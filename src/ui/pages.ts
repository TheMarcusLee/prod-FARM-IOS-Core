/**
 * The plain pages: the device registry, Rig, Alerts, Accounts and Settings. Each one is a body
 * for `renderShell` — simple, honest, and empty-stated. See docs/design/backline.md.
 */
import type { FarmEvent } from '../fleet/events.js';
import type { WallDevice } from '../fleet/page.js';
import { icon } from './icons.js';
import type { RigService } from './rig.js';
import { escapeHtml, slotNumber, stateBadge } from './shell.js';

/**
 * Identity colours, assigned in order of account creation. Fixed values from the design spec —
 * never interpolated from anything a user typed.
 */
export const ACCOUNT_COLOURS = [
    '#a3c497', '#b9a6dc', '#e6a48f', '#9dbfdd', '#dcc27a', '#e0a3c4', '#9fd3c3', '#b3bccd',
] as const;

export function accountColour(index: number): string {
    return ACCOUNT_COLOURS[((index % ACCOUNT_COLOURS.length) + ACCOUNT_COLOURS.length) % ACCOUNT_COLOURS.length]!;
}

function panel(title: string, body: string, actions = ''): string {
    return `<section class="bl-panel"><div class="bl-panel-head">${escapeHtml(title)}`
        + `${actions ? `<span class="bl-spacer"></span>${actions}` : ''}</div>`
        + `<div class="bl-panel-body">${body}</div></section>`;
}

function empty(sentence: string, action = ''): string {
    return `<div class="bl-empty"><span>${escapeHtml(sentence)}</span>${action}</div>`;
}

/* ---- Devices ---------------------------------------------------------- */

const LINK_WORD: Record<string, string> = { wifi: 'Wi-Fi', usb: 'USB' };

export function renderDevicesPage(devices: readonly WallDevice[]): string {
    if (!devices.length) {
        return `<div class="bl-page">${panel('Devices', empty('No phones are registered yet.',
            '<a class="bl-btn bl-btn-primary" href="/devices/register">Register a device</a>'))}</div>`;
    }
    const rows = devices.map((device) => {
        const number = slotNumber(device.slot);
        const link = device.connected ? LINK_WORD[device.wifi ? 'wifi' : 'usb'] ?? 'USB' : 'not connected';
        return `<tr data-device-row data-udid="${escapeHtml(device.udid)}">`
            + `<td class="bl-tile-num">${number}</td>`
            + `<td><a href="/devices/${encodeURIComponent(device.udid)}">${escapeHtml(device.name)}</a></td>`
            + `<td>${device.platform === 'android' ? 'Android' : 'iOS'}</td>`
            + `<td class="bl-muted">${escapeHtml(device.driver)}</td>`
            + `<td>${device.tags.length ? device.tags.map((tag) => `<span class="bl-chip bl-chip-sm">${escapeHtml(tag)}</span>`).join('') : '<span class="bl-faint">none</span>'}</td>`
            + `<td>${stateBadge(device.state)} <span class="bl-faint">${escapeHtml(link)}</span></td>`
            + '<td class="bl-row-actions">'
            + `<a class="bl-btn bl-btn-sm" href="/devices/${encodeURIComponent(device.udid)}">Open</a>`
            + `<button type="button" class="bl-btn bl-btn-sm" data-device-disable="${device.disabled ? 'false' : 'true'}">${device.disabled ? 'Enable' : 'Disable'}</button>`
            + '<button type="button" class="bl-btn bl-btn-sm" data-device-remove>Remove</button>'
            + '</td></tr>';
    }).join('');
    return `<div class="bl-page"><section class="bl-panel">
<table class="bl-table" id="device-registry">
<thead><tr><th>#</th><th>Name</th><th>Platform</th><th>Driver</th><th>Tags</th><th>Connection</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></section>
<p class="bl-muted" id="device-registry-result" aria-live="polite"></p></div>`;
}

/* ---- Rig -------------------------------------------------------------- */

const RIG_WORD: Record<RigService['state'], string> = { running: 'Running', idle: 'Idle', stopped: 'Not running' };
const RIG_DOT: Record<RigService['state'], string> = { running: 'ok', idle: 'warn', stopped: 'bad' };

export function renderRigPage(services: readonly RigService[]): string {
    const rows = services.map((service) => `<div class="bl-service">
<div><div class="bl-service-name">${escapeHtml(service.name)}</div>
<div class="bl-service-detail">${escapeHtml(service.detail)}</div></div>
${service.state === 'stopped' && service.docs ? `<a class="bl-btn bl-btn-sm" href="${escapeHtml(service.docs)}">How to fix</a>` : ''}
<span class="bl-state"><span class="bl-dot ${RIG_DOT[service.state]}"></span>${RIG_WORD[service.state]}</span>
</div>`).join('');
    return `<div class="bl-page"><div class="bl-services">${rows}</div>
<p class="bl-muted">Backline runs these on this machine. Anything that is not running has a link to
the page that explains how to start it.</p></div>`;
}

/* ---- Alerts ----------------------------------------------------------- */

const SEVERITY_DOT: Record<string, string> = { error: 'bad', warning: 'warn', info: '' };

