import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { inject } from './support.js';

// Every module that resolves a path from the environment does so on first load,
// so the whole file shares one workspace and imports the app after setting it.
process.env.ANDROID_DISCOVERY = 'off';
const workspace = await mkdtemp(path.join(os.tmpdir(), 'pf-mobile-'));
process.env.DEVICES_CONFIG_PATH = path.join(workspace, 'devices.json');
process.env.SCHEDULER_DATA_DIR = path.join(workspace, 'data');
process.env.CONTENT_DIR = path.join(workspace, 'content');

const { createApp } = await import('../src/api/app.js');
const { createLocalAuthProvider, SESSION_COOKIE } = await import('../src/auth/local.js');
const { createApiToken, listApiTokens, resetTokenUseThrottle, setPassword, touchApiToken } =
    await import('../src/auth/state.js');
const { setMediaTools } = await import('../src/content/ffmpeg.js');
const { createFarmMcpServer } = await import('../src/mcp/server.js');
const { resolveUploadPath, uploadDirectories } = await import('../src/mcp/uploads.js');
const { derivedDeviceState } = await import('../src/fleet/summary.js');
const { createMemoryEventStore } = await import('../src/fleet/events.js');
const {
    bucketFor, clampScreenshotWidth, queueStatus, registerMobileRoutes,
} = await import('../src/api/routes/mobile.js');
const { PluginRegistry } = await import('../src/registry.js');

import type { ContentItemRow, ExecutionRow, ScheduleRow } from '../src/database/schema.js';
import type { ContentStore, QueuePlanRow } from '../src/content/store.js';
import type { DeviceDriver } from '../src/drivers/types.js';
import type { McpDependencies } from '../src/mcp/types.js';
import type { RegisteredDevice } from '../src/devices/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

const PASSWORD = 'correct-horse-battery';

interface Context { after(fn: () => unknown): void }

async function statePath(context: Context): Promise<string> {
    const directory = await mkdtemp(path.join(workspace, 'auth-'));
    const state = path.join(directory, '.auth.json');
    const previous = process.env.AUTH_STATE_PATH;
    process.env.AUTH_STATE_PATH = state;
    resetTokenUseThrottle();
    context.after(() => {
        if (previous === undefined) delete process.env.AUTH_STATE_PATH; else process.env.AUTH_STATE_PATH = previous;
    });
    return state;
}

async function writeDevices(devices: RegisteredDevice[]): Promise<void> {
    await writeFile(process.env.DEVICES_CONFIG_PATH!, JSON.stringify(devices), 'utf8');
}

function scheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
    return {
        id: 'schedule-1', deviceUdid: 'device-1', pluginId: 'com.example.probe', taskType: 'ping', taskVersion: 1,
        payload: {}, timing: { kind: 'now' }, status: 'active', runWindowMinutes: 30,
        nextRunAt: new Date('2026-09-06T09:00:00Z'), createdAt: new Date('2026-09-01T09:00:00Z'),
        updatedAt: new Date('2026-09-01T09:00:00Z'), ...overrides,
    } as ScheduleRow;
}

function executionRow(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
    return {
        id: 'execution-1', scheduleId: 'schedule-1', deviceUdid: 'device-1', pluginId: 'com.example.probe',
        taskType: 'ping', taskVersion: 1, payload: {}, status: 'running',
        scheduledFor: new Date('2026-09-05T09:00:00Z'), deadlineAt: new Date('2026-09-05T09:30:00Z'),
        queueJobId: null, startedAt: new Date('2026-09-05T09:00:04Z'), finishedAt: null, exitCode: null,
        error: null, stopRequestedAt: null, attempts: 1,
        createdAt: new Date('2026-09-05T09:00:00Z'), updatedAt: new Date('2026-09-05T09:00:04Z'), ...overrides,
    } as ExecutionRow;
}

