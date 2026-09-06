import path from 'node:path';

import type { MotionSettings } from '../motion/profile.js';
import type { Seed } from '../motion/rng.js';
import { driverMotion, straightPath, type MotionSource } from '../motion/source.js';
import { errorMessage, pause, runCommand, type CommandRunner } from './common.js';
import { parseUiautomatorXml } from './uiautomator-xml.js';
import {
    DriverError,
    type DeviceDriver, type Key, type MediaFile, type Point, type ScreenGeometry, type Swipe,
    type TimedPoint, type UiNode,
} from './types.js';

export interface AdbDriverOptions {
    /** adb serial; doubles as the farm UDID for Android devices. */
    serial: string;
    run?: CommandRunner;
    /** Where pushed media lands. TikTok's picker reads the standard camera folder. */
    mediaDirectory?: string;
    /** Handedness and pace for the generated swipe arcs; defaults to the serial's stable profile. */
    motion?: MotionSettings;
    /** One seed per run, so a replay draws the same paths. Defaults to `MOTION_SEED` or the clock. */
    motionSeed?: Seed;
}

const ANDROID_KEYCODES: Record<Key, number> = { home: 3, back: 4, enter: 66, delete: 67, recents: 187, power: 26 };

/** uiautomator writes here, then we `cat` it; OEM builds only ever print a banner on stdout. */
const DUMP_PATH = '/sdcard/window_dump.xml';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Android over the Android Debug Bridge: `adb shell input` for touch, `screencap` for pixels,
 * `uiautomator dump` for the tree. Works over USB or wireless debugging (`adb tcpip 5555`).
 * Modelled on simvyn's android adapter, trimmed to what a posting routine needs.
 */
export function createAdbDriver(options: AdbDriverOptions): DeviceDriver {
    const { serial } = options;
    const run = options.run ?? runCommand;
    const mediaDirectory = options.mediaDirectory ?? '/sdcard/DCIM/Camera';
    const adb = (...args: string[]) => run('adb', ['-s', serial, ...args]);
    const shell = (...args: string[]) => adb('shell', ...args);
    // A minute-long clip over USB 2 takes far longer than the 30s default command deadline.
    const push = (localPath: string, remotePath: string) =>
        run('adb', ['-s', serial, 'push', localPath, remotePath], { timeoutMs: 10 * 60_000 });
    let cachedScreen: ScreenGeometry | undefined;
    let hand: MotionSource | undefined;
    const motion = () => (hand ??= driverMotion(serial, options.motion, options.motionSeed));
    const motionEvents = createMotionEventBudget();

    return {
        kind: 'adb',
        platform: 'android',
        udid: serial,
        launchApp: (packageName) => launchViaAdb(packageName, shell),
        terminateApp: async (packageName) => { await shell('am', 'force-stop', shellQuote(packageName)); },
        tap: async ({ x, y }: Point) => { await shell('input', 'tap', String(Math.round(x)), String(Math.round(y))); },
        swipe: async ({ from, to, durationMs, straight }: Swipe) => {
            const path = straight
                ? straightPath(from, to, durationMs)
                : motion().path(from, to, durationMs);
            await playPath(path, motionEvents, shell);
        },
        gesture: (path: TimedPoint[]) => playPath(path, motionEvents, shell),
        type: async (text) => { await shell('input', 'text', escapeForInputText(text)); },
        pressKey: async (key) => { await shell('input', 'keyevent', String(ANDROID_KEYCODES[key])); },
        screenshot: () => screenshotViaScreencap(serial, run),
        uiTree: () => uiTreeViaUiautomator(shell),
        screen: async () => { cachedScreen ??= await screenViaWm(shell); return cachedScreen; },
        pushMedia: (file) => pushMediaViaAdb(file, mediaDirectory, push, shell),
        pause,
    };
}

/**
 * `adb shell a b c` concatenates the arguments and hands the string to the *device's* shell, so
 * every argument has to survive a second round of word splitting, globbing and expansion. One
 * pair of single quotes does that for anything except a single quote, which is spliced in.
 */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `input text` can only send ASCII: the KeyCharacterMap lookup silently drops anything outside
 * it, so an emoji or accented caption would post as gibberish. Fail loudly instead, and name the
 * way out — the a11y-bridge driver types UTF-8 through the on-device keyboard route.
 */
