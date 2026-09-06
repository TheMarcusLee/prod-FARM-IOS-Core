/**
 * The runbook, as a story.
 *
 * Everything an operator sees of a runbook is here: the sentences it is made of, the recording bar,
 * the questions about typed lines, the live run beside the phone's screen, and the repair panel a
 * failed run opens at. The step table in html.ts is still there for whoever wants it, folded away.
 *
 * Panel markup is trusted code; every runbook, device and step value is escaped on the way in.
 */

import type { RegisteredDevice } from '../devices/registry.js';
import { icon } from '../ui/icons.js';
import { escapeHtml, ROUTE_PREFIX } from './html.js';
import {
    variableNames, type Runbook, type Step,
} from './model.js';
import { blanksIn, confidenceWords, describeStep, platformFact, stepConfidence } from './narrate.js';

/** How a live run is watched from the page. One per runbook, in process, like the recorder. */
export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface LiveRun {
    runbookId: string;
    udid: string;
    deviceName: string;
    startedAt: string;
    states: StepState[];
    /** Set once the run is over. */
    outcome?: 'succeeded' | 'failed' | 'stopped';
    error?: string;
    /** What the phone showed when a step failed — the list the repair panel offers. */
    visibleTexts?: string[];
    failedIndex?: number;
}

function deviceName(devices: readonly RegisteredDevice[], udid: string): string {
    return devices.find((device) => device.udid === udid)?.name ?? udid;
}

/* ---- one sentence ------------------------------------------------------ */

/** The list of visible texts a repair offers, as one-click buttons. */
function labelChoices(runbookId: string, index: number, texts: readonly string[], label: string): string {
    if (!texts.length) {
        return '<p class="bl-faint">Nothing on that screen carried a name, so there is nothing to pick.</p>';
    }
    const buttons = texts.slice(0, 24).map((text) => `<button class="bl-btn bl-btn-sm" type="submit" name="text"`
        + ` value="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join('');
    return `<form class="bl-rb-picks" hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbookId)}/steps/${index}/target"`
        + ` hx-target="#runbook-story" hx-swap="outerHTML">`
        + `<span class="bl-faint">${escapeHtml(label)}</span>${buttons}</form>`;
}

/**
 * The one question a recording cannot answer for itself: whether a typed line is the same every
 * run. Asked inline, once, and never in the language of variables.
 */
function blankQuestion(runbookId: string, index: number, step: Extract<Step, { type: 'type' }>): string {
    if (step.fixed || blanksIn(step.text).length) return '';
    return `<form class="bl-rb-ask" hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbookId)}/steps/${index}/blank"`
        + ` hx-target="#runbook-story" hx-swap="outerHTML">`
        + '<span>Is this always the same, or does it change each run?</span>'
        + '<button class="bl-btn bl-btn-sm" type="submit" name="answer" value="same">Always the same</button>'
        + '<label class="bl-rb-blank-name"><span class="bl-faint">Changes — call it</span>'
        + `<input class="bl-input" name="name" value="${escapeHtml(suggestBlankName(step.text))}" maxlength="64"`
        + ' pattern="[A-Za-z][A-Za-z0-9_]*" aria-label="Name for this blank"></label>'
        + '<button class="bl-btn bl-btn-sm" type="submit" name="answer" value="changes">It changes each run</button>'
        + '</form>';
}