/** Newest-first keyset over an array — the same contract the repository implements in SQL. */
function fakeList<T extends { id: string; createdAt: Date }>(rows: readonly T[]) {
    return async (limit = 100, _deviceUdid?: string, before?: { createdAt: Date; id?: string }) => {
        const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const after = before
            ? sorted.filter((row) => row.createdAt < before.createdAt
                || (row.createdAt.getTime() === before.createdAt.getTime() && row.id < (before.id ?? '')))
            : sorted;
        return after.slice(0, limit);
    };
}

function fakeScheduler(overrides: Partial<Record<string, unknown>> = {}): SchedulerRepository {
    return {
        async listSchedules() { return []; },
        async listExecutions() { return []; },
        async schedule() { return null; },
        async execution() { return null; },
        async setScheduleStatus() { return null; },
        async activeExecution() { return null; },
        connection: undefined,
        ...overrides,
    } as unknown as SchedulerRepository;
}

function fakeStore(overrides: Partial<ContentStore> = {}): ContentStore {
    const unused = () => { throw new Error('not used by these tests'); };
    return { ...Object.fromEntries(['insertAsset', 'assetPath', 'listItems', 'item', 'insertItem'].map(
        (name) => [name, unused],
    )), ...overrides } as unknown as ContentStore;
}

function queuePlan(overrides: Partial<QueuePlanRow> = {}): QueuePlanRow {
    return {
        id: 'plan-1', ruleId: 'rule-1', itemId: 'item-1', scheduleId: 'schedule-1',
        plannedFor: new Date('2026-09-06T18:00:00Z'), usedMarkedAt: null, scheduleStatus: 'paused',
        deviceUdid: 'device-1', caption: 'day 14 of building the farm', assetId: 'asset-1', ...overrides,
    };
}

/** The mobile routes on a bare instance — no dashboard, no auth, the content-routes test style. */
async function mobileApp(
    context: Context, options: Parameters<typeof registerMobileRoutes>[1],
): Promise<FastifyInstance> {
    const app = Fastify();
    await registerMobileRoutes(app, options);
    await app.ready();
    context.after(() => app.close());
    return app;
}

// ---- token identity --------------------------------------------------------

const probePlugin = {
    id: 'com.example.probe', version: '1.0.0', displayName: 'Probe', tasks: [],
    registerRoutes({ app }: { app: FastifyInstance }) {
        app.get('/api/probe', async (request) => ({ apiToken: request.apiToken ?? null }));
    },
};

async function authApp(state: string, context: Context): Promise<FastifyInstance> {
    const app = await createApp({
        plugins: new PluginRegistry([probePlugin]),
        scheduler: fakeScheduler(),
        authProvider: createLocalAuthProvider({ statePath: state }),
    });
    context.after(() => app.close());
    return app;
}

test('a bearer request is decorated with its token id and name', async (context) => {
    const state = await statePath(context);
    const { token, record } = await createApiToken(state, 'marcus-iphone');
    const app = await authApp(state, context);

    const probe = await inject(app, { method: 'GET', url: '/api/probe', headers: { authorization: `Bearer ${token}` } });
    assert.equal(probe.statusCode, 200);
    assert.deepEqual(probe.json().apiToken, { id: record.id, name: 'marcus-iphone' });
});

test('a cookie session is decorated as the session identity', async (context) => {
    const state = await statePath(context);
    await setPassword(state, PASSWORD);
    const app = await authApp(state, context);

    const login = await inject(app, { method: 'POST', url: '/login', payload: { password: PASSWORD } });
    const cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [String(login.headers['set-cookie'])])
        .find((value) => value.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0] ?? '';
    assert.ok(cookie, 'expected a session cookie');

    const probe = await inject(app, { method: 'GET', url: '/api/probe', headers: { cookie } });
    assert.deepEqual(probe.json().apiToken, { id: 'session', name: 'local' });
});

