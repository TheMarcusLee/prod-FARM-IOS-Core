import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { contentRoot, dataRoot } from '../content/paths.js';

/**
 * `upload_asset`'s `path` argument reads a file as the `web` process user. Left
 * open that is "hand an agent a token, hand it every file the operator can
 * read" — including `devices.json`, which holds device passcodes, and
 * `.auth.json`, which holds every token digest.
 *
 * So the argument is an explicit whitelist: the content directory and an inbox
 * under the scheduler data root by default, overridable with MCP_UPLOAD_DIRS.
 * Base64 uploads are unaffected — they carry their own bytes and read nothing.
 */
export function uploadDirectories(environment: NodeJS.ProcessEnv = process.env): string[] {
    const configured = (environment.MCP_UPLOAD_DIRS ?? '')
        .split(/[,:]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    const directories = configured.length ? configured : [contentRoot(), path.join(dataRoot(), 'inbox')];
    return [...new Set(directories.map((directory) => path.resolve(directory)))];
}

function inside(candidate: string, directory: string): boolean {
    return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

/**
 * Returns the real path of `candidate` when it sits inside one of the allowed
 * directories, and throws otherwise. Both sides are resolved with `realpath`,
 * so a symlink planted inside an allowed directory cannot point out of it.
 */
export async function resolveUploadPath(candidate: string, directories: readonly string[]): Promise<string> {
    const real = await realpath(path.resolve(candidate)).catch(() => null);
    if (real === null) throw new Error(`No readable file at ${candidate}`);
    for (const directory of directories) {
        const realDirectory = await realpath(directory).catch(() => null);
        if (realDirectory && inside(real, realDirectory)) return real;
    }
    throw new Error(
        `${candidate} is outside the allowed upload directories (${directories.join(', ')}). `
        + 'Move the file into one of them, or set MCP_UPLOAD_DIRS.',
    );
}
