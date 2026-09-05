import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ExecutionRow } from '../../database/schema.js';
import { discoverConnectedDeviceUdids } from '../../devices/discovery.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../../devices/registry.js';
import type { DeviceConnectionStatus } from '../../devices/connection-manager.js';
import { requestWdaService } from '../../devices/wda-service-client.js';
import { driverKindOf, platformOf } from '../../drivers/select.js';
import { createBulkSchedules, parseBulkRequest } from '../../fleet/bulk.js';
import {
    clampLimit, createEventStore, isEventKind, isEventSeverity, serializeEvent,
    type EventQuery, type EventStore, type FarmEvent,
} from '../../fleet/events.js';
import {
    createDeviceMonitorState, diffDeviceStatuses, longOfflineDevices, type DeviceMonitorState,
} from '../../fleet/device-monitor.js';
import { renderFleetPage, type FleetCard } from '../../fleet/page.js';
import { createEventStreamHub, type EventStreamHub } from '../../fleet/sse-hub.js';
import { createEventRecorder, type EventRecorder } from '../../fleet/recorder.js';
import { deviceState, stuckExecutions, summarizeFleet } from '../../fleet/summary.js';
import { notificationConfigFromEnv, type NotificationConfig } from '../../notifications/config.js';
import { acknowledgedMark } from '../../push/acks.js';
import { deliverEvent, type DeliveryOptions, type DeliveryResult } from '../../notifications/deliver.js';
import { buildDigest, startDigestScheduler } from '../../notifications/digest.js';
import type { SchedulerRepository } from '../../scheduler/repository.js';

/** Structurally satisfied by CreateAppOptions, so app.ts passes its own options through. */
export interface FleetRouteOptions {
    scheduler: SchedulerRepository;
    /** Test seams. Production leaves every one of these unset. */
    events?: EventStore;
    notifications?: NotificationConfig;
    delivery?: DeliveryOptions;
    loadDevices?: () => Promise<RegisteredDevice[]>;
    connectedUdids?: () => Promise<string[]>;
    deviceStatuses?: () => Promise<DeviceConnectionStatus[]>;
    now?: () => Date;
    ssePollIntervalMs?: number;
    monitorIntervalMs?: number;
    /** How long /api/fleet/summary and /fleet may reuse one device+scheduler read. */
    summaryTtlMs?: number;
    /** Set false to keep the device/stuck/digest timers out of a test process. */
    backgroundTasks?: boolean;
}

const HEARTBEAT_MS = 15_000;
const DEFAULT_MONITOR_MS = 30_000;
/**
 * The fleet page polls its summary every 5 s, and so does every tray app. Each
 * call means a USB enumeration plus two 500-row scheduler queries, so a handful
 * of watchers used to multiply that by however many of them there were. A cache
 * this short is invisible to the operator and collapses the fan-in to one pass.
 */
const DEFAULT_SUMMARY_TTL_MS = 2_000;

/** Memoises an async load for `ttlMs`, sharing one in-flight call between callers. */
function throttled<T>(ttlMs: number, now: () => number, load: () => Promise<T>): () => Promise<T> {
    let cached: { at: number; value: T } | null = null;
    let inFlight: Promise<T> | null = null;
    return async () => {
        const at = now();
        if (cached && at - cached.at < ttlMs) return cached.value;
        inFlight ??= load().then((value) => {
            cached = { at: now(), value };
            return value;
        }).finally(() => { inFlight = null; });
        return inFlight;
    };
}

function fleetTags(devices: readonly RegisteredDevice[]): string[] {
    return [...new Set(devices.flatMap((device) => device.tags ?? []))].sort();
}

function accountsOf(device: RegisteredDevice): string[] {
    return Object.values(device.pluginData).flatMap((value) => {
        const candidate = value?.accounts;
        return Array.isArray(candidate) ? candidate.filter((entry): entry is string => typeof entry === 'string') : [];
    });
}

/** Ask wda-service for the live per-device connection states over its Unix socket. */
async function wdaServiceStatuses(): Promise<DeviceConnectionStatus[]> {
    const response = await requestWdaService('/devices', { timeoutMs: 2_000 });
    if (response.statusCode < 200 || response.statusCode >= 300) return [];
    return (JSON.parse(response.body).devices ?? []) as DeviceConnectionStatus[];
}

