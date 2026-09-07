import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';

import {
    ScrcpyStreamParser, avcCodecString, containsKeyframe, detectScrcpy, liveVideoMessage,
    parameterSets, parseForwardedPort, parseScrcpyVersion, serverArgs, STILLS_ONLY_MESSAGE,
} from '../src/live/scrcpy.js';
import {
    LiveUnavailableError, VIEWER_QUALITY, WALL_QUALITY, createSessionManager, maxStreamsFromEnv,
    qualityFor, type LiveQuality, type LiveStreamHandlers,
} from '../src/live/sessions.js';
import { FLAG_CONFIG, FLAG_KEYFRAME, encodeFrame, shouldSendFrame } from '../src/api/routes/live.js';
import { chooseMode, decodeFrame, orientedScreen, viewMode } from '../static/dashboard/ts/live-modes.js';
import type { RegisteredDevice } from '../src/devices/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

const DEVICES_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'bl-live-')), 'devices.json');
const ANDROID: RegisteredDevice = {
    name: 'Pixel 7', udid: 'R58N12ABCDE', platform: 'android', driver: 'adb',
    android: { serial: 'R58N12ABCDE' }, pluginData: {},
};
writeFileSync(DEVICES_PATH, JSON.stringify([ANDROID]));
process.env.DEVICES_CONFIG_PATH = DEVICES_PATH;
process.env.ANDROID_DISCOVERY = 'off';

const { createApp } = await import('../src/api/app.js');
const { PluginRegistry } = await import('../src/registry.js');

/* ---- the wire format -------------------------------------------------- */

const CONFIG_FLAG = 1n << 63n;
const KEY_FLAG = 1n << 62n;

function packet(data: Buffer, options: { ptsUs?: number; keyframe?: boolean; config?: boolean } = {}): Buffer {
    const header = Buffer.alloc(12);
    let marked = BigInt(options.ptsUs ?? 0);
    if (options.config) marked |= CONFIG_FLAG;
    if (options.keyframe) marked |= KEY_FLAG;
    header.writeBigUInt64BE(marked, 0);
    header.writeUInt32BE(data.length, 8);
    return Buffer.concat([header, data]);
}

function nal(type: number, payload: number[] = [0x11, 0x22]): Buffer {
    return Buffer.from([0, 0, 0, 1, 0x60 | type, ...payload]);
}

function header(name = 'Pixel 7', width = 1080, height = 2400): Buffer {
    const dummy = Buffer.from([0]);
    const nameField = Buffer.alloc(64);
    nameField.write(name, 'utf8');
    const codec = Buffer.alloc(12);
    codec.writeUInt32BE(0x68_32_36_34, 0);
    codec.writeUInt32BE(width, 4);
    codec.writeUInt32BE(height, 8);
    return Buffer.concat([dummy, nameField, codec]);
}

test('the parser reads the device name, the codec header and one frame', () => {
    const parser = new ScrcpyStreamParser();
    const events = parser.push(Buffer.concat([
        header(), packet(nal(1), { ptsUs: 2_000_000 }),
    ]));
    assert.deepEqual(events[0], { type: 'device', name: 'Pixel 7' });
    assert.deepEqual(events[1], { type: 'codec', codec: 'h264', width: 1080, height: 2400 });
    assert.equal(events[2]?.type, 'frame');
    const frame = events[2]!.type === 'frame' ? events[2]!.frame : undefined;
    assert.equal(frame?.ptsUs, 2_000_000);
    assert.equal(frame?.keyframe, false);
    assert.equal(frame?.config, false);
});

test('a frame split across chunks is only emitted once all of it has arrived', () => {
    const stream = Buffer.concat([header(), packet(nal(5, [1, 2, 3, 4, 5, 6]), { ptsUs: 10, keyframe: true })]);
    const parser = new ScrcpyStreamParser();
    const events = [];
    // One byte at a time is the worst a socket can do, so it is what the test does.
    for (const byte of stream) events.push(...parser.push(Buffer.from([byte])));
    const frames = events.filter((event) => event.type === 'frame');
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.type === 'frame' && frames[0]!.frame.keyframe, true);
});

