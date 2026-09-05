import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { LaunchContext, RunHandle } from './types.ts';

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

/** Deletes the cluster. The caller must have stopped the service first. */
export async function resetEmbeddedPostgres(dataDir: string): Promise<void> {
    await rm(dataDir, { recursive: true, force: true });
}
