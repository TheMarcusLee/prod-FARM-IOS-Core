/**
 * The Control Center: the wall of live phone screens at `/`, its filter panel and its inspector.
 * Markup only — the browser side lives in `static/dashboard/ts/wall.ts`. See docs/design/backline.md.
 */
import { icon } from '../ui/icons.js';
import { escapeHtml, slotNumber, stateBadge } from '../ui/shell.js';
import type { DerivedDeviceState } from './summary.js';

export { escapeHtml };

export interface WallExecution {
    id: string;
    status: string;
    /** "com.git-agni.tiktok/post" — what the phone is doing. */
    task: string;
}

export interface WallLogLine {
    /** HH:MM:SS. */
    time: string;
    text: string;
}

export interface WallDevice {
    udid: string;
    name: string;
    /** Registration order, zero-based; the operator sees `slotNumber(slot)`. */
    slot: number;
    platform: 'ios' | 'android';
    driver: string;
    state: DerivedDeviceState;
    connected: boolean;
    disabled: boolean;
    /** An Android phone reachable over Wi-Fi through its accessibility bridge. */
    wifi: boolean;
    tags: readonly string[];
    accounts: readonly string[];
    current?: WallExecution;
    /** Next planned run across this phone's active schedules. */
    nextRunAt?: Date;
    /** What that next run is, in words. */
    nextLabel?: string;
    /** The newest event for this phone, used by the needs-you callout. */
    lastMessage?: string;
    /** When the farm last had a frame from this phone. */
    lastFrameAt?: Date;
    postedToday?: number;
    failedToday?: number;
}

export interface WallData {
    devices: readonly WallDevice[];
    tags: readonly string[];
    /** The phone the inspector opens on; undefined when the fleet is empty. */
    selected?: WallDevice;
    /** The selected phone's running log, newest last. */
    log?: readonly WallLogLine[];
    /** "live video: scrcpy 3.1" or "stills only: install scrcpy (brew install scrcpy)". */
    liveVideo?: string;
}

const STATE_WORD: Record<DerivedDeviceState, string> = {
    online: 'online', busy: 'busy', offline: 'offline', disabled: 'disabled', error: 'error',
};

