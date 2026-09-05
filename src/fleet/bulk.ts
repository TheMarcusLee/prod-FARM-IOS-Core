import type { RegisteredDevice } from '../devices/registry.js';
import type { SchedulerRepository } from '../scheduler/repository.js';
import type { CreateTaskInput, JsonObject, ScheduleTiming, TaskEnvelope } from '../types.js';

export type Stagger =
    | { kind: 'fixed'; minutes: number }
    | { kind: 'random'; windowMinutes: number };

export const MAX_BULK_DEVICES = 200;
const MAX_STAGGER_MINUTES = 1440;

/** Explicit whitelist — the request body never reaches the repository unchecked. */
export function parseStagger(value: unknown): Stagger {
    if (value === undefined || value === null) return { kind: 'fixed', minutes: 0 };
    const input = value as { kind?: unknown; minutes?: unknown; windowMinutes?: unknown };
    if (input.kind === 'fixed') {
        const minutes = Number(input.minutes ?? 0);
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_STAGGER_MINUTES) {
            throw new Error(`stagger.minutes must be between 0 and ${MAX_STAGGER_MINUTES}`);
        }
        return { kind: 'fixed', minutes };
    }
    if (input.kind === 'random') {
        const windowMinutes = Number(input.windowMinutes ?? 0);
        if (!Number.isFinite(windowMinutes) || windowMinutes < 0 || windowMinutes > MAX_STAGGER_MINUTES) {
            throw new Error(`stagger.windowMinutes must be between 0 and ${MAX_STAGGER_MINUTES}`);
        }
        return { kind: 'random', windowMinutes };
    }
    throw new Error('stagger.kind must be "fixed" or "random"');
}

/**
 * One start offset (in minutes) per device, in the order the devices were given.
 * `fixed` spreads them evenly (index × minutes); `random` picks a whole minute
 * inside [0, windowMinutes) so a fleet never posts in lockstep.
 */
export function staggerOffsets(count: number, stagger: Stagger, random: () => number = Math.random): number[] {
    return Array.from({ length: Math.max(0, count) }, (_value, index) => (
        stagger.kind === 'fixed'
            ? index * stagger.minutes
            : Math.floor(random() * stagger.windowMinutes)
    ));
}

