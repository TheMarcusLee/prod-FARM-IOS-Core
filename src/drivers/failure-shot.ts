import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DeviceDriver } from './types.js';

/**
 * A picture of the screen that beat the routine.
 *
 * "Control not found" is the most common way an Android routine dies, and the error text alone —
 * a label, the alternates it tried, the first twenty on-screen strings — is rarely enough to see
 * what actually went wrong. One PNG is. The executor points `FAILURE_SHOT_DIR` at a directory per
 * execution; without it (a routine run by hand from the CLI) nothing is written and nothing fails.
 */

export const FAILURE_SHOT_DIR = 'FAILURE_SHOT_DIR';

function fileNameFor(label: string): string {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'screen';
    return `${Date.now()}-${slug}.png`;
}

/**
 * Returns the absolute path written, or undefined when there is nowhere to write or the phone
 * would not give up a screenshot. Never throws: this runs on the way out of a failure, and a
 * second error here would replace the useful one.
 */
export async function captureFailureScreenshot(
    driver: DeviceDriver, label: string, environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
    const directory = environment[FAILURE_SHOT_DIR]?.trim();
    if (!directory) return undefined;
    try {
        const image = await driver.screenshot();
        const target = path.resolve(directory, fileNameFor(label));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, image, { mode: 0o600 });
        return target;
    } catch {
        return undefined;
    }
}
