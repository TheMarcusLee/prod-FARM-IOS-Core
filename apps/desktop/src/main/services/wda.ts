import { existsSync } from 'node:fs';

import { httpOk, runCommand } from '../health.ts';
import { spawnService } from '../process.ts';
import type { ServiceDefinition } from '../types.ts';
import { farmEntryArgs, farmNodeSpawn, type ServiceContext } from './context.ts';

export const WDA_HELP = 'docs/getting-started.md';

/**
 * The WebDriverAgent supervisor. Needs Xcode and signing material, so on a
 * machine without either it reports `not configured` and the Android-only
 * dashboard keeps working.
 */
export function wdaService(context: ServiceContext): ServiceDefinition {
    const socketPath = context.paths.wdaServiceSocket;
    return {
        id: 'wda',
        label: 'WDA service',
        help: WDA_HELP,
        optional: true,
        dependsOn: [],
        healthTimeoutMs: 60_000,
        async preflight() {
            if (process.platform !== 'darwin') {
                return { ok: false, reason: 'WebDriverAgent needs macOS with Xcode.', help: WDA_HELP };
            }
            const xcode = await runCommand('xcodebuild', ['-version'], { timeoutMs: 20_000 });
            if (!xcode.ok) {
                return {
                    ok: false,
                    reason: 'Xcode command line tools are unavailable — iOS devices cannot be supervised.',
                    help: WDA_HELP,
                };
            }
            if (!context.settings.xcodeOrgId) {
                return {
                    ok: false,
                    reason: 'Set XCODE_ORG_ID in Settings before WebDriverAgent can be signed and started.',
                    help: WDA_HELP,
                };
            }
            return { ok: true };
        },
        launch: (runContext) => Promise.resolve(
            spawnService(farmNodeSpawn(context, farmEntryArgs(context, 'src/devices/wda-service.ts')), runContext, 'wda'),
        ),
        // The service talks HTTP over a Unix socket; existence of the socket alone
        // is not enough because a stale file survives a hard kill.
        health: async () => existsSync(socketPath) && httpOk('/health', { socketPath }),
    };
}
