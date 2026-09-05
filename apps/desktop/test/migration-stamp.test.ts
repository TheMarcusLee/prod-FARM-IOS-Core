import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    clearStamp, databaseIdentity, migrationFingerprint, migrationsAlreadyApplied, readStamp, writeStamp,
} from '../src/main/migration-stamp.ts';

function drizzle(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phone-farm-drizzle-'));
    for (const [name, sql] of Object.entries(files)) {
        mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
        writeFileSync(path.join(dir, name), sql);
    }
    return dir;
}

const BASE = { databaseIdentity: '127.0.0.1:55432/phone_farm', appVersion: '0.1.0' };

test('a migration set fingerprints the same way twice', () => {
    const migrationsDir = drizzle({ '0000_init.sql': 'create table a();', 'meta/_journal.json': '{}' });
    const first = migrationFingerprint({ ...BASE, migrationsDir });

    assert.equal(typeof first, 'string');
    assert.equal(migrationFingerprint({ ...BASE, migrationsDir }), first);
});

test('a new migration, an edited one, a new version or another database all re-run', () => {
    const migrationsDir = drizzle({ '0000_init.sql': 'create table a();' });
    const original = migrationFingerprint({ ...BASE, migrationsDir });

    writeFileSync(path.join(migrationsDir, '0001_more.sql'), 'create table b();');
    const added = migrationFingerprint({ ...BASE, migrationsDir });
    assert.notEqual(added, original, 'a new .sql file makes the stamp stale');

    writeFileSync(path.join(migrationsDir, '0001_more.sql'), 'create table b(id int);');
    assert.notEqual(migrationFingerprint({ ...BASE, migrationsDir }), added, 'so does editing one');

    assert.notEqual(
        migrationFingerprint({ ...BASE, migrationsDir, appVersion: '0.2.0' }),
        migrationFingerprint({ ...BASE, migrationsDir }),
        'so does a new app version',
    );
    assert.notEqual(
        migrationFingerprint({ ...BASE, migrationsDir, databaseIdentity: 'db.example.com:5432/other' }),
        migrationFingerprint({ ...BASE, migrationsDir }),
        'and so does pointing at somebody else database',
    );
});

test('anything that cannot be fingerprinted means run the migrations, never skip them', () => {
    const missing = path.join(os.tmpdir(), 'phone-farm-not-there-at-all');
    rmSync(missing, { recursive: true, force: true });
    assert.equal(migrationFingerprint({ ...BASE, migrationsDir: missing }), null);
    assert.equal(migrationFingerprint({ ...BASE, migrationsDir: drizzle({ 'notes.md': 'hi' }) }), null);

    // A null fingerprint can never match a stamp, and is never written as one.
    const stampFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'phone-farm-stamp-')), 'migrations.stamp');
    writeStamp(stampFile, null);
    assert.equal(readStamp(stampFile), null);
    assert.equal(migrationsAlreadyApplied(stampFile, null), false);
});

test('a stamp written after a clean run is what lets the next launch skip', () => {
    const migrationsDir = drizzle({ '0000_init.sql': 'create table a();' });
    const stampFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'phone-farm-stamp-')), 'migrations.stamp');
    const fingerprint = migrationFingerprint({ ...BASE, migrationsDir });

    assert.equal(migrationsAlreadyApplied(stampFile, fingerprint), false, 'nothing has run yet');

    writeStamp(stampFile, fingerprint);
    assert.equal(migrationsAlreadyApplied(stampFile, fingerprint), true);

    // A different database with the same files is a different stamp entirely.
    const elsewhere = migrationFingerprint({ ...BASE, migrationsDir, databaseIdentity: 'other:5432/db' });
    assert.equal(migrationsAlreadyApplied(stampFile, elsewhere), false);
});

test('a corrupt stamp file is treated as no stamp', () => {
    const stampFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'phone-farm-stamp-')), 'migrations.stamp');
    writeFileSync(stampFile, 'not json at all');
    assert.equal(readStamp(stampFile), null);
    assert.equal(migrationsAlreadyApplied(stampFile, 'abc'), false);

    writeFileSync(stampFile, '{"fingerprint": 42}');
    assert.equal(readStamp(stampFile), null);
});

test('clearing the stamp forces a re-run — what a database reset must do', () => {
    const stampFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'phone-farm-stamp-')), 'migrations.stamp');
    writeStamp(stampFile, 'abc');
    assert.equal(migrationsAlreadyApplied(stampFile, 'abc'), true);

    clearStamp(stampFile);
    assert.equal(migrationsAlreadyApplied(stampFile, 'abc'), false, 'a fresh cluster has none of them applied');
});

test('the database identity carries no credentials and survives an unparseable URL', () => {
    assert.equal(
        databaseIdentity('postgresql://phone_farm:hunter2@127.0.0.1:55432/phone_farm'),
        '127.0.0.1:55432/phone_farm',
    );
    assert.ok(!databaseIdentity('postgresql://u:hunter2@h:5432/d').includes('hunter2'));
    assert.equal(databaseIdentity('postgresql://h/phone_farm'), 'h:5432/phone_farm', 'the default port is implied');
    assert.notEqual(databaseIdentity('nonsense'), databaseIdentity('other nonsense'));
});
