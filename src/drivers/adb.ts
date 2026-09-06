import path from 'node:path';

import { pause, runCommand, type CommandRunner } from './common.js';
import { parseUiautomatorXml } from './uiautomator-xml.js';
import {
    DriverError,
    type DeviceDriver, type Key, type MediaFile, type Point, type ScreenGeometry, type Swipe, type UiNode,
} from './types.js';

export interface AdbDriverOptions {
    /** adb serial; doubles as the farm UDID for Android devices. */
    serial: string;
    run?: CommandRunner;
    /** Where pushed media lands. TikTok's picker reads the standard camera folder. */
    mediaDirectory?: string;
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

    return {
        kind: 'adb',
        platform: 'android',
        udid: serial,
        launchApp: (packageName) => launchViaAdb(packageName, shell),
        terminateApp: async (packageName) => { await shell('am', 'force-stop', shellQuote(packageName)); },
        tap: async ({ x, y }: Point) => { await shell('input', 'tap', String(Math.round(x)), String(Math.round(y))); },
        swipe: async ({ from, to, durationMs }: Swipe) => {
            await shell('input', 'swipe', ...[from.x, from.y, to.x, to.y, durationMs].map((v) => String(Math.round(v))));
        },
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
