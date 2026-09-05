import type { ExecutionRow } from '../database/schema.js';
import type { RegisteredDevice } from '../devices/registry.js';
import type { FarmEvent } from './events.js';
import type { DeviceState, FleetSummary } from './summary.js';

export function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
}

export interface FleetCard {
    device: RegisteredDevice;
    state: DeviceState;
    platform: string;
    driver: string;
    tags: string[];
    accounts: string[];
    /** The running or queued execution, if any. */
    current?: ExecutionRow;
    /** Next planned run across this device's active schedules. */
    nextRunAt?: Date;
    lastEvent?: FarmEvent;
}

const STATE_LABEL: Record<DeviceState, string> = { online: 'Online', offline: 'Offline', disabled: 'Disabled' };

function activityLine(card: FleetCard): string {
    if (card.current) {
        const task = `${card.current.pluginId}/${card.current.taskType}`;
        return `<span class="fleet-activity ${escapeHtml(card.current.status)}">${escapeHtml(card.current.status)} · ${escapeHtml(task)}</span>`;
    }
    if (card.nextRunAt) return `<span class="fleet-activity next">next ${escapeHtml(card.nextRunAt.toISOString())}</span>`;
    return '<span class="fleet-activity idle">idle</span>';
}

function preview(card: FleetCard): string {
    const udid = encodeURIComponent(card.device.udid);
    // Only online, enabled devices get a thumbnail, and only once the card is
    // actually on screen — the browser must not poll 40 phones it cannot see.
    if (card.state !== 'online') return '<div class="fleet-shot empty" aria-hidden="true"></div>';
    return `<div class="fleet-shot"><img alt="Screen of ${escapeHtml(card.device.name)}" data-shot="/api/devices/${udid}/remote/screenshot" onerror="this.style.visibility='hidden'"></div>`;
}

function tagEditor(card: FleetCard): string {
    return `<form class="fleet-tags" data-tag-form data-udid="${escapeHtml(card.device.udid)}">`
        + `<input name="tags" value="${escapeHtml(card.tags.join(', '))}" placeholder="tags, comma separated" aria-label="Tags for ${escapeHtml(card.device.name)}">`
        + '<button class="button secondary" type="submit">Save tags</button></form>';
}

function renderCard(card: FleetCard): string {
    const udid = card.device.udid;
    const accounts = card.accounts.map((account) => `<option value="${escapeHtml(account)}">${escapeHtml(account)}</option>`).join('');
    return `<article class="fleet-card" data-device-card data-udid="${escapeHtml(udid)}" data-state="${escapeHtml(card.state)}" data-platform="${escapeHtml(card.platform)}" data-tags="${escapeHtml(card.tags.join(','))}">
<header><label class="fleet-pick"><input type="checkbox" data-select aria-label="Select ${escapeHtml(card.device.name)}"><span>${escapeHtml(card.device.name)}</span></label><span class="badge state-${escapeHtml(card.state)}">${escapeHtml(STATE_LABEL[card.state])}</span></header>
${preview(card)}
<p class="fleet-badges"><span class="badge platform-${escapeHtml(card.platform)}">${escapeHtml(card.platform === 'android' ? 'Android' : 'iOS')}</span><span class="badge driver">${escapeHtml(card.driver)}</span>${card.tags.map((tag) => `<span class="badge tag">${escapeHtml(tag)}</span>`).join('')}</p>
<p class="fleet-meta">${activityLine(card)}</p>
<p class="fleet-meta last-event">${card.lastEvent ? `${escapeHtml(card.lastEvent.kind)} · ${escapeHtml(card.lastEvent.title)}` : 'No events yet'}</p>
<label class="fleet-account">Account <select data-account ${card.accounts.length ? '' : 'disabled'}>${accounts || '<option value="">No accounts</option>'}</select></label>
${tagEditor(card)}
<a class="button secondary" href="/devices/${encodeURIComponent(udid)}">Open device</a>
</article>`;
}

function summaryTiles(summary: FleetSummary): string {
    const tiles: Array<[string, number]> = [
        ['Online', summary.devices.online], ['Offline', summary.devices.offline], ['Disabled', summary.devices.disabled],
        ['Running', summary.running], ['Queued', summary.queued], ['Stuck', summary.stuck],
        ['Failed 24 h', summary.failedLast24h], ['Planned 24 h', summary.plannedNext24h],
    ];
    return `<section class="fleet-summary">${tiles.map(([label, value]) =>
        `<div class="fleet-tile"><span class="fleet-tile-value">${value}</span><span class="fleet-tile-label">${escapeHtml(label)}</span></div>`).join('')}</section>`;
}

