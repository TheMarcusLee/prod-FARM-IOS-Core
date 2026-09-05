import type { ServiceDefinition } from '../types.ts';
import { adbService } from './adb.ts';
import { appiumService } from './appium.ts';
import { migrationsService } from './migrations.ts';
import { postgresService } from './postgres.ts';
import { wdaService } from './wda.ts';
import { webService } from './web.ts';
import { workerService } from './worker.ts';
import type { ServiceContext } from './context.ts';

export type { ServiceContext } from './context.ts';

/** Declaration order is also the start order for services with no dependencies. */
export function buildServices(context: ServiceContext): ServiceDefinition[] {
    return [
        postgresService(context),
        migrationsService(context),
        adbService(context),
        appiumService(context),
        wdaService(context),
        workerService(context),
        webService(context),
    ];
}
