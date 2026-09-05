import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Where the farm repository lives.
 *
 * Dev: `apps/desktop` sits inside the checkout, so the root is two levels up.
 * Packaged: electron-builder copies the checkout (with node_modules) into
 * `Contents/Resources/farm` via `extraResources`.
 */
export function resolveRepoRoot(appPath: string, resourcesPath: string, packaged: boolean): string {
    const candidates = packaged
        ? [path.join(resourcesPath, 'farm')]
        : [path.resolve(appPath, '..', '..'), path.join(resourcesPath, 'farm')];
    for (const candidate of candidates) {
        if (existsSync(path.join(candidate, 'src', 'api', 'server.ts'))) return candidate;
    }
    throw new Error(`Could not locate the farm repository (looked in ${candidates.join(', ')})`);
}

export interface AppPaths {
    repoRoot: string;
    userData: string;
    logsDir: string;
    postgresDataDir: string;
    schedulerDataDir: string;
    devicesConfigPath: string;
    wdaServiceSocket: string;
}

export function appPaths(repoRoot: string, userData: string): AppPaths {
    return {
        repoRoot,
        userData,
        logsDir: path.join(userData, 'logs'),
        postgresDataDir: path.join(userData, 'postgres'),
        schedulerDataDir: path.join(userData, 'scheduler-data'),
        devicesConfigPath: path.join(userData, 'devices.json'),
        // A Unix socket path must stay under ~104 bytes, so keep it short and flat.
        wdaServiceSocket: path.join(userData, 'wda.sock'),
    };
}
