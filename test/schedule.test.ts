import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

import { inject } from './support.js';
import { createApp } from '../src/api/app.js';
import { registerScheduleRoutes } from '../src/api/routes/schedule.js';
import { defaultDashboardTheme } from '../src/dashboard-theme.js';
import { PluginRegistry } from '../src/registry.js';
import type { ExecutionRow, ScheduleRow } from '../src/database/schema.js';
import type { RegisteredDevice } from '../src/devices/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import { ACCOUNT_PALETTE, assignAccountColours, collectAccounts } from '../src/schedule/accounts.js';
import { buildTimeline, windowForRange, type TimelinePayload } from '../src/schedule/timeline.js';

/** 2026-09-05 19:30 local — an evening, so the range is the one the design calls "tonight". */
const NOW = new Date(2026, 8, 5, 19, 30, 0);

function device(index: number, accounts: string[] = [], overrides: Partial<RegisteredDevice> = {}): RegisteredDevice {
    return {
        udid: `device-${index}`, name: `Phone ${index}`, platform: 'android',
        pluginData: accounts.length ? { 'com.git-agni.tiktok': { accounts } } : {},
        ...overrides,
    };
}

function execution(overrides: Partial<ExecutionRow> & { id: string; deviceUdid: string; scheduledFor: Date }): ExecutionRow {
    const scheduledFor = overrides.scheduledFor;
    return {
        scheduleId: null, pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1, payload: {},
        deadlineAt: new Date(scheduledFor.getTime() + 30 * 60_000), status: 'queued', queueJobId: null,
        startedAt: null, finishedAt: null, exitCode: null, error: null, stopRequestedAt: null,
        createdAt: scheduledFor, updatedAt: scheduledFor, ...overrides,
    } as ExecutionRow;
}

const DEVICES = [device(1, ['@one']), device(2, ['@two']), device(3, ['@three'], { disabled: true })];

function fakeScheduler(executions: ExecutionRow[], schedules: ScheduleRow[] = []): SchedulerRepository {
    return {
        async listExecutions(limit = 100) { return executions.slice(0, limit); },
        async listSchedules(limit = 100) { return schedules.slice(0, limit); },
    } as unknown as SchedulerRepository;
}

async function scheduleApi(executions: ExecutionRow[], schedules: ScheduleRow[] = []): Promise<FastifyInstance> {
    const app = Fastify();
    await registerScheduleRoutes(app, {
        scheduler: fakeScheduler(executions, schedules),
        loadDevices: async () => DEVICES,
        connectedUdids: async () => [DEVICES[0]!.udid],
        contentStore: null, events: null, now: () => NOW,
    });
    return app;
}

async function timeline(app: FastifyInstance, query = ''): Promise<TimelinePayload> {
    const response = await inject(app, { method: 'GET', url: `/api/schedule/timeline${query}` });
    assert.equal(response.statusCode, 200);
    return response.json() as TimelinePayload;
}

// ---- account colours -------------------------------------------------------

test('account colours follow registration order and stay put when accounts are added', () => {
    const accounts = collectAccounts([device(1, ['@one', '@two']), device(2, ['@three'])]);
    assert.deepEqual(accounts, ['@one', '@two', '@three']);

    const before = assignAccountColours(accounts);
    assert.equal(before.get('@one')?.name, ACCOUNT_PALETTE[0]?.name);
    assert.equal(before.get('@three')?.name, ACCOUNT_PALETTE[2]?.name);

    // A fourth account registered later must not repaint the first three.
    const after = assignAccountColours(collectAccounts(
        [device(1, ['@one', '@two']), device(2, ['@three'])], ['@four'],
    ));
    for (const account of accounts) assert.equal(after.get(account)?.fill, before.get(account)?.fill);
    assert.equal(after.get('@four')?.name, ACCOUNT_PALETTE[3]?.name);

    // The palette cycles rather than running out.
    const many = assignAccountColours(Array.from({ length: 10 }, (_, index) => `@a${index}`));
    assert.equal(many.get('@a8')?.name, ACCOUNT_PALETTE[0]?.name);
    assert.equal(many.get('@a9')?.name, ACCOUNT_PALETTE[1]?.name);
});

