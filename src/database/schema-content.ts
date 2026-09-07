import {
    boolean, date, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

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
/**
 * A set is either a pool the planner draws single posts from, or one ordered
 * slideshow posted whole. `content_set_items.position` already carries the
 * order, so a slideshow needs no table of its own — only this flag and the
 * slide it leads with.
 */
export type ContentSetKind = 'pool' | 'slideshow';
/** The `format` a drip rule will post. `any` is every format the pool happens to hold. */
export type DripFormat = 'any' | 'video' | 'photo' | 'slideshow';
/**
 * How a rule walks its pool. `fifo` drains never-used media first, then the least
 * recently used; `filename` is the operator's own order, taken from the uploaded
 * file's name, which is the only way to assemble a numbered slideshow correctly.
 */
export type DripOrder = 'random' | 'fifo' | 'filename';
/** The four networks an account can live on. `src/content/networks.ts` maps each to a plugin. */
export type PostNetwork = 'tiktok' | 'instagram' | 'youtube' | 'threads';
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
    kind: text('kind').$type<ContentSetKind>().notNull().default('pool'),
    /** Index into the set's ordered items of the slide the post leads with. */
    coverIndex: integer('cover_index').notNull().default(0),
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

/**
 * A creator is a person, and a person owns a phone: three TikToks, three
 * Instagrams and three YouTube channels signed in on the same handset. Rules
 * target the creator, the planner fans a post out over the accounts.
 *
 * `devices` do not live in Postgres — they are `devices.json` — so `device_udid`
 * is a plain string here, checked against the registry at plan time the same way
 * `drip_rules.device_udid` always was.
 */
export const creators = contentSchema.table('creators', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    deviceUdid: text('device_udid').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex('creators_name_idx').on(table.name),
    index('creators_device_idx').on(table.deviceUdid),
]);

/**
 * One signed-in account. The per-device handle list in `devices.json` still
 * works and is still what the phone's account switcher reads; these rows are the
 * addition that says *which network* a handle is on and *whose* it is.
 */
export const creatorAccounts = contentSchema.table('creator_accounts', {
    id: uuid('id').primaryKey().defaultRandom(),
    creatorId: uuid('creator_id').notNull().references(() => creators.id, { onDelete: 'cascade' }),
    network: text('network').$type<PostNetwork>().notNull(),
    handle: text('handle').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex('creator_accounts_handle_idx').on(table.creatorId, table.network, table.handle),
    index('creator_accounts_network_idx').on(table.network, table.handle),
]);

/**
 * Every time an item went out, and where.
 *
 * `content_items.used_count` / `last_used_at` stay as they were — the global
 * counters the library grid shows — but "never reuse inside N days" is a
 * question about *this account*: the same clip on three of a creator's TikToks
 * is three different feeds, and refusing the second one because the first
 * happened was the bug this table exists to fix.
 */
export const contentUses = contentSchema.table('content_uses', {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id').notNull().references(() => contentItems.id, { onDelete: 'cascade' }),
    network: text('network').$type<PostNetwork>().notNull(),
    handle: text('handle').notNull(),
    deviceUdid: text('device_udid'),
    scheduleId: uuid('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    executionId: uuid('execution_id'),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    index('content_uses_account_idx').on(table.itemId, table.network, table.handle, table.usedAt),
    index('content_uses_recent_idx').on(table.usedAt),
]);

/**
 * What one phone may do in a day, across every account and every rule on it.
 *
 * Rules do not know about each other, so six rules of two posts a day on one
 * handset is twelve posts through one app on one IP. The planner reads this row
 * before it commits any post and reports what the cap dropped.
 */
export const deviceLimits = contentSchema.table('device_limits', {
    deviceUdid: text('device_udid').primaryKey(),
    maxPostsPerDay: integer('max_posts_per_day').notNull().default(8),
    minMinutesBetweenPosts: integer('min_minutes_between_posts').notNull().default(30),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** What a phone with no `device_limits` row is held to. */
export const DEFAULT_DEVICE_LIMITS = { maxPostsPerDay: 8, minMinutesBetweenPosts: 30 } as const;

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
    /** Narrows the pool to one post format; `any` leaves it alone. */
    format: text('format').$type<DripFormat>().notNull().default('any'),
    setId: uuid('set_id').references(() => contentSets.id, { onDelete: 'set null' }),
    tag: text('tag'),
    captionTemplateId: uuid('caption_template_id').references(() => captionTemplates.id, { onDelete: 'set null' }),
    /** `order` is reserved in SQL; the API still calls this field `order`. */
    pickOrder: text('pick_order').$type<DripOrder>().notNull().default('random'),
    avoidReuseDays: integer('avoid_reuse_days').notNull().default(30),
    /**
     * The network `account` lives on. Every rule written before creators existed
     * was a TikTok rule, which is exactly what the default says.
     */
    network: text('network').$type<PostNetwork>().notNull().default('tiktok'),
    /**
     * Set instead of `account`: the rule posts each chosen item to every enabled
     * account this creator owns. `account` is still stored (the form keeps a
     * handle in it) but the planner ignores it once a creator is named.
     */
    creatorId: uuid('creator_id').references(() => creators.id, { onDelete: 'set null' }),
    /** Narrows a creator rule to these networks. Empty means every network the creator is on. */
    networks: text('networks').array().$type<PostNetwork[]>().notNull().default([]),
    /** Minutes between the copies of one item, so a fan-out never lands in the same minute. */
    crossPostGapMinutes: integer('cross_post_gap_minutes').notNull().default(20),
    /** Slides an auto-assembled slideshow carries. Only read by a `slideshow` rule over a tag. */
    slideSize: integer('slide_size').notNull().default(5),
    /**
     * Per-network caption templates, `{ instagram: "<uuid>", … }`. A JSON column
     * rather than a table: it is read and written whole with the rule, never
     * queried across rules, so a join table would buy nothing.
     */
    networkCaptions: jsonb('network_captions').$type<Partial<Record<PostNetwork, string>>>().notNull().default({}),
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
    /** Which account this copy went to. A creator rule writes one plan row set per target. */
    network: text('network').$type<PostNetwork>().notNull().default('tiktok'),
    account: text('account'),
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
export type CreatorRow = typeof creators.$inferSelect;
export type CreatorAccountRow = typeof creatorAccounts.$inferSelect;
export type ContentUseRow = typeof contentUses.$inferSelect;
export type DeviceLimitRow = typeof deviceLimits.$inferSelect;
export type DripPlanRow = typeof dripPlans.$inferSelect;
