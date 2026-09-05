import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import Fastify, { type FastifyInstance } from 'fastify';

import { inject } from './support.js';
import {
    EVENT_KINDS, clampLimit, createMemoryEventStore, isEventKind, isEventSeverity,
    queryEvents, serializeEvent, severityRank, type EventInput, type FarmEvent,
} from '../src/fleet/events.js';
import { registerFleetRoutes, type FleetRouteOptions } from '../src/api/routes/fleet.js';
import { createEventStreamHub } from '../src/fleet/sse-hub.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

/** A bare Fastify with only the fleet routes — createApp registers them itself. */
async function fleetApp(options: Partial<FleetRouteOptions>): Promise<FastifyInstance> {
    const app = Fastify();
    await registerFleetRoutes(app, { scheduler, backgroundTasks: false, ...options });
    return app;
}

const scheduler = {
    async listExecutions() { return []; },
    async listSchedules() { return []; },
} as unknown as SchedulerRepository;

function seedInput(overrides: Partial<EventInput> = {}): EventInput {
    return {
        kind: 'execution.failed', severity: 'error', deviceUdid: 'udid-a',
        title: 'Doomscroll failed', detail: { error: 'boom' }, ...overrides,
    };
}

async function seededStore(): Promise<ReturnType<typeof createMemoryEventStore>> {
    const store = createMemoryEventStore();
    await store.record(seedInput({ kind: 'execution.started', severity: 'info', title: 'started' }));
    await store.record(seedInput({ kind: 'device.disconnected', severity: 'warning', deviceUdid: 'udid-b', title: 'offline' }));
    await store.record(seedInput({ title: 'failed' }));
    return store;
}

test('the event contract exposes exactly the agreed kinds and severities', () => {
    assert.deepEqual([...EVENT_KINDS], [
        'execution.started', 'execution.succeeded', 'execution.failed', 'execution.stopped', 'execution.cancelled',
        'execution.stuck',
        'device.connected', 'device.disconnected', 'device.error',
        'schedule.created', 'schedule.paused', 'schedule.cancelled', 'digest.daily',
    ]);
    assert.ok(isEventKind('digest.daily') && !isEventKind('execution.exploded'));
    assert.ok(isEventSeverity('warning') && !isEventSeverity('critical'));
    assert.ok(severityRank('error') > severityRank('warning'));
    assert.equal(clampLimit('abc'), 100);
    assert.equal(clampLimit(9_999), 500);
});

test('recording an event assigns an increasing id and serializes to the wire shape', async () => {
    const store = createMemoryEventStore();
    const first = await store.record(seedInput());
    const second = await store.record(seedInput({ kind: 'execution.succeeded', severity: 'info', title: 'ok', detail: null }));
    assert.equal(first.id, 1);
    assert.equal(second.id, 2);
    assert.equal(second.detail, null);

    const wire = serializeEvent(first);
    assert.deepEqual(Object.keys(wire).sort(), [
        'createdAt', 'detail', 'deviceUdid', 'executionId', 'id', 'kind', 'scheduleId', 'severity', 'title',
    ]);
    assert.equal(wire.kind, 'execution.failed');
    assert.match(String(wire.createdAt), /^\d{4}-\d{2}-\d{2}T/);
});

test('queries filter by kind, severity, device and time, newest first, with an id cursor', async () => {
    const store = await seededStore();
    const all = await store.list();
    assert.deepEqual(all.map(({ id }) => id), [3, 2, 1]);
    assert.deepEqual((await store.list({ kind: 'execution.failed' })).map(({ id }) => id), [3]);
    assert.deepEqual((await store.list({ severity: 'warning' })).map(({ id }) => id), [2]);
    assert.deepEqual((await store.list({ deviceUdid: 'udid-b' })).map(({ id }) => id), [2]);
    assert.deepEqual((await store.list({ before: 3 })).map(({ id }) => id), [2, 1]);
    assert.deepEqual((await store.list({ limit: 2 })).map(({ id }) => id), [3, 2]);

    const cutoff = new Date(Date.now() + 60_000);
    assert.equal((await store.list({ since: cutoff })).length, 0);
    assert.equal((await store.list({ until: cutoff })).length, 3);
    // after() is the SSE direction: oldest first, strictly greater than the cursor
    assert.deepEqual((await store.after(1)).map(({ id }) => id), [2, 3]);
});

