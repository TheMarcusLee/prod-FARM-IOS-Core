/**
 * scrcpy's server, used as a video source. The jar it ships is pushed to the phone, started
 * through `app_process`, and speaks a small binary protocol back over an adb forward: a dummy
 * byte, the device name, one codec header, then H.264 access units with a 12-byte header each.
 *
 * Only the parsing and the process handling live here; who is watching what is
 * `src/live/sessions.ts`. See docs/live-video.md.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { runCommand, type CommandRunner } from '../drivers/common.js';

/** Where the jar is pushed. scrcpy itself uses this path, so a leftover copy is harmless. */
export const SERVER_REMOTE_PATH = '/data/local/tmp/scrcpy-server.jar';

/** The header scrcpy writes before each access unit: 8 bytes of pts and flags, 4 of length. */
export const FRAME_HEADER_BYTES = 12;

/** `send_device_meta=true` writes the device name in a fixed-width, null-padded field. */
export const DEVICE_NAME_BYTES = 64;

// scrcpy 4.x: bit 63 marks a session packet (size announcement), 62 a config packet, 61 a keyframe.
const PACKET_FLAG_SESSION = 1n << 63n;
const PACKET_FLAG_CONFIG = 1n << 62n;
const PACKET_FLAG_KEY_FRAME = 1n << 61n;
const PTS_MASK = (1n << 61n) - 1n;
const SESSION_PACKET_BYTES = 12;

/** Codec ids are four ASCII bytes read as a big-endian u32. */
const CODEC_NAMES: Record<number, string> = {
    0x68_32_36_34: 'h264',
    0x68_32_36_35: 'h265',
    0x00_61_76_31: 'av1',
};

export type ScrcpyEvent =
    | { type: 'device'; name: string }
    | { type: 'codec'; codec: string; width: number; height: number }
    | { type: 'frame'; frame: ScrcpyFrame };

export interface ScrcpyFrame {
    /** One access unit in Annex B framing (start codes included). */
    data: Buffer;
    /** Presentation timestamp in microseconds; null for the codec-config packet, which has none. */
    ptsUs: number | null;
    /** True for an IDR, and for the SPS/PPS packet that precedes one. */
    keyframe: boolean;
    /** True when this packet is only codec configuration, not a picture. */
    config: boolean;
}

export interface ScrcpyParserOptions {
    /** `tunnel_forward=true` makes the server write one byte before anything else. */
    dummyByte?: boolean;
    /** `send_device_meta=true` (the default) writes a 64-byte device name. */
    deviceMeta?: boolean;
    /** `send_codec_meta=true` (the default) writes the codec id and the video size. */
    codecMeta?: boolean;
}

type Stage = 'dummy' | 'name' | 'codec' | 'frames';

/**
 * Fed whatever the socket hands over, in whatever sizes it hands it over. A frame is only
 * emitted once every one of its bytes has arrived, so a caller never sees half a picture.
 */
export class ScrcpyStreamParser {
    private buffer: Buffer = Buffer.alloc(0);
    private stage: Stage;
    private readonly codecMeta: boolean;
    private readonly deviceMeta: boolean;
    private codecName = 'h264';

    constructor(options: ScrcpyParserOptions = {}) {
        this.deviceMeta = options.deviceMeta ?? true;
        this.codecMeta = options.codecMeta ?? true;
        this.stage = options.dummyByte === false
            ? (this.deviceMeta ? 'name' : this.codecMeta ? 'codec' : 'frames')
            : 'dummy';
    }

    push(chunk: Uint8Array): ScrcpyEvent[] {
        this.buffer = this.buffer.length
            ? Buffer.concat([this.buffer, Buffer.from(chunk)])
            : Buffer.from(chunk);
        const events: ScrcpyEvent[] = [];
        for (;;) {
            const event = this.step(events);
            if (!event) return events;
        }
    }