export function assertAdbTypeable(text: string): void {
    const offending = [...text].find((character) => {
        const code = character.codePointAt(0)!;
        return code < 0x20 || code > 0x7e;
    });
    if (offending === undefined) return;
    const shown = offending === '\n' ? '\\n' : offending === '\t' ? '\\t' : offending;
    throw new DriverError(
        `adb "input text" cannot type ${JSON.stringify(shown)} (only printable ASCII works). `
        + 'Use the a11y-bridge driver for this device, or remove the non-ASCII characters.',
    );
}

/** Rejects what `input text` cannot type, then quotes the rest for the device shell. */
export function escapeForInputText(text: string): string {
    assertAdbTypeable(text);
    return shellQuote(text);
}

async function screenshotViaScreencap(serial: string, run: CommandRunner): Promise<Buffer> {
    // exec-out keeps the PNG bytes clean: plain `adb shell` would translate 0x0a into 0x0d0a.
    const result = await run('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
        encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeoutMs: 30_000,
    });
    const stdout = result.stdout;
    if (!Buffer.isBuffer(stdout) || stdout.length === 0) throw new DriverError('screencap returned no data');
    if (!stdout.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
        throw new DriverError(`screencap returned ${stdout.length} bytes that are not a PNG: ${stdout.subarray(0, 40).toString('utf8')}`);
    }
    return stdout;
}

type Shell = (...args: string[]) => ReturnType<CommandRunner>;

/**
 * Dump to a file, then read it back. Dumping to `/dev/tty` only works when adb allocated a pty,
 * which it does not for a one-shot command, and several OEM builds print a "UI hierchary dumped
 * to" banner either side of the XML. Both cases are handled: use stdout when it happens to carry
 * the XML, otherwise `cat` the file.
 */
async function uiTreeViaUiautomator(shell: Shell): Promise<UiNode> {
    const { stdout } = await shell('uiautomator', 'dump', DUMP_PATH);
    const banner = String(stdout);
    const inline = banner.indexOf('<?xml');
    if (inline >= 0) return parseUiautomatorXml(banner.slice(inline));
    const dumped = String((await shell('cat', DUMP_PATH)).stdout);
    const start = dumped.indexOf('<?xml');
    if (start < 0) {
        throw new DriverError(
            `uiautomator dump returned no XML (dump said "${banner.trim().slice(0, 120)}", `
            + `${DUMP_PATH} said "${dumped.trim().slice(0, 120)}")`,
        );
    }
    return parseUiautomatorXml(dumped.slice(start));
}

/**
 * `wm size` prints the panel size and, when one is set, an override on a second line. The
 * override is what `input` coordinates and screenshots are in, so it has to win.
 */
export function parseWmSize(stdout: string): ScreenGeometry {
    const sizes = new Map<string, ScreenGeometry>();
    for (const match of stdout.matchAll(/(Override|Physical) size:\s*(\d+)x(\d+)/g)) {
        sizes.set(match[1]!, { width: Number(match[2]), height: Number(match[3]), scale: 1 });
    }
    const geometry = sizes.get('Override') ?? sizes.get('Physical');
    if (!geometry) throw new DriverError(`Could not read screen size from: ${stdout.trim()}`);
    return geometry;
}

async function screenViaWm(shell: Shell): Promise<ScreenGeometry> {
    const { stdout } = await shell('wm', 'size');
    return parseWmSize(String(stdout));
}

/** True when monkey actually injected the launch intent rather than printing an error. */
export function monkeyLaunched(output: string): boolean {
    if (/No activities found|Error|Exception|aborted/i.test(output)) return false;
    return /Events injected:\s*[1-9]/.test(output);
}

/**
 * monkey is the one-liner everyone reaches for, but it reports success on stdout rather than
 * through the exit code and gives up on packages whose launcher activity is behind a
 * disabled-until-used stub. Resolve the launcher component and `am start` it when that happens.
 */
async function launchViaAdb(packageName: string, shell: Shell): Promise<void> {
    const { stdout } = await shell('monkey', '-p', shellQuote(packageName), '-c', 'android.intent.category.LAUNCHER', '1');
    if (monkeyLaunched(String(stdout))) return;
    const component = await launcherComponent(packageName, shell);
    await shell('am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-n', shellQuote(component));
}

