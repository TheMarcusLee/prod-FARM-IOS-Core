import { httpOk } from '../health.ts';
import { spawnService } from '../process.ts';
import type { ServiceDefinition } from '../types.ts';
import { farmNodeSpawn, tsxArgs, type ServiceContext } from './context.ts';

/** The Fastify dashboard the main window loads once `/health` answers. */
export function webService(context: ServiceContext): ServiceDefinition {
    const port = context.settings.webPort;
    return {
        id: 'web',
        label: 'Dashboard (web)',
        help: 'docs/desktop.md#services',
        dependsOn: ['migrations'],
        healthTimeoutMs: 90_000,
        launch: (runContext) => Promise.resolve(
            spawnService(farmNodeSpawn(context, tsxArgs('src/api/server.ts')), runContext),
        ),
        health: () => httpOk('/health', { port }),
    };
}
