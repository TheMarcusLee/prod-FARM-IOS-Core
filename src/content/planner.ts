import type { ContentItemRow, DripPlanRow, DripRuleRow } from '../database/schema.js';
import { clampCaption, renderCaptionTemplate } from './templates.js';
import { addDays, localDate, windowForDate } from './time.js';

const MINUTE_MS = 60_000;

/** One post's worth of media: a single clip, or 1–3 images making a slideshow. */
export type ContentGroup = ContentItemRow[];

/**
 * Random posting times inside a window, never closer together than
 * `minGapMinutes` and never outside the window.
 *
 * `n` draws are taken, sorted, scaled across the slack the window has left once
 * every mandatory gap is reserved, then each gap is added back. That keeps the
 * times uniformly spread *and* legal, which rejection sampling would not
 * guarantee in a tight window. Offsets are floored to whole minutes, which can
 * only widen a gap, never narrow one.
 */
export function chooseTimes(
    window: { start: Date; end: Date },
    count: number,
    minGapMinutes: number,
    random: () => number,
    notBefore?: Date,
): Date[] {
    const startMs = Math.ceil(Math.max(window.start.getTime(), notBefore?.getTime() ?? 0) / MINUTE_MS) * MINUTE_MS;
    const span = window.end.getTime() - startMs;
    if (!Number.isFinite(span) || span < 0 || count < 1) return [];
    const gap = Math.max(0, Math.round(minGapMinutes)) * MINUTE_MS;
    const fits = gap > 0 ? Math.floor(span / gap) + 1 : count;
    const total = Math.max(0, Math.min(count, fits));
    if (!total) return [];
    const slack = span - (total - 1) * gap;
    const draws = Array.from({ length: total }, () => Math.min(1, Math.max(0, random())) * slack)
        .map((value) => Math.floor(value / MINUTE_MS) * MINUTE_MS)
        .sort((a, b) => a - b);
    return draws.map((offset, index) => new Date(startMs + offset + index * gap));
}

function shuffle<T>(values: T[], random: () => number): T[] {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.min(index, Math.floor(random() * (index + 1)));
        [copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T];
    }
    return copy;
}

function groupSortKey(group: ContentGroup): [number, number] {
    const lastUsed = Math.min(...group.map((item) => item.lastUsedAt?.getTime() ?? 0));
    const created = Math.min(...group.map((item) => item.createdAt.getTime()));
    return [lastUsed, created];
}

/** `fifo` drains never-used media first, then the least recently used. */
export function orderCandidates(
    groups: ContentGroup[],
    order: DripRuleRow['pickOrder'],
    random: () => number,
): ContentGroup[] {
    if (order === 'random') return shuffle(groups, random);
    return [...groups].sort((a, b) => {
        const [leftUsed, leftCreated] = groupSortKey(a);
        const [rightUsed, rightCreated] = groupSortKey(b);
        return leftUsed - rightUsed || leftCreated - rightCreated;
    });
}

export interface PlannedPost {
    rule: DripRuleRow;
    items: ContentGroup;
    date: string;
    runAt: Date;
    caption?: string;
}

export interface PlannerPorts {
    now: Date;
    random: () => number;
    /** Days ahead to plan, counting today. Defaults to 2 (today and tomorrow). */
    horizonDays?: number;
    rules(): Promise<DripRuleRow[]>;
    /** Postable groups for the rule, already filtered by status and reuse age. */
    candidates(rule: DripRuleRow, reuseCutoff: Date): Promise<ContentGroup[]>;
    plansForDates(ruleId: string, dates: string[]): Promise<DripPlanRow[]>;
    captionTemplate(id: string): Promise<{ template: string } | null>;
    /** Creates the real `once` schedule; returns its id, or null when it was rejected. */
    createPost(post: PlannedPost): Promise<{ scheduleId: string } | null>;
    recordPlan(post: PlannedPost, scheduleId: string): Promise<void>;
    markRulePlanned(ruleId: string, date: string): Promise<void>;
    /** A disabled rule releases the schedules it planned that have not started. */
    cancelRuleSchedules(ruleId: string): Promise<number>;
}

export interface PlanReport {
    rulesConsidered: number;
    planned: number;
    cancelled: number;
    skipped: string[];
}

function captionFor(
    group: ContentGroup,
    template: string | null,
    rule: DripRuleRow,
    random: () => number,
    date: string,
): string | undefined {
    const lead = group[0];
    if (!template) return lead?.caption?.trim() || undefined;
    const rendered = renderCaptionTemplate(template, {
        title: lead?.caption ?? '',
        hashtags: group.flatMap((item) => item.hashtags),
        account: rule.account,
        date,
    }, random);
    return rendered ? clampCaption(rendered) : undefined;
}

/**
 * Plans every enabled rule for today and tomorrow in the rule's own timezone.
 * A date that already has `drip_plans` rows is left alone, so the hourly tick
 * and a manual POST /api/drip/plan converge on the same queue instead of
 * doubling it.
 */
export async function planDripRules(ports: PlannerPorts): Promise<PlanReport> {
    const report: PlanReport = { rulesConsidered: 0, planned: 0, cancelled: 0, skipped: [] };
    const horizon = Math.max(1, ports.horizonDays ?? 2);
    for (const rule of await ports.rules()) {
        report.rulesConsidered += 1;
        if (!rule.enabled) {
            report.cancelled += await ports.cancelRuleSchedules(rule.id);
            continue;
        }
        const today = localDate(ports.now, rule.timezone);
        const dates = Array.from({ length: horizon }, (_, offset) => addDays(today, offset));
        const alreadyPlanned = new Set((await ports.plansForDates(rule.id, dates)).map((plan) => plan.date));
        const open = dates.filter((date) => !alreadyPlanned.has(date));
        if (!open.length) continue;

        const reuseCutoff = new Date(ports.now.getTime() - Math.max(0, rule.avoidReuseDays) * 86_400_000);
        const pool = orderCandidates(await ports.candidates(rule, reuseCutoff), rule.pickOrder, ports.random);
        const template = rule.captionTemplateId
            ? (await ports.captionTemplate(rule.captionTemplateId))?.template ?? null
            : null;
        let cursor = 0;

        for (const date of open) {
            const window = windowForDate(date, rule.windowStart, rule.windowEnd, rule.timezone);
            const times = chooseTimes(window, rule.postsPerDay, rule.minGapMinutes, ports.random, ports.now);
            if (!times.length) {
                // The window for this date has already closed; recording it keeps
                // the next tick from re-deciding the same thing every hour.
                if (window.end <= ports.now) await ports.markRulePlanned(rule.id, date);
                continue;
            }
            if (cursor >= pool.length) {
                report.skipped.push(`${rule.id}: no unused content matches this rule`);
                break;
            }
            let created = 0;
            for (const runAt of times) {
                const group = pool[cursor];
                if (!group) break;
                cursor += 1;
                const caption = captionFor(group, template, rule, ports.random, date);
                const post: PlannedPost = { rule, items: group, date, runAt, ...(caption ? { caption } : {}) };
                const result = await ports.createPost(post);
                if (!result) continue;
                await ports.recordPlan(post, result.scheduleId);
                created += 1;
            }
            report.planned += created;
            if (created) await ports.markRulePlanned(rule.id, date);
        }
    }
    return report;
}