/** `cmd package resolve-activity --brief <pkg>` ends with `<pkg>/<activity>`. */
export function parseResolvedActivity(stdout: string, packageName: string): string | undefined {
    return stdout.split(/\r?\n/).map((line) => line.trim()).reverse()
        .find((line) => line.startsWith(`${packageName}/`));
}

async function launcherComponent(packageName: string, shell: Shell): Promise<string> {
    const { stdout } = await shell('cmd', 'package', 'resolve-activity', '--brief', shellQuote(packageName));
    const component = parseResolvedActivity(String(stdout), packageName);
    if (!component) throw new DriverError(`Could not resolve a launcher activity for ${packageName}: ${String(stdout).trim().slice(0, 200)}`);
    return component;
}

type Push = (localPath: string, remotePath: string) => ReturnType<CommandRunner>;

async function pushMediaViaAdb(file: MediaFile, mediaDirectory: string, push: Push, shell: Shell): Promise<void> {
    const fileName = file.fileName ?? path.basename(file.localPath);
    const remotePath = `${mediaDirectory}/${fileName}`;
    // `adb push` takes its arguments as argv, so spaces in either path need no quoting here.
    await push(file.localPath, remotePath);
    await scanMedia(remotePath, shell);
}

/**
 * Without a scan the file exists but the gallery (and TikTok's picker) does not list it.
 * Android 10 removed the MEDIA_SCANNER_SCAN_FILE receiver and rejects `file://` URIs, so the
 * broadcast returns success there while doing nothing; MediaStore's `scan_file` provider method
 * is the supported route. Try it first and keep the broadcast for pre-10 phones.
 */
async function scanMedia(remotePath: string, shell: Shell): Promise<void> {
    try {
        await shell('content', 'call', '--uri', 'content://media/external/file', '--method', 'scan_file', '--arg', shellQuote(remotePath));
        return;
    } catch {
        // No scan_file method on this build; fall through to the legacy broadcast.
    }
    await shell('am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', shellQuote(`file://${remotePath}`));
}

export interface AdbListedDevice {
    serial: string;
    /** `device`, `unauthorized`, `offline`, `recovery`, ... — whatever adb printed. */
    state: string;
    model?: string;
}

/**
 * `adb devices -l`, minus the header and the `* daemon not running; starting now ... *` banner
 * the server prints on its first invocation. Wi-Fi serials (`192.168.1.40:5555`) parse like any
 * other because only whitespace separates the columns.
 */
export function parseAdbDevices(stdout: string): AdbListedDevice[] {
    const lines = stdout.split(/\r?\n/).map((line) => line.trim());
    const header = lines.findIndex((line) => line.startsWith('List of devices attached'));
    return lines.slice(header + 1)
        .filter((line) => line && !line.startsWith('*'))
        .map((line) => line.split(/\s+/))
        .flatMap((parts) => {
            const [serial, state] = parts;
            if (!serial || !state) return [];
            const model = parts.find((part) => part.startsWith('model:'))?.slice('model:'.length);
            return [{ serial, state, ...(model ? { model } : {}) }];
        });
}

/** `adb devices -l` → serials in the `device` state, with model when reported. */
export async function discoverAdbDevices(run: CommandRunner = runCommand): Promise<Array<{ serial: string; model?: string }>> {
    const { stdout } = await run('adb', ['devices', '-l']);
    return parseAdbDevices(String(stdout))
        .filter(({ state }) => state === 'device')
        .map(({ serial, model }) => ({ serial, ...(model ? { model } : {}) }));
}

/**
 * `input motionevent` (Android 8+) is the only way through adb to put more than two points into a
 * gesture: DOWN, then one MOVE per sample, then UP. They go out as one `adb shell` invocation
 * because the expensive part is the round trip, not the event.
 */
export const MOTION_EVENT_DOWN = 'DOWN';

/**
 * What one `input motionevent` costs on the phone before anything is measured: an `app_process`
 * start plus the injection. Real devices come in between about 25 ms and 60 ms; the budget
 * replaces this with what it actually observes after the first gesture.
 */
export const DEFAULT_MOTION_EVENT_COST_MS = 40;

/** Below this, a `sleep` between two events costs more than the wait it inserts. */
const MIN_SLEEP_MS = 15;

