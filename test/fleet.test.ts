import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import { inject } from './support.js';
import type { ExecutionRow, ScheduleRow } from '../src/database/schema.js';
import type { DeviceConnectionStatus } from '../src/devices/connection-manager.js';
import type { RegisteredDevice } from '../src/devices/registry.js';
import type { FleetRouteOptions } from '../src/api/routes/fleet.js';
import {
    createBulkSchedules, parseBulkRequest, parseStagger, shiftLocalTime, staggerOffsets, staggeredTiming,
} from '../src/fleet/bulk.js';
import { createDeviceMonitorState, diffDeviceStatuses, longOfflineDevices } from '../src/fleet/device-monitor.js';
import { createMemoryEventStore, type EventInput } from '../src/fleet/events.js';
import { lifecycleEventInput, schedulerEventHook } from '../src/fleet/scheduler-events.js';
import { escapeHtml } from '../src/fleet/page.js';
import { derivedDeviceState, deviceState, stuckExecutions, summarizeFleet } from '../src/fleet/summary.js';
import type { CreateTaskInput, ScheduleTiming } from '../src/types.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');

// devices/registry.ts freezes its path at first import, so point it at a scratch
// file before anything that reaches it is imported — hence the dynamic imports below.
const DEVICES_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'pf-fleet-')), 'devices.json');
writeFileSync(DEVICES_PATH, '[]');
process.env.DEVICES_CONFIG_PATH = DEVICES_PATH;

function device(overrides: Partial<RegisteredDevice> = {}): RegisteredDevice {
    return { name: 'Phone A', udid: 'udid-a', pluginData: {}, ...overrides };
}

function executionRow(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
    return {
        id: 'exec-1', scheduleId: 'sched-1', deviceUdid: 'udid-a',
        pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1, payload: {},
        scheduledFor: new Date('2026-03-01T11:00:00.000Z'), deadlineAt: new Date('2026-03-01T11:30:00.000Z'),
        status: 'running', queueJobId: 'job-1', startedAt: new Date('2026-03-01T11:00:00.000Z'),
        finishedAt: null, exitCode: null, error: null, stopRequestedAt: null,
        createdAt: NOW, updatedAt: NOW, ...overrides,
    } as ExecutionRow;
}

function scheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
    return {
        id: 'sched-1', deviceUdid: 'udid-a', pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1,
        payload: {}, timing: { kind: 'daily', localTime: '09:00', timezone: 'UTC' }, status: 'active',
        runWindowMinutes: 30, nextRunAt: new Date('2026-03-01T18:00:00.000Z'),
        createdAt: NOW, updatedAt: NOW, ...overrides,
    } as ScheduleRow;
}

/** Captures createTask calls, and fails for any device whose udid starts with "bad". */
function fakeScheduler(overrides: Partial<SchedulerRepository> = {}) {
    const created: CreateTaskInput[] = [];
    const scheduler = {
        created,
        async createTask(input: CreateTaskInput) {
            if (input.deviceUdid.startsWith('bad')) throw new Error('This schedule is within 10 minutes of another schedule on this device');
            created.push(input);
            return scheduleRow({ id: `sched-${created.length}`, deviceUdid: input.deviceUdid });
        },
        async listExecutions() { return []; },
        async listSchedules() { return []; },
        ...overrides,
    };
    return scheduler as unknown as SchedulerRepository & { created: CreateTaskInput[] };
}

async function fleetApp(options: Partial<FleetRouteOptions> & { scheduler: SchedulerRepository }): Promise<FastifyInstance> {
    const { registerFleetRoutes } = await import('../src/api/routes/fleet.js');
    const app = Fastify();
    await registerFleetRoutes(app, { backgroundTasks: false, now: () => NOW, ...options });
    return app;
}

