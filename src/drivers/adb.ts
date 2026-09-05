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

const ANDROID_KEYCODES: Record<Key, number> = { home: 3, back: 4, enter: 66, delete: 67 };

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
    let cachedScreen: ScreenGeometry | undefined;

    return {
        kind: 'adb',
        platform: 'android',
        udid: serial,
        launchApp: async (packageName) => { await shell('monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'); },
        terminateApp: async (packageName) => { await shell('am', 'force-stop', packageName); },
        tap: async ({ x, y }: Point) => { await shell('input', 'tap', String(Math.round(x)), String(Math.round(y))); },
        swipe: async ({ from, to, durationMs }: Swipe) => {
            await shell('input', 'swipe', ...[from.x, from.y, to.x, to.y, durationMs].map((v) => String(Math.round(v))));
        },
        type: async (text) => { await shell('input', 'text', escapeForInputText(text)); },
        pressKey: async (key) => { await shell('input', 'keyevent', String(ANDROID_KEYCODES[key])); },
        screenshot: () => screenshotViaScreencap(serial, run),
        uiTree: () => uiTreeViaUiautomator(shell),
        screen: async () => { cachedScreen ??= await screenViaWm(shell); return cachedScreen; },
        pushMedia: (file) => pushMediaViaAdb(file, mediaDirectory, adb, shell),
        pause,
    };
}

/** `input text` treats space and shell metacharacters specially; %s is its space escape. */
export function escapeForInputText(text: string): string {
    return text.replace(/[\\'"`$&|;<>()]/g, (char) => `\\${char}`).replace(/ /g, '%s');
}

async function screenshotViaScreencap(serial: string, run: CommandRunner): Promise<Buffer> {
    const result = await run('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' });
    const stdout = result.stdout;
    if (!Buffer.isBuffer(stdout) || stdout.length === 0) throw new DriverError('screencap returned no data');
    return stdout;
}

type Shell = (...args: string[]) => ReturnType<CommandRunner>;

async function uiTreeViaUiautomator(shell: Shell): Promise<UiNode> {
    // Dumping to stdout avoids a second round trip to `cat` the file. Some OEM builds print a
    // "UI hierchary dumped to" banner before the XML, so slice from the first tag.
    const { stdout } = await shell('uiautomator', 'dump', '/dev/tty');
    const xml = String(stdout);
    const start = xml.indexOf('<?xml');
    if (start < 0) throw new DriverError(`uiautomator dump returned no XML: ${xml.slice(0, 120)}`);
    return parseUiautomatorXml(xml.slice(start));
}

async function screenViaWm(shell: Shell): Promise<ScreenGeometry> {
    const { stdout } = await shell('wm', 'size');
    const match = String(stdout).match(/(?:Override|Physical) size:\s*(\d+)x(\d+)/);
    if (!match) throw new DriverError(`Could not read screen size from: ${String(stdout).trim()}`);
    return { width: Number(match[1]), height: Number(match[2]), scale: 1 };
}

async function pushMediaViaAdb(file: MediaFile, mediaDirectory: string, adb: Shell, shell: Shell): Promise<void> {
    const fileName = file.fileName ?? path.basename(file.localPath);
    const remotePath = `${mediaDirectory}/${fileName}`;
    await adb('push', file.localPath, remotePath);
    // Without a scan the file exists but the gallery (and TikTok's picker) does not list it.
    await shell('am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${remotePath}`);
}

/** `adb devices -l` → serials in the `device` state, with model when reported. */
export async function discoverAdbDevices(run: CommandRunner = runCommand): Promise<Array<{ serial: string; model?: string }>> {
    const { stdout } = await run('adb', ['devices', '-l']);
    return String(stdout).split(/\r?\n/).slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2 && parts[1] === 'device')
        .map((parts) => {
            const model = parts.find((part) => part.startsWith('model:'))?.slice('model:'.length);
            return { serial: parts[0]!, ...(model ? { model } : {}) };
        });
}
