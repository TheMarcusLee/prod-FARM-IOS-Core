/**
 * Server-rendered dashboard surfaces for runbooks: the /runbooks list, the step editor, and the
 * device-page panel. HTMX only — every control posts a form and swaps a fragment back.
 * Panel and page HTML is trusted code; every runbook, device, and step value is escaped here.
 */

import type { RegisteredDevice } from '../devices/registry.js';
import {
    KEYS, STEP_TYPES, summarizeStep, variableNames,
    type Runbook, type Step, type StepType,
} from './model.js';
import type { RecordingSession } from './recorder.js';

/**
 * HTML escaping is the wrong escape inside a `<script>` block: `&#39;` is not a
 * quote to the JS parser, and `</script>` in a string still closes the element.
 * A JSON literal with the three markup characters escaped is safe in both.
 */
export function scriptLiteral(value: unknown): string {
    return JSON.stringify(String(value ?? ''))
        .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
        .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function escapeHtml(value: unknown): string {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function layout(title: string, body: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
        + `<title>${escapeHtml(title)} · Phone Farm</title><link rel="stylesheet" href="/assets/styles.css">`
        + `<script src="/assets/htmx.min.js" defer></script></head><body><main class="shell runbook-shell">`
        + `<nav class="app-nav"><a class="button secondary" href="/">Devices</a><a class="button secondary" href="/tasks">Tasks</a>`
        + `<a class="button secondary" href="/runbooks">Runbooks</a></nav>${body}</main></body></html>`;
}

function notice(message?: string): string {
    return message ? `<p class="run-error">${escapeHtml(message)}</p>` : '';
}

function deviceOptions(devices: readonly RegisteredDevice[]): string {
    return devices.map((device) => `<option value="${escapeHtml(device.udid)}">${escapeHtml(device.name)}</option>`).join('');
}

function platformOptions(selected: string): string {
    return ['any', 'ios', 'android']
        .map((value) => `<option value="${value}"${value === selected ? ' selected' : ''}>${value}</option>`).join('');
}

/** The whole list page. `#runbook-list` is also the swap target of every mutating form here. */
export function runbookListFragment(runbooks: readonly Runbook[], devices: readonly RegisteredDevice[], message?: string): string {
    const rows = runbooks.map((runbook) => `<tr><td><a href="/runbooks/${escapeHtml(runbook.id)}">${escapeHtml(runbook.name)}</a>`
        + `<br><span class="muted">${escapeHtml(runbook.description || runbook.id)}</span></td>`
        + `<td>${escapeHtml(runbook.platform)}</td><td>${runbook.steps.length}</td>`
        + `<td><span class="muted">${escapeHtml(runbook.updatedAt.slice(0, 16).replace('T', ' '))}</span></td>`
        + `<td><form hx-post="/plugins/com.farm.runbook/runbooks/${escapeHtml(runbook.id)}/run" hx-target="#runbook-list" hx-swap="outerHTML" class="inline-form">`
        + `<input type="hidden" name="view" value="list">`
        + `<select name="udid" aria-label="Device for ${escapeHtml(runbook.name)}">${deviceOptions(devices)}</select>`
        + `<button class="button" type="submit">Run</button></form></td>`
        + `<td><form hx-post="/plugins/com.farm.runbook/runbooks/${escapeHtml(runbook.id)}/duplicate" hx-target="#runbook-list" hx-swap="outerHTML" class="inline-form">`
        + `<button class="button secondary" type="submit">Duplicate</button></form>`
        + `<form hx-post="/plugins/com.farm.runbook/runbooks/${escapeHtml(runbook.id)}/delete" hx-target="#runbook-list" hx-swap="outerHTML" hx-confirm="Delete this runbook?" class="inline-form">`
        + `<button class="button secondary" type="submit">Delete</button></form></td></tr>`).join('');
    return `<section id="runbook-list" class="panel"><h2>Runbooks</h2>${notice(message)}`
        + `<table class="runbook-table"><tr><th>Name</th><th>Platform</th><th>Steps</th><th>Updated</th><th>Run on device</th><th></th></tr>`
        + `${rows || '<tr><td colspan="6">No runbooks yet. Create one, then record on a device page.</td></tr>'}</table></section>`;
}

export function runbooksPage(runbooks: readonly Runbook[], devices: readonly RegisteredDevice[]): string {
    const create = `<section class="panel"><h2>New runbook</h2>`
        + `<form hx-post="/plugins/com.farm.runbook/runbooks" hx-target="#runbook-list" hx-swap="outerHTML">`
        + `<label>Name <input name="name" required maxlength="80" placeholder="Warm up feed"></label> `
        + `<label>Description <input name="description" maxlength="1000"></label> `
        + `<label>Platform <select name="platform">${platformOptions('any')}</select></label> `
        + `<label>App id <input name="appId" placeholder="com.zhiliaoapp.musically"></label> `
        + `<label>Recorded for <select name="udid">${deviceOptions(devices)}</select></label> `
        + `<button class="button" type="submit">Create</button></form></section>`;
    return layout('Runbooks', `<h1>Runbooks</h1><p class="muted">Record a sequence once on one phone, replay it on the fleet.</p>`
        + `${create}${runbookListFragment(runbooks, devices)}`);
}

function stepValueField(step: Step | undefined, index: number): string {
    const name = `step.${index}.value`;
    const type = step?.type;
    if (type === 'launchApp') return input(name, step && 'appId' in step ? step.appId : '', 'app id');
    if (type === 'type') return input(name, step && 'text' in step ? step.text : '', 'text or {{var}}');
    if (type === 'screenshot') return input(name, step && 'label' in step ? step.label : '', 'label');
    if (type === 'key') {
        const current = step && 'key' in step ? step.key : '';
        return `<select name="${name}">${KEYS.map((key) => `<option value="${key}"${key === current ? ' selected' : ''}>${key}</option>`).join('')}</select>`;
    }
    return input(name, '', '');
}

function input(name: string, value: string | number | undefined, placeholder: string, size = 12): string {
    return `<input name="${name}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}" size="${size}">`;
}

function typeSelect(index: number, selected: StepType | ''): string {
    const options = ['', ...STEP_TYPES]
        .map((value) => `<option value="${value}"${value === selected ? ' selected' : ''}>${value || '—'}</option>`).join('');
    return `<select name="step.${index}.type" aria-label="Step ${index + 1} type">${options}</select>`;
}

function stepRow(step: Step | undefined, index: number): string {
    const selector = step && ('target' in step ? step.target : step);
    const id = selector && 'id' in selector ? selector.id : undefined;
    const text = step?.type === 'waitForText' || step?.type === 'assert' ? step.text
        : step?.type === 'tap' ? (step.target.text ?? step.target.description) : undefined;
    const from = step?.type === 'tap' ? step.target.fraction : step?.type === 'swipe' ? step.from : undefined;
    const to = step?.type === 'swipe' ? step.to : undefined;
    const ms = step?.type === 'wait' ? step.ms : step?.type === 'swipe' ? step.durationMs
        : step?.type === 'waitForText' ? step.timeoutMs : undefined;
    const expect = step?.type === 'assert' ? step.expect : '';
    return `<tr><td>${index + 1}</td><td>${typeSelect(index, step?.type ?? '')}</td><td>${stepValueField(step, index)}</td>`
        + `<td>${input(`step.${index}.id`, id, 'id')}</td><td>${input(`step.${index}.text`, text, 'text')}</td>`
        + `<td>${input(`step.${index}.x`, from?.x, 'x', 6)}${input(`step.${index}.y`, from?.y, 'y', 6)}</td>`
        + `<td>${input(`step.${index}.x2`, to?.x, 'x2', 6)}${input(`step.${index}.y2`, to?.y, 'y2', 6)}</td>`
        + `<td>${input(`step.${index}.ms`, ms, 'ms', 8)}</td>`
        + `<td><select name="step.${index}.expect"><option value=""></option>`
        + `<option value="present"${expect === 'present' ? ' selected' : ''}>present</option>`
        + `<option value="absent"${expect === 'absent' ? ' selected' : ''}>absent</option></select></td>`
        + `<td>${input(`step.${index}.retries`, step?.retries, '0', 4)}${input(`step.${index}.retryDelayMs`, step?.retryDelayMs, 'ms', 6)}</td>`
        + `<td><input type="checkbox" name="step.${index}.optional" value="on"${step?.optional ? ' checked' : ''} aria-label="Step ${index + 1} optional"></td>`
        + `<td><input type="checkbox" name="step.${index}.delete" value="on" aria-label="Delete step ${index + 1}"></td></tr>`;
}

/** The editor is one form: every row is `step.<index>.<field>`, and the last row is always blank. */
export function runbookEditorFragment(runbook: Runbook, devices: readonly RegisteredDevice[], message?: string): string {
    const rows = [...runbook.steps.map((step, index) => stepRow(step, index)), stepRow(undefined, runbook.steps.length)].join('');
    const variables = variableNames(runbook);
    const varInputs = variables.map((name) => `<label>${escapeHtml(name)} <input name="vars.${escapeHtml(name)}" required></label>`).join(' ');
    const meta = `<form hx-post="/plugins/com.farm.runbook/runbooks/${escapeHtml(runbook.id)}/meta" hx-target="#runbook-editor" hx-swap="outerHTML">`
        + `<label>Name <input name="name" value="${escapeHtml(runbook.name)}" required maxlength="80"></label> `
        + `<label>Description <input name="description" value="${escapeHtml(runbook.description)}" maxlength="1000"></label> `
        + `<label>Platform <select name="platform">${platformOptions(runbook.platform)}</select></label> `
        + `<label>App id <input name="appId" value="${escapeHtml(runbook.appId ?? '')}"></label> `
        + `<button class="button secondary" type="submit">Save details</button></form>`;
    const run = `<form hx-post="/plugins/com.farm.runbook/runbooks/${escapeHtml(runbook.id)}/run" hx-target="#runbook-editor" hx-swap="outerHTML">`
        + `<input type="hidden" name="view" value="editor">`
        + `<label>Run on <select name="udid">${deviceOptions(devices)}</select></label> ${varInputs} `
        + `<button class="button" type="submit">Run now</button></form>`;
    const steps = `<form hx-post="/plugins/com.farm.runbook/runbooks/${escapeHtml(runbook.id)}/steps-form" hx-target="#runbook-editor" hx-swap="outerHTML">`
        + `<table class="runbook-table runbook-steps"><tr><th>#</th><th>Type</th><th>Value</th><th>Target id</th><th>Target text</th>`
        + `<th>x / y</th><th>x2 / y2</th><th>ms</th><th>Expect</th><th>Retries / delay</th><th>Opt.</th><th>Del.</th></tr>`
        + `${rows}</table><button class="button" type="submit">Save steps</button></form>`;
    return `<section id="runbook-editor" class="panel"><h2>${escapeHtml(runbook.name)}</h2>${notice(message)}`
        + `<p class="muted">Recorded on <code>${escapeHtml(runbook.createdFor.udid)}</code> · `
        + `${runbook.createdFor.screen.width} × ${runbook.createdFor.screen.height} · ${runbook.steps.length} steps</p>`
        + `${meta}<h3>Steps</h3>${steps}<h3>Run</h3>${run}</section>`;
}

export function runbookPage(runbook: Runbook, devices: readonly RegisteredDevice[]): string {
    return layout(runbook.name, `<h1>${escapeHtml(runbook.name)}</h1>${runbookEditorFragment(runbook, devices)}`);
}

/** The device-page panel: pick a runbook, toggle recording, watch the steps arrive. */
export function devicePanelFragment(
    udid: string,
    runbooks: readonly Runbook[],
    session: RecordingSession | undefined,
    recording: Runbook | undefined,
    message?: string,
): string {
    const prefix = `/plugins/com.farm.runbook/devices/${encodeURIComponent(udid)}/record`;
    const poll = session ? ` hx-get="/plugins/com.farm.runbook/devices/${encodeURIComponent(udid)}/panel" hx-trigger="every 2s" hx-swap="outerHTML"` : '';
    const body = session && recording
        ? `<p><strong>Recording</strong> into <a href="/runbooks/${escapeHtml(recording.id)}">${escapeHtml(recording.name)}</a>`
            + ` — every tap, swipe and typed line on this page becomes a step.</p>`
            + `<ol class="runbook-steps-live">${recording.steps.map((step) => `<li>${escapeHtml(summarizeStep(step))}</li>`).join('') || '<li class="muted">No steps yet.</li>'}</ol>`
            + `<form hx-post="${prefix}/stop" hx-target="#runbook-panel" hx-swap="outerHTML"><button class="button" type="submit">Stop recording</button></form>`
        : `<form hx-post="${prefix}/start" hx-target="#runbook-panel" hx-swap="outerHTML">`
            + `<label>Record into <select name="runbookId">${runbooks.map((runbook) => `<option value="${escapeHtml(runbook.id)}">${escapeHtml(runbook.name)}</option>`).join('')}</select></label> `
            + `<button class="button secondary" type="submit"${runbooks.length ? '' : ' disabled'}>Start recording</button></form>`
            + (runbooks.length ? '' : '<p class="muted">Create a runbook on the <a href="/runbooks">Runbooks</a> page first.</p>');
    // The recorder hook in the device page reads this flag; the panel is what keeps it current.
    const flag = `<script>document.documentElement.dataset.runbookRecording = ${scriptLiteral(session?.runbookId ?? '')};</script>`;
    return `<section id="runbook-panel" class="panel"${poll}><h2>Runbooks</h2>${notice(message)}${body}${flag}</section>`;
}

/** Every runbook surface hangs off the plugin's own route prefix. */
export const ROUTE_PREFIX = '/plugins/com.farm.runbook';
