import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    LOCK_FILE, backupDirFor, clearStaleLock, readLock, resetEmbeddedPostgres, startEmbeddedPostgres,
    takeOverCluster, type PostmasterTools,
} from '../src/main/embedded-postgres.ts';
import { ChildRegistry } from '../src/main/orphans.ts';
import { setChildRegistry } from '../src/main/process.ts';
import type { LaunchContext } from '../src/main/types.ts';

/** A userData directory with a `postgres/` cluster in it, as the app lays it out. */
function userData(files: Record<string, string> = { 'PG_VERSION': '17\n' }): { root: string; dataDir: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), 'phone-farm-pg-'));
    const dataDir = path.join(root, 'postgres');
    mkdirSync(dataDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dataDir, name), content);
    return { root, dataDir };
}

const dead = () => false;
const live = () => true;

test('no postmaster.pid at all is not a problem', () => {
    const { dataDir } = userData();
    assert.deepEqual(readLock(dataDir, dead), { kind: 'absent' });
});

test('a postmaster.pid whose pid is gone is recognised as stale and removed', async () => {
    // The state a hard kill of the app, or of the machine, leaves behind. Postgres
    // refuses to start while the file is there, and the operator only ever sees
    // "pg_ctl start failed" with nothing they can act on.
    const { dataDir } = userData({ 'PG_VERSION': '17\n', [LOCK_FILE]: '9123\n/data\n1700000000\n' });

    assert.deepEqual(readLock(dataDir, dead), {
        kind: 'stale', pid: 9123, reason: 'no process is running under pid 9123',
    });

    const verdict = await clearStaleLock(dataDir, dead);
    assert.equal(verdict.kind, 'stale');
    assert.equal(existsSync(path.join(dataDir, LOCK_FILE)), false);
    assert.equal(existsSync(path.join(dataDir, 'PG_VERSION')), true, 'only the lock file is touched');
});

test('a postmaster.pid held by a live process is left exactly where it is', async () => {
    const { dataDir } = userData({ 'PG_VERSION': '17\n', [LOCK_FILE]: '9123\n/data\n' });

    assert.deepEqual(readLock(dataDir, live), { kind: 'held', pid: 9123, port: null });
    await clearStaleLock(dataDir, live);
    assert.equal(existsSync(path.join(dataDir, LOCK_FILE)), true, 'a running cluster is never unlocked');
});

test('a held postmaster.pid reports the port on its fourth line', () => {
    const { dataDir } = userData({ [LOCK_FILE]: '9123\n/data\n1700000000\n55432\n/tmp\n127.0.0.1\n' });
    assert.deepEqual(readLock(dataDir, live), { kind: 'held', pid: 9123, port: 55432 });
});

test('a postmaster.pid that is not a pid at all is stale, not held', () => {
    const { dataDir } = userData({ [LOCK_FILE]: 'garbage\n' });
    assert.deepEqual(readLock(dataDir, live), {
        kind: 'stale', pid: null, reason: 'postmaster.pid does not start with a pid',
    });
});

test('resetting the database moves the cluster aside instead of deleting it', async () => {
    const { root, dataDir } = userData({ 'PG_VERSION': '17\n', 'base': 'the operator whole farm' });

    const { backupDir } = await resetEmbeddedPostgres(dataDir, root, new Date('2026-01-02T03:04:05.678Z'));

    assert.equal(backupDir, path.join(root, 'postgres-backup-2026-01-02T03-04-05'));
    assert.equal(existsSync(dataDir), false, 'the cluster is out of the way of a fresh initdb');
    assert.equal(readFileSync(path.join(backupDir!, 'base'), 'utf8'), 'the operator whole farm');
});

test('the backup name is dated, so two resets never overwrite each other', () => {
    const first = backupDirFor('/data/postgres', new Date('2026-01-02T03:04:05Z'));
    const second = backupDirFor('/data/postgres', new Date('2026-01-02T09:00:00Z'));
    assert.notEqual(first, second);
    assert.match(first, /postgres-backup-2026-01-02T03-04-05$/);
});

test('reset refuses any directory that is not this app own bundled cluster', async () => {
    const { root } = userData();
    const elsewhere = path.join(root, 'not-postgres');
    mkdirSync(elsewhere);

    await assert.rejects(
        () => resetEmbeddedPostgres(elsewhere, root),
        /Refusing to reset .*not-postgres: it is not this app's bundled cluster/,
    );
    await assert.rejects(
        // The shape an external DATABASE_URL setup would have to reach through.
        () => resetEmbeddedPostgres('/usr/local/var/postgres', root),
        /Refusing to reset/,
    );
    assert.equal(existsSync(elsewhere), true);
});

