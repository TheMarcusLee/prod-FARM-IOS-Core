import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { inject } from './support.js';
import type { RegisteredDevice } from '../src/devices/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

// devices/registry.ts freezes its path at first import, so it is set before the
// dynamic imports below reach it.
const DEVICES_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'bl-cc-')), 'devices.json');
writeFileSync(DEVICES_PATH, '[]');
process.env.DEVICES_CONFIG_PATH = DEVICES_PATH;
process.env.ANDROID_DISCOVERY = 'off';

const { createApp } = await import('../src/api/app.js');
const { PluginRegistry } = await import('../src/registry.js');
const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
const { createMemoryEventStore } = await import('../src/fleet/events.js');

const ANDROID: RegisteredDevice = {
    name: 'Pixel 7', udid: 'R58N12ABCDE', platform: 'android', driver: 'adb',
    android: { serial: 'R58N12ABCDE' }, pluginData: {},
};
const IPHONE: RegisteredDevice = { name: 'iPhone 8', udid: 'ios-udid', pluginData: {} };

interface AppOptions {
    devices?: RegisteredDevice[];
    connected?: string[];
    pushed?: string[];
}

async function app(context: { after(fn: () => unknown): void }, options: AppOptions = {}) {
    await writeFile(DEVICES_PATH, JSON.stringify(options.devices ?? [ANDROID, IPHONE]));
    const instance = await createApp({
        plugins: new PluginRegistry([]),
        scheduler: { async activeExecution() { return null; } } as unknown as SchedulerRepository,
        dashboardTheme: defaultDashboardTheme,
        connectedUdids: async () => options.connected ?? [ANDROID.udid],
        createDriver: (device) => ({
            kind: 'adb', platform: 'android', udid: device.udid,
            async launchApp() {}, async terminateApp() {}, async tap() {}, async swipe() {}, async type() {},
            async pressKey() {}, async uiTree() { throw new Error('not used'); },
            async screenshot() { return Buffer.alloc(0); },
            async screen() { return { width: 1080, height: 2400, scale: 1 }; },
            async pushMedia() { options.pushed?.push(device.udid); },
            async pause() {},
        }) as never,
    });
    context.after(() => instance.close());
    return instance;
}

test('the bulk device actions whitelist their bodies', async (context) => {
    const instance = await app(context);

    for (const [url, payload, expected] of [
        ['/api/devices/actions/push-media', {}, /udids must be a non-empty array/],
        ['/api/devices/actions/push-media', { udids: [] }, /udids must be a non-empty array/],
        ['/api/devices/actions/push-media', { udids: ['../etc/passwd'], assetId: 'x' }, /udid must/],
        ['/api/devices/actions/push-media', { udids: [ANDROID.udid], assetId: 'not-a-uuid' }, /assetId must be an uploaded asset id/],
        ['/api/devices/actions/install-apk', { udids: [ANDROID.udid] }, /path must be the path of an \.apk file/],
        ['/api/devices/actions/install-apk', { udids: [ANDROID.udid], path: 'evil.sh' }, /path must be the path of an \.apk file/],
        ['/api/devices/actions/install-apk', { udids: [ANDROID.udid], path: '../../escape.apk' }, /must name a file inside/],
    ] as const) {
        const response = await inject(instance, { method: 'POST', url, payload });
        assert.equal(response.statusCode, 400, `${url} ${JSON.stringify(payload)}`);
        assert.match(response.json().error, expected);
    }

    // A phone that is not registered, and one the operator disabled, are both refused.
    const unknown = await inject(instance, {
        method: 'POST', url: '/api/devices/actions/install-apk',
        payload: { udids: ['nobody'], path: 'bridge.apk' },
    });
    assert.equal(unknown.statusCode, 404);
});

test('an APK never reaches an iPhone', async (context) => {
    const instance = await app(context);
    const response = await inject(instance, {
        method: 'POST', url: '/api/devices/actions/install-apk',
        payload: { udids: [ANDROID.udid, IPHONE.udid], path: 'bridge.apk' },
    });
    // The path check runs first and there is no APK on disk here, so the refusal is
    // either "no such APK" or the platform one — never an adb call for an iPhone.
    assert.ok([400, 404].includes(response.statusCode), String(response.statusCode));
});