/** "23:50" + 20 → "00:10". */
export function shiftLocalTime(localTime: string, minutes: number): string {
    const [hour = 0, minute = 0] = localTime.split(':').map(Number);
    const total = ((hour * 60 + minute + Math.round(minutes)) % 1440 + 1440) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Moves a timing forward by `offsetMinutes`. A staggered "now" becomes a "once". */
export function staggeredTiming(timing: ScheduleTiming, offsetMinutes: number, now: Date): ScheduleTiming {
    if (offsetMinutes <= 0) return timing;
    const shift = offsetMinutes * 60_000;
    if (timing.kind === 'now') return { kind: 'once', runAt: new Date(now.getTime() + shift).toISOString() };
    if (timing.kind === 'once') return { kind: 'once', runAt: new Date(new Date(timing.runAt).getTime() + shift).toISOString() };
    return { ...timing, localTime: shiftLocalTime(timing.localTime, offsetMinutes) };
}

export interface BulkScheduleRequest {
    deviceUdids: string[];
    task: TaskEnvelope;
    timing: ScheduleTiming;
    stagger: Stagger;
    runWindowMinutes?: number;
    /** Optional per-device payload patch — how each device gets its own account. */
    overrides?: Record<string, JsonObject>;
}

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Explicit whitelist for POST /api/schedules/bulk — nothing else reaches the repository. */
export function parseBulkRequest(body: unknown): BulkScheduleRequest {
    if (!isJsonObject(body)) throw new Error('A JSON body is required');
    const raw = body as Record<string, unknown>;
    const deviceUdids = raw.deviceUdids;
    if (!Array.isArray(deviceUdids) || !deviceUdids.length) throw new Error('deviceUdids must be a non-empty array');
    if (deviceUdids.length > MAX_BULK_DEVICES) throw new Error(`deviceUdids may not exceed ${MAX_BULK_DEVICES} devices`);
    if (deviceUdids.some((udid) => typeof udid !== 'string' || !udid.trim())) throw new Error('deviceUdids must contain device UDIDs');
    const unique = [...new Set(deviceUdids as string[])];
    const task = raw.task as Record<string, unknown> | undefined;
    if (!isJsonObject(task) || typeof task.pluginId !== 'string' || typeof task.taskType !== 'string'
        || !Number.isInteger(task.taskVersion) || !isJsonObject(task.payload)) {
        throw new Error('task must be { pluginId, taskType, taskVersion, payload }');
    }
    if (!isJsonObject(raw.timing) || typeof (raw.timing as { kind?: unknown }).kind !== 'string') {
        throw new Error('timing is required');
    }
    const overrides: Record<string, JsonObject> = {};
    if (raw.overrides !== undefined) {
        if (!isJsonObject(raw.overrides)) throw new Error('overrides must be an object keyed by device UDID');
        for (const udid of unique) {
            const patch = (raw.overrides as Record<string, unknown>)[udid];
            if (patch === undefined) continue;
            if (!isJsonObject(patch)) throw new Error(`overrides.${udid} must be an object`);
            overrides[udid] = patch;
        }
    }
    const runWindowMinutes = raw.runWindowMinutes;
    if (runWindowMinutes !== undefined && (!Number.isInteger(runWindowMinutes) || (runWindowMinutes as number) < 1)) {
        throw new Error('runWindowMinutes must be a positive integer');
    }
    return {
        deviceUdids: unique,
        task: {
            pluginId: task.pluginId, taskType: task.taskType,
            taskVersion: task.taskVersion as number, payload: task.payload,
        },
        timing: raw.timing as unknown as ScheduleTiming,
        stagger: parseStagger(raw.stagger),
        ...(runWindowMinutes === undefined ? {} : { runWindowMinutes: runWindowMinutes as number }),
        ...(Object.keys(overrides).length ? { overrides } : {}),
    };
}

export interface BulkScheduleOutcome {
    deviceUdid: string;
    ok: boolean;
    scheduleId?: string;
    offsetMinutes: number;
    nextRunAt?: string;
    error?: string;
}

export interface BulkScheduleDependencies {
    scheduler: Pick<SchedulerRepository, 'createTask'>;
    devices: readonly RegisteredDevice[];
    now?: Date;
    random?: () => number;
}

/**
 * One schedule per device, created through the normal repository path so every
 * plugin validation and conflict rule still applies. A device that fails is
 * reported and the rest continue.
 */
export async function createBulkSchedules(
    request: BulkScheduleRequest, dependencies: BulkScheduleDependencies,
): Promise<BulkScheduleOutcome[]> {
    const now = dependencies.now ?? new Date();
    const offsets = staggerOffsets(request.deviceUdids.length, request.stagger, dependencies.random);
    const byUdid = new Map(dependencies.devices.map((device) => [device.udid, device]));
    const outcomes: BulkScheduleOutcome[] = [];
    for (const [index, deviceUdid] of request.deviceUdids.entries()) {
        const offsetMinutes = offsets[index] ?? 0;
        try {
            const device = byUdid.get(deviceUdid);
            if (!device) throw new Error('Device is not registered');
            if (device.disabled) throw new Error('Device is disabled — activate it before scheduling automation');
            const payload = { ...request.task.payload, ...(request.overrides?.[deviceUdid] ?? {}) };
            const input: CreateTaskInput = {
                deviceUdid,
                task: { ...request.task, payload },
                timing: staggeredTiming(request.timing, offsetMinutes, now),
                ...(request.runWindowMinutes === undefined ? {} : { runWindowMinutes: request.runWindowMinutes }),
            };
            const schedule = await dependencies.scheduler.createTask(
                input, device.pluginData[request.task.pluginId] ?? {}, now,
            );
            outcomes.push({
                deviceUdid, ok: true, scheduleId: schedule.id, offsetMinutes,
                ...(schedule.nextRunAt ? { nextRunAt: schedule.nextRunAt.toISOString() } : {}),
            });
        } catch (error) {
            outcomes.push({
                deviceUdid, ok: false, offsetMinutes,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return outcomes;
}
