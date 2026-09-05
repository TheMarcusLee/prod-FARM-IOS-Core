/**
 * Server-rendered HTML for the Schedule page. The page script re-renders the same markup from
 * `GET /api/schedule/timeline` every 30 seconds; this module draws the first frame so the timeline
 * is never a blank rectangle waiting for JavaScript. Keep the two in step — see
 * static/dashboard/ts/schedule.ts, which mirrors `trackHtml` element for element.
 */

import { icon } from '../ui/icons.js';
import { escapeHtml, renderShell, type RigStatus } from '../ui/shell.js';
import {
    RANGE_LABELS, clipGeometry, hhmm, playheadPercent,
    type TimelineClip, type TimelinePayload, type TimelineRange, type TimelineTrack,
} from './timeline.js';

/** Inline styles are the only honest way to place a clip: its position is data, not design. */
function clipStyle(clip: TimelineClip, payload: TimelinePayload): string {
    const { left, width } = clipGeometry(clip, payload.from, payload.to);
    const failed = clip.status === 'failed';
    const retry = Boolean(clip.retryOf);
    const paint = failed || retry ? '' : `background:${clip.colour.fill};border-color:${clip.colour.line};color:${clip.colour.ink};`;
    return `left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;${paint}`;
}

function clipClass(clip: TimelineClip): string {
    const parts = ['bl-clip'];
    if (clip.status === 'failed') parts.push('is-failed');
    else if (clip.retryOf) parts.push('is-retry');
    if (clip.status === 'succeeded') parts.push('is-done');
    if (clip.status === 'running') parts.push('is-running');
    if (clip.status === 'planned') parts.push('is-planned');
    if (clip.status === 'cancelled' || clip.status === 'stopped') parts.push('is-stopped');
    return parts.join(' ');
}

function clipLabel(clip: TimelineClip): string {
    if (clip.status === 'failed') return `${icon('alert', 11)}<span>failed</span>`;
    if (clip.retryOf) return `<span>retry ${escapeHtml(clip.time)}</span>`;
    return `<span>${escapeHtml(clip.title)}</span>`;
}

export function clipHtml(clip: TimelineClip, payload: TimelinePayload): string {
    const progress = clip.progress === undefined ? ''
        : `<span class="bl-clip-progress" style="width:${(clip.progress * 100).toFixed(1)}%"></span>`;
    return `<button type="button" class="${clipClass(clip)}" style="${clipStyle(clip, payload)}"`
        + ` data-clip="${escapeHtml(clip.id)}" title="${escapeHtml(clip.summary)}">${progress}${clipLabel(clip)}</button>`;
}

function trackNameHtml(track: TimelineTrack): string {
    return `<div class="bl-tl-track-name" data-state="${escapeHtml(track.state)}">`
        + `<span class="bl-tl-slot">${escapeHtml(track.slot)}</span>`
        + `<span class="bl-tl-device">${escapeHtml(track.name)}</span></div>`;
}

export function trackHtml(track: TimelineTrack, payload: TimelinePayload): string {
    return trackNameHtml(track)
        + `<div class="bl-tl-track bl-tl-lane" data-device="${escapeHtml(track.deviceUdid)}">`
        + track.clips.map((clip) => clipHtml(clip, payload)).join('')
        + '</div>';
}

function legendHtml(payload: TimelinePayload): string {
    if (!payload.accounts.length) return '';
    return `<div class="bl-legend">${payload.accounts.map(({ account, colour }) =>
        `<span class="bl-legend-item"><span class="bl-legend-swatch" style="background:${colour.fill};border-color:${colour.line}"></span>`
        + `${escapeHtml(account)}</span>`).join('')}</div>`;
}

function subtitle(payload: TimelinePayload): string {
    const { posts, accounts, needsYou } = payload.counts;
    const first = `${posts} ${posts === 1 ? 'post' : 'posts'} across ${accounts} ${accounts === 1 ? 'account' : 'accounts'}`;
    return needsYou ? `${first} · ${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you` : first;
}

export function timelineHtml(payload: TimelinePayload): string {
    const step = 100 / Math.max(1, payload.ticks.length - 1);
    const playhead = playheadPercent(payload.now, payload.from, payload.to);
    const head = payload.ticks.map(({ label }) => `<span>${escapeHtml(label)}</span>`).join('');
    const body = payload.tracks.length
        ? payload.tracks.map((track) => trackHtml(track, payload)).join('')
        : '<div class="bl-tl-track-name"></div><div class="bl-tl-track bl-tl-lane">'
            + '<p class="bl-tl-empty">No phones are active. Register one on the Devices page.</p></div>';
    const marker = playhead === null ? ''
        : `<div class="bl-playhead" style="left:${playhead.toFixed(3)}%">`
            + `<span class="bl-playhead-label">now ${escapeHtml(hhmm(new Date(payload.now)))}</span></div>`;
    return `<div class="bl-tl" style="--bl-tl-step:${step.toFixed(4)}%">`
        + `<div class="bl-tl-corner"></div><div class="bl-tl-ruler">${head}</div>`
        + `${body}<div class="bl-tl-overlay">${marker}</div></div>`;
}