test('a fixed stagger spreads devices evenly and a random one stays inside the window', () => {
    assert.deepEqual(staggerOffsets(4, { kind: 'fixed', minutes: 7 }), [0, 7, 14, 21]);
    assert.deepEqual(staggerOffsets(3, { kind: 'fixed', minutes: 0 }), [0, 0, 0]);
    assert.deepEqual(staggerOffsets(0, { kind: 'fixed', minutes: 5 }), []);

    // A random stagger deals distinct minutes: two phones opening TikTok in the
    // same minute is the lockstep the stagger exists to prevent.
    const twelve = staggerOffsets(12, { kind: 'random', windowMinutes: 45 });
    assert.equal(twelve.length, 12);
    assert.equal(new Set(twelve).size, 12);
    assert.ok(twelve.every((offset) => Number.isInteger(offset) && offset >= 0 && offset < 45));

    // Independent draws would collide most of the time; this must never collide.
    for (let trial = 0; trial < 200; trial++) {
        const offsets = staggerOffsets(12, { kind: 'random', windowMinutes: 45 });
        assert.equal(new Set(offsets).size, 12, `trial ${trial} produced a duplicate minute`);
    }

    // Deterministic source: the deal is 0..n-1, shuffled.
    assert.deepEqual(staggerOffsets(4, { kind: 'random', windowMinutes: 60 }, () => 0).sort((a, b) => a - b),
        [0, 1, 2, 3]);

    // More devices than minutes: collisions are unavoidable, so they are spread
    // as evenly as the window allows rather than clumping.
    const crowded = staggerOffsets(50, { kind: 'random', windowMinutes: 45 });
    assert.ok(crowded.every((offset) => offset >= 0 && offset < 45));
    const counts = new Map<number, number>();
    for (const offset of crowded) counts.set(offset, (counts.get(offset) ?? 0) + 1);
    assert.equal(new Set(crowded).size, 45);
    assert.ok(Math.max(...counts.values()) <= 2);

    // A zero-width window is every device at once, as asked.
    assert.deepEqual(staggerOffsets(3, { kind: 'random', windowMinutes: 0 }), [0, 0, 0]);

    assert.deepEqual(parseStagger(undefined), { kind: 'fixed', minutes: 0 });
    assert.deepEqual(parseStagger({ kind: 'random', windowMinutes: 30 }), { kind: 'random', windowMinutes: 30 });
    assert.throws(() => parseStagger({ kind: 'sometimes' }), /stagger.kind/);
    assert.throws(() => parseStagger({ kind: 'fixed', minutes: -1 }), /stagger.minutes/);
    assert.throws(() => parseStagger({ kind: 'random', windowMinutes: 5_000 }), /stagger.windowMinutes/);
});

test('a stagger offset moves each timing kind forward', () => {
    assert.equal(shiftLocalTime('08:00', 30), '08:30');
    assert.equal(shiftLocalTime('23:50', 20), '00:10');
    assert.equal(shiftLocalTime('00:05', 0), '00:05');

    // "now" cannot carry an offset, so a staggered run becomes a one-shot.
    assert.deepEqual(staggeredTiming({ kind: 'now' }, 0, NOW), { kind: 'now' });
    assert.deepEqual(staggeredTiming({ kind: 'now' }, 15, NOW), { kind: 'once', runAt: '2026-03-01T12:15:00.000Z' });
    assert.deepEqual(
        staggeredTiming({ kind: 'once', runAt: '2026-03-01T18:00:00.000Z' }, 90, NOW),
        { kind: 'once', runAt: '2026-03-01T19:30:00.000Z' },
    );
    const daily: ScheduleTiming = { kind: 'daily', localTime: '23:55', timezone: 'Europe/London' };
    assert.deepEqual(staggeredTiming(daily, 10, NOW), { kind: 'daily', localTime: '00:05', timezone: 'Europe/London' });
});

test('the bulk request body is whitelisted', () => {
    const parsed = parseBulkRequest({
        deviceUdids: ['a', 'b', 'a'],
        task: { pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1, payload: { durationMinutes: 5 } },
        timing: { kind: 'now' },
        stagger: { kind: 'fixed', minutes: 3 },
        runWindowMinutes: 45,
        overrides: { a: { account: '@one' }, unknown: { account: '@nope' } },
        somethingElse: 'dropped',
    });
    assert.deepEqual(parsed.deviceUdids, ['a', 'b']);
    assert.equal(parsed.runWindowMinutes, 45);
    assert.deepEqual(parsed.overrides, { a: { account: '@one' } });
    assert.equal((parsed as unknown as Record<string, unknown>).somethingElse, undefined);

    assert.throws(() => parseBulkRequest({ deviceUdids: [] }), /deviceUdids/);
    assert.throws(() => parseBulkRequest({ deviceUdids: ['a'], task: { pluginId: 'x' } }), /task must be/);
    assert.throws(() => parseBulkRequest({ deviceUdids: ['a'], task: { pluginId: 'x', taskType: 'y', taskVersion: 1, payload: {} } }), /timing/);
    assert.throws(() => parseBulkRequest({ deviceUdids: Array.from({ length: 201 }, (_v, i) => `d${i}`) }), /may not exceed/);
});

