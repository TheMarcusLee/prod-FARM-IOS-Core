import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

import { inject } from './support.js';
import { registerFleetRoutes } from '../src/api/routes/fleet.js';
import { registerPushRoutes } from '../src/api/routes/push.js';
import { createMemoryEventStore, type EventInput, type FarmEvent } from '../src/fleet/events.js';
import {
    capExpoMessage, chunk, fetchExpoReceipts, isDeviceNotRegistered, isRetryableStatus,
    isRetryableTicketError, sendExpoMessages,
    EXPO_MESSAGE_LIMIT_BYTES, EXPO_PUSH_URL, EXPO_RECEIPT_URL, type ExpoTicket, type PushFetch,
} from '../src/push/expo.js';
import { createMemoryAckStore } from '../src/push/acks.js';
import {
    createMemoryRegistrationStore, isExpoPushToken, matchesRegistration, parseRegistration, tokenSuffix,
} from '../src/push/registrations.js';
import {
    createCoalescer, createRelayClient, inQuietHours, parseQuietHours, parseStreamEvent, passesQuietHours,
    pushMessage, readRelayState, relayConfigFromEnv, runRelay, sendBatches, settleReceipts, writeRelayState,
    type PendingReceipt, type RelayClient, type RelayConfig, type RelayRegistration,
} from '../src/push/relay.js';
import { createSseParser, sseBackoffDelay } from '../src/push/sse.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

const scheduler = {
    async listExecutions() { return []; },
    async listSchedules() { return []; },
} as unknown as SchedulerRepository;

function farmEvent(overrides: Partial<FarmEvent> = {}): FarmEvent {
    return {
        id: 7, kind: 'execution.failed', severity: 'error', deviceUdid: 'udid-a',
        executionId: '3f8f4e0e-0000-4000-8000-000000000001', scheduleId: null,
        title: 'Doomscroll failed on udid-a', detail: { error: 'WDA session died' },
        createdAt: new Date('2026-03-01T09:30:00.000Z'), ...overrides,
    };
}

function registration(overrides: Partial<RelayRegistration> = {}): RelayRegistration {
    return { id: 'reg-1', expoPushToken: TOKEN_A, name: 'marcus-iphone', minSeverity: 'warning', kinds: null, ...overrides };
}

function relayConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
    return {
        baseUrl: 'http://127.0.0.1:3000', statePath: '/dev/null', publicBaseUrl: 'https://farm.example',
        quietHours: null, timezone: 'UTC', coalesceWindowMs: 30_000, receiptDelayMs: 900_000,
        registrationRefreshMs: 30_000, ...overrides,
    };
}

/** Collects every Expo request so a test can assert the batching and the bodies. */
function fakeExpo(responder: (url: string, body: unknown) => unknown = () => ({ data: [] })) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: PushFetch = async (url, init) => {
        const body = JSON.parse(init.body) as unknown;
        calls.push({ url, body });
        const payload = responder(url, body);
        if (typeof payload === 'number') return { ok: false, status: payload, async json() { return {}; } };
        return { ok: true, status: 200, async json() { return payload; } };
    };
    return { calls, fetchImpl };
}

function recordingClient(): RelayClient & { deleted: string[]; errors: Array<[string, string]> } {
    const deleted: string[] = [];
    const errors: Array<[string, string]> = [];
    return {
        deleted, errors,
        async listRegistrations() { return []; },
        async deleteRegistration(id) { deleted.push(id); },
        async reportError(id, error) { errors.push([id, error]); },
    };
}

async function pushApp(): Promise<FastifyInstance> {
    const app = Fastify();
    await registerPushRoutes(app, {
        scheduler, events: createMemoryEventStore(), acks: createMemoryAckStore(),
        pushRegistrations: createMemoryRegistrationStore(),
    });
    return app;
}

/* ------------------------------------------------------------------ registrations */

test('Expo push tokens are validated, and only their suffix is ever echoed back', () => {
    assert.ok(isExpoPushToken(TOKEN_A));
    assert.ok(isExpoPushToken(TOKEN_B));
    assert.ok(!isExpoPushToken('ExponentPushToken[]'));
    assert.ok(!isExpoPushToken('fcm-token-1234'));
    assert.ok(!isExpoPushToken('ExponentPushToken[abc'));
    assert.ok(!isExpoPushToken(42));
    assert.equal(tokenSuffix(TOKEN_A), 'aaaaaa');
    assert.ok(!tokenSuffix(TOKEN_A).includes('['));
});

