import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ExecutionRow } from '../src/database/schema.js';
import { STUCK_GRACE_MS } from '../src/fleet/summary.js';
import {
    SchedulerRepository, STUCK_EXECUTION_ERROR, type SchedulerLifecycleEvent,
} from '../src/scheduler/repository.js';

// devices/registry.ts freezes its path at first import, and the worker module
// reaches it; point it at a scratch file before importing anything.
const DEVICES_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'pf-sweep-')), 'devices.json');
writeFileSync(DEVICES_PATH, '[]');
process.env.DEVICES_CONFIG_PATH = DEVICES_PATH;

const NOW = new Date('2026-03-01T12:00:00.000Z');

/** A fake clock the tests step by hand — nothing here waits on a real timer. */
function clock(start = NOW): { now: () => Date; advance: (ms: number) => void } {
    let current = start.getTime();
    return { now: () => new Date(current), advance: (ms) => { current += ms; } };
}

function executionRow(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
    return {
        id: 'exec-1', scheduleId: 'sched-1', deviceUdid: 'udid-a',
        pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1, payload: {},
        scheduledFor: new Date(NOW.getTime() - 3_600_000), deadlineAt: new Date(NOW.getTime() - 1_800_000),
        status: 'running', queueJobId: 'job-1', startedAt: new Date(NOW.getTime() - 3_600_000),
        finishedAt: null, exitCode: null, error: null, stopRequestedAt: null,
        createdAt: NOW, updatedAt: NOW, ...overrides,
    } as ExecutionRow;
}

/** Every Date reachable from a captured drizzle condition — the cutoff is in there. */
function datesIn(value: unknown, seen = new Set<unknown>()): Date[] {
    if (value instanceof Date) return [value];
    if (!value || typeof value !== 'object' || seen.has(value)) return [];
    seen.add(value);
    return Object.values(value as Record<string, unknown>).flatMap((entry) => datesIn(entry, seen));
}

test('the give-up sweep fails running executions five minutes past their deadline', async () => {
    const time = clock();
    const events: SchedulerLifecycleEvent[] = [];
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const chain: Record<string, unknown> = {
        then(resolve: (value: unknown) => void) { resolve([executionRow({ status: 'failed' })]); },
    };
    for (const method of ['update', 'set', 'where', 'returning']) {
        chain[method] = (...args: unknown[]) => { calls.push({ method, args }); return chain; };
    }
    const repository = new SchedulerRepository(
        { db: chain } as never, {} as never, {} as never, (event) => { events.push(event); },
    );

    time.advance(90_000);
    const failed = await repository.failStuckExecutions(time.now());
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(failed.length, 1);
    const written = calls.find(({ method }) => method === 'set')!.args[0] as Record<string, unknown>;
    assert.equal(written.status, 'failed');
    assert.equal(written.error, STUCK_EXECUTION_ERROR);
    assert.deepEqual(written.finishedAt, time.now(), 'the fake clock, not Date.now()');

    // The cutoff is the deadline plus the same grace `execution.stuck` uses, so
    // the warning always lands before the give-up.
    const cutoff = new Date(time.now().getTime() - STUCK_GRACE_MS);
    const condition = calls.find(({ method }) => method === 'where')!.args[0];
    assert.ok(datesIn(condition).some((date) => date.getTime() === cutoff.getTime()),
        'the where clause compares deadlineAt against now minus the stuck grace');

    // A failed sweep is an ordinary failure on the timeline, not a silent status flip.
    assert.deepEqual(events.map(({ kind }) => kind), ['execution.failed']);
});

test('the sweep stops the plugin process only for executions this worker owns', async () => {
    const { sweepStuckExecutions } = await import('../src/scheduler/worker.js');
    const time = clock();
    const asked: Date[] = [];
    const stopped: string[] = [];
    const repository = {
        async failStuckExecutions(now: Date) {
            asked.push(now);
            return [executionRow({ id: 'exec-mine', status: 'failed' }), executionRow({ id: 'exec-theirs', status: 'failed' })];
        },
    };
    const running = new Map([['exec-mine', () => stopped.push('exec-mine')]]);

    time.advance(STUCK_GRACE_MS);
    assert.equal(await sweepStuckExecutions({ repository, running }, time.now()), 2);

    assert.deepEqual(asked, [time.now()]);
    // The other worker's execution is failed in the database and left alone
    // here — there is no process in this one to kill.
    assert.deepEqual(stopped, ['exec-mine']);
});