test('bulk scheduling staggers each device and reports per-device failures without aborting', async () => {
    const scheduler = fakeScheduler();
    const outcomes = await createBulkSchedules({
        deviceUdids: ['udid-a', 'bad-device', 'udid-c', 'unregistered', 'udid-off'],
        task: { pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1, payload: { destination: 'draft' } },
        timing: { kind: 'now' },
        stagger: { kind: 'fixed', minutes: 10 },
        overrides: { 'udid-a': { account: '@one' }, 'udid-c': { account: '@three' } },
    }, {
        scheduler,
        devices: [device(), device({ udid: 'bad-device' }), device({ udid: 'udid-c' }), device({ udid: 'udid-off', disabled: true })],
        now: NOW,
    });

    assert.deepEqual(outcomes.map(({ deviceUdid, ok, offsetMinutes }) => [deviceUdid, ok, offsetMinutes]), [
        ['udid-a', true, 0], ['bad-device', false, 10], ['udid-c', true, 20],
        ['unregistered', false, 30], ['udid-off', false, 40],
    ]);
    assert.match(outcomes[1]!.error!, /within 10 minutes/);
    assert.match(outcomes[3]!.error!, /not registered/);
    assert.match(outcomes[4]!.error!, /disabled/);

    // Each successful device kept its own account and its own start time.
    assert.deepEqual(scheduler.created.map(({ deviceUdid, timing, task }) => [deviceUdid, timing, task.payload.account]), [
        ['udid-a', { kind: 'now' }, '@one'],
        ['udid-c', { kind: 'once', runAt: '2026-03-01T12:20:00.000Z' }, '@three'],
    ]);
});

test('POST /api/schedules/bulk creates one schedule per device and reports the failures', async (context) => {
    const scheduler = fakeScheduler();
    const app = await fleetApp({
        scheduler, events: createMemoryEventStore(),
        loadDevices: async () => [device(), device({ udid: 'bad-device' })],
    });
    context.after(() => app.close());

    const response = await inject(app, {
        method: 'POST', url: '/api/schedules/bulk',
        payload: {
            deviceUdids: ['udid-a', 'bad-device'],
            task: { pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1, payload: { durationMinutes: 10 } },
            timing: { kind: 'now' },
            stagger: { kind: 'fixed', minutes: 5 },
        },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().created, 1);
    assert.equal(response.json().failed, 1);
    assert.deepEqual(response.json().results.map((result: { deviceUdid: string; ok: boolean }) => [result.deviceUdid, result.ok]),
        [['udid-a', true], ['bad-device', false]]);

    const invalid = await inject(app, { method: 'POST', url: '/api/schedules/bulk', payload: { deviceUdids: [] } });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /deviceUdids/);
});

