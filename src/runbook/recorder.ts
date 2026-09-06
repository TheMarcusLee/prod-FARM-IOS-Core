/**
 * Recording turns the dashboard's remote-control actions into runbook steps.
 *
 * The device page already taps the phone through `POST /api/devices/:udid/remote/action`; while a
 * recording is open it posts the same action to the runbook step endpoint. The step endpoint runs
 * *after* the tap has landed, so the tree it needs to identify the tapped control is the one
 * captured **before** it: the session caches a tree at `start` and re-captures after every step.
 */

import type { Point, ScreenGeometry, UiNode } from '../drivers/types.js';
import type { DeviceDriver } from '../drivers/types.js';
import { visibleTexts } from '../drivers/verify.js';
import type { JsonValue } from '../types.js';
import { MAX_SEEN_TEXTS, type Step, type TapTarget } from './model.js';
import { autoWaitStep } from './narrate.js';

/** The remote actions a recording can represent. Everything else is refused by name. */
export type RecordableAction =
    | { type: 'tap'; x: number; y: number }
    | { type: 'swipe'; startX: number; startY: number; endX: number; endY: number; durationMs: number }
    | { type: 'text'; text: string }
    | { type: 'home' }
    | { type: 'back' };

const UNRECORDABLE = ['lock', 'wake', 'unlock', 'volumeUp', 'volumeDown'];

function coordinate(value: JsonValue | undefined, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 20_000) {
        throw new Error(`${label} must be a screen coordinate`);
    }
    return value;
}

export function validateRemoteAction(value: JsonValue | undefined): RecordableAction {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('action must be an object');
    const type = value.type;
    if (typeof type !== 'string') throw new Error('action.type must be a string');
    switch (type) {
        case 'tap':
            return { type, x: coordinate(value.x, 'action.x'), y: coordinate(value.y, 'action.y') };
        case 'swipe':
            return {
                type,
                startX: coordinate(value.startX, 'action.startX'), startY: coordinate(value.startY, 'action.startY'),
                endX: coordinate(value.endX, 'action.endX'), endY: coordinate(value.endY, 'action.endY'),
                durationMs: coordinate(value.durationMs, 'action.durationMs'),
            };
        case 'text': {
            if (typeof value.text !== 'string' || value.text.length > 2_000) throw new Error('action.text must be a string');
            return { type, text: value.text };
        }
        case 'home':
        case 'back':
            return { type };
        default:
            throw new Error(UNRECORDABLE.includes(type)
                ? `"${type}" is a device-state action and cannot be recorded as a step`
                : `"${type}" is not a recordable action`);
    }
}

