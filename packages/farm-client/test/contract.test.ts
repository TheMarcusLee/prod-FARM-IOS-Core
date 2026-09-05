/**
 * Contract tests: the client parsed against bodies the *farm* actually sends.
 *
 * Every fixture below is copied from the server's own tests
 * (`test/mobile-api.test.ts`, `test/fleet.test.ts`, `test/push.test.ts`) or
 * composed from the serialisers those tests assert on — `serializeEvent`,
 * `summarizeFleet`, `serializeRegistration`, `queueItem`. If the farm changes
 * one of them, these fail before a screen has a chance to render `undefined`.
 */

import { createFarmClient, eventText, type FarmEvent } from '../src';

/** The fixture the farm's `keysetPage()` produces for a paginated list. */
function response(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
}

function clientReturning(reply: (url: string, init?: RequestInit) => Response) {
    const urls: string[] = [];
    const client = createFarmClient({
        baseUrl: 'http://farm-mac.tailnet-1234.ts.net:3000',
        token: 'pf_live_abc',
        retries: 0,
        fetch: async (url, init) => {
            urls.push(String(url));
            return reply(String(url), init);
        },
    });
    return { client, urls };
}

/* --------------------------------------------------------------- bootstrap */

// `test/mobile-api.test.ts` → "GET /api/mobile/bootstrap composes release,
// plugins, fleet, events and capabilities".
const BOOTSTRAP = {
    serverTime: '2026-09-05T09:41:12.004Z',
    release: { version: '1.4.0', sha: '69673d2' },
    plugins: [
        {
            id: 'com.git-agni.tiktok',
            version: '1.0.0',
            displayName: 'TikTok',
            tasks: [{ type: 'doomscroll', version: 1, displayName: 'Doomscroll' }],
        },
    ],
    fleet: {
        counts: { total: 3, online: 0, busy: 1, offline: 0, disabled: 1, error: 1 },
        devices: [
            {
                udid: 'device-1',
                name: 'iPhone 8 · slot 1',
                platform: 'ios',
                tags: ['warm-up'],
                state: 'busy',
                connection: { connected: true },
                currentExecution: {
                    id: 'execution-1',
                    taskType: 'doomscroll',
                    status: 'running',
                    startedAt: '2026-09-05T09:38:02.110Z',
                    summary: 'com.git-agni.tiktok/doomscroll@1',
                },
                nextRunAt: '2026-09-06T09:00:00.000Z',
                lastError: null,
            },
        ],
    },
    recentEvents: [
        {
            id: 1,
            kind: 'device.error',
            severity: 'error',
            deviceUdid: 'device-2',
            executionId: null,
            scheduleId: null,
            title: 'adb lost the device',
            detail: { physical: 'connected', wda: 'error', error: 'adb lost the device' },
            createdAt: '2026-09-05T09:40:00.000Z',
        },
    ],
    unacknowledgedCount: 1,
    capabilities: { push: true, eventAck: true, thumbnails: true, contentQueue: true, tokens: true, rateLimits: true },
};

describe('GET /api/mobile/bootstrap', () => {
    it('reads the release, the six capability keys and the per-device badge', async () => {
        const { client } = clientReturning(() => response(BOOTSTRAP));
        const boot = await client.bootstrap();

        expect(boot.release.version).toBe('1.4.0');
        expect(boot.release.sha).toBe('69673d2');
        // Not `screenshotThumbnails`/`drip`, and there is no `events`/`sse` key.
        expect(Object.keys(boot.capabilities).sort()).toEqual([
            'contentQueue', 'eventAck', 'push', 'rateLimits', 'thumbnails', 'tokens',
        ]);
        expect(boot.fleet.counts.total).toBe(3);
        expect(boot.fleet.devices[0]!.state).toBe('busy');
        // Bootstrap sends `{ connected }` only — no `message` to render.
        expect(boot.fleet.devices[0]!.connection).toEqual({ connected: true });
    });

    it('renders a recent event through the same `detail` path the timeline uses', async () => {
        const { client } = clientReturning(() => response(BOOTSTRAP));
        const [event] = (await client.bootstrap()).recentEvents;
        expect(event!.detail).toMatchObject({ wda: 'error' });
        expect(eventText(event!, 'Pixel 6a')).toEqual({
            title: 'adb lost the device',
            body: 'adb lost the device',
        });
    });
});

/* ------------------------------------------------------------ fleet summary */

describe('GET /api/fleet/summary', () => {
    // `summarizeFleet()` in src/fleet/summary.ts — counters, and a four-way
    // device count that is *not* the derived badge.
    const SUMMARY = {
        generatedAt: '2026-09-05T09:41:12.004Z',
        devices: { total: 12, online: 10, offline: 1, disabled: 1 },
        byPlatform: { ios: 9, android: 3 },
        running: 3,
        queued: 2,
        stuck: 0,
        failedLast24h: 1,
        succeededLast24h: 14,
        plannedNext24h: 7,
    };

    it('parses the counter shape the farm really answers with', async () => {
        const { client } = clientReturning(() => response(SUMMARY));
        const summary = await client.getFleetSummary();
        expect(summary.devices.total).toBe(12);
        expect(summary.byPlatform.android).toBe(3);
        expect(summary.plannedNext24h).toBe(7);
        // The thing it deliberately does *not* carry: a device list.
        expect((summary as unknown as { counts?: unknown }).counts).toBeUndefined();
    });
});

/* --------------------------------------------------------------- pagination */

