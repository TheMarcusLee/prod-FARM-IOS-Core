import type { RegisteredDevice } from '../devices/registry.js';
import type { Seed } from '../motion/rng.js';
import { createA11yBridgeDriver } from './a11y-bridge.js';
import { createAdbDriver } from './adb.js';
import { DriverError, type DeviceDriver, type DriverKind, type Platform } from './types.js';
import { createWdaDriver } from './wda.js';

export interface SelectOptions {
    /** Device unlock passcode (iOS), resolved by the caller from secrets. */
    passcode?: string;
    /** Falls back to WDA_LOCAL_PORT / 8100 like the executor does today. */
    defaultWdaPort?: number;
    fetchImpl?: typeof fetch;
    /** The run's motion seed, so every gesture in one execution comes from one reproducible stream. */
    motionSeed?: Seed;
}

export function platformOf(device: Pick<RegisteredDevice, 'platform' | 'android'>): Platform {
    return device.platform ?? (device.android ? 'android' : 'ios');
}

export function driverKindOf(device: Pick<RegisteredDevice, 'platform' | 'driver' | 'android'>): DriverKind {
    if (device.driver) return device.driver;
    return platformOf(device) === 'android' ? 'adb' : 'wda';
}

/** The one place that knows how a devices.json entry becomes a live driver. */
export function driverForDevice(device: RegisteredDevice, options: SelectOptions = {}): DeviceDriver {
    const kind = driverKindOf(device);
    const platform = platformOf(device);
    if (platform === 'ios' && kind !== 'wda') throw new DriverError(`Driver ${kind} is not valid for iOS device ${device.udid}`);
    if (platform === 'android' && kind === 'wda') throw new DriverError(`Driver wda is not valid for Android device ${device.udid}`);

    switch (kind) {
        case 'wda':
            return createWdaDriver({
                udid: device.udid,
                wdaUrl: `http://127.0.0.1:${device.wdaLocalPort ?? options.defaultWdaPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`,
                passcode: options.passcode,
                fetchImpl: options.fetchImpl,
                ...(device.motion ? { motion: device.motion } : {}),
                ...(options.motionSeed !== undefined ? { motionSeed: options.motionSeed } : {}),
            });
        case 'adb':
            return createAdbDriver({
                serial: androidConfig(device).serial,
                ...(device.motion ? { motion: device.motion } : {}),
                ...(options.motionSeed !== undefined ? { motionSeed: options.motionSeed } : {}),
            });
        case 'a11y-bridge': {
            const android = androidConfig(device);
            if (!android.bridgeUrl || !android.bridgeToken) {
                throw new DriverError(`Device ${device.udid} uses the a11y-bridge driver but has no android.bridgeUrl / android.bridgeToken`);
            }
            return createA11yBridgeDriver({
                serial: android.serial,
                baseUrl: android.bridgeUrl,
                token: android.bridgeToken,
                fetchImpl: options.fetchImpl,
                ...(device.motion ? { motion: device.motion } : {}),
                ...(options.motionSeed !== undefined ? { motionSeed: options.motionSeed } : {}),
                // Launch, terminate and media push still go over adb during the sync pass; the
                // posting routine itself only needs the bridge.
                fallback: createAdbDriver({ serial: android.serial }),
            });
        }
    }
}

function androidConfig(device: RegisteredDevice): NonNullable<RegisteredDevice['android']> {
    return device.android ?? { serial: device.udid };
}