test('the config packet carries no timestamp and is marked as configuration', () => {
    const parser = new ScrcpyStreamParser();
    const events = parser.push(Buffer.concat([
        header(), packet(Buffer.concat([nal(7), nal(8)]), { config: true }),
    ]));
    const frame = events.find((event) => event.type === 'frame');
    assert.ok(frame && frame.type === 'frame');
    assert.equal(frame.frame.config, true);
    assert.equal(frame.frame.ptsUs, null);
    // Parameter sets always precede an IDR, so they count as a keyframe for the browser's sake.
    assert.equal(frame.frame.keyframe, true);
});

test('a keyframe is recognised from NAL types 5, 7 and 8 and nothing else', () => {
    assert.equal(containsKeyframe(nal(5)), true);
    assert.equal(containsKeyframe(nal(7)), true);
    assert.equal(containsKeyframe(nal(8)), true);
    assert.equal(containsKeyframe(nal(1)), false);
    assert.equal(containsKeyframe(Buffer.alloc(0)), false);
});

test('the parameter sets and the WebCodecs codec string come out of the config packet', () => {
    const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xaa]);
    const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80]);
    const sets = parameterSets(Buffer.concat([sps, pps]));
    assert.deepEqual([...(sets.sps ?? [])], [...sps.subarray(4)]);
    assert.deepEqual([...(sets.pps ?? [])], [...pps.subarray(4)]);
    assert.equal(avcCodecString(sets.sps), 'avc1.640028');
    assert.equal(avcCodecString(Buffer.from([1, 2])), undefined);
});

test('scrcpy is only usable when both the jar and a version are found', async () => {
    const present = await detectScrcpy({
        env: { SCRCPY_SERVER: '/opt/homebrew/share/scrcpy/scrcpy-server' },
        exists: async () => true,
        run: async () => ({ stdout: 'scrcpy 3.1 <https://github.com/Genymobile/scrcpy>', stderr: '' }),
    });
    assert.deepEqual(
        { available: present.available, version: present.version, message: present.message },
        { available: true, version: '3.1', message: 'live video: scrcpy 3.1' },
    );
    const missing = await detectScrcpy({ env: {}, exists: async () => false, run: async () => ({ stdout: '', stderr: '' }) });
    assert.equal(missing.available, false);
    assert.equal(missing.message, STILLS_ONLY_MESSAGE);
    assert.equal(liveVideoMessage({ available: false }), STILLS_ONLY_MESSAGE);
    assert.equal(parseScrcpyVersion('scrcpy 2.7\n'), '2.7');
    assert.equal(parseScrcpyVersion('nothing here'), undefined);
    assert.equal(parseForwardedPort('49213\n'), 49213);
    assert.equal(parseForwardedPort('error: device offline'), undefined);
});

test('the server is started video-only, at the size and rate the watchers asked for', () => {
    const args = serverArgs({ version: '3.1', scid: '0a0b0c0d', maxSize: 400, maxFps: 10 });
    assert.equal(args[0], 'CLASSPATH=/data/local/tmp/scrcpy-server.jar');
    assert.deepEqual(args.slice(1, 5), ['app_process', '/', 'com.genymobile.scrcpy.Server', '3.1']);
    for (const expected of ['scid=0a0b0c0d', 'tunnel_forward=true', 'video=true', 'audio=false',
        'control=false', 'max_size=400', 'max_fps=10', 'video_codec=h264', 'send_frame_meta=true',
        'send_device_meta=true', 'raw_stream=false']) {
        assert.ok(args.includes(expected), expected);
    }
});

/* ---- sessions --------------------------------------------------------- */

interface FakeStream {
    udid: string;
    quality: LiveQuality;
    handlers: LiveStreamHandlers;
    stopped: boolean;
}

function fakeRunner() {
    const started: FakeStream[] = [];
    const timers: Array<{ run: () => void; ms: number }> = [];
    const manager = (options: { maxStreams?: number } = {}) => createSessionManager({
        ...options,
        lingerMs: 4_000,
        setTimer: (run, ms) => {
            const timer = { run, ms };
            timers.push(timer);
            return timer;
        },
        clearTimer: (handle) => {
            const index = timers.indexOf(handle as { run: () => void; ms: number });
            if (index >= 0) timers.splice(index, 1);
        },
        start: async (udid, quality, handlers) => {
            const stream: FakeStream = { udid, quality, handlers, stopped: false };
            started.push(stream);
            return { stop() { stream.stopped = true; } };
        },
    });
    const fire = () => {
        const pending = timers.splice(0, timers.length);
        for (const timer of pending) timer.run();
    };
    return { started, timers, manager, fire };
}

