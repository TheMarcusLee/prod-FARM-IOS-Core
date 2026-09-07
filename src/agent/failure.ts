import { SCREENSHOT_MARKER, SELECTOR_MARKER } from '../drivers/missing-control.js';
import { INSTAGRAM_PLUGIN_ID, THREADS_PLUGIN_ID, TIKTOK_PLUGIN_ID, YOUTUBE_PLUGIN_ID } from '../plugin-ids.js';
import type { FlowName } from './catalog.js';

/**
 * Turning "the routine could not find a control" into "send the agent at this selector".
 *
 * The routines already say which selector failed and where the screenshot went, at the end of the
 * error (see src/drivers/missing-control.ts). This reads it back so a failed execution carries
 * enough context for the dashboard's failure card to offer a calibration pass — without the
 * dashboard, the event store, or the alert renderer knowing anything about Android selectors.
 *
 * Deliberately pure and dependency-free: it runs inside the scheduler's lifecycle hook, which
 * must return immediately and must never throw.
 */

export interface CalibrationHint {
    plugin: string;
    flow: FlowName;
    udid: string;
    /** The selector table key that failed, when the routine named one. */
    selector?: string;
    /** Absolute path of the screenshot taken at the moment of failure, when one was taken. */
    screenshot?: string;
}

const CALIBRATABLE = new Set([TIKTOK_PLUGIN_ID, INSTAGRAM_PLUGIN_ID, THREADS_PLUGIN_ID, YOUTUBE_PLUGIN_ID]);

/** `post` is a post; everything that scrolls a feed — doomscroll, warmup — is a warm-up. */
export function flowForTaskType(taskType: string): FlowName | undefined {
    if (taskType === 'post') return 'post';
    if (taskType === 'doomscroll' || taskType === 'warmup') return 'warmup';
    return undefined;
}

export interface FailedExecutionLike {
    pluginId: string;
    taskType: string;
    deviceUdid: string;
    error?: string | null;
}

/**
 * Undefined when this failure is not a missing control on a calibratable Android routine — a
 * database error, an offline phone, an iOS run — in which case there is nothing for an agent to do.
 */
export function calibrationHint(execution: FailedExecutionLike): CalibrationHint | undefined {
    const error = execution.error ?? '';
    if (!/control not found|Timed out waiting for/i.test(error)) return undefined;
    if (!CALIBRATABLE.has(execution.pluginId)) return undefined;
    const flow = flowForTaskType(execution.taskType);
    if (!flow) return undefined;
    const selector = SELECTOR_MARKER.exec(error)?.[1];
    const screenshot = SCREENSHOT_MARKER.exec(error)?.[1];
    return {
        plugin: execution.pluginId, flow, udid: execution.deviceUdid,
        ...(selector ? { selector } : {}),
        ...(screenshot ? { screenshot: screenshot.trim() } : {}),
    };
}
