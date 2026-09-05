import { mkdirSync } from 'node:fs';

import { widenedPath } from './health.ts';
import { LogFiles } from './logs.ts';
import type { AppPaths } from './paths.ts';
import { childEnvironment, embeddedDatabaseUrl, type Settings } from './settings.ts';
import { buildServices, type ServiceContext } from './services/index.ts';
import { Supervisor } from './supervisor.ts';

export function resolveDatabaseUrl(settings: Settings): string {
    return settings.databaseUrl.trim()
        || embeddedDatabaseUrl(settings.embeddedPostgresPort, settings.embeddedPostgresPassword);
}

export function buildServiceContext(paths: AppPaths, settings: Settings): ServiceContext {
    const databaseUrl = resolveDatabaseUrl(settings);
    mkdirSync(paths.schedulerDataDir, { recursive: true, mode: 0o700 });
    const env = childEnvironment({
        settings,
        databaseUrl,
        repoRoot: paths.repoRoot,
        schedulerDataDir: paths.schedulerDataDir,
        devicesConfigPath: paths.devicesConfigPath,
        wdaServiceSocket: paths.wdaServiceSocket,
    });
    return {
        paths,
        settings,
        databaseUrl,
        env: {
            ...env,
            PATH: widenedPath(),
            HOME: process.env.HOME ?? '',
            TMPDIR: process.env.TMPDIR ?? '/tmp',
            LANG: process.env.LANG ?? 'en_US.UTF-8',
        },
        nodeExecPath: process.execPath,
    };
}

export interface Fleet {
    supervisor: Supervisor;
    logs: LogFiles;
    context: ServiceContext;
}

export function createFleet(paths: AppPaths, settings: Settings): Fleet {
    const context = buildServiceContext(paths, settings);
    const logs = new LogFiles(paths.logsDir);
    const supervisor = new Supervisor(buildServices(context), {
        onLog: (id, line) => logs.append(id, line),
        logPathFor: (id) => logs.pathFor(id),
    });
    return { supervisor, logs, context };
}
