/**
 * A runbook is a recorded sequence of phone input that replays on any device.
 *
 * Everything here is data validation over UNTRUSTED json: the recorder writes runbooks, but so
 * does the dashboard's step editor and `PUT /api/runbooks/:id`. Every field is whitelisted and
 * bounded, and anything unexpected throws a message an operator can act on.
 */

import type { Key } from '../drivers/types.js';
import type { JsonValue } from '../types.js';

export interface Fraction {
    /** 0..1 across the recorded screen's width. */
    x: number;
    /** 0..1 down the recorded screen's height. */
    y: number;
}

/**
 * Where a tap goes. Resolution order at replay: `id`, then `text`/`description` through the
 * accessibility tree (OCR when a recognizer is injected), then `fraction` scaled to the target
 * device's screen.
 */
export interface TapTarget {
    id?: string;
    text?: string;
    description?: string;
    fraction: Fraction;
}

export interface StepOptions {
    /** Extra attempts after the first one. 0..10. */
    retries?: number;
    retryDelayMs?: number;
    /** A failing optional step is logged and skipped instead of failing the run. */
    optional?: boolean;
    /**
     * The visible texts on the phone when this step was recorded. Kept so the narration panel can
     * offer "pick the label" without going back to the device, which by then shows another screen.
     */
    seen?: string[];
    /** A `type` step the operator has confirmed is the same every run — asked once, never again. */
    fixed?: boolean;
    /**
     * This label was written from memory rather than read off a phone. The starter runbooks mark
     * every selector nobody has confirmed against real hardware, and the narration says
     * "(unverified)" so the first hardware session knows exactly what to check.
     */
    guess?: boolean;
    /**
     * How many times this step runs. A whole number, or one `{{name}}` blank — which is how
     * "swipe up as many times as you want" is asked for without anybody typing braces.
     */
    repeat?: number | string;
    /** The gap between repetitions. Without it a repeated swipe is a fling, not scrolling. */
    repeatDelayMs?: number;
}

export type Step = StepOptions & (
    | { type: 'launchApp'; appId: string }
    | { type: 'tap'; target: TapTarget }
    | { type: 'swipe'; from: Fraction; to: Fraction; durationMs: number }
    | { type: 'type'; text: string }
    | { type: 'key'; key: Key }
    | { type: 'wait'; ms: number }
    | { type: 'waitForText'; text?: string; id?: string; timeoutMs: number }
    | { type: 'assert'; text?: string; id?: string; expect: 'present' | 'absent' }
    | { type: 'screenshot'; label: string }
);

export type StepType = Step['type'];

export const STEP_TYPES: readonly StepType[] = [
    'launchApp', 'tap', 'swipe', 'type', 'key', 'wait', 'waitForText', 'assert', 'screenshot',
];

export const KEYS: readonly Key[] = ['home', 'back', 'recents', 'power', 'enter', 'delete'];

export type RunbookPlatform = 'ios' | 'android' | 'any';

export interface RunbookScreen {
    width: number;
    height: number;
    scale: number;
}

export interface Runbook {
    id: string;
    name: string;
    description: string;
    platform: RunbookPlatform;
    /** Bundle id / package name the runbook drives, when it launches one. */
    appId?: string;
    /** The device it was recorded on — its screen is what the fractions were measured against. */
    createdFor: { udid: string; screen: RunbookScreen };
    steps: Step[];
    /**
     * Set on the copies seeded from `src/runbook/templates`, and on nothing else. It is how the
     * list page knows to badge a runbook "Starter", and how a later release can tell an untouched
     * starter from an operator's own copy of it.
     */
    template?: string;
    version: 1;
    createdAt: string;
    updatedAt: string;
    /** When the plugin's task last replayed this runbook, and how it went. Absent until it has. */
    lastRunAt?: string;
    lastRunStatus?: RunbookRunStatus;
    /** What the operator last filled the blanks in with; the run form offers these again. */
    lastValues?: Record<string, string>;
    /** Where the last failure happened, so the runbook page can open at that sentence. */
    lastFailure?: RunbookFailure;
}

