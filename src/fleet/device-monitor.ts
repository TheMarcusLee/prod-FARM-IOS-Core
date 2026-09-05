import type { DeviceConnectionStatus } from '../devices/connection-manager.js';
import type { EventInput } from './events.js';

export function isDeviceReady(status: DeviceConnectionStatus): boolean {
    return status.physical === 'connected' && status.wda === 'ready';
}

/**
 * The three states worth an event. Everything else a wda-service status carries
 * (the `appium` field, the human message) is detail, not a transition.
 */
export type DeviceSignal = 'ready' | 'down' | 'error';

export function deviceSignal(status: DeviceConnectionStatus): DeviceSignal {
    if (status.wda === 'error') return 'error';
    return isDeviceReady(status) ? 'ready' : 'down';
}

/**
 * How long a new signal has to hold before it becomes an event. A USB cable with
 * a bad contact flaps between `connected` and `disconnected` several times a
 * minute; without this every bounce would be a row in the timeline and a push
 * notification on somebody's phone. Chosen to span two 30 s monitor polls.
 */
export const DEVICE_DEBOUNCE_MS = 45_000;

interface PendingSignal {
    signal: DeviceSignal;
    since: Date;
}

export interface DeviceMonitorState {
    /** Last *confirmed* status per device — the baseline the next poll is compared against. */
    previous: Map<string, DeviceConnectionStatus>;
    /** A signal seen but not yet held long enough to be believed. */
    pending: Map<string, PendingSignal>;
    /** When each currently-offline device went offline; feeds the daily digest. */
    offlineSince: Map<string, Date>;
}

export function createDeviceMonitorState(): DeviceMonitorState {
    return { previous: new Map(), pending: new Map(), offlineSince: new Map() };
}

function eventFor(status: DeviceConnectionStatus, signal: DeviceSignal): EventInput {
    const detail = { physical: status.physical, wda: status.wda, appium: status.appium, message: status.message };
    if (signal === 'error') {
        return {
            kind: 'device.error', severity: 'error', deviceUdid: status.udid,
            title: `Device ${status.udid} reported an error`, detail: { ...detail, error: status.message },
        };
    }
    return signal === 'ready'
        ? { kind: 'device.connected', severity: 'info', deviceUdid: status.udid, title: `Device ${status.udid} is online`, detail }
        : { kind: 'device.disconnected', severity: 'warning', deviceUdid: status.udid, title: `Device ${status.udid} went offline`, detail };
}

/**
 * Compares a fresh poll of wda-service statuses against the last confirmed one
 * and returns the events worth recording. The first sighting of a device only
 * establishes the baseline, so a restart does not replay the whole fleet, and a
 * change is only believed once it has held for `debounceMs` — a flapping cable
 * that settles back where it started produces no event at all.
 */
export function diffDeviceStatuses(
    state: DeviceMonitorState, statuses: readonly DeviceConnectionStatus[], now = new Date(),
    debounceMs = DEVICE_DEBOUNCE_MS,
): EventInput[] {
    const produced: EventInput[] = [];
    for (const status of statuses) {
        // Offline bookkeeping tracks the raw signal: the digest reports devices
        // that have been down for an hour, where a 45 s debounce is noise.
        const ready = isDeviceReady(status);
        if (!ready && !state.offlineSince.has(status.udid)) state.offlineSince.set(status.udid, now);
        if (ready) state.offlineSince.delete(status.udid);

        const signal = deviceSignal(status);
        const previous = state.previous.get(status.udid);
        if (!previous) {
            state.previous.set(status.udid, status);
            continue;
        }
        if (signal === deviceSignal(previous)) {
            // Back where it started: whatever was pending never happened.
            state.pending.delete(status.udid);
            state.previous.set(status.udid, status);
            continue;
        }
        const pending = state.pending.get(status.udid);
        if (!pending || pending.signal !== signal) {
            state.pending.set(status.udid, { signal, since: now });
            continue;
        }
        if (now.getTime() - pending.since.getTime() < debounceMs) continue;
        state.pending.delete(status.udid);
        state.previous.set(status.udid, status);
        produced.push(eventFor(status, signal));
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
