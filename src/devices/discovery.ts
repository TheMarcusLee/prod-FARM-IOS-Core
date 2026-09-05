import { createRequire } from 'node:module';

import { discoverAdbDevices } from '../drivers/adb.js';
import { errorMessage, runCommand, type CommandRunner } from '../drivers/common.js';
import type { Platform } from '../drivers/types.js';
import { modelNameForProductType } from './coordinates.js';

const require = createRequire(import.meta.url);
interface IosUtilities {
    getConnectedDevices(): Promise<string[]>;
    getDeviceName(udid: string): Promise<string>;
    getOSVersion(udid: string): Promise<string>;
    getDeviceInfo(udid: string): Promise<{ ProductType?: string; HardwareModel?: string }>;
}
const { utilities } = require('appium-ios-device') as { utilities: IosUtilities };

export interface Device {
    name: string;
    osVersion: string;
    /** iOS UDID or Android adb serial. */
    udid: string;
    /** Absent means iOS; records built before Android discovery existed never set it. */
    platform?: Platform;
    productType?: string;
    hardwareModel?: string;
    modelName?: string;
}

export function devicePlatform(device: Pick<Device, 'platform'>): Platform {
    return device.platform ?? 'ios';
}

/** Every phone the Mac can currently see: iPhones over usbmuxd, Android over adb. */
export async function discoverConnectedDevices(): Promise<Device[]> {
    const [ios, android] = await Promise.all([discoverConnectedIosDevices(), discoverConnectedAndroidDevices()]);
    return [...ios, ...android];
}

export async function discoverConnectedIosDevices(): Promise<Device[]> {
    const udids = await utilities.getConnectedDevices();
    return Promise.all(udids.map(async (udid) => {
        const [name, osVersion, info] = await Promise.all([
            utilities.getDeviceName(udid), utilities.getOSVersion(udid), utilities.getDeviceInfo(udid),
        ]);
        const modelName = modelNameForProductType(info.ProductType);
        return {
            name, osVersion, udid, platform: 'ios' as const,
            ...(info.ProductType ? { productType: info.ProductType } : {}),
            ...(info.HardwareModel ? { hardwareModel: info.HardwareModel } : {}),
            ...(modelName ? { modelName } : {}),
        };
    }));
}

/** UDIDs only, optionally for one platform. WDA tooling passes 'ios' so an Android serial never becomes a build target. */
export async function discoverConnectedDeviceUdids(platform?: Platform): Promise<string[]> {
    if (platform === 'ios') return utilities.getConnectedDevices();
    if (platform === 'android') return (await discoverConnectedAndroidDevices()).map(({ udid }) => udid);
    const [ios, android] = await Promise.all([utilities.getConnectedDevices(), discoverConnectedAndroidDevices()]);
    return [...ios, ...android.map(({ udid }) => udid)];
}

interface AndroidProperties {
    name: string;
    osVersion: string;
    modelName?: string;
}

// Model and OS version do not change while a phone stays plugged in, and discovery is polled
// every couple of seconds by the dashboard and the connection manager, so each phone is asked
// once. The entry still expires: a phone that takes an OS update keeps its serial, and a stale
// "Android 13" would then follow it around the dashboard until the farm restarts.
export const ANDROID_PROPERTY_TTL_MS = 15 * 60_000;

interface CachedProperties {
    properties: AndroidProperties;
    expiresAt: number;
}

const androidPropertyCache = new Map<string, CachedProperties>();
let adbProblemReported: string | undefined;

/** `adb devices -l` plus one `getprop` per new serial. Missing adb is reported once, then silent. */
export async function discoverConnectedAndroidDevices(run: CommandRunner = runCommand, now: () => number = Date.now): Promise<Device[]> {
    if ((process.env.ANDROID_DISCOVERY ?? '').toLowerCase() === 'off') return [];
    let listed: Array<{ serial: string; model?: string }>;
    try {
        listed = await discoverAdbDevices(run);
    } catch (error) {
        const message = errorMessage(error);
        if (adbProblemReported !== message) {
            adbProblemReported = message;
            console.warn(`[discovery] Android discovery is unavailable (set ANDROID_DISCOVERY=off to silence): ${message}`);
        }
        return [];
    }
    adbProblemReported = undefined;
    return Promise.all(listed.map(async ({ serial, model }) => ({
        udid: serial,
        platform: 'android' as const,
        ...(await androidProperties(serial, model, run, now)),
    })));
}

async function androidProperties(
    serial: string, listedModel: string | undefined, run: CommandRunner, now: () => number,
): Promise<AndroidProperties> {
    const cached = androidPropertyCache.get(serial);
    if (cached && cached.expiresAt > now()) return cached.properties;
    const fallback: AndroidProperties = { name: listedModel ?? serial, osVersion: 'unknown' };
    let stdout: string;
    try {
        ({ stdout } = await run('adb', ['-s', serial, 'shell', 'getprop ro.build.version.release; getprop ro.product.model'], { timeoutMs: 10_000 }) as { stdout: string });
    } catch {
        // Mid-boot or just authorised; the next poll asks again.
        return fallback;
    }
    const properties = parseAndroidProperties(String(stdout), fallback);
    androidPropertyCache.set(serial, { properties, expiresAt: now() + ANDROID_PROPERTY_TTL_MS });
    return properties;
}

export function parseAndroidProperties(stdout: string, fallback: AndroidProperties): AndroidProperties {
    // `* daemon not running; starting now ... *` lands on stdout ahead of the getprop output the
    // first time the adb server is started, and would otherwise be read as the OS version.
    const lines = stdout.split(/\r?\n/).map((line) => line.trim());
    while (lines[0]?.startsWith('*')) lines.shift();
    const [release = '', model = ''] = lines;
    return {
        name: model || fallback.name,
        osVersion: release || fallback.osVersion,
        ...(model ? { modelName: model } : {}),
    };
}

/** Test hook: forget cached Android properties. */
export function resetAndroidDiscoveryCache(): void {
    androidPropertyCache.clear();
    adbProblemReported = undefined;
}
