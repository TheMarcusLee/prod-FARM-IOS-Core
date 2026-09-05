/**
 * Everything the Control Center, the devices list and the inspector need about the fleet, read
 * once per request. Every scheduler call is optional: a farm with no database still renders its
 * phones, it just has nothing to say about schedules.
 */
import type { ExecutionRow, ScheduleRow } from '../database/schema.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../devices/registry.js';
import { driverKindOf, platformOf } from '../drivers/select.js';
import { connectedFleetUdids } from '../fleet/connectivity.js';
import type { FarmEvent, EventStore } from '../fleet/events.js';
import type { WallData, WallDevice, WallLogLine } from '../fleet/page.js';
import { timeOfDay } from '../fleet/page.js';
import { derivedDeviceState } from '../fleet/summary.js';
import type { SchedulerRepository } from '../scheduler/repository.js';

export interface WallSources {
    scheduler: SchedulerRepository;
    loadDevices?: () => Promise<RegisteredDevice[]>;
    connectedUdids?: () => Promise<string[]>;
    events?: () => EventStore | null;
    now?: () => Date;
    /** The phone the inspector should open on, when the request names one. */
    selectedUdid?: string;
}

/** Never let a missing database take a page down; an unavailable list is an empty one. */
async function safely<T>(load: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await load();
    } catch {
        return fallback;
    }
}

export function accountsOf(device: RegisteredDevice): string[] {
    return Object.values(device.pluginData).flatMap((value) => {
        const candidate = value?.accounts;
        return Array.isArray(candidate) ? candidate.filter((entry): entry is string => typeof entry === 'string') : [];
    });
}

/** An Android phone whose accessibility bridge is reachable over the network, not the cable. */
export function onWifi(device: RegisteredDevice): boolean {
    return platformOf(device) === 'android' && typeof device.android?.bridgeUrl === 'string'
        && !device.android.bridgeUrl.includes('127.0.0.1');
}

function taskName(row: { pluginId: string; taskType: string }): string {
    return `${row.pluginId}/${row.taskType}`;
}

/** A log line that starts with a clock or an ISO timestamp keeps it; anything else is just text. */
export function parseLogLine(line: string): WallLogLine {
    const clock = /^\[?(\d{2}:\d{2}:\d{2})]?\s+(.*)$/.exec(line);
    if (clock) return { time: clock[1]!, text: clock[2]! };
    const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?\s+(.*)$/.exec(line);
    if (iso) return { time: iso[1]!.slice(11), text: iso[2]! };
    return { time: '', text: line };
}

export interface FleetRead {
    devices: RegisteredDevice[];
    connected: Set<string>;
    executions: ExecutionRow[];
    schedules: ScheduleRow[];
    events: FarmEvent[];
    now: Date;
}

/** One pass over the registry, the connection sources, the scheduler and the event log. */
export async function readFleet(sources: WallSources): Promise<FleetRead> {
    const now = sources.now?.() ?? new Date();
    const scheduler = sources.scheduler as Partial<SchedulerRepository>;
    const store = sources.events?.() ?? null;
    const [devices, connected, executions, schedules, events] = await Promise.all([
        safely(() => (sources.loadDevices ?? loadRegisteredDevices)(), [] as RegisteredDevice[]),
        safely(() => (sources.connectedUdids ?? (() => connectedFleetUdids()))(), [] as string[]),
        safely(async () => await scheduler.listExecutions?.(200) ?? [], [] as ExecutionRow[]),
        safely(async () => await scheduler.listSchedules?.(200) ?? [], [] as ScheduleRow[]),
        safely(async () => await store?.list({ limit: 200 }) ?? [], [] as FarmEvent[]),
    ]);
    return { devices, connected: new Set(connected), executions, schedules, events, now };
}

