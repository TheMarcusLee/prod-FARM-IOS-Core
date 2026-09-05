import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';

import { inject } from './support.js';
import { registerFleetRoutes } from '../src/api/routes/fleet.js';
import type { ExecutionRow, ScheduleRow } from '../src/database/schema.js';
import type { FarmEvent } from '../src/fleet/events.js';
import { createMemoryEventStore } from '../src/fleet/events.js';
import { createEventRecorder } from '../src/fleet/recorder.js';
import { notificationConfigFromEnv, type NotificationConfig } from '../src/notifications/config.js';
import {
    backoffDelay, deliverEvent, isRetryableStatus, MAX_BACKOFF_MS, postJson, shouldNotify, type FetchLike,
} from '../src/notifications/deliver.js';
import {
    buildDigest, digestDueAt, nextDigestAt, previousDigestAt, startDigestScheduler, tallyByDeviceAndAccount,
} from '../src/notifications/digest.js';
import {
    discordPayload, headerSafe, ntfyRequest, slackPayload, truncate, webhookPayload,
    DISCORD_LIMITS, NTFY_PRIORITY, NTFY_TAGS, SEVERITY_COLOURS, SLACK_LIMITS,
} from '../src/notifications/payloads.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import type { JsonObject } from '../src/types.js';

const CREATED_AT = new Date('2026-03-01T09:30:00.000Z');

function event(overrides: Partial<FarmEvent> = {}): FarmEvent {
    return {
        id: 42, kind: 'execution.failed', severity: 'error', deviceUdid: 'udid-a',
        executionId: '3f8f4e0e-0000-4000-8000-000000000001', scheduleId: null,
        title: 'Doomscroll failed on udid-a', detail: { error: 'WDA session died' },
        createdAt: CREATED_AT, ...overrides,
    };
}

function config(overrides: Partial<NotificationConfig> = {}): NotificationConfig {
    return {
        channels: [{ name: 'webhook', url: 'https://hooks.example/webhook' }],
        minSeverity: 'warning', digestLocalTime: '08:00', digestTimezone: 'UTC',
        publicBaseUrl: 'https://farm.example', ...overrides,
    };
}

/** Records every request so a test can assert the exact body a channel receives. */
function recordingFetch(responder: (url: string) => { ok: boolean; status: number } = () => ({ ok: true, status: 200 })) {
    const calls: Array<{ url: string; body: JsonObject }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) as JsonObject });
        return responder(url);
    };
    return { calls, fetchImpl };
}

function executionRow(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
    return {
        id: 'exec-1', scheduleId: null, deviceUdid: 'udid-a',
        pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1, payload: { account: '@one' },
        scheduledFor: new Date('2026-03-01T08:00:00.000Z'), deadlineAt: new Date('2026-03-01T08:30:00.000Z'),
        status: 'succeeded', queueJobId: null, startedAt: new Date('2026-03-01T08:00:00.000Z'),
        finishedAt: new Date('2026-03-01T08:05:00.000Z'), exitCode: 0, error: null, stopRequestedAt: null,
        createdAt: new Date('2026-03-01T08:00:00.000Z'), updatedAt: new Date('2026-03-01T08:05:00.000Z'),
        ...overrides,
    } as ExecutionRow;
}

function scheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
    return {
        id: 'sched-1', deviceUdid: 'udid-a', pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1,
        payload: {}, timing: { kind: 'daily', localTime: '09:00', timezone: 'UTC' }, status: 'active',
        runWindowMinutes: 30, nextRunAt: new Date('2026-03-01T18:00:00.000Z'),
        createdAt: CREATED_AT, updatedAt: CREATED_AT, ...overrides,
    } as ScheduleRow;
}

