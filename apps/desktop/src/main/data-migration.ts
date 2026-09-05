import { readdirSync, renameSync, rmdirSync } from 'node:fs';
import path from 'node:path';

import type { StartupNotice } from './types.ts';

/**
 * Moving the data directory left behind by the rename to Backline.
 *
 * `app.setName('Backline')` changed userData from
 * `~/Library/Application Support/Phone Farm` to `…/Backline`, which silently
 * hides an existing install's settings, database, devices and logs: the app
 * starts up looking brand new beside a folder holding everything the operator
 * has. On the first launch after the rename the old directory is moved across,
 * once, before anything opens a file in the new one.
 *
 * The decision is deliberately conservative and one-way: it only ever fires when
 * the new directory holds none of the app's own data, so a farm that has been
 * running under the new name is never touched again, whatever is left beside it.
 */
export const LEGACY_DATA_DIR_NAME = 'Phone Farm';

/**
 * What makes a directory somebody's farm rather than an empty shell.
 *
 * "Empty" cannot be taken literally for the *new* directory: Electron creates
 * userData and writes its own caches into it before the first line of this app
 * runs, so an emptiness test would never be true and the migration would never
 * happen. What matters is whether any of the app's own data is there — those
 * files are the whole of what this app keeps (see docs/desktop.md, "Where data
 * lives"), and Chromium's caches are worth nothing and are recreated anyway.
 */
export const APP_DATA_ENTRIES = [
    'settings.json',
    'postgres',
    'logs',
    'devices.json',
    'scheduler-data',
    'migrations.stamp',
    'supervised-children.json',
    'appium',
] as const;

/**
 * What makes the *old* directory worth moving: real state, not a stray folder
 * that happens to carry the old name. Settings hold the generated database
 * password, and the cluster holds everything else.
 */
export const LEGACY_EVIDENCE = ['settings.json', 'postgres'] as const;

/** Just enough filesystem for the decision, so the tests can invent a layout. */
export interface DirectoryProbe {
    /** The directory's entries, or null when it does not exist. */
    entries(directory: string): readonly string[] | null;
}

export const realProbe: DirectoryProbe = {
    entries(directory) {
        try {
            return readdirSync(directory);
        } catch {
            return null;
        }
    },
};

export interface MigrationPlan {
    move: boolean;
    /** One sentence for the log, said the same way whether it moved or not. */
    reason: string;
}

function hasAny(entries: readonly string[] | null, wanted: readonly string[]): boolean {
    if (!entries) return false;
    return wanted.some((name) => entries.includes(name));
}

/**
 * Whether the old data directory should become the new one. Pure: the whole
 * decision is these two listings.
 */
export function planDataMigration(legacyDir: string, dataDir: string, probe: DirectoryProbe = realProbe): MigrationPlan {
    const legacy = probe.entries(legacyDir);
    const current = probe.entries(dataDir);
    if (hasAny(current, APP_DATA_ENTRIES)) {
        return { move: false, reason: `${dataDir} already holds Backline's data; the old directory is left alone.` };
    }
    if (legacy === null) {
        return { move: false, reason: `No ${LEGACY_DATA_DIR_NAME} directory to migrate.` };
    }
    if (!hasAny(legacy, LEGACY_EVIDENCE)) {
        return { move: false, reason: `${legacyDir} holds no settings or database; nothing to migrate.` };
    }
    return { move: true, reason: `Moving ${legacyDir} to ${dataDir}.` };
}

/** Everything the move itself needs, so a test can make a rename fail. */
export interface MigrationIo extends DirectoryProbe {
    rename(from: string, to: string): void;
    /** Removes a directory only when it is empty; throws otherwise. */
    removeEmptyDirectory(directory: string): void;
}

export const realIo: MigrationIo = {
    entries: realProbe.entries,
    rename: (from, to) => { renameSync(from, to); },
    removeEmptyDirectory: (directory) => { rmdirSync(directory); },
};

export interface MigrationResult {
    moved: boolean;
    reason: string;
    /** Set only when the move was wanted and could not be made. */
    notice: StartupNotice | null;
}

/**
 * Runs the plan.
 *
 * A rename of the whole directory is the operation this wants: atomic, and it
 * cannot half-copy a Postgres cluster. It is only possible when the new path is
 * free, so an existing (cache-only) directory is removed first when it is empty,
 * and otherwise the entries are moved across one by one — still renames, still
 * no copying, just several of them.
 *
 * Every failure mode ends the same way: both directories are left exactly where
 * they are and the operator is told, in the Starting window, which two paths to
 * look at. Nothing is deleted and nothing is retried behind their back.
 */
export function migrateLegacyDataDirectory(
    legacyDir: string, dataDir: string, io: MigrationIo = realIo,
): MigrationResult {
    const plan = planDataMigration(legacyDir, dataDir, io);
    if (!plan.move) return { moved: false, reason: plan.reason, notice: null };
    try {
        const current = io.entries(dataDir);
        if (current === null) {
            io.rename(legacyDir, dataDir);
        } else if (current.length === 0) {
            io.removeEmptyDirectory(dataDir);
            io.rename(legacyDir, dataDir);
        } else {
            // Electron got there first and left its caches. Move the contents in.
            for (const entry of io.entries(legacyDir) ?? []) {
                io.rename(path.join(legacyDir, entry), path.join(dataDir, entry));
            }
        }
        return { moved: true, reason: `Moved ${legacyDir} to ${dataDir}.`, notice: null };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
            moved: false,
            reason: `Could not move ${legacyDir} to ${dataDir}: ${detail}`,
            notice: {
                title: 'Your data from the old "Phone Farm" folder was not moved',
                message: `Backline could not move ${legacyDir} to ${dataDir} (${detail}). `
                    + 'Both folders are still there and nothing was deleted; it is now starting '
                    + 'with an empty one. Quit Backline and move the folder across in the Finder, '
                    + 'or start again empty.',
            },
        };
    }
}
