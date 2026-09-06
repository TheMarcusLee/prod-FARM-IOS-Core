/**
 * The starter library: the runbooks a fresh farm already has.
 *
 * Every farm starts by recording the same half-dozen flows — open the app and scroll, post the
 * newest clip, save it to drafts, follow back whoever followed you. Those are shipped as JSON
 * under `templates/`, and seeded into `SCHEDULER_DATA_DIR/runbooks` on first boot so there is
 * something on the Runbooks page before anybody has held a phone.
 *
 * A seeded copy is an ordinary runbook: it gets a fresh id, and editing it is editing it. The one
 * thing it keeps is `template`, which is how the list page badges it "Starter" and how seeding
 * knows it has already been done. **Nothing here ever overwrites a file that is already there** —
 * a template whose name is already present is left completely alone, edits and all.
 *
 * Every label in the templates that nobody has confirmed against real hardware carries
 * `guess: true` on its step, which the narration reads out as "(unverified)".
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { JsonValue } from '../types.js';
import { newRunbookId, validateRunbook, type Runbook } from './model.js';
import { listRunbooks, writeRunbook } from './store.js';

const TEMPLATE_ROOT = fileURLToPath(new URL('./templates/', import.meta.url));

/**
 * The shipped runbooks, validated exactly like an imported file — a template with a typo in it
 * should fail here, in a test, rather than on a phone.
 */
export async function loadStarterRunbooks(): Promise<Runbook[]> {
    const names = (await readdir(TEMPLATE_ROOT)).filter((name) => name.endsWith('.json')).sort();
    const runbooks: Runbook[] = [];
    for (const name of names) {
        const raw = JSON.parse(await readFile(path.join(TEMPLATE_ROOT, name), 'utf8')) as JsonValue;
        const runbook = validateRunbook(raw);
        if (!runbook.template) throw new Error(`${name} is a starter runbook without a template name`);
        runbooks.push(runbook);
    }
    return runbooks;
}

export interface InstallResult {
    /** Template names copied in by this call. */
    installed: string[];
    /** Template names already on disk, and therefore left alone. */
    kept: string[];
}

/**
 * Copies in every starter that is not already present. Idempotent: run it on every boot, and on
 * demand from the Runbooks page — the second run installs nothing.
 */
export async function installStarterRunbooks(directory?: string): Promise<InstallResult> {
    const existing = new Set(
        (await listRunbooks(directory)).map((runbook) => runbook.template).filter((name): name is string => Boolean(name)),
    );
    const result: InstallResult = { installed: [], kept: [] };
    for (const starter of await loadStarterRunbooks()) {
        const template = starter.template!;
        if (existing.has(template)) {
            result.kept.push(template);
            continue;
        }
        const now = new Date().toISOString();
        await writeRunbook({ ...starter, id: newRunbookId(), createdAt: now, updatedAt: now }, directory);
        result.installed.push(template);
    }
    return result;
}

/** The sentence the Runbooks page shows after Restore starter runbooks. */
export function describeInstall(result: InstallResult): string {
    if (!result.installed.length) {
        return `Every starter runbook is already here — ${result.kept.length} of them, and none were touched.`;
    }
    return `Added ${result.installed.length} starter ${result.installed.length === 1 ? 'runbook' : 'runbooks'}`
        + `${result.kept.length ? `; the ${result.kept.length} already here were left alone` : ''}.`;
}