function watcher(id: string, quality: LiveQuality = WALL_QUALITY) {
    const frames: Array<{ keyframe: boolean }> = [];
    const ends: string[] = [];
    return {
        frames, ends,
        subscriber: {
            id, quality,
            config() {},
            frame(frame: { keyframe: boolean }) { frames.push(frame); },
            ended(reason: string) { ends.push(reason); },
        },
    };
}

test('one stream serves every watcher of the same phone', async () => {
    const rig = fakeRunner();
    const sessions = rig.manager();
    await sessions.subscribe('udid-a', watcher('one').subscriber);
    await sessions.subscribe('udid-a', watcher('two').subscriber);
    await sessions.subscribe('udid-b', watcher('three').subscriber);
    assert.equal(rig.started.length, 2);
    assert.equal(sessions.active(), 2);
});

test('a stream stops after the last watcher leaves, unless one comes back first', async () => {
    const rig = fakeRunner();
    const sessions = rig.manager();
    await sessions.subscribe('udid-a', watcher('one').subscriber);
    sessions.unsubscribe('udid-a', 'one');
    assert.equal(rig.started[0]!.stopped, false, 'it lingers rather than stopping at once');
    await sessions.subscribe('udid-a', watcher('two').subscriber);
    rig.fire();
    assert.equal(rig.started[0]!.stopped, false, 'a watcher that came back cancelled the stop');
    assert.equal(rig.started.length, 1, 'and no second stream was started');

    sessions.unsubscribe('udid-a', 'two');
    rig.fire();
    assert.equal(rig.started[0]!.stopped, true);
    assert.equal(sessions.active(), 0);
});

test('the farm streams no more phones at once than it is allowed', async () => {
    const rig = fakeRunner();
    const sessions = rig.manager({ maxStreams: 2 });
    await sessions.subscribe('udid-a', watcher('a').subscriber);
    await sessions.subscribe('udid-b', watcher('b').subscriber);
    await assert.rejects(
        sessions.subscribe('udid-c', watcher('c').subscriber),
        (error: unknown) => error instanceof LiveUnavailableError,
    );
    assert.equal(sessions.active(), 2);
    assert.equal(maxStreamsFromEnv({ LIVE_MAX_STREAMS: '3' } as NodeJS.ProcessEnv), 3);
    assert.equal(maxStreamsFromEnv({} as NodeJS.ProcessEnv), 12);
});

test('the stream is restarted at the size the largest watcher needs, and shrinks again', async () => {
    const rig = fakeRunner();
    const sessions = rig.manager();
    await sessions.subscribe('udid-a', watcher('tile', WALL_QUALITY).subscriber);
    assert.deepEqual(rig.started[0]!.quality, WALL_QUALITY);

    await sessions.subscribe('udid-a', watcher('viewer', VIEWER_QUALITY).subscriber);
    assert.equal(rig.started.length, 2, 'a bigger watcher renegotiates the stream');
    assert.equal(rig.started[0]!.stopped, true);
    assert.deepEqual(rig.started[1]!.quality, VIEWER_QUALITY);

    sessions.unsubscribe('udid-a', 'viewer');
    await Promise.resolve();
    assert.equal(rig.started.length, 3);
    assert.deepEqual(rig.started[2]!.quality, WALL_QUALITY);
    assert.deepEqual(qualityFor([WALL_QUALITY, VIEWER_QUALITY]), VIEWER_QUALITY);
});

test('asking for a keyframe restarts the stream, which is how scrcpy sends an IDR', async () => {
    const rig = fakeRunner();
    const sessions = rig.manager();
    await sessions.subscribe('udid-a', watcher('one').subscriber);
    await sessions.requestKeyframe('udid-a');
    assert.equal(rig.started.length, 2);
    assert.equal(rig.started[0]!.stopped, true);
    assert.deepEqual(rig.started[1]!.quality, WALL_QUALITY);
    // A phone nobody is watching has nothing to restart.
    await sessions.requestKeyframe('udid-none');
    assert.equal(rig.started.length, 2);
});