test('channels, severity floor and digest settings are read from the environment', () => {
    const parsed = notificationConfigFromEnv({
        NOTIFY_WEBHOOK_URL: 'https://hooks.example/webhook',
        NOTIFY_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
        NOTIFY_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x',
        NOTIFY_NTFY_URL: 'https://ntfy.sh/farm-alerts-9f2a', NOTIFY_NTFY_TOKEN: 'tk_secret',
        NOTIFY_MIN_SEVERITY: 'error', NOTIFY_KINDS: 'execution.failed, nonsense ,digest.daily',
        DIGEST_LOCAL_TIME: '07:15', DIGEST_TIMEZONE: 'Europe/London', PUBLIC_BASE_URL: 'https://farm.example/',
    } as NodeJS.ProcessEnv);
    assert.deepEqual(parsed.channels.map(({ name }) => name), ['webhook', 'slack', 'discord', 'ntfy']);
    assert.equal(parsed.channels[3]!.token, 'tk_secret');
    assert.equal(parsed.minSeverity, 'error');
    assert.deepEqual(parsed.kinds, ['execution.failed', 'digest.daily']);
    assert.equal(parsed.digestLocalTime, '07:15');
    assert.equal(parsed.digestTimezone, 'Europe/London');
    assert.equal(parsed.publicBaseUrl, 'https://farm.example');

    const defaults = notificationConfigFromEnv({} as NodeJS.ProcessEnv);
    assert.deepEqual(defaults.channels, []);
    assert.equal(defaults.minSeverity, 'warning');
    assert.equal(defaults.kinds, undefined);
    assert.equal(defaults.digestLocalTime, '08:00');
    assert.equal(defaults.digestTimezone, 'UTC');

    // Junk values fall back rather than throwing on boot.
    const junk = notificationConfigFromEnv({
        NOTIFY_WEBHOOK_URL: 'file:///etc/passwd', NOTIFY_MIN_SEVERITY: 'loud', DIGEST_LOCAL_TIME: '99:99',
    } as NodeJS.ProcessEnv);
    assert.deepEqual(junk.channels, []);
    assert.equal(junk.minSeverity, 'warning');
    assert.equal(junk.digestLocalTime, '08:00');
});

test('severity filtering keeps quiet events out, and NOTIFY_KINDS overrides it', () => {
    const warningFloor = config();
    assert.equal(shouldNotify({ kind: 'execution.failed', severity: 'error' }, warningFloor), true);
    assert.equal(shouldNotify({ kind: 'device.disconnected', severity: 'warning' }, warningFloor), true);
    assert.equal(shouldNotify({ kind: 'execution.started', severity: 'info' }, warningFloor), false);

    const kindsOnly = config({ minSeverity: 'error', kinds: ['execution.started', 'digest.daily'] });
    assert.equal(shouldNotify({ kind: 'execution.started', severity: 'info' }, kindsOnly), true);
    assert.equal(shouldNotify({ kind: 'execution.failed', severity: 'error' }, kindsOnly), false);
});

test('the generic webhook posts the whole event under an "event" key', () => {
    const payload = webhookPayload(event());
    assert.deepEqual(payload, {
        event: {
            id: 42, kind: 'execution.failed', severity: 'error', deviceUdid: 'udid-a',
            executionId: '3f8f4e0e-0000-4000-8000-000000000001', scheduleId: null,
            title: 'Doomscroll failed on udid-a', detail: { error: 'WDA session died' },
            createdAt: CREATED_AT.toISOString(),
        },
    });
});

test('the Slack payload is Block Kit: header, device/kind/time fields, code block, link', () => {
    const payload = slackPayload(event(), 'https://farm.example');
    const blocks = payload.blocks as Array<Record<string, unknown>>;
    assert.equal(blocks[0]!.type, 'header');
    assert.match(String((blocks[0]!.text as { text: string }).text), /Doomscroll failed on udid-a/);

    const fields = (blocks[1]!.fields as Array<{ text: string }>).map(({ text }) => text);
    assert.ok(fields.some((text) => text.includes('*Device*\nudid-a')));
    assert.ok(fields.some((text) => text.includes('*Kind*\nexecution.failed')));
    assert.ok(fields.some((text) => text.includes(`*Time*\n${CREATED_AT.toISOString()}`)));

    assert.equal((blocks[2]!.text as { text: string }).text, '```WDA session died```');
    const button = (blocks[3]!.elements as Array<{ url: string }>)[0]!;
    assert.equal(button.url, 'https://farm.example/api/executions/3f8f4e0e-0000-4000-8000-000000000001');

    // No error text and no base URL: no code block and no link block.
    const quiet = slackPayload(event({ severity: 'info', kind: 'execution.started', detail: null }), '');
    assert.equal((quiet.blocks as unknown[]).length, 2);
});

