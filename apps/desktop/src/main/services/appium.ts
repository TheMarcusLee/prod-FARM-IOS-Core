import { existsSync } from 'node:fs';
import path from 'node:path';

import { httpOk } from '../health.ts';
import { spawnService } from '../process.ts';
import type { ServiceDefinition } from '../types.ts';
import { farmNodeSpawn, type ServiceContext } from './context.ts';

export const APPIUM_HELP = 'docs/getting-started.md';

/** Mirrors the repo's `npm run appium` script, including APPIUM_HOME isolation. */
export function appiumService(context: ServiceContext): ServiceDefinition {
    const entry = path.join(context.paths.repoRoot, 'node_modules', 'appium', 'index.js');
    const port = context.settings.appiumPort;
    return {
        id: 'appium',
        label: 'Appium',
        help: APPIUM_HELP,
        optional: true,
        dependsOn: [],
        healthTimeoutMs: 60_000,
        async preflight() {
            if (!existsSync(entry)) {
                return {
                    ok: false,
                    reason: 'Appium is not installed in the bundled checkout — iOS automation is unavailable.',
                    help: APPIUM_HELP,
                };
            }
            return { ok: true };
        },
        launch: (runContext) => Promise.resolve(spawnService(farmNodeSpawn(context, [
            entry, '--address', '127.0.0.1', '--base-path', '/', '--port', String(port), '--log-level', 'info',
        ]), runContext)),
        health: () => httpOk('/status', { port }),
    };
}
