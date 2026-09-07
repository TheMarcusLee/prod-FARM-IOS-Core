import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inject } from './support.js';
import type { CreateTaskInput, JsonObject } from '../src/types.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import { PluginRegistry } from '../src/registry.js';

process.env.ANDROID_DISCOVERY = 'off';

// devices.json and the override store both resolve once, when their module first loads.
const workspace = await mkdtemp(path.join(os.tmpdir(), 'pf-agent-dash-'));
process.env.DEVICES_CONFIG_PATH = path.join(workspace, 'devices.json');
process.env.SCHEDULER_DATA_DIR = workspace;

const { createApp } = await import('../src/api/app.js');
const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
const { createAgentPlugin } = await import('../src/agent-plugin.js');
const { createTikTokPlugin } = await import('../src/tiktok-plugin.js');
const { renderAlertsPage } = await import('../src/ui/pages.js');
const { TIKTOK_PLUGIN_ID, AGENT_PLUGIN_ID } = await import('../src/plugin-ids.js');
const { recordSelectorOverride } = await import('../src/drivers/selector-overrides.js');

const SERIAL = 'R58N12ABCDE';

interface Booked { input: CreateTaskInput; pluginData: JsonObject }

async function app(booked: Booked[], plugins = [createTikTokPlugin({}), createAgentPlugin()]) {
    await writeFile(process.env.DEVICES_CONFIG_PATH!, JSON.stringify([
        { name: 'Pixel 7', udid: SERIAL, platform: 'android', driver: 'adb', android: { serial: SERIAL }, pluginData: {} },
        { name: 'Shelf phone', udid: 'shelved', platform: 'android', disabled: true, pluginData: {} },
    ]));
    return createApp({
        plugins: new PluginRegistry(plugins),
        scheduler: {
            async activeExecution() { return null; },
            async createTask(input: CreateTaskInput, pluginData: JsonObject) {
                booked.push({ input, pluginData });
                return { id: 'schedule-1', ...input };
            },
        } as unknown as SchedulerRepository,
        dashboardTheme: defaultDashboardTheme,
    });
}

test('the device page Selectors fragment lists each routine, its alternates and what is confirmed', async (context) => {
    const instance = await app([]);
    context.after(() => instance.close());
    await recordSelectorOverride({
        plugin: TIKTOK_PLUGIN_ID, udid: SERIAL, name: 'accountSwitcher',
        entry: { id: 'account_switch' }, confirmedBy: 'agent', note: 'TikTok 39.4.4',
    });

    const response = await inject(instance, { method: 'GET', url: `/api/devices/${SERIAL}/fragments/selectors` });
    assert.equal(response.statusCode, 200);
    const body = response.body;
    assert.match(body, /TikTok · post/);
    assert.match(body, /TikTok · warmup/);
    assert.match(body, /captionField/);
    assert.match(body, /#btn_post/, 'the built-in alternates are shown, not just the name');
    assert.match(body, /unverified<\/span>/, 'a guess with nothing recorded reads as unverified');
    assert.match(body, /#account_switch/);
    assert.match(body, /agent · \d{4}-\d{2}-\d{2}/, 'a confirmed selector says who and when');
    assert.match(body, /data-calibrate data-plugin="com\.git-agni\.tiktok"/);

    const missing = await inject(instance, { method: 'GET', url: '/api/devices/nope/fragments/selectors' });
    assert.equal(missing.statusCode, 404);
});

test('the panel offers no button when the agent plugin is not loaded', async (context) => {
    const instance = await app([], [createTikTokPlugin({})]);
    context.after(() => instance.close());
    const response = await inject(instance, { method: 'GET', url: `/api/devices/${SERIAL}/fragments/selectors` });
    assert.doesNotMatch(response.body, /data-calibrate/);
    assert.match(response.body, /calibration agent plugin is not loaded/);
});

test('"Ask the agent to calibrate" books the calibrate task on that phone', async (context) => {
    const booked: Booked[] = [];
    const instance = await app(booked);
    context.after(() => instance.close());

    const created = await inject(instance, {
        method: 'POST', url: '/api/agent/calibrate',
        payload: { udid: SERIAL, plugin: TIKTOK_PLUGIN_ID, flow: 'post' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(booked.length, 1);
    assert.deepEqual(booked[0]?.input.task, {
        pluginId: AGENT_PLUGIN_ID, taskType: 'calibrate', taskVersion: 1,
        payload: { plugin: TIKTOK_PLUGIN_ID, flow: 'post', udid: SERIAL },
    });
    assert.deepEqual(booked[0]?.input.timing, { kind: 'now' });

    for (const [payload, status] of [
        [{ udid: SERIAL, plugin: TIKTOK_PLUGIN_ID, flow: 'scroll' }, 400],
        [{ plugin: TIKTOK_PLUGIN_ID, flow: 'post' }, 400],
        [{ udid: 'nope', plugin: TIKTOK_PLUGIN_ID, flow: 'post' }, 404],
        [{ udid: 'shelved', plugin: TIKTOK_PLUGIN_ID, flow: 'post' }, 409],
    ] as const) {
        const refused = await inject(instance, { method: 'POST', url: '/api/agent/calibrate', payload });
        assert.equal(refused.statusCode, status, JSON.stringify(payload));
    }
    assert.equal(booked.length, 1, 'nothing else was booked');
});

test('a failure that could not find a control offers the calibration button; other failures do not', () => {
    const base = {
        id: 1, severity: 'error' as const, kind: 'execution.failed' as const,
        deviceUdid: SERIAL, executionId: 'e1', scheduleId: null, createdAt: new Date(0),
    };
    const withHint = renderAlertsPage([{
        ...base, title: 'tiktok/post failed',
        detail: { calibrate: { plugin: TIKTOK_PLUGIN_ID, flow: 'post', udid: SERIAL, selector: 'captionField' } },
    }], 1);
    assert.match(withHint, /Ask the agent to calibrate \(captionField\)/);
    assert.match(withHint, /data-flow="post"/);

    const plain = renderAlertsPage([{ ...base, title: 'tiktok/post failed', detail: { error: 'device is offline' } }], 1);
    assert.doesNotMatch(plain, /data-calibrate/);

    // Event detail is data, not markup: a hint that is not the shape we expect renders nothing.
    const rubbish = renderAlertsPage([{ ...base, title: 'x', detail: { calibrate: { plugin: '<script>', flow: 'nope' } } }], 1);
    assert.doesNotMatch(rubbish, /data-calibrate/);
});