test('the fleet summary counts device states, running work and the 24 hour windows', async (context) => {
    const executions = [
        executionRow({ id: 'e1', status: 'running', deadlineAt: new Date('2026-03-01T12:30:00.000Z') }),
        executionRow({ id: 'e2', status: 'queued', scheduledFor: new Date('2026-03-01T15:00:00.000Z') }),
        executionRow({ id: 'e3', status: 'failed', finishedAt: new Date('2026-03-01T06:00:00.000Z') }),
        executionRow({ id: 'e4', status: 'failed', finishedAt: new Date('2026-02-01T06:00:00.000Z') }),
        executionRow({ id: 'e5', status: 'succeeded', finishedAt: new Date('2026-03-01T07:00:00.000Z') }),
        executionRow({ id: 'e6', status: 'running', deadlineAt: new Date('2026-03-01T11:00:00.000Z') }),
    ];
    const devices = [
        { device: device(), connected: true, state: deviceState(device(), true) },
        { device: device({ udid: 'udid-b' }), connected: false, state: deviceState(device({ udid: 'udid-b' }), false) },
        { device: device({ udid: 'udid-c', disabled: true, platform: 'android' as const }), connected: false, state: 'disabled' as const },
    ];
    const summary = summarizeFleet({ devices, executions, schedules: [scheduleRow()], now: NOW });
    assert.deepEqual(summary.devices, { total: 3, online: 1, offline: 1, disabled: 1 });
    assert.deepEqual(summary.byPlatform, { ios: 2, android: 1 });
    assert.equal(summary.running, 2);
    assert.equal(summary.queued, 1);
    assert.equal(summary.stuck, 1, 'e6 is more than five minutes past its deadline');
    assert.equal(summary.failedLast24h, 1);
    assert.equal(summary.succeededLast24h, 1);
    assert.equal(summary.plannedNext24h, 2, 'one queued execution plus one active schedule');
    assert.deepEqual(stuckExecutions(executions, NOW).map(({ id }) => id), ['e6']);

    const scheduler = fakeScheduler({
        async listExecutions() { return executions; },
        async listSchedules() { return [scheduleRow()]; },
    } as unknown as Partial<SchedulerRepository>);
    const app = await fleetApp({
        scheduler, events: createMemoryEventStore(),
        loadDevices: async () => devices.map(({ device: entry }) => entry),
        connectedUdids: async () => ['udid-a'],
    });
    context.after(() => app.close());
    const response = await inject(app, { method: 'GET', url: '/api/fleet/summary' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().devices, { total: 3, online: 1, offline: 1, disabled: 1 });
    assert.equal(response.json().generatedAt, NOW.toISOString());
});

test('the wall renders a numbered tile per phone, with its state and a live frame', async (context) => {
    await writeFile(DEVICES_PATH, JSON.stringify([
        device({ tags: ['warm', 'uk'], pluginData: { 'com.git-agni.tiktok': { accounts: ['@one', '@two'] } } }),
        device({ udid: 'udid-b', name: 'Pixel', platform: 'android', tags: ['uk'] }),
        device({ udid: 'udid-c', name: 'Retired', disabled: true }),
    ]));
    const scheduler = fakeScheduler({
        async listExecutions() { return [executionRow()]; },
        async listSchedules() { return [scheduleRow({ deviceUdid: 'udid-a' })]; },
        async execution() { return { ...executionRow(), logs: ['11:00:04 Tapped Create, then Upload'] }; },
    } as unknown as Partial<SchedulerRepository>);
    const { createApp } = await import('../src/api/app.js');
    const { PluginRegistry } = await import('../src/registry.js');
    const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler, dashboardTheme: defaultDashboardTheme,
        connectedUdids: async () => ['udid-a'],
    });
    context.after(() => app.close());

    const page = await inject(app, { method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers['content-type']), /text\/html/);

    // One tile per phone, numbered in registration order, with the derived state.
    assert.match(page.body, /data-tile data-udid="udid-a" data-slot="01" data-state="busy" data-platform="ios"/);
    assert.match(page.body, /data-tile data-udid="udid-b" data-slot="02" data-state="offline" data-platform="android"/);
    assert.match(page.body, /data-tile data-udid="udid-c" data-slot="03" data-state="disabled"/);
    assert.match(page.body, /<span class="bl-tile-num">01<\/span><span class="bl-tile-name">Phone A<\/span>/);
    assert.match(page.body, /data-tags="warm,uk"/);

    // Only a connected, enabled phone gets a frame, and never with a src the page ships.
    assert.equal((page.body.match(/data-frame/g) ?? []).length, 2, 'one tile frame plus the inspector viewer');
    assert.doesNotMatch(page.body, /<img[^>]+src="\/api\/devices/);

    // The filter panel: connection segments, group chips from the tags, the numbered picker.
    for (const filter of ['all', 'usb', 'wifi', 'ios']) {
        assert.match(page.body, new RegExp(`data-link-filter="${filter}"`));
    }
    assert.match(page.body, /data-group="uk"[^>]*>uk 2</);
    assert.match(page.body, /data-pick="udid-b"[^>]*>02</);
    assert.match(page.body, /1 of 3 up/);

    // The toolbar acts on the selection.
    for (const action of ['select-all', 'schedule-post', 'warm-up', 'push-media', 'run-runbook', 'install-apk', 'reconnect', 'pause']) {
        assert.match(page.body, new RegExp(`data-wall-action="${action}"`));
    }

    // The inspector opens on the connected phone, with its viewer, hardware column and log.
    assert.match(page.body, /id="inspector" data-udid="udid-a"/);
    assert.match(page.body, /data-viewer data-udid="udid-a" data-platform="ios" data-live="1"/);
    assert.match(page.body, /data-hw="home"/);
    // Back and recents are Android keys; an iPhone has neither.
    assert.doesNotMatch(page.body, /data-hw="recents"/);
    assert.match(page.body, /Tapped Create, then Upload/);
    assert.match(page.body, /Next post/);
    assert.match(page.body, /Today/);
    assert.match(page.body, /2 needs you/);

    // The old fleet grid's bookmark still works.
    const moved = await inject(app, { method: 'GET', url: '/fleet' });
    assert.equal(moved.statusCode, 302);
    assert.equal(moved.headers.location, '/');
});

