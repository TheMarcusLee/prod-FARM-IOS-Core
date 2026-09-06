/**
 * Server-rendered dashboard surfaces for runbooks: the /runbooks list, the step editor, and the
 * device-page panel. HTMX only — every control posts a form and swaps a fragment back. Panel and
 * page HTML is trusted code; every runbook, device, and step value is escaped here.
 * The pages render through the Backline shell; see docs/design/backline.md.
 */

import type { RegisteredDevice } from '../devices/registry.js';
import { icon } from '../ui/icons.js';
import type { ShellPage } from '../ui/context.js';
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

/** Every runbook surface hangs off the plugin's own route prefix. */
export const ROUTE_PREFIX = '/plugins/com.farm.runbook';

/**
 * Runbook pages are the shell's page slots; the chrome comes from `createShellContext`'s `shell`,
 * which the plugin route context carries. `assetVersion` is the cache-busting suffix, e.g. `?v=abc`.
 */
function layout(title: string, toolbar: string, body: string, assetVersion = ''): ShellPage {
    return {
        title, active: 'runbooks', toolbar,
        body: `<div class="bl-page">${body}</div>`,
        head: `<link rel="stylesheet" href="/assets/pages.css${assetVersion}">`
            + `<script type="module" src="/assets/runbooks.js${assetVersion}" defer></script>`,
    };
}

function notice(message?: string): string {
    if (!message) return '';
    return `<div class="bl-callout bl-callout-bad">${escapeHtml(message)}</div>`;
}

function deviceOptions(devices: readonly RegisteredDevice[], selected?: string): string {
    if (!devices.length) return '<option value="">No phones registered</option>';
    return devices.map((device) => `<option value="${escapeHtml(device.udid)}"${device.udid === selected ? ' selected' : ''}>`
        + `${escapeHtml(device.name)}</option>`).join('');
}

function platformOptions(selected: string): string {
    return ['any', 'ios', 'android']
        .map((value) => `<option value="${value}"${value === selected ? ' selected' : ''}>${value}</option>`).join('');
}

function stamp(iso: string): string {
    return iso.slice(0, 16).replace('T', ' ');
}

/**
 * One dialog per row rather than one shared dialog, so "Run on device" is a plain form post with no
 * state to keep in the client — the button that opens it names the dialog it opens, and that is all
 * the page script does.
 */
function runDialog(runbook: Runbook, devices: readonly RegisteredDevice[], view: 'list' | 'editor'): string {
    const id = `run-${runbook.id}`;
    const vars = variableNames(runbook).map((name) => `<label class="bl-field"><span>${escapeHtml(name)}</span>`
        + `<input class="bl-input" name="vars.${escapeHtml(name)}" required></label>`).join('');
    return `<dialog class="bl-dialog" id="${escapeHtml(id)}">
<div class="bl-dialog-head"><strong>Run ${escapeHtml(runbook.name)}</strong>
<button type="button" class="bl-btn bl-btn-icon" data-dialog-close aria-label="Close">${icon('x')}</button></div>
<form hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/run" hx-target="#runbook-${view}" hx-swap="outerHTML" data-dialog-submit>
<input type="hidden" name="view" value="${view}">
<div class="bl-dialog-body"><label class="bl-field"><span>Phone</span>
<select class="bl-select" name="udid">${deviceOptions(devices, runbook.createdFor.udid)}</select></label>${vars}
<p class="bl-faint">The run is queued on that phone straight away.</p></div>
<div class="bl-dialog-foot"><button type="button" class="bl-btn" data-dialog-close>Cancel</button>
<button class="bl-btn bl-btn-primary" type="submit">Run now</button></div></form></dialog>`;
}