function parseEventQuery(query: Record<string, string | undefined>): EventQuery {
    const parsed: EventQuery = { limit: clampLimit(query.limit) };
    const date = (value: string | undefined): Date | undefined => {
        if (!value) return undefined;
        const candidate = new Date(value);
        if (!Number.isFinite(candidate.getTime())) throw Object.assign(new Error('since/until must be ISO timestamps'), { statusCode: 400 });
        return candidate;
    };
    const since = date(query.since);
    const until = date(query.until);
    if (since) parsed.since = since;
    if (until) parsed.until = until;
    if (query.kind) {
        if (!isEventKind(query.kind)) throw Object.assign(new Error(`Unknown event kind "${query.kind}"`), { statusCode: 400 });
        parsed.kind = query.kind;
    }
    if (query.severity) {
        if (!isEventSeverity(query.severity)) throw Object.assign(new Error('severity must be info, warning or error'), { statusCode: 400 });
        parsed.severity = query.severity;
    }
    if (query.deviceUdid) parsed.deviceUdid = query.deviceUdid;
    if (query.before !== undefined) {
        const before = Number(query.before);
        if (!Number.isFinite(before)) throw Object.assign(new Error('before must be an event id'), { statusCode: 400 });
        parsed.before = before;
    }
    return parsed;
}

/**
 * Fleet operations: the /fleet page, bulk scheduling, the event timeline, its
 * SSE stream, and notification delivery. Everything degrades to 503 rather than
 * throwing when the scheduler database is not wired up (unit tests, no DATABASE_URL).
 */
