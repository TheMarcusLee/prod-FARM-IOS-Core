import { and, asc, count, desc, eq, gt, gte, lt, lte, type SQL } from 'drizzle-orm';

import type { DatabaseConnection } from '../database/client.js';
import { events, type EventRow, type EventSeverity } from '../database/schema.js';
import type { JsonObject } from '../types.js';

export type { EventSeverity };

/** The fixed event vocabulary. A companion mobile app is built against this list. */
export const EVENT_KINDS = [
    'execution.started', 'execution.succeeded', 'execution.failed', 'execution.stopped', 'execution.stuck',
    'device.connected', 'device.disconnected', 'device.error',
    'schedule.created', 'schedule.paused', 'schedule.cancelled',
    'digest.daily',
] as const;

export type EventKind = typeof EVENT_KINDS[number];

export const EVENT_SEVERITIES: readonly EventSeverity[] = ['info', 'warning', 'error'];

/** Ordered worst-last, so a minimum severity is a simple index comparison. */
const SEVERITY_RANK: Record<EventSeverity, number> = { info: 0, warning: 1, error: 2 };

export function severityRank(severity: EventSeverity): number {
    return SEVERITY_RANK[severity] ?? 0;
}

export function isEventKind(value: unknown): value is EventKind {
    return typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);
}

export function isEventSeverity(value: unknown): value is EventSeverity {
    return value === 'info' || value === 'warning' || value === 'error';
}

export interface EventInput {
    kind: EventKind;
    severity: EventSeverity;
    deviceUdid?: string | null;
    executionId?: string | null;
    scheduleId?: string | null;
    title: string;
    detail?: JsonObject | null;
}

export interface FarmEvent {
    id: number;
    kind: EventKind;
    severity: EventSeverity;
    deviceUdid: string | null;
    executionId: string | null;
    scheduleId: string | null;
    title: string;
    detail: JsonObject | null;
    createdAt: Date;
}

export interface EventQuery {
    since?: Date;
    until?: Date;
    kind?: EventKind;
    deviceUdid?: string;
    severity?: EventSeverity;
    /** Cursor: only events with a smaller id (newest first). */
    before?: number;
    /** Floor: only events with a larger id — the unacknowledged mark. */
    afterId?: number;
    limit?: number;
}

export interface EventStore {
    /** Newest first. */
    list(query?: EventQuery): Promise<FarmEvent[]>;
    /** Oldest first — the SSE replay/tail direction. */
    after(id: number, limit?: number): Promise<FarmEvent[]>;
    /** How many events sit above the cursor — the unacknowledged count. */
    countAfter(id: number): Promise<number>;
    record(input: EventInput): Promise<FarmEvent>;
}

export const MAX_EVENT_LIMIT = 500;

export function clampLimit(value: unknown, fallback = 100): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(Math.floor(parsed), MAX_EVENT_LIMIT);
}

function toEvent(row: EventRow): FarmEvent {
    return {
        id: Number(row.id), kind: row.kind as EventKind, severity: row.severity,
        deviceUdid: row.deviceUdid, executionId: row.executionId, scheduleId: row.scheduleId,
        title: row.title, detail: row.detail ?? null, createdAt: row.createdAt,
    };
}

/** Wire shape for the JSON API, the SSE stream and every notification channel. */
export function serializeEvent(event: FarmEvent): JsonObject {
    return {
        id: event.id, kind: event.kind, severity: event.severity,
        deviceUdid: event.deviceUdid, executionId: event.executionId, scheduleId: event.scheduleId,
        title: event.title, detail: event.detail, createdAt: event.createdAt.toISOString(),
    };
}

export function matchesEventQuery(event: FarmEvent, query: EventQuery): boolean {
    if (query.since && event.createdAt < query.since) return false;
    if (query.until && event.createdAt > query.until) return false;
    if (query.kind && event.kind !== query.kind) return false;
    if (query.deviceUdid && event.deviceUdid !== query.deviceUdid) return false;
    if (query.severity && event.severity !== query.severity) return false;
    if (query.before !== undefined && event.id >= query.before) return false;
    if (query.afterId !== undefined && event.id <= query.afterId) return false;
    return true;
}

/** Newest first, same ordering and cursor rules as the SQL store. */
export function queryEvents(events: readonly FarmEvent[], query: EventQuery = {}): FarmEvent[] {
    return events.filter((event) => matchesEventQuery(event, query))
        .sort((a, b) => b.id - a.id)
        .slice(0, clampLimit(query.limit));
}

/**
 * The same contract backed by an array. Used by the tests, and by any embedding
 * that wants the fleet routes without a scheduler database.
 */
export function createMemoryEventStore(seed: readonly FarmEvent[] = []): EventStore & { events: FarmEvent[] } {
    const events = [...seed];
    let nextId = events.reduce((highest, event) => Math.max(highest, event.id), 0);
    return {
        events,
        async record(input) {
            const event: FarmEvent = {
                id: ++nextId, kind: input.kind, severity: input.severity,
                deviceUdid: input.deviceUdid ?? null, executionId: input.executionId ?? null,
                scheduleId: input.scheduleId ?? null, title: input.title, detail: input.detail ?? null,
                createdAt: new Date(),
            };
            events.push(event);
            return event;
        },
        async list(query = {}) { return queryEvents(events, query); },
        async after(id, limit = 100) {
            return events.filter((event) => event.id > id).sort((a, b) => a.id - b.id).slice(0, clampLimit(limit));
        },
        async countAfter(id) { return events.filter((event) => event.id > id).length; },
    };
}

export function createEventStore(connection: DatabaseConnection): EventStore {
    const { db } = connection;
    return {
        async record(input) {
            const [row] = await db.insert(events).values({
                kind: input.kind, severity: input.severity,
                deviceUdid: input.deviceUdid ?? null, executionId: input.executionId ?? null,
                scheduleId: input.scheduleId ?? null, title: input.title, detail: input.detail ?? null,
            }).returning();
            if (!row) throw new Error('Unable to record event');
            return toEvent(row);
        },
        async list(query = {}) {
            const filters: SQL[] = [];
            if (query.since) filters.push(gte(events.createdAt, query.since));
            if (query.until) filters.push(lte(events.createdAt, query.until));
            if (query.kind) filters.push(eq(events.kind, query.kind));
            if (query.deviceUdid) filters.push(eq(events.deviceUdid, query.deviceUdid));
            if (query.severity) filters.push(eq(events.severity, query.severity));
            if (query.before !== undefined) filters.push(lt(events.id, query.before));
            if (query.afterId !== undefined) filters.push(gt(events.id, query.afterId));
            const rows = await db.select().from(events)
                .where(filters.length ? and(...filters) : undefined)
                .orderBy(desc(events.id)).limit(clampLimit(query.limit));
            return rows.map(toEvent);
        },
        async after(id, limit = 100) {
            const rows = await db.select().from(events).where(gt(events.id, id))
                .orderBy(asc(events.id)).limit(clampLimit(limit));
            return rows.map(toEvent);
        },
        async countAfter(id) {
            const [row] = await db.select({ total: count() }).from(events).where(gt(events.id, id));
            return Number(row?.total ?? 0);
        },
    };
}
