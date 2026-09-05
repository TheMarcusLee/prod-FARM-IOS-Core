import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    LOCK_FILE, backupDirFor, clearStaleLock, readLock, resetEmbeddedPostgres,
} from '../src/main/embedded-postgres.ts';

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

    assert.deepEqual(readLock(dataDir, live), { kind: 'held', pid: 9123 });
    await clearStaleLock(dataDir, live);
    assert.equal(existsSync(path.join(dataDir, LOCK_FILE)), true, 'a running cluster is never unlocked');
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