// ---- ranges ----------------------------------------------------------------

test('each named range covers the window its label promises', () => {
    // Today runs to midnight, and always shows at least six hours, so a look at
    // 19:30 starts at 18:00 rather than leaving a two-inch strip.
    const today = windowForRange('today', NOW);
    assert.equal(today.from.getHours(), 18);
    assert.equal(today.to.getTime() - new Date(2026, 8, 6).getTime(), 0);

    const tomorrow = windowForRange('tomorrow', NOW);
    assert.equal(tomorrow.from.getDate(), 6);
    assert.equal(tomorrow.to.getDate(), 7);

    const week = windowForRange('week', NOW);
    assert.equal(Math.round((week.to.getTime() - week.from.getTime()) / 86_400_000), 7);
    assert.equal(week.from.getHours(), 0);
});

test('the timeline endpoint answers for every range and honours an explicit window', async (context) => {
    const app = await scheduleApi([execution({ id: 'e1', deviceUdid: 'device-1', scheduledFor: new Date(2026, 8, 5, 20, 0) })]);
    context.after(() => app.close());

    const today = await timeline(app);
    assert.equal(today.range, 'today');
    assert.match(today.heading, /^Tonight, Saturday 5 September$/);
    assert.equal(today.tracks.flatMap(({ clips }) => clips).length, 1);

    const tomorrow = await timeline(app, '?range=tomorrow');
    assert.equal(tomorrow.range, 'tomorrow');
    assert.equal(tomorrow.tracks.flatMap(({ clips }) => clips).length, 0, 'tonight\'s post is not tomorrow\'s');

    const week = await timeline(app, '?range=week');
    assert.equal(week.range, 'week');
    assert.equal(week.tracks.flatMap(({ clips }) => clips).length, 1);

    const custom = await timeline(app, '?from=2026-09-05T00:00:00.000Z&to=2026-09-06T00:00:00.000Z');
    assert.equal(custom.range, 'custom');
    assert.equal(custom.from, '2026-09-05T00:00:00.000Z');

    // Nonsense falls back to today rather than 500ing.
    assert.equal((await timeline(app, '?range=next-decade')).range, 'today');
});

// ---- clips -----------------------------------------------------------------

test('a running clip reports how far through its window it is', async (context) => {
    const started = new Date(2026, 8, 5, 19, 20);
    const app = await scheduleApi([execution({
        id: 'running', deviceUdid: 'device-1', scheduledFor: started, startedAt: started,
        deadlineAt: new Date(2026, 8, 5, 19, 40), status: 'running',
        payload: { account: '@one', caption: 'gym pov #3' },
    })]);
    context.after(() => app.close());

    const clip = (await timeline(app)).tracks.flatMap(({ clips }) => clips)[0];
    assert.equal(clip?.status, 'running');
    assert.equal(clip?.progress, 0.5, 'ten minutes into a twenty-minute window');
    assert.equal(clip?.title, 'posting');
    assert.equal(clip?.account, '@one');
});

