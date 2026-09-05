import { createA11yBridgeDriver } from '../../drivers/a11y-bridge.js';
import { createAdbDriver } from '../../drivers/adb.js';
import { DriverError, type DeviceDriver } from '../../drivers/types.js';

/**
 * Plugin routines run in a child process, so they cannot be handed `context.driver` directly.
 * The executor gives them the same device as environment variables instead
 * (see `pluginEnvironment` in src/scheduler/executor.ts); this rebuilds the driver from those.
 *
 * Nothing here logs A11Y_BRIDGE_TOKEN — the bridge token is a device credential and the run log
 * is stored and displayed.
 */

export type AndroidEnv = Partial<Record<
    'DEVICE_PLATFORM' | 'DEVICE_DRIVER' | 'DEVICE_UDID' | 'ANDROID_SERIAL' | 'A11Y_BRIDGE_URL' | 'A11Y_BRIDGE_TOKEN',
    string
>>;

export function androidSerialFromEnv(env: AndroidEnv): string {
    const serial = env.ANDROID_SERIAL?.trim() || env.DEVICE_UDID?.trim();
    if (!serial) throw new DriverError('ANDROID_SERIAL (or DEVICE_UDID) is required for an Android routine');
    return serial;
}

export function driverKindFromEnv(env: AndroidEnv): 'adb' | 'a11y-bridge' {
    const kind = env.DEVICE_DRIVER?.trim() || 'adb';
    if (kind !== 'adb' && kind !== 'a11y-bridge') throw new DriverError(`DEVICE_DRIVER must be adb or a11y-bridge on Android; received ${kind}`);
    return kind;
}

/** The adb driver, which is also the a11y-bridge driver's fallback for launch/terminate/pushMedia. */
export function adbDriverFromEnv(env: AndroidEnv = process.env): DeviceDriver {
    return createAdbDriver({ serial: androidSerialFromEnv(env) });
}

export function driverFromEnv(env: AndroidEnv = process.env): DeviceDriver {
    const serial = androidSerialFromEnv(env);
    if (driverKindFromEnv(env) === 'adb') return createAdbDriver({ serial });
    const baseUrl = env.A11Y_BRIDGE_URL?.trim();
    const token = env.A11Y_BRIDGE_TOKEN?.trim();
    if (!baseUrl || !token) {
        throw new DriverError(`Device ${serial} uses the a11y-bridge driver but A11Y_BRIDGE_URL / A11Y_BRIDGE_TOKEN are not set`);
    }
    return createA11yBridgeDriver({
        serial, baseUrl, token,
        // The bridge is an AccessibilityService: it cannot start apps or write to the gallery.
        fallback: createAdbDriver({ serial }),
    });
}