    /** One transition; returns false when the buffer is short of the next whole thing. */
    private step(events: ScrcpyEvent[]): boolean {
        if (this.stage === 'dummy') {
            if (this.buffer.length < 1) return false;
            this.buffer = this.buffer.subarray(1);
            this.stage = this.deviceMeta ? 'name' : this.codecMeta ? 'codec' : 'frames';
            return true;
        }
        if (this.stage === 'name') {
            if (this.buffer.length < DEVICE_NAME_BYTES) return false;
            const field = this.buffer.subarray(0, DEVICE_NAME_BYTES);
            this.buffer = this.buffer.subarray(DEVICE_NAME_BYTES);
            const end = field.indexOf(0);
            events.push({ type: 'device', name: field.subarray(0, end < 0 ? field.length : end).toString('utf8') });
            this.stage = this.codecMeta ? 'codec' : 'frames';
            return true;
        }
        if (this.stage === 'codec') {
            // scrcpy 4.x sends only the codec id here; the picture size follows as a session packet.
            if (this.buffer.length < 4) return false;
            const id = this.buffer.readUInt32BE(0);
            this.buffer = this.buffer.subarray(4);
            this.codecName = CODEC_NAMES[id] ?? 'unknown';
            this.stage = 'frames';
            return true;
        }
        if (this.buffer.length < FRAME_HEADER_BYTES) return false;
        if ((this.buffer.readBigUInt64BE(0) & PACKET_FLAG_SESSION) !== 0n) {
            // Session packet: flags(4) width(4) height(4). Sent at start and again on rotation.
            if (this.buffer.length < SESSION_PACKET_BYTES) return false;
            const width = this.buffer.readUInt32BE(4);
            const height = this.buffer.readUInt32BE(8);
            this.buffer = this.buffer.subarray(SESSION_PACKET_BYTES);
            events.push({ type: 'codec', codec: this.codecName, width, height });
            return true;
        }
        const size = this.buffer.readUInt32BE(8);
        if (this.buffer.length < FRAME_HEADER_BYTES + size) return false;
        const marked = this.buffer.readBigUInt64BE(0);
        const data = Buffer.from(this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + size));
        this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + size);
        const config = (marked & PACKET_FLAG_CONFIG) !== 0n;
        events.push({
            type: 'frame',
            frame: {
                data, config,
                ptsUs: config ? null : Number(marked & PTS_MASK),
                keyframe: (marked & PACKET_FLAG_KEY_FRAME) !== 0n || containsKeyframe(data),
            },
        });
        return true;
    }
}

/** Every NAL unit in an Annex B buffer, as `[type, payload]` pairs. */
export function nalUnits(data: Uint8Array): Array<{ type: number; start: number; end: number }> {
    const units: Array<{ type: number; start: number; end: number }> = [];
    let index = 0;
    let openedAt = -1;
    let openedType = -1;
    while (index + 2 < data.length) {
        const isStart = data[index] === 0 && data[index + 1] === 0
            && (data[index + 2] === 1 || (data[index + 2] === 0 && data[index + 3] === 1));
        if (!isStart) {
            index += 1;
            continue;
        }
        const length = data[index + 2] === 1 ? 3 : 4;
        if (openedAt >= 0) units.push({ type: openedType, start: openedAt, end: index });
        openedAt = index + length;
        openedType = (data[openedAt] ?? 0) & 0x1f;
        index += length;
    }
    if (openedAt >= 0) units.push({ type: openedType, start: openedAt, end: data.length });
    return units;
}

/** An IDR picture (5), or the parameter sets (7, 8) that always precede one. */
export function containsKeyframe(data: Uint8Array): boolean {
    return nalUnits(data).some(({ type }) => type === 5 || type === 7 || type === 8);
}

/** The SPS and PPS out of a codec-config packet, without their start codes. */
export function parameterSets(data: Uint8Array): { sps?: Buffer; pps?: Buffer } {
    const sets: { sps?: Buffer; pps?: Buffer } = {};
    for (const unit of nalUnits(data)) {
        const payload = Buffer.from(data.subarray(unit.start, unit.end));
        if (unit.type === 7 && !sets.sps) sets.sps = payload;
        if (unit.type === 8 && !sets.pps) sets.pps = payload;
    }
    return sets;
}

/**
 * The `avc1.PPCCLL` string WebCodecs wants, read straight out of the SPS: profile_idc, the
 * constraint flags byte, level_idc. Undefined when the SPS is too short to say.
 */
export function avcCodecString(sps: Uint8Array | undefined): string | undefined {
    if (!sps || sps.length < 4) return undefined;
    const hex = [sps[1]!, sps[2]!, sps[3]!].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `avc1.${hex}`;
}

/* ---- finding the server ----------------------------------------------- */

export interface LiveVideoStatus {
    available: boolean;
    /** "3.1", when scrcpy told us. */
    version?: string;
    jarPath?: string;
    /** The sentence the Rig page and the inspector print. */
    message: string;
}

export const STILLS_ONLY_MESSAGE = 'stills only: install scrcpy (brew install scrcpy)';