test('a stream that ends tells its watchers, and the session is forgotten', async () => {
    const rig = fakeRunner();
    const sessions = rig.manager();
    const one = watcher('one');
    await sessions.subscribe('udid-a', one.subscriber);
    rig.started[0]!.handlers.end('the phone was unplugged');
    assert.deepEqual(one.ends, ['the phone was unplugged']);
    assert.equal(sessions.active(), 0);
});

/* ---- the socket ------------------------------------------------------- */

test('frames are dropped when the socket is behind, but keyframes are given room', () => {
    assert.equal(shouldSendFrame(0, false, 1_000), true);
    assert.equal(shouldSendFrame(2_000, false, 1_000), false, 'a picture frame goes when the socket is behind');
    assert.equal(shouldSendFrame(2_000, true, 1_000), true, 'a keyframe is worth waiting for');
    assert.equal(shouldSendFrame(5_000, true, 1_000), false, 'until the socket is hopeless');

    const encoded = encodeFrame({ data: Uint8Array.from([9, 9]), keyframe: true, config: false, timestampMs: 1234 });
    assert.equal(encoded[0], FLAG_KEYFRAME);
    assert.equal(encoded.readUInt32BE(4), 1234);
    assert.deepEqual([...encoded.subarray(8)], [9, 9]);
    assert.equal(encodeFrame({ data: new Uint8Array(), keyframe: true, config: true, timestampMs: 0 })[0],
        FLAG_KEYFRAME | FLAG_CONFIG);
});

interface AppOptions {
    available?: boolean;
    auth?: boolean;
    start?: (handlers: LiveStreamHandlers) => void;
}

async function liveApp(context: { after(fn: () => unknown): void }, options: AppOptions = {}) {
    const app = await createApp({
        plugins: new PluginRegistry([]),
        scheduler: { async activeExecution() { return null; } } as unknown as SchedulerRepository,
        connectedUdids: async () => [ANDROID.udid],
        ...(options.auth
            ? {
                authProvider: {
                    id: 'test', logoutPath: '/auth/logout',
                    registerRoutes() {},
                    async authenticate(request: { headers: Record<string, unknown> }) {
                        return request.headers['x-live-test'] === 'yes' ? { id: 'u', roles: [] } : null;
                    },
                    isPublicPath() { return false; },
                },
            }
            : {}),
        liveVideo: {
            async status() {
                return options.available === false
                    ? { available: false, message: STILLS_ONLY_MESSAGE }
                    : { available: true, version: '3.1', jarPath: '/tmp/scrcpy-server', message: 'live video: scrcpy 3.1' };
            },
            async start(_udid, _quality, handlers) {
                options.start?.(handlers);
                return { stop() {} };
            },
        },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = `ws://127.0.0.1:${port}/api/devices/${ANDROID.udid}/live`;
    const sockets: WebSocket[] = [];
    // Fastify waits for every connection before it closes, so each socket is dropped, and its
    // close is waited for, before the server is asked to stop.
    context.after(async () => {
        await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) return resolve();
            socket.once('close', () => resolve());
            socket.terminate();
        })));
        await app.close();
    });
    const open = (headers: Record<string, string> = {}) => {
        const socket = new WebSocket(url, { headers });
        sockets.push(socket);
        return socket;
    };
    return { app, url, open };
}

/**
 * Messages can land before a test gets round to listening for them, so every one is collected
 * from the moment the socket exists and handed out in order.
 */
function messages(socket: WebSocket) {
    const seen: Array<string | Buffer> = [];
    const waiting: Array<(message: string | Buffer) => void> = [];
    socket.on('message', (data: Buffer, isBinary: boolean) => {
        const message = isBinary ? data : data.toString('utf8');
        const next = waiting.shift();
        if (next) next(message);
        else seen.push(message);
    });
    return {
        next(): Promise<string | Buffer> {
            const ready = seen.shift();
            if (ready !== undefined) return Promise.resolve(ready);
            return new Promise((resolve, reject) => {
                waiting.push(resolve);
                socket.once('error', reject);
                socket.once('close', () => reject(new Error('the socket closed with nothing to read')));
            });
        },
    };
}

