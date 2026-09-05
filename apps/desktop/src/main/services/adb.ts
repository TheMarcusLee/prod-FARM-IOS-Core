import { runCommand } from '../health.ts';
import type { ServiceDefinition } from '../types.ts';
import type { ServiceContext } from './context.ts';

export const ADB_HELP = 'docs/android-dashboard.md';

/**
 * `adb start-server` is a one-shot: the daemon it launches outlives the command
 * and is shared with anything else on the machine, so the app never kills it.
 */
export function adbService(context: ServiceContext): ServiceDefinition {
    const env = { ...context.env, PATH: context.env.PATH ?? process.env.PATH ?? '' };
    return {
        id: 'adb',
        label: 'Android Debug Bridge',
        help: ADB_HELP,
        optional: true,
        oneshot: true,
        async preflight() {
            if (context.settings.androidDiscovery === 'off') {
                return { ok: false, reason: 'Android discovery is off in Settings; adb is not started.', help: ADB_HELP };
            }
            const version = await runCommand('adb', ['version'], { env, timeoutMs: 5_000 });
            if (!version.ok) {
                return {
                    ok: false,
                    reason: 'adb is not on PATH — install Android platform-tools, or set Android discovery to off.',
                    help: ADB_HELP,
                };
            }
            return { ok: true };
        },
        async launch(runContext) {
            const result = await runCommand('adb', ['start-server'], { env, timeoutMs: 20_000 });
            runContext.log(result.ok ? 'out' : 'err', `${result.stdout}${result.stderr}`.trim() || 'adb start-server');
            const devices = await runCommand('adb', ['devices'], { env, timeoutMs: 10_000 });
            runContext.log('out', devices.stdout.trim());
            return {
                pid: null,
                exited: Promise.resolve(result.ok ? 0 : 1),
                // Deliberately does not `adb kill-server`: the daemon is machine-wide.
                async stop() { /* shared daemon */ },
            };
        },
    };
}