export function liveVideoMessage(status: Pick<LiveVideoStatus, 'available' | 'version'>): string {
    return status.available && status.version ? `live video: scrcpy ${status.version}` : STILLS_ONLY_MESSAGE;
}

/** `scrcpy --version` prints "scrcpy 3.1 <https://…>" on its first line. */
export function parseScrcpyVersion(output: string): string | undefined {
    return /scrcpy\s+v?(\d+\.\d+(?:\.\d+)?)/i.exec(output)?.[1];
}

export interface DetectOptions {
    env?: NodeJS.ProcessEnv;
    run?: CommandRunner;
    exists?: (file: string) => Promise<boolean>;
}

const HOMEBREW_PREFIXES = ['/opt/homebrew', '/usr/local'];

async function fileExists(file: string): Promise<boolean> {
    try {
        await access(file);
        return true;
    } catch { return false; }
}

/**
 * Where the jar is and what version speaks to it. `SCRCPY_SERVER` wins; otherwise the Homebrew
 * copy. Anything missing means the feature is simply not available and the wall keeps polling.
 */
export async function detectScrcpy(options: DetectOptions = {}): Promise<LiveVideoStatus> {
    const env = options.env ?? process.env;
    const run = options.run ?? runCommand;
    const exists = options.exists ?? fileExists;
    const candidates = env.SCRCPY_SERVER
        ? [env.SCRCPY_SERVER]
        : HOMEBREW_PREFIXES.map((prefix) => path.join(prefix, 'share/scrcpy/scrcpy-server'));
    let jarPath: string | undefined;
    for (const candidate of candidates) {
        if (await exists(candidate)) {
            jarPath = candidate;
            break;
        }
    }
    if (!jarPath) return { available: false, message: STILLS_ONLY_MESSAGE };
    let version = env.SCRCPY_VERSION;
    if (!version) {
        try {
            const { stdout } = await run('scrcpy', ['--version'], { timeoutMs: 5_000 });
            version = parseScrcpyVersion(String(stdout));
        } catch { version = undefined; }
    }
    // The server refuses to start unless the version string matches the jar it was built from,
    // so an unknown version is the same as no server at all.
    if (!version) return { available: false, jarPath, message: STILLS_ONLY_MESSAGE };
    return { available: true, version, jarPath, message: liveVideoMessage({ available: true, version }) };
}

let detected: Promise<LiveVideoStatus> | undefined;

/** Detected once per process; the answer only changes when someone installs scrcpy. */
export function liveVideoStatus(options: DetectOptions = {}): Promise<LiveVideoStatus> {
    return (detected ??= detectScrcpy(options));
}

export function forgetLiveVideoStatus(): void {
    detected = undefined;
}

/* ---- starting one stream ---------------------------------------------- */

export interface ScrcpyServerOptions {
    version: string;
    scid: string;
    maxSize: number;
    maxFps: number;
}

/**
 * The argv `app_process` is handed. Video only: audio and control are scrcpy's own, and the farm
 * already has remote input of its own through adb.
 */
export function serverArgs(options: ScrcpyServerOptions): string[] {
    return [
        `CLASSPATH=${SERVER_REMOTE_PATH}`, 'app_process', '/', 'com.genymobile.scrcpy.Server',
        options.version,
        `scid=${options.scid}`,
        'tunnel_forward=true',
        'video=true', 'audio=false', 'control=false',
        `max_size=${Math.round(options.maxSize)}`,
        `max_fps=${Math.round(options.maxFps)}`,
        'video_codec=h264',
        'send_frame_meta=true', 'send_device_meta=true', 'raw_stream=false',
    ];
}

/** scrcpy's own scid: eight lowercase hex digits, high bit clear. */
export function randomScid(random: () => number = Math.random): string {
    return Math.floor(random() * 0x7fff_ffff).toString(16).padStart(8, '0');
}

