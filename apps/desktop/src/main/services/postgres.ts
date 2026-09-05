import { postgresReady } from '../health.ts';
import { embeddedPostgresAvailable, startEmbeddedPostgres } from '../embedded-postgres.ts';
import { EMBEDDED_DB_NAME, EMBEDDED_DB_USER } from '../settings.ts';
import type { ServiceDefinition } from '../types.ts';
import type { ServiceContext } from './context.ts';

export const POSTGRES_HELP = 'docs/desktop.md#database';

/**
 * Either supervises the bundled cluster, or — when the operator supplied an
 * external DATABASE_URL — just waits for their server to answer.
 */
export function postgresService(context: ServiceContext): ServiceDefinition {
    const external = context.settings.databaseUrl.trim().length > 0;
    const target = external ? parseTarget(context.settings.databaseUrl) : {
        host: '127.0.0.1',
        port: context.settings.embeddedPostgresPort,
    };

    if (external) {
        return {
            id: 'postgres',
            label: 'PostgreSQL (external)',
            help: POSTGRES_HELP,
            healthTimeoutMs: 20_000,
            async preflight() {
                if (!target) {
                    return { ok: false, reason: 'The DATABASE_URL in Settings could not be parsed.', help: POSTGRES_HELP };
                }
                return { ok: true };
            },
            async launch(runContext) {
                runContext.log('app', `Using the external database at ${target?.host}:${target?.port}`);
                // Nothing to supervise: an external server has its own lifecycle.
                return {
                    pid: null,
                    exited: new Promise<number | null>(() => undefined),
                    async stop() { /* not ours to stop */ },
                };
            },
            health: async () => (target ? postgresReady(target.host, target.port) : false),
        };
    }

    return {
        id: 'postgres',
        label: 'PostgreSQL (bundled)',
        help: POSTGRES_HELP,
        healthTimeoutMs: 120_000,
        async preflight() {
            if (await embeddedPostgresAvailable()) return { ok: true };
            return {
                ok: false,
                reason: 'The bundled Postgres binaries are missing — set an external DATABASE_URL in Settings, or reinstall.',
                help: POSTGRES_HELP,
            };
        },
        launch: (runContext) => startEmbeddedPostgres({
            dataDir: context.paths.postgresDataDir,
            port: context.settings.embeddedPostgresPort,
            user: EMBEDDED_DB_USER,
            password: context.settings.embeddedPostgresPassword,
            database: EMBEDDED_DB_NAME,
        }, runContext),
        health: () => postgresReady('127.0.0.1', context.settings.embeddedPostgresPort),
    };
}

function parseTarget(url: string): { host: string; port: number } | null {
    try {
        const parsed = new URL(url);
        return { host: parsed.hostname || '127.0.0.1', port: Number(parsed.port || 5432) };
    } catch {
        return null;
    }
}