function filters(tags: readonly string[]): string {
    const options = tags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('');
    return `<section class="fleet-filters">
<label>Tag <select id="filter-tag"><option value="">All</option>${options}</select></label>
<label>Platform <select id="filter-platform"><option value="">All</option><option value="ios">iOS</option><option value="android">Android</option></select></label>
<label>State <select id="filter-state"><option value="">All</option><option value="online">Online</option><option value="offline">Offline</option><option value="disabled">Disabled</option></select></label>
<label class="fleet-pick"><input type="checkbox" id="select-all"><span>Select all visible</span></label>
<span id="fleet-selection-count" class="fleet-meta">0 selected</span>
</section>`;
}

const BULK_PANEL = `<section class="fleet-bulk">
<details open><summary>Run doomscroll now</summary>
<form id="bulk-doomscroll" class="fleet-form">
<label>Minutes <input name="durationMinutes" type="number" min="1" max="180" value="10" required></label>
<label>Personality <select name="personality"><option value="casual">casual</option><option value="skimmer">skimmer</option><option value="engaged">engaged</option></select></label>
<label class="fleet-pick"><input name="likeEnabled" type="checkbox" checked><span>Like</span></label>
<label class="fleet-pick"><input name="saveEnabled" type="checkbox"><span>Save</span></label>
<label>Stagger <select name="staggerKind"><option value="fixed">fixed minutes</option><option value="random">random window</option></select></label>
<label>Value <input name="staggerValue" type="number" min="0" max="1440" value="0"></label>
<button class="button primary" type="submit">Run on selected</button>
</form></details>
<details><summary>Schedule a TikTok post</summary>
<form id="bulk-post" class="fleet-form">
<label>Media <input name="media" type="file" accept="video/*,image/*" multiple required></label>
<label>Start <input name="runAt" type="datetime-local" required></label>
<label>Destination <select name="destination"><option value="draft">draft</option><option value="publish">publish</option></select></label>
<label>Caption <input name="caption" maxlength="2200"></label>
<label>Stagger <select name="staggerKind"><option value="fixed">fixed minutes</option><option value="random">random window</option></select></label>
<label>Value <input name="staggerValue" type="number" min="0" max="1440" value="5"></label>
<button class="button primary" type="submit">Schedule on selected</button>
</form></details>
<div class="fleet-actions">
<button class="button secondary" data-bulk="pause">Pause schedules</button>
<button class="button secondary" data-bulk="resume">Resume schedules</button>
<button class="button secondary" data-bulk="disable">Disable</button>
<button class="button secondary" data-bulk="enable">Enable</button>
<button class="button secondary" data-bulk="reconnect">Reconnect</button>
</div>
<pre id="fleet-result" class="fleet-result" aria-live="polite"></pre>
</section>`;

