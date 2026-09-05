import assert from 'node:assert/strict';
import test from 'node:test';

import { affectsPlanning } from '../src/api/routes/content.js';
import { reconcileUsage, replanRule, runDripPlanner } from '../src/content/runner.js';
import type { ContentStore } from '../src/content/store.js';
import type { DripPlanRow, DripRuleRow } from '../src/database/schema.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import { zonedTimeToUtc } from '../src/content/time.js';

function plan(overrides: Partial<DripPlanRow> = {}): DripPlanRow {
    return {
        id: 'plan-1', ruleId: 'rule-1', date: '2026-03-10', scheduleId: 'schedule-1', itemId: 'item-1',
        plannedFor: new Date('2026-03-10T12:00:00Z'), usedMarkedAt: null,
        createdAt: new Date('2026-03-10T08:00:00Z'), ...overrides,
    };
}

function rule(overrides: Partial<DripRuleRow> = {}): DripRuleRow {
    return {
        id: 'rule-1', deviceUdid: 'device-1', account: '@handle', enabled: true, postsPerDay: 2,
        windowStart: '09:00', windowEnd: '21:00', timezone: 'UTC', minGapMinutes: 120,
        destination: 'draft', source: 'tag', setId: null, tag: 'fitness', captionTemplateId: null,
        pickOrder: 'random', avoidReuseDays: 30, lastPlannedDate: null,
        createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    };
}

function store(overrides: Partial<ContentStore> = {}): ContentStore {
    const refuse = () => { throw new Error('not used by these tests'); };
    return { ...(Object.create(null) as ContentStore), listRules: refuse, ...overrides } as ContentStore;
}

test('a planning run that cannot take the lock reports it instead of double-planning', async () => {
    let planned = false;
    const busy = store({
        async withPlannerLock() { return null; },
        async listRules() { planned = true; return []; },
    });
    const report = await runDripPlanner({ store: busy, scheduler: {} as SchedulerRepository });
    assert.equal(planned, false, 'the body must not run without the lock');
    assert.equal(report.planned, 0);
    assert.match(report.skipped.join(' '), /Another planning run is already in progress/);
    // The BUSY report is copied, not shared — a caller pushing into `skipped`
    // must not poison the next request.
    report.skipped.push('mutated');
    const second = await runDripPlanner({ store: busy, scheduler: {} as SchedulerRepository });
    assert.equal(second.skipped.length, 1);
});

test('used_count is credited exactly once even when two sweeps race', async () => {
    const claimed = new Set<string>();
    const credits: string[] = [];
    const racing = store({
        async succeededUnmarkedPlans() { return [plan({ id: 'plan-a' }), plan({ id: 'plan-b', itemId: 'item-2' })]; },
        async markPlanUsed(planId, itemId) {
            if (claimed.has(planId)) return false; // the other sweep got there first
            claimed.add(planId);
            credits.push(itemId);
            return true;
        },
    });
    assert.equal(await reconcileUsage(racing), 2);
    assert.deepEqual(credits, ['item-1', 'item-2']);
    // The second sweep sees the same rows (its snapshot predates the claim) and credits nothing.
    assert.equal(await reconcileUsage(racing), 0);
    assert.deepEqual(credits, ['item-1', 'item-2']);
});

test('editing a rule releases the posts it had planned but not yet run', async () => {
    const cancelled: string[] = [];
    const deleted: string[][] = [];
    const edited = store({
        async unstartedPlans() {
            return [
                { planId: 'p1', scheduleId: 's1' },
                { planId: 'p2', scheduleId: 's1' }, // a slideshow: two plans, one schedule
                { planId: 'p3', scheduleId: 's2' },
                { planId: 'p4', scheduleId: null }, // never made it to a schedule
            ];
        },
        async deletePlans(ids) { deleted.push(ids); return ids.length; },
    });
    const scheduler = {
        async setScheduleStatus(id: string) { cancelled.push(id); return null; },
    } as unknown as SchedulerRepository;

    const result = await replanRule({ store: edited, scheduler, ruleId: 'rule-1' });
    assert.deepEqual(cancelled, ['s1', 's2'], 'each schedule is cancelled once, not once per plan row');
    assert.deepEqual(deleted, [['p1', 'p2', 'p3', 'p4']]);
    assert.deepEqual(result, { cancelled: 2, released: 4 });
});

test('a schedule that is already terminal does not abort the release', async () => {
    const edited = store({
        async unstartedPlans() { return [{ planId: 'p1', scheduleId: 'gone' }, { planId: 'p2', scheduleId: 'ok' }]; },
        async deletePlans(ids) { return ids.length; },
    });
    const scheduler = {
        async setScheduleStatus(id: string) {
            if (id === 'gone') throw new Error('Cannot change a completed schedule to cancelled');
            return null;
        },
    } as unknown as SchedulerRepository;
    const result = await replanRule({ store: edited, scheduler, ruleId: 'rule-1' });
    assert.deepEqual(result, { cancelled: 1, released: 2 });
});

test('only the fields that decide when and what a rule posts trigger a re-plan', () => {
    const before = rule();
    assert.equal(affectsPlanning(before, rule()), false);
    assert.equal(affectsPlanning(before, rule({ enabled: false })), false, 'pausing is handled by the planner itself');
    assert.equal(affectsPlanning(before, rule({ updatedAt: new Date('2027-01-01T00:00:00Z') })), false);
    assert.equal(affectsPlanning(before, rule({ lastPlannedDate: '2026-03-10' })), false);
    for (const patch of [
        { windowStart: '06:00' }, { windowEnd: '23:00' }, { timezone: 'Europe/Berlin' },
        { postsPerDay: 4 }, { minGapMinutes: 30 }, { tag: 'cooking' }, { source: 'set' as const },
        { destination: 'publish' as const }, { pickOrder: 'fifo' as const }, { deviceUdid: 'device-2' },
        { account: '@other' }, { avoidReuseDays: 1 }, { captionTemplateId: 'tpl' }, { setId: 'set-1' },
    ]) {
        assert.equal(affectsPlanning(before, rule(patch)), true, JSON.stringify(patch));
    }
});

test('the repeated hour of a fall-back resolves to its first occurrence', () => {
    const zone = 'America/New_York';
    const ambiguous = zonedTimeToUtc('2026-11-01', 60 + 30, zone);
    assert.equal(ambiguous.toISOString(), '2026-11-01T05:30:00.000Z'); // 01:30 EDT, not 01:30 EST
    // An unambiguous time in the same day is untouched.
    assert.equal(zonedTimeToUtc('2026-11-01', 12 * 60, zone).toISOString(), '2026-11-01T17:00:00.000Z');
});
