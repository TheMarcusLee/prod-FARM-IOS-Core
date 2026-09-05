import type { ExecutionRow, ScheduleRow } from '../database/schema.js';
import type { RegisteredDevice } from '../devices/registry.js';
import { platformOf } from '../drivers/select.js';

export type DeviceState = 'online' | 'offline' | 'disabled';

export interface FleetDevice {
    device: RegisteredDevice;
    connected: boolean;
    state: DeviceState;
}

export function deviceState(device: Pick<RegisteredDevice, 'disabled'>, connected: boolean): DeviceState {
    if (device.disabled) return 'disabled';
    return connected ? 'online' : 'offline';
}

/**
 * The badge a client renders. Wider than `DeviceState`, which only knows about
 * registration and USB: `busy` and `error` need the execution table and the
 * control-channel state, so they are derived here once rather than in every
 * client from four separate fields.
 */
export type DerivedDeviceState = 'online' | 'busy' | 'offline' | 'disabled' | 'error';

export interface DerivedStateInput {
    disabled?: boolean;
    connected: boolean;
    /** A queued or running execution on this device. */
    busy?: boolean;
    /** The control channel reported an error, or the device's last event was an error. */
    errored?: boolean;
}

/**
 * Precedence: an operator's own decision (`disabled`) first, then whether the
 * phone is physically there, then whether it is broken, then whether it is
 * working. An offline device is "offline", not "error" — the cable is the story.
 */
export function derivedDeviceState(input: DerivedStateInput): DerivedDeviceState {
    if (input.disabled) return 'disabled';
    if (!input.connected) return 'offline';
    if (input.errored) return 'error';
    return input.busy ? 'busy' : 'online';
}

/** A running execution is stuck once it is this far past its run-window deadline. */
export const STUCK_GRACE_MS = 5 * 60_000;

export function stuckExecutions(executions: readonly ExecutionRow[], now: Date, graceMs = STUCK_GRACE_MS): ExecutionRow[] {
    return executions.filter((execution) => execution.status === 'running'
        && now.getTime() > execution.deadlineAt.getTime() + graceMs);
}

export interface FleetSummaryInput {
    devices: readonly FleetDevice[];
    executions: readonly ExecutionRow[];
    schedules: readonly ScheduleRow[];
    now?: Date;
}

export interface FleetSummary {
    generatedAt: string;
    devices: { total: number; online: number; offline: number; disabled: number };
    byPlatform: Record<string, number>;
    running: number;
    queued: number;
    stuck: number;
    failedLast24h: number;
    succeededLast24h: number;
    plannedNext24h: number;
}

/** Pure — the /api/fleet/summary route, the fleet page and the tray app all read this shape. */
export function summarizeFleet(input: FleetSummaryInput): FleetSummary {
    const now = input.now ?? new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const dayAhead = new Date(now.getTime() + 86_400_000);
    const byPlatform: Record<string, number> = {};
    for (const entry of input.devices) {
        const platform = platformOf(entry.device);
        byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;
    }
    const finishedInWindow = (execution: ExecutionRow, status: ExecutionRow['status']) => execution.status === status
        && Boolean(execution.finishedAt) && execution.finishedAt!.getTime() >= dayAgo.getTime();
    const queuedNext24h = input.executions.filter((execution) => execution.status === 'queued'
        && execution.scheduledFor.getTime() <= dayAhead.getTime()).length;
    const scheduledNext24h = input.schedules.filter((schedule) => schedule.status === 'active'
        && Boolean(schedule.nextRunAt) && schedule.nextRunAt!.getTime() > now.getTime()
        && schedule.nextRunAt!.getTime() <= dayAhead.getTime()).length;
    return {
        generatedAt: now.toISOString(),
        devices: {
            total: input.devices.length,
            online: input.devices.filter(({ state }) => state === 'online').length,
            offline: input.devices.filter(({ state }) => state === 'offline').length,
            disabled: input.devices.filter(({ state }) => state === 'disabled').length,
        },
        byPlatform,
        running: input.executions.filter(({ status }) => status === 'running').length,
        queued: input.executions.filter(({ status }) => status === 'queued').length,
        stuck: stuckExecutions(input.executions, now).length,
        failedLast24h: input.executions.filter((execution) => finishedInWindow(execution, 'failed')).length,
        succeededLast24h: input.executions.filter((execution) => finishedInWindow(execution, 'succeeded')).length,
        plannedNext24h: queuedNext24h + scheduledNext24h,
    };
}
