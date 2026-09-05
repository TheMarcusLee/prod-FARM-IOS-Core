import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    notifyEventHook, scheduleTransitionAllowed, SchedulerRepository, type SchedulerLifecycleEvent,
} from '../src/scheduler/repository.js';
import { mutateRegisteredDevices } from '../src/devices/registry.js';

test('scheduleTransitionAllowed blocks resuming a finished schedule', () => {
    assert.equal(scheduleTransitionAllowed('active', 'paused'), true);
    assert.equal(scheduleTransitionAllowed('paused', 'active'), true);
    assert.equal(scheduleTransitionAllowed('active', 'cancelled'), true);
    assert.equal(scheduleTransitionAllowed('completed', 'cancelled'), true);
    assert.equal(scheduleTransitionAllowed('completed', 'active'), false);
    assert.equal(scheduleTransitionAllowed('cancelled', 'active'), false);
    assert.equal(scheduleTransitionAllowed('cancelled', 'paused'), false);
});

test('mutateRegisteredDevices serializes overlapping writes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pf-registry-lock-'));
    const configPath = path.join(dir, 'devices.json');

    // fire 20 concurrent independent mutations; each appends one entry
    await Promise.all(
        Array.from({ length: 20 }, (_, i) => mutateRegisteredDevices(
            (devices) => { devices.push({ name: `d${i}`, udid: `udid-${i}`, pluginData: {} }); },
            configPath,
        )),
    );

    const saved = JSON.parse(await readFile(configPath, 'utf8')) as Array<{ udid: string }>;
    assert.equal(saved.length, 20, 'no write was lost to a race');
    assert.equal(new Set(saved.map((d) => d.udid)).size, 20);
});

test('a throwing event hook cannot unwind the scheduler', async () => {
    const seen: unknown[] = [];
    const event = {
        kind: 'schedule.created',
        schedule: { id: 's1' },
    } as unknown as SchedulerLifecycleEvent;

    // A synchronous throw used to propagate straight out of createTask, so a
    // failing notification aborted a schedule that had already been written.
    assert.doesNotThrow(() => notifyEventHook(() => { throw new Error('recorder down'); }, event, (error) => seen.push(error)));
    // An async hook whose promise rejects is the same failure one tick later.
    notifyEventHook((() => Promise.reject(new Error('smtp down'))) as never, event, (error) => seen.push(error));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((error) => (error as Error).message), ['recorder down', 'smtp down']);

    // A healthy hook still sees the event, exactly once.
    const delivered: SchedulerLifecycleEvent[] = [];
    notifyEventHook((incoming) => { delivered.push(incoming); }, event);
    assert.deepEqual(delivered, [event]);
});

test('the newest-first listings order by the same pair the keyset cursor compares', async () => {
    const orderings: unknown[][] = [];
    const recorder = () => {
        const chain = {
            from: () => chain,
            where: () => chain,
            orderBy: (...columns: unknown[]) => { orderings.push(columns); return chain; },
            limit: async () => [],
        };
        return chain;
    };
    const repository = new SchedulerRepository(
        { db: { select: recorder } } as never,
        {} as never,
        {} as never,
    );
    const cursor = { createdAt: new Date('2026-03-01T00:00:00Z'), id: 'aaaa' };
    await repository.listSchedules(10, 'udid-1', cursor);
    await repository.listExecutions(10, 'udid-1', cursor);

    // Ordering by createdAt alone leaves rows sharing an instant in an
    // arbitrary order, and the (createdAt, id) cursor then skips or repeats them.
    assert.equal(orderings.length, 2);
    for (const columns of orderings) assert.equal(columns.length, 2, 'createdAt and id, not createdAt alone');
});

/**
 * A drizzle-shaped stub: every builder method returns the same chain, and
 * awaiting the chain yields the next queued result. Enough to drive the small
 * repository methods that are pure query plus bookkeeping.
 */
function fakeDb(results: unknown[][]): { db: unknown; calls: Array<{ method: string; args: unknown[] }> } {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const queue = [...results];
    const chain: Record<string, unknown> = {
        then(resolve: (value: unknown) => void) { resolve(queue.shift() ?? []); },
    };
    for (const method of [
        'select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values',
        'onConflictDoNothing', 'update', 'set', 'delete', 'returning',
    ]) {
        chain[method] = (...args: unknown[]) => { calls.push({ method, args }); return chain; };
    }
    return { db: chain, calls };
}

function executionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'exec-1', scheduleId: null, deviceUdid: 'udid-a',
        pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1, payload: {},
        scheduledFor: new Date('2026-03-01T11:00:00.000Z'), deadlineAt: new Date('2026-03-01T11:30:00.000Z'),
        status: 'running', queueJobId: 'job-1', startedAt: new Date('2026-03-01T11:00:00.000Z'),
        finishedAt: null, exitCode: null, error: null, stopRequestedAt: null,
        createdAt: new Date('2026-03-01T10:00:00.000Z'), updatedAt: new Date('2026-03-01T10:00:00.000Z'),
        ...overrides,
    };
}

test('a cancelled execution still reaches the fleet timeline', async () => {
    const events: SchedulerLifecycleEvent[] = [];
    // finishExecution: the update's returning(), then the asset purge's three reads.
    const { db } = fakeDb([[executionRow({ status: 'cancelled' })], [executionRow({ status: 'cancelled' })], [], []]);
    const repository = new SchedulerRepository({ db } as never, {} as never, {} as never, (event) => { events.push(event); });

    await repository.finishExecution('exec-1', 'cancelled', null, 'Cancelled before execution');
    await new Promise((resolve) => setImmediate(resolve));

    // Suppressing this left a run that vanished from the queue looking like one
    // that was never created.
    assert.deepEqual(events.map(({ kind }) => kind), ['execution.cancelled']);
});
