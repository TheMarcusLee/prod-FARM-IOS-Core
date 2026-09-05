import { boolean, date, index, integer, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { assets, schedules } from './schema.js';

/**
 * The content library lives in the same `scheduler` Postgres schema as the rest
 * of the app. It is declared here rather than imported from `schema.ts` because
 * `schema.ts` re-exports this file — importing the `pgSchema` handle back out of
 * it would touch a `const` still in its temporal dead zone. `pgSchema` is just a
 * name, so re-declaring it is safe; the `assets`/`schedules` references below are
 * lazy callbacks and only run once both modules have finished evaluating.
 */
export const contentSchema = pgSchema('scheduler');

export type ContentKind = 'video' | 'image';
export type ContentStatus = 'ready' | 'processing' | 'failed' | 'archived';
export type DripSource = 'set' | 'tag';
export type DripOrder = 'random' | 'fifo';
export type PostDestination = 'draft' | 'publish';

export const contentItems = contentSchema.table('content_items', {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The file a post actually uploads — the normalised copy when one was produced. */
    assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    /** The untouched upload, kept so a re-normalise never needs the source again. */
    originalAssetId: uuid('original_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    kind: text('kind').$type<ContentKind>().notNull(),
    durationMs: integer('duration_ms'),
    width: integer('width').notNull().default(0),
    height: integer('height').notNull().default(0),
    normalized: boolean('normalized').notNull().default(false),
    sha256: text('sha256').notNull(),
    tags: text('tags').array().notNull().default([]),
    caption: text('caption'),
    hashtags: text('hashtags').array().notNull().default([]),
    /** Relative to CONTENT_DIR; a poster frame the library grid shows. */
    posterPath: text('poster_path'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    usedCount: integer('used_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    status: text('status').$type<ContentStatus>().notNull().default('processing'),
    error: text('error'),
}, (table) => [
    index('content_items_status_idx').on(table.status, table.createdAt),
    index('content_items_last_used_idx').on(table.lastUsedAt),
]);

export const contentSets = contentSchema.table('content_sets', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [uniqueIndex('content_sets_name_idx').on(table.name)]);

export const contentSetItems = contentSchema.table('content_set_items', {
    setId: uuid('set_id').notNull().references(() => contentSets.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id').notNull().references(() => contentItems.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
}, (table) => [
    primaryKey({ columns: [table.setId, table.itemId] }),
    index('content_set_items_order_idx').on(table.setId, table.position),
]);

export const captionTemplates = contentSchema.table('caption_templates', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    template: text('template').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [uniqueIndex('caption_templates_name_idx').on(table.name)]);

export const dripRules = contentSchema.table('drip_rules', {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceUdid: text('device_udid').notNull(),
    account: text('account').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    postsPerDay: integer('posts_per_day').notNull().default(1),
    /** Local wall-clock 'HH:MM' in `timezone`; an end at or before the start crosses midnight. */
    windowStart: text('window_start').notNull().default('09:00'),
    windowEnd: text('window_end').notNull().default('21:00'),
    timezone: text('timezone').notNull().default('UTC'),
    minGapMinutes: integer('min_gap_minutes').notNull().default(90),
    destination: text('destination').$type<PostDestination>().notNull().default('draft'),
    source: text('source').$type<DripSource>().notNull().default('tag'),
    setId: uuid('set_id').references(() => contentSets.id, { onDelete: 'set null' }),
    tag: text('tag'),
    captionTemplateId: uuid('caption_template_id').references(() => captionTemplates.id, { onDelete: 'set null' }),
    /** `order` is reserved in SQL; the API still calls this field `order`. */
    pickOrder: text('pick_order').$type<DripOrder>().notNull().default('random'),
    avoidReuseDays: integer('avoid_reuse_days').notNull().default(30),
    lastPlannedDate: date('last_planned_date', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('drip_rules_device_idx').on(table.deviceUdid, table.account)]);

export const dripPlans = contentSchema.table('drip_plans', {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id').notNull().references(() => dripRules.id, { onDelete: 'cascade' }),
    /** Local date in the rule's timezone — the idempotency key for a planning run. */
    date: date('date', { mode: 'string' }).notNull(),
    scheduleId: uuid('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    itemId: uuid('item_id').notNull().references(() => contentItems.id, { onDelete: 'cascade' }),
    plannedFor: timestamp('planned_for', { withTimezone: true, mode: 'date' }).notNull(),
    /** Set once the item's used_count has been credited for this plan. */
    usedMarkedAt: timestamp('used_marked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    index('drip_plans_rule_date_idx').on(table.ruleId, table.date),
    index('drip_plans_schedule_idx').on(table.scheduleId),
]);

export type ContentItemRow = typeof contentItems.$inferSelect;
export type ContentSetRow = typeof contentSets.$inferSelect;
export type CaptionTemplateRow = typeof captionTemplates.$inferSelect;
export type DripRuleRow = typeof dripRules.$inferSelect;
export type DripPlanRow = typeof dripPlans.$inferSelect;
