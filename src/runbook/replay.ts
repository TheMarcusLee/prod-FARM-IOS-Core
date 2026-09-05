/**
 * Replays a runbook on any device through the DeviceDriver interface.
 *
 * The recording device's screen is only a fallback: a tap resolves by accessibility id, then by
 * text / content-desc, then (with an injected recognizer) by OCR, and only then by the recorded
 * fraction scaled to this device's screen. That order is what lets one recording drive a fleet of
 * different phones.
 */

import { pause } from '../drivers/common.js';
import { center, findById, findByText, tappableBounds, visibleTexts, type Recognize } from '../drivers/verify.js';
import type { DeviceDriver, Point, UiNode } from '../drivers/types.js';
import { applyVariables, summarizeStep, type Runbook, type Step, type TapTarget } from './model.js';

export interface ReplayOptions {
    vars?: Record<string, string>;
    /** Enables the OCR fallback for text targets; omitted in tests and when no binding is available. */
    recognize?: Recognize;
    signal?: AbortSignal;
    log?: (line: string) => void | Promise<void>;
    onScreenshot?: (label: string, png: Buffer) => void | Promise<void>;
    /** Tree polling interval for waitForText. */
    intervalMs?: number;
}

export interface ReplayResult {
    stepsRun: number;
    stepsSkipped: number;
    stopped: boolean;
}

export type ResolvedVia = 'id' | 'text' | 'description' | 'ocr' | 'fraction';

/** Carries the step index and what was on screen — the two things an operator needs to fix a run. */
export class RunbookStepError extends Error {
    constructor(
        readonly stepIndex: number,
        readonly step: Step,
        readonly reason: string,
        readonly visibleTexts: string[],
    ) {
        const seen = visibleTexts.slice(0, 20).join(', ') || '(no accessibility nodes)';
        super(`Step ${stepIndex + 1} (${summarizeStep(step)}) failed: ${reason}. Screen showed: ${seen}`);
        this.name = 'RunbookStepError';
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Never let a driver without a usable tree (or a flaky read) abort resolution — fall through. */
async function readTree(driver: DeviceDriver): Promise<UiNode | undefined> {
    try {
        return await driver.uiTree();
    } catch {
        return undefined;
    }
}

async function screenTexts(driver: DeviceDriver): Promise<string[]> {
    const root = await readTree(driver);
    return root ? visibleTexts(root) : [];
}

export async function resolveTapPoint(
    driver: DeviceDriver,
    target: TapTarget,
    recognize?: Recognize,
): Promise<{ point: Point; via: ResolvedVia }> {
    const root = target.id || target.text || target.description ? await readTree(driver) : undefined;
    if (root) {
        if (target.id) {
            const node = findById(root, target.id);
            if (node) return { point: center(tappableBounds(root, node)), via: 'id' };
        }
        for (const [via, value] of [['text', target.text], ['description', target.description]] as const) {
            if (!value) continue;
            const node = findByText(root, { text: value });
            if (node) return { point: center(tappableBounds(root, node)), via };
        }
    }
    const wanted = target.text ?? target.description;
    if (recognize && wanted) {
        const words = await recognize(await driver.screenshot());
        const word = words.find((candidate) => candidate.text.trim().toLowerCase().includes(wanted.trim().toLowerCase()));
        if (word) {
            const { scale } = await driver.screen();
            const point = center(word.bounds);
            return { point: { x: point.x / scale, y: point.y / scale }, via: 'ocr' };
        }
    }
    const screen = await driver.screen();
    return {
        point: { x: Math.round(target.fraction.x * screen.width), y: Math.round(target.fraction.y * screen.height) },
        via: 'fraction',
    };
}

function matches(root: UiNode, selector: { text?: string; id?: string }): boolean {
    if (selector.id && findById(root, selector.id)) return true;
    return Boolean(selector.text && findByText(root, { text: selector.text }));
}

async function waitForSelector(
    driver: DeviceDriver,
    selector: { text?: string; id?: string },
    timeoutMs: number,
    options: ReplayOptions,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const root = await readTree(driver);
        if (root && matches(root, selector)) return;
        if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
        await pause(options.intervalMs ?? 500, options.signal);
    }
}

async function runStep(driver: DeviceDriver, step: Step, options: ReplayOptions, log: (line: string) => Promise<void>): Promise<void> {
    switch (step.type) {
        case 'launchApp':
            return driver.launchApp(step.appId);
        case 'tap': {
            const { point, via } = await resolveTapPoint(driver, step.target, options.recognize);
            await log(`  resolved by ${via} → (${Math.round(point.x)}, ${Math.round(point.y)})`);
            return driver.tap(point);
        }
        case 'swipe': {
            const screen = await driver.screen();
            return driver.swipe({
                from: { x: Math.round(step.from.x * screen.width), y: Math.round(step.from.y * screen.height) },
                to: { x: Math.round(step.to.x * screen.width), y: Math.round(step.to.y * screen.height) },
                durationMs: step.durationMs,
            });
        }
        case 'type':
            return driver.type(applyVariables(step.text, options.vars));
        case 'key':
            return driver.pressKey(step.key);
        case 'wait':
            return driver.pause(step.ms, options.signal);
        case 'waitForText':
            return waitForSelector(driver, step, step.timeoutMs, options);
        case 'assert': {
            const root = await readTree(driver);
            const present = Boolean(root && matches(root, step));
            if (present === (step.expect === 'present')) return;
            throw new Error(`expected ${step.id ? `#${step.id}` : `"${step.text}"`} to be ${step.expect}`);
        }
        case 'screenshot': {
            const png = await driver.screenshot();
            await options.onScreenshot?.(step.label, png);
            return log(`  captured "${step.label}" (${png.length} bytes)`);
        }
    }
}

export async function replayRunbook(
    driver: DeviceDriver,
    runbook: Runbook,
    options: ReplayOptions = {},
): Promise<ReplayResult> {
    const log = async (line: string): Promise<void> => { await options.log?.(line); };
    const result: ReplayResult = { stepsRun: 0, stepsSkipped: 0, stopped: false };
    await log(`Replaying "${runbook.name}" (${runbook.steps.length} steps) on ${driver.platform} ${driver.udid}`);
    for (const [index, step] of runbook.steps.entries()) {
        if (options.signal?.aborted) {
            result.stopped = true;
            await log(`Stopped before step ${index + 1}`);
            return result;
        }
        const attempts = 1 + (step.retries ?? 0);
        let failure: unknown;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                await log(`Step ${index + 1}/${runbook.steps.length}: ${summarizeStep(step)}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
                await runStep(driver, step, options, log);
                failure = undefined;
                break;
            } catch (error) {
                if (options.signal?.aborted) {
                    result.stopped = true;
                    await log(`Stopped during step ${index + 1}`);
                    return result;
                }
                failure = error;
                if (attempt < attempts) await pause(step.retryDelayMs ?? 1_000, options.signal);
            }
        }
        if (failure === undefined) {
            result.stepsRun += 1;
            continue;
        }
        if (step.optional) {
            result.stepsSkipped += 1;
            await log(`Step ${index + 1} is optional — skipping after ${message(failure)}`);
            continue;
        }
        throw new RunbookStepError(index, step, message(failure), await screenTexts(driver));
    }
    await log(`Finished: ${result.stepsRun} steps run, ${result.stepsSkipped} skipped`);
    return result;
}