test('the Discord embed is coloured by severity and links back to the execution', () => {
    const payload = discordPayload(event(), 'https://farm.example');
    const embed = (payload.embeds as Array<Record<string, unknown>>)[0]!;
    assert.equal(embed.color, SEVERITY_COLOURS.error);
    assert.equal(embed.timestamp, CREATED_AT.toISOString());
    assert.equal(embed.url, 'https://farm.example/api/executions/3f8f4e0e-0000-4000-8000-000000000001');
    const fields = embed.fields as Array<{ name: string; value: string }>;
    assert.deepEqual(fields.slice(0, 3).map(({ name }) => name), ['Device', 'Kind', 'Severity']);
    assert.match(fields[3]!.value, /```WDA session died```/);

    assert.equal(((discordPayload(event({ severity: 'warning' })).embeds as Array<{ color: number }>)[0]!).color, SEVERITY_COLOURS.warning);
    assert.equal(((discordPayload(event({ severity: 'info' })).embeds as Array<{ color: number }>)[0]!).color, SEVERITY_COLOURS.info);
});

test('a failing channel is retried three times with exponential backoff and never throws', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await postJson('https://hooks.example/webhook', { hello: 'world' }, {
        fetchImpl: async () => { attempts++; return { ok: false, status: 500 }; },
        sleep: async (ms) => { delays.push(ms); },
    });
    assert.equal(attempts, 4, 'one attempt plus three retries');
    assert.deepEqual(delays, [backoffDelay(0), backoffDelay(1), backoffDelay(2)]);
    assert.deepEqual(delays, [500, 1_000, 2_000]);
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.equal(result.attempts, 4);

    // A transport error is retried the same way, and reported rather than thrown.
    const thrown = await postJson('https://hooks.example/webhook', {}, {
        fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, sleep: async () => {},
    });
    assert.equal(thrown.ok, false);
    assert.match(String(thrown.error), /ECONNREFUSED/);

    // A retry that eventually succeeds stops retrying.
    let calls = 0;
    const recovered = await postJson('https://hooks.example/webhook', {}, {
        fetchImpl: async () => ({ ok: ++calls === 2, status: calls === 2 ? 204 : 502 }), sleep: async () => {},
    });
    assert.deepEqual([recovered.ok, recovered.attempts, recovered.status], [true, 2, 204]);
});

test('deliverEvent posts the right payload to every configured channel and reports each result', async () => {
    const { calls, fetchImpl } = recordingFetch((url) => ({ ok: !url.includes('discord'), status: url.includes('discord') ? 503 : 200 }));
    const results = await deliverEvent(event(), config({
        channels: [
            { name: 'webhook', url: 'https://hooks.example/webhook' },
            { name: 'slack', url: 'https://hooks.slack.com/services/x' },
            { name: 'discord', url: 'https://discord.com/api/webhooks/x' },
        ],
    }), { fetchImpl, sleep: async () => {} });

    assert.deepEqual(results.map(({ channel, ok }) => [channel, ok]), [['webhook', true], ['slack', true], ['discord', false]]);
    assert.ok('event' in calls[0]!.body);
    assert.ok('blocks' in calls[1]!.body);
    assert.ok('embeds' in calls[2]!.body);
    // The failed Discord post was retried; the successful ones were not.
    assert.equal(calls.filter(({ url }) => url.includes('discord')).length, 4);
});