/** A gesture is a shape, not a flip-book: three points is the floor, two dozen the ceiling. */
const POINT_LIMITS = { min: 3, max: 24 } as const;

export interface MotionEventBudget {
    /** How many of a path's points fit inside `durationMs` at the cost measured so far. */
    points(durationMs: number): number;
    /** Feed back what a dispatch of `count` events actually took. */
    record(count: number, elapsedMs: number): void;
    /** False once this device turned out not to have `input motionevent`. */
    supported(): boolean;
    disable(): void;
    costMs(): number;
}

/**
 * Shell latency is the whole problem with playing a path over adb: ask for twenty points on a
 * 300 ms swipe and the phone spends a second and a half delivering them, which is a drag rather
 * than a flick. So measure what an event costs on this device and spend the gesture's duration
 * accordingly — fewer points on a slow phone, the full sample count on a fast one.
 */
export function createMotionEventBudget(initialCostMs = DEFAULT_MOTION_EVENT_COST_MS): MotionEventBudget {
    let cost = initialCostMs;
    let available = true;
    return {
        points: (durationMs) => Math.max(
            POINT_LIMITS.min,
            Math.min(POINT_LIMITS.max, Math.floor(Math.max(0, durationMs) / Math.max(1, cost)) + 1),
        ),
        // An exponential moving average: one slow gesture (a screenshot landing mid-swipe) should
        // nudge the estimate, not redefine it.
        record: (count, elapsedMs) => {
            if (count < 2 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
            cost = cost * 0.7 + (elapsedMs / count) * 0.3;
        },
        supported: () => available,
        disable: () => { available = false; },
        costMs: () => cost,
    };
}

/** Keeps the first and last point and spreads the rest evenly; a path never gets *more* points. */
export function samplePath(path: readonly TimedPoint[], count: number): TimedPoint[] {
    if (path.length <= count || count < 2) return [...path];
    const step = (path.length - 1) / (count - 1);
    return Array.from({ length: count }, (_, index) => path[Math.round(index * step)]!);
}

/**
 * The chained shell command for one path. `sleep` only appears where the gap between two samples
 * is wider than the event itself costs — otherwise the phone is already slower than the human.
 */
export function motionEventCommand(path: readonly TimedPoint[], costMs = DEFAULT_MOTION_EVENT_COST_MS): string {
    if (path.length < 2) throw new DriverError('A gesture needs at least two points');
    const at = (point: TimedPoint) => `${Math.round(point.x)} ${Math.round(point.y)}`;
    const parts: string[] = [`input motionevent ${MOTION_EVENT_DOWN} ${at(path[0]!)}`];
    for (let index = 1; index < path.length; index += 1) {
        const previous = path[index - 1]!;
        const point = path[index]!;
        const slack = point.t - previous.t - costMs;
        if (slack >= MIN_SLEEP_MS) parts.push(`sleep ${(slack / 1000).toFixed(3)}`);
        const last = index === path.length - 1;
        parts.push(`input motionevent ${last ? 'UP' : 'MOVE'} ${at(point)}`);
    }
    return parts.join('; ');
}

/** `input` prints its usage rather than failing cleanly on a build without `motionevent`. */
export function motionEventUnsupported(text: string): boolean {
    return /Unknown command|unknown command|Error: Unknown|Usage: input/.test(text);
}

async function playPath(path: readonly TimedPoint[], budget: MotionEventBudget, shell: Shell): Promise<void> {
    if (path.length < 2) throw new DriverError('A gesture needs at least two points');
    const first = path[0]!;
    const last = path[path.length - 1]!;
    const fallback = async () => {
        await shell('input', 'swipe', ...[first.x, first.y, last.x, last.y, last.t - first.t]
            .map((value) => String(Math.round(value))));
    };
    if (!budget.supported()) return fallback();
    const limited = samplePath(path, budget.points(last.t - first.t));
    const startedAt = Date.now();
    let stdout: string;
    try {
        stdout = String((await shell(motionEventCommand(limited, budget.costMs()))).stdout);
    } catch (error) {
        if (!motionEventUnsupported(errorMessage(error))) throw error;
        budget.disable();
        return fallback();
    }
    if (motionEventUnsupported(stdout)) {
        // Nothing was injected; the swipe still has to happen.
        budget.disable();
        return fallback();
    }
    budget.record(limited.length, Date.now() - startedAt);
}
