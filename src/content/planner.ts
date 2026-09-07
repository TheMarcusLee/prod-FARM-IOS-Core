import type { DripFormat, DripPlanRow, DripRuleRow } from '../database/schema.js';
import type { PostFormat } from './formats.js';
import { formatProblemFor, networkLabel, type NetworkId } from './networks.js';
import type { CandidateItem, DeviceLimits, DeviceLoadRow, PostTarget } from './store.js';
import { clampCaption, renderCaptionTemplate } from './templates.js';
import { addDays, isTimeZone, localDate, windowForDate } from './time.js';

const MINUTE_MS = 60_000;

/** One post's worth of media: a single clip, a single image, or the ordered slides of a slideshow. */
export type ContentGroup = CandidateItem[];

/**
 * What a group of library items posts as. It mirrors `inferFormat` in
 * `./formats.js`, which reads MIME types; here the items already carry the
 * `kind` ingest decided, so there is nothing to parse. A group that is neither
 * all video nor all image has no format and is never planned.
 */
export function groupFormat(group: ContentGroup): PostFormat | null {
    if (!group.length) return null;
    if (group.every((item) => item.kind === 'video')) return group.length === 1 ? 'video' : null;
    if (group.every((item) => item.kind === 'image')) return group.length === 1 ? 'photo' : 'slideshow';
    return null;
}

/** A rule set to `any` takes whatever the pool holds; anything else narrows it to one format. */
export function matchesFormat(group: ContentGroup, filter: DripFormat): boolean {
    const format = groupFormat(group);
    if (!format) return false;
    return filter === 'any' || filter === format;
}

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

/**
 * `fifo` drains never-used media first, then the least recently used.
 * `filename` is the operator's own order — the uploaded file's name, compared
 * naturally so `slide-2` sorts before `slide-10`. That is the only ordering that
 * assembles a numbered slideshow the way it was numbered.
 */
export function orderCandidates(
    groups: ContentGroup[],
    order: DripRuleRow['pickOrder'],
    random: () => number,
): ContentGroup[] {
    if (order === 'random') return shuffle(groups, random);
    if (order === 'filename') {
        return [...groups].sort((a, b) => compareNames(groupName(a), groupName(b)));
    }
    return [...groups].sort((a, b) => {
        const [leftUsed, leftCreated] = groupSortKey(a);
        const [rightUsed, rightCreated] = groupSortKey(b);
        return leftUsed - rightUsed || leftCreated - rightCreated;
    });
}

function groupName(group: ContentGroup): string {
    return group[0]?.sortName ?? group[0]?.id ?? '';
}

const NAMES = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function compareNames(left: string, right: string): number {
    return NAMES.compare(left, right);
}

/** The same ordering over loose items, for assembling a slideshow out of a tag. */
export function orderItems(
    items: readonly CandidateItem[],
    order: DripRuleRow['pickOrder'],
    random: () => number,
): CandidateItem[] {
    return orderCandidates(items.map((item) => [item]), order, random).map((group) => group[0] as CandidateItem);
}

export interface PlannedPost {
    rule: DripRuleRow;
    items: ContentGroup;
    /** Decided from the items, never from the rule: the rule only filters. */
    format: PostFormat;
    /** The account this copy goes to. An account rule has exactly one; a creator rule has several. */
    target: PostTarget;
    date: string;
    runAt: Date;
    caption?: string;
    /**
     * 0 for the first copy of an item, 1 for the next account it is cross-posted
     * to, and so on. The runner uses it to record an assembled slideshow set once
     * rather than once per account.
     */
    copyIndex: number;
}

