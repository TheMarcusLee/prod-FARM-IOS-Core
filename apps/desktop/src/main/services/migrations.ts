import { spawnService } from '../process.ts';
import type { ServiceDefinition } from '../types.ts';
import { farmNodeSpawn, tsxArgs, type ServiceContext } from './context.ts';

/** One-shot: runs the repo's drizzle + pg-boss migrations before worker/web start. */
export function migrationsService(context: ServiceContext): ServiceDefinition {
    return {
        id: 'migrations',
        label: 'Database migrations',
        help: 'docs/desktop.md#database',
        oneshot: true,
        dependsOn: ['postgres'],
        launch: (runContext) => Promise.resolve(
            spawnService(farmNodeSpawn(context, tsxArgs('src/database/migrate.ts')), runContext),
        ),
    };
}
