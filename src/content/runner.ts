import crypto from 'node:crypto';
import { copyFile, link, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { loadRegisteredDevices } from '../devices/registry.js';
import type { SchedulerRepository } from '../scheduler/repository.js';
import type { ContentItemRow, DripRuleRow } from '../database/schema.js';
import type { JsonObject } from '../types.js';
import { dataRoot } from './paths.js';
import { planDripRules, type ContentGroup, type PlanReport, type PlannedPost, type PlannerPorts } from './planner.js';
import type { ContentStore } from './store.js';

export const TIKTOK_PLUGIN_ID = 'com.git-agni.tiktok';

export interface DripRunnerOptions {
    store: ContentStore;
    scheduler: SchedulerRepository;
    now?: Date;
    random?: () => number;
    horizonDays?: number;
}

/**
 * A set of one to three images is one slideshow post; anything else in a set is
 * a pool of individual posts. A partially reusable slideshow is skipped rather
 * than posted incomplete.
 */
export async function candidateGroups(
    store: ContentStore,
    rule: DripRuleRow,
    reuseCutoff: Date,
): Promise<ContentGroup[]> {
    const available = await store.candidateItems(rule, reuseCutoff);
    if (rule.source === 'set' && rule.setId) {
        const members = await store.setItems(rule.setId);
        const slideshow = members.length >= 1 && members.length <= 3
            && members.every((item) => item.kind === 'image' && item.status === 'ready');
        if (slideshow) {
            const ready = new Set(available.map((item) => item.id));
            return members.every((item) => ready.has(item.id)) ? [members] : [];
        }
    }
    return available.map((item) => [item]);
}

/**
 * The scheduler deletes a one-off schedule's assets once it succeeds, so a post
 * never points at the library master. Each planned post gets its own assets row
 * backed by a hard link to the same bytes — the purge unlinks the copy and the
 * library keeps its file.
 */
async function linkPostAsset(store: ContentStore, item: ContentItemRow): Promise<{
    assetId: string; name: string; mimeType: string;
}> {
    const source = await store.assetPath(item.assetId);
    if (!source) throw new Error(`Content item ${item.id} has no stored file`);
    const root = dataRoot();
    const absoluteSource = path.resolve(root, source.relativePath);
    const relativePath = path.join('content', 'posts', crypto.randomUUID());
    const absoluteTarget = path.join(root, relativePath);
    await mkdir(path.dirname(absoluteTarget), { recursive: true });
    try {
        await link(absoluteSource, absoluteTarget);
    } catch {
        await copyFile(absoluteSource, absoluteTarget);
    }
    const { size } = await stat(absoluteTarget);
    const { id } = await store.insertAsset({
        relativePath, originalName: source.originalName, mimeType: source.mimeType, size, sha256: item.sha256,
    });
    return { assetId: id, name: source.originalName, mimeType: source.mimeType };
}

async function devicePluginData(deviceUdid: string): Promise<JsonObject | null> {
    const device = (await loadRegisteredDevices()).find(({ udid }) => udid === deviceUdid);
    if (!device || device.disabled) return null;
    return device.pluginData[TIKTOK_PLUGIN_ID] ?? {};
}

/**
 * Builds the planner's ports over the real store, scheduler and filesystem.
 * Exported so a test can swap individual ports without a database.
 */
export function dripPorts(options: DripRunnerOptions): { ports: PlannerPorts; skipped: string[] } {
    const { store, scheduler } = options;
    const now = options.now ?? new Date();
    const skipped: string[] = [];
    const ports: PlannerPorts = {
        now,
        random: options.random ?? Math.random,
        ...(options.horizonDays === undefined ? {} : { horizonDays: options.horizonDays }),
        rules: () => store.listRules(),
        candidates: (rule, reuseCutoff) => candidateGroups(store, rule, reuseCutoff),
        plansForDates: (ruleId, dates) => store.plansForDates(ruleId, dates),
        captionTemplate: (id) => store.template(id),
        async createPost(post: PlannedPost) {
            const pluginData = await devicePluginData(post.rule.deviceUdid);
            if (!pluginData) {
                skipped.push(`${post.rule.id}: device ${post.rule.deviceUdid} is not registered or is disabled`);
                return null;
            }
            const media = [] as Array<{ assetId: string; name: string; mimeType: string }>;
            try {
                for (const item of post.items) media.push(await linkPostAsset(store, item));
                const schedule = await scheduler.createTask({
                    deviceUdid: post.rule.deviceUdid,
                    task: {
                        pluginId: TIKTOK_PLUGIN_ID, taskType: 'post', taskVersion: 1,
                        payload: {
                            media, destination: post.rule.destination, account: post.rule.account,
                            ...(post.caption ? { caption: post.caption } : {}),
                        },
                    },
                    // Always `once`. A recurring publish is what the plugin makes
                    // you confirm; the drip queue plans discrete posts instead.
                    timing: { kind: 'once', runAt: post.runAt.toISOString() },
                }, pluginData, now, media.map(({ assetId }) => assetId));
                return { scheduleId: schedule.id };
            } catch (error) {
                if (media.length) await scheduler.deleteAssets(media.map(({ assetId }) => assetId));
                skipped.push(`${post.rule.id}: ${error instanceof Error ? error.message : String(error)}`);
                return null;
            }
        },
        async recordPlan(post, scheduleId) {
            for (const item of post.items) {
                await store.insertPlan({
                    ruleId: post.rule.id, date: post.date, scheduleId, itemId: item.id, plannedFor: post.runAt,
                });
            }
        },
        async markRulePlanned(ruleId, date) {
            await store.updateRule(ruleId, { lastPlannedDate: date });
        },
        async cancelRuleSchedules(ruleId) {
            let cancelled = 0;
            for (const id of await store.unstartedScheduleIds(ruleId)) {
                try {
                    await scheduler.setScheduleStatus(id, 'cancelled');
                    cancelled += 1;
                } catch { /* already terminal */ }
            }
            return cancelled;
        },
    };
    return { ports, skipped };
}

/**
 * Credits `used_count` only once an execution actually succeeded. Polling the
 * executions table keeps the coupling to the scheduler at one read, instead of
 * a callback the worker process would have to know about.
 */
export async function reconcileUsage(store: ContentStore, now = new Date()): Promise<number> {
    const plans = await store.succeededUnmarkedPlans();
    for (const plan of plans) await store.markPlanUsed(plan.id, plan.itemId, now);
    return plans.length;
}

export async function runDripPlanner(options: DripRunnerOptions): Promise<PlanReport> {
    const { ports, skipped } = dripPorts(options);
    const report = await planDripRules(ports);
    report.skipped.push(...skipped);
    await reconcileUsage(options.store, options.now ?? new Date());
    return report;
}