test('the inspector fragment renders one phone, and an Android one gets the Android keys', async (context) => {
    await writeFile(DEVICES_PATH, JSON.stringify([
        device({ udid: 'udid-b', name: 'Pixel', platform: 'android', driver: 'adb', android: { serial: 'udid-b' } }),
    ]));
    const { createApp } = await import('../src/api/app.js');
    const { PluginRegistry } = await import('../src/registry.js');
    const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler: fakeScheduler(), dashboardTheme: defaultDashboardTheme,
        connectedUdids: async () => ['udid-b'],
    });
    context.after(() => app.close());

    const fragment = await inject(app, { method: 'GET', url: '/api/fragments/inspector/udid-b' });
    assert.equal(fragment.statusCode, 200);
    assert.match(fragment.body, /id="inspector" data-udid="udid-b"/);
    assert.match(fragment.body, /data-hw="back"/);
    assert.match(fragment.body, /data-hw="recents"/);
    assert.equal((await inject(app, { method: 'GET', url: '/api/fragments/inspector/nope' })).statusCode, 404);
});


test('PATCH /api/devices/:udid stores tags and rejects anything that is not a string array', async (context) => {
    const configPath = DEVICES_PATH;
    await writeFile(configPath, JSON.stringify([{ name: 'Phone A', udid: 'udid-a', pluginData: {} }]));

    const { createApp } = await import('../src/api/app.js');
    const { PluginRegistry } = await import('../src/registry.js');
    const app = await createApp({
        plugins: new PluginRegistry([]),
        scheduler: { async activeExecution() { return null; } } as unknown as SchedulerRepository,
    });
    context.after(() => app.close());

    const saved = await inject(app, {
        method: 'PATCH', url: '/api/devices/udid-a', payload: { tags: [' warm ', 'uk', 'warm', ''] },
    });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().tags, ['warm', 'uk']);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8'))[0].tags, ['warm', 'uk']);

    const rejected = await inject(app, { method: 'PATCH', url: '/api/devices/udid-a', payload: { tags: 'warm' } });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().error, /tags must be an array of strings/);
});

test('device status polling turns connection changes into events', () => {
    const status = (overrides: Partial<DeviceConnectionStatus> = {}): DeviceConnectionStatus => ({
        udid: 'udid-a', physical: 'connected', wda: 'ready', appium: 'ready', managed: true,
        message: 'WDA is ready', retryCount: 0, updatedAt: NOW.toISOString(), ...overrides,
    });
    const down = status({ physical: 'disconnected', wda: 'disconnected', message: 'Reconnect the USB cable' });
    const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1_000);
    const state = createDeviceMonitorState();

    // First sighting is only a baseline.
    assert.deepEqual(diffDeviceStatuses(state, [status()], NOW), []);
    assert.deepEqual(diffDeviceStatuses(state, [status()], NOW), []);

    // A change is proposed, then has to hold for the debounce before it counts.
    assert.deepEqual(diffDeviceStatuses(state, [down], at(0)), []);
    const offline = diffDeviceStatuses(state, [down], at(60));
    assert.deepEqual(offline.map(({ kind, severity, deviceUdid }) => [kind, severity, deviceUdid]),
        [['device.disconnected', 'warning', 'udid-a']]);

    assert.deepEqual(diffDeviceStatuses(state, [status()], at(70)), []);
    const back = diffDeviceStatuses(state, [status()], at(130));
    assert.deepEqual(back.map(({ kind, severity }) => [kind, severity]), [['device.connected', 'info']]);

    const broken = status({ wda: 'error', message: 'xcodebuild exited 65' });
    assert.deepEqual(diffDeviceStatuses(state, [broken], at(140)), []);
    const failed = diffDeviceStatuses(state, [broken], at(200));
    assert.deepEqual(failed.map(({ kind, severity }) => [kind, severity]), [['device.error', 'error']]);
    assert.equal((failed[0]!.detail as { error: string }).error, 'xcodebuild exited 65');
    // The same error is not re-reported on every poll.
    assert.deepEqual(diffDeviceStatuses(state, [broken], at(400)), []);

    // Devices offline for over an hour feed the digest.
    const later = new Date(NOW.getTime() + 3 * 3_600_000 + 200_000);
    assert.deepEqual(longOfflineDevices(state, later).map(({ deviceUdid }) => deviceUdid), ['udid-a']);
    assert.deepEqual(longOfflineDevices(state, NOW), []);
});

