import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { coordinatesForProfile, validateCoordinateOverrides, type DeviceCoordinateOverrides, type DeviceProfileName } from './coordinates.js';
import { DEVICE_ID_MESSAGE, validDeviceId } from './identifiers.js';
import type { JsonObject } from '../types.js';
import type { AndroidDeviceConfig, DriverKind, Platform } from '../drivers/types.js';
import { validateMotionSettings, type MotionSettings } from '../motion/profile.js';

export interface RegisteredDevice {
    name: string;
    /** iOS UDID or Android adb serial. */
    udid: string;
    /** Defaults to 'ios' so existing devices.json files keep loading. */
    platform?: Platform;
    /** Defaults to 'wda' on iOS and 'adb' on Android. See docs/adr/0001. */
    driver?: DriverKind;
    android?: AndroidDeviceConfig;
    coordinateProfile?: DeviceProfileName;
    wdaLocalPort?: number;
    mjpegLocalPort?: number;
    /** Device unlock passcode. Lives here (devices.json is 0600 and git-ignored), never in an API response. */
    passcode?: string;
    /** Per-device single-tap coordinate overrides (dashboard calibration). */
    coordinates?: DeviceCoordinateOverrides;
    /**
     * How this phone's "person" moves. Optional: with nothing set, handedness and pace come from
     * a stable hash of the udid, so every device is consistent without being configured.
     */
    motion?: MotionSettings;
    /** When true the farm keeps the entry but stops supervising it — no WDA, no worker, no discovery polling. */
    disabled?: boolean;
    /** Free-form fleet labels used to filter and bulk-select devices on /fleet. */
    tags?: string[];
    pluginData: Record<string, JsonObject>;
}

/** Devices the farm should actively supervise (everything except the disabled ones). */
export function activeDevices(devices: readonly RegisteredDevice[]): RegisteredDevice[] {
    return devices.filter((device) => !device.disabled);
}

export const PASSCODE_PATTERN = /^\d{4,}$/;

/** What is left of an Android config once the bearer token is gone. */
export type RedactedAndroidConfig = Omit<AndroidDeviceConfig, 'bridgeToken'> & { hasBridgeToken: boolean };

export type RedactedDevice<T extends RedactableDevice> =
    Omit<T, 'passcode' | 'android'> & { hasPasscode: boolean; android?: RedactedAndroidConfig };

interface RedactableDevice {
    passcode?: string;
    android?: AndroidDeviceConfig;
}

/**
 * A device with every credential removed and a boolean marker in its place — safe to serialize.
 * Both the unlock passcode and `android.bridgeToken` are credentials: the token is what
 * authenticates control of the accessibility bridge on that phone. Redacting here rather than at
 * an API boundary is deliberate — a route added later that returns a device record cannot leak
 * one by forgetting to call a second helper.
 */
export function redactDevice<T extends RedactableDevice>(device: T): RedactedDevice<T> {
    const { passcode, android, ...rest } = device;
    const redacted = { ...rest, hasPasscode: Boolean(passcode) } as RedactedDevice<T>;
    if (!android) return redacted;
    const { bridgeToken, ...withoutToken } = android;
    return { ...redacted, android: { ...withoutToken, hasBridgeToken: Boolean(bridgeToken) } };
}

const defaultRegistryPath = path.resolve(process.env.DEVICES_CONFIG_PATH ?? 'devices.json');

export async function loadRegisteredDevices(registryPath = defaultRegistryPath): Promise<RegisteredDevice[]> {
    let raw: string;
    try {
        raw = await readFile(registryPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    let devices: RegisteredDevice[];
    try {
        devices = JSON.parse(raw) as RegisteredDevice[];
    } catch (error) {
        throw new Error(`${registryPath} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const device of devices) {
        coordinatesForProfile(device.coordinateProfile);
        device.pluginData ??= {};
    }
    return devices;
}

export async function saveRegisteredDevices(devices: RegisteredDevice[], registryPath = defaultRegistryPath): Promise<void> {
    const unique = new Set<string>();
    for (const device of devices) {
        // The same gate the API applies, because devices.json is also edited by hand and by
        // scripts: `udid` and `android.serial` both reach `adb -s <value>`, where a leading dash
        // is a flag rather than a device.
        if (!validDeviceId(device.udid)) throw new Error(`Device udid ${JSON.stringify(device.udid)} ${DEVICE_ID_MESSAGE}`);
        if (device.android !== undefined && !validDeviceId(device.android.serial)) {
            throw new Error(`Device ${device.udid} android.serial ${JSON.stringify(device.android.serial)} ${DEVICE_ID_MESSAGE}`);
        }
        coordinatesForProfile(device.coordinateProfile);
        if (device.passcode !== undefined && !PASSCODE_PATTERN.test(device.passcode)) {
            throw new Error(`Device ${device.udid} passcode must contain at least four digits`);
        }
        if (device.coordinates !== undefined) {
            device.coordinates = validateCoordinateOverrides(device.coordinates, device.coordinateProfile);
            if (Object.keys(device.coordinates).length === 0) delete device.coordinates;
        }
        if (device.motion !== undefined) {
            try {
                device.motion = validateMotionSettings(device.motion);
            } catch (error) {
                throw new Error(`Device ${device.udid} ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!device.motion) delete device.motion;
        }
        if (device.disabled !== true) delete device.disabled;
        if (unique.has(device.udid)) throw new Error(`Device ${device.udid} is already registered`);
        unique.add(device.udid);
    }
    await mkdir(path.dirname(registryPath), { recursive: true });
    const temporaryPath = `${registryPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(devices, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, registryPath);
}

// Every load-modify-save of devices.json in one process must go through here,
// or two overlapping mutations (a passcode save racing a disable toggle) each
// read the same file and the second write clobbers the first.
let registryMutation: Promise<unknown> = Promise.resolve();

export function mutateRegisteredDevices<T>(
    mutate: (devices: RegisteredDevice[]) => T | Promise<T>,
    registryPath = defaultRegistryPath,
): Promise<T> {
    const run = registryMutation.then(async () => {
        const devices = await loadRegisteredDevices(registryPath);
        const result = await mutate(devices);
        await saveRegisteredDevices(devices, registryPath);
        return result;
    });
    registryMutation = run.catch(() => undefined);
    return run;
}
