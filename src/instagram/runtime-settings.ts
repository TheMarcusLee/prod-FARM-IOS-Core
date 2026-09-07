import type { JsonObject, RegisteredDevice } from '../types.js';

export const INSTAGRAM_PLUGIN_ID = 'com.backline.instagram';

function settings(device: RegisteredDevice | undefined): JsonObject {
    return device?.pluginData[INSTAGRAM_PLUGIN_ID] ?? {};
}

export function coordinateProfile(device: RegisteredDevice | undefined): string {
    // The top-level devices.json field is canonical (what the dashboard and
    // resolveDeviceCoordinates use); the pluginData copy is a per-plugin override.
    if (typeof device?.coordinateProfile === 'string') return device.coordinateProfile;
    const legacy = settings(device).coordinateProfile;
    return typeof legacy === 'string' ? legacy : 'iphone8';
}

/**
 * The Instagram handles signed in on this phone.
 *
 * A phone's Instagram accounts are not its TikTok accounts, so they are stored under this
 * plugin's own `pluginData` key. A device with none listed is not blocked from posting — the
 * routines simply do not switch account.
 */
export function registeredAccounts(device: RegisteredDevice | undefined): string[] {
    const value = settings(device).accounts;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
