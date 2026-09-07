import assert from 'node:assert/strict';
import test from 'node:test';

import type {
    ContentItemRow, CreatorAccountRow, DripPlanRow, DripRuleRow, PostNetwork,
} from '../src/database/schema.js';
import { limitsFor } from '../src/content/formats.js';
import {
    NETWORK_TASKS, formatProblemFor, postPayloadFor, taskForNetwork,
} from '../src/content/networks.js';
import { orderItems, planDripRules, type PlannedPost, type PlannerPorts } from '../src/content/planner.js';
import { assembleSlideshows, candidateGroups, ruleTargets } from '../src/content/runner.js';
import type { CandidateItem, ContentStore, PostTarget } from '../src/content/store.js';
import { PluginRegistry } from '../src/registry.js';
import { createTikTokPlugin } from '../src/tiktok-plugin.js';

/** A seeded generator, so every assertion below is reproducible. */
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
        postsPerDay: 1, windowStart: '09:00', windowEnd: '21:00', timezone: 'UTC',
        minGapMinutes: 120, destination: 'draft', source: 'tag', format: 'any', setId: null, tag: 'fitness',
        captionTemplateId: null, pickOrder: 'random', avoidReuseDays: 30, lastPlannedDate: null,
        network: 'tiktok', creatorId: null, networks: [], crossPostGapMinutes: 20, slideSize: 5,
        networkCaptions: {},
        createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    };
}

function item(id: string, overrides: Partial<CandidateItem> = {}): CandidateItem {
    return {
        id, assetId: `asset-${id}`, originalAssetId: null, kind: 'image', durationMs: null,
        width: 1080, height: 1920, normalized: true, sha256: id, tags: ['fitness'], caption: null,
        hashtags: [], posterPath: null, createdAt: new Date('2026-01-01T00:00:00Z'),
        usedCount: 0, lastUsedAt: null, status: 'ready', error: null, ...overrides,
    };
}

function store(overrides: Partial<ContentStore> = {}): ContentStore {
    const refuse = () => { throw new Error('not used by this test'); };
    return { ...(Object.create(null) as ContentStore), listRules: refuse, ...overrides } as ContentStore;
}

interface Harness {
    ports: PlannerPorts;
    created: PlannedPost[];
    /** Every (network, handle) pair the candidate query was asked about. */
    askedFor: PostTarget[][];
}

function ports(overrides: Partial<PlannerPorts> & { pool?: CandidateItem[][] } = {}): Harness {
    const created: PlannedPost[] = [];
    const askedFor: PostTarget[][] = [];
    const plans: DripPlanRow[] = [];
    let counter = 0;
    const pool = overrides.pool ?? [[item('a', { kind: 'video' })]];
    const base: PlannerPorts = {
        now: new Date('2026-03-10T08:00:00Z'),
        random: seeded(5),
        horizonDays: 1,
        rules: async () => [rule()],
        async targets(current) { return [{ network: current.network, handle: current.account }]; },
        async candidates(_current, _cutoff, targets) { askedFor.push([...targets]); return pool; },
        async plansForDates(ruleId, dates) {
            return plans.filter((plan) => plan.ruleId === ruleId && dates.includes(plan.date));
        },
        async captionTemplate() { return null; },
        async deviceLimits() { return { maxPostsPerDay: 99, minMinutesBetweenPosts: 0 }; },
        async deviceLoad() { return []; },
        async createPost(post) { counter += 1; created.push(post); return { scheduleId: `schedule-${counter}` }; },
        async recordPlan(post, scheduleId) {
            plans.push({ id: `plan-${plans.length + 1}`, ruleId: post.rule.id, date: post.date, scheduleId } as DripPlanRow);
        },
        async markRulePlanned() { /* nothing to record here */ },
        async cancelRuleSchedules() { return 0; },
        ...overrides,
    };
    return { ports: base, created, askedFor };
}

// ---- per-account reuse -----------------------------------------------------

test('the reuse window is asked per account, not globally', async () => {
    const context = ports({
        rules: async () => [rule({ creatorId: 'creator-1', avoidReuseDays: 7 })],
        async targets() {
            return [
                { network: 'tiktok', handle: '@mia' },
                { network: 'instagram', handle: '@mia.ig' },
            ];
        },
    });
    await planDripRules(context.ports);
    // The store is handed both accounts: "has *this* handle posted it" is the
    // question, and the same clip on a second account is a different feed.
    assert.deepEqual(context.askedFor, [[
        { network: 'tiktok', handle: '@mia' },
        { network: 'instagram', handle: '@mia.ig' },
    ]]);
});