export interface PlannerPorts {
    now: Date;
    random: () => number;
    /** Days ahead to plan, counting today. Defaults to 2 (today and tomorrow). */
    horizonDays?: number;
    rules(): Promise<DripRuleRow[]>;
    /**
     * The accounts this rule posts to: one for an account rule, every enabled
     * account of the creator (optionally narrowed by `networks`) for a creator
     * rule. An empty list is a rule with nowhere to post, and is reported.
     */
    targets(rule: DripRuleRow): Promise<PostTarget[]>;
    /** Postable groups for the rule, already filtered by status and per-account reuse age. */
    candidates(rule: DripRuleRow, reuseCutoff: Date, targets: readonly PostTarget[]): Promise<ContentGroup[]>;
    plansForDates(ruleId: string, dates: string[]): Promise<DripPlanRow[]>;
    captionTemplate(id: string): Promise<{ template: string } | null>;
    /** What this phone may do in a day across every rule on it. */
    deviceLimits(deviceUdid: string): Promise<DeviceLimits>;
    /** Posts already planned on this phone for these dates, by any rule. */
    deviceLoad(deviceUdid: string, dates: readonly string[]): Promise<DeviceLoadRow[]>;
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
    handle: string,
    random: () => number,
    date: string,
): string | undefined {
    const lead = group[0];
    if (!template) return lead?.caption?.trim() || undefined;
    const rendered = renderCaptionTemplate(template, {
        title: lead?.caption ?? '',
        hashtags: group.flatMap((item) => item.hashtags),
        account: handle,
        date,
    }, random);
    return rendered ? clampCaption(rendered) : undefined;
}

/**
 * The phone's own ledger for one planning run: what is already on it, plus what
 * this run has committed. Rules do not know about each other, so without this a
 * handset with six rules of two posts a day quietly does twelve posts through
 * four apps on one IP — which is the shape of a ban, not of a farm.
 */
class DeviceBudget {
    private readonly perDate = new Map<string, number>();
    private readonly times: number[] = [];

    constructor(private readonly limits: DeviceLimits, load: readonly DeviceLoadRow[]) {
        for (const row of load) this.commit(row.date, row.plannedFor);
    }

    /** Why this time is not allowed on this phone, or undefined when it is. */
    refuse(date: string, at: Date): string | undefined {
        if ((this.perDate.get(date) ?? 0) >= this.limits.maxPostsPerDay) {
            return `${date} is already at this phone's ${this.limits.maxPostsPerDay} posts a day`;
        }
        const gap = this.limits.minMinutesBetweenPosts * MINUTE_MS;
        if (gap > 0 && this.times.some((time) => Math.abs(time - at.getTime()) < gap)) {
            return `${at.toISOString().slice(11, 16)} UTC is inside this phone's ${this.limits.minMinutesBetweenPosts}-minute gap`;
        }
        return undefined;
    }

    commit(date: string, at: Date): void {
        this.perDate.set(date, (this.perDate.get(date) ?? 0) + 1);
        this.times.push(at.getTime());
    }
}

/** The templates a rule renders with: its own, plus any per-network override. */
async function templatesFor(
    rule: DripRuleRow,
    ports: PlannerPorts,
): Promise<{ base: string | null; byNetwork: Partial<Record<NetworkId, string>> }> {
    const base = rule.captionTemplateId
        ? (await ports.captionTemplate(rule.captionTemplateId))?.template ?? null
        : null;
    const byNetwork: Partial<Record<NetworkId, string>> = {};
    for (const [network, id] of Object.entries(rule.networkCaptions ?? {})) {
        if (typeof id !== 'string' || !id) continue;
        const template = (await ports.captionTemplate(id))?.template;
        if (template) byNetwork[network as NetworkId] = template;
    }
    return { base, byNetwork };
}

/**
 * Plans every enabled rule for today and tomorrow in the rule's own timezone.
 * A date that already has `drip_plans` rows is left alone, so the hourly tick
 * and a manual POST /api/drip/plan converge on the same queue instead of
 * doubling it.
 *
 * A creator rule posts each chosen item to every one of that creator's enabled
 * accounts, staggered by `crossPostGapMinutes` so no two copies land in the same
 * minute, and each copy is checked against its own network's format table first:
 * a 35-slide TikTok slideshow is *refused* for Instagram's 20 and said so in the
 * report, never silently truncated into a different post.
 */
