import type { AppPaths } from '../paths.ts';
import type { Settings } from '../settings.ts';

/** Everything a service definition needs, resolved once per fleet build. */
export interface ServiceContext {
    paths: AppPaths;
    settings: Settings;
    /** The connection string children are given (override, or the embedded one). */
    databaseUrl: string;
    /** Environment for every farm child process. */
    env: Record<string, string>;
    /** Node-compatible executable: `process.execPath` with ELECTRON_RUN_AS_NODE. */
    nodeExecPath: string;
}

/** `node --import tsx <script>` in the farm checkout, run through the Electron binary. */
export function farmNodeSpawn(context: ServiceContext, args: readonly string[]) {
    return {
        file: context.nodeExecPath,
        args,
        cwd: context.paths.repoRoot,
        env: {
            ...context.env,
            // Makes the Electron binary behave as plain Node, so a packaged app needs
            // no separate Node runtime on the operator's machine.
            ELECTRON_RUN_AS_NODE: '1',
            NODE_ENV: process.env.NODE_ENV ?? 'production',
        },
    };
}

/**
 * Node arguments that run one farm entry point.
 *
 * A checkout is TypeScript and needs the `tsx` loader; the packaged app ships
 * `farm-dist`, which is plain JavaScript compiled ahead of time and carries no
 * TypeScript toolchain at all, so there the same script is spawned with nothing
 * but its `.js` path. `src/runtime/farm-entry.ts` does the same for the farm's
 * own child processes.
 */
export function farmEntryArgs(context: ServiceContext, script: string): string[] {
    const entry = context.paths.compiled && script.endsWith('.ts')
        ? `${script.slice(0, -'.ts'.length)}.js`
        : script;
    return entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry];
}