export async function registerFleetRoutes(app: FastifyInstance, options: FleetRouteOptions): Promise<void> {
    const clock = options.now ?? (() => new Date());
    const notifications = options.notifications ?? notificationConfigFromEnv();
    const loadDevices = options.loadDevices ?? loadRegisteredDevices;
    // Only the UDIDs: discoverConnectedDevices() also asks usbmuxd for a name,
    // an OS version and a device-info blob per phone — three extra round trips
    // each — and every one of them is thrown away here.
    const connectedUdids = options.connectedUdids ?? (() => discoverConnectedDeviceUdids());

    let store: EventStore | null = options.events ?? null;
    const eventStore = (): EventStore | null => {
        if (!store && options.scheduler?.connection) store = createEventStore(options.scheduler.connection);
        return store;
    };
    const requireStore = (reply: FastifyReply): EventStore | null => {
        const resolved = eventStore();
        if (!resolved) void reply.code(503).send({ error: 'The event log is unavailable — the scheduler database is not connected' });
        return resolved;
    };
    const recorder: EventRecorder = createEventRecorder({
        record: async (input) => {
            const resolved = eventStore();
            if (!resolved) throw new Error('Event store unavailable');
            return resolved.record(input);
        },
        list: async (query) => eventStore()?.list(query) ?? [],
        after: async (id, limit) => eventStore()?.after(id, limit) ?? [],
        countAfter: async (id) => eventStore()?.countAfter(id) ?? 0,
    }, { notifications, ...(options.delivery ? { delivery: options.delivery } : {}), log: (message) => app.log.warn(message) });

    // One poll timer and one query for every subscriber — see sse-hub.ts. Built
    // lazily so a process without an event store never starts a timer at all.
    let streams: EventStreamHub | null = null;
    const hub = (): EventStreamHub => {
        const resolved = eventStore();
        if (!resolved) throw new Error('Event store unavailable');
        streams ??= createEventStreamHub(resolved, {
            ...(options.ssePollIntervalMs === undefined ? {} : { intervalMs: options.ssePollIntervalMs }),
            heartbeatMs: HEARTBEAT_MS,
            log: (message) => app.log.debug(message),
        });
        return streams;
    };
    // Without this an `app.close()` leaves the poll and heartbeat intervals
    // running and the sockets open — a leaked timer per test that opened a stream.
    app.addHook('onClose', async () => { streams?.closeAll(); });

    app.get<{ Querystring: Record<string, string | undefined> }>('/api/events', async (request, reply) => {
        const resolved = requireStore(reply);
        if (!resolved) return reply;
        const query = parseEventQuery(request.query);
        // ?acknowledged=false narrows to what this token has not marked read; with
        // no ack store attached it degrades to the unfiltered timeline.
        if (request.query.acknowledged === 'false') {
            const mark = await acknowledgedMark(app, request);
            if (mark) query.afterId = mark;
        }
        const events = await resolved.list(query);
        return {
            events: events.map(serializeEvent),
            nextBefore: events.length === query.limit ? events[events.length - 1]?.id ?? null : null,
        };
    });

    // Server-Sent Events. The cursor is the event id, so a reconnecting client
    // replays exactly what it missed via Last-Event-ID. Polling the table (not an
    // in-process emitter) is what lets the worker process's events reach the browser.
    app.get<{ Querystring: { lastEventId?: string } }>('/api/events/stream', async (request, reply) => {
        const resolved = requireStore(reply);
        if (!resolved) return reply;
        const header = request.headers['last-event-id'];
        let cursor = Number((Array.isArray(header) ? header[0] : header) ?? request.query.lastEventId ?? 0);
        if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
            'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive', 'x-accel-buffering': 'no',
        });
        raw.write(': connected\n\n');
        const subscription = hub().add(raw, cursor);
        request.raw.once('close', () => subscription.close());
        request.raw.once('error', () => subscription.close());
        raw.once('error', () => subscription.close());
        // First replay is immediate; everything after it rides the shared poll.
        await hub().poll();
    });

    app.post('/api/notifications/test', async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!notifications.channels.length) {
            return reply.code(409).send({ error: 'No notification channels are configured', channels: [] });
        }
        const probe: FarmEvent = {
            id: 0, kind: 'digest.daily', severity: 'info', deviceUdid: null, executionId: null, scheduleId: null,
            title: 'Phone Farm notification test',
            detail: { test: true, sentAt: clock().toISOString() },
            createdAt: clock(),
        };
        const results: DeliveryResult[] = await deliverEvent(probe, notifications, options.delivery ?? {});
        return { ok: results.every(({ ok }) => ok), channels: results };
    });

    app.post('/api/schedules/bulk', async (request, reply) => {
        let parsed;
        try {
            parsed = parseBulkRequest(request.body);
        } catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
        const outcomes = await createBulkSchedules(parsed, {
            scheduler: options.scheduler, devices: await loadDevices(), now: clock(),
        });
        const created = outcomes.filter(({ ok }) => ok).length;
        // 207-style semantics: partial success is normal here, so the envelope
        // carries per-device results instead of a single status code.
        return reply.code(created ? 201 : 400).send({ created, failed: outcomes.length - created, results: outcomes });
    });

    const summaryTtlMs = options.summaryTtlMs ?? DEFAULT_SUMMARY_TTL_MS;
    const fleetState = throttled(summaryTtlMs, () => clock().getTime(), async () => {
        const [devices, connected] = await Promise.all([loadDevices(), connectedUdids()]);
        const online = new Set(connected);
        return devices.map((device) => ({
            device, connected: online.has(device.udid),
            state: deviceState(device, online.has(device.udid)),
        }));
    });

    const schedulerState = throttled(summaryTtlMs, () => clock().getTime(), async () => {
        const [executions, schedules] = await Promise.all([
            options.scheduler.listExecutions(500), options.scheduler.listSchedules(500),
        ]);
        return { executions, schedules };
    });

    app.get('/api/fleet/summary', async () => {
        const [devices, { executions, schedules }] = await Promise.all([fleetState(), schedulerState()]);
        return summarizeFleet({ devices, executions, schedules, now: clock() });
    });

    app.get('/fleet', async (_request, reply) => {
        const now = clock();
        const [devices, { executions, schedules }] = await Promise.all([fleetState(), schedulerState()]);
        const recent = await (eventStore()?.list({ limit: 300 }) ?? Promise.resolve([] as FarmEvent[]));
        const latestEvent = new Map<string, FarmEvent>();
        for (const event of recent) {
            if (event.deviceUdid && !latestEvent.has(event.deviceUdid)) latestEvent.set(event.deviceUdid, event);
        }
        const activeByDevice = new Map<string, ExecutionRow>();
        for (const execution of executions) {
            if (!['queued', 'running'].includes(execution.status)) continue;
            const held = activeByDevice.get(execution.deviceUdid);
            if (!held || held.status !== 'running') activeByDevice.set(execution.deviceUdid, execution);
        }
        const nextByDevice = new Map<string, Date>();
        for (const schedule of schedules) {
            if (schedule.status !== 'active' || !schedule.nextRunAt) continue;
            const held = nextByDevice.get(schedule.deviceUdid);
            if (!held || schedule.nextRunAt < held) nextByDevice.set(schedule.deviceUdid, schedule.nextRunAt);
        }
        const cards: FleetCard[] = devices.map(({ device, state }) => ({
            device, state, platform: platformOf(device), driver: driverKindOf(device),
            tags: device.tags ?? [], accounts: accountsOf(device),
            ...(activeByDevice.get(device.udid) ? { current: activeByDevice.get(device.udid)! } : {}),
            ...(nextByDevice.get(device.udid) ? { nextRunAt: nextByDevice.get(device.udid)! } : {}),
            ...(latestEvent.get(device.udid) ? { lastEvent: latestEvent.get(device.udid)! } : {}),
        }));
        return reply.type('text/html').send(renderFleetPage({
            cards,
            summary: summarizeFleet({ devices, executions, schedules, now }),
            tags: fleetTags(devices.map(({ device }) => device)),
        }));
    });

    // Background observers. They only run in a process with a real scheduler
    // database; a unit test that injects a fake repository gets none of them.
    if (options.backgroundTasks === false || (!options.events && !options.scheduler?.connection)) return;
    const monitorState: DeviceMonitorState = createDeviceMonitorState();
    const readStatuses = options.deviceStatuses ?? wdaServiceStatuses;
    // Rebuilt from the still-stuck set on every sweep, so an execution that
    // finishes drops out of it instead of accumulating for the process lifetime.
    let reportedStuck = new Set<string>();

    const sweep = async (): Promise<void> => {
        const now = clock();
        try {
            for (const input of diffDeviceStatuses(monitorState, await readStatuses(), now)) await recorder.record(input);
        } catch (error) { app.log.debug(`Fleet device poll failed: ${String(error)}`); }
        try {
            const stuck = stuckExecutions(await options.scheduler.listExecutions(500), now);
            const seen = new Set(stuck.map(({ id }) => id));
            reportedStuck = new Set([...reportedStuck].filter((id) => seen.has(id)));
            for (const execution of stuck) {
                if (reportedStuck.has(execution.id)) continue;
                reportedStuck.add(execution.id);
                await recorder.record({
                    kind: 'execution.stuck', severity: 'error', deviceUdid: execution.deviceUdid,
                    executionId: execution.id, scheduleId: execution.scheduleId,
                    title: `Execution on ${execution.deviceUdid} is running past its deadline`,
                    detail: {
                        task: `${execution.pluginId}/${execution.taskType}@${execution.taskVersion}`,
                        deadlineAt: execution.deadlineAt.toISOString(),
                        startedAt: execution.startedAt?.toISOString() ?? null,
                    },
                });
            }
        } catch (error) { app.log.debug(`Stuck-execution sweep failed: ${String(error)}`); }
    };

    const monitor = setInterval(() => void sweep(), options.monitorIntervalMs ?? DEFAULT_MONITOR_MS);
    monitor.unref?.();

    const digest = startDigestScheduler({
        localTime: notifications.digestLocalTime, timezone: notifications.digestTimezone,
        now: clock,
        log: (message) => app.log.warn(message),
        // The timeline is the persistence: the newest digest.daily row is when
        // the last one went out, so a restart after the slot does not send a
        // second one and a farm that was down at the slot still catches up.
        lastRunAt: async () => (await eventStore()?.list({ kind: 'digest.daily', limit: 1 }))?.[0]?.createdAt ?? null,
        run: async (now) => {
            const [executions, schedules] = await Promise.all([
                options.scheduler.listExecutions(500), options.scheduler.listSchedules(500),
            ]);
            // Recorded directly rather than through the recorder: the digest
            // always goes out, whatever NOTIFY_MIN_SEVERITY says.
            const event = await eventStore()?.record(buildDigest({
                now, executions, schedules, offlineDevices: longOfflineDevices(monitorState, now),
            }));
            if (event && notifications.channels.length) await deliverEvent(event, notifications, options.delivery ?? {});
        },
    });

    app.addHook('onClose', async () => { clearInterval(monitor); digest.stop(); });
}