test('GET /api/tokens lists names without digests, and DELETE revokes one', async (context) => {
    const state = await statePath(context);
    const { token } = await createApiToken(state, 'marcus-iphone');
    const other = await createApiToken(state, 'push-relay');
    const app = await authApp(state, context);
    const headers = { authorization: `Bearer ${token}` };

    const listed = await inject(app, { method: 'GET', url: '/api/tokens', headers });
    assert.equal(listed.statusCode, 200);
    const names = listed.json().tokens.map((entry: { name: string }) => entry.name);
    assert.deepEqual(names.sort(), ['marcus-iphone', 'push-relay']);
    const first = listed.json().tokens[0];
    assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'id', 'lastUsedAt', 'name']);

    const removed = await inject(app, { method: 'DELETE', url: `/api/tokens/${other.record.id}`, headers });
    assert.equal(removed.statusCode, 204);
    assert.deepEqual((await listApiTokens(state)).map(({ name }) => name), ['marcus-iphone']);

    const missing = await inject(app, { method: 'DELETE', url: '/api/tokens/not-a-token', headers });
    assert.equal(missing.statusCode, 404);

    // The revoked token is off the farm immediately.
    const rejected = await inject(app, {
        method: 'GET', url: '/api/tokens', headers: { authorization: `Bearer ${other.token}` },
    });
    assert.equal(rejected.statusCode, 401);
});

test('lastUsedAt tracks a request and is throttled to once a minute', async (context) => {
    const state = await statePath(context);
    const { token, record } = await createApiToken(state, 'marcus-iphone');
    const app = await authApp(state, context);

    await inject(app, { method: 'GET', url: '/api/probe', headers: { authorization: `Bearer ${token}` } });
    const first = (await listApiTokens(state)).find(({ id }) => id === record.id)?.lastUsedAt;
    assert.ok(first, 'expected lastUsedAt to be recorded');

    // Half a minute later: still the same write, because the file is not an audit log.
    await touchApiToken(state, record.id, Date.now() + 30_000);
    assert.equal((await listApiTokens(state)).find(({ id }) => id === record.id)?.lastUsedAt, first);

    await touchApiToken(state, record.id, Date.now() + 120_000);
    assert.notEqual((await listApiTokens(state)).find(({ id }) => id === record.id)?.lastUsedAt, first);
});

// ---- rate limits -----------------------------------------------------------

test('rate limits answer 429 with the standard headers once the budget is spent', async (context) => {
    const previous = process.env.RATE_LIMIT_READ;
    process.env.RATE_LIMIT_READ = '2';
    context.after(() => {
        if (previous === undefined) delete process.env.RATE_LIMIT_READ; else process.env.RATE_LIMIT_READ = previous;
    });
    const app = await createApp({ plugins: new PluginRegistry([]), scheduler: fakeScheduler() });
    context.after(() => app.close());

    assert.equal((await inject(app, { method: 'GET', url: '/api/plugins' })).statusCode, 200);
    assert.equal((await inject(app, { method: 'GET', url: '/api/plugins' })).statusCode, 200);
    const limited = await inject(app, { method: 'GET', url: '/api/plugins' });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['x-ratelimit-limit'], '2');
    assert.equal(limited.headers['x-ratelimit-remaining'], '0');
    assert.ok(limited.headers['retry-after'], 'expected a retry-after header');
    assert.match(limited.json().error, /Rate limit exceeded/);
});

test('rate limit buckets separate remote actions per device from ordinary reads and writes', () => {
    const action = bucketFor('POST', '/api/devices/udid-1/remote/action');
    assert.deepEqual([action.name, action.max, action.windowMs, action.scope], ['action', 10, 1_000, 'udid-1']);
    const shot = bucketFor('GET', '/api/devices/udid-2/remote/screenshot');
    assert.deepEqual([shot.name, shot.max, shot.windowMs, shot.scope], ['screenshot', 5, 1_000, 'udid-2']);
    assert.deepEqual(bucketFor('GET', '/api/devices').max, 300);
    assert.deepEqual(bucketFor('POST', '/api/schedules').max, 60);
});

// ---- MCP upload allowlist --------------------------------------------------