test('an account rule asks about exactly its own account and network', async () => {
    const context = ports({ rules: async () => [rule({ network: 'threads', account: '@only' })] });
    await planDripRules(context.ports);
    assert.deepEqual(context.askedFor, [[{ network: 'threads', handle: '@only' }]]);
});

test('a use is recorded against the account the plan named, and credits the item once', async () => {
    const uses: Array<{ itemId: string; network: string; handle: string }> = [];
    const claimed = new Set<string>();
    const { reconcileUsage } = await import('../src/content/runner.js');
    const recording = store({
        async succeededUnmarkedPlans() {
            return [
                { id: 'p1', ruleId: 'rule-1', itemId: 'item-1', network: 'tiktok', account: '@mia', scheduleId: 's1' },
                { id: 'p2', ruleId: 'rule-1', itemId: 'item-1', network: 'instagram', account: '@mia.ig', scheduleId: 's2' },
            ] as unknown as DripPlanRow[];
        },
        async rule() { return rule(); },
        async markPlanUsed(planId, itemId, _at, use) {
            if (claimed.has(planId)) return false;
            claimed.add(planId);
            if (use) uses.push({ itemId, network: use.network, handle: use.handle });
            return true;
        },
    });
    assert.equal(await reconcileUsage(recording), 2);
    // One item, two accounts, two rows: that is what makes the next planning run
    // able to say "@mia has had this, @mia.ig has not".
    assert.deepEqual(uses, [
        { itemId: 'item-1', network: 'tiktok', handle: '@mia' },
        { itemId: 'item-1', network: 'instagram', handle: '@mia.ig' },
    ]);
});

// ---- creator fan-out -------------------------------------------------------

test('a creator rule posts one item to every enabled account, staggered by the gap', async () => {
    const context = ports({
        rules: async () => [rule({ creatorId: 'creator-1', crossPostGapMinutes: 25 })],
        async targets() {
            return [
                { network: 'tiktok', handle: '@mia' },
                { network: 'instagram', handle: '@mia.ig' },
                { network: 'threads', handle: '@mia.th' },
            ];
        },
    });
    await planDripRules(context.ports);
    assert.equal(context.created.length, 3, 'one item, three accounts, three posts');
    assert.deepEqual(context.created.map(({ target }) => target.handle), ['@mia', '@mia.ig', '@mia.th']);
    // Every copy carries the same media…
    assert.equal(new Set(context.created.map(({ items }) => items[0]!.id)).size, 1);
    // …and no two land in the same minute.
    const times = context.created.map(({ runAt }) => runAt.getTime()).sort((a, b) => a - b);
    assert.equal(times[1]! - times[0]!, 25 * 60_000);
    assert.equal(times[2]! - times[1]!, 25 * 60_000);
});

test('a copy staggered past the end of the window is reported rather than posted late', async () => {
    const context = ports({
        rules: async () => [rule({
            creatorId: 'creator-1', crossPostGapMinutes: 600, windowStart: '09:00', windowEnd: '11:00',
        })],
        async targets() {
            return [{ network: 'tiktok', handle: '@mia' }, { network: 'youtube', handle: '@mia.yt' }];
        },
        pool: [[item('a', { kind: 'video' })]],
    });
    const report = await planDripRules(context.ports);
    assert.equal(context.created.length, 1);
    assert.match(report.skipped.join(' | '), /@mia\.yt on YouTube fell outside the window/);
});

test('a rule whose creator has no enabled account says so instead of planning nothing quietly', async () => {
    const context = ports({
        rules: async () => [rule({ creatorId: 'creator-1' })],
        async targets() { return []; },
    });
    const report = await planDripRules(context.ports);
    assert.equal(context.created.length, 0);
    assert.match(report.skipped.join(' '), /no enabled account to post to/);
});

