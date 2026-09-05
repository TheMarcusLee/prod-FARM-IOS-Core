import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

import { inject } from './support.js';
import { createApp } from '../src/api/app.js';
import { registerContentRoutes } from '../src/api/routes/content.js';
import { defaultDashboardTheme } from '../src/dashboard-theme.js';
import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import type { CaptionTemplateRow, ContentItemRow, ContentSetRow, DripRuleRow } from '../src/database/schema.js';
import type { ContentStore } from '../src/content/store.js';

function contentItem(overrides: Partial<ContentItemRow> = {}): ContentItemRow {
    return {
        id: '11111111-1111-4111-8111-111111111111', assetId: 'asset-1', originalAssetId: null,
        kind: 'video', durationMs: 20_000, width: 1080, height: 1920, normalized: true, sha256: 'abc',
        tags: ['fitness'], caption: 'Leg day', hashtags: ['gym'], posterPath: null,
        createdAt: new Date('2026-02-01T00:00:00Z'), usedCount: 2, lastUsedAt: null,
        status: 'ready', error: null, ...overrides,
    };
}

/** Mirrors the fake-repository style of test/app.test.ts — no database anywhere. */
function fakeStore(): { store: ContentStore; state: { items: ContentItemRow[]; rules: DripRuleRow[] } } {
    const state = { items: [contentItem()], rules: [] as DripRuleRow[] };
    const unused = () => { throw new Error('not used by these tests'); };
    const store = {
        insertAsset: unused,
        assetPath: async () => null,
        listItems: async (filter: { tag?: string } = {}) =>
            state.items.filter((item) => !filter.tag || item.tags.includes(filter.tag)),
        item: async (id: string) => state.items.find((entry) => entry.id === id) ?? null,
        insertItem: unused,
        updateItem: async (id: string, patch: Partial<ContentItemRow>) => {
            const index = state.items.findIndex((entry) => entry.id === id);
            if (index < 0) return null;
            state.items[index] = { ...state.items[index] as ContentItemRow, ...patch };
            return state.items[index] as ContentItemRow;
        },
        deleteItem: async (id: string) => {
            const before = state.items.length;
            state.items = state.items.filter((entry) => entry.id !== id);
            return state.items.length < before;
        },
        listSets: async () => [] as Array<ContentSetRow & { itemCount: number }>,
        createSet: async (values: { name: string; notes?: string | null }) => ({
            id: 'set-1', name: values.name, notes: values.notes ?? null, createdAt: new Date(),
        }) as ContentSetRow,
        deleteSet: async () => false,
        setItems: async () => [],
        setSetItems: async () => {},
        listTemplates: async () => [] as CaptionTemplateRow[],
        template: async () => null,
        createTemplate: async (values: { name: string; template: string }) => ({
            id: 'template-1', ...values, createdAt: new Date(),
        }) as CaptionTemplateRow,
        deleteTemplate: async () => false,
        listRules: async () => state.rules,
        rule: async (id: string) => state.rules.find((entry) => entry.id === id) ?? null,
        createRule: async (values: Partial<DripRuleRow>) => {
            const row = {
                id: `rule-${state.rules.length + 1}`, lastPlannedDate: null,
                createdAt: new Date(), updatedAt: new Date(), ...values,
            } as DripRuleRow;
            state.rules.push(row);
            return row;
        },
        updateRule: async () => null,
        deleteRule: async () => false,
        candidateItems: async () => [],
        plansForDates: async () => [],
        upcomingPlans: async () => [],
        insertPlan: unused,
        unstartedScheduleIds: async () => [],
        succeededUnmarkedPlans: async () => [],
        markPlanUsed: async () => {},
    } as unknown as ContentStore;
    return { store, state };
}

/**
 * `createApp` builds its store from the scheduler's own connection, so the API
 * assertions mount the same route module on a bare Fastify instance with the
 * fake store injected. The planner tick is switched off.
 */
async function contentApi(): Promise<{ app: FastifyInstance; state: ReturnType<typeof fakeStore>['state'] }> {
    const { store, state } = fakeStore();
    const app = Fastify();
    await registerContentRoutes(app, {
        scheduler: {} as SchedulerRepository, store, plannerIntervalMinutes: 0,
    });
    return { app, state };
}

test('the dashboard links to /content and the page renders', async (context) => {
    const app = await createApp({
        plugins: new PluginRegistry([]),
        scheduler: {} as SchedulerRepository,
        dashboardTheme: defaultDashboardTheme,
    });
    context.after(() => app.close());

    const index = await inject(app, { method: 'GET', url: '/' });
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /href="\/content"[^>]*>Content</);

    const page = await inject(app, { method: 'GET', url: '/content' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<h1>Content<\/h1>/);
    assert.doesNotMatch(page.body, /__FOOTER__|__PLUGIN_NAV__|__AUTH_NAV__/);
    assert.match(page.body, /\/assets\/content\.js/);

    const script = await inject(app, { method: 'GET', url: '/assets/content.js' });
    assert.equal(script.statusCode, 200);
    assert.match(String(script.headers['content-type']), /javascript/);
});

