/**
 * Runbooks live as one JSON file per runbook under `SCHEDULER_DATA_DIR/runbooks/<id>.json`.
 * No migration, no table: a runbook is a document an operator can read, diff, and copy between
 * farms. Writes go through a temp file + rename, like devices.json.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { JsonValue } from '../types.js';
import { validateRunbook, validateRunbookId, type Runbook } from './model.js';

export function runbookDirectory(directory?: string): string {
    return directory ?? path.join(path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data'), 'runbooks');
}

/** Validating the id before it reaches the filesystem is what keeps `../` out of the path. */
export function runbookPath(id: string, directory?: string): string {
    return path.join(runbookDirectory(directory), `${validateRunbookId(id)}.json`);
}

export function runbookExists(id: string, directory?: string): boolean {
    try {
        return existsSync(runbookPath(id, directory));
    } catch {
        return false;
    }
}

export async function readRunbook(id: string, directory?: string): Promise<Runbook | undefined> {
    let raw: string;
    try {
        raw = await readFile(runbookPath(id, directory), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    return validateRunbook(JSON.parse(raw) as JsonValue);
}

export async function listRunbooks(directory?: string): Promise<Runbook[]> {
    const root = runbookDirectory(directory);
    let names: string[];
    try {
        names = await readdir(root);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    const runbooks: Runbook[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
        try {
            runbooks.push(validateRunbook(JSON.parse(await readFile(path.join(root, name), 'utf8')) as JsonValue));
        } catch {
            // One corrupt file must not blank the whole list page.
        }
    }
    return runbooks.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeRunbook(runbook: Runbook, directory?: string): Promise<Runbook> {
    const target = runbookPath(runbook.id, directory);
    const stored: Runbook = { ...runbook, updatedAt: new Date().toISOString() };
    await mkdir(path.dirname(target), { recursive: true });
    const temporaryPath = `${target}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, target);
    return stored;
}

export async function deleteRunbook(id: string, directory?: string): Promise<boolean> {
    try {
        await unlink(runbookPath(id, directory));
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

/**
 * The picture a failed run took, beside the runbook it belongs to. One per runbook: the useful
 * screenshot is the latest one, and a farm that runs a runbook nightly must not fill a disk.
 */
export function failureScreenshotName(id: string): string {
    return `${validateRunbookId(id)}-failure.png`;
}

export async function writeFailureScreenshot(id: string, png: Buffer, directory?: string): Promise<string> {
    const name = failureScreenshotName(id);
    const target = path.join(runbookDirectory(directory), name);
    await mkdir(path.dirname(target), { recursive: true });
    const temporaryPath = `${target}.${process.pid}.tmp`;
    await writeFile(temporaryPath, png, { mode: 0o600 });
    await rename(temporaryPath, target);
    return name;
}

export async function readFailureScreenshot(id: string, directory?: string): Promise<Buffer | undefined> {
    try {
        return await readFile(path.join(runbookDirectory(directory), failureScreenshotName(id)));
    } catch {
        return undefined;
    }
}

// Recording appends one step at a time from concurrent HTTP requests; two overlapping
// read-modify-writes would each read the same file and the second would drop a step.
let mutation: Promise<unknown> = Promise.resolve();

export function mutateRunbook(
    id: string,
    mutate: (runbook: Runbook) => void | Promise<void>,
    directory?: string,
): Promise<Runbook | undefined> {
    const run = mutation.then(async () => {
        const runbook = await readRunbook(id, directory);
        if (!runbook) return undefined;
        await mutate(runbook);
        return writeRunbook(runbook, directory);
    });
    mutation = run.catch(() => undefined);
    return run;
}