test('resetting when there is nothing there leaves no empty backup folder behind', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'phone-farm-pg-'));
    assert.deepEqual(await resetEmbeddedPostgres(path.join(root, 'postgres'), root), { backupDir: null });

    mkdirSync(path.join(root, 'postgres'));
    assert.deepEqual(await resetEmbeddedPostgres(path.join(root, 'postgres'), root), { backupDir: null });
});

/**
 * A machine with one leftover postmaster on it. `answering` is whether it replies
 * on the port it was asked about; signals are recorded and SIGINT/SIGKILL end it.
 */
function machine(options: { pid: number; answering: (port: number) => boolean }) {
    const state = {
        alive: new Set([options.pid]),
        signals: [] as string[],
        time: 0,
        logs: [] as string[],
        tools: null as unknown as PostmasterTools,
        context: null as unknown as LaunchContext,
    };
    state.tools = {
        alive: (pid) => state.alive.has(pid),
        ready: async (port) => state.alive.has(options.pid) && options.answering(port),
        signal: (pid, signal) => {
            state.signals.push(`${signal}:${pid}`);
            if (signal === 'SIGINT' || signal === 'SIGKILL') state.alive.delete(pid);
        },
        sleep: async (ms) => { state.time += ms; },
        now: () => state.time,
    };
    state.context = { log: (_stream, text) => { state.logs.push(text); } };
    return state;
}

const lockFor = (pid: number, port: number) => `${pid}\n/data\n1700000000\n${port}\n`;

test('a live postmaster on our port is adopted, not started a second time', async () => {
    // The state `pkill` of the Electron process leaves: the postmaster survives,
    // holding the lock and the port. Starting on top of it can only fail.
    const { dataDir } = userData({ 'PG_VERSION': '17\n', [LOCK_FILE]: lockFor(9123, 55432) });
    const box = machine({ pid: 9123, answering: (port) => port === 55432 });

    const verdict = await takeOverCluster(dataDir, 55432, box.context, box.tools);

    assert.deepEqual(verdict, { kind: 'adopted', pid: 9123 });
    assert.deepEqual(box.signals, [], 'a healthy cluster is never signalled');
    assert.equal(existsSync(path.join(dataDir, LOCK_FILE)), true);
    assert.match(box.logs.at(-1) ?? '', /reusing it instead of starting a second one/);
});

test('a live postmaster on another port is shut down before ours starts', async () => {
    // The operator changed the port in Settings while the old postmaster was
    // still up: it is our cluster, so it is ours to stop.
    const { dataDir } = userData({ 'PG_VERSION': '17\n', [LOCK_FILE]: lockFor(9123, 55432) });
    const box = machine({ pid: 9123, answering: (port) => port === 55432 });

    const verdict = await takeOverCluster(dataDir, 55500, box.context, box.tools);

    assert.deepEqual(verdict, { kind: 'fresh' });
    assert.deepEqual(box.signals, ['SIGINT:9123'], 'a fast shutdown, not a kill');
    assert.equal(existsSync(path.join(dataDir, LOCK_FILE)), false, 'the lock it left behind is removed');
    assert.match(box.logs.join('\n'), /port 55432, not the configured port 55500/);
});

test('a live postmaster that never answers is shut down instead of waited on for ever', async () => {
    const { dataDir } = userData({ 'PG_VERSION': '17\n', [LOCK_FILE]: lockFor(9123, 55432) });
    const box = machine({ pid: 9123, answering: () => false });

    const verdict = await takeOverCluster(dataDir, 55432, box.context, box.tools);

    assert.deepEqual(verdict, { kind: 'fresh' });
    assert.deepEqual(box.signals, ['SIGINT:9123']);
    assert.ok(box.time >= 10_000, 'it was given its chance to come up first');
});

test('a postmaster that ignores SIGINT gets SIGKILL, and one that survives that is reported', async () => {
    const { dataDir } = userData({ 'PG_VERSION': '17\n', [LOCK_FILE]: lockFor(9123, 55432) });
    const box = machine({ pid: 9123, answering: () => false });
    box.tools.signal = (pid, signal) => {
        box.signals.push(`${signal}:${pid}`);
        if (signal === 'SIGKILL') box.alive.delete(pid);
    };
    assert.deepEqual(await takeOverCluster(dataDir, 55432, box.context, box.tools), { kind: 'fresh' });
    assert.deepEqual(box.signals, ['SIGINT:9123', 'SIGKILL:9123']);

    const immortal = userData({ 'PG_VERSION': '17\n', [LOCK_FILE]: lockFor(9124, 55432) });
    const stuck = machine({ pid: 9124, answering: () => false });
    stuck.tools.signal = (pid, signal) => { stuck.signals.push(`${signal}:${pid}`); };
    await assert.rejects(
        () => takeOverCluster(immortal.dataDir, 55432, stuck.context, stuck.tools),
        /pid 9124.*would not stop/,
    );
});