test('queryEvents applies the same rules as the SQL store', () => {
    const base: FarmEvent = {
        id: 1, kind: 'device.error', severity: 'error', deviceUdid: 'a', executionId: null, scheduleId: null,
        title: 't', detail: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const events = [base, { ...base, id: 2, severity: 'info' as const }, { ...base, id: 3, deviceUdid: 'b' }];
    assert.deepEqual(queryEvents(events).map(({ id }) => id), [3, 2, 1]);
    assert.deepEqual(queryEvents(events, { severity: 'error' }).map(({ id }) => id), [3, 1]);
    assert.deepEqual(queryEvents(events, { deviceUdid: 'a', before: 2 }).map(({ id }) => id), [1]);
});

test('GET /api/events serializes, paginates and rejects unknown filters', async (context) => {
    const store = await seededStore();
    const app = await fleetApp({ events: store });
    context.after(() => app.close());

    const all = await inject(app, { method: 'GET', url: '/api/events' });
    assert.equal(all.statusCode, 200);
    assert.deepEqual(all.json().events.map((event: { id: number }) => event.id), [3, 2, 1]);
    assert.equal(all.json().nextBefore, null);

    const page = await inject(app, { method: 'GET', url: '/api/events?limit=2' });
    assert.deepEqual(page.json().events.map((event: { id: number }) => event.id), [3, 2]);
    assert.equal(page.json().nextBefore, 2);

    const next = await inject(app, { method: 'GET', url: '/api/events?limit=2&before=2' });
    assert.deepEqual(next.json().events.map((event: { id: number }) => event.id), [1]);

    const filtered = await inject(app, { method: 'GET', url: '/api/events?kind=device.disconnected&severity=warning&deviceUdid=udid-b' });
    assert.deepEqual(filtered.json().events.map((event: { id: number }) => event.id), [2]);

    assert.equal((await inject(app, { method: 'GET', url: '/api/events?kind=nope' })).statusCode, 400);
    assert.equal((await inject(app, { method: 'GET', url: '/api/events?severity=nope' })).statusCode, 400);
    assert.equal((await inject(app, { method: 'GET', url: '/api/events?since=not-a-date' })).statusCode, 400);
});

test('GET /api/events/stream replays from Last-Event-ID and streams new events', async (context) => {
    const store = await seededStore();
    const app = await fleetApp({ events: store, ssePollIntervalMs: 20 });
    context.after(() => app.close());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;

    const controller = new AbortController();
    context.after(() => controller.abort());
    const response = await fetch(`http://127.0.0.1:${port}/api/events/stream`, {
        headers: { 'last-event-id': '1' }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/event-stream/);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (predicate: (text: string) => boolean): Promise<string> => {
        while (!predicate(buffer)) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
        }
        return buffer;
    };

    // Replay: events 2 and 3 were missed by a client that last saw id 1.
    await readUntil((text) => text.includes('id: 3'));
    assert.match(buffer, /id: 2\nevent: device\.disconnected\ndata: \{/);
    assert.match(buffer, /id: 3\nevent: execution\.failed\ndata: \{/);
    assert.doesNotMatch(buffer, /id: 1\n/);
    const replayed = JSON.parse(/id: 3\nevent: execution\.failed\ndata: (\{.*\})/.exec(buffer)![1]!);
    assert.equal(replayed.severity, 'error');
    assert.equal(replayed.detail.error, 'boom');

    // Live tail: an event recorded after the client connected arrives on the poll.
    await store.record(seedInput({ kind: 'execution.stuck', title: 'stuck' }));
    await readUntil((text) => text.includes('event: execution.stuck'));
    assert.match(buffer, /id: 4\nevent: execution\.stuck\n/);

    controller.abort();
});

/* --------------------------------------------------------------- the SSE hub */

function fakeSocket(options: { acceptBytes?: number } = {}) {
    let budget = options.acceptBytes ?? Number.POSITIVE_INFINITY;
    const drainListeners: Array<() => void> = [];
    return {
        chunks: [] as string[],
        ended: false,
        destroyed: false,
        write(chunk: string): boolean {
            this.chunks.push(chunk);
            budget -= chunk.length;
            return budget > 0;
        },
        end(): void { this.ended = true; },
        once(_event: 'drain', listener: () => void): void { drainListeners.push(listener); },
        drain(): void { for (const listener of drainListeners.splice(0)) listener(); },
        ids(): number[] {
            return this.chunks.flatMap((chunk) => {
                const match = /^id: (\d+)/.exec(chunk);
                return match ? [Number(match[1])] : [];
            });
        },
    };
}

test('the stream hub replays from a cursor and never sends an event twice', async () => {
    const store = await seededStore();
    const hub = createEventStreamHub(store, { intervalMs: 60_000, heartbeatMs: 60_000 });
    const socket = fakeSocket();
    hub.add(socket, 1);

    await hub.poll();
    assert.deepEqual(socket.ids(), [2, 3]);

    // A second round with nothing new writes nothing at all.
    await hub.poll();
    assert.deepEqual(socket.ids(), [2, 3]);

    await store.record(seedInput({ kind: 'execution.stuck', title: 'stuck' }));
    await hub.poll();
    assert.deepEqual(socket.ids(), [2, 3, 4]);
    hub.closeAll();
});

test('two overlapping polls do not duplicate events on a slow store', async () => {
    const store = await seededStore();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const slow = {
        ...store,
        async after(id: number, limit?: number) {
            calls++;
            if (calls === 1) await gate;
            return store.after(id, limit);
        },
    };
    const hub = createEventStreamHub(slow, { intervalMs: 60_000, heartbeatMs: 60_000 });
    const socket = fakeSocket();
    hub.add(socket, 0);

    // The second poll starts while the first is still waiting on the store. With
    // no in-flight guard both would read the same cursor and send 1..3 twice.
    const first = hub.poll();
    const second = hub.poll();
    release();
    await Promise.all([first, second]);
    assert.deepEqual(socket.ids(), [1, 2, 3]);
    assert.equal(calls, 1);
    hub.closeAll();
});

test('one poll serves every subscriber, and a closed socket is dropped', async () => {
    const store = await seededStore();
    let queries = 0;
    const counted = {
        ...store,
        async after(id: number, limit?: number) { queries++; return store.after(id, limit); },
    };
    const hub = createEventStreamHub(counted, { intervalMs: 60_000, heartbeatMs: 60_000 });
    const sockets = Array.from({ length: 12 }, () => fakeSocket());
    for (const socket of sockets) hub.add(socket, 0);

    await hub.poll();
    // Twelve browsers watching the fleet, one query.
    assert.equal(queries, 1);
    for (const socket of sockets) assert.deepEqual(socket.ids(), [1, 2, 3]);

    sockets[0]!.destroyed = true;
    await store.record(seedInput({ title: 'another' }));
    await hub.poll();
    assert.equal(sockets[0]!.ended, true);
    assert.equal(hub.size, 11);
    assert.deepEqual(sockets[1]!.ids(), [1, 2, 3, 4]);
    hub.closeAll();
});

test('a socket that stops accepting bytes is paused until it drains', async () => {
    const store = await seededStore();
    const hub = createEventStreamHub(store, { intervalMs: 60_000, heartbeatMs: 60_000 });
    // Accepts the first frame and then reports a full buffer.
    const socket = fakeSocket({ acceptBytes: 10 });
    hub.add(socket, 0);

    await hub.poll();
    assert.deepEqual(socket.ids(), [1]);
    // Still blocked: the hub must not queue the rest in memory.
    await hub.poll();
    assert.deepEqual(socket.ids(), [1]);

    socket.drain();
    await hub.poll();
    assert.deepEqual(socket.ids(), [1, 2]);
    hub.closeAll();
});

test('closing the app ends open streams and leaves no timers behind', async (context) => {
    const store = await seededStore();
    const hub = createEventStreamHub(store, { intervalMs: 5, heartbeatMs: 5 });
    const socket = fakeSocket();
    hub.add(socket, 0);
    assert.equal(hub.size, 1);
    hub.closeAll();
    assert.equal(socket.ended, true);
    assert.equal(hub.size, 0);
    // Timers are only alive while somebody is subscribed, so an app that closed
    // its streams has nothing left ticking.
    assert.equal(hub.size, 0);

    // And through the route: opening a stream and closing the app must not hang
    // on a poll interval that nobody cleared.
    const app = await fleetApp({ events: store, ssePollIntervalMs: 5 });
    context.after(() => app.close());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/events/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    controller.abort();
    await response.body!.cancel().catch(() => {});
    await app.close();
});