test('content API routes answer from an injected store', async (context) => {
    const { app, state } = await contentApi();
    context.after(() => app.close());

    const list = await inject(app, { method: 'GET', url: '/api/content/items' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, 1);

    const filtered = await inject(app, { method: 'GET', url: '/api/content/items?tag=nothing' });
    assert.equal(filtered.json().items.length, 0);

    const fragment = await inject(app, {
        method: 'GET', url: '/api/content/items', headers: { 'hx-request': 'true' },
    });
    assert.match(String(fragment.headers['content-type']), /text\/html/);
    assert.match(fragment.body, /id="content-library"/);
    assert.match(fragment.body, /fitness/);

    const patched = await inject(app, {
        method: 'PATCH', url: `/api/content/items/${state.items[0]?.id}`,
        payload: { tags: 'Gym, #Cardio', caption: 'Updated', id: 'ignored', usedCount: 999 },
    });
    assert.equal(patched.statusCode, 200);
    assert.deepEqual(state.items[0]?.tags, ['gym', 'cardio']);
    assert.equal(state.items[0]?.caption, 'Updated');
    // The whitelist dropped the fields that were not offered for editing.
    assert.equal(state.items[0]?.usedCount, 2);
    assert.equal(state.items[0]?.id, '11111111-1111-4111-8111-111111111111');

    const missing = await inject(app, {
        method: 'PATCH', url: '/api/content/items/22222222-2222-4222-8222-222222222222', payload: { tags: 'x' },
    });
    assert.equal(missing.statusCode, 404);
});

test('drip rules are validated before they reach the database', async (context) => {
    const { app, state } = await contentApi();
    context.after(() => app.close());

    const impossible = await inject(app, {
        method: 'POST', url: '/api/drip/rules',
        payload: {
            deviceUdid: 'device-1', account: 'handle', postsPerDay: 6, minGapMinutes: 180,
            windowStart: '09:00', windowEnd: '12:00', source: 'tag', tag: 'fitness',
        },
    });
    assert.equal(impossible.statusCode, 400);
    assert.match(impossible.json().error, /do not fit/);

    const noSource = await inject(app, {
        method: 'POST', url: '/api/drip/rules',
        payload: { deviceUdid: 'device-1', account: 'handle', source: 'set' },
    });
    assert.equal(noSource.statusCode, 400);
    assert.match(noSource.json().error, /content set/);

    const badZone = await inject(app, {
        method: 'POST', url: '/api/drip/rules',
        payload: { deviceUdid: 'device-1', account: 'handle', tag: 'fitness', timezone: 'Mars/Olympus' },
    });
    assert.equal(badZone.statusCode, 400);

    const created = await inject(app, {
        method: 'POST', url: '/api/drip/rules',
        payload: {
            deviceUdid: 'device-1', account: 'handle', postsPerDay: 3, minGapMinutes: 120,
            windowStart: '09:00', windowEnd: '21:00', timezone: 'UTC', source: 'tag', tag: 'Fitness',
            destination: 'publish', order: 'fifo', enabled: 'true', id: 'attacker-chosen',
        },
    });
    assert.equal(created.statusCode, 201);
    const rule = state.rules[0];
    assert.equal(rule?.account, '@handle');
    assert.equal(rule?.tag, 'fitness');
    assert.equal(rule?.pickOrder, 'fifo');
    assert.equal(rule?.destination, 'publish');
    assert.notEqual(rule?.id, 'attacker-chosen');
});

test('a caption template can be previewed without being saved', async (context) => {
    const { app } = await contentApi();
    context.after(() => app.close());

    const preview = await inject(app, {
        method: 'POST', url: '/api/content/templates/preview',
        payload: { template: '{title} {hashtags}', title: 'Hello', hashtags: 'gym, fyp' },
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().preview, 'Hello #gym #fyp');

    const empty = await inject(app, { method: 'POST', url: '/api/content/templates/preview', payload: {} });
    assert.equal(empty.statusCode, 400);
});

test('URL ingest reports 501 when yt-dlp is not configured', async (context) => {
    const { app } = await contentApi();
    context.after(() => app.close());

    const previous = process.env.YT_DLP_PATH;
    process.env.YT_DLP_PATH = '/nonexistent/yt-dlp';
    context.after(() => {
        if (previous === undefined) delete process.env.YT_DLP_PATH; else process.env.YT_DLP_PATH = previous;
    });

    const response = await inject(app, {
        method: 'POST', url: '/api/content/ingest-url', payload: { url: 'https://example.test/video' },
    });
    assert.equal(response.statusCode, 501);
    assert.match(response.json().error, /yt-dlp/);

    const bad = await inject(app, { method: 'POST', url: '/api/content/ingest-url', payload: { url: 'ftp://x/y' } });
    assert.equal(bad.statusCode, 400);
});
