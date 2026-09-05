import { spawnService } from '../process.ts';
import type { ServiceDefinition } from '../types.ts';
import { farmNodeSpawn, tsxArgs, type ServiceContext } from './context.ts';

/** The scheduler worker. No health endpoint of its own; running is healthy. */
export function workerService(context: ServiceContext): ServiceDefinition {
    return {
        id: 'worker',
        label: 'Scheduler worker',
        help: 'docs/architecture.md',
        dependsOn: ['migrations'],
        launch: (runContext) => Promise.resolve(
            spawnService(farmNodeSpawn(context, tsxArgs('src/scheduler/worker.ts')), runContext),
        ),
    };
}
