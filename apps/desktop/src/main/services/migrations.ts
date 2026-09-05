import path from 'node:path';

import {
    databaseIdentity, migrationFingerprint, migrationsAlreadyApplied, writeStamp,
} from '../migration-stamp.ts';
import { spawnService } from '../process.ts';
import type { RunHandle, ServiceDefinition } from '../types.ts';
import { farmEntryArgs, farmNodeSpawn, type ServiceContext } from './context.ts';

export const MIGRATION_STAMP_FILE = 'migrations.stamp';

/**
 * One-shot: runs the repo's drizzle + pg-boss migrations before worker/web start.
 *
 * It is a dependency of both, so it is asked to run on every launch, every
 * "restart all" and every settings change — each of which spawned a Node process
 * and a Postgres connection only to find there was nothing to do. A stamp file
 * records the fingerprint of the migration files, the app version and the target
 * database after a run that exited 0, and a matching stamp skips the spawn.
 *
 * The bias is always towards running: an unreadable `drizzle/`, a missing stamp,
 * a new or edited `.sql`, a different database or a new app version all re-run.
 */
export function migrationsService(context: ServiceContext): ServiceDefinition {
    const stampFile = path.join(context.paths.userData, MIGRATION_STAMP_FILE);
    const fingerprint = migrationFingerprint({
        migrationsDir: path.join(context.paths.repoRoot, 'drizzle'),
        databaseIdentity: databaseIdentity(context.databaseUrl),
        appVersion: context.appVersion,
    });

    return {
        id: 'migrations',
        label: 'Database migrations',
        help: 'docs/desktop.md#database',
        oneshot: true,
        dependsOn: ['postgres'],
        async launch(runContext): Promise<RunHandle> {
            if (migrationsAlreadyApplied(stampFile, fingerprint)) {
                runContext.log('app', 'Already applied for this version and database; nothing to do.');
                return { pid: null, exited: Promise.resolve(0), async stop() { /* nothing ran */ } };
            }
            const handle = spawnService(
                farmNodeSpawn(context, farmEntryArgs(context, 'src/database/migrate.ts')),
                runContext,
                'migrations',
            );
            // Stamped only on a clean exit, so a failed or killed run always retries.
            void handle.exited.then((code) => { if (code === 0) writeStamp(stampFile, fingerprint); });
            return handle;
        },
    };
}
