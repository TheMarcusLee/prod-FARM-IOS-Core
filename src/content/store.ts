import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from '../database/schema.js';
import {
    assets, captionTemplates, contentItems, contentSetItems, contentSets, dripPlans, dripRules, executions, schedules,
    type CaptionTemplateRow, type ContentItemRow, type ContentSetRow, type DripPlanRow, type DripRuleRow,
} from '../database/schema.js';

export type ContentDatabase = NodePgDatabase<typeof schema>;

export interface NewAsset {
    relativePath: string;
    originalName: string;
    mimeType: string;
    size: number;
    sha256: string;
}

export interface ContentStore {
    insertAsset(asset: NewAsset): Promise<{ id: string }>;
    assetPath(assetId: string): Promise<{ relativePath: string; originalName: string; mimeType: string } | null>;
    listItems(filter?: { status?: string; tag?: string; limit?: number }): Promise<ContentItemRow[]>;
    item(id: string): Promise<ContentItemRow | null>;
    insertItem(values: typeof contentItems.$inferInsert): Promise<ContentItemRow>;
    updateItem(id: string, patch: Partial<typeof contentItems.$inferInsert>): Promise<ContentItemRow | null>;
    deleteItem(id: string): Promise<boolean>;
    listSets(): Promise<Array<ContentSetRow & { itemCount: number }>>;
    createSet(values: { name: string; notes?: string | null }): Promise<ContentSetRow>;
    deleteSet(id: string): Promise<boolean>;
    setItems(setId: string): Promise<ContentItemRow[]>;
    setSetItems(setId: string, itemIds: string[]): Promise<void>;
    listTemplates(): Promise<CaptionTemplateRow[]>;
    template(id: string): Promise<CaptionTemplateRow | null>;
    createTemplate(values: { name: string; template: string }): Promise<CaptionTemplateRow>;
    deleteTemplate(id: string): Promise<boolean>;
    listRules(): Promise<DripRuleRow[]>;
    rule(id: string): Promise<DripRuleRow | null>;
    createRule(values: typeof dripRules.$inferInsert): Promise<DripRuleRow>;
    updateRule(id: string, patch: Partial<typeof dripRules.$inferInsert>): Promise<DripRuleRow | null>;
    deleteRule(id: string): Promise<boolean>;
    candidateItems(rule: DripRuleRow, reuseCutoff: Date): Promise<ContentItemRow[]>;
    plansForDates(ruleId: string, dates: string[]): Promise<DripPlanRow[]>;
    upcomingPlans(ruleId?: string, limit?: number): Promise<Array<DripPlanRow & { status: string | null }>>;
    insertPlan(values: typeof dripPlans.$inferInsert): Promise<DripPlanRow>;
    unstartedScheduleIds(ruleId: string): Promise<string[]>;
    succeededUnmarkedPlans(): Promise<DripPlanRow[]>;
    markPlanUsed(planId: string, itemId: string, at: Date): Promise<void>;
}

function rowsOrNull<T>(rows: T[]): T | null {
    return rows[0] ?? null;
}