test('upload directories default to the content directory and the data inbox', () => {
    const directories = uploadDirectories({});
    assert.equal(directories.length, 2);
    assert.ok(directories.some((entry) => entry.endsWith(path.join('content'))));
    assert.ok(directories.some((entry) => entry.endsWith(path.join('data', 'inbox'))));
    assert.deepEqual(uploadDirectories({ MCP_UPLOAD_DIRS: '/tmp/a,/tmp/b' }), ['/tmp/a', '/tmp/b']);
});

test('an upload path outside the allowlist is rejected, symlinks included', async (context) => {
    const allowed = await mkdtemp(path.join(workspace, 'inbox-'));
    const secrets = await mkdtemp(path.join(workspace, 'secret-'));
    const inside = path.join(allowed, 'clip.mp4');
    const outside = path.join(secrets, 'devices.json');
    await writeFile(inside, 'clip');
    await writeFile(outside, 'passcodes');
    const escape = path.join(allowed, 'escape.json');
    await symlink(outside, escape);
    context.after(() => rm(allowed, { recursive: true, force: true }));

    // The allowed file resolves; macOS realpath prefixes /private, so compare the tail.
    assert.match(await resolveUploadPath(inside, [allowed]), /inbox-[^/]+\/clip\.mp4$/);
    await assert.rejects(resolveUploadPath(outside, [allowed]), /outside the allowed upload directories/);
    // The symlink *lives* in the allowlist; its target does not.
    await assert.rejects(resolveUploadPath(escape, [allowed]), /outside the allowed upload directories/);
    await assert.rejects(resolveUploadPath(path.join(allowed, 'missing.mp4'), [allowed]), /No readable file/);
});

test('the upload_asset tool refuses a path outside the allowlist and list_upload_dirs reports them', async () => {
    const allowed = await mkdtemp(path.join(workspace, 'tools-'));
    const dependencies = {
        scheduler: {
            async registerAssets(files: readonly { originalName: string; mimeType: string }[]) {
                return files.map((file) => ({ id: 'asset-1', name: file.originalName, mimeType: file.mimeType }));
            },
        },
        async loadDevices() { return []; },
        async discoverDevices() { return []; },
        async screenshot() { return Buffer.alloc(0); },
        async listAssets() { return []; },
        listPlugins() { return []; },
        dataDirectory: path.join(workspace, 'data'),
        uploadDirectories: [allowed],
    } as unknown as McpDependencies;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFarmMcpServer(dependencies);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
        const blocked = await client.callTool({
            name: 'upload_asset', arguments: { name: 'x.mp4', mimeType: 'video/mp4', path: '/etc/hosts' },
        }) as { isError?: boolean; content: Array<{ text?: string }> };
        assert.equal(blocked.isError, true);
        assert.match(blocked.content[0]?.text ?? '', /outside the allowed upload directories/);

        const allowedFile = path.join(allowed, 'clip.mp4');
        await writeFile(allowedFile, 'clip');
        const accepted = await client.callTool({
            name: 'upload_asset', arguments: { name: 'clip.mp4', mimeType: 'video/mp4', path: allowedFile },
        }) as { isError?: boolean; content: Array<{ text?: string }> };
        assert.notEqual(accepted.isError, true, accepted.content[0]?.text ?? 'upload rejected');

        const dirs = await client.callTool({ name: 'list_upload_dirs', arguments: {} }) as {
            content: Array<{ text?: string }>;
        };
        assert.deepEqual(JSON.parse(dirs.content[0]?.text ?? '{}'), { directories: [allowed] });
    } finally {
        await client.close();
        await server.close();
    }
});

// ---- screenshot thumbnails -------------------------------------------------

test('screenshot widths clamp to the thumbnail range and ignore nonsense', () => {
    assert.equal(clampScreenshotWidth(undefined), null);
    assert.equal(clampScreenshotWidth('wide'), null);
    assert.equal(clampScreenshotWidth('1'), 120);
    assert.equal(clampScreenshotWidth('320'), 320);
    assert.equal(clampScreenshotWidth('99999'), 1080);
});