export function renderAlertsPage(events: readonly FarmEvent[], unread: number): string {
    if (!events.length) {
        return `<div class="bl-page">${panel('Alerts', empty('Nothing has gone wrong yet. Alerts appear here when a phone drops off or a task fails.'))}</div>`;
    }
    const rows = events.map((event) => `<li class="bl-alert" data-event-id="${event.id}">
<span class="bl-dot ${SEVERITY_DOT[event.severity] ?? ''}"></span>
<div class="bl-alert-copy"><div class="bl-alert-title">${escapeHtml(event.title)}</div>
<div class="bl-alert-meta"><span class="bl-chip bl-chip-sm">${escapeHtml(event.kind)}</span>
<span class="bl-chip bl-chip-sm">${escapeHtml(event.severity)}</span>
${event.deviceUdid ? `<a href="/devices/${encodeURIComponent(event.deviceUdid)}">${escapeHtml(event.deviceUdid)}</a>` : ''}
<time>${escapeHtml(event.createdAt.toISOString())}</time></div></div></li>`).join('');
    return `<div class="bl-page">
<p class="bl-muted" id="alerts-unread">${unread} unread</p>
<ul class="bl-alerts" id="alerts-list" data-newest="${events[0]?.id ?? 0}">${rows}</ul></div>`;
}

/* ---- Accounts --------------------------------------------------------- */

export interface AccountRow {
    handle: string;
    colourIndex: number;
    devices: ReadonlyArray<{ udid: string; name: string; slot: number }>;
}

export function renderAccountsPage(accounts: readonly AccountRow[], devices: readonly WallDevice[]): string {
    if (!accounts.length) {
        return `<div class="bl-page">${panel('Accounts', empty('No accounts are recorded yet. Add the handles signed in on a phone from its device page.',
            devices.length ? `<a class="bl-btn" href="/devices/${encodeURIComponent(devices[0]!.udid)}">Open ${slotNumber(devices[0]!.slot)}</a>` : ''))}</div>`;
    }
    const rows = accounts.map((account) => `<tr>
<td><span class="bl-swatch" style="background:${accountColour(account.colourIndex)}"></span>${escapeHtml(account.handle)}</td>
<td>${account.devices.map((device) => `<a class="bl-chip bl-chip-sm" href="/devices/${encodeURIComponent(device.udid)}">${slotNumber(device.slot)} ${escapeHtml(device.name)}</a>`).join('')}</td>
</tr>`).join('');
    return `<div class="bl-page"><section class="bl-panel"><table class="bl-table" id="accounts-table">
<thead><tr><th>Account</th><th>Phones</th></tr></thead><tbody>${rows}</tbody></table></section>
<p class="bl-muted">Accounts come from each phone's record. Edit them on the device page; the colour
is the account's identity everywhere else in Backline.</p></div>`;
}

/** Group the fleet's accounts, giving each one a stable colour by first appearance. */
export function accountRows(devices: readonly WallDevice[]): AccountRow[] {
    const byHandle = new Map<string, AccountRow>();
    for (const device of devices) {
        for (const handle of device.accounts) {
            let row = byHandle.get(handle);
            if (!row) {
                row = { handle, colourIndex: byHandle.size, devices: [] };
                byHandle.set(handle, row);
            }
            (row.devices as Array<{ udid: string; name: string; slot: number }>)
                .push({ udid: device.udid, name: device.name, slot: device.slot });
        }
    }
    return [...byHandle.values()];
}

/* ---- Settings --------------------------------------------------------- */

export interface SettingsInput {
    theme: 'auto' | 'light';
    /** The MCP client block an operator pastes into their editor. */
    mcpConfig: string;
    /** Where this farm answers, for the MCP block and the docs links. */
    origin: string;
}

export function renderSettingsPage(input: SettingsInput): string {
    const theme = `<div class="bl-seg" role="group" aria-label="Theme">
<a href="/settings?theme=auto"${input.theme === 'auto' ? ' aria-current="true"' : ''}>Auto</a>
<a href="/settings?theme=light"${input.theme === 'light' ? ' aria-current="true"' : ''}>Light</a></div>`;
    const tiles = `<div class="bl-rows">
<div><span>Screen size</span><span><button type="button" class="bl-btn bl-btn-sm" data-reset-tiles>Reset to medium, 1 fps</button></span></div>
<div><span>Where they are kept</span><span class="bl-faint">This browser only</span></div></div>`;
    const tokens = `<p class="bl-muted">API tokens are minted from the command line so they never pass
through a browser: <code>npm run token:create</code>, and <code>npm run token:revoke</code> to take one
back. The mobile app and the MCP server both authenticate with one.</p>
<a class="bl-btn" href="/docs/auth">Read about tokens</a>`;
    return `<div class="bl-page bl-page-narrow">
${panel('Appearance', `<p class="bl-muted">Auto follows the operating system at night; light keeps the
pro-app appearance whatever the machine does.</p>${theme}`)}
${panel('Wall defaults', tiles)}
${panel('Tokens', tokens)}
${panel('MCP', `<p class="bl-muted">Point an MCP client at this farm to let it read the fleet and
schedule work. Paste this into the client's configuration.</p>
<pre class="bl-code" id="mcp-config">${escapeHtml(input.mcpConfig)}</pre>
<button type="button" class="bl-btn" data-copy="#mcp-config">${icon('layers')}Copy</button>`)}
</div>`;
}