test('ruleTargets reads the creator, honours enabled, and narrows to the rule networks', async () => {
    const accounts = [
        { id: '1', creatorId: 'c', network: 'tiktok', handle: '@a', enabled: true },
        { id: '2', creatorId: 'c', network: 'instagram', handle: '@b', enabled: true },
        { id: '3', creatorId: 'c', network: 'instagram', handle: '@c', enabled: false },
        { id: '4', creatorId: 'c', network: 'youtube', handle: '@d', enabled: true },
    ] as CreatorAccountRow[];
    const reading = store({ async listCreatorAccounts() { return accounts; } });

    assert.deepEqual(await ruleTargets(reading, rule({ creatorId: 'c' })), [
        { network: 'tiktok', handle: '@a' },
        { network: 'instagram', handle: '@b' },
        { network: 'youtube', handle: '@d' },
    ], 'a disabled account is not posted to');

    assert.deepEqual(
        await ruleTargets(reading, rule({ creatorId: 'c', networks: ['instagram'] as PostNetwork[] })),
        [{ network: 'instagram', handle: '@b' }],
    );

    // No creator: the rule's own single account, on its own network.
    assert.deepEqual(await ruleTargets(reading, rule({ network: 'youtube', account: '@solo' })), [
        { network: 'youtube', handle: '@solo' },
    ]);
});

test('a per-network caption template overrides the rule template for that network only', async () => {
    const templates: Record<string, string> = {
        'tpl-base': 'base {account}',
        'tpl-ig': 'instagram {account}',
    };
    const context = ports({
        rules: async () => [rule({
            creatorId: 'creator-1', captionTemplateId: 'tpl-base',
            networkCaptions: { instagram: 'tpl-ig' },
        })],
        async targets() {
            return [{ network: 'tiktok', handle: '@mia' }, { network: 'instagram', handle: '@mia.ig' }];
        },
        async captionTemplate(id) { return templates[id] ? { template: templates[id] as string } : null; },
    });
    await planDripRules(context.ports);
    assert.deepEqual(context.created.map(({ caption }) => caption), ['base @mia', 'instagram @mia.ig']);
});

// ---- per-network format refusal --------------------------------------------

test('a 35-slide TikTok slideshow is refused for Instagram and named in the report', async () => {
    const slides = Array.from({ length: 35 }, (_, index) => item(`s${index}`));
    const context = ports({
        rules: async () => [rule({ creatorId: 'creator-1', format: 'slideshow' })],
        async targets() {
            return [{ network: 'tiktok', handle: '@mia' }, { network: 'instagram', handle: '@mia.ig' }];
        },
        pool: [slides],
    });
    const report = await planDripRules(context.ports);
    assert.deepEqual(context.created.map(({ target }) => target.handle), ['@mia'], 'TikTok takes 35, Instagram does not');
    assert.match(
        report.skipped.join(' | '),
        /@mia\.ig on Instagram did not get this slideshow — Instagram takes 2–20 files in a slideshow, not 35/,
    );
});

test('YouTube has no slideshow surface at all, and the refusal says that rather than a count', () => {
    assert.equal(limitsFor('youtube', 'slideshow'), undefined);
    assert.equal(formatProblemFor('youtube', 'slideshow', 3), 'YouTube does not take slideshow posts');
    assert.equal(formatProblemFor('youtube', 'video', 1), undefined);
    assert.equal(formatProblemFor('tiktok', 'slideshow', 35), undefined);
});

// ---- the plugin behind each network ----------------------------------------

test('a planned post names the network\'s own plugin and payload, not always TikTok\'s', () => {
    assert.equal(NETWORK_TASKS.instagram.pluginId, 'com.backline.instagram');
    assert.equal(NETWORK_TASKS.youtube.pluginId, 'com.backline.youtube');
    assert.equal(NETWORK_TASKS.threads.pluginId, 'com.backline.threads');

    const media = [{ assetId: 'a', name: 'clip.mp4', mimeType: 'video/mp4' }];
    const shared = { media, format: 'video' as const, destination: 'draft' as const, caption: 'hello' };
    assert.deepEqual(postPayloadFor({ ...shared, network: 'tiktok', account: '@a' }), {
        media, format: 'video', destination: 'draft', account: '@a', caption: 'hello',
    });
    // Instagram calls the same three things reel/photo/carousel.
    assert.equal((postPayloadFor({
        ...shared, network: 'instagram', account: '@a', format: 'slideshow',
    }) as { format: string }).format, 'carousel');
    // A Short needs a title; the caption becomes it.
    assert.equal((postPayloadFor({ ...shared, network: 'youtube', account: '@a' }) as { title: string }).title, 'hello');
    // A thread's body is `text`, not `caption`.
    assert.deepEqual(postPayloadFor({ ...shared, network: 'threads', account: '@a' }), {
        media, destination: 'draft', account: '@a', text: 'hello',
    });
});

test('the registered plugin wins over the static table when the app booted with one', () => {
    const plugins = new PluginRegistry([createTikTokPlugin()]);
    assert.deepEqual(taskForNetwork('tiktok', plugins), {
        pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1,
    });
    // A network whose plugin this process did not register still falls back.
    assert.deepEqual(taskForNetwork('threads', plugins), NETWORK_TASKS.threads);
});