test('a flapping USB cable produces no events at all', () => {
    const status = (physical: 'connected' | 'disconnected'): DeviceConnectionStatus => ({
        udid: 'udid-a', physical, wda: physical === 'connected' ? 'ready' : 'disconnected', appium: 'ready',
        managed: true, message: '', retryCount: 0, updatedAt: NOW.toISOString(),
    });
    const state = createDeviceMonitorState();
    diffDeviceStatuses(state, [status('connected')], NOW);

    // Ten polls over five minutes, alternating every 30 s: nothing ever holds
    // for the debounce window, so nothing reaches the timeline.
    const produced: unknown[] = [];
    for (let poll = 1; poll <= 10; poll++) {
        const physical = poll % 2 === 0 ? 'connected' : 'disconnected';
        produced.push(...diffDeviceStatuses(state, [status(physical)], new Date(NOW.getTime() + poll * 30_000)));
    }
    assert.deepEqual(produced, []);

    // Once it stays down, the disconnect is reported exactly once.
    const settled = [11, 12, 13].flatMap((poll) =>
        diffDeviceStatuses(state, [status('disconnected')], new Date(NOW.getTime() + poll * 30_000)));
    assert.deepEqual(settled.map(({ kind }) => kind), ['device.disconnected']);
});

test('a retried execution reports one execution.started, then execution.retried', async () => {
    const recorded: EventInput[] = [];
    const hook = schedulerEventHook({ record: async (input) => { recorded.push(input); return null; } });
    const execution = executionRow({ status: 'running' });

    // pg-boss runs a retry as the same job, so the worker starts an attempt per
    // try. The attempt number rides along with the signal instead of the
    // observer keeping a set of ids it has already seen.
    hook({ kind: 'execution.started', execution, attempt: 1 });
    hook({ kind: 'execution.started', execution, attempt: 2 });
    hook({ kind: 'execution.started', execution, attempt: 3 });
    hook({ kind: 'execution.failed', execution: executionRow({ status: 'failed' }) });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(recorded.map(({ kind }) => kind),
        ['execution.started', 'execution.retried', 'execution.retried', 'execution.failed']);
    assert.deepEqual(recorded.map(({ severity }) => severity), ['info', 'info', 'info', 'error']);
    assert.deepEqual(recorded.map(({ detail }) => (detail as { attempt?: number }).attempt), [1, 2, 3, undefined]);
    assert.match(recorded[1]!.title, /was retried on udid-a/);

    // A signal with no attempt at all — anything that is not startAttempt — is
    // still a plain start.
    hook({ kind: 'execution.started', execution });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorded.at(-1)!.kind, 'execution.started');
});

test('the scheduler hook swallows a mapping failure instead of taking the scheduler down', () => {
    const logged: string[] = [];
    const hook = schedulerEventHook({ record: async () => null }, (message) => logged.push(message));
    // A lifecycle signal with no execution row at all: lifecycleEventInput throws
    // reading through it, and the hook must absorb that.
    assert.doesNotThrow(() => hook({ kind: 'execution.started' } as never));
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /execution\.started/);
});