/** A first guess at what the blank is called, from the line itself. */
export function suggestBlankName(text: string): string {
    const trimmed = text.trim();
    if (/^[\w.+-]+@[\w.-]+$/.test(trimmed)) return 'email';
    if (/^https?:\/\//i.test(trimmed)) return 'link';
    if (/^[#@]/.test(trimmed)) return 'tag';
    if (trimmed.split(/\s+/).length > 3) return 'caption';
    return 'text';
}

function sentenceRow(
    runbook: Runbook, step: Step, index: number,
    options: { state?: StepState; failure?: Runbook['lastFailure'] },
): string {
    const confidence = stepConfidence(step);
    const failed = options.failure?.stepIndex === index;
    const state = options.state ?? 'pending';
    const classes = ['bl-rb-line', `is-${state}`, ...(failed ? ['is-broken'] : [])].join(' ');
    const mark = failed ? 'bad' : confidence === 'sure' ? 'ok' : 'warn';
    const pick = confidence === 'position' && step.type === 'tap'
        ? `<details class="bl-rb-fix"><summary>Pick the label</summary>`
            + labelChoices(runbook.id, index, step.seen ?? [], 'What did you tap?')
            + '</details>'
        : '';
    const blank = step.type === 'type' ? blankQuestion(runbook.id, index, step) : '';
    return `<li class="${classes}"><span class="bl-dot ${mark}" title="${escapeHtml(confidenceWords(step))}"></span>
<div class="bl-rb-line-body"><span class="bl-rb-sentence">${escapeHtml(describeStep(step))}</span>
${pick}${blank}
<details class="bl-rb-details"><summary>Details</summary><pre>${escapeHtml(JSON.stringify(step, null, 2))}</pre></details></div>
<span class="bl-rb-line-state">${escapeHtml(stateWord(state))}</span></li>`;
}

function stateWord(state: StepState): string {
    return state === 'running' ? 'running' : state === 'done' ? 'done'
        : state === 'skipped' ? 'skipped' : state === 'failed' ? 'failed' : '';
}

/* ---- the story --------------------------------------------------------- */

export interface StoryOptions {
    devices: readonly RegisteredDevice[];
    /** The phone this runbook is recording on, when it is recording. */
    recordingOn?: string;
    /** The live run, when one is going. */
    run?: LiveRun;
    message?: string;
}

/** The sentences, and everything you can do to one of them. Polled while a recording is open. */
export function storyFragment(runbook: Runbook, options: StoryOptions): string {
    const poll = options.recordingOn || (options.run && !options.run.outcome)
        ? ` hx-get="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/story" hx-trigger="every 2s" hx-swap="outerHTML"` : '';
    const failure = runbook.lastFailure;
    const lines = runbook.steps.map((step, index) => sentenceRow(runbook, step, index, {
        ...(options.run?.states[index] ? { state: options.run.states[index]! } : {}),
        ...(failure ? { failure } : {}),
    })).join('');
    const empty = options.recordingOn
        ? '<li class="bl-rb-line"><span class="bl-dot"></span><div class="bl-rb-line-body">'
            + '<span class="bl-rb-sentence bl-faint">Drive the phone. What you do turns up here, a line at a time.</span></div></li>'
        : '<li class="bl-rb-line"><span class="bl-dot"></span><div class="bl-rb-line-body">'
            + '<span class="bl-rb-sentence bl-faint">Nothing recorded yet.</span></div></li>';
    const note = options.message ? `<div class="bl-callout">${escapeHtml(options.message)}</div>` : '';
    return `<section id="runbook-story" class="bl-panel"${poll}>
<div class="bl-panel-head">What this runbook does<span class="bl-muted" style="margin-left:auto;font-weight:400">${runbook.steps.length} of 200</span></div>
<div class="bl-panel-body">${note}<ol class="bl-rb-story">${lines || empty}</ol>${repairPanel(runbook)}</div></section>`;
}

/* ---- fix on failure ---------------------------------------------------- */

function repairPanel(runbook: Runbook): string {
    const failure = runbook.lastFailure;
    if (!failure) return '';
    const step = runbook.steps[failure.stepIndex];
    const shot = failure.screenshot
        ? `<img class="bl-rb-shot" src="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/failure.png?at=${encodeURIComponent(failure.at)}"`
            + ' alt="The phone\'s screen when the runbook stopped">'
        : '<p class="bl-faint">No picture was taken.</p>';
    const repair = step?.type === 'tap'
        ? labelChoices(runbook.id, failure.stepIndex, failure.visibleTexts, 'Pick the right button')
        : '<p class="bl-faint">This step does not tap anything, so there is no button to re-pick.</p>';
    return `<div class="bl-rb-repair"><div class="bl-rb-repair-copy">
<strong>It stopped at “${escapeHtml(step ? describeStep(step) : `step ${failure.stepIndex + 1}`)}”</strong>
<p class="bl-faint">${escapeHtml(failure.reason)}</p>${repair}
<form hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/try" hx-target="#runbook-run" hx-swap="outerHTML">
<input type="hidden" name="udid" value="${escapeHtml(failure.deviceUdid ?? runbook.createdFor.udid)}">
<button class="bl-btn bl-btn-primary bl-btn-sm" type="submit">Try again</button></form>
</div><div class="bl-rb-repair-shot">${shot}</div></div>`;
}

/* ---- the recording bar and the name prompt ----------------------------- */

/** The loudest state a runbook has: red, and one button out of it. */
export function recordingBar(runbook: Runbook, devices: readonly RegisteredDevice[], udid: string): string {
    return `<div class="bl-rb-banner"><span class="bl-rec-dot"></span>
<span>Recording on ${escapeHtml(deviceName(devices, udid))}. Everything you do on that phone is written down.</span>
<form hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/done" hx-target="#runbook-editor" hx-swap="outerHTML">
<button class="bl-btn bl-btn-danger bl-btn-sm" type="submit">Done</button></form></div>`;
}

export const PLACEHOLDER_PREFIX = 'Untitled recording';

export function needsName(runbook: Runbook): boolean {
    return runbook.name.startsWith(PLACEHOLDER_PREFIX);
}

/** Done asks two things, one of them optional, and nothing else. */
export function namePrompt(runbook: Runbook, devices: readonly RegisteredDevice[]): string {
    return `<section class="bl-panel bl-rb-name"><div class="bl-panel-head">Name it</div><div class="bl-panel-body">
<form class="bl-inline-form" hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/name" hx-target="#runbook-editor" hx-swap="outerHTML">
<label class="bl-field"><span>What is it called?</span>
<input class="bl-input" name="name" required maxlength="80" placeholder="Warm up the feed" autofocus></label>
<label class="bl-field"><span>What is it for? (optional)</span>
<input class="bl-input" name="description" maxlength="200" placeholder="Opens the app and scrolls a little"></label>
<button class="bl-btn bl-btn-primary" type="submit">Save</button></form>
<p class="bl-faint">${escapeHtml(platformFact(deviceName(devices, runbook.createdFor.udid), runbook.platform))}</p>
</div></section>`;
}

/* ---- try it now -------------------------------------------------------- */

/** The live screen beside the sentences. Same viewer markup the wall's inspector uses. */
function viewer(udid: string, platform: string, name: string): string {
    return `<div class="bl-viewer-screen" data-viewer data-udid="${escapeHtml(udid)}"`
        + ` data-platform="${escapeHtml(platform)}" data-live="1">`
        + `<img data-frame alt="Screen of ${escapeHtml(name)}" draggable="false">`
        + '<span class="bl-viewer-badge">live</span></div>';
}

function runStateLine(run: LiveRun | undefined): string {
    if (!run) return '';
    if (!run.outcome) return `<span class="bl-state busy"><span class="bl-dot busy"></span>Running on ${escapeHtml(run.deviceName)}</span>`;
    if (run.outcome === 'succeeded') return '<span class="bl-state ok"><span class="bl-dot ok"></span>It worked</span>';
    if (run.outcome === 'stopped') return '<span class="bl-state warn"><span class="bl-dot warn"></span>Stopped</span>';
    return `<span class="bl-state error"><span class="bl-dot error"></span>${escapeHtml(run.error ?? 'It stopped early')}</span>`;
}

/** The part of the try panel that changes while a run goes; the viewer above it is left alone. */
export function runProgressFragment(runbook: Runbook, run: LiveRun | undefined): string {
    const poll = run && !run.outcome
        ? ` hx-get="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/progress" hx-trigger="every 1s" hx-swap="outerHTML"` : '';
    const lines = runbook.steps.map((step, index) => {
        const state = run?.states[index] ?? 'pending';
        return `<li class="bl-rb-line is-${state}"><span class="bl-dot ${state === 'failed' ? 'bad' : state === 'done' ? 'ok' : ''}"></span>`
            + `<div class="bl-rb-line-body"><span class="bl-rb-sentence">${escapeHtml(describeStep(step))}</span></div>`
            + `<span class="bl-rb-line-state">${escapeHtml(stateWord(state))}</span></li>`;
    }).join('');
    const showed = run?.visibleTexts?.length
        ? `<p class="bl-faint">The screen showed: ${escapeHtml(run.visibleTexts.slice(0, 12).join(', '))}</p>` : '';
    return `<div id="runbook-progress"${poll}><div class="bl-rb-run-head">${runStateLine(run)}</div>
<ol class="bl-rb-story">${lines}</ol>${showed}</div>`;
}

/** The whole try panel: the phone on one side, the sentences lighting up on the other. */
export function runPanelFragment(
    runbook: Runbook, devices: readonly RegisteredDevice[], run: LiveRun | undefined, message?: string,
): string {
    const note = message ? `<div class="bl-callout bl-callout-bad">${escapeHtml(message)}</div>` : '';
    if (!run) {
        return `<section id="runbook-run" class="bl-panel" style="margin-top:16px"><div class="bl-panel-body">${note}
<p class="bl-faint">Press “Run it on this phone now” to watch it happen.</p></div></section>`;
    }
    const device = devices.find(({ udid }) => udid === run.udid);
    return `<section id="runbook-run" class="bl-panel" style="margin-top:16px">
<div class="bl-panel-head">Trying it on ${escapeHtml(run.deviceName)}</div>
<div class="bl-panel-body">${note}<div class="bl-rb-try">
<div class="bl-rb-try-screen">${viewer(run.udid, device?.platform ?? 'android', run.deviceName)}</div>
<div class="bl-rb-try-story">${runProgressFragment(runbook, run)}</div>
</div></div></section>`;
}

/* ---- the blanks a run has to fill -------------------------------------- */

/** One field per blank, last value prefilled. Nobody types braces. */
export function blankFields(runbook: Runbook): string {
    return variableNames(runbook).map((name) => `<label class="bl-field"><span>${escapeHtml(name)}</span>`
        + `<input class="bl-input" name="vars.${escapeHtml(name)}" required maxlength="500"`
        + ` value="${escapeHtml(runbook.lastValues?.[name] ?? '')}"></label>`).join('');
}