/** `adb forward tcp:0 …` prints the port it allocated. */
export function parseForwardedPort(output: string): number | undefined {
    const port = Number(String(output).trim().split(/\r?\n/).pop());
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

export interface ScrcpyStreamHandlers {
    codec(info: { codec: string; width: number; height: number }): void;
    frame(frame: ScrcpyFrame): void;
    end(reason?: string): void;
}

export interface ScrcpyStream {
    stop(): Promise<void>;
}

export interface StartScrcpyOptions {
    serial: string;
    status: LiveVideoStatus;
    maxSize: number;
    maxFps: number;
    run?: CommandRunner;
    spawnProcess?: typeof spawn;
    connect?: (port: number) => Promise<net.Socket>;
}

function connectLocal(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

/**
 * Push, forward, start, connect. Every step is undone by `stop()` in reverse, including the adb
 * forward — a farm that starts and stops streams all day would otherwise leak one per session.
 */
export async function startScrcpyStream(
    options: StartScrcpyOptions, handlers: ScrcpyStreamHandlers,
): Promise<ScrcpyStream> {
    const { serial, status } = options;
    if (!status.available || !status.jarPath || !status.version) throw new Error(STILLS_ONLY_MESSAGE);
    const run = options.run ?? runCommand;
    const spawnProcess = options.spawnProcess ?? spawn;
    const connect = options.connect ?? connectLocal;
    const scid = randomScid();
    const adb = (...args: string[]) => run('adb', ['-s', serial, ...args], { timeoutMs: 60_000 });

    await adb('push', status.jarPath, SERVER_REMOTE_PATH);
    const forwarded = await adb('forward', 'tcp:0', `localabstract:scrcpy_${scid}`);
    const port = parseForwardedPort(String(forwarded.stdout));
    if (!port) throw new Error('adb forward did not report a port for the scrcpy tunnel');

    let child: ChildProcess | undefined;
    let socket: net.Socket | undefined;
    let stopped = false;
    const cleanUp = async () => {
        socket?.destroy();
        child?.kill('SIGTERM');
        try { await adb('forward', '--remove', `tcp:${port}`); } catch { /* the phone is already gone */ }
    };

    child = spawnProcess('adb', ['-s', serial, 'shell', ...serverArgs({
        version: status.version, scid, maxSize: options.maxSize, maxFps: options.maxFps,
    })], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('exit', () => {
        if (!stopped) handlers.end('the scrcpy server stopped');
    });

    // Keep the server's complaints: when the stream never starts, they are the only clue.
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
    let first: Buffer;
    try {
        ({ socket, first } = await connectWithRetries(connect, port));
    } catch (error) {
        await cleanUp();
        throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? ` · server said: ${stderr.trim()}` : ''}`);
    }
    const parser = new ScrcpyStreamParser();
    const feed = (chunk: Buffer) => {
        for (const event of parser.push(chunk)) {
            if (event.type === 'codec') handlers.codec(event);
            else if (event.type === 'frame') handlers.frame(event.frame);
        }
    };
    feed(first);
    socket.on('data', feed);
    socket.once('close', () => { if (!stopped) handlers.end('the phone closed the video stream'); });
    socket.once('error', (error: Error) => { if (!stopped) handlers.end(error.message); });

    return {
        async stop() {
            stopped = true;
            await cleanUp();
        },
    };
}

/**
 * The server needs a moment to bind its socket after `app_process` starts, and adb's forward
 * accepts our TCP connection *before* the phone side is listening, then drops it: a connect that
 * succeeds and closes with no bytes is "not ready yet", not "ended". So a connection only counts
 * once the server's first byte (the tunnel_forward dummy) has arrived, exactly as scrcpy's own
 * client does. The bytes read while deciding are handed back so nothing is lost.
 */
async function connectWithRetries(
    connect: (port: number) => Promise<net.Socket>, port: number, attempts = 40,
): Promise<{ socket: net.Socket; first: Buffer }> {
    let last: unknown = 'no answer';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        let socket: net.Socket | undefined;
        try {
            socket = await connect(port);
            const first = await firstBytes(socket, 1_500);
            if (first) return { socket, first };
            last = 'the tunnel closed before the server answered';
        } catch (error) {
            last = error;
        }
        socket?.destroy();
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Could not reach the scrcpy server on port ${port}: ${String(last)}`);
}

/** Resolves with the first data the socket delivers, or undefined if it closes or stays silent. */
function firstBytes(socket: net.Socket, timeoutMs: number): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
        const done = (value: Buffer | undefined) => {
            clearTimeout(timer);
            socket.off('data', onData); socket.off('close', onClose); socket.off('error', onClose); socket.off('end', onClose);
            resolve(value);
        };
        const onData = (chunk: Buffer) => done(chunk);
        const onClose = () => done(undefined);
        const timer = setTimeout(() => done(undefined), timeoutMs);
        socket.once('data', onData);
        socket.once('close', onClose); socket.once('error', onClose); socket.once('end', onClose);
    });
}