// ---- auto-assembled slideshows ---------------------------------------------

test('a slideshow rule over a tag assembles whole slideshows of slideSize images', async () => {
    const images = ['c', 'a', 'd', 'b', 'e', 'f', 'g'].map((id) => item(id, { sortName: `${id}.jpg` }));
    const groups = await candidateGroups(
        store({ async candidateItems() { return images; } }),
        rule({ format: 'slideshow', slideSize: 3, pickOrder: 'filename' }),
        new Date('2026-02-01T00:00:00Z'),
        { random: seeded(1) },
    );
    // Seven images, three to a post: two whole slideshows, and the odd one left
    // in the library rather than posted as a one-slide "slideshow".
    assert.deepEqual(groups.map((group) => group.map(({ id }) => id)), [['a', 'b', 'c'], ['d', 'e', 'f']]);
});

test('filename order is natural, so slide-2 comes before slide-10', () => {
    const names = ['slide-10.jpg', 'slide-2.jpg', 'slide-1.jpg'];
    const ordered = orderItems(names.map((name, index) => item(String(index), { sortName: name })), 'filename', seeded(1));
    assert.deepEqual(ordered.map(({ sortName }) => sortName), ['slide-1.jpg', 'slide-2.jpg', 'slide-10.jpg']);
});

test('assembly honours the pick order and never mixes video into a slideshow', () => {
    const pool: CandidateItem[] = [
        item('new', { createdAt: new Date('2026-05-01T00:00:00Z'), lastUsedAt: new Date('2026-05-01T00:00:00Z') }),
        item('old', { createdAt: new Date('2026-01-01T00:00:00Z') }),
        item('clip', { kind: 'video' }),
        item('mid', { createdAt: new Date('2026-02-01T00:00:00Z') }),
    ];
    const groups = assembleSlideshows(pool, rule({ format: 'slideshow', slideSize: 2, pickOrder: 'fifo' }), seeded(1));
    assert.deepEqual(groups.map((group) => group.map(({ id }) => id)), [['old', 'mid']]);
    for (const group of groups) for (const slide of group) assert.equal(slide.kind, 'image');
});

test('a set-backed slideshow is untouched by assembly — it is still posted whole and in order', async () => {
    const members = [item('a'), item('b'), item('c')];
    const groups = await candidateGroups(
        store({
            async candidateItems() { return members; },
            async set() { return { id: 'set-1', kind: 'slideshow' } as never; },
            async setItems() { return members as ContentItemRow[]; },
        }),
        rule({ format: 'slideshow', source: 'set', setId: 'set-1', tag: null, slideSize: 2 }),
        new Date('2026-02-01T00:00:00Z'),
    );
    assert.deepEqual(groups.map((group) => group.map(({ id }) => id)), [['a', 'b', 'c']]);
});

// ---- per-phone caps --------------------------------------------------------

test('the per-phone daily cap holds across every rule on that phone, and says what it dropped', async () => {
    const rules = [
        rule({ id: 'rule-1', postsPerDay: 3, minGapMinutes: 60 }),
        rule({ id: 'rule-2', account: '@second', postsPerDay: 3, minGapMinutes: 60 }),
    ];
    const context = ports({
        rules: async () => rules,
        pool: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [item(id, { kind: 'video' })]),
        async deviceLimits() { return { maxPostsPerDay: 4, minMinutesBetweenPosts: 0 }; },
    });
    const report = await planDripRules(context.ports);
    assert.equal(context.created.length, 4, 'two rules of three posts on one phone is capped at four');
    assert.equal(report.planned, 4);
    assert.match(report.skipped.join(' | '), /is already at this phone's 4 posts a day/);
});

test('the per-phone gap also counts posts another rule already put on the calendar', async () => {
    const context = ports({
        rules: async () => [rule({ postsPerDay: 1 })],
        pool: [[item('a', { kind: 'video' })]],
        async deviceLimits() { return { maxPostsPerDay: 99, minMinutesBetweenPosts: 24 * 60 }; },
        // Something is already planned on this handset today, by a different rule.
        async deviceLoad() { return [{ date: '2026-03-10', plannedFor: new Date('2026-03-10T12:00:00Z') }]; },
    });
    const report = await planDripRules(context.ports);
    assert.equal(context.created.length, 0);
    assert.match(report.skipped.join(' | '), /inside this phone's 1440-minute gap/);
});
