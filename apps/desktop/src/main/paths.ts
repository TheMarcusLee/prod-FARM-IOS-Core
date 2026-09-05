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
        if (farmEntryExtension(candidate) !== null) return candidate;
    }
    throw new Error(`Could not locate the farm repository (looked in ${candidates.join(', ')})`);
}

/**
 * `ts` for a checkout run through tsx, `js` for the compiled `farm-dist` tree the
 * packaged app ships, `null` when the directory is not a farm at all.
 */
export function farmEntryExtension(root: string): 'ts' | 'js' | null {
    if (existsSync(path.join(root, 'src', 'api', 'server.js'))) return 'js';
    if (existsSync(path.join(root, 'src', 'api', 'server.ts'))) return 'ts';
    return null;
}

export interface AppPaths {
    repoRoot: string;
    /** True when `repoRoot` holds compiled JavaScript, so children run without tsx. */
    compiled: boolean;
    userData: string;
    logsDir: string;
    postgresDataDir: string;
    schedulerDataDir: string;
    devicesConfigPath: string;
    wdaServiceSocket: string;
    /** APPIUM_HOME: where Appium keeps its installed drivers. */
    appiumHome: string;
}

export function appPaths(repoRoot: string, userData: string): AppPaths {
    const compiled = farmEntryExtension(repoRoot) === 'js';
    return {
        repoRoot,
        compiled,
        userData,
        logsDir: path.join(userData, 'logs'),
        postgresDataDir: path.join(userData, 'postgres'),
        schedulerDataDir: path.join(userData, 'scheduler-data'),
        devicesConfigPath: path.join(userData, 'devices.json'),
        // A Unix socket path must stay under ~104 bytes, so keep it short and flat.
        wdaServiceSocket: path.join(userData, 'wda.sock'),
        // Appium writes its driver manifest into APPIUM_HOME on every start. In a
        // checkout that is the repository's own `.appium2`, which is what the npm
        // scripts use, so `appium:install-driver` and the app share one driver. In
        // a packaged app `repoRoot` is inside the .app bundle: writing there breaks
        // the code signature and would be lost on the next update, so it moves to
        // the data directory with everything else the operator owns.
        appiumHome: compiled ? path.join(userData, 'appium') : path.join(repoRoot, '.appium2'),
    };
}
