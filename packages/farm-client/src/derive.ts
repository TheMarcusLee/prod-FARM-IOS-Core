/**
 * Derivations the app needs when the farm has not given them to it.
 *
 * `/api/fleet/summary` already returns a derived `state` (gap 11). This module
 * exists for the fallback path — an older farm without the fleet endpoint,
 * where the app has only `/api/devices` and per-device connection rows — and
 * for the coordinate mapping, which is client-side by definition.
 */

import type {
    DeviceConnectionStatus,
    DeviceState,
    FleetCounts,
    FleetDevice,
    Platform,
    RegisteredDevice,
    RemoteAction,
} from './models';

/**
 * `disabled` wins over everything: a disabled device also reports
 * `connected: null`, and rendering it as "unplugged" is a lie the operator will
 * chase with a cable.
 */
export function deriveDeviceState(
    device: Pick<RegisteredDevice, 'disabled' | 'connected'>,
    connection?: Pick<DeviceConnectionStatus, 'physical' | 'wda'> | null,
    hasActiveExecution = false,
): DeviceState {
    if (device.disabled) return 'disabled';
    if (connection?.wda === 'error') return 'error';
    if (connection ? connection.physical === 'disconnected' : device.connected === null) return 'offline';
    if (hasActiveExecution) return 'busy';
    return 'online';
}

export function countStates(devices: Pick<FleetDevice, 'state'>[]): FleetCounts {
    const counts: FleetCounts = { total: devices.length, online: 0, busy: 0, offline: 0, disabled: 0, error: 0 };
    for (const device of devices) counts[device.state] += 1;
    return counts;
}

export function platformOf(device: { platform?: Platform }): Platform {
    // Absent means iOS (`src/types.ts`).
    return device.platform ?? 'ios';
}

export function deviceTags(devices: { tags?: string[] }[]): string[] {
    const seen = new Set<string>();
    for (const device of devices) for (const tag of device.tags ?? []) seen.add(tag);
    return [...seen].sort((a, b) => a.localeCompare(b));
}

/* -------------------------------------------------- coordinate mapping */

export interface Rect {
    width: number;
    height: number;
}

/**
 * Map a touch inside an `resizeMode: 'contain'` image view back to device
 * coordinates. `screenSize` is points from `remote/info`, which is what
 * `/remote/action` expects — the `scale` factor is not applied.
 *
 * Returns `null` when the touch landed in the letterbox rather than on the
 * screen, so the caller can ignore it rather than tap the edge.
 */
export function mapTouchToDevice(
    touch: { x: number; y: number },
    view: Rect,
    screenSize: Rect,
): { x: number; y: number } | null {
    if (view.width <= 0 || view.height <= 0 || screenSize.width <= 0 || screenSize.height <= 0) return null;

    const scale = Math.min(view.width / screenSize.width, view.height / screenSize.height);
    const renderedWidth = screenSize.width * scale;
    const renderedHeight = screenSize.height * scale;
    const offsetX = (view.width - renderedWidth) / 2;
    const offsetY = (view.height - renderedHeight) / 2;

    const x = (touch.x - offsetX) / scale;
    const y = (touch.y - offsetY) / scale;
    if (x < 0 || y < 0 || x > screenSize.width || y > screenSize.height) return null;

    return { x: Math.round(x), y: Math.round(y) };
}

/** A drag becomes a swipe; below the threshold it is a tap the finger wobbled on. */
export function gestureToAction(
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
    tapThresholdPx = 12,
): RemoteAction {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance < tapThresholdPx) return { type: 'tap', x: from.x, y: from.y };
    return {
        type: 'swipe',
        startX: from.x,
        startY: from.y,
        endX: to.x,
        endY: to.y,
        // Clamp: a 4 ms swipe is a flick the driver cannot reproduce, and a
        // 10 s one holds the WDA session open for no reason.
        durationMs: Math.min(3_000, Math.max(50, Math.round(durationMs))),
    };
}

/** `back` and `text` are Android-only; the farm answers 400 otherwise. */
export function isActionSupported(action: RemoteAction['type'], platform: Platform): boolean {
    if (action === 'back' || action === 'text') return platform === 'android';
    return true;
}
