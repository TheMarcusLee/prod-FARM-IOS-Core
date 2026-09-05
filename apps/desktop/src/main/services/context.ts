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

export function tsxArgs(script: string): string[] {
    return ['--import', 'tsx', script];
}