/** Turn one read of the fleet into the wall's view of it, in registration order. */
export function toWallDevices(read: FleetRead): WallDevice[] {
    const dayStart = new Date(read.now.getFullYear(), read.now.getMonth(), read.now.getDate()).getTime();
    const active = new Map<string, ExecutionRow>();
    for (const execution of read.executions) {
        if (!['queued', 'running'].includes(execution.status)) continue;
        const held = active.get(execution.deviceUdid);
        if (!held || held.status !== 'running') active.set(execution.deviceUdid, execution);
    }
    const next = new Map<string, ScheduleRow>();
    for (const schedule of read.schedules) {
        if (schedule.status !== 'active' || !schedule.nextRunAt) continue;
        const held = next.get(schedule.deviceUdid);
        if (!held || schedule.nextRunAt < held.nextRunAt!) next.set(schedule.deviceUdid, schedule);
    }
    const latest = new Map<string, FarmEvent>();
    for (const event of read.events) {
        if (event.deviceUdid && !latest.has(event.deviceUdid)) latest.set(event.deviceUdid, event);
    }
    const finishedToday = (execution: ExecutionRow, status: string) => execution.status === status
        && Boolean(execution.finishedAt) && execution.finishedAt!.getTime() >= dayStart;

    return read.devices.map((device, slot) => {
        const connected = read.connected.has(device.udid);
        const current = active.get(device.udid);
        const event = latest.get(device.udid);
        const errored = event?.severity === 'error'
            || read.executions.some((execution) => execution.deviceUdid === device.udid
                && execution.status === 'failed' && Boolean(execution.finishedAt)
                && execution.finishedAt!.getTime() >= dayStart
                && !active.has(device.udid));
        const schedule = next.get(device.udid);
        const wall: WallDevice = {
            udid: device.udid,
            name: device.name,
            slot,
            platform: platformOf(device) === 'android' ? 'android' : 'ios',
            driver: driverKindOf(device),
            state: derivedDeviceState({
                ...(device.disabled ? { disabled: true } : {}),
                connected,
                busy: Boolean(current),
                errored,
            }),
            connected,
            disabled: Boolean(device.disabled),
            wifi: onWifi(device),
            tags: device.tags ?? [],
            accounts: accountsOf(device),
            postedToday: read.executions.filter((execution) => execution.deviceUdid === device.udid
                && finishedToday(execution, 'succeeded')).length,
            failedToday: read.executions.filter((execution) => execution.deviceUdid === device.udid
                && finishedToday(execution, 'failed')).length,
        };
        if (current) wall.current = { id: current.id, status: current.status, task: taskName(current) };
        if (schedule?.nextRunAt) {
            wall.nextRunAt = schedule.nextRunAt;
            wall.nextLabel = taskName(schedule);
        }
        if (event) wall.lastMessage = event.title;
        return wall;
    });
}

/** The last few lines of whatever ran most recently on this phone. */
export async function inspectorLog(
    scheduler: SchedulerRepository, udid: string, limit = 6,
): Promise<WallLogLine[]> {
    const partial = scheduler as Partial<SchedulerRepository>;
    const executions = await safely(async () => await partial.listExecutions?.(10, udid) ?? [], [] as ExecutionRow[]);
    const execution = executions.find(({ status }) => status === 'running') ?? executions[0];
    if (!execution) return [];
    const detail = await safely(async () => await partial.execution?.(execution.id) ?? null, null);
    const lines = detail?.logs ?? [];
    if (!lines.length) {
        const started = execution.startedAt ?? execution.scheduledFor;
        return [{ time: timeOfDay(started), text: `${taskName(execution)} is ${execution.status}` }];
    }
    return lines.slice(-limit).map(parseLogLine);
}

export function fleetTags(devices: readonly RegisteredDevice[]): string[] {
    return [...new Set(devices.flatMap((device) => device.tags ?? []))].sort();
}

/** The whole Control Center payload. */
export async function collectWall(sources: WallSources): Promise<WallData & { read: FleetRead }> {
    const read = await readFleet(sources);
    const devices = toWallDevices(read);
    const selected = devices.find(({ udid }) => udid === sources.selectedUdid)
        ?? devices.find((device) => device.connected && !device.disabled) ?? devices[0];
    const log = selected ? await inspectorLog(sources.scheduler, selected.udid) : [];
    return {
        devices,
        tags: fleetTags(read.devices),
        ...(selected ? { selected } : {}),
        log,
        read,
    };
}