describe('keyset pagination on /api/schedules and /api/executions', () => {
    it('takes the next cursor from X-Next-Before, not the body', async () => {
        const { client, urls } = clientReturning(() =>
            response({ schedules: [{ id: 'sch-1' }, { id: 'sch-2' }] }, { headers: { 'x-next-before': 'sch-2' } }),
        );
        const page = await client.listSchedules({ limit: 2 });
        expect(page.schedules).toHaveLength(2);
        expect(page.nextBefore).toBe('sch-2');
        expect(urls[0]).toContain('?limit=2');
    });

    it('reports no cursor on the last page, where the farm sends no header', async () => {
        const { client } = clientReturning(() => response({ executions: [{ id: 'exec-1' }] }));
        const page = await client.listExecutions({ limit: 50 });
        expect(page.executions).toHaveLength(1);
        expect(page.nextBefore).toBeUndefined();
    });
});

/* -------------------------------------------------------- envelope unwrapping */

describe('response envelopes', () => {
    it('unwraps `{ registrations }` from GET /api/push/registrations', async () => {
        // `serializeRegistration` — never the Expo token itself, only its suffix.
        const { client } = clientReturning(() =>
            response({
                registrations: [
                    {
                        id: 'b4a1', name: 'marcus-iphone', tokenSuffix: 'x2q9fa', minSeverity: 'warning',
                        kinds: ['execution.failed'], tokenId: '5d2c',
                        createdAt: '2026-09-05T09:12:00.000Z', lastSeenAt: '2026-09-05T09:12:00.000Z', lastError: null,
                    },
                ],
            }),
        );
        const rows = await client.listPushRegistrations();
        expect(Array.isArray(rows)).toBe(true);
        expect(rows[0]!.tokenSuffix).toBe('x2q9fa');
        expect(rows[0]).not.toHaveProperty('expoPushToken');
    });

    it('unwraps `{ item }` from the content-queue writes and sends no body', async () => {
        // `queueItem()` in src/api/routes/mobile.ts.
        const item = {
            id: 'd31a', status: 'approved', deviceUdid: 'device-1', caption: 'day 14 of building the farm',
            assetId: '9f2c', thumbnailUrl: '/api/assets/9f2c/thumbnail',
            plannedFor: '2026-09-06T18:00:00.000Z', scheduleId: '8c1f',
        };
        const bodies: (string | null)[] = [];
        const { client, urls } = clientReturning((_url, init) => {
            bodies.push(init?.body === undefined ? null : String(init.body));
            return response({ item });
        });

        expect(await client.approveContentItem('d31a')).toEqual(item);
        expect(await client.skipContentItem('d31a')).toEqual(item);
        expect(urls).toEqual([
            'http://farm-mac.tailnet-1234.ts.net:3000/api/content/queue/d31a/approve',
            'http://farm-mac.tailnet-1234.ts.net:3000/api/content/queue/d31a/skip',
        ]);
        // Neither route reads a body; sending `plannedFor`/`reason` would read
        // as a feature that works.
        expect(bodies).toEqual([null, null]);
    });

    it('reads the bulk result as counts plus per-device rows', async () => {
        const { client } = clientReturning(() =>
            response(
                {
                    created: 1,
                    failed: 1,
                    results: [
                        { deviceUdid: 'device-1', ok: true, scheduleId: '8c1f' },
                        { deviceUdid: 'device-3', ok: false, error: 'This device is disabled' },
                    ],
                },
                { status: 201 },
            ),
        );
        const result = await client.createSchedulesBulk({
            deviceUdids: ['device-1', 'device-3'],
            task: { pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1, payload: {} },
            timing: { kind: 'now' },
        });
        expect(result.created).toBe(1);
        expect(result.results.filter((row) => !row.ok)).toHaveLength(1);
    });
});

/* ------------------------------------------------------------------- events */

describe('GET /api/events', () => {
    it('sends one `kind`, because a repeated one is a 400', async () => {
        const { client, urls } = clientReturning(() => response({ events: [], nextBefore: null }));
        await client.listEvents({ kind: 'execution.failed', limit: 50, before: 42 });
        expect(urls[0]).toContain('kind=execution.failed');
        expect(urls[0]!.match(/kind=/g)).toHaveLength(1);
        expect(urls[0]).toContain('before=42');
    });

    it('parses `serializeEvent` output — numeric id, `detail`, no `message`', async () => {
        // `test/events.test.ts` asserts exactly these keys on the wire.
        const wire = {
            id: 42,
            kind: 'execution.failed',
            severity: 'error',
            deviceUdid: 'device-1',
            executionId: 'execution-1',
            scheduleId: 'schedule-1',
            title: 'com.git-agni.tiktok/doomscroll@1 failed on device-1',
            detail: { task: 'com.git-agni.tiktok/doomscroll@1', status: 'failed', exitCode: 1, error: 'WDA went away' },
            createdAt: '2026-09-05T13:44:02.118Z',
        };
        const { client } = clientReturning(() => response({ events: [wire], nextBefore: 42 }));
        const page = await client.listEvents({ limit: 1 });

        const event: FarmEvent = page.events[0]!;
        expect(typeof event.id).toBe('number');
        expect(event).not.toHaveProperty('message');
        expect(eventText(event).body).toBe('WDA went away (exit 1)');
        expect(page.nextBefore).toBe(42);
    });

    it('survives an event with no detail at all', async () => {
        const { client } = clientReturning(() =>
            response({
                events: [{
                    id: 7, kind: 'schedule.paused', severity: 'info', deviceUdid: null, executionId: null,
                    scheduleId: 'schedule-1', title: 'Schedule paused', detail: null,
                    createdAt: '2026-09-05T13:44:02.118Z',
                }],
            }),
        );
        const [event] = (await client.listEvents()).events;
        expect(eventText(event!)).toEqual({ title: 'Schedule paused', body: '' });
    });
});