test('GET /remote/screenshot?width resizes the frame and keeps cache-control: no-store', async (context) => {
    const serial = 'R58N12ABCDE';
    await writeDevices([{ udid: serial, name: 'Pixel 7', platform: 'android' } as RegisteredDevice]);
    const frame = await sharp({
        create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 30, b: 60 } },
    }).png().toBuffer();
    const driver = { async screenshot() { return frame; } } as unknown as DeviceDriver;
    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler: fakeScheduler(), createDriver: () => driver,
    });
    context.after(() => app.close());

    const full = await inject(app, { method: 'GET', url: `/api/devices/${serial}/remote/screenshot` });
    assert.equal(full.statusCode, 200);
    assert.equal(full.headers['cache-control'], 'no-store');
    assert.equal((await sharp(full.rawPayload).metadata()).width, 1600);

    const thumb = await inject(app, { method: 'GET', url: `/api/devices/${serial}/remote/screenshot?width=320` });
    assert.equal((await sharp(thumb.rawPayload).metadata()).width, 320);

    const clamped = await inject(app, { method: 'GET', url: `/api/devices/${serial}/remote/screenshot?width=4` });
    assert.equal((await sharp(clamped.rawPayload).metadata()).width, 120);
    assert.equal(clamped.headers['cache-control'], 'no-store');
});

// ---- bootstrap -------------------------------------------------------------

test('GET /api/mobile/bootstrap composes release, plugins, fleet, events and capabilities', async (context) => {
    await writeDevices([
        { udid: 'device-1', name: 'iPhone 8 · slot 1', tags: ['warm-up'] } as RegisteredDevice,
        { udid: 'device-2', name: 'Pixel 6a', platform: 'android' } as RegisteredDevice,
        { udid: 'device-3', name: 'Shelf phone', disabled: true } as RegisteredDevice,
    ]);
    const events = createMemoryEventStore();
    await events.record({ kind: 'device.error', severity: 'error', deviceUdid: 'device-2', title: 'adb lost the device' });
    const app = await mobileApp(context, {
        scheduler: fakeScheduler({
            listExecutions: async () => [executionRow()],
            listSchedules: async () => [scheduleRow()],
        }),
        plugins: new PluginRegistry([]),
        events,
        loadDevices: async () => JSON.parse(await readFile(process.env.DEVICES_CONFIG_PATH!, 'utf8')),
        connectedUdids: async () => ['device-1', 'device-2'],
        now: () => new Date('2026-09-05T09:41:12.004Z'),
    });

    const body = (await app.inject({ method: 'GET', url: '/api/mobile/bootstrap' })).json();
    assert.equal(body.serverTime, '2026-09-05T09:41:12.004Z');
    assert.equal(typeof body.release.version, 'string');
    assert.deepEqual(body.capabilities, {
        push: false, eventAck: false, thumbnails: true, contentQueue: true, tokens: true, rateLimits: true,
    });
    assert.deepEqual(body.fleet.counts, { total: 3, online: 0, busy: 1, offline: 0, disabled: 1, error: 1 });
    assert.equal(body.recentEvents.length, 1);
    assert.equal(body.recentEvents[0].kind, 'device.error');
    assert.equal(body.unacknowledgedCount, 0);
});

test('bootstrap devices carry tags, the derived state and what is running now', async (context) => {
    await writeDevices([{ udid: 'device-1', name: 'iPhone 8 · slot 1', tags: ['warm-up'] } as RegisteredDevice]);
    const app = await mobileApp(context, {
        scheduler: fakeScheduler({
            listExecutions: async () => [executionRow()],
            listSchedules: async () => [scheduleRow()],
        }),
        plugins: new PluginRegistry([]),
        events: createMemoryEventStore(),
        loadDevices: async () => JSON.parse(await readFile(process.env.DEVICES_CONFIG_PATH!, 'utf8')),
        connectedUdids: async () => ['device-1'],
    });

    const [device] = (await app.inject({ method: 'GET', url: '/api/mobile/bootstrap' })).json().fleet.devices;
    assert.deepEqual(device.tags, ['warm-up']);
    assert.equal(device.state, 'busy');
    assert.equal(device.currentExecution.id, 'execution-1');
    assert.equal(device.nextRunAt, '2026-09-06T09:00:00.000Z');
    assert.equal(device.lastError, null);
});

