import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    LEGACY_DATA_DIR_NAME, migrateLegacyDataDirectory, planDataMigration,
    realIo, type DirectoryProbe, type MigrationIo,
} from '../src/main/data-migration.ts';

const SUPPORT = '/Users/someone/Library/Application Support';
const LEGACY = path.join(SUPPORT, LEGACY_DATA_DIR_NAME);
const DATA = path.join(SUPPORT, 'Backline');

/** A filesystem that is nothing but a directory listing per path. */
function layout(entries: Record<string, string[]>): DirectoryProbe {
    return { entries: (directory) => entries[directory] ?? null };
}

test('an install from before the rename is moved across on the first launch', () => {
    const plan = planDataMigration(LEGACY, DATA, layout({
        [LEGACY]: ['settings.json', 'postgres', 'logs', 'devices.json'],
    }));
    assert.equal(plan.move, true);
    assert.match(plan.reason, /Phone Farm/);

    // A cluster with no settings file beside it is still an install worth keeping.
    assert.equal(planDataMigration(LEGACY, DATA, layout({ [LEGACY]: ['postgres'] })).move, true);
    // So is one Electron already made a (cache-only) new directory beside.
    assert.equal(planDataMigration(LEGACY, DATA, layout({
        [LEGACY]: ['settings.json'],
        [DATA]: ['Cache', 'Local Storage', 'blob_storage'],
    })).move, true);
});

test('the old directory is never touched again once the new one has content', () => {
    for (const held of ['settings.json', 'postgres', 'logs', 'devices.json']) {
        const plan = planDataMigration(LEGACY, DATA, layout({
            [LEGACY]: ['settings.json', 'postgres'],
            [DATA]: [held],
        }));
        assert.equal(plan.move, false, `${held} in the new directory stops the migration`);
        assert.match(plan.reason, /already holds Backline's data/);
    }
});

test('nothing is moved when there is nothing, or nothing real, to move', () => {
    assert.equal(planDataMigration(LEGACY, DATA, layout({ [DATA]: [] })).move, false);
    assert.match(planDataMigration(LEGACY, DATA, layout({})).reason, /No Phone Farm directory/);
    // A folder that only carries the old name is not somebody's farm.
    const stray = planDataMigration(LEGACY, DATA, layout({ [LEGACY]: ['notes.txt', '.DS_Store'] }));
    assert.equal(stray.move, false);
    assert.match(stray.reason, /no settings or database/);
});

test('the move is a rename, and what it renames depends on what is already there', () => {
    const renames: [string, string][] = [];
    const removed: string[] = [];
    const io = (entries: Record<string, string[]>): MigrationIo => ({
        entries: layout(entries).entries,
        rename: (from, to) => { renames.push([from, to]); },
        removeEmptyDirectory: (directory) => { removed.push(directory); },
    });

    // Nothing in the way: one rename of the whole directory.
    assert.equal(migrateLegacyDataDirectory(LEGACY, DATA, io({ [LEGACY]: ['settings.json'] })).moved, true);
    assert.deepEqual(renames, [[LEGACY, DATA]]);
    assert.deepEqual(removed, []);

    // An empty new directory is removed first, so the rename has a free path.
    renames.length = 0;
    migrateLegacyDataDirectory(LEGACY, DATA, io({ [LEGACY]: ['postgres'], [DATA]: [] }));
    assert.deepEqual(removed, [DATA]);
    assert.deepEqual(renames, [[LEGACY, DATA]]);

    // Electron's caches are already there: the contents move in, one at a time.
    renames.length = 0;
    migrateLegacyDataDirectory(LEGACY, DATA, io({ [LEGACY]: ['settings.json', 'postgres'], [DATA]: ['Cache'] }));
    assert.deepEqual(renames, [
        [path.join(LEGACY, 'settings.json'), path.join(DATA, 'settings.json')],
        [path.join(LEGACY, 'postgres'), path.join(DATA, 'postgres')],
    ]);
});

test('a rename that cannot be made leaves both directories and names them in a notice', () => {
    const result = migrateLegacyDataDirectory(LEGACY, DATA, {
        entries: layout({ [LEGACY]: ['settings.json', 'postgres'] }).entries,
        rename: () => { throw new Error('EXDEV: cross-device link not permitted'); },
        removeEmptyDirectory: () => undefined,
    });

    assert.equal(result.moved, false);
    assert.match(result.reason, /Could not move/);
    const notice = result.notice;
    assert.ok(notice, 'the operator is told');
    assert.match(notice.message, new RegExp(LEGACY.replaceAll('/', '\\/')));
    assert.match(notice.message, new RegExp(DATA.replaceAll('/', '\\/')));
    assert.match(notice.message, /nothing was deleted/);
    // A migration that was never wanted is not a notice.
    assert.equal(migrateLegacyDataDirectory(LEGACY, DATA, {
        entries: layout({ [DATA]: ['settings.json'] }).entries,
        rename: () => { throw new Error('never called'); },
        removeEmptyDirectory: () => undefined,
    }).notice, null);
});

test('on a real filesystem the data arrives in the new directory', () => {
    const support = mkdtempSync(path.join(os.tmpdir(), 'farm-support-'));
    const legacy = path.join(support, LEGACY_DATA_DIR_NAME);
    const data = path.join(support, 'Backline');
    mkdirSync(path.join(legacy, 'postgres'), { recursive: true });
    writeFileSync(path.join(legacy, 'settings.json'), '{"webPort":3000}');
    // Electron made the new directory and put a cache in it before we ran.
    mkdirSync(path.join(data, 'Cache'), { recursive: true });

    assert.equal(migrateLegacyDataDirectory(legacy, data, realIo).moved, true);
    assert.equal(readFileSync(path.join(data, 'settings.json'), 'utf8'), '{"webPort":3000}');
    assert.ok(existsSync(path.join(data, 'postgres')));
    assert.ok(existsSync(path.join(data, 'Cache')), 'what was already there is kept');
    assert.ok(!existsSync(path.join(legacy, 'settings.json')));

    // A second launch is a no-op, whatever is left beside the new directory.
    writeFileSync(path.join(legacy, 'settings.json'), 'stale');
    const again = migrateLegacyDataDirectory(legacy, data, realIo);
    assert.equal(again.moved, false);
    assert.equal(readFileSync(path.join(data, 'settings.json'), 'utf8'), '{"webPort":3000}');
});