const STYLES = `:root{color-scheme:dark}
body{margin:0;background:#080b10;color:#f5f7fa;font:15px Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}h1{margin:0 0 6px;font-size:32px;letter-spacing:-.03em}
.shell{width:min(1200px,calc(100% - 32px));margin:0 auto;padding:28px 0 64px}
.topbar{border-bottom:1px solid #242c38;background:#0b0f15}
.topbar-inner{display:flex;justify-content:space-between;align-items:center;gap:16px;width:min(1200px,calc(100% - 32px));margin:0 auto;padding:10px 0}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border:1px solid #242c38;border-radius:9px;padding:0 13px;background:#171d26;color:#f5f7fa;font-size:13px;font-weight:700;text-decoration:none;cursor:pointer}
.button.primary{border-color:transparent;background:#ff365e}
button:disabled{opacity:.55;cursor:wait}
input,select{padding:7px 9px;border:1px solid #2c3542;border-radius:8px;background:#10151d;color:inherit;font:inherit}
.fleet-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:18px 0}
.fleet-tile{padding:12px;border:1px solid #242c38;border-radius:12px;background:#11161e}
.fleet-tile-value{display:block;font-size:24px;font-weight:800}
.fleet-tile-label,.fleet-meta{color:#929cab;font-size:12px}
.fleet-filters,.fleet-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:14px 0}
.fleet-filters label,.fleet-form label{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#929cab}
.fleet-bulk{margin:16px 0;padding:14px;border:1px solid #242c38;border-radius:12px;background:#11161e}
.fleet-form{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:12px 0}
.fleet-result{max-height:220px;overflow:auto;margin:0;color:#929cab;font-size:12px;white-space:pre-wrap}
.fleet-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.fleet-card{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid #242c38;border-radius:14px;background:#11161e}
.fleet-card header{display:flex;justify-content:space-between;align-items:center;gap:8px}
.fleet-card[hidden]{display:none}
.fleet-pick{display:inline-flex;align-items:center;gap:7px;font-weight:700;font-size:14px}
.fleet-shot{aspect-ratio:9/16;max-height:220px;overflow:hidden;border:1px solid #242c38;border-radius:10px;background:#0b0f15}
.fleet-shot img{width:100%;height:100%;object-fit:contain}
.fleet-shot.empty{background:repeating-linear-gradient(45deg,#0b0f15,#0b0f15 8px,#11161e 8px,#11161e 16px)}
.badge{display:inline-block;margin:0 5px 5px 0;padding:2px 8px;border:1px solid #2c3542;border-radius:999px;font-size:11px;font-weight:700}
.badge.state-online{border-color:#42d69d;color:#42d69d}
.badge.state-offline{border-color:#f4bd50;color:#f4bd50}
.badge.state-disabled{border-color:#5b6675;color:#929cab}
.badge.platform-ios{border-color:#60a5fa;color:#60a5fa}
.badge.platform-android{border-color:#42d69d;color:#42d69d}
.badge.tag{border-color:#ff365e;color:#ff365e}
.fleet-activity.running{color:#42d69d}.fleet-activity.queued{color:#f4bd50}
.fleet-tags{display:flex;gap:6px}.fleet-tags input{flex:1;min-width:0}
.last-event{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;

const SCRIPT = String.raw`
const cards = () => Array.from(document.querySelectorAll('[data-device-card]'));
const result = document.getElementById('fleet-result');
const say = (value) => { result.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
const selected = () => cards().filter((card) => !card.hidden && card.querySelector('[data-select]').checked);
const udids = () => selected().map((card) => card.dataset.udid);

function applyFilters() {
    const tag = document.getElementById('filter-tag').value;
    const platform = document.getElementById('filter-platform').value;
    const state = document.getElementById('filter-state').value;
    for (const card of cards()) {
        const tags = (card.dataset.tags || '').split(',').filter(Boolean);
        card.hidden = (tag && !tags.includes(tag)) || (platform && card.dataset.platform !== platform)
            || (state && card.dataset.state !== state);
    }
    countSelection();
}

function countSelection() {
    document.getElementById('fleet-selection-count').textContent = selected().length + ' selected';
}

for (const id of ['filter-tag', 'filter-platform', 'filter-state']) {
    document.getElementById(id).addEventListener('change', applyFilters);
}
document.getElementById('select-all').addEventListener('change', (event) => {
    for (const card of cards()) if (!card.hidden) card.querySelector('[data-select]').checked = event.target.checked;
    countSelection();
});
document.addEventListener('change', (event) => { if (event.target.matches('[data-select]')) countSelection(); });

// Screenshots refresh only while the card is on screen, and never for a
// disabled or offline device (those cards carry no [data-shot] image at all).
const REFRESH_MS = 30000;
const visible = new Set();
const refresh = (image) => { image.src = image.dataset.shot + '?t=' + Date.now(); };
const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        const image = entry.target;
        if (entry.isIntersecting) { visible.add(image); if (!image.src) refresh(image); }
        else visible.delete(image);
    }
}, { rootMargin: '120px' });
for (const image of document.querySelectorAll('[data-shot]')) observer.observe(image);
setInterval(() => { for (const image of visible) if (!image.closest('[data-device-card]').hidden) refresh(image); }, REFRESH_MS);

async function send(url, options) {
    const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || (url + ' failed with ' + response.status));
    return body;
}

function staggerFrom(form) {
    const kind = form.staggerKind.value;
    const value = Number(form.staggerValue.value || 0);
    return kind === 'fixed' ? { kind: 'fixed', minutes: value } : { kind: 'random', windowMinutes: value };
}

async function bulkSchedule(body) {
    const outcome = await send('/api/schedules/bulk', { method: 'POST', body: JSON.stringify(body) });
    say(outcome);
}

document.getElementById('bulk-doomscroll').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!udids().length) return say('Select at least one device.');
    try {
        await bulkSchedule({
            deviceUdids: udids(),
            task: { pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1, payload: {
                durationMinutes: Number(form.durationMinutes.value), personality: form.personality.value,
                likeEnabled: form.likeEnabled.checked, saveEnabled: form.saveEnabled.checked,
            } },
            timing: { kind: 'now' },
            stagger: staggerFrom(form),
        });
    } catch (error) { say(String(error.message || error)); }
});

