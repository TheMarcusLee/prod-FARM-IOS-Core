import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { postgresReady } from './health.ts';
import { registerChild, unregisterChild } from './process.ts';
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
    | { kind: 'held'; pid: number; port: number | null }
    | { kind: 'stale'; pid: number | null; reason: string };

/**
 * What `postmaster.pid` in a data directory means right now.
 *
 * Postgres refuses to start while that file is there, and after a hard kill of
 * the app — or of the machine — it is there with a pid that no longer exists.
 * The operator then sees "pg_ctl start failed" for ever with nothing actionable
 * in it, which is exactly the half-dead state this app must not produce. This
 * decides whether the file describes a live postmaster or is simply litter.
 *
 * The file's fourth line is the port the postmaster listens on; it is reported
 * for a held lock so the caller can tell "our cluster, our port" from "our
 * cluster, started with a setting the operator has since changed".
 */
export function readLock(dataDir: string, alive: (pid: number) => boolean): LockVerdict {
    let contents: string;
    try {
        contents = readFileSync(path.join(dataDir, LOCK_FILE), 'utf8');
    } catch {
        return { kind: 'absent' };
    }
    const lines = contents.split('\n');
    const first = lines[0]?.trim() ?? '';
    const pid = Number.parseInt(first, 10);
    if (!Number.isInteger(pid) || pid <= 1) {
        return { kind: 'stale', pid: null, reason: `${LOCK_FILE} does not start with a pid` };
    }
    if (!alive(pid)) return { kind: 'stale', pid, reason: `no process is running under pid ${pid}` };
    const port = Number.parseInt(lines[3]?.trim() ?? '', 10);
    return { kind: 'held', pid, port: Number.isInteger(port) && port > 0 ? port : null };
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

/** How the code below looks at, and acts on, a postmaster it did not spawn. */
export interface PostmasterTools {
    alive(pid: number): boolean;
    /** Does a postmaster answer on this port right now? */
    ready(port: number): Promise<boolean>;
    signal(pid: number, signal: NodeJS.Signals): void;
    sleep(ms: number): Promise<void>;
    now(): number;
}

export const defaultPostmasterTools: PostmasterTools = {
    alive: pidAlive,
    ready: (port) => postgresReady('127.0.0.1', port),
    signal(pid, signal) {
        try { process.kill(pid, signal); } catch { /* already gone */ }
    },
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
};

/** How long a leftover postmaster gets to answer before it is treated as unusable. */
export const ADOPT_TIMEOUT_MS = 10_000;
/** How long a fast shutdown (SIGINT) gets before the postmaster is killed outright. */
export const SHUTDOWN_TIMEOUT_MS = 15_000;

export type ClusterTakeover =
    /** Nothing was running; start a postmaster of our own. */
    | { kind: 'fresh' }
    /** A postmaster from a previous run is healthy on our port; it is ours now. */
    | { kind: 'adopted'; pid: number };

/**
 * Decides what to do about whatever is holding the cluster before starting it.
 *
 * `pkill` of the Electron process does not take the postmaster with it — it is an
 * ordinary child, not part of the supervised process tree — so the very next
 * launch finds a live postmaster holding the lock. Starting a second one on top
 * of it can only fail (`lock file "postmaster.pid" already exists`), and used to
 * fail on every retry, with migrations, worker and web waiting behind it for
 * ever. There are exactly three sane outcomes and this picks one of them:
 *
 *  - the lock is stale: remove it and start normally;
 *  - a live postmaster is on our port and answers: adopt it, spawn nothing;
 *  - a live postmaster is on another port, or never answers: it is still this
 *    app's cluster (the lock is in our data directory), so shut it down and start.
 */
export async function takeOverCluster(
    dataDir: string,
    port: number,
    context: LaunchContext,
    tools: PostmasterTools = defaultPostmasterTools,
): Promise<ClusterTakeover> {
    const lock = await clearStaleLock(dataDir, tools.alive);
    if (lock.kind === 'absent') return { kind: 'fresh' };
    if (lock.kind === 'stale') {
        context.log('app', `Removed a stale ${LOCK_FILE} (${lock.reason}) — the last run did not shut down cleanly.`);
        return { kind: 'fresh' };
    }

    const where = lock.port === null ? 'an unknown port' : `port ${lock.port}`;
    context.log('app', `A postmaster from a previous run still holds this cluster (pid ${lock.pid}, ${where}).`);
    if (lock.port === null || lock.port === port) {
        const deadline = tools.now() + ADOPT_TIMEOUT_MS;
        for (;;) {
            if (await tools.ready(port)) {
                context.log('app', `It answers on 127.0.0.1:${port}; reusing it instead of starting a second one.`);
                return { kind: 'adopted', pid: lock.pid };
            }
            if (!tools.alive(lock.pid) || tools.now() >= deadline) break;
            await tools.sleep(500);
        }
    }

    context.log(
        'app',
        lock.port !== null && lock.port !== port
            ? `It is on ${where}, not the configured port ${port}; shutting it down before starting.`
            : 'It does not answer; shutting it down before starting.',
    );
    await shutdownPostmaster(lock.pid, tools);
    if (tools.alive(lock.pid)) {
        throw new Error(
            `A postmaster from a previous run (pid ${lock.pid}) holds ${dataDir} and would not stop. `
            + 'Quit it (or reboot) and the next start will succeed.',
        );
    }
    const after = await clearStaleLock(dataDir, tools.alive);
    if (after.kind === 'stale') context.log('app', `Removed the ${LOCK_FILE} it left behind.`);
    return { kind: 'fresh' };
}

/** SIGINT is Postgres's "fast shutdown"; SIGKILL only when that is ignored. */
async function shutdownPostmaster(pid: number, tools: PostmasterTools): Promise<void> {
    if (!tools.alive(pid)) return;
    tools.signal(pid, 'SIGINT');
    const deadline = tools.now() + SHUTDOWN_TIMEOUT_MS;
    while (tools.alive(pid) && tools.now() < deadline) await tools.sleep(250);
    if (!tools.alive(pid)) return;
    tools.signal(pid, 'SIGKILL');
    const hardDeadline = tools.now() + 5_000;
    while (tools.alive(pid) && tools.now() < hardDeadline) await tools.sleep(250);
}

/** Test seams: the library constructor and the process tools. */
export interface EmbeddedPostgresDeps {
    load?(): Promise<EmbeddedPostgresConstructor>;
    tools?: PostmasterTools;
}

/**
 * Starts (and on first run bootstraps) the bundled Postgres cluster — or adopts
 * the one a previous run left running.
 *
 * The role is created by initdb as the cluster superuser, so the only extra
 * bootstrap step is creating the application database.
 *
 * Whichever way the postmaster came to be, its pid is recorded among the
 * supervised children: a relaunch after a crash of this app then kills it the
 * way it kills a leftover appium or worker, instead of tripping over it.
 */
export async function startEmbeddedPostgres(
    options: EmbeddedPostgresOptions,
    context: LaunchContext,
    deps: EmbeddedPostgresDeps = {},
): Promise<RunHandle> {
    const tools = deps.tools ?? defaultPostmasterTools;
    const EmbeddedPostgres = await (deps.load ?? loadEmbeddedPostgres)();
    await mkdir(path.dirname(options.dataDir), { recursive: true, mode: 0o700 });
    const first = !clusterInitialised(options.dataDir);

    const takeover = await takeOverCluster(options.dataDir, options.port, context, tools);
    if (takeover.kind === 'adopted') return adoptedHandle(takeover.pid, context, tools);

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

    // The library keeps its child private; the lock file it just wrote is the
    // authoritative pid anyway, and the child's own pid is the fallback.
    const lock = readLock(options.dataDir, tools.alive);
    const pid = lock.kind === 'held'
        ? lock.pid
        : ((postgres as unknown as { process?: { pid?: number } }).process?.pid ?? null);
    if (pid !== null) registerChild(pid, 'postgres');

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
        pid,
        exited,
        async stop() {
            context.log('app', 'Stopping Postgres');
            try {
                await postgres.stop();
            } catch (error) {
                context.log('err', `stop failed: ${String(error)}`);
            }
            if (pid !== null) unregisterChild(pid);
            resolveExit(0);
        },
    };
}

/**
 * A handle over a postmaster this process did not spawn. It never reports an
 * exit — like the library's own handle — so the supervisor's health sweep is
 * what notices it dying; stopping it is a fast shutdown by signal.
 */
function adoptedHandle(pid: number, context: LaunchContext, tools: PostmasterTools): RunHandle {
    registerChild(pid, 'postgres');
    let resolveExit: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
    return {
        pid,
        exited,
        async stop() {
            context.log('app', `Stopping Postgres (pid ${pid})`);
            await shutdownPostmaster(pid, tools);
            unregisterChild(pid);
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