test('scheduler lifecycle signals map onto the event contract', () => {
    const failed = lifecycleEventInput({ kind: 'execution.failed', execution: executionRow({ status: 'failed', error: 'WDA died' }) });
    assert.equal(failed.kind, 'execution.failed');
    assert.equal(failed.severity, 'error');
    assert.equal(failed.deviceUdid, 'udid-a');
    assert.equal(failed.executionId, 'exec-1');
    assert.equal(failed.scheduleId, 'sched-1');
    assert.match(failed.title, /com\.git-agni\.tiktok\/doomscroll@1 failed on udid-a/);
    assert.equal((failed.detail as { error: string }).error, 'WDA died');

    assert.equal(lifecycleEventInput({ kind: 'execution.started', execution: executionRow() }).severity, 'info');
    assert.equal(lifecycleEventInput({ kind: 'execution.stopped', execution: executionRow() }).severity, 'warning');

    // A cancelled run is not an error, but it still has to leave a trace.
    const cancelled = lifecycleEventInput({
        kind: 'execution.cancelled',
        execution: executionRow({ status: 'cancelled', error: 'Cancelled before execution' }),
    });
    assert.equal(cancelled.kind, 'execution.cancelled');
    assert.equal(cancelled.severity, 'info');
    assert.equal(cancelled.executionId, 'exec-1');
    assert.match(cancelled.title, /com\.git-agni\.tiktok\/doomscroll@1 was cancelled on udid-a/);

    const paused = lifecycleEventInput({ kind: 'schedule.paused', schedule: scheduleRow({ status: 'paused' }) });
    assert.equal(paused.kind, 'schedule.paused');
    assert.equal(paused.scheduleId, 'sched-1');
    assert.equal(paused.executionId, undefined);
    assert.match(paused.title, /schedule paused on udid-a/);
});

/* ------------------------------------------------- rendering and summary cost */

