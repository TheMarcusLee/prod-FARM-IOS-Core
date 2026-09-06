/**
 * Plain sentences for recorded steps.
 *
 * A runbook is a recording of what somebody did on a phone, so that is how it should read back:
 * "Opened TikTok", "Tapped Create", "Swiped up". Nothing here mentions a step type, a timeout, a
 * retry count or a brace — those belong to the engine, not to the person who pressed record.
 *
 * Everything in this module is pure text. The HTML that shows it (and escapes it) is in story.ts.
 */

import type { Step, TapTarget } from './model.js';

/** Bundle ids and package names an operator should not have to read. */
const APP_NAMES: Record<string, string> = {
    'com.zhiliaoapp.musically': 'TikTok',
    'com.ss.android.ugc.trill': 'TikTok',
    'com.instagram.android': 'Instagram',
    'com.instagram.ios': 'Instagram',
    'com.burbn.instagram': 'Instagram',
    'com.google.android.youtube': 'YouTube',
    'com.google.ios.youtube': 'YouTube',
    'com.android.chrome': 'Chrome',
    'com.apple.mobilesafari': 'Safari',
    'com.android.settings': 'Settings',
    'com.apple.Preferences': 'Settings',
};

export function appName(appId: string): string {
    const known = APP_NAMES[appId];
    if (known) return known;
    // "com.example.photoeditor" reads better as "Photoeditor" than as its package name.
    const last = appId.split('.').filter(Boolean).at(-1) ?? appId;
    return last.charAt(0).toUpperCase() + last.slice(1);
}

const KEY_WORDS: Record<string, string> = {
    home: 'Went to the home screen',
    back: 'Pressed back',
    recents: 'Opened the recent apps',
    power: 'Pressed the power button',
    enter: 'Pressed enter',
    delete: 'Pressed delete',
};

/** How a tap target reads in a sentence: its label, or an honest description of a position. */
export function targetWords(target: TapTarget): string {
    const label = target.text ?? target.description ?? idLabel(target.id);
    // A label that is only a blank reads as the thing it stands for, never as braces.
    if (label && target.text) {
        const blanks = blanksIn(target.text);
        if (blanks.length === 1 && target.text.trim() === `{{${blanks[0]!}}}`) return `the ${blanks[0]!}`;
    }
    if (label) return label;
    return `the screen ${percent(target.fraction.x)} across, ${percent(target.fraction.y)} down`;
}