test('the register body is an explicit whitelist with defaults and rejections', () => {
    const parsed = parseRegistration({
        expoPushToken: TOKEN_A, name: '  marcus-iphone  ', kinds: ['execution.failed', 'execution.failed', 'device.error'],
        minSeverity: 'error', tokenId: 'spoofed', nonsense: true,
    }, 'token-1');
    assert.deepEqual(parsed, {
        expoPushToken: TOKEN_A, name: 'marcus-iphone', minSeverity: 'error',
        kinds: ['execution.failed', 'device.error'], tokenId: 'token-1',
    });
    // Defaults: no minSeverity is a warning floor, no kinds is every kind.
    assert.deepEqual(parseRegistration({ expoPushToken: TOKEN_B, name: 'x' }, 't').kinds, null);
    assert.equal(parseRegistration({ expoPushToken: TOKEN_B, name: 'x' }, 't').minSeverity, 'warning');

    for (const body of [
        { expoPushToken: 'nope', name: 'x' },
        { expoPushToken: TOKEN_A },
        { expoPushToken: TOKEN_A, name: 'x', minSeverity: 'loud' },
        { expoPushToken: TOKEN_A, name: 'x', kinds: ['execution.exploded'] },
        { expoPushToken: TOKEN_A, name: 'x', kinds: [] },
        { expoPushToken: TOKEN_A, name: 'x', kinds: 'execution.failed' },
    ]) {
        assert.throws(() => parseRegistration(body, 't'), /.+/, JSON.stringify(body));
    }
});