document.getElementById('bulk-post').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const chosen = selected();
    if (!chosen.length) return say('Select at least one device.');
    const missing = chosen.filter((card) => !card.querySelector('[data-account]').value);
    if (missing.length) return say('These devices have no TikTok account: ' + missing.map((card) => card.dataset.udid).join(', '));
    try {
        say('Uploading media…');
        const data = new FormData();
        for (const file of form.media.files) data.append('media', file);
        const uploaded = await fetch('/api/assets', { method: 'POST', body: data }).then((response) => response.json());
        const media = uploaded.map((asset) => ({ assetId: asset.id, name: asset.name, mimeType: asset.mimeType }));
        const overrides = {};
        for (const card of chosen) overrides[card.dataset.udid] = { account: card.querySelector('[data-account]').value };
        await bulkSchedule({
            deviceUdids: chosen.map((card) => card.dataset.udid),
            task: { pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1, payload: {
                media, destination: form.destination.value, account: '',
                ...(form.caption.value ? { caption: form.caption.value } : {}),
            } },
            timing: { kind: 'once', runAt: new Date(form.runAt.value).toISOString() },
            stagger: staggerFrom(form),
            overrides,
        });
    } catch (error) { say(String(error.message || error)); }
});

document.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-tag-form]');
    if (!form) return;
    event.preventDefault();
    const tags = form.tags.value.split(',').map((tag) => tag.trim()).filter(Boolean);
    try {
        await send('/api/devices/' + encodeURIComponent(form.dataset.udid), { method: 'PATCH', body: JSON.stringify({ tags }) });
        const card = form.closest('[data-device-card]');
        card.dataset.tags = tags.join(',');
        say('Tags saved for ' + form.dataset.udid);
    } catch (error) { say(String(error.message || error)); }
});

document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-bulk]');
    if (!button) return;
    const action = button.dataset.bulk;
    const targets = udids();
    if (!targets.length) return say('Select at least one device.');
    button.disabled = true;
    const report = [];
    for (const udid of targets) {
        try {
            if (action === 'pause' || action === 'resume') {
                const { schedules } = await send('/api/schedules?deviceUdid=' + encodeURIComponent(udid), { method: 'GET' });
                const wanted = action === 'pause' ? 'active' : 'paused';
                const matching = schedules.filter((schedule) => schedule.status === wanted);
                for (const schedule of matching) await send('/api/schedules/' + schedule.id + '/' + action, { method: 'POST', body: '{}' });
                report.push(udid + ': ' + matching.length + ' schedules ' + action + 'd');
            } else if (action === 'disable' || action === 'enable') {
                await send('/api/devices/' + encodeURIComponent(udid), { method: 'PATCH', body: JSON.stringify({ disabled: action === 'disable' }) });
                report.push(udid + ': ' + action + 'd');
            } else {
                await send('/api/devices/' + encodeURIComponent(udid) + '/reconnect', { method: 'POST', body: '{}' });
                report.push(udid + ': reconnect requested');
            }
        } catch (error) { report.push(udid + ': ' + (error.message || error)); }
    }
    button.disabled = false;
    say(report.join('\n'));
});

applyFilters();
`;

export interface FleetPageInput {
    cards: readonly FleetCard[];
    summary: FleetSummary;
    tags: readonly string[];
    navHtml?: string;
    footerHtml?: string;
}

export function renderFleetPage(input: FleetPageInput): string {
    const grid = input.cards.length
        ? `<section class="fleet-grid">${input.cards.map(renderCard).join('')}</section>`
        : '<p class="fleet-meta">No devices are registered yet.</p>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Fleet · Phone Farm</title>
<style>${STYLES}</style></head><body>
<header class="topbar"><div class="topbar-inner"><a class="button secondary" href="/">Devices</a>
<nav><a class="button secondary" href="/tasks">Tasks</a>${input.navHtml ?? ''}</nav></div></header>
<main class="shell"><h1>Fleet</h1><p class="fleet-meta">Every registered device, its live state and bulk automation.</p>
${summaryTiles(input.summary)}${filters(input.tags)}${BULK_PANEL}${grid}</main>
<footer class="shell">${input.footerHtml ?? ''}</footer>
<script>${SCRIPT}</script></body></html>`;
}
