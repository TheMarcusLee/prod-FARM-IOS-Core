import type { DeviceConnectionStatus } from '../devices/connection-manager.js';
import type { EventInput } from './events.js';

export function isDeviceReady(status: DeviceConnectionStatus): boolean {
    return status.physical === 'connected' && status.wda === 'ready';
}

export interface DeviceMonitorState {
    /** Last status seen per device — the baseline the next poll is compared against. */
    previous: Map<string, DeviceConnectionStatus>;
    /** When each currently-offline device went offline; feeds the daily digest. */
    offlineSince: Map<string, Date>;
}

export function createDeviceMonitorState(): DeviceMonitorState {
    return { previous: new Map(), offlineSince: new Map() };
}

/**
 * Compares a fresh poll of wda-service statuses against the previous one and
 * returns the events worth recording. The first sighting of a device only
 * establishes the baseline, so a restart does not replay the whole fleet.
 */
export function diffDeviceStatuses(
    state: DeviceMonitorState, statuses: readonly DeviceConnectionStatus[], now = new Date(),
): EventInput[] {
    const produced: EventInput[] = [];
    for (const status of statuses) {
        const previous = state.previous.get(status.udid);
        state.previous.set(status.udid, status);
        const ready = isDeviceReady(status);
        if (!ready && !state.offlineSince.has(status.udid)) state.offlineSince.set(status.udid, now);
        if (ready) state.offlineSince.delete(status.udid);
        if (!previous) continue;
        const detail = { physical: status.physical, wda: status.wda, appium: status.appium, message: status.message };
        if (status.wda === 'error' && previous.wda !== 'error') {
            produced.push({
                kind: 'device.error', severity: 'error', deviceUdid: status.udid,
                title: `Device ${status.udid} reported an error`, detail: { ...detail, error: status.message },
            });
            continue;
        }
        const wasReady = isDeviceReady(previous);
        if (wasReady === ready) continue;
        produced.push(ready
            ? { kind: 'device.connected', severity: 'info', deviceUdid: status.udid, title: `Device ${status.udid} is online`, detail }
            : { kind: 'device.disconnected', severity: 'warning', deviceUdid: status.udid, title: `Device ${status.udid} went offline`, detail });
    }
    return produced;
}

/** Devices that have been offline for longer than `minimumMs` (an hour, for the digest). */
export function longOfflineDevices(
    state: DeviceMonitorState, now = new Date(), minimumMs = 3_600_000,
): Array<{ deviceUdid: string; since: string; minutes: number }> {
    return [...state.offlineSince.entries()]
        .filter(([, since]) => now.getTime() - since.getTime() >= minimumMs)
        .map(([deviceUdid, since]) => ({
            deviceUdid, since: since.toISOString(),
            minutes: Math.floor((now.getTime() - since.getTime()) / 60_000),
        }));
}