test('a failed clip is paired with the attempt that retries it', async (context) => {
    const failedAt = new Date(2026, 8, 5, 19, 40);
    const app = await scheduleApi([
        execution({
            id: 'failed', deviceUdid: 'device-1', scheduleId: 'schedule-1', scheduledFor: failedAt,
            startedAt: failedAt, finishedAt: new Date(2026, 8, 5, 19, 45), status: 'failed',
            error: 'The Post button was not found',
        }),
        execution({
            id: 'retry', deviceUdid: 'device-1', scheduleId: 'schedule-1',
            scheduledFor: new Date(2026, 8, 5, 20, 10),
        }),
        // A different schedule on the same phone must not be adopted as the retry.
        execution({ id: 'other', deviceUdid: 'device-1', scheduleId: 'schedule-2', scheduledFor: new Date(2026, 8, 5, 20, 30) }),
    ]);
    context.after(() => app.close());

    const payload = await timeline(app);
    const clips = new Map(payload.tracks.flatMap(({ clips: rows }) => rows).map((clip) => [clip.id, clip]));
    assert.equal(clips.get('retry')?.retryOf, 'failed');
    assert.equal(clips.get('failed')?.retriedBy, 'retry');
    assert.equal(clips.get('other')?.retryOf, undefined);
    assert.equal(payload.counts.needsYou, 1);
    assert.match(clips.get('failed')?.summary ?? '', /The Post button was not found/);
});

test('a disabled phone gets no track, and an offline one is marked offline', () => {
    const payload = buildTimeline({
        from: new Date(2026, 8, 5, 18, 0), to: new Date(2026, 8, 6), now: NOW, range: 'today',
        devices: DEVICES, connected: new Set(['device-1']), executions: [], schedules: [],
    });
    assert.deepEqual(payload.tracks.map(({ deviceUdid }) => deviceUdid), ['device-1', 'device-2']);
    assert.deepEqual(payload.tracks.map(({ slot }) => slot), ['01', '02']);
    assert.equal(payload.tracks[0]?.state, 'online');
    assert.equal(payload.tracks[1]?.state, 'offline');
});

// ---- pages -----------------------------------------------------------------

test('the schedule page renders a track per active phone through the shell', async (context) => {
    const app = await scheduleApi([execution({
        id: 'e1', deviceUdid: 'device-2', scheduledFor: new Date(2026, 8, 5, 20, 0),
        payload: { account: '@two', caption: 'morning routine' },
    })]);
    context.after(() => app.close());

    const page = await inject(app, { method: 'GET', url: '/schedule' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<title>Schedule · Backline<\/title>/);
    assert.match(page.body, /class="bl-nav"/, 'renders through renderShell');
    assert.match(page.body, /Tonight, Saturday 5 September/);
    assert.match(page.body, /data-device="device-1"/);
    assert.match(page.body, /data-device="device-2"/);
    assert.doesNotMatch(page.body, /data-device="device-3"/, 'a disabled phone has no track');
    assert.match(page.body, /20:00 morning routine/);
    assert.match(page.body, /bl-playhead/);
    assert.match(page.body, /\/assets\/pages\.css\?v=/);
    assert.doesNotMatch(page.body, /iOS Farm|Phone Farm|Handler|Agniverse/);

    const styles = await inject(app, { method: 'GET', url: '/assets/pages.css' });
    assert.equal(styles.statusCode, 200);
    assert.match(String(styles.headers['content-type']), /css/);
});

test('the retired /tasks page redirects to Schedule', async (context) => {
    const app = await createApp({
        plugins: new PluginRegistry([{
            id: 'com.example.stats', version: '1.0.0', displayName: 'Stats', tasks: [],
            navLinks: [{ label: 'Stats', href: '/stats' }],
        }]),
        scheduler: {} as SchedulerRepository,
        dashboardTheme: defaultDashboardTheme,
        authProvider: {
            id: 'test', logoutPath: '/auth/logout',
            registerRoutes() {},
            async authenticate() { return { id: 'u', roles: [] }; },
            isPublicPath() { return true; },
        },
    });
    context.after(() => app.close());

    const moved = await inject(app, { method: 'GET', url: '/tasks' });
    assert.equal(moved.statusCode, 302);
    assert.equal(moved.headers.location, '/schedule');

    // And the page still renders with no database behind it at all.
    const page = await inject(app, { method: 'GET', url: '/schedule' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /No phones are active/);
    // The shell's slots are filled from the same options app.ts already has.
    assert.match(page.body, /href="\/stats"[^>]*>Stats</);
    assert.match(page.body, /href="\/auth\/logout"[^>]*>Log out</);
});