export async function planDripRules(ports: PlannerPorts): Promise<PlanReport> {
    const report: PlanReport = { rulesConsidered: 0, planned: 0, cancelled: 0, skipped: [] };
    const horizon = Math.max(1, ports.horizonDays ?? 2);
    // One budget per phone for the whole run, so rule six sees what rule one took.
    const budgets = new Map<string, DeviceBudget>();
    for (const rule of await ports.rules()) {
        report.rulesConsidered += 1;
        if (!rule.enabled) {
            report.cancelled += await ports.cancelRuleSchedules(rule.id);
            continue;
        }
        // A zone the API accepted can still be unknown here: a restored dump, a
        // hand-edited row, or an ICU build without it. Reading the wall clock
        // would throw and take every *other* rule's planning down with it.
        if (!isTimeZone(rule.timezone)) {
            report.skipped.push(`${rule.id}: "${rule.timezone}" is not a time zone this host knows`);
            continue;
        }
        const today = localDate(ports.now, rule.timezone);
        const dates = Array.from({ length: horizon }, (_, offset) => addDays(today, offset));
        const alreadyPlanned = new Set((await ports.plansForDates(rule.id, dates)).map((plan) => plan.date));
        const open = dates.filter((date) => !alreadyPlanned.has(date));
        if (!open.length) continue;

        const targets = await ports.targets(rule);
        if (!targets.length) {
            report.skipped.push(`${rule.id}: no enabled account to post to`);
            continue;
        }

        const reuseCutoff = new Date(ports.now.getTime() - Math.max(0, rule.avoidReuseDays) * 86_400_000);
        const available = (await ports.candidates(rule, reuseCutoff, targets))
            .filter((group) => matchesFormat(group, rule.format));
        if (!available.length && rule.format !== 'any') {
            report.skipped.push(`${rule.id}: no unused ${rule.format} content matches this rule`);
            continue;
        }
        const pool = orderCandidates(available, rule.pickOrder, ports.random);
        const { base, byNetwork } = await templatesFor(rule, ports);

        let budget = budgets.get(rule.deviceUdid);
        if (!budget) {
            budget = new DeviceBudget(await ports.deviceLimits(rule.deviceUdid), await ports.deviceLoad(rule.deviceUdid, dates));
            budgets.set(rule.deviceUdid, budget);
        }
        const stagger = Math.max(1, rule.crossPostGapMinutes) * MINUTE_MS;
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
            let exhausted = false;
            for (const runAt of times) {
                const group = pool[cursor];
                if (!group) { exhausted = true; break; }
                cursor += 1;
                const format = groupFormat(group);
                // `matchesFormat` already dropped anything unpostable; this keeps
                // the type honest rather than asserting it away.
                if (!format) continue;
                for (const [copyIndex, target] of targets.entries()) {
                    // Each copy is checked against its own network's table. A
                    // slideshow that is legal on TikTok and too long for
                    // Instagram is dropped *for Instagram*, by name.
                    const problem = formatProblemFor(target.network, format, group.length);
                    if (problem) {
                        report.skipped.push(
                            `${rule.id}: ${target.handle} on ${networkLabel(target.network)} did not get this ${format} — ${problem}`,
                        );
                        continue;
                    }
                    const copyAt = new Date(runAt.getTime() + copyIndex * stagger);
                    if (copyAt > window.end) {
                        report.skipped.push(
                            `${rule.id}: ${target.handle} on ${networkLabel(target.network)} fell outside the window once staggered by ${rule.crossPostGapMinutes} minutes`,
                        );
                        continue;
                    }
                    const refused = budget.refuse(date, copyAt);
                    if (refused) {
                        report.skipped.push(`${rule.id}: dropped a post for ${target.handle} — ${refused}`);
                        continue;
                    }
                    const template = byNetwork[target.network] ?? base;
                    const caption = captionFor(group, template, rule, target.handle, ports.random, date);
                    const post: PlannedPost = {
                        rule, items: group, format, target, date, runAt: copyAt, copyIndex,
                        ...(caption ? { caption } : {}),
                    };
                    const result = await ports.createPost(post);
                    if (!result) continue;
                    await ports.recordPlan(post, result.scheduleId);
                    budget.commit(date, copyAt);
                    created += 1;
                }
            }
            report.planned += created;
            if (created) await ports.markRulePlanned(rule.id, date);
            if (exhausted) {
                // The day is recorded with fewer posts than the rule asks for.
                // Say so: silently under-posting for weeks is the failure mode
                // an unattended farm actually has.
                report.skipped.push(
                    `${rule.id}: ran out of unused content on ${date} after ${created} of ${times.length * targets.length} posts`,
                );
                break;
            }
        }
    }
    return report;
}