/** The whole list body. `#runbook-list` is also the swap target of every mutating form here. */
export function runbookListFragment(runbooks: readonly Runbook[], devices: readonly RegisteredDevice[], message?: string): string {
    const rows = runbooks.map((runbook) => `<div class="bl-rb-row">
<div class="bl-rb-name"><a href="/runbooks/${escapeHtml(runbook.id)}">${escapeHtml(runbook.name)}</a>
<p>${escapeHtml(runbook.description || runbook.id)}</p></div>
<div class="bl-rb-col">${escapeHtml(runbook.platform)}</div>
<div class="bl-rb-col">${runbook.steps.length} ${runbook.steps.length === 1 ? 'step' : 'steps'}</div>
<div class="bl-rb-col">${escapeHtml(stamp(runbook.updatedAt))}</div>
<div class="bl-rb-actions">
<button type="button" class="bl-btn bl-btn-sm" data-dialog="run-${escapeHtml(runbook.id)}">Run on device</button>
<form hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/duplicate" hx-target="#runbook-list" hx-swap="outerHTML">
<button class="bl-btn bl-btn-sm" type="submit">Duplicate</button></form>
<form hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/delete" hx-target="#runbook-list" hx-swap="outerHTML" hx-confirm="Delete this runbook?">
<button class="bl-btn bl-btn-sm" type="submit">Delete</button></form>
</div>${runDialog(runbook, devices, 'list')}</div>`).join('');
    const empty = '<div class="bl-empty">No runbooks yet. Create one, then record on it from a phone\'s page.</div>';
    return `<section id="runbook-list" class="bl-panel">${notice(message)}
<div class="bl-rb-row bl-section-title"><div class="bl-rb-name">Runbook</div><div class="bl-rb-col">Platform</div>
<div class="bl-rb-col">Steps</div><div class="bl-rb-col">Updated</div><div class="bl-rb-actions" style="width:250px"></div></div>
${rows || empty}</section>`;
}

function createForm(devices: readonly RegisteredDevice[]): string {
    return `<form hx-post="${ROUTE_PREFIX}/runbooks" hx-target="#runbook-list" hx-swap="outerHTML" data-dialog-submit>
<div class="bl-dialog-body"><div class="bl-form-grid">
<label class="bl-field"><span>Name</span><input class="bl-input" name="name" required maxlength="80" placeholder="Warm up the feed"></label>
<label class="bl-field"><span>Description</span><input class="bl-input" name="description" maxlength="1000"></label>
<label class="bl-field"><span>Platform</span><select class="bl-select" name="platform">${platformOptions('any')}</select></label>
<label class="bl-field"><span>App id</span><input class="bl-input" name="appId" placeholder="com.zhiliaoapp.musically"></label>
<label class="bl-field"><span>Recorded for</span><select class="bl-select" name="udid">${deviceOptions(devices)}</select></label>
</div></div>
<div class="bl-dialog-foot"><button type="button" class="bl-btn" data-dialog-close>Cancel</button>
<button class="bl-btn bl-btn-primary" type="submit">Create</button></div></form>`;
}

export function runbooksPage(
    runbooks: readonly Runbook[], devices: readonly RegisteredDevice[], assetVersion = '',
): ShellPage {
    return layout('Runbooks',
        `<button type="button" class="bl-btn bl-btn-primary" data-dialog="new-runbook">${icon('plus')}New runbook</button>`,
        `<p class="bl-muted">Record a sequence once on one phone, replay it on the fleet.</p>`
        + `${runbookListFragment(runbooks, devices)}`
        + `<dialog class="bl-dialog" id="new-runbook"><div class="bl-dialog-head"><strong>New runbook</strong>`
        + `<button type="button" class="bl-btn bl-btn-icon" data-dialog-close aria-label="Close">${icon('x')}</button></div>`
        + createForm(devices) + '</dialog>',
        assetVersion);
}

// ---- the editor ------------------------------------------------------------

function input(name: string, value: string | number | undefined, placeholder: string): string {
    return `<input name="${name}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}"`
        + ` aria-label="${escapeHtml(placeholder || name)}">`;
}