function recentHtml(payload: TimelinePayload): string {
    if (!payload.recent.length) {
        return '<p class="bl-empty">Nothing has run yet. Schedule a post and it shows up here.</p>';
    }
    return `<ul class="bl-recent">${payload.recent.map((event) => `<li class="bl-recent-row is-${escapeHtml(event.severity)}">`
        + `<time>${escapeHtml(event.time)}</time><span>${escapeHtml(event.title)}</span>`
        + `${event.deviceName ? `<em>${escapeHtml(event.deviceName)}</em>` : ''}</li>`).join('')}</ul>`;
}

function plannerHtml(payload: TimelinePayload): string {
    const planner = payload.planner;
    if (!planner) return '';
    const next = planner.nextRunAt ? hhmm(new Date(planner.nextRunAt)) : 'not scheduled';
    const rules = `${planner.enabled} of ${planner.rules} ${planner.rules === 1 ? 'rule' : 'rules'} enabled`;
    const warnings = planner.warnings.length
        ? `<div class="bl-callout bl-callout-bad"><strong>The planner will under-post</strong>`
            + `${planner.warnings.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}</div>`
        : '';
    return `<section class="bl-panel bl-sched-planner"><div class="bl-panel-head">Planner</div>`
        + `<div class="bl-panel-body"><p class="bl-muted">Next planning run at ${escapeHtml(next)} · ${escapeHtml(rules)}.</p>`
        + `${warnings}</div></section>`;
}

/** The whole page body: the board, the recent list and the planner line. */
export function schedulePageBody(payload: TimelinePayload): string {
    return `<div class="bl-sched" id="schedule-root" data-from="${escapeHtml(payload.from)}" data-to="${escapeHtml(payload.to)}">`
        + `<section class="bl-panel bl-sched-board">`
        + `<header class="bl-sched-head"><h2 id="schedule-heading">${escapeHtml(payload.heading)}</h2>`
        + `<p class="bl-sched-sub" id="schedule-sub">${escapeHtml(subtitle(payload))}</p>`
        + `<div class="bl-sched-legend" id="schedule-legend">${legendHtml(payload)}</div></header>`
        + `<div class="bl-tl-scroll" id="schedule-timeline">${timelineHtml(payload)}</div></section>`
        + `<div class="bl-sched-foot">`
        + `<section class="bl-panel bl-sched-recent"><div class="bl-panel-head">Recently</div>`
        + `<div class="bl-panel-body" id="schedule-recent">${recentHtml(payload)}</div></section>`
        + `${plannerHtml(payload)}</div>`
        + `<div class="bl-popover" id="schedule-popover" hidden></div>`
        + pickerHtml(payload)
        + `</div>`;
}

/** "Schedule post" needs a phone before it needs anything else; the picker is that question. */
function pickerHtml(payload: TimelinePayload): string {
    const rows = payload.tracks.map((track) => `<a class="bl-picker-row" href="/devices/${encodeURIComponent(track.deviceUdid)}">`
        + `<span class="bl-tl-slot">${escapeHtml(track.slot)}</span><span>${escapeHtml(track.name)}</span>`
        + `<span class="bl-muted">${escapeHtml(track.accounts.join(', ') || 'no accounts yet')}</span></a>`).join('');
    return `<dialog class="bl-dialog" id="schedule-picker"><form method="dialog"><div class="bl-dialog-head">`
        + `<strong>Schedule a post</strong><button class="bl-btn bl-btn-icon" value="close" aria-label="Close">${icon('x')}</button></div></form>`
        + `<div class="bl-dialog-body"><p class="bl-muted">Choose the phone that posts it.</p>`
        + `<div class="bl-picker">${rows || '<p class="bl-muted">No phones are active yet.</p>'}</div></div></dialog>`;
}

export interface SchedulePageInput {
    payload: TimelinePayload;
    rig?: RigStatus;
    unreadAlerts?: number;
    pluginNav?: string;
    authNav?: string;
    /** Cache-busting suffix for the page assets, e.g. `?v=abc123`. */
    assetVersion?: string;
}

function rangeControl(range: TimelineRange): string {
    const options = (['today', 'tomorrow', 'week'] as const).map((key) => {
        const current = key === range ? ' aria-current="true"' : '';
        return `<a href="/schedule?range=${key}"${current}>${RANGE_LABELS[key]}</a>`;
    }).join('');
    return `<div class="bl-seg" role="group" aria-label="Range">${options}</div>`;
}

export function renderSchedulePage(input: SchedulePageInput): string {
    const version = input.assetVersion ?? '';
    return renderShell({
        title: 'Schedule',
        active: 'schedule',
        toolbar: `${rangeControl(input.payload.range)}`
            + `<button type="button" class="bl-btn bl-btn-primary" id="schedule-post">${icon('plus')}Schedule post</button>`,
        toolbarRight: `<span id="schedule-updated" class="bl-faint">Updated ${escapeHtml(hhmm(new Date(input.payload.now)))}</span>`,
        body: schedulePageBody(input.payload),
        head: `<link rel="stylesheet" href="/assets/pages.css${version}">`
            + `<script type="module" src="/assets/schedule.js${version}" defer></script>`,
        ...(input.rig ? { rig: input.rig } : {}),
        ...(input.unreadAlerts === undefined ? {} : { unreadAlerts: input.unreadAlerts }),
        ...(input.pluginNav ? { pluginNav: input.pluginNav } : {}),
        ...(input.authNav ? { authNav: input.authNav } : {}),
    });
}
