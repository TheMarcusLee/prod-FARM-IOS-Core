import { fileURLToPath } from 'node:url';

/**
 * The farm runs from one of two shapes:
 *
 *   - TypeScript sources loaded through `tsx` — every `npm run …` script, and
 *     the desktop app in development;
 *   - JavaScript compiled ahead of time — the packaged desktop app, which ships
 *     `apps/desktop/farm-dist` and no TypeScript toolchain at all
 *     (see `apps/desktop/scripts/build-farm.mjs`).
 *
 * A handful of places re-spawn a farm entry point as a child process with a
 * hard-coded `--import tsx <file>.ts`. This module is the single place that
 * knows which shape is running, so those spawns keep working in both.
 */
export const runningCompiled = fileURLToPath(import.meta.url).endsWith('.js');

/** The `.js` sibling of a `.ts` entry point when running compiled, else the path unchanged. */
export function farmEntryPath(script: string): string {
    return runningCompiled && script.endsWith('.ts') ? `${script.slice(0, -3)}.js` : script;
}

export interface FarmEntryArgsOptions {
    /** `--env-file-if-exists=` entries, mirroring the repository's npm scripts. */
    envFiles?: readonly string[];
}

/**
 * `node` arguments that run a farm entry point: the `tsx` loader is added only
 * when the entry point really is TypeScript.
 */
export function farmEntryArgs(script: string, options: FarmEntryArgsOptions = {}): string[] {
    const entry = farmEntryPath(script);
    return [
        ...(options.envFiles ?? []).map((file) => `--env-file-if-exists=${file}`),
        ...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []),
        entry,
    ];
}
