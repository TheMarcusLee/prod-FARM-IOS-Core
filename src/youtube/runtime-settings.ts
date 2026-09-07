import type { JsonObject, RegisteredDevice } from '@git-agni/backline';

export const YOUTUBE_PLUGIN_ID = 'com.backline.youtube';

function settings(device: RegisteredDevice | undefined): JsonObject {
    return device?.pluginData[YOUTUBE_PLUGIN_ID] ?? {};
}

/** The devices.json field is canonical; the pluginData copy mirrors the TikTok plugin's fallback. */
export function coordinateProfile(device: RegisteredDevice | undefined): string {
    if (typeof device?.coordinateProfile === 'string') return device.coordinateProfile;
    const legacy = settings(device).coordinateProfile;
    return typeof legacy === 'string' ? legacy : 'iphone8';
}

/** The YouTube channels this device is registered for, as `@handle` strings. */
export function registeredAccounts(device: RegisteredDevice | undefined): string[] {
    const value = settings(device).accounts;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