/** Everything the "fix it" flow needs, captured when a replay gives up on a step. */
export interface RunbookFailure {
    stepIndex: number;
    reason: string;
    /** What the phone showed at that moment — the list "Pick the right button" offers. */
    visibleTexts: string[];
    at: string;
    /** File name of the screenshot beside the runbook, when one could be taken. */
    screenshot?: string;
    executionId?: string;
    deviceUdid?: string;
}

/** `stopped` is the operator pressing Stop; `failed` is anything the replay could not do. */
export type RunbookRunStatus = 'succeeded' | 'failed' | 'stopped';

export function validateRunStatus(value: JsonValue | undefined): RunbookRunStatus | undefined {
    return value === 'succeeded' || value === 'failed' || value === 'stopped' ? value : undefined;
}

export const MAX_STEPS = 200;
export const MAX_REPEAT = 50;
export const MAX_SEEN_TEXTS = 40;
const MAX_SEEN_LENGTH = 200;
const APP_ID_PATTERN = /^[A-Za-z0-9._-]{3,255}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;
export const BLANK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SCREENSHOT_PATTERN = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const TEMPLATE_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

function object(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
    return value;
}

function text(value: JsonValue | undefined, label: string, max: number, min = 1): string {
    if (typeof value !== 'string') throw new Error(`${label} must be a string`);
    const trimmed = value.trim();
    if (trimmed.length < min) throw new Error(`${label} is required`);
    if (value.length > max) throw new Error(`${label} must be ${max} characters or fewer`);
    return min === 0 ? value : trimmed;
}

function optionalText(value: JsonValue | undefined, label: string, max: number): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return text(value, label, max);
}

