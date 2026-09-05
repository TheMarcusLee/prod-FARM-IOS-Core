import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContentItemRow, DripPlanRow, DripRuleRow } from '../src/database/schema.js';
import { chooseTimes, orderCandidates, planDripRules, type PlannedPost, type PlannerPorts } from '../src/content/planner.js';
import { localDate, windowForDate, zonedTimeToUtc } from '../src/content/time.js';

/** A tiny seeded generator so every assertion below is reproducible. */
function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function rule(overrides: Partial<DripRuleRow> = {}): DripRuleRow {
    return {
        id: 'rule-1', deviceUdid: 'device-1', account: '@handle', enabled: true,
        postsPerDay: 3, windowStart: '09:00', windowEnd: '21:00', timezone: 'UTC',
        minGapMinutes: 120, destination: 'draft', source: 'tag', setId: null, tag: 'fitness',
        captionTemplateId: null, pickOrder: 'random', avoidReuseDays: 30, lastPlannedDate: null,
        createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    };
}

function item(id: string, overrides: Partial<ContentItemRow> = {}): ContentItemRow {
    return {
        id, assetId: `asset-${id}`, originalAssetId: null, kind: 'video', durationMs: 15_000,
        width: 1080, height: 1920, normalized: true, sha256: 'x', tags: ['fitness'], caption: `Clip ${id}`,
        hashtags: ['fyp'], posterPath: null, createdAt: new Date('2026-01-01T00:00:00Z'),
        usedCount: 0, lastUsedAt: null, status: 'ready', error: null,
        ...overrides,
    };
}

interface Recorded { post: PlannedPost; scheduleId: string }

function ports(overrides: Partial<PlannerPorts> & { pool?: ContentItemRow[] } = {}) {
    const plans: DripPlanRow[] = [];
    const created: Recorded[] = [];
    const cutoffs: Date[] = [];
    const markedDates: string[] = [];
    let counter = 0;
    const pool = overrides.pool ?? [item('a'), item('b'), item('c'), item('d'), item('e'), item('f')];
    const base: PlannerPorts = {
        now: new Date('2026-03-10T08:00:00Z'),
        random: seeded(7),
        rules: async () => [rule()],
        async candidates(_rule, cutoff) { cutoffs.push(cutoff); return pool.map((entry) => [entry]); },
        async plansForDates(ruleId, dates) {
            return plans.filter((plan) => plan.ruleId === ruleId && dates.includes(plan.date));
        },
        async captionTemplate() { return null; },
        async createPost(post) { counter += 1; created.push({ post, scheduleId: `schedule-${counter}` }); return { scheduleId: `schedule-${counter}` }; },
        async recordPlan(post, scheduleId) {
            for (const entry of post.items) {
                plans.push({
                    id: `plan-${plans.length + 1}`, ruleId: post.rule.id, date: post.date, scheduleId,
                    itemId: entry.id, plannedFor: post.runAt, usedMarkedAt: null, createdAt: new Date(),
                } as DripPlanRow);
            }
        },
        async markRulePlanned(_ruleId, date) { markedDates.push(date); },
        async cancelRuleSchedules() { return 0; },
        ...overrides,
    };
    return { ports: base, plans, created, cutoffs, markedDates };
}

test('chooseTimes keeps every post inside the window and at least the gap apart', () => {
    const window = windowForDate('2026-03-10', '09:00', '21:00', 'UTC');
    for (let seed = 1; seed <= 50; seed += 1) {
        const times = chooseTimes(window, 4, 90, seeded(seed));
        assert.equal(times.length, 4, `seed ${seed}`);
        for (const [index, time] of times.entries()) {
            assert.ok(time >= window.start && time <= window.end, `seed ${seed} slot ${index} inside window`);
            if (index > 0) {
                const gap = time.getTime() - (times[index - 1] as Date).getTime();
                assert.ok(gap >= 90 * 60_000, `seed ${seed} slot ${index} gap ${gap / 60_000} min`);
            }
        }
    }
});

test('chooseTimes plans fewer posts than asked when the window cannot fit them', () => {
    const window = windowForDate('2026-03-10', '09:00', '12:00', 'UTC');
    assert.equal(chooseTimes(window, 6, 90, seeded(3)).length, 3);
    // A closed window yields nothing rather than a post in the past.
    const past = chooseTimes(window, 3, 90, seeded(3), new Date('2026-03-10T23:00:00Z'));
    assert.deepEqual(past, []);
});

