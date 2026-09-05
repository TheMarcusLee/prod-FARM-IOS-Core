import { bigint, index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import type { EventSeverity } from './schema-events.js';

/**
 * Same physical `scheduler` schema as schema.ts, re-declared for the reason
 * spelled out in schema-events.ts: schema.ts re-exports this file, so importing
 * its `pgSchema` handle back out would touch a `const` in its temporal dead zone.
 */
const pushSchema = pgSchema('scheduler');

/**
 * One row per phone that asked to be pushed to. `expo_push_token` is the natural
 * key — re-registering the same token updates preferences instead of adding a row.
 * `token_id` is the API token identity that registered it, so a revoked operator
 * token can take its registrations with it.
 */
export const pushRegistrations = pushSchema.table('push_registrations', {
    id: uuid('id').primaryKey().defaultRandom(),
    expoPushToken: text('expo_push_token').notNull().unique(),
    name: text('name').notNull(),
    minSeverity: text('min_severity').$type<EventSeverity>().notNull().default('warning'),
    /** Null means "every kind at or above `min_severity`". */
    kinds: text('kinds').array(),
    tokenId: text('token_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** The last Expo receipt error, kept so a dead token is visible before it is pruned. */
    lastError: text('last_error'),
}, (table) => [index('push_registrations_token_idx').on(table.tokenId)]);

/**
 * Per-token read mark for the event timeline: everything with `id <= up_to_id`
 * is acknowledged for that caller. One row per API token identity, so two phones
 * keep separate unread state.
 */
export const eventAcks = pushSchema.table('event_acks', {
    tokenId: text('token_id').primaryKey(),
    upToId: bigint('up_to_id', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type PushRegistrationRow = typeof pushRegistrations.$inferSelect;
export type EventAckRow = typeof eventAcks.$inferSelect;