function stepValueField(step: Step | undefined, index: number): string {
    const name = `step.${index}.value`;
    const type = step?.type;
    if (type === 'launchApp') return input(name, step && 'appId' in step ? step.appId : '', 'app id');
    if (type === 'type') return input(name, step && 'text' in step ? step.text : '', 'text or {{var}}');
    if (type === 'screenshot') return input(name, step && 'label' in step ? step.label : '', 'label');
    if (type === 'key') {
        const current = step && 'key' in step ? step.key : '';
        return `<select name="${name}" aria-label="Key">${KEYS.map((key) => `<option value="${key}"${key === current ? ' selected' : ''}>${key}</option>`).join('')}</select>`;
    }
    return input(name, '', '');
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
        + `<td><div class="bl-steps-pair">${input(`step.${index}.x`, from?.x, 'x')}${input(`step.${index}.y`, from?.y, 'y')}</div></td>`
        + `<td><div class="bl-steps-pair">${input(`step.${index}.x2`, to?.x, 'x2')}${input(`step.${index}.y2`, to?.y, 'y2')}</div></td>`
        + `<td>${input(`step.${index}.ms`, ms, 'ms')}</td>`
        + `<td><select name="step.${index}.expect" aria-label="Expect"><option value=""></option>`
        + `<option value="present"${expect === 'present' ? ' selected' : ''}>present</option>`
        + `<option value="absent"${expect === 'absent' ? ' selected' : ''}>absent</option></select></td>`
        + `<td><div class="bl-steps-pair">${input(`step.${index}.retries`, step?.retries, 'retries')}`
        + `${input(`step.${index}.retryDelayMs`, step?.retryDelayMs, 'delay')}</div></td>`
        + `<td><input type="checkbox" name="step.${index}.optional" value="on"${step?.optional ? ' checked' : ''} aria-label="Step ${index + 1} optional"></td>`
        + `<td><input type="checkbox" name="step.${index}.delete" value="on" aria-label="Delete step ${index + 1}"></td></tr>`;
}

/** Recording is the loudest state a runbook has, so it gets a banner rather than a checkbox. */
function recordControl(runbook: Runbook, devices: readonly RegisteredDevice[], recordingOn?: string): string {
    if (recordingOn) {
        const device = devices.find(({ udid }) => udid === recordingOn);
        return `<div class="bl-rb-banner"><span class="bl-rec-dot"></span>
<span>Recording on ${escapeHtml(device?.name ?? recordingOn)}. Every tap, swipe and typed line on that phone's page becomes a step.</span>
<form hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/record/stop-form" hx-target="#runbook-editor" hx-swap="outerHTML">
<button class="bl-btn bl-btn-danger bl-btn-sm" type="submit">Stop recording</button></form></div>`;
    }
    return `<section class="bl-panel bl-rb-record"><div class="bl-panel-head">Recording</div><div class="bl-panel-body">
<form class="bl-inline-form" hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/record/start-form" hx-target="#runbook-editor" hx-swap="outerHTML">
<label class="bl-field"><span>Record on</span><select class="bl-select" name="udid">${deviceOptions(devices, runbook.createdFor.udid)}</select></label>
<button class="bl-btn" type="submit"${devices.length ? '' : ' disabled'}>${icon('play')}Start recording</button>
<span class="bl-faint">Open that phone's page and drive it; each action is appended here.</span></form></div></section>`;
}

/** The editor is one form: every row is `step.<index>.<field>`, and the last row is always blank. */
export function runbookEditorFragment(
    runbook: Runbook, devices: readonly RegisteredDevice[], message?: string, recordingOn?: string,
): string {
    const rows = [...runbook.steps.map((step, index) => stepRow(step, index)), stepRow(undefined, runbook.steps.length)].join('');
    const meta = `<form class="bl-form-grid" hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/meta" hx-target="#runbook-editor" hx-swap="outerHTML">
<label class="bl-field"><span>Name</span><input class="bl-input" name="name" value="${escapeHtml(runbook.name)}" required maxlength="80"></label>
<label class="bl-field"><span>Description</span><input class="bl-input" name="description" value="${escapeHtml(runbook.description)}" maxlength="1000"></label>
<label class="bl-field"><span>Platform</span><select class="bl-select" name="platform">${platformOptions(runbook.platform)}</select></label>
<label class="bl-field"><span>App id</span><input class="bl-input" name="appId" value="${escapeHtml(runbook.appId ?? '')}"></label>
<label class="bl-field"><span>&nbsp;</span><button class="bl-btn" type="submit">Save details</button></label></form>`;
    // baseCount tells the save how many steps this form was rendered from, so steps a
    // recording appends while the editor is open are kept rather than clobbered.
    const steps = `<form hx-post="${ROUTE_PREFIX}/runbooks/${escapeHtml(runbook.id)}/steps-form" hx-target="#runbook-editor" hx-swap="outerHTML">
<input type="hidden" name="baseCount" value="${runbook.steps.length}">
<div style="overflow-x:auto"><table class="bl-steps"><thead><tr><th>#</th><th>Type</th><th>Value</th><th>Target id</th><th>Target text</th>
<th>x / y</th><th>x2 / y2</th><th>ms</th><th>Expect</th><th>Retries / delay</th><th>Opt.</th><th>Del.</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<div class="bl-form-actions"><button class="bl-btn bl-btn-primary" type="submit">Save steps</button></div></form>`;
    return `<section id="runbook-editor">${notice(message)}
${recordControl(runbook, devices, recordingOn)}
<section class="bl-panel" style="margin-top:16px"><div class="bl-panel-head">Details
<span class="bl-muted" style="margin-left:auto;font-weight:400">Recorded on ${escapeHtml(runbook.createdFor.udid)} ·
${runbook.createdFor.screen.width} × ${runbook.createdFor.screen.height}</span></div>
<div class="bl-panel-body">${meta}</div></section>
<section class="bl-panel" style="margin-top:16px"><div class="bl-panel-head">Steps
<span class="bl-muted" style="margin-left:auto;font-weight:400">${runbook.steps.length} of 200</span></div>
<div class="bl-panel-body">${steps}</div></section>
${runDialog(runbook, devices, 'editor')}</section>`;
}