function clock(value: Date): string {
    return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

export function timeOfDay(value: Date): string {
    return `${clock(value)}:${String(value.getSeconds()).padStart(2, '0')}`;
}

/** A phone is live on the wall when it is connected and the operator has not disabled it. */
function showsFrames(device: WallDevice): boolean {
    return device.connected && !device.disabled;
}

function tileScreen(device: WallDevice): string {
    if (!showsFrames(device)) {
        const label = device.disabled ? 'disabled'
            : device.lastFrameAt ? `last frame ${clock(device.lastFrameAt)}` : 'offline';
        return `<span class="bl-tile-screen">${escapeHtml(label)}</span>`;
    }
    const canvas = device.platform === 'android' ? '<canvas data-canvas hidden></canvas>' : '';
    return `<span class="bl-tile-screen" data-screen><img data-frame alt="" draggable="false">${canvas}</span>`;
}

function tile(device: WallDevice): string {
    const number = slotNumber(device.slot);
    const classes = ['bl-tile'];
    if (device.state === 'error') classes.push('is-error');
    if (device.disabled) classes.push('is-disabled');
    return `<article class="${classes.join(' ')}" tabindex="0" data-tile`
        + ` data-udid="${escapeHtml(device.udid)}" data-slot="${number}"`
        + ` data-state="${escapeHtml(device.state)}" data-platform="${escapeHtml(device.platform)}"`
        + ` data-driver="${escapeHtml(device.driver)}" data-link="${device.wifi ? 'wifi' : 'usb'}"`
        + ` data-tags="${escapeHtml(device.tags.join(','))}"`
        + ` aria-label="${escapeHtml(`${number} ${device.name}, ${STATE_WORD[device.state]}`)}">`
        + tileScreen(device)
        + '<span class="bl-tile-foot">'
        + `<label class="bl-check"><input type="checkbox" data-select aria-label="${escapeHtml(`Select ${number} ${device.name}`)}"></label>`
        + `<span class="bl-tile-num">${number}</span>`
        + `<span class="bl-tile-name">${escapeHtml(device.name)}</span>`
        + stateBadge(device.state)
        + '</span></article>';
}

function numberPicker(devices: readonly WallDevice[]): string {
    return devices.map((device) => {
        const number = slotNumber(device.slot);
        const offline = device.disabled || !device.connected ? ' is-offline' : '';
        return `<button type="button" class="bl-num${offline}" data-pick="${escapeHtml(device.udid)}"`
            + ` aria-pressed="false" title="${escapeHtml(device.name)}">${number}</button>`;
    }).join('');
}

function groupChips(devices: readonly WallDevice[], tags: readonly string[]): string {
    const all = `<button type="button" class="bl-chip" data-group="" aria-pressed="true">All ${devices.length}</button>`;
    const chips = tags.map((tag) => {
        const count = devices.filter((device) => device.tags.includes(tag)).length;
        return `<button type="button" class="bl-chip" data-group="${escapeHtml(tag)}" aria-pressed="false">${escapeHtml(tag)} ${count}</button>`;
    }).join('');
    return `<div class="bl-chip-row">${all}${chips}</div>`;
}

/** The phone that most needs a person: an errored one first, then a phone that dropped off. */
export function needsYou(devices: readonly WallDevice[]): WallDevice | undefined {
    return devices.find((device) => device.state === 'error')
        ?? devices.find((device) => device.state === 'offline' && !device.disabled);
}

function callout(devices: readonly WallDevice[]): string {
    const device = needsYou(devices);
    if (!device) {
        return '<div class="bl-callout bl-cc-callout"><strong>Nothing needs you</strong>'
            + '<span>Every phone is connected and running its schedule.</span></div>';
    }
    const number = slotNumber(device.slot);
    const detail = device.lastMessage ?? (device.state === 'error'
        ? 'The last task failed on this phone.'
        : 'This phone is not reachable — check the cable or wireless debugging.');
    return `<div class="bl-callout bl-callout-bad bl-cc-callout"><strong>${number} needs you</strong>`
        + `<span>${escapeHtml(detail)}</span>`
        + `<a class="bl-btn bl-btn-sm" href="/devices/${encodeURIComponent(device.udid)}">Open ${number}</a></div>`;
}

function filters(data: WallData): string {
    const up = data.devices.filter((device) => device.connected && !device.disabled).length;
    return `<aside class="bl-cc-filters" id="wall-filters">
<div class="bl-seg" role="group" aria-label="Connection">
<button type="button" data-link-filter="all" aria-pressed="true">All</button>
<button type="button" data-link-filter="usb" aria-pressed="false">USB</button>
<button type="button" data-link-filter="wifi" aria-pressed="false">Wi-Fi</button>
<button type="button" data-link-filter="ios" aria-pressed="false">iPhone</button>
</div>
<div class="bl-cc-group">
<label class="bl-label" for="wall-size"><span>Screen size</span><b id="wall-size-value">M</b></label>
<input class="bl-slider" id="wall-size" type="range" min="0" max="2" step="1" value="1">
<label class="bl-label" for="wall-quality"><span>Quality</span><b id="wall-quality-value">Live</b></label>
<input class="bl-slider" id="wall-quality" type="range" min="0" max="2" step="1" value="2">
</div>
<div class="bl-cc-group">
<div class="bl-label"><span>Group</span><a href="/devices">Edit</a></div>
${groupChips(data.devices, data.tags)}
</div>
<div class="bl-cc-group">
<div class="bl-label"><span>Devices</span><b>${up} of ${data.devices.length} up</b></div>
<div class="bl-numgrid">${numberPicker(data.devices)}</div>
</div>
${callout(data.devices)}
</aside>`;
}

const TOOLBAR_ACTIONS: ReadonlyArray<{ action: string; label: string; glyph: Parameters<typeof icon>[0] }> = [
    { action: 'select-all', label: 'Select all', glyph: 'check' },
    { action: 'schedule-post', label: 'Schedule post', glyph: 'calendar' },
    { action: 'warm-up', label: 'Warm up', glyph: 'bolt' },
    { action: 'push-media', label: 'Push media', glyph: 'upload' },
    { action: 'run-runbook', label: 'Run runbook', glyph: 'list' },
    { action: 'install-apk', label: 'Install APK', glyph: 'box' },
    { action: 'reconnect', label: 'Reconnect', glyph: 'refresh' },
    { action: 'pause', label: 'Pause', glyph: 'pause' },
];

/** The buttons in the toolbar; they act on the wall's selection. */
export function wallToolbar(): string {
    return TOOLBAR_ACTIONS.map(({ action, label, glyph }) =>
        `<button type="button" class="bl-btn" data-wall-action="${action}">${icon(glyph)}${label}</button>`).join('');
}

export function wallToolbarRight(): string {
    return '<span id="wall-selection">0 selected</span>';
}

const HARDWARE: ReadonlyArray<{ key: string; label: string; glyph: Parameters<typeof icon>[0]; android?: true }> = [
    { key: 'home', label: 'Home', glyph: 'home' },
    { key: 'back', label: 'Back', glyph: 'back', android: true },
    { key: 'recents', label: 'Recent apps', glyph: 'recents', android: true },
    { key: 'volumeUp', label: 'Volume up', glyph: 'plus' },
    { key: 'volumeDown', label: 'Volume down', glyph: 'minus' },
    { key: 'power', label: 'Power', glyph: 'power' },
    { key: 'screenshot', label: 'Screenshot', glyph: 'camera' },
    { key: 'text', label: 'Type text', glyph: 'keyboard' },
];

/** The hardware button column beside a viewer. Android-only keys are dropped on iOS. */
export function hardwareColumn(platform: 'ios' | 'android'): string {
    return `<div class="bl-hw" role="group" aria-label="Hardware buttons">${HARDWARE
        .filter((button) => platform === 'android' || !button.android)
        .map((button) => `<button type="button" data-hw="${button.key}" title="${escapeHtml(button.label)}"`
            + ` aria-label="${escapeHtml(button.label)}">${icon(button.glyph)}</button>`)
        .join('')}</div>`;
}

/** The live screen of one phone, at the size the caller's column gives it. */
export function viewer(device: WallDevice, badge: string): string {
    const canvas = device.platform === 'android' ? '<canvas data-canvas hidden></canvas>' : '';
    const inner = showsFrames(device)
        ? `<img data-frame alt="Screen of ${escapeHtml(device.name)}" draggable="false">${canvas}`
            + `<span class="bl-viewer-badge">${escapeHtml(badge)}</span>`
        : `<span class="bl-viewer-empty">${escapeHtml(device.disabled ? 'This phone is disabled' : 'This phone is offline')}</span>`;
    return `<div class="bl-viewer-screen" data-viewer data-udid="${escapeHtml(device.udid)}"`
        + ` data-platform="${escapeHtml(device.platform)}" data-live="${showsFrames(device) ? '1' : '0'}">${inner}</div>`;
}

function logBlock(log: readonly WallLogLine[]): string {
    if (!log.length) {
        return '<div class="bl-log"><div><span>Nothing has run on this phone yet.</span></div></div>';
    }
    return `<div class="bl-log">${log.map((line, index) =>
        `<div${index === log.length - 1 ? ' class="is-current"' : ''}><time>${escapeHtml(line.time)}</time>`
        + `<span>${escapeHtml(line.text)}</span></div>`).join('')}</div>`;
}

/** The right-hand column for one phone. Also served on its own at /api/fragments/inspector/:udid. */
export function renderInspector(
    device: WallDevice | undefined, log: readonly WallLogLine[] = [], liveVideo?: string,
): string {
    if (!device) {
        return '<div class="bl-inspector" id="inspector"><div class="bl-empty">'
            + '<span>Select a phone to control it.</span>'
            + '<a class="bl-btn" href="/devices/register">Register a device</a></div></div>';
    }
    const number = slotNumber(device.slot);
    const account = device.accounts[0];
    const state = `${STATE_WORD[device.state]}${account ? ` · ${account}` : ''}`;
    const posted = device.postedToday ?? 0;
    const failed = device.failedToday ?? 0;
    const next = device.nextRunAt
        ? `${clock(device.nextRunAt)}${device.nextLabel ? ` · ${device.nextLabel}` : ''}`
        : 'Nothing planned';
    const stop = device.current
        ? `<button type="button" class="bl-btn bl-btn-primary" data-inspector-stop="${escapeHtml(device.current.id)}">Stop task</button>`
        : '<button type="button" class="bl-btn" disabled>Nothing running</button>';
    return `<div class="bl-inspector" id="inspector" data-udid="${escapeHtml(device.udid)}">
<div class="bl-inspector-head"><span class="bl-tile-num">${number}</span><span>${escapeHtml(device.name)}</span>
<span class="bl-state ${escapeHtml(device.state)}"><span class="bl-dot ${escapeHtml(device.state)}"></span>${escapeHtml(state)}</span>
<span class="bl-spacer"></span>
<a class="bl-btn bl-btn-icon" href="/devices/${encodeURIComponent(device.udid)}" title="Open device">${icon('expand')}</a></div>
<div class="bl-viewer">${viewer(device, 'live')}${hardwareColumn(device.platform)}</div>
<div class="bl-inspector-foot">
${device.platform === 'android' && liveVideo ? `<p class="bl-hint" data-live-status>${escapeHtml(liveVideo)}</p>` : ''}
<div class="bl-btn-row">${stop}<a class="bl-btn" href="/devices/${encodeURIComponent(device.udid)}">Open device</a>
<button type="button" class="bl-btn" data-record-runbook="${escapeHtml(device.udid)}">Record what I do next</button></div>
<div id="inspector-recording" hidden></div>
<div id="inspector-run" hx-get="/api/fragments/inspector/${encodeURIComponent(device.udid)}/run" hx-trigger="every 3s" hx-swap="outerHTML">
${logBlock(log)}
<div class="bl-rows"><div><span>Next post</span><span>${escapeHtml(next)}</span></div>
<div><span>Today</span><span>${posted} posted · ${failed} failed</span></div></div>
</div></div></div>`;
}

/** Just the parts of the inspector that change while a task runs. */
export function renderInspectorRun(device: WallDevice, log: readonly WallLogLine[]): string {
    const posted = device.postedToday ?? 0;
    const failed = device.failedToday ?? 0;
    const next = device.nextRunAt
        ? `${clock(device.nextRunAt)}${device.nextLabel ? ` · ${device.nextLabel}` : ''}`
        : 'Nothing planned';
    return `<div id="inspector-run" hx-get="/api/fragments/inspector/${encodeURIComponent(device.udid)}/run" hx-trigger="every 3s" hx-swap="outerHTML">
${logBlock(log)}
<div class="bl-rows"><div><span>Next post</span><span>${escapeHtml(next)}</span></div>
<div><span>Today</span><span>${posted} posted · ${failed} failed</span></div></div>
</div>`;
}

function wall(devices: readonly WallDevice[]): string {
    if (!devices.length) {
        return '<div class="bl-wall bl-wall-empty" id="wall"><div class="bl-empty">'
            + '<span>No phones are registered yet.</span>'
            + '<a class="bl-btn bl-btn-primary" href="/devices/register">Register a device</a></div></div>';
    }
    return `<div class="bl-wall" id="wall">${devices.map(tile).join('')}</div>`;
}

/** The `.bl-cc` body of the Control Center; the caller wraps it in `renderShell`. */
export function renderControlCenter(data: WallData): string {
    return `<div class="bl-cc">${filters(data)}${wall(data.devices)}`
        + `${renderInspector(data.selected, data.log, data.liveVideo)}</div>`;
}