test('a 4xx that will never succeed is not retried, but 429 and 5xx are', async () => {
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(502), true);
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(408), true);
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(403), false);

    // A revoked Slack webhook answers 404 for good; hammering it three more
    // times only spends somebody's rate limit on the same failure.
    const gone = await postJson('https://hooks.slack.com/services/revoked', {}, {
        fetchImpl: async () => ({ ok: false, status: 404 }), sleep: async () => {},
    });
    assert.deepEqual([gone.ok, gone.attempts, gone.status], [false, 1, 404]);

    const throttled = await postJson('https://hooks.slack.com/services/busy', {}, {
        fetchImpl: async () => ({ ok: false, status: 429 }), sleep: async () => {},
    });
    assert.equal(throttled.attempts, 4);

    // Backoff is bounded rather than doubling forever.
    assert.equal(backoffDelay(0), 500);
    assert.equal(backoffDelay(2), 2_000);
    assert.equal(backoffDelay(20), MAX_BACKOFF_MS);
});

test('the recorder stores the event and delivers it without blocking or throwing', async () => {
    const store = createMemoryEventStore();
    const { calls, fetchImpl } = recordingFetch();
    const recorder = createEventRecorder(store, {
        notifications: config(), delivery: { fetchImpl, sleep: async () => {} }, log: () => {},
    });
    const recorded = await recorder.record({ kind: 'execution.failed', severity: 'error', title: 'boom' });
    assert.equal(recorded?.id, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);

    // An info event is stored but stays below the warning floor.
    await recorder.record({ kind: 'execution.started', severity: 'info', title: 'quiet' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(store.events.length, 2);

    // A store that throws is logged, not propagated.
    const logged: string[] = [];
    const broken = createEventRecorder(
        { ...store, record: async () => { throw new Error('database gone'); } },
        { log: (message) => logged.push(message) },
    );
    assert.equal(await broken.record({ kind: 'device.error', severity: 'error', title: 'x' }), null);
    assert.match(logged[0]!, /database gone/);
});

test('the daily digest aggregates posts per device and account, offline devices and stuck runs', () => {
    const now = new Date('2026-03-01T08:00:00.000Z');
    const executions = [
        executionRow({ id: 'e1', deviceUdid: 'udid-a', payload: { account: '@one' }, status: 'succeeded', finishedAt: new Date('2026-03-01T07:00:00.000Z') }),
        executionRow({ id: 'e2', deviceUdid: 'udid-a', payload: { account: '@one' }, status: 'failed', finishedAt: new Date('2026-03-01T06:00:00.000Z') }),
        executionRow({ id: 'e3', deviceUdid: 'udid-a', payload: { account: '@two' }, status: 'succeeded', finishedAt: new Date('2026-03-01T05:00:00.000Z') }),
        executionRow({ id: 'e4', deviceUdid: 'udid-b', payload: {}, status: 'succeeded', finishedAt: new Date('2026-03-01T04:00:00.000Z') }),
        // Older than the 24 h window — excluded.
        executionRow({ id: 'e5', deviceUdid: 'udid-b', payload: { account: '@three' }, status: 'failed', finishedAt: new Date('2026-02-20T04:00:00.000Z') }),
        // Running well past its deadline — stuck.
        executionRow({ id: 'e6', deviceUdid: 'udid-c', status: 'running', finishedAt: null, deadlineAt: new Date('2026-03-01T07:00:00.000Z') }),
    ];
    const digest = buildDigest({
        now, executions,
        schedules: [scheduleRow(), scheduleRow({ id: 'sched-2', nextRunAt: new Date('2026-03-09T00:00:00.000Z') }), scheduleRow({ id: 'sched-3', status: 'paused' })],
        offlineDevices: [{ deviceUdid: 'udid-d', since: '2026-03-01T05:00:00.000Z', minutes: 180 }],
    });

    assert.equal(digest.kind, 'digest.daily');
    assert.equal(digest.severity, 'warning');
    const detail = digest.detail as Record<string, unknown>;
    assert.deepEqual(detail.totals, { succeeded: 3, failed: 1 });
    assert.deepEqual(detail.byDeviceAccount, [
        { deviceUdid: 'udid-a', account: '@one', succeeded: 1, failed: 1 },
        { deviceUdid: 'udid-a', account: '@two', succeeded: 1, failed: 0 },
        { deviceUdid: 'udid-b', account: '(no account)', succeeded: 1, failed: 0 },
    ]);
    assert.deepEqual(detail.offlineOverAnHour, [{ deviceUdid: 'udid-d', since: '2026-03-01T05:00:00.000Z', minutes: 180 }]);
    assert.deepEqual(detail.stuckExecutions, [
        { executionId: 'e6', deviceUdid: 'udid-c', deadlineAt: '2026-03-01T07:00:00.000Z' },
    ]);
    // Only sched-1 falls inside the next 24 h.
    assert.equal(detail.plannedNext24h, 1);
    assert.match(digest.title, /3 succeeded, 1 failed, 1 offline, 1 planned/);

    // A clean day is informational.
    const clean = buildDigest({ now, executions: [], schedules: [], offlineDevices: [] });
    assert.equal(clean.severity, 'info');
    assert.deepEqual(tallyByDeviceAndAccount([], now), []);
});

test('the digest fires at DIGEST_LOCAL_TIME in DIGEST_TIMEZONE', () => {
    const next = nextDigestAt('08:00', 'Europe/London', new Date('2026-06-01T09:00:00.000Z'));
    // June is BST (UTC+1), so 08:00 local is 07:00 UTC the following day.
    assert.equal(next.toISOString(), '2026-06-02T07:00:00.000Z');
    assert.equal(nextDigestAt('08:00', 'UTC', new Date('2026-06-01T07:00:00.000Z')).toISOString(), '2026-06-01T08:00:00.000Z');
});

test('POST /api/notifications/test reports a per-channel result', async (context) => {
    const scheduler = { async listExecutions() { return []; }, async listSchedules() { return []; } } as unknown as SchedulerRepository;
    const { calls, fetchImpl } = recordingFetch((url) => ({ ok: !url.includes('slack'), status: url.includes('slack') ? 500 : 200 }));
    const app = Fastify();
    context.after(() => app.close());
    await registerFleetRoutes(app, {
        scheduler, events: createMemoryEventStore(), backgroundTasks: false,
        delivery: { fetchImpl, sleep: async () => {} },
        notifications: config({
            channels: [
                { name: 'webhook', url: 'https://hooks.example/webhook' },
                { name: 'slack', url: 'https://hooks.slack.com/services/x' },
            ],
        }),
    });

    const response = await inject(app, { method: 'POST', url: '/api/notifications/test', payload: {} });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, false);
    assert.deepEqual(response.json().channels.map((result: { channel: string; ok: boolean }) => [result.channel, result.ok]),
        [['webhook', true], ['slack', false]]);
    assert.equal(calls[0]!.url, 'https://hooks.example/webhook');

    const bare = Fastify();
    context.after(() => bare.close());
    await registerFleetRoutes(bare, { scheduler, events: createMemoryEventStore(), backgroundTasks: false, notifications: config({ channels: [] }) });
    const none = await inject(bare, { method: 'POST', url: '/api/notifications/test', payload: {} });
    assert.equal(none.statusCode, 409);
});

test('the ntfy publish maps severity to a priority, kind to an emoji tag, and links back', () => {
    const request = ntfyRequest(event(), { token: 'tk_secret' }, 'https://farm.example');
    assert.equal(request.headers.Title, 'Doomscroll failed on udid-a');
    assert.equal(request.headers.Priority, NTFY_PRIORITY.error);
    assert.equal(request.headers.Priority, '5');
    assert.equal(request.headers.Tags, NTFY_TAGS['execution.failed']);
    assert.equal(request.headers.Click, 'https://farm.example/api/executions/3f8f4e0e-0000-4000-8000-000000000001');
    assert.equal(request.headers.Authorization, 'Bearer tk_secret');
    assert.match(String(request.headers['content-type']), /text\/plain/);
    assert.equal(request.body, 'Doomscroll failed on udid-a\nWDA session died');

    // Warning is priority 4, info is 3, and an unprotected topic sends no Authorization.
    const warning = ntfyRequest(event({ severity: 'warning', kind: 'device.disconnected', detail: null }), {}, '');
    assert.equal(warning.headers.Priority, '4');
    assert.equal(warning.headers.Tags, 'warning');
    assert.equal(warning.headers.Authorization, undefined);
    assert.equal(warning.headers.Click, undefined, 'no PUBLIC_BASE_URL, no click-through');
    assert.equal(warning.body, 'Doomscroll failed on udid-a\ndevice.disconnected · udid-a');
    assert.equal(ntfyRequest(event({ severity: 'info' }), {}, '').headers.Priority, '3');

    // Header values are one line of printable ASCII, whatever the device is called.
    assert.equal(headerSafe('iPhone 8 · slot 1\nX-Injected: yes'), 'iPhone 8  slot 1 X-Injected: yes');
});

test('an ntfy channel posts text with headers while the others still post JSON', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return { ok: true, status: 200 };
    };
    const results = await deliverEvent(event(), config({
        channels: [
            { name: 'webhook', url: 'https://hooks.example/webhook' },
            { name: 'ntfy', url: 'https://ntfy.sh/farm-alerts-9f2a', token: 'tk_secret' },
        ],
    }), { fetchImpl, sleep: async () => {} });

    assert.deepEqual(results.map(({ channel, ok }) => [channel, ok]), [['webhook', true], ['ntfy', true]]);
    assert.equal(calls[0]!.headers['content-type'], 'application/json');
    assert.equal(calls[1]!.url, 'https://ntfy.sh/farm-alerts-9f2a');
    assert.equal(calls[1]!.headers.Title, 'Doomscroll failed on udid-a');
    assert.equal(calls[1]!.body, 'Doomscroll failed on udid-a\nWDA session died');
});

