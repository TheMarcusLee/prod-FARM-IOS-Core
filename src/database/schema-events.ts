import { bigint, index, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import type { JsonObject } from '../types.js';

/**
 * The same physical `scheduler` schema as schema.ts. It is re-declared instead
 * of imported because schema.ts re-exports this file, and an ESM cycle would
 * evaluate this module before schema.ts had defined its own handle.
 */
const eventsSchema = pgSchema('scheduler');

export type EventSeverity = 'info' | 'warning' | 'error';

/**
 * Fleet timeline. Append-only: one row per notable thing that happened to a
 * device, execution or schedule. `id` is the SSE cursor (Last-Event-ID) and the
 * pagination cursor for GET /api/events?before=.
 */
export const events = eventsSchema.table('events', {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text('kind').notNull(),
    severity: text('severity').$type<EventSeverity>().notNull(),
    deviceUdid: text('device_udid'),
    executionId: uuid('execution_id'),
    scheduleId: uuid('schedule_id'),
    title: text('title').notNull(),
    detail: jsonb('detail').$type<JsonObject>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    index('events_created_at_idx').on(table.createdAt),
    index('events_device_idx').on(table.deviceUdid),
]);

export type EventRow = typeof events.$inferSelect;