function integer(value: JsonValue | undefined, label: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${label} must be a whole number between ${min} and ${max}`);
    }
    return value;
}

function fraction(value: JsonValue | undefined, label: string): Fraction {
    const input = object(value, label);
    const read = (name: 'x' | 'y'): number => {
        const candidate = input[name];
        if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
            throw new Error(`${label}.${name} must be a fraction between 0 and 1`);
        }
        return Math.round(candidate * 100_000) / 100_000;
    };
    return { x: read('x'), y: read('y') };
}

function stepOptions(input: Record<string, JsonValue>): StepOptions {
    const options: StepOptions = {};
    if (input.retries !== undefined && input.retries !== null) options.retries = integer(input.retries, 'retries', 0, 10);
    if (input.retryDelayMs !== undefined && input.retryDelayMs !== null) {
        options.retryDelayMs = integer(input.retryDelayMs, 'retryDelayMs', 0, 60_000);
    }
    if (input.optional !== undefined && input.optional !== null) {
        if (typeof input.optional !== 'boolean') throw new Error('optional must be true or false');
        if (input.optional) options.optional = true;
    }
    if (input.fixed !== undefined && input.fixed !== null) {
        if (typeof input.fixed !== 'boolean') throw new Error('fixed must be true or false');
        if (input.fixed) options.fixed = true;
    }
    if (input.guess !== undefined && input.guess !== null) {
        if (typeof input.guess !== 'boolean') throw new Error('guess must be true or false');
        if (input.guess) options.guess = true;
    }
    const repeat = validateRepeat(input.repeat);
    if (repeat !== undefined) options.repeat = repeat;
    if (input.repeatDelayMs !== undefined && input.repeatDelayMs !== null) {
        options.repeatDelayMs = integer(input.repeatDelayMs, 'repeatDelayMs', 0, 60_000);
    }
    const seen = validateSeen(input.seen);
    if (seen.length) options.seen = seen;
    return options;
}

/**
 * `repeat` is either a count or a single blank. A blank is the only string allowed: anything else
 * would be a number the run could not resolve, and a silent 1 is worse than a refusal.
 */
export function validateRepeat(value: JsonValue | undefined): number | string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string') {
        const match = /^\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}$/.exec(value.trim());
        if (!match) throw new Error('repeat must be a whole number or a single blank like {{times}}');
        return `{{${match[1]!}}}`;
    }
    return integer(value, 'repeat', 1, MAX_REPEAT);
}

/** The screen's visible texts, as recorded. Bounded on both axes: it is stored on every step. */
export function validateSeen(value: JsonValue | undefined): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error('seen must be an array of the texts on screen');
    const texts: string[] = [];
    for (const entry of value.slice(0, MAX_SEEN_TEXTS)) {
        if (typeof entry !== 'string') throw new Error('seen must hold only strings');
        const trimmed = entry.trim().slice(0, MAX_SEEN_LENGTH);
        if (trimmed && !texts.includes(trimmed)) texts.push(trimmed);
    }
    return texts;
}

/** A `waitForText` / `assert` needs one of the two selectors, never neither. */
function selector(input: Record<string, JsonValue>, label: string): { text?: string; id?: string } {
    const selectorText = optionalText(input.text, `${label} text`, 500);
    const selectorId = optionalText(input.id, `${label} id`, 255);
    if (!selectorText && !selectorId) throw new Error(`${label} needs a text or an id to look for`);
    return { ...(selectorId ? { id: selectorId } : {}), ...(selectorText ? { text: selectorText } : {}) };
}

export function validateTapTarget(value: JsonValue | undefined): TapTarget {
    const input = object(value, 'target');
    return {
        ...(optionalText(input.id, 'target id', 255) ? { id: optionalText(input.id, 'target id', 255) } : {}),
        ...(optionalText(input.text, 'target text', 500) ? { text: optionalText(input.text, 'target text', 500) } : {}),
        ...(optionalText(input.description, 'target description', 500)
            ? { description: optionalText(input.description, 'target description', 500) } : {}),
        fraction: fraction(input.fraction, 'target fraction'),
    };
}

export function validateStep(value: JsonValue | undefined, index: number): Step {
    const input = object(value, `Step ${index + 1}`);
    const options = stepOptions(input);
    const type = input.type;
    switch (type) {
        case 'launchApp': {
            const appId = text(input.appId, 'appId', 255);
            if (!APP_ID_PATTERN.test(appId)) throw new Error('appId must be a valid bundle id or package name');
            return { ...options, type, appId };
        }
        case 'tap':
            return { ...options, type, target: validateTapTarget(input.target) };
        case 'swipe':
            return {
                ...options, type,
                from: fraction(input.from, 'swipe from'), to: fraction(input.to, 'swipe to'),
                durationMs: integer(input.durationMs, 'swipe durationMs', 50, 10_000),
            };
        case 'type':
            return { ...options, type, text: text(input.text, 'type text', 2_000, 0) };
        case 'key': {
            if (typeof input.key !== 'string' || !KEYS.includes(input.key as Key)) {
                throw new Error(`key must be one of ${KEYS.join(', ')}`);
            }
            return { ...options, type, key: input.key as Key };
        }
        case 'wait':
            return { ...options, type, ms: integer(input.ms, 'wait ms', 0, 600_000) };
        case 'waitForText':
            return {
                ...options, type, ...selector(input, 'waitForText'),
                timeoutMs: integer(input.timeoutMs, 'waitForText timeoutMs', 100, 300_000),
            };
        case 'assert': {
            if (input.expect !== 'present' && input.expect !== 'absent') {
                throw new Error('assert expect must be "present" or "absent"');
            }
            return { ...options, type, ...selector(input, 'assert'), expect: input.expect };
        }
        case 'screenshot':
            return { ...options, type, label: text(input.label, 'screenshot label', 120) };
        default:
            throw new Error(`Step ${index + 1} has an unknown type "${String(type)}"`);
    }
}

export function validateSteps(value: JsonValue | undefined): Step[] {
    if (!Array.isArray(value)) throw new Error('steps must be an array');
    if (value.length > MAX_STEPS) throw new Error(`A runbook holds at most ${MAX_STEPS} steps`);
    return value.map((step, index) => validateStep(step, index));
}

function screen(value: JsonValue | undefined): RunbookScreen {
    const input = object(value, 'screen');
    return {
        width: integer(input.width, 'screen width', 1, 20_000),
        height: integer(input.height, 'screen height', 1, 20_000),
        scale: integer(input.scale, 'screen scale', 1, 4),
    };
}

export function validateTemplate(value: JsonValue | undefined): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const name = text(value, 'template', 64);
    if (!TEMPLATE_PATTERN.test(name)) throw new Error('template must be lowercase letters, digits or hyphens');
    return name;
}

export function validatePlatform(value: JsonValue | undefined): RunbookPlatform {
    if (value === 'ios' || value === 'android' || value === 'any') return value;
    throw new Error('platform must be "ios", "android", or "any"');
}

export function validateRunbookId(value: JsonValue | undefined): string {
    const id = text(value, 'id', 64);
    if (!ID_PATTERN.test(id)) throw new Error('id must be 8–64 lowercase letters, digits, or hyphens');
    return id;
}

/** The whole record, as stored on disk and as accepted by `PUT /api/runbooks/:id`. */
export function validateRunbook(value: JsonValue | undefined): Runbook {
    const input = object(value, 'Runbook');
    if (input.version !== 1) throw new Error('Only runbook version 1 is supported');
    const createdFor = object(input.createdFor, 'createdFor');
    const appId = optionalText(input.appId, 'appId', 255);
    if (appId && !APP_ID_PATTERN.test(appId)) throw new Error('appId must be a valid bundle id or package name');
    const now = new Date().toISOString();
    return {
        id: validateRunbookId(input.id),
        name: text(input.name, 'name', 80),
        description: input.description === undefined || input.description === null ? '' : text(input.description, 'description', 1_000, 0),
        platform: validatePlatform(input.platform),
        ...(appId ? { appId } : {}),
        createdFor: { udid: text(createdFor.udid, 'createdFor udid', 128), screen: screen(createdFor.screen) },
        steps: validateSteps(input.steps),
        ...(validateTemplate(input.template) ? { template: validateTemplate(input.template)! } : {}),
        version: 1,
        createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
        updatedAt: now,
        ...(typeof input.lastRunAt === 'string' ? { lastRunAt: input.lastRunAt } : {}),
        ...(validateRunStatus(input.lastRunStatus) ? { lastRunStatus: validateRunStatus(input.lastRunStatus) } : {}),
        ...(Object.keys(validateValues(input.lastValues)).length ? { lastValues: validateValues(input.lastValues) } : {}),
        ...(validateFailure(input.lastFailure) ? { lastFailure: validateFailure(input.lastFailure)! } : {}),
    };
}

export const MAX_VALUES = 32;

export function validateValues(value: JsonValue | undefined): Record<string, string> {
    if (value === undefined || value === null) return {};
    const input = object(value, 'values');
    const values: Record<string, string> = {};
    for (const [name, entry] of Object.entries(input).slice(0, MAX_VALUES)) {
        if (!BLANK_NAME_PATTERN.test(name)) throw new Error(`"${name}" is not a valid name for a blank`);
        if (typeof entry !== 'string') throw new Error(`values.${name} must be a string`);
        values[name] = entry.slice(0, 500);
    }
    return values;
}

export function validateFailure(value: JsonValue | undefined): RunbookFailure | undefined {
    if (value === undefined || value === null) return undefined;
    const input = object(value, 'lastFailure');
    return {
        stepIndex: integer(input.stepIndex, 'lastFailure stepIndex', 0, MAX_STEPS),
        reason: text(input.reason, 'lastFailure reason', 500, 0),
        visibleTexts: validateSeen(input.visibleTexts),
        at: typeof input.at === 'string' ? input.at : new Date().toISOString(),
        ...(optionalText(input.screenshot, 'lastFailure screenshot', 128) && SCREENSHOT_PATTERN.test(String(input.screenshot))
            ? { screenshot: String(input.screenshot) } : {}),
        ...(optionalText(input.executionId, 'lastFailure executionId', 128) ? { executionId: String(input.executionId) } : {}),
        ...(optionalText(input.deviceUdid, 'lastFailure deviceUdid', 128) ? { deviceUdid: String(input.deviceUdid) } : {}),
    };
}

export function newRunbookId(): string {
    return `rb-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** True when a runbook recorded for `runbook.platform` may run on a device of `platform`. */
export function platformCompatible(runbook: Pick<Runbook, 'platform'>, platform: 'ios' | 'android'): boolean {
    return runbook.platform === 'any' || runbook.platform === platform;
}

/** The blanks a runbook asks for. `{{name}}` is only the storage format; the UI says "blank". */
export function variableNames(runbook: Pick<Runbook, 'steps'>): string[] {
    const names = new Set<string>();
    for (const step of runbook.steps) {
        if (step.type === 'tap' && step.target.text) {
            for (const match of step.target.text.matchAll(VARIABLE_PATTERN)) names.add(match[1]!);
        }
        if (typeof step.repeat === 'string') {
            for (const match of step.repeat.matchAll(VARIABLE_PATTERN)) names.add(match[1]!);
        }
        // "Check that {{handle}} is on screen" is how a health check names the account it is for.
        if ((step.type === 'waitForText' || step.type === 'assert') && step.text) {
            for (const match of step.text.matchAll(VARIABLE_PATTERN)) names.add(match[1]!);
        }
        if (step.type !== 'type') continue;
        for (const match of step.text.matchAll(VARIABLE_PATTERN)) names.add(match[1]!);
    }
    return [...names].sort();
}

/** Substitutes `{{name}}` placeholders; an unsupplied variable is an error, never an empty string. */
export function applyVariables(value: string, vars: Record<string, string> = {}): string {
    return value.replaceAll(VARIABLE_PATTERN, (_match, name: string) => {
        const replacement = vars[name];
        if (replacement === undefined) throw new Error(`Missing value for variable {{${name}}}`);
        return replacement;
    });
}

/**
 * How many times a step runs, with the blank filled in. A blank that is not a whole number in
 * range is the operator's mistake and is named as one, rather than quietly running once.
 */
export function repeatCount(step: Step, vars: Record<string, string> = {}): number {
    if (step.repeat === undefined) return 1;
    if (typeof step.repeat === 'number') return step.repeat;
    const supplied = applyVariables(step.repeat, vars).trim();
    const count = Number(supplied);
    if (!Number.isInteger(count) || count < 1 || count > MAX_REPEAT) {
        throw new Error(`"${supplied}" is not a number of times between 1 and ${MAX_REPEAT}`);
    }
    return count;
}

export function summarizeStep(step: Step): string {
    switch (step.type) {
        case 'launchApp': return `launch ${step.appId}`;
        case 'tap': return `tap ${describeTarget(step.target)}`;
        case 'swipe': return `swipe (${step.from.x}, ${step.from.y}) → (${step.to.x}, ${step.to.y})`;
        case 'type': return `type "${step.text}"`;
        case 'key': return `press ${step.key}`;
        case 'wait': return `wait ${step.ms}ms`;
        case 'waitForText': return `wait for ${step.id ? `#${step.id}` : `"${step.text}"`}`;
        case 'assert': return `assert ${step.id ? `#${step.id}` : `"${step.text}"`} is ${step.expect}`;
        case 'screenshot': return `screenshot "${step.label}"`;
    }
}

export function describeTarget(target: TapTarget): string {
    if (target.id) return `#${target.id}`;
    if (target.text) return `"${target.text}"`;
    if (target.description) return `"${target.description}"`;
    return `(${target.fraction.x}, ${target.fraction.y})`;
}