test('POST /api/notifications/test includes the ntfy channel', async (context) => {
    const scheduler = { async listExecutions() { return []; }, async listSchedules() { return []; } } as unknown as SchedulerRepository;
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
        calls.push({ url, headers: init.headers });
        return { ok: true, status: 200 };
    };
    const app = Fastify();
    context.after(() => app.close());
    await registerFleetRoutes(app, {
        scheduler, events: createMemoryEventStore(), backgroundTasks: false,
        delivery: { fetchImpl, sleep: async () => {} },
        notifications: config({ channels: [{ name: 'ntfy', url: 'https://ntfy.sh/farm-alerts-9f2a' }] }),
    });

    const response = await inject(app, { method: 'POST', url: '/api/notifications/test', payload: {} });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().channels.map((result: { channel: string; ok: boolean }) => [result.channel, result.ok]),
        [['ntfy', true]]);
    assert.equal(calls[0]!.headers.Title, 'Phone Farm notification test');
    assert.equal(calls[0]!.headers.Tags, NTFY_TAGS['digest.daily']);
});


/* ------------------------------------------- channel limits and digest timing */

test('a stack trace is cut to fit Discord and Slack rather than rejected', () => {
    const trace = 'Error: WDA session died\n'.repeat(500);
    const long = event({ title: 'x'.repeat(600), detail: { error: trace } });

    const embed = (discordPayload(long, 'https://farm.example') as { embeds: Array<Record<string, unknown>> }).embeds[0]!;
    assert.equal(String(embed.title).length, DISCORD_LIMITS.title);
    const fields = embed.fields as Array<{ name: string; value: string }>;
    for (const field of fields) {
        assert.ok(field.value.length <= DISCORD_LIMITS.fieldValue, `${field.name} is ${field.value.length} long`);
        assert.ok(field.name.length <= DISCORD_LIMITS.fieldName);
    }
    // Discord counts the whole embed against one 6000-character budget.
    const total = String(embed.title).length
        + fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
    assert.ok(total <= DISCORD_LIMITS.embedTotal, `embed is ${total} characters`);
    assert.ok(fields.some((field) => field.name === 'Error'));

    const slack = slackPayload(long, 'https://farm.example') as { text: string; blocks: Array<Record<string, unknown>> };
    assert.ok(slack.text.length <= SLACK_LIMITS.text);
    const header = slack.blocks[0] as { text: { text: string } };
    assert.ok(header.text.text.length <= SLACK_LIMITS.headerText);
    const section = slack.blocks[1] as { fields: Array<{ text: string }> };
    for (const field of section.fields) assert.ok(field.text.length <= SLACK_LIMITS.fieldText);
    const fenced = slack.blocks[2] as { text: { text: string } };
    assert.ok(fenced.text.text.length <= SLACK_LIMITS.text, `code block is ${fenced.text.text.length} long`);

    assert.equal(truncate('abcdef', 10), 'abcdef');
    assert.equal(truncate('abcdef', 3), 'ab…');
});