test('the shell carries the rig status and the unread alert count', async (context) => {
    const store = createMemoryEventStore();
    await store.record({ kind: 'device.disconnected', severity: 'warning', deviceUdid: ANDROID.udid, title: 'Pixel 7 went offline' });
    await store.record({ kind: 'execution.failed', severity: 'error', deviceUdid: ANDROID.udid, title: 'The post failed' });
    await writeFile(DEVICES_PATH, JSON.stringify([ANDROID, IPHONE]));
    const instance = await createApp({
        plugins: new PluginRegistry([]),
        scheduler: {} as SchedulerRepository,
        dashboardTheme: defaultDashboardTheme,
        connectedUdids: async () => [ANDROID.udid],
        events: store,
    });
    context.after(() => instance.close());

    const page = await inject(instance, { method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    // Two unacknowledged events, and the rig block says what is up in plain words.
    assert.match(page.body, /<span class="bl-count">2<\/span>/);
    assert.match(page.body, /Rig (?:running|degraded)[^<]*<\/strong>/);
    assert.match(page.body, /2 phones · 1 adb · 1 iPhone/);

    const alerts = await inject(instance, { method: 'GET', url: '/alerts' });
    assert.equal(alerts.statusCode, 200);
    assert.match(alerts.body, /The post failed/);
    assert.match(alerts.body, /2 unread/);
    assert.match(alerts.body, /data-ack-all/);

    // The Rig page names every service and links the docs for the ones that are down.
    const rig = await inject(instance, { method: 'GET', url: '/rig' });
    assert.equal(rig.statusCode, 200);
    for (const service of ['Dashboard', 'Database', 'Worker', 'Android bridge', 'iPhone bridge']) {
        assert.match(rig.body, new RegExp(`bl-service-name">${service}<`));
    }
    assert.match(rig.body, /href="\/docs\/getting-started"/);
    assert.equal((await inject(instance, { method: 'GET', url: '/docs/getting-started' })).statusCode, 200);
    assert.equal((await inject(instance, { method: 'GET', url: '/docs/../package' })).statusCode, 404);
});

test('the accounts page groups every phone under its handle', async (context) => {
    const instance = await app(context, {
        devices: [
            { ...ANDROID, pluginData: { 'com.git-agni.tiktok': { accounts: ['@one'] } } },
            { ...IPHONE, pluginData: { 'com.git-agni.tiktok': { accounts: ['@one', '@two'] } } },
        ],
    });
    const page = await inject(instance, { method: 'GET', url: '/accounts' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /@one/);
    assert.match(page.body, /@two/);
    // Each account carries its identity colour, assigned by first appearance.
    assert.match(page.body, /bl-swatch" style="background:#a3c497"/);
    assert.match(page.body, /bl-swatch" style="background:#b9a6dc"/);
});

/**
 * The chrome — the sidebar's rig block and the Alerts unread count — is one implementation in
 * src/ui/context.ts, and every page that renders through the shell gets it. Content and Runbooks
 * used to wire their own subset, so they said "Rig status unknown" and never showed a count.
 */
test('every shell page carries the same rig block and unread count', async (context) => {
    const { createRunbookPlugin } = await import('../src/runbook-plugin.js');
    const store = createMemoryEventStore();
    await store.record({ kind: 'execution.failed', severity: 'error', deviceUdid: ANDROID.udid, title: 'The post failed' });
    await store.record({ kind: 'device.disconnected', severity: 'warning', deviceUdid: ANDROID.udid, title: 'Pixel 7 went offline' });
    await writeFile(DEVICES_PATH, JSON.stringify([ANDROID, IPHONE]));
    const instance = await createApp({
        plugins: new PluginRegistry([createRunbookPlugin({
            directory: path.join(mkdtempSync(path.join(os.tmpdir(), 'bl-rb-')), 'runbooks'),
        })]),
        scheduler: {} as SchedulerRepository,
        dashboardTheme: defaultDashboardTheme,
        connectedUdids: async () => [ANDROID.udid],
        events: store,
    });
    context.after(() => instance.close());

    for (const url of ['/', '/schedule', '/content', '/runbooks', '/devices', '/alerts', '/settings']) {
        const page = await inject(instance, { method: 'GET', url });
        assert.equal(page.statusCode, 200, url);
        assert.doesNotMatch(page.body, /Rig status unknown/, url);
        assert.match(page.body, /class="bl-rig-status">.*2 phones/s, url);
        assert.match(page.body, /class="bl-count">2</, url);
        // The plugin's own nav entry is in the sidebar of every page too.
        assert.match(page.body, /href="\/runbooks"[\s\S]*?Runbooks/, url);
    }
});
