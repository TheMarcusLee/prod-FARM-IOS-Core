import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { LaunchContext, RunHandle } from './types.ts';

/** The postmaster's own lock file. Its first line is the pid that holds the cluster. */
export const LOCK_FILE = 'postmaster.pid';

export interface EmbeddedPostgresOptions {
    dataDir: string;
    port: number;
    user: string;
    password: string;
    database: string;
}

interface EmbeddedPostgresInstance {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
}

type EmbeddedPostgresConstructor = new (options: Record<string, unknown>) => EmbeddedPostgresInstance;

/**
 * `embedded-postgres` is ESM-only and pulls a large platform binary, so it is
 * imported lazily: an install without the matching `@embedded-postgres/*` package
 * must degrade to "not configured", not crash the app at startup.
 */
async function loadEmbeddedPostgres(): Promise<EmbeddedPostgresConstructor> {
    const module = await import('embedded-postgres');
    const candidate = (module as { default?: unknown }).default ?? module;
    return candidate as EmbeddedPostgresConstructor;
}

export async function embeddedPostgresAvailable(): Promise<boolean> {
    try {
        await loadEmbeddedPostgres();
        return true;
    } catch {
        return false;
    }
}

/** True once initdb has run in this data directory. */
export function clusterInitialised(dataDir: string): boolean {
    return existsSync(path.join(dataDir, 'PG_VERSION'));
}

export type LockVerdict =
    | { kind: 'absent' }
    | { kind: 'held'; pid: number }
    | { kind: 'stale'; pid: number | null; reason: string };

/**
 * What `postmaster.pid` in a data directory means right now.
 *
 * Postgres refuses to start while that file is there, and after a hard kill of
 * the app — or of the machine — it is there with a pid that no longer exists.
 * The operator then sees "pg_ctl start failed" for ever with nothing actionable
 * in it, which is exactly the half-dead state this app must not produce. This
 * decides whether the file describes a live postmaster or is simply litter.
 */
export function readLock(dataDir: string, alive: (pid: number) => boolean): LockVerdict {
    let contents: string;
    try {
        contents = readFileSync(path.join(dataDir, LOCK_FILE), 'utf8');
    } catch {
        return { kind: 'absent' };
    }
    const first = contents.split('\n')[0]?.trim() ?? '';
    const pid = Number.parseInt(first, 10);
    if (!Number.isInteger(pid) || pid <= 1) {
        return { kind: 'stale', pid: null, reason: `${LOCK_FILE} does not start with a pid` };
    }
    if (alive(pid)) return { kind: 'held', pid };
    return { kind: 'stale', pid, reason: `no process is running under pid ${pid}` };
}

/** `process.kill(pid, 0)` as a predicate: true when a process holds that pid. */
export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means it exists but belongs to another user, which still counts.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Removes a `postmaster.pid` that no live postmaster owns. Returns what it did.
 *
 * Only ever removes the lock file itself: everything else in the data directory
 * is the operator's data, and a crash recovery on the next start is Postgres's
 * job, not this app's.
 */
export async function clearStaleLock(
    dataDir: string, alive: (pid: number) => boolean = pidAlive,
): Promise<LockVerdict> {
    const verdict = readLock(dataDir, alive);
    if (verdict.kind === 'stale') await rm(path.join(dataDir, LOCK_FILE), { force: true });
    return verdict;
}

/**
 * Starts (and on first run bootstraps) the bundled Postgres cluster.
 *
 * The role is created by initdb as the cluster superuser, so the only extra
 * bootstrap step is creating the application database.
 */