test('the live socket sends a config message and then binary frames', async (context) => {
    const { open } = await liveApp(context, {
        start(handlers) {
            handlers.codec({ codec: 'h264', width: 720, height: 1600 });
            handlers.frame({
                data: Uint8Array.from([0, 0, 0, 1, 0x65, 1, 2]), keyframe: true, config: false, ptsUs: 3_000_000,
            });
        },
    });
    const socket = open();
    const inbox = messages(socket);
    const config = await inbox.next();
    assert.deepEqual(JSON.parse(String(config)), { type: 'config', codec: 'h264', width: 720, height: 1600 });
    const frame = await inbox.next();
    assert.ok(Buffer.isBuffer(frame));
    assert.equal(frame[0], FLAG_KEYFRAME);
    assert.equal(frame.readUInt32BE(4), 3_000);
    assert.deepEqual([...frame.subarray(8)], [0, 0, 0, 1, 0x65, 1, 2]);
});

test('a farm without scrcpy says so on the socket rather than leaving it open', async (context) => {
    const { app, open } = await liveApp(context, { available: false });
    const status = await app.inject({ method: 'GET', url: '/api/live/status' });
    assert.deepEqual(status.json(), { available: false, message: STILLS_ONLY_MESSAGE });
    const message = await messages(open()).next();
    assert.deepEqual(JSON.parse(String(message)), { type: 'unavailable', message: STILLS_ONLY_MESSAGE });
});

test('the live socket is authenticated like the rest of the API', async (context) => {
    const { open } = await liveApp(context, { auth: true });
    const refused = open();
    const outcome = await new Promise<string>((resolve) => {
        refused.once('unexpected-response', (_request, response) => {
            // The refused upgrade leaves a connection Fastify would wait for at close.
            response.socket?.destroy();
            resolve(`status ${response.statusCode}`);
        });
        refused.once('open', () => resolve('opened'));
        refused.once('error', () => resolve('refused'));
    });
    assert.notEqual(outcome, 'opened', 'an unauthenticated upgrade must not succeed');

    const allowed = open({ 'x-live-test': 'yes' });
    await new Promise((resolve, reject) => {
        allowed.once('open', resolve);
        allowed.once('error', reject);
    });
});

/* ---- the browser's decisions ------------------------------------------ */

test('live is only chosen when everything it needs is there', () => {
    const base = { preference: 'live' as const, webCodecs: true, serverAvailable: true, socketFailures: 0, platform: 'android' };
    assert.equal(chooseMode(base), 'live');
    assert.equal(chooseMode({ ...base, preference: 'off' }), 'off');
    assert.equal(chooseMode({ ...base, preference: 'stills' }), 'stills');
    assert.equal(chooseMode({ ...base, webCodecs: false }), 'stills');
    assert.equal(chooseMode({ ...base, serverAvailable: false }), 'stills');
    assert.equal(chooseMode({ ...base, socketFailures: 2 }), 'stills');
    assert.equal(chooseMode({ ...base, platform: 'ios' }), 'stills', 'iPhones keep MJPEG');
    assert.equal(viewMode(0), 'off');
    assert.equal(viewMode(2), 'live');
    assert.equal(viewMode(9), 'live');
});

test('the browser reads the frame header and maps taps through the stream size', () => {
    const encoded = encodeFrame({ data: Uint8Array.from([1, 2, 3]), keyframe: false, config: false, timestampMs: 77 });
    const decoded = decodeFrame(new Uint8Array(encoded));
    assert.deepEqual(decoded && { ...decoded, data: [...decoded.data] },
        { keyframe: false, config: false, timestampMs: 77, data: [1, 2, 3] });
    assert.equal(decodeFrame(new Uint8Array(3)), undefined);

    const portrait = { width: 1080, height: 2400 };
    assert.deepEqual(orientedScreen(portrait, undefined), portrait);
    assert.deepEqual(orientedScreen(portrait, { width: 360, height: 800 }), portrait);
    assert.deepEqual(orientedScreen(portrait, { width: 800, height: 360 }), { width: 2400, height: 1080 });
});