test('POST /api/push/register is idempotent on the token and refreshes lastSeenAt', async (context) => {
    const app = await pushApp();
    context.after(() => app.close());

    const created = await inject(app, {
        method: 'POST', url: '/api/push/register',
        payload: { expoPushToken: TOKEN_A, name: 'marcus-iphone', kinds: ['execution.failed'] },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().name, 'marcus-iphone');
    assert.equal(created.json().tokenSuffix, 'aaaaaa');
    assert.equal(created.json().minSeverity, 'warning');
    // The push token itself is never in the response.
    assert.ok(!JSON.stringify(created.json()).includes(TOKEN_A));

    const updated = await inject(app, {
        method: 'POST', url: '/api/push/register',
        payload: { expoPushToken: TOKEN_A, name: 'marcus-iphone-15', minSeverity: 'error' },
    });
    assert.equal(updated.statusCode, 200, 're-registering updates rather than creating');
    assert.equal(updated.json().id, created.json().id);
    assert.equal(updated.json().name, 'marcus-iphone-15');
    assert.equal(updated.json().kinds, null);
    assert.ok(Date.parse(updated.json().lastSeenAt) >= Date.parse(created.json().lastSeenAt));

    const listed = await inject(app, { method: 'GET', url: '/api/push/registrations' });
    assert.equal(listed.json().registrations.length, 1);

    const bad = await inject(app, { method: 'POST', url: '/api/push/register', payload: { expoPushToken: 'nope', name: 'x' } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /ExponentPushToken/);
});

test('DELETE /api/push/registrations/:id revokes one and 404s for anything else', async (context) => {
    const app = await pushApp();
    context.after(() => app.close());
    const created = await inject(app, {
        method: 'POST', url: '/api/push/register', payload: { expoPushToken: TOKEN_A, name: 'marcus-iphone' },
    });
    const { id } = created.json();

    assert.equal((await inject(app, { method: 'DELETE', url: `/api/push/registrations/${id}` })).statusCode, 204);
    assert.equal((await inject(app, { method: 'GET', url: '/api/push/registrations' })).json().registrations.length, 0);
    assert.equal((await inject(app, { method: 'DELETE', url: `/api/push/registrations/${id}` })).statusCode, 404);
    assert.equal((await inject(app, { method: 'DELETE', url: '/api/push/registrations/not-a-uuid' })).statusCode, 404);
});

test('the relay reports an Expo error back onto the registration', async (context) => {
    const app = await pushApp();
    context.after(() => app.close());
    const { id } = (await inject(app, {
        method: 'POST', url: '/api/push/register', payload: { expoPushToken: TOKEN_A, name: 'marcus-iphone' },
    })).json();

    assert.equal((await inject(app, {
        method: 'POST', url: `/api/push/registrations/${id}/error`, payload: { error: 'MessageRateExceeded' },
    })).statusCode, 204);
    const listed = (await inject(app, { method: 'GET', url: '/api/push/registrations' })).json();
    assert.equal(listed.registrations[0].lastError, 'MessageRateExceeded');
    assert.equal((await inject(app, {
        method: 'POST', url: `/api/push/registrations/${id}/error`, payload: { error: '  ' },
    })).statusCode, 400);
});

test('a registration matches on its kinds when set, and on the severity floor otherwise', () => {
    const floor = { minSeverity: 'warning' as const, kinds: null };
    assert.ok(matchesRegistration(floor, { kind: 'device.disconnected', severity: 'warning' }));
    assert.ok(matchesRegistration(floor, { kind: 'execution.failed', severity: 'error' }));
    assert.ok(!matchesRegistration(floor, { kind: 'execution.started', severity: 'info' }));

    const kinds = { minSeverity: 'error' as const, kinds: ['execution.started' as const] };
    assert.ok(matchesRegistration(kinds, { kind: 'execution.started', severity: 'info' }));
    assert.ok(!matchesRegistration(kinds, { kind: 'execution.failed', severity: 'error' }));
});

/* ------------------------------------------------------------------ acknowledgement */

test('acknowledgement is per token identity and never rewinds', async (context) => {
    const events = createMemoryEventStore();
    const seed = async (title: string): Promise<void> => {
        await events.record({ kind: 'execution.failed', severity: 'error', title } as EventInput);
    };
    for (const title of ['one', 'two', 'three', 'four']) await seed(title);

    const app = Fastify();
    context.after(() => app.close());
    await registerFleetRoutes(app, { scheduler, events, backgroundTasks: false });
    await registerPushRoutes(app, { scheduler, events, acks: createMemoryAckStore() });

    assert.deepEqual((await inject(app, { method: 'GET', url: '/api/events/unacknowledged-count' })).json(),
        { unacknowledgedCount: 4, upToId: 0 });

    const acked = await inject(app, { method: 'POST', url: '/api/events/ack', payload: { upToId: 2 } });
    assert.deepEqual(acked.json(), { acknowledged: 2, unacknowledgedCount: 2 });

    // Unfiltered is untouched; ?acknowledged=false hides what this token has read.
    assert.deepEqual((await inject(app, { method: 'GET', url: '/api/events' })).json()
        .events.map((event: { id: number }) => event.id), [4, 3, 2, 1]);
    assert.deepEqual((await inject(app, { method: 'GET', url: '/api/events?acknowledged=false' })).json()
        .events.map((event: { id: number }) => event.id), [4, 3]);

    // An older mark is ignored, and a re-ack acknowledges nothing new.
    assert.deepEqual((await inject(app, { method: 'POST', url: '/api/events/ack', payload: { upToId: 1 } })).json(),
        { acknowledged: 0, unacknowledgedCount: 2 });
    assert.equal((await inject(app, { method: 'POST', url: '/api/events/ack', payload: { upToId: 'soon' } })).statusCode, 400);
});

test('two token identities keep separate unread state', async (context) => {
    const events = createMemoryEventStore();
    await events.record({ kind: 'device.error', severity: 'error', title: 'one' } as EventInput);
    await events.record({ kind: 'device.error', severity: 'error', title: 'two' } as EventInput);

    const app = Fastify();
    context.after(() => app.close());
    // Stand in for the parallel auth branch's decoration: a header names the token.
    app.addHook('onRequest', async (request) => {
        const header = request.headers['x-test-token'];
        if (typeof header === 'string') Object.assign(request, { apiToken: { id: header, name: header } });
    });
    await registerFleetRoutes(app, { scheduler, events, backgroundTasks: false });
    await registerPushRoutes(app, { scheduler, events, acks: createMemoryAckStore() });

    await inject(app, { method: 'POST', url: '/api/events/ack', payload: { upToId: 2 }, headers: { 'x-test-token': 'phone-a' } });
    assert.equal((await inject(app, {
        method: 'GET', url: '/api/events/unacknowledged-count', headers: { 'x-test-token': 'phone-a' },
    })).json().unacknowledgedCount, 0);
    assert.equal((await inject(app, {
        method: 'GET', url: '/api/events/unacknowledged-count', headers: { 'x-test-token': 'phone-b' },
    })).json().unacknowledgedCount, 2);
    // No decoration at all falls back to the synthetic local identity.
    assert.equal((await inject(app, { method: 'GET', url: '/api/events/unacknowledged-count' })).json().unacknowledgedCount, 2);
});

/* ------------------------------------------------------------------ relay */

test('quiet hours wrap past midnight and let errors through', () => {
    const overnight = parseQuietHours('22:00-07:00');
    assert.deepEqual(overnight, { startMinutes: 1_320, endMinutes: 420 });
    assert.equal(parseQuietHours('lunchtime'), null);
    assert.equal(parseQuietHours('22:00-22:00'), null);

    const at = (iso: string) => inQuietHours(overnight, new Date(iso), 'UTC');
    assert.ok(at('2026-03-01T23:30:00.000Z'));
    assert.ok(at('2026-03-01T02:00:00.000Z'));
    assert.ok(!at('2026-03-01T12:00:00.000Z'));
    assert.ok(!at('2026-03-01T07:00:00.000Z'));
    // The same instant is outside the window an hour further east.
    assert.ok(!inQuietHours(overnight, new Date('2026-03-01T21:30:00.000Z'), 'UTC'));
    assert.ok(inQuietHours(overnight, new Date('2026-03-01T21:30:00.000Z'), 'Europe/Berlin'));

    assert.ok(passesQuietHours({ severity: 'error' }, true));
    assert.ok(!passesQuietHours({ severity: 'warning' }, true));
    assert.ok(passesQuietHours({ severity: 'info' }, false));
});

test('bursts coalesce to one push per registration per window, folded with a count', () => {
    const coalescer = createCoalescer(30_000);
    coalescer.add('reg-1', farmEvent({ id: 1 }));
    // The first event for a quiet registration goes straight out.
    const first = coalescer.drain(1_000);
    assert.deepEqual(first.map(({ key, events }) => [key, events.length]), [['reg-1', 1]]);

    coalescer.add('reg-1', farmEvent({ id: 2 }));
    coalescer.add('reg-1', farmEvent({ id: 3 }));
    coalescer.add('reg-2', farmEvent({ id: 4 }));
    // Inside the window reg-1 is held; reg-2 has never been sent to, so it fires.
    assert.deepEqual(coalescer.drain(5_000).map(({ key }) => key), ['reg-2']);
    assert.equal(coalescer.size, 1);

    const folded = coalescer.drain(31_001);
    assert.deepEqual(folded.map(({ key, events }) => [key, events.map((event) => event.id)]), [['reg-1', [2, 3]]]);
    assert.equal(coalescer.size, 0);

    const message = pushMessage(registration(), folded[0]!.events, 'https://farm.example');
    assert.equal(message.title, '2 farm alerts');
    assert.match(message.body, /and 1 more/);
    assert.equal(message.data.count, 2);
    assert.equal(message.data.eventId, 3);
    assert.equal(message.priority, 'high');

    const single = pushMessage(registration(), [farmEvent()], '');
    assert.equal(single.title, 'Doomscroll failed on udid-a');
    assert.equal(single.body, 'WDA session died');
    assert.equal(single.to, TOKEN_A);
    assert.equal(single.sound, 'default');
    assert.equal(single.data.count, 1);
});

test('messages go to Expo in batches of at most 100, retrying 429 and 5xx', async () => {
    assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
    assert.ok(isRetryableStatus(429) && isRetryableStatus(503) && !isRetryableStatus(400));

    const messages = Array.from({ length: 150 }, (_value, index) =>
        pushMessage(registration({ expoPushToken: TOKEN_A }), [farmEvent({ id: index + 1 })]));
    const { calls, fetchImpl } = fakeExpo((_url, body) => ({
        data: (body as unknown[]).map((_message, index) => ({ status: 'ok', id: `ticket-${index}` })),
    }));
    const tickets = await sendExpoMessages(messages, { fetchImpl, sleep: async () => {} });
    assert.equal(calls.length, 2, '150 messages is two requests');
    assert.equal(calls[0]!.url, EXPO_PUSH_URL);
    assert.equal((calls[0]!.body as unknown[]).length, 100);
    assert.equal((calls[1]!.body as unknown[]).length, 50);
    assert.equal(tickets.length, 150);

    const delays: number[] = [];
    const flaky = fakeExpo(() => 429);
    const failed = await sendExpoMessages(messages.slice(0, 1), {
        fetchImpl: flaky.fetchImpl, sleep: async (ms) => { delays.push(ms); },
    });
    assert.equal(flaky.calls.length, 4, 'one attempt plus three retries');
    assert.deepEqual(delays, [1_000, 2_000, 4_000]);
    assert.equal(failed[0]!.status, 'error');

    // A 400 is not worth retrying.
    const rejected = fakeExpo(() => 400);
    await sendExpoMessages(messages.slice(0, 1), { fetchImpl: rejected.fetchImpl, sleep: async () => {} });
    assert.equal(rejected.calls.length, 1);
});

test('sendBatches drops a DeviceNotRegistered token and records other errors', async () => {
    const client = recordingClient();
    const tickets: ExpoTicket[] = [
        { status: 'ok', id: 'ticket-1' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', message: 'MessageRateExceeded' },
    ];
    const { fetchImpl } = fakeExpo(() => ({ data: tickets }));
    const batches = ['reg-1', 'reg-2', 'reg-3'].map((id) => ({
        registration: registration({ id }), events: [farmEvent({ id: 1 })],
    }));
    const outcome = await sendBatches(batches, { config: relayConfig(), client, fetchImpl, sleep: async () => {} }, 1_000);

    assert.deepEqual(outcome.receipts, [{ ticketId: 'ticket-1', registrationId: 'reg-1', dueAt: 901_000 }]);
    assert.deepEqual(client.deleted, ['reg-2']);
    assert.deepEqual(client.errors, [['reg-3', 'MessageRateExceeded']]);
    // reg-3 was rate limited, so its event still holds the relay's cursor back;
    // reg-2's device is gone for good and does not.
    assert.equal(outcome.lowestUndelivered, 1);
});

test('receipts are read 15 minutes later and prune the tokens Expo has given up on', async () => {
    const client = recordingClient();
    const pending: PendingReceipt[] = [
        { ticketId: 'ticket-1', registrationId: 'reg-1', dueAt: 1_000 },
        { ticketId: 'ticket-2', registrationId: 'reg-2', dueAt: 1_000 },
        { ticketId: 'ticket-3', registrationId: 'reg-3', dueAt: 900_000 },
    ];
    const { calls, fetchImpl } = fakeExpo(() => ({
        data: {
            'ticket-1': { status: 'ok' },
            'ticket-2': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
        },
    }));
    const options = { config: relayConfig(), client, fetchImpl, sleep: async () => {} };

    // Nothing is due yet at t=0.
    assert.equal((await settleReceipts(pending, options, 0)).length, 3);
    assert.equal(calls.length, 0);

    const remaining = await settleReceipts(pending, options, 2_000);
    assert.equal(calls[0]!.url, EXPO_RECEIPT_URL);
    assert.deepEqual((calls[0]!.body as { ids: string[] }).ids, ['ticket-1', 'ticket-2']);
    assert.deepEqual(client.deleted, ['reg-2']);
    assert.deepEqual(remaining.map(({ ticketId }) => ticketId), ['ticket-3']);
    assert.ok(isDeviceNotRegistered({ status: 'error', details: { error: 'DeviceNotRegistered' } }));
    assert.ok(!isDeviceNotRegistered({ status: 'error', details: { error: 'MessageTooBig' } }));

    // A non-fatal receipt error lands in last_error instead.
    const other = fakeExpo(() => ({ data: { 'ticket-3': { status: 'error', message: 'MessageTooBig' } } }));
    await settleReceipts([pending[2]!], { ...options, fetchImpl: other.fetchImpl }, 900_001);
    assert.deepEqual(client.errors, [['reg-3', 'MessageTooBig']]);
});

test('the relay parses the farm SSE framing and persists its cursor', async (context) => {
    const parser = createSseParser();
    assert.deepEqual(parser.push(': connected\n\n'), []);
    assert.deepEqual(parser.push('id: 42\nevent: execution.failed\ndata: {"id":42,'), []);
    const messages = parser.push('"kind":"execution.failed","severity":"error","title":"boom"}\n\n: heartbeat\n\n');
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.id, '42');
    assert.equal(messages[0]!.event, 'execution.failed');

    const event = parseStreamEvent(messages[0]!)!;
    assert.equal(event.id, 42);
    assert.equal(event.severity, 'error');
    assert.equal(parseStreamEvent({ data: 'not json' }), null);
    assert.equal(parseStreamEvent({ data: '{"id":1,"kind":"nope","severity":"error"}' }), null);

    assert.ok(sseBackoffDelay(0, () => 0) >= 500 && sseBackoffDelay(0, () => 1) <= 1_000);
    assert.ok(sseBackoffDelay(20, () => 1) <= 30_000);

    const directory = await mkdtemp(path.join(tmpdir(), 'push-relay-'));
    const statePath = path.join(directory, 'push-relay.json');
    assert.deepEqual(await readRelayState(statePath), { lastEventId: 0 });
    await writeRelayState(statePath, { lastEventId: 42 });
    assert.deepEqual(await readRelayState(statePath), { lastEventId: 42 });
    assert.match(await readFile(statePath, 'utf8'), /"lastEventId": 42/);
    context.after(async () => {});
});

test('the relay reads its configuration from the environment, loopback by default', () => {
    const defaults = relayConfigFromEnv({ SCHEDULER_DATA_DIR: '/tmp/farm-data' } as NodeJS.ProcessEnv);
    assert.equal(defaults.baseUrl, 'http://127.0.0.1:3000');
    assert.equal(defaults.token, undefined);
    assert.equal(defaults.statePath, '/tmp/farm-data/push-relay.json');
    assert.equal(defaults.quietHours, null);
    assert.equal(defaults.coalesceWindowMs, 30_000);
    assert.equal(defaults.receiptDelayMs, 900_000);

    const configured = relayConfigFromEnv({
        FARM_BASE_URL: 'https://farm.example/', FARM_API_TOKEN: 'secret', SCHEDULER_DATA_DIR: '/tmp/farm-data',
        PUSH_QUIET_HOURS: '22:00-07:00', PUSH_TIMEZONE: 'Europe/London', PUBLIC_BASE_URL: 'https://farm.example/',
    } as NodeJS.ProcessEnv);
    assert.equal(configured.baseUrl, 'https://farm.example');
    assert.equal(configured.token, 'secret');
    assert.equal(configured.timezone, 'Europe/London');
    assert.deepEqual(configured.quietHours, { startMinutes: 1_320, endMinutes: 420 });
});

test('the relay client talks to the farm over the public API, bearer token included', async () => {
    const requests: Array<{ url: string; method: string; auth: string | undefined }> = [];
    const fetchImpl = (async (url: string, init: { method?: string; headers: Record<string, string> }) => {
        requests.push({ url, method: init.method ?? 'GET', auth: init.headers.authorization });
        return { ok: true, status: 200, async json() { return { registrations: [{ id: 'reg-1' }] }; } };
    }) as unknown as typeof fetch;
    const client = createRelayClient({ baseUrl: 'https://farm.example', token: 'secret' }, fetchImpl);

    assert.deepEqual(await client.listRegistrations(), [{ id: 'reg-1' }] as unknown as RelayRegistration[]);
    await client.deleteRegistration('reg-1');
    await client.reportError('reg-1', 'MessageTooBig');
    assert.deepEqual(requests.map(({ url, method }) => [method, url]), [
        ['GET', 'https://farm.example/api/push/registrations'],
        ['DELETE', 'https://farm.example/api/push/registrations/reg-1'],
        ['POST', 'https://farm.example/api/push/registrations/reg-1/error'],
    ]);
    assert.ok(requests.every(({ auth }) => auth === 'Bearer secret'));

    // Loopback with no token sends no Authorization header at all.
    const open = createRelayClient({ baseUrl: 'http://127.0.0.1:3000' }, fetchImpl);
    await open.deleteRegistration('reg-2');
    assert.equal(requests[3]!.auth, undefined);
});

test('an unfetched receipt lookup and an empty batch are both no-ops', async () => {
    const { calls, fetchImpl } = fakeExpo();
    assert.deepEqual(await fetchExpoReceipts([], { fetchImpl }), {});
    assert.deepEqual(await sendBatches([], { config: relayConfig(), client: recordingClient(), fetchImpl }, 0),
        { receipts: [], lowestUndelivered: null });
    assert.equal(calls.length, 0);
});


/* ------------------------------------------------- relay cursor and shutdown */

test('quiet hours hold across a DST change and around midnight', () => {
    const overnight = parseQuietHours('22:00-07:00')!;
    // Europe/London springs forward at 01:00 UTC on 2026-03-29. 23:30 local is
    // inside the window on either side of it, and 07:30 local is outside.
    assert.ok(inQuietHours(overnight, new Date('2026-03-28T23:30:00.000Z'), 'Europe/London'));
    assert.ok(inQuietHours(overnight, new Date('2026-03-29T22:30:00.000Z'), 'Europe/London'));
    // 08:30 UTC on 29 March is 09:30 BST — morning, not quiet.
    assert.ok(!inQuietHours(overnight, new Date('2026-03-29T08:30:00.000Z'), 'Europe/London'));
    // 06:30 UTC is 07:30 BST, just past the end of the window.
    assert.ok(!inQuietHours(overnight, new Date('2026-03-29T06:30:00.000Z'), 'Europe/London'));
    // 05:30 UTC is 06:30 BST, still inside it.
    assert.ok(inQuietHours(overnight, new Date('2026-03-29T05:30:00.000Z'), 'Europe/London'));

    // Exactly midnight, and the two boundary minutes.
    assert.ok(inQuietHours(overnight, new Date('2026-03-01T00:00:00.000Z'), 'UTC'));
    assert.ok(inQuietHours(overnight, new Date('2026-03-01T22:00:00.000Z'), 'UTC'));
    assert.ok(!inQuietHours(overnight, new Date('2026-03-01T21:59:00.000Z'), 'UTC'));
    assert.ok(!inQuietHours(overnight, new Date('2026-03-01T07:00:00.000Z'), 'UTC'));
    assert.ok(inQuietHours(overnight, new Date('2026-03-01T06:59:00.000Z'), 'UTC'));

    // A daytime window does not wrap.
    const daytime = parseQuietHours('09:00-17:00')!;
    assert.ok(inQuietHours(daytime, new Date('2026-03-01T12:00:00.000Z'), 'UTC'));
    assert.ok(!inQuietHours(daytime, new Date('2026-03-01T23:00:00.000Z'), 'UTC'));
});

test('an oversized push is cut down rather than rejected as MessageTooBig', () => {
    const huge = pushMessage(registration(), [farmEvent({
        title: 'x'.repeat(5_000),
        detail: { error: 'y'.repeat(9_000) },
    })], 'https://farm.example');
    const capped = capExpoMessage(huge);
    assert.ok(Buffer.byteLength(JSON.stringify(capped), 'utf8') <= EXPO_MESSAGE_LIMIT_BYTES);
    // A message already inside the limit is untouched.
    const small = pushMessage(registration(), [farmEvent()], '');
    assert.deepEqual(capExpoMessage(small), small);

    assert.equal(isRetryableTicketError({ status: 'error', details: { error: 'MessageRateExceeded' } }), true);
    assert.equal(isRetryableTicketError({ status: 'error', details: { error: 'DeviceNotRegistered' } }), false);
    assert.equal(isRetryableTicketError({ status: 'ok' }), false);
});

/** A source that yields a fixed script of events and then ends the connection. */
function scriptedSource(events: FarmEvent[]) {
    const seen: number[] = [];
    return {
        seen,
        connect(lastEventId: number) {
            seen.push(lastEventId);
            return (async function* stream() {
                for (const event of events) {
                    if (event.id <= lastEventId) continue;
                    yield { data: JSON.stringify({ ...event, createdAt: event.createdAt.toISOString() }) };
                }
            })();
        },
    };
}

async function runOnce(options: {
    events: FarmEvent[];
    statePath: string;
    registrations?: RelayRegistration[];
    config?: Partial<RelayConfig>;
    tickets?: ExpoTicket[];
}): Promise<{ pushed: unknown[]; seen: number[] }> {
    const controller = new AbortController();
    const source = scriptedSource(options.events);
    const { calls, fetchImpl } = fakeExpo(() => ({ data: options.tickets ?? options.events.map((_event, index) => ({ status: 'ok', id: `ticket-${index}` })) }));
    const client: RelayClient = {
        async listRegistrations() { return options.registrations ?? [registration()]; },
        async deleteRegistration() {},
        async reportError() {},
    };
    // The scripted source ends immediately, so the relay would reconnect for
    // ever; abort as soon as the first pass through the stream is done.
    const sleep = async (): Promise<void> => { controller.abort(); };
    await runRelay({
        config: relayConfig({ statePath: options.statePath, coalesceWindowMs: 0, ...options.config }),
        client, source, fetchImpl, sleep, log: () => {}, signal: controller.signal,
    });
    return { pushed: calls, seen: source.seen };
}

test('the relay cursor advances past events nobody wanted, and stops at one Expo refused', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'push-relay-cursor-'));

    // No registrations at all: the events are settled the moment they are seen,
    // so a farm nobody has registered a phone with does not replay its history.
    const quiet = path.join(directory, 'quiet.json');
    await runOnce({ statePath: quiet, registrations: [], events: [farmEvent({ id: 10 }), farmEvent({ id: 11 })] });
    assert.deepEqual(await readRelayState(quiet), { lastEventId: 11 });

    // Quiet hours drop a warning: same story, the cursor still moves.
    const overnight = path.join(directory, 'overnight.json');
    await runOnce({
        statePath: overnight, registrations: [registration()],
        config: { quietHours: parseQuietHours('00:00-23:59') },
        events: [farmEvent({ id: 20, severity: 'warning' })],
    });
    assert.deepEqual(await readRelayState(overnight), { lastEventId: 20 });

    // Expo refuses the message: the cursor stops just below it so the next start
    // replays rather than losing the alert.
    const refused = path.join(directory, 'refused.json');
    await runOnce({
        statePath: refused,
        events: [farmEvent({ id: 30 })],
        tickets: [{ status: 'error', message: 'MessageRateExceeded' }],
    });
    assert.deepEqual(await readRelayState(refused), { lastEventId: 29 });

    // A successful send does move it, and the next connect resumes from there.
    const sent = path.join(directory, 'sent.json');
    await runOnce({ statePath: sent, events: [farmEvent({ id: 40 })] });
    assert.deepEqual(await readRelayState(sent), { lastEventId: 40 });
    const second = await runOnce({ statePath: sent, events: [farmEvent({ id: 41 })] });
    assert.deepEqual(second.seen, [40]);
});