test('every interpolation on the Control Center is escaped', async (context) => {
    await writeFile(DEVICES_PATH, JSON.stringify([{
        name: '<script>alert("name")</script>',
        udid: 'udid-x',
        tags: ['" onmouseover="alert(2)', "it's fine"],
        pluginData: { 'com.git-agni.tiktok': { accounts: ['</option><script>alert(3)</script>'] } },
    }]));
    const scheduler = fakeScheduler({
        async listExecutions() {
            return [executionRow({ deviceUdid: 'udid-x', status: 'running', taskType: '"><script>alert(4)</script>' })];
        },
        async listSchedules() { return []; },
        async execution() { return { ...executionRow(), logs: ['<img src=x onerror=alert(1)>'] }; },
    } as unknown as Partial<SchedulerRepository>);
    const { createApp } = await import('../src/api/app.js');
    const { PluginRegistry } = await import('../src/registry.js');
    const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler, dashboardTheme: defaultDashboardTheme,
        connectedUdids: async () => ['udid-x'],
    });
    context.after(() => app.close());

    const page = await inject(app, { method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    // The only <script> elements are the ones the shell ships itself: htmx, the shared
    // page script and the wall. Every injected one survives as &lt;script&gt; text.
    const scripts = page.body.match(/<script\b/g) ?? [];
    assert.equal(scripts.length, 3, `found ${scripts.length} script tags`);
    assert.doesNotMatch(page.body, /<script>alert/);
    assert.doesNotMatch(page.body, /<\/option><script/);
    assert.doesNotMatch(page.body, /"><script/);
    assert.doesNotMatch(page.body, /" onmouseover="/);
    assert.doesNotMatch(page.body, /<img src=x/);
    // And the values are still there, escaped.
    assert.match(page.body, /&lt;script&gt;alert\(&quot;name&quot;\)&lt;\/script&gt;/);
    assert.match(page.body, /it&#39;s fine/);

    // The renderer itself, on the values a device record can carry.
    assert.equal(escapeHtml('<a href="x">&\'</a>'),
        '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(7), '7');
});


test('twelve pollers on the summary cost one device enumeration, not twelve', async (context) => {
    let enumerations = 0;
    let executionQueries = 0;
    const scheduler = fakeScheduler({
        async listExecutions() { executionQueries++; return []; },
        async listSchedules() { return []; },
    } as unknown as Partial<SchedulerRepository>);
    const app = await fleetApp({
        scheduler, events: createMemoryEventStore(),
        loadDevices: async () => [device()],
        connectedUdids: async () => { enumerations++; return ['udid-a']; },
        summaryTtlMs: 5_000,
    });
    context.after(() => app.close());

    // A dozen fleet pages and tray apps all polling inside one window.
    await Promise.all(Array.from({ length: 12 }, () => inject(app, { method: 'GET', url: '/api/fleet/summary' })));
    assert.equal(enumerations, 1, 'USB was enumerated once for twelve callers');
    assert.equal(executionQueries, 1, 'the execution table was read once for twelve callers');

    // Serial callers inside the window reuse it too; the clock is frozen at NOW.
    for (let call = 0; call < 5; call++) await inject(app, { method: 'GET', url: '/api/fleet/summary' });
    assert.equal(enumerations, 1);
});

test('stuck executions are swept on a timer and reported once each', async (context) => {
    const store = createMemoryEventStore();
    const executions = [
        // Five minutes past its deadline plus the grace period.
        executionRow({ id: 'e-stuck', status: 'running', deadlineAt: new Date(NOW.getTime() - 10 * 60_000) }),
        executionRow({ id: 'e-fine', status: 'running', deadlineAt: new Date(NOW.getTime() + 60_000) }),
    ];
    let listed = 0;
    const scheduler = fakeScheduler({
        async listExecutions() { listed++; return executions; },
        async listSchedules() { return []; },
    } as unknown as Partial<SchedulerRepository>);

    const app = Fastify();
    context.after(() => app.close());
    const { registerFleetRoutes } = await import('../src/api/routes/fleet.js');
    await registerFleetRoutes(app, {
        scheduler, events: store, now: () => NOW,
        loadDevices: async () => [device()],
        connectedUdids: async () => ['udid-a'],
        deviceStatuses: async () => [],
        monitorIntervalMs: 5,
        notifications: {
            channels: [], minSeverity: 'warning', digestLocalTime: '08:00',
            digestTimezone: 'UTC', publicBaseUrl: '',
        },
    });

    // The sweep is a background timer, not something a request triggers.
    const stuck = () => store.events.filter((event) => event.kind === 'execution.stuck');
    await new Promise((resolve) => { setTimeout(resolve, 120); });
    assert.ok(listed > 1, `the sweep ran ${listed} times`);
    assert.deepEqual(stuck().map(({ executionId, severity }) => [executionId, severity]),
        [['e-stuck', 'error']], 'exactly one execution.stuck, however many sweeps ran');
    assert.equal(stuck()[0]!.deviceUdid, 'udid-a');
    assert.equal((stuck()[0]!.detail as { deadlineAt: string }).deadlineAt,
        executions[0]!.deadlineAt.toISOString());
    // No secrets: the detail carries the task identity and timings, never the payload.
    assert.deepEqual(Object.keys(stuck()[0]!.detail!).sort(), ['deadlineAt', 'startedAt', 'task']);
});

test('a bridge phone reachable over Wi-Fi but invisible to adb is online, not offline', async () => {
    const { DeviceConnectionManager } = await import('../src/devices/connection-manager.js');
    const bridgePhone = device({
        name: 'Pixel', udid: 'R58N1', platform: 'android', driver: 'a11y-bridge',
        android: { serial: 'R58N1', bridgeUrl: 'http://192.168.1.40:18300/' },
    });
    const connections = new DeviceConnectionManager({
        loadDevices: async () => [bridgePhone],
        // Nothing on the USB bus, and nothing in `adb devices`.
        connectedUdids: async () => [],
        endpointReady: async (url) => url.endsWith('/ping'),
        spawnSupervisor: () => { throw new Error('Android phones never get a WDA supervisor'); },
        now: () => 0,
    });

    await connections.reconcile();
    const status = connections.status('R58N1');

    // The bridge answering *is* the connection for this driver: adb is optional
    // once the phone is bootstrapped, so the manager reports it as physically
    // connected and the badge has to agree.
    assert.equal(status?.physical, 'connected');
    const connected = status?.physical === 'connected';
    assert.equal(deviceState(bridgePhone, connected), 'online');
    assert.equal(derivedDeviceState({ disabled: bridgePhone.disabled, connected }), 'online');
    assert.equal(derivedDeviceState({ connected, busy: true }), 'busy');
    assert.equal(derivedDeviceState({ connected, errored: true }), 'error');

    // The rule the callers have to honour: `connected` is the connection
    // manager's `physical`, not "is it in `adb devices`". Feeding raw USB/adb
    // enumeration in shows a healthy Wi-Fi phone as offline.
    assert.equal(derivedDeviceState({ connected: false }), 'offline');
});