/** "com.app:id/follow_button" is a name, once the package and the underscores are gone. */
function idLabel(id: string | undefined): string | undefined {
    if (!id) return undefined;
    const last = id.split('/').at(-1) ?? id;
    const words = last.replaceAll(/[_.-]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : undefined;
}

function percent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function seconds(ms: number): string {
    if (ms < 1_000) return `${ms} milliseconds`;
    const value = Math.round(ms / 100) / 10;
    return `${value} ${value === 1 ? 'second' : 'seconds'}`;
}

function quote(value: string, max = 48): string {
    const trimmed = value.length > max ? `${value.slice(0, max - 1)}…` : value;
    return `“${trimmed}”`;
}

const BLANK = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;

/** The blanks in one typed line, in the order they appear. */
export function blanksIn(text: string): string[] {
    return [...new Set([...text.matchAll(BLANK)].map((match) => match[1]!))];
}

function swipeWords(step: Extract<Step, { type: 'swipe' }>): string {
    const dx = step.to.x - step.from.x;
    const dy = step.to.y - step.from.y;
    if (Math.abs(dy) >= Math.abs(dx)) {
        if (Math.abs(dy) < 0.03) return 'Held still on the screen';
        return dy < 0 ? 'Swiped up' : 'Swiped down';
    }
    return dx < 0 ? 'Swiped left' : 'Swiped right';
}

function selectorWords(step: { text?: string; id?: string }): string {
    if (step.text) {
        // A selector that is only a blank reads as the thing it stands for, never as braces.
        const blanks = blanksIn(step.text);
        if (blanks.length === 1 && step.text.trim() === `{{${blanks[0]!}}}`) return `the ${blanks[0]!}`;
        return quote(step.text);
    }
    return idLabel(step.id) ?? 'the control';
}

/**
 * How many times over, in words. A count reads as "three times"; a blank reads as the question the
 * run will ask, because nobody has answered it yet.
 */
function repeatWords(step: Step): string {
    if (step.repeat === undefined) return '';
    if (typeof step.repeat === 'string') {
        const name = blanksIn(step.repeat)[0];
        return name ? `, as many times as the ${name} says` : '';
    }
    return step.repeat > 1 ? `, ${step.repeat} times` : '';
}

/**
 * One recorded step, as the sentence the recorder's side panel shows. A step marked `guess` — the
 * starter runbooks mark every label nobody has held a phone up to — says so, in one word.
 */
export function describeStep(step: Step): string {
    return `${describeAction(step)}${repeatWords(step)}${step.guess ? ' (unverified)' : ''}`;
}

function describeAction(step: Step): string {
    switch (step.type) {
        case 'launchApp':
            return `Opened ${appName(step.appId)}`;
        case 'tap':
            return `Tapped ${targetWords(step.target)}`;
        case 'swipe':
            return swipeWords(step);
        case 'type': {
            const blanks = blanksIn(step.text);
            if (blanks.length === 1 && step.text.trim() === `{{${blanks[0]!}}}`) return `Typed the ${blanks[0]!}`;
            if (blanks.length) return `Typed a line with the ${blanks.join(' and the ')} filled in`;
            return step.text.trim() ? `Typed ${quote(step.text)}` : 'Cleared the text box';
        }
        case 'key':
            return KEY_WORDS[step.key] ?? `Pressed ${step.key}`;
        case 'wait':
            return `Waited ${seconds(step.ms)}`;
        case 'waitForText':
            return `Waited for ${selectorWords(step)} to appear`;
        case 'assert':
            return step.expect === 'present'
                ? `Checked that ${selectorWords(step)} is on screen`
                : `Checked that ${selectorWords(step)} is gone`;
        case 'screenshot':
            return `Took a picture of the screen (${step.label})`;
    }
}

/**
 * How sure the recorder is that this step will replay on another phone. `sure` means the control
 * was captured by its identifier or its label; `position` means only where the finger landed, which
 * is the one thing that does not survive a different screen.
 */
export type Confidence = 'sure' | 'position';

export function stepConfidence(step: Step): Confidence {
    if (step.type !== 'tap') return 'sure';
    const { target } = step;
    return target.id || target.text || target.description ? 'sure' : 'position';
}

export function confidenceWords(step: Step): string {
    if (stepConfidence(step) === 'sure') {
        return step.type === 'tap' ? 'Captured by name — this replays on any phone' : 'Nothing to look up';
    }
    return 'Only the position was captured — pick the label to make this replay anywhere';
}

/* ---- auto-waits ------------------------------------------------------- */

/** Texts on the second screen that were not on the first one. */
export function newTexts(before: readonly string[], after: readonly string[]): string[] {
    const had = new Set(before.map((text) => text.trim().toLowerCase()));
    const fresh: string[] = [];
    for (const text of after) {
        const trimmed = text.trim();
        const key = trimmed.toLowerCase();
        if (!trimmed || had.has(key)) continue;
        had.add(key);
        fresh.push(trimmed);
    }
    return fresh;
}

/** How much of the screen is new. Below this the app only redrew a counter, and no wait is worth it. */
const MATERIAL_CHANGE = 2;

/**
 * The most distinctive of the new texts: the one a person would recognise as "the next screen". A
 * short word ("1", "OK") is a poor thing to wait for, and so is a whole sentence; the middle is
 * what titles and buttons look like.
 */
export function mostDistinctive(texts: readonly string[]): string | undefined {
    const usable = texts.filter((text) => text.length >= 3 && text.length <= 40 && /[A-Za-z]/.test(text));
    if (!usable.length) return undefined;
    const score = (text: string): number => {
        const words = text.trim().split(/\s+/).length;
        return (words <= 4 ? 2 : 0) + (/^[A-Z]/.test(text) ? 1 : 0) - Math.abs(text.length - 12) / 20;
    };
    return [...usable].sort((a, b) => score(b) - score(a))[0];
}

const AUTO_WAIT_TIMEOUT_MS = 15_000;

/**
 * The wait to insert between two recorded actions, when the screen materially changed between
 * them. An operator waiting for an upload screen never thinks to add a wait; the recording did the
 * waiting for them, and this is that pause written down as something the replay can check.
 */
export function autoWaitStep(before: readonly string[], after: readonly string[]): Step | undefined {
    const fresh = newTexts(before, after);
    if (fresh.length < MATERIAL_CHANGE) return undefined;
    const wanted = mostDistinctive(fresh);
    if (!wanted) return undefined;
    return { type: 'waitForText', text: wanted, timeoutMs: AUTO_WAIT_TIMEOUT_MS, seen: fresh.slice(0, 20) };
}

/** The one line the runbook page shows about where a recording came from. */
export function platformFact(deviceName: string, platform: 'ios' | 'android' | 'any'): string {
    if (platform === 'android') return `Recorded on ${deviceName} · works on Android; iPhone untested`;
    if (platform === 'ios') return `Recorded on ${deviceName} · works on iPhone; Android untested`;
    return `Recorded on ${deviceName} · no phone type recorded yet`;
}