test('shutdown flushes whatever the coalescing window is still holding', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'push-relay-shutdown-'));
    const statePath = path.join(directory, 'state.json');
    // A window long enough that nothing would drain on its own before the abort.
    const { pushed } = await runOnce({
        statePath,
        config: { coalesceWindowMs: 600_000 },
        events: [farmEvent({ id: 50 }), farmEvent({ id: 51 })],
        tickets: [{ status: 'ok', id: 'ticket-0' }],
    });
    // Both events reached Expo, folded into one message, and the cursor moved.
    assert.ok(pushed.length >= 1);
    assert.deepEqual(await readRelayState(statePath), { lastEventId: 51 });
});

test('the coalescer forgets registrations that stopped receiving', () => {
    const coalescer = createCoalescer(1_000);
    coalescer.add('reg-1', farmEvent({ id: 1 }));
    coalescer.drain(0);
    assert.equal(coalescer.lowestPendingId(), null);

    coalescer.add('reg-1', farmEvent({ id: 5 }));
    coalescer.add('reg-2', farmEvent({ id: 3 }));
    // The oldest event still held is what pins the relay cursor.
    assert.equal(coalescer.lowestPendingId(), 3);

    // force ignores the window — the shutdown path.
    assert.deepEqual(coalescer.drain(0, true).map(({ key }) => key).sort(), ['reg-1', 'reg-2']);
    assert.equal(coalescer.lowestPendingId(), null);
});