export function runbookPage(
    runbook: Runbook, devices: readonly RegisteredDevice[], assetVersion = '', recordingOn?: string,
): ShellPage {
    return layout(runbook.name,
        `<a class="bl-btn" href="/runbooks">${icon('chevronLeft')}All runbooks</a>`
        + `<button type="button" class="bl-btn bl-btn-primary" data-dialog="run-${escapeHtml(runbook.id)}">${icon('play')}Run on device</button>`,
        runbookEditorFragment(runbook, devices, undefined, recordingOn), assetVersion);
}

/** The device-page panel: pick a runbook, toggle recording, watch the steps arrive. */
export function devicePanelFragment(
    udid: string,
    runbooks: readonly Runbook[],
    session: RecordingSession | undefined,
    recording: Runbook | undefined,
    message?: string,
): string {
    const prefix = `${ROUTE_PREFIX}/devices/${encodeURIComponent(udid)}/record`;
    const poll = session ? ` hx-get="${ROUTE_PREFIX}/devices/${encodeURIComponent(udid)}/panel" hx-trigger="every 2s" hx-swap="outerHTML"` : '';
    const body = session && recording
        ? `<div class="bl-rb-banner"><span class="bl-rec-dot"></span>
<span>Recording into <a href="/runbooks/${escapeHtml(recording.id)}">${escapeHtml(recording.name)}</a> — every tap, swipe and typed line on this page becomes a step.</span>
<form hx-post="${prefix}/stop" hx-target="#runbook-panel" hx-swap="outerHTML"><button class="bl-btn bl-btn-danger bl-btn-sm" type="submit">Stop recording</button></form></div>
<ul class="bl-rb-live">${recording.steps.map((step) => `<li>${escapeHtml(summarizeStep(step))}</li>`).join('') || '<li class="bl-muted">No steps yet.</li>'}</ul>`
        : `<form class="bl-inline-form" hx-post="${prefix}/start" hx-target="#runbook-panel" hx-swap="outerHTML">
<label class="bl-field"><span>Record into</span><select class="bl-select" name="runbookId">${runbooks.map((runbook) => `<option value="${escapeHtml(runbook.id)}">${escapeHtml(runbook.name)}</option>`).join('')}</select></label>
<button class="bl-btn" type="submit"${runbooks.length ? '' : ' disabled'}>${icon('play')}Start recording</button></form>`
            + (runbooks.length ? '' : '<p class="bl-muted">Create a runbook on the <a href="/runbooks">Runbooks</a> page first.</p>');
    // The recorder hook in the device page reads this flag; the panel is what keeps it current.
    const flag = `<script>document.documentElement.dataset.runbookRecording = ${scriptLiteral(session?.runbookId ?? '')};</script>`;
    return `<section id="runbook-panel"${poll}>${notice(message)}${body}${flag}</section>`;
}