test('chooseTimes never schedules before `notBefore` inside an open window', () => {
    const window = windowForDate('2026-03-10', '09:00', '21:00', 'UTC');
    const now = new Date('2026-03-10T15:20:00Z');
    const times = chooseTimes(window, 2, 60, seeded(11), now);
    assert.ok(times.length >= 1);
    for (const time of times) assert.ok(time >= now, time.toISOString());
});

test('a rule in a non-UTC zone posts inside its own local window', async () => {
    const timezone = 'America/New_York';
    const context = ports({
        now: new Date('2026-03-10T02:00:00Z'), // still 2026-03-09 in New York
        rules: async () => [rule({ timezone, postsPerDay: 2, minGapMinutes: 60 })],
    });
    await planDripRules(context.ports);
    assert.ok(context.created.length >= 2);
    for (const { post } of context.created) {
        const local = localDate(post.runAt, timezone);
        const open = zonedTimeToUtc(local, 9 * 60, timezone);
        const close = zonedTimeToUtc(local, 21 * 60, timezone);
        assert.ok(post.runAt >= open && post.runAt <= close, `${post.runAt.toISOString()} outside ${local} window`);
    }
});

test('planning is idempotent — a second run over the same dates creates nothing', async () => {
    const context = ports();
    const first = await planDripRules(context.ports);
    assert.equal(first.planned, context.created.length);
    assert.ok(first.planned > 0);

    const before = context.created.length;
    const second = await planDripRules(context.ports);
    assert.equal(second.planned, 0);
    assert.equal(context.created.length, before);
});

test('the reuse window is pushed down to the candidate query', async () => {
    const context = ports({ rules: async () => [rule({ avoidReuseDays: 14 })] });
    await planDripRules(context.ports);
    assert.equal(context.cutoffs.length, 1);
    const expected = new Date('2026-03-10T08:00:00Z').getTime() - 14 * 86_400_000;
    assert.equal(context.cutoffs[0]?.getTime(), expected);
});

test('an item is never planned twice inside one run', async () => {
    const context = ports();
    await planDripRules(context.ports);
    const ids = context.created.flatMap(({ post }) => post.items.map((entry) => entry.id));
    assert.equal(new Set(ids).size, ids.length);
});

test('a paused rule plans nothing and releases its unstarted schedules', async () => {
    let cancelled = 0;
    const context = ports({
        rules: async () => [rule({ enabled: false })],
        async cancelRuleSchedules() { cancelled += 3; return 3; },
    });
    const report = await planDripRules(context.ports);
    assert.equal(report.planned, 0);
    assert.equal(report.cancelled, 3);
    assert.equal(cancelled, 3);
    assert.equal(context.created.length, 0);
});

test('a rule with no available content is reported instead of throwing', async () => {
    const context = ports({ async candidates() { return []; } });
    const report = await planDripRules(context.ports);
    assert.equal(report.planned, 0);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0] as string, /no unused content/);
});

test('captions come from the rule template, with the item supplying title and hashtags', async () => {
    const context = ports({
        rules: async () => [rule({ captionTemplateId: 'template-1', postsPerDay: 1 })],
        async captionTemplate() { return { template: '{title} {random:one|one} {hashtags}' }; },
        pool: [item('a', { caption: 'Leg day', hashtags: ['gym', 'fyp'] })],
    });
    await planDripRules(context.ports);
    assert.equal(context.created[0]?.post.caption, 'Leg day one #gym #fyp');
});

test('fifo ordering drains never-used media first, then the least recently used', () => {
    const groups = [
        [item('used-recently', { lastUsedAt: new Date('2026-03-01T00:00:00Z') })],
        [item('never-used')],
        [item('used-long-ago', { lastUsedAt: new Date('2026-01-01T00:00:00Z') })],
    ];
    const ordered = orderCandidates(groups, 'fifo', seeded(1));
    assert.deepEqual(ordered.map((group) => group[0]?.id), ['never-used', 'used-long-ago', 'used-recently']);
});

test('random ordering depends only on the injected generator', () => {
    const groups = ['a', 'b', 'c', 'd'].map((id) => [item(id)]);
    const first = orderCandidates(groups, 'random', seeded(42)).map((group) => group[0]?.id);
    const second = orderCandidates(groups, 'random', seeded(42)).map((group) => group[0]?.id);
    assert.deepEqual(first, second);
    assert.deepEqual([...first].sort(), ['a', 'b', 'c', 'd']);
});

test('a rejected schedule is skipped without recording a plan', async () => {
    const context = ports({
        rules: async () => [rule({ postsPerDay: 2 })],
        async createPost() { return null; },
    });
    const report = await planDripRules(context.ports);
    assert.equal(report.planned, 0);
    assert.equal(context.plans.length, 0);
    assert.equal(context.markedDates.length, 0);
});