function contains(node: UiNode, point: Point): boolean {
    const { left, top, right, bottom } = node.bounds;
    return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

function area(node: UiNode): number {
    return Math.max(0, node.bounds.right - node.bounds.left) * Math.max(0, node.bounds.bottom - node.bounds.top);
}

function* walk(node: UiNode): Generator<UiNode> {
    yield node;
    for (const child of node.children) yield* walk(child);
}

export function fractionOf(point: Point, screen: ScreenGeometry): { x: number; y: number } {
    const clamp = (value: number): number => Math.min(1, Math.max(0, Math.round(value * 100_000) / 100_000));
    return { x: clamp(point.x / screen.width), y: clamp(point.y / screen.height) };
}

/**
 * The smallest node under the tapped point that carries an identity; when the tapped leaf is
 * anonymous (an icon inside a labelled row) the enclosing identified node wins, because that is
 * what a replay on a differently sized phone can find again.
 */
export function targetAtPoint(root: UiNode | undefined, point: Point, screen: ScreenGeometry): TapTarget {
    const fraction = fractionOf(point, screen);
    if (!root) return { fraction };
    const containing = [...walk(root)].filter((node) => contains(node, point)).sort((a, b) => area(a) - area(b));
    const identified = containing.find((node) => node.id || node.text || node.description);
    if (!identified) return { fraction };
    return {
        ...(identified.id ? { id: identified.id } : {}),
        ...(identified.text ? { text: identified.text } : {}),
        ...(identified.description && identified.description !== identified.text
            ? { description: identified.description } : {}),
        fraction,
    };
}

/** One remote action plus the screen it happened on, as a step. */
export function stepFromAction(action: RecordableAction, screen: ScreenGeometry, tree?: UiNode): Step {
    switch (action.type) {
        case 'tap':
            return { type: 'tap', target: targetAtPoint(tree, { x: action.x, y: action.y }, screen) };
        case 'swipe':
            return {
                type: 'swipe',
                from: fractionOf({ x: action.startX, y: action.startY }, screen),
                to: fractionOf({ x: action.endX, y: action.endY }, screen),
                durationMs: Math.round(action.durationMs),
            };
        case 'text':
            return { type: 'type', text: action.text };
        case 'home':
            return { type: 'key', key: 'home' };
        case 'back':
            return { type: 'key', key: 'back' };
    }
}

export interface RecordingSession {
    runbookId: string;
    udid: string;
    screen: ScreenGeometry;
    /** The tree as it was before the next action lands. */
    tree?: UiNode;
    /** The visible texts of that tree, kept on every step so "pick the label" can offer them. */
    texts: string[];
    /**
     * A wait the recorder owes the next step: the screen changed materially after the last action,
     * so the replay has to wait for the new screen rather than tap into the old one.
     */
    pendingWait?: Step;
    startedAt: string;
    steps: number;
}

/** In-process recording state. A restart ends any recording, which is the honest behaviour. */
export function createRecorder() {
    const sessions = new Map<string, RecordingSession>();
    /**
     * Re-reads the screen after an action. Anything materially new on it is what the operator sat
     * and waited for, so it becomes the wait in front of whatever they do next.
     */
    const capture = async (session: RecordingSession, driver: DeviceDriver, compare: boolean): Promise<void> => {
        let tree: UiNode | undefined;
        try {
            tree = await driver.uiTree();
        } catch {
            // A driver without a tree still records fractions; the panel says so.
            tree = undefined;
        }
        const texts = tree ? visibleTexts(tree).slice(0, MAX_SEEN_TEXTS) : [];
        if (compare && session.texts.length && texts.length) {
            session.pendingWait = autoWaitStep(session.texts, texts);
        }
        session.tree = tree;
        session.texts = texts;
    };
    return {
        async start(udid: string, runbookId: string, driver: DeviceDriver): Promise<RecordingSession> {
            for (const [key, session] of sessions) if (session.runbookId === runbookId) sessions.delete(key);
            const session: RecordingSession = {
                runbookId, udid, screen: await driver.screen(), texts: [],
                startedAt: new Date().toISOString(), steps: 0,
            };
            await capture(session, driver, false);
            sessions.set(udid, session);
            return session;
        },
        stop(udid: string): RecordingSession | undefined {
            const session = sessions.get(udid);
            sessions.delete(udid);
            return session;
        },
        forDevice(udid: string): RecordingSession | undefined {
            return sessions.get(udid);
        },
        forRunbook(runbookId: string): RecordingSession | undefined {
            return [...sessions.values()].find((session) => session.runbookId === runbookId);
        },
        /**
         * Enrich an action with the pre-action tree, then re-capture for the next one. One action
         * can produce two steps: the wait the previous action earned, and the action itself.
         */
        async record(session: RecordingSession, action: RecordableAction, driver: DeviceDriver): Promise<Step[]> {
            const step: Step = { ...stepFromAction(action, session.screen, session.tree) };
            if (session.texts.length) step.seen = [...new Set(session.texts)];
            const wait = session.pendingWait;
            session.pendingWait = undefined;
            const steps = wait ? [wait, step] : [step];
            session.steps += steps.length;
            await capture(session, driver, true);
            return steps;
        },
    };
}

export type Recorder = ReturnType<typeof createRecorder>;