export async function startEmbeddedPostgres(
    options: EmbeddedPostgresOptions,
    context: LaunchContext,
): Promise<RunHandle> {
    const EmbeddedPostgres = await loadEmbeddedPostgres();
    await mkdir(path.dirname(options.dataDir), { recursive: true, mode: 0o700 });
    const first = !clusterInitialised(options.dataDir);

    const lock = await clearStaleLock(options.dataDir);
    if (lock.kind === 'stale') {
        context.log('app', `Removed a stale ${LOCK_FILE} (${lock.reason}) — the last run did not shut down cleanly.`);
    } else if (lock.kind === 'held') {
        context.log('app', `A postmaster is already running for this cluster (pid ${lock.pid}); reusing it.`);
    }

    const postgres = new EmbeddedPostgres({
        databaseDir: options.dataDir,
        user: options.user,
        password: options.password,
        port: options.port,
        authMethod: 'scram-sha-256',
        persistent: true,
        onLog: (message: unknown) => context.log('out', String(message)),
        onError: (message: unknown) => context.log('err', String(message)),
    });

    if (first) {
        context.log('app', `Initialising a new cluster in ${options.dataDir}`);
        await describeFailure('initdb', options, () => postgres.initialise());
    }
    context.log('app', `Starting Postgres on 127.0.0.1:${options.port}`);
    await describeFailure('pg_ctl start', options, () => postgres.start());

    if (first) {
        try {
            await postgres.createDatabase(options.database);
            context.log('app', `Created database ${options.database}`);
        } catch (error) {
            // A retried first run can find the database already there.
            context.log('app', `createDatabase(${options.database}): ${String(error)}`);
        }
    }

    let resolveExit: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
    return {
        pid: null,
        exited,
        async stop() {
            context.log('app', 'Stopping Postgres');
            try {
                await postgres.stop();
            } catch (error) {
                context.log('err', `stop failed: ${String(error)}`);
            }
            resolveExit(0);
        },
    };
}

/**
 * `embedded-postgres` rejects with a bare `undefined` when pg_ctl fails, so the
 * reason has to be reconstructed here or the operator sees "undefined".
 */
async function describeFailure(
    step: string, options: EmbeddedPostgresOptions, run: () => Promise<void>,
): Promise<void> {
    try {
        await run();
    } catch (error) {
        const cause = error instanceof Error ? error.message : String(error ?? '');
        const detail = cause && cause !== 'undefined' ? `: ${cause}` : '';
        throw new Error(
            `${step} failed for ${options.dataDir} on port ${options.port}${detail}. `
            + 'Check the service log — a leftover postmaster or a port clash is the usual cause.',
        );
    }
}

/** `postgres-backup-2026-01-02T03-04-05` beside the cluster it came from. */
export function backupDirFor(dataDir: string, at = new Date()): string {
    const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${dataDir}-backup-${stamp}`;
}

export interface ResetResult {
    /** Where the old cluster now is, or null when there was nothing to keep. */
    backupDir: string | null;
}

/**
 * Retires the cluster so a new one can be created in its place.
 *
 * It is deliberately a rename and not a delete. "Reset the database" is the one
 * button in this app that destroys the operator's whole farm — every device,
 * schedule and execution — and a non-technical operator reaches for it when
 * something looks broken, not when they want to lose their data. The old cluster
 * is moved aside and its path handed back to be shown; deleting it is then a
 * decision the operator makes in the Finder, with the data still in front of them.
 *
 * `expectedParent` is the app's own userData directory. An external DATABASE_URL
 * is refused a layer above, in the IPC handler, but this is the check that means
 * no code path can ever aim this function at somebody else's data.
 */
export async function resetEmbeddedPostgres(
    dataDir: string, expectedParent: string, at = new Date(),
): Promise<ResetResult> {
    const resolved = path.resolve(dataDir);
    const parent = path.resolve(expectedParent);
    if (path.dirname(resolved) !== parent || path.basename(resolved) !== 'postgres') {
        throw new Error(`Refusing to reset ${resolved}: it is not this app's bundled cluster.`);
    }
    if (!existsSync(resolved)) return { backupDir: null };
    // An empty directory is not data; moving it aside would only be confusing.
    if ((await readdir(resolved)).length === 0) {
        await rm(resolved, { recursive: true, force: true });
        return { backupDir: null };
    }
    const backupDir = backupDirFor(resolved, at);
    await rename(resolved, backupDir);
    return { backupDir };
}