test('ntfy headers never carry a newline, whatever is in the title or the base URL', () => {
    const nasty = event({
        title: 'Doomscroll failed\r\nX-Injected: yes',
        deviceUdid: 'udid-a',
        detail: { error: 'boom\nsecond line' },
    });
    const request = ntfyRequest(nasty, { token: 'secret' }, 'https://farm.example\nX-Evil: 1');
    for (const [name, value] of Object.entries(request.headers)) {
        assert.doesNotMatch(value, /[\r\n]/, `${name} carries a line break`);
    }
    assert.equal(headerSafe('a\r\nb'), 'a b');
    // The body may be multi-line; only headers are constrained.
    assert.match(request.body, /\n/);
});

test('the digest is not sent twice when the farm restarts after the slot', async () => {
    // 08:00 Europe/London on 2026-06-02 is 07:00 UTC.
    const slot = new Date('2026-06-02T07:00:00.000Z');
    assert.equal(previousDigestAt('08:00', 'Europe/London', new Date('2026-06-02T09:00:00.000Z')).toISOString(),
        slot.toISOString());

    // Restarted at 09:00 having already sent today's digest at 07:00: wait for tomorrow.
    assert.equal(
        digestDueAt('08:00', 'Europe/London', new Date('2026-06-02T09:00:00.000Z'), slot).toISOString(),
        '2026-06-03T07:00:00.000Z',
    );
    // Restarted at 09:00 with yesterday's digest as the newest one: catch up now.
    assert.equal(
        digestDueAt('08:00', 'Europe/London', new Date('2026-06-02T09:00:00.000Z'), new Date('2026-06-01T07:00:00.000Z'))
            .toISOString(),
        slot.toISOString(),
    );
    // A farm that has never sent one waits rather than firing at boot.
    assert.equal(digestDueAt('08:00', 'Europe/London', new Date('2026-06-02T09:00:00.000Z'), null).toISOString(),
        '2026-06-03T07:00:00.000Z');

    // And end to end: two restarts inside the same day produce one digest.
    let sent = 0;
    let lastRun: Date | null = new Date('2026-06-02T07:00:00.000Z');
    const boot = (now: Date) => startDigestScheduler({
        localTime: '08:00', timezone: 'Europe/London', intervalMs: 1, now: () => now,
        lastRunAt: async () => lastRun,
        run: async (at) => { sent++; lastRun = at; },
    });
    for (const attempt of [0, 1]) {
        const scheduler = boot(new Date(`2026-06-02T09:0${attempt}:00.000Z`));
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        scheduler.stop();
    }
    assert.equal(sent, 0);

    // The same two restarts with yesterday's digest as the newest: exactly one catch-up.
    sent = 0;
    lastRun = new Date('2026-06-01T07:00:00.000Z');
    for (const attempt of [0, 1]) {
        const scheduler = boot(new Date(`2026-06-02T09:0${attempt}:00.000Z`));
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        scheduler.stop();
    }
    assert.equal(sent, 1);
});

test('the digest slot stays at 08:00 local across a DST change', () => {
    // Europe/London springs forward at 01:00 UTC on 2026-03-29.
    assert.equal(nextDigestAt('08:00', 'Europe/London', new Date('2026-03-28T09:00:00.000Z')).toISOString(),
        '2026-03-29T07:00:00.000Z');
    // The day before the change, 08:00 local is 08:00 UTC.
    assert.equal(nextDigestAt('08:00', 'Europe/London', new Date('2026-03-27T09:00:00.000Z')).toISOString(),
        '2026-03-28T08:00:00.000Z');
    // Autumn: the clocks go back on 2026-10-25, and 08:00 local is 08:00 UTC after it.
    assert.equal(nextDigestAt('08:00', 'Europe/London', new Date('2026-10-25T09:00:00.000Z')).toISOString(),
        '2026-10-26T08:00:00.000Z');
});