// ---- fleet state and device tags -------------------------------------------

test('the derived device state answers with one badge, in precedence order', () => {
    assert.equal(derivedDeviceState({ disabled: true, connected: true, busy: true }), 'disabled');
    assert.equal(derivedDeviceState({ connected: false, errored: true }), 'offline');
    assert.equal(derivedDeviceState({ connected: true, errored: true, busy: true }), 'error');
    assert.equal(derivedDeviceState({ connected: true, busy: true }), 'busy');
    assert.equal(derivedDeviceState({ connected: true }), 'online');
});

test('GET /api/devices returns tags alongside the redacted record', async (context) => {
    await writeDevices([
        { udid: 'device-1', name: 'iPhone 8 · slot 1', tags: ['warm-up', 'us-east'], passcode: '1234' } as RegisteredDevice,
    ]);
    const app = await createApp({ plugins: new PluginRegistry([]), scheduler: fakeScheduler() });
    context.after(() => app.close());

    const [device] = (await inject(app, { method: 'GET', url: '/api/devices' })).json();
    assert.deepEqual(device.tags, ['warm-up', 'us-east']);
    assert.equal(device.hasPasscode, true);
    assert.equal(device.passcode, undefined);
});

// ---- asset thumbnails ------------------------------------------------------

async function seedAsset(name: string, body: Buffer): Promise<string> {
    const relativePath = path.join('uploads', name);
    const file = path.join(process.env.SCHEDULER_DATA_DIR!, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    return relativePath;
}

test('an image asset thumbnail is a JPEG of at most 320 px, cached on disk', async (context) => {
    const source = await sharp({
        create: { width: 1200, height: 800, channels: 3, background: { r: 10, g: 120, b: 200 } },
    }).png().toBuffer();
    const relativePath = await seedAsset('image-asset.png', source);
    const app = await mobileApp(context, {
        scheduler: fakeScheduler(),
        plugins: new PluginRegistry([]),
        store: fakeStore({
            thumbnailAsset: async () => ({
                id: 'asset-1', relativePath, mimeType: 'image/png', sha256: 'image-sha',
            }),
            itemForAsset: async () => null,
        }),
    });

    const response = await app.inject({ method: 'GET', url: '/api/assets/asset-1/thumbnail' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    const meta = await sharp(response.rawPayload).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.ok((meta.width ?? 0) <= 320 && (meta.height ?? 0) <= 320, `got ${meta.width}x${meta.height}`);
    // The second request is served from the cache entry the first one wrote.
    await readFile(path.join(process.env.SCHEDULER_DATA_DIR!, 'thumbnails', 'image-sha.jpg'));
    assert.equal((await app.inject({ method: 'GET', url: '/api/assets/asset-1/thumbnail' })).statusCode, 200);
});

test('a video asset thumbnail comes from the stored poster frame when there is one', async (context) => {
    const poster = await sharp({
        create: { width: 360, height: 640, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).jpeg().toBuffer();
    await mkdir(process.env.CONTENT_DIR!, { recursive: true });
    await writeFile(path.join(process.env.CONTENT_DIR!, 'poster.jpg'), poster);
    const relativePath = await seedAsset('clip-poster.mp4', Buffer.from('not really a video'));
    const app = await mobileApp(context, {
        scheduler: fakeScheduler(),
        plugins: new PluginRegistry([]),
        store: fakeStore({
            thumbnailAsset: async () => ({
                id: 'asset-2', relativePath, mimeType: 'video/mp4', sha256: 'poster-sha',
            }),
            itemForAsset: async () => ({ posterPath: 'poster.jpg' } as ContentItemRow),
        }),
    });

    const response = await app.inject({ method: 'GET', url: '/api/assets/asset-2/thumbnail' });
    assert.equal(response.statusCode, 200);
    assert.equal((await sharp(response.rawPayload).metadata()).format, 'jpeg');
});

test('a video asset with no poster falls back to an ffmpeg first frame', async (context) => {
    const frame = await sharp({
        create: { width: 320, height: 180, channels: 3, background: { r: 5, g: 5, b: 5 } },
    }).jpeg().toBuffer();
    const framePath = path.join(workspace, 'frame.jpg');
    await writeFile(framePath, frame);
    const fake = path.join(workspace, 'fake-ffmpeg.sh');
    // Copies a known frame to whatever output path the caller asked for.
    await writeFile(fake, `#!/bin/sh\nfor last; do :; done\ncp ${framePath} "$last"\n`, { mode: 0o755 });
    await chmod(fake, 0o755);
    setMediaTools({ ffmpeg: fake, ffprobe: '/usr/bin/true' });
    context.after(() => setMediaTools(null));

    const relativePath = await seedAsset('clip-raw.mp4', Buffer.from('not really a video'));
    const app = await mobileApp(context, {
        scheduler: fakeScheduler(),
        plugins: new PluginRegistry([]),
        store: fakeStore({
            thumbnailAsset: async () => ({
                id: 'asset-3', relativePath, mimeType: 'video/mp4', sha256: 'ffmpeg-sha',
            }),
            itemForAsset: async () => null,
        }),
    });

    const response = await app.inject({ method: 'GET', url: '/api/assets/asset-3/thumbnail' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
});

test('an unknown asset is a 404, not a broken image', async (context) => {
    const app = await mobileApp(context, {
        scheduler: fakeScheduler(),
        plugins: new PluginRegistry([]),
        store: fakeStore({ thumbnailAsset: async () => null }),
    });
    const response = await app.inject({ method: 'GET', url: '/api/assets/nope/thumbnail' });
    assert.equal(response.statusCode, 404);
});

// ---- content queue ---------------------------------------------------------

test('the queue status is derived from the plan and its schedule', () => {
    assert.equal(queueStatus({ scheduleStatus: null, usedMarkedAt: null }), 'planned');
    assert.equal(queueStatus({ scheduleStatus: 'paused', usedMarkedAt: null }), 'planned');
    assert.equal(queueStatus({ scheduleStatus: 'active', usedMarkedAt: null }), 'approved');
    assert.equal(queueStatus({ scheduleStatus: 'cancelled', usedMarkedAt: null }), 'skipped');
    assert.equal(queueStatus({ scheduleStatus: 'completed', usedMarkedAt: null }), 'posted');
    assert.equal(queueStatus({ scheduleStatus: 'active', usedMarkedAt: new Date() }), 'posted');
});

test('GET /api/content/queue returns planned posts with a thumbnail URL', async (context) => {
    const app = await mobileApp(context, {
        scheduler: fakeScheduler(),
        plugins: new PluginRegistry([]),
        store: fakeStore({ queuePlans: async () => [queuePlan()] }),
    });

    const [item] = (await app.inject({ method: 'GET', url: '/api/content/queue' })).json().items;
    assert.deepEqual(item, {
        id: 'plan-1', status: 'planned', deviceUdid: 'device-1', caption: 'day 14 of building the farm',
        assetId: 'asset-1', thumbnailUrl: '/api/assets/asset-1/thumbnail',
        plannedFor: '2026-09-06T18:00:00.000Z', scheduleId: 'schedule-1',
    });
});

test('approve resumes a held post and is a no-op the second time', async (context) => {
    const resumed: Array<[string, string]> = [];
    let status: string | null = 'paused';
    const app = await mobileApp(context, {
        scheduler: fakeScheduler({
            setScheduleStatus: async (id: string, next: string) => { resumed.push([id, next]); status = next; return null; },
        }),
        plugins: new PluginRegistry([]),
        store: fakeStore({ queuePlan: async () => queuePlan({ scheduleStatus: status }) }),
    });

    const first = await inject(app, { method: 'POST', url: '/api/content/queue/plan-1/approve' });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().item.status, 'approved');
    assert.deepEqual(resumed, [['schedule-1', 'active']]);

    const second = await inject(app, { method: 'POST', url: '/api/content/queue/plan-1/approve' });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().item.status, 'approved');
    assert.equal(resumed.length, 1, 'an already-approved post must not be re-scheduled');

    const missing = await inject(app, { method: 'POST', url: '/api/content/queue/nope/approve' });
    assert.equal(missing.statusCode, 200);
});

test('skip cancels the schedule and closes the plan without spending the item', async (context) => {
    const cancelled: Array<[string, string]> = [];
    const skipped: string[] = [];
    const app = await mobileApp(context, {
        scheduler: fakeScheduler({
            setScheduleStatus: async (id: string, next: string) => { cancelled.push([id, next]); return null; },
        }),
        plugins: new PluginRegistry([]),
        store: fakeStore({
            queuePlan: async (id: string) => (id === 'plan-1' ? queuePlan({ scheduleStatus: 'active' }) : null),
            markPlanSkipped: async (planId: string) => { skipped.push(planId); },
        }),
    });

    const response = await inject(app, { method: 'POST', url: '/api/content/queue/plan-1/skip' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().item.status, 'skipped');
    assert.deepEqual(cancelled, [['schedule-1', 'cancelled']]);
    assert.deepEqual(skipped, ['plan-1']);

    const missing = await inject(app, { method: 'POST', url: '/api/content/queue/nope/skip' });
    assert.equal(missing.statusCode, 404);
});

// ---- keyset pagination -----------------------------------------------------

test('schedules and executions paginate with ?limit and ?before, and are unchanged without them', async (context) => {
    const schedules = [1, 2, 3, 4, 5].map((index) => scheduleRow({
        id: `schedule-${index}`, createdAt: new Date(Date.UTC(2026, 8, index)),
    }));
    const executions = [1, 2, 3].map((index) => executionRow({
        id: `execution-${index}`, createdAt: new Date(Date.UTC(2026, 8, index)),
    }));
    const app = await createApp({
        plugins: new PluginRegistry([]),
        scheduler: fakeScheduler({
            listSchedules: fakeList(schedules),
            listExecutions: fakeList(executions),
            schedule: async (id: string) => schedules.find((row) => row.id === id) ?? null,
            execution: async (id: string) => executions.find((row) => row.id === id) ?? null,
        }),
    });
    context.after(() => app.close());

    const all = await inject(app, { method: 'GET', url: '/api/schedules' });
    assert.equal(all.json().schedules.length, 5);
    assert.equal(all.headers['x-next-before'], undefined, 'an unpaginated response is unchanged');

    const first = await inject(app, { method: 'GET', url: '/api/schedules?limit=2' });
    assert.deepEqual(first.json().schedules.map((row: ScheduleRow) => row.id), ['schedule-5', 'schedule-4']);
    assert.equal(first.headers['x-next-before'], 'schedule-4');

    const second = await inject(app, { method: 'GET', url: '/api/schedules?limit=2&before=schedule-4' });
    assert.deepEqual(second.json().schedules.map((row: ScheduleRow) => row.id), ['schedule-3', 'schedule-2']);

    // An ISO createdAt is an equally valid cursor.
    const byTime = await inject(app, {
        method: 'GET', url: `/api/executions?limit=5&before=${encodeURIComponent('2026-09-03T00:00:00.000Z')}`,
    });
    assert.deepEqual(byTime.json().executions.map((row: ExecutionRow) => row.id), ['execution-2', 'execution-1']);
    assert.equal(byTime.headers['x-next-before'], undefined, 'the last page carries no cursor');

    const bogus = await inject(app, { method: 'GET', url: '/api/schedules?before=schedule-99' });
    assert.equal(bogus.statusCode, 400);
    assert.match(bogus.json().error, /row id or an ISO createdAt/);
});

test.after(async () => { await rm(workspace, { recursive: true, force: true }); });
