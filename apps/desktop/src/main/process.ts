import { spawn, type ChildProcess } from 'node:child_process';

import type { LaunchContext, RunHandle } from './types.ts';

export interface SpawnSpec {
    file: string;
    args: readonly string[];
    cwd: string;
    env: Record<string, string>;
    /** Grace period before SIGKILL. */
    stopTimeoutMs?: number;
}

/**
 * Runs a farm service as a child process.
 *
 * In a packaged app there is no standalone `node`, so the caller passes
 * `process.execPath` with ELECTRON_RUN_AS_NODE=1 — the Electron binary then
 * behaves exactly like the Node it embeds.
 */
export function spawnService(spec: SpawnSpec, context: LaunchContext): RunHandle {
    context.log('app', `$ ${spec.file} ${spec.args.join(' ')}`);
    const child = spawn(spec.file, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so stopping the service also stops anything it spawned.
        detached: true,
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => context.log('out', chunk));
    child.stderr?.on('data', (chunk: string) => context.log('err', chunk));
    return childHandle(child, spec.stopTimeoutMs ?? 10_000, context);
}

export function childHandle(child: ChildProcess, stopTimeoutMs: number, context: LaunchContext): RunHandle {
    const exited = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
        child.once('error', (error) => {
            context.log('err', `failed to spawn: ${error.message}`);
            resolve(null);
        });
    });
    let stopped = false;
    return {
        get pid() { return child.pid ?? null; },
        exited,
        async stop() {
            if (stopped || child.exitCode !== null || child.signalCode !== null) return;
            stopped = true;
            signalGroup(child, 'SIGTERM');
            const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), stopTimeoutMs);
            await exited;
            clearTimeout(timer);
        },
    };
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
        // Negative pid targets the whole process group created by `detached`.
        process.kill(-child.pid, signal);
    } catch {
        try { child.kill(signal); } catch { /* already gone */ }
    }
}