/** Plain functions over one Drizzle handle — no ORM classes, no repository hierarchy. */
export function createContentStore(db: ContentDatabase): ContentStore {
    return {
        async insertAsset(asset) {
            const [row] = await db.insert(assets).values(asset).returning({ id: assets.id });
            if (!row) throw new Error('Unable to register asset');
            return row;
        },
        async assetPath(assetId) {
            const [row] = await db.select({
                relativePath: assets.relativePath, originalName: assets.originalName, mimeType: assets.mimeType,
            }).from(assets).where(eq(assets.id, assetId)).limit(1);
            return row ?? null;
        },
        async listItems(filter = {}) {
            const conditions = [
                ...(filter.status ? [eq(contentItems.status, filter.status as ContentItemRow['status'])] : []),
                ...(filter.tag ? [sql`${contentItems.tags} @> ARRAY[${filter.tag}]::text[]`] : []),
            ];
            const query = db.select().from(contentItems);
            const filtered = conditions.length ? query.where(and(...conditions)) : query;
            return filtered.orderBy(desc(contentItems.createdAt)).limit(filter.limit ?? 200);
        },
        async item(id) {
            return rowsOrNull(await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1));
        },
        async insertItem(values) {
            const [row] = await db.insert(contentItems).values(values).returning();
            if (!row) throw new Error('Unable to create content item');
            return row;
        },
        async updateItem(id, patch) {
            const [row] = await db.update(contentItems).set(patch).where(eq(contentItems.id, id)).returning();
            return row ?? null;
        },
        async deleteItem(id) {
            const rows = await db.delete(contentItems).where(eq(contentItems.id, id)).returning({ id: contentItems.id });
            return rows.length > 0;
        },
        async listSets() {
            const sets = await db.select().from(contentSets).orderBy(asc(contentSets.name));
            if (!sets.length) return [];
            const counts = await db.select({ setId: contentSetItems.setId, count: sql<number>`count(*)::int` })
                .from(contentSetItems).groupBy(contentSetItems.setId);
            const byId = new Map(counts.map((row) => [row.setId, row.count]));
            return sets.map((set) => ({ ...set, itemCount: byId.get(set.id) ?? 0 }));
        },
        async createSet(values) {
            const [row] = await db.insert(contentSets).values(values).returning();
            if (!row) throw new Error('Unable to create set');
            return row;
        },
        async deleteSet(id) {
            const rows = await db.delete(contentSets).where(eq(contentSets.id, id)).returning({ id: contentSets.id });
            return rows.length > 0;
        },
        async setItems(setId) {
            const rows = await db.select({ item: contentItems }).from(contentSetItems)
                .innerJoin(contentItems, eq(contentItems.id, contentSetItems.itemId))
                .where(eq(contentSetItems.setId, setId))
                .orderBy(asc(contentSetItems.position));
            return rows.map(({ item }) => item);
        },
        async setSetItems(setId, itemIds) {
            await db.transaction(async (tx) => {
                await tx.delete(contentSetItems).where(eq(contentSetItems.setId, setId));
                if (!itemIds.length) return;
                await tx.insert(contentSetItems).values(itemIds.map((itemId, position) => ({ setId, itemId, position })));
            });
        },
        async listTemplates() {
            return db.select().from(captionTemplates).orderBy(asc(captionTemplates.name));
        },
        async template(id) {
            return rowsOrNull(await db.select().from(captionTemplates).where(eq(captionTemplates.id, id)).limit(1));
        },
        async createTemplate(values) {
            const [row] = await db.insert(captionTemplates).values(values).returning();
            if (!row) throw new Error('Unable to create caption template');
            return row;
        },
        async deleteTemplate(id) {
            const rows = await db.delete(captionTemplates).where(eq(captionTemplates.id, id))
                .returning({ id: captionTemplates.id });
            return rows.length > 0;
        },
        async listRules() {
            return db.select().from(dripRules).orderBy(asc(dripRules.deviceUdid), asc(dripRules.account));
        },
        async rule(id) {
            return rowsOrNull(await db.select().from(dripRules).where(eq(dripRules.id, id)).limit(1));
        },
        async createRule(values) {
            const [row] = await db.insert(dripRules).values(values).returning();
            if (!row) throw new Error('Unable to create drip rule');
            return row;
        },
        async updateRule(id, patch) {
            const [row] = await db.update(dripRules).set({ ...patch, updatedAt: new Date() })
                .where(eq(dripRules.id, id)).returning();
            return row ?? null;
        },
        async deleteRule(id) {
            const rows = await db.delete(dripRules).where(eq(dripRules.id, id)).returning({ id: dripRules.id });
            return rows.length > 0;
        },
        async candidateItems(rule, reuseCutoff) {
            const fresh = or(isNull(contentItems.lastUsedAt), sql`${contentItems.lastUsedAt} < ${reuseCutoff}`);
            if (rule.source === 'set') {
                if (!rule.setId) return [];
                const rows = await db.select({ item: contentItems, position: contentSetItems.position })
                    .from(contentSetItems)
                    .innerJoin(contentItems, eq(contentItems.id, contentSetItems.itemId))
                    .where(and(eq(contentSetItems.setId, rule.setId), eq(contentItems.status, 'ready'), fresh))
                    .orderBy(asc(contentSetItems.position));
                return rows.map(({ item }) => item);
            }
            if (!rule.tag) return [];
            return db.select().from(contentItems).where(and(
                eq(contentItems.status, 'ready'),
                sql`${contentItems.tags} @> ARRAY[${rule.tag}]::text[]`,
                fresh,
            )).orderBy(asc(contentItems.createdAt));
        },
        async plansForDates(ruleId, dates) {
            if (!dates.length) return [];
            return db.select().from(dripPlans)
                .where(and(eq(dripPlans.ruleId, ruleId), inArray(dripPlans.date, dates)));
        },
        async upcomingPlans(ruleId, limit = 50) {
            const rows = await db.select({ plan: dripPlans, status: schedules.status })
                .from(dripPlans)
                .leftJoin(schedules, eq(schedules.id, dripPlans.scheduleId))
                .where(ruleId ? eq(dripPlans.ruleId, ruleId) : gte(dripPlans.plannedFor, new Date(0)))
                .orderBy(asc(dripPlans.plannedFor))
                .limit(limit);
            return rows.map(({ plan, status }) => ({ ...plan, status }));
        },
        async insertPlan(values) {
            const [row] = await db.insert(dripPlans).values(values).returning();
            if (!row) throw new Error('Unable to record drip plan');
            return row;
        },
        async unstartedScheduleIds(ruleId) {
            const rows = await db.select({ id: schedules.id }).from(dripPlans)
                .innerJoin(schedules, eq(schedules.id, dripPlans.scheduleId))
                .where(and(eq(dripPlans.ruleId, ruleId), inArray(schedules.status, ['active', 'paused'])));
            return rows.map(({ id }) => id);
        },
        async succeededUnmarkedPlans() {
            const rows = await db.selectDistinctOn([dripPlans.id], { plan: dripPlans }).from(dripPlans)
                .innerJoin(executions, eq(executions.scheduleId, dripPlans.scheduleId))
                .where(and(isNull(dripPlans.usedMarkedAt), eq(executions.status, 'succeeded')));
            return rows.map(({ plan }) => plan);
        },
        async markPlanUsed(planId, itemId, at) {
            await db.transaction(async (tx) => {
                await tx.update(dripPlans).set({ usedMarkedAt: at }).where(eq(dripPlans.id, planId));
                await tx.update(contentItems).set({
                    usedCount: sql`${contentItems.usedCount} + 1`, lastUsedAt: at,
                }).where(eq(contentItems.id, itemId));
            });
        },
    };
}