/** The `embedded-postgres` class, minus the 300 MB of binaries. */
class FakeEmbeddedPostgres {
    static instances: FakeEmbeddedPostgres[] = [];
    static failStart: string | null = null;
    calls: string[] = [];
    process?: { pid: number };
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
        this.options = options;
        FakeEmbeddedPostgres.instances.push(this);
    }

    async initialise(): Promise<void> { this.calls.push('initialise'); }

    async start(): Promise<void> {
        this.calls.push('start');
        if (FakeEmbeddedPostgres.failStart) throw new Error(FakeEmbeddedPostgres.failStart);
        this.process = { pid: 7777 };
        // What the real postmaster does before it announces itself as ready.
        writeFileSync(path.join(this.options.databaseDir as string, LOCK_FILE), lockFor(7777, this.options.port as number));
    }

    async stop(): Promise<void> { this.calls.push('stop'); }

    async createDatabase(name: string): Promise<void> { this.calls.push(`createDatabase:${name}`); }
}

function startWith(dataDir: string, port: number, tools: PostmasterTools, context: LaunchContext) {
    FakeEmbeddedPostgres.instances = [];
    FakeEmbeddedPostgres.failStart = null;
    return startEmbeddedPostgres(
        { dataDir, port, user: 'farm', password: 'pw', database: 'farm' },
        context,
        { load: async () => FakeEmbeddedPostgres as never, tools },
    );
}

test('the postmaster pid is recorded among the supervised children while it runs', async () => {
    // So that a relaunch after a crash of the app kills it exactly the way it
    // kills a leftover appium or worker, instead of tripping over its lock file.
    const { root, dataDir } = userData();
    const registry = new ChildRegistry(root);
    setChildRegistry(registry);
    try {
        const box = machine({ pid: 1, answering: () => false });
        box.tools.alive = (pid) => pid === 7777;
        const handle = await startWith(dataDir, 55432, box.tools, box.context);

        assert.equal(handle.pid, 7777);
        assert.deepEqual(registry.current().map((entry) => [entry.pid, entry.label]), [[7777, 'postgres']]);
        assert.deepEqual(FakeEmbeddedPostgres.instances[0]?.calls, ['start']);

        await handle.stop();
        assert.deepEqual(registry.current(), [], 'a clean stop forgets it again');
        assert.deepEqual(FakeEmbeddedPostgres.instances[0]?.calls, ['start', 'stop']);
    } finally {
        setChildRegistry(null);
    }
});

test('adopting a leftover postmaster spawns nothing and records the adopted pid', async () => {
    const { root, dataDir } = userData({ 'PG_VERSION': '17\n', [LOCK_FILE]: lockFor(9123, 55432) });
    const registry = new ChildRegistry(root);
    setChildRegistry(registry);
    try {
        const box = machine({ pid: 9123, answering: () => true });
        const handle = await startWith(dataDir, 55432, box.tools, box.context);

        assert.equal(handle.pid, 9123);
        assert.equal(FakeEmbeddedPostgres.instances.length, 0, 'no second postmaster is ever constructed');
        assert.deepEqual(registry.current().map((entry) => entry.pid), [9123]);

        await handle.stop();
        assert.deepEqual(box.signals, ['SIGINT:9123'], 'stopping an adopted postmaster is a fast shutdown');
        assert.deepEqual(registry.current(), []);
    } finally {
        setChildRegistry(null);
    }
});

test('a stale lock is removed and the cluster started normally', async () => {
    const { dataDir } = userData({ 'PG_VERSION': '17\n', [LOCK_FILE]: lockFor(9123, 55432) });
    const box = machine({ pid: 1, answering: () => false });
    box.tools.alive = (pid) => pid === 7777;

    const handle = await startWith(dataDir, 55432, box.tools, box.context);

    assert.equal(handle.pid, 7777);
    assert.match(box.logs[0] ?? '', /Removed a stale postmaster\.pid \(no process is running under pid 9123\)/);
    assert.deepEqual(FakeEmbeddedPostgres.instances[0]?.calls, ['start']);
});
