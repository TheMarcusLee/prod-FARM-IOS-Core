/**
 * Server-rendered HTML for the Content page: the library grid, sets, caption templates and the drip
 * rules that turn media into scheduled posts. The page is one `renderShell` call; the four listings
 * are HTMX fragments that swap themselves, so their wrapper ids (`content-library`, `content-sets`,
 * `caption-templates`, `drip-rules`) and the `data-*` hooks the page script listens for are part of
 * the contract. See docs/design/backline.md.
 */

import type { CaptionTemplateRow, ContentItemRow, ContentSetRow, DripPlanRow, DripRuleRow } from '../database/schema.js';
import { assignAccountColours, colourFor, type AccountColour } from '../schedule/accounts.js';
import { icon } from '../ui/icons.js';
import type { ShellPage } from '../ui/context.js';

export function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
}

function duration(item: ContentItemRow): string {
    if (!item.durationMs) return item.kind === 'image' ? 'image' : 'video';
    const seconds = Math.round(item.durationMs / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function tagChips(tags: readonly string[]): string {
    return tags.map((tag) => `<span class="bl-tagchip">${escapeHtml(tag)}</span>`).join('');
}

function usedLabel(item: ContentItemRow): string {
    if (!item.usedCount) return 'never used';
    const last = item.lastUsedAt ? `, last ${item.lastUsedAt.toISOString().slice(0, 10)}` : '';
    return `used ${item.usedCount}×${last}`;
}

/** The library grid. Posters come from the shared asset thumbnailer, so one cache serves every client. */
export function renderLibrary(items: ContentItemRow[]): string {
    if (!items.length) {
        return '<div id="content-library" class="bl-empty">No media yet. Drop a file on the panel above, or ingest a folder.</div>';
    }
    const cards = items.map((item) => {
        const title = item.caption?.trim() || duration(item);
        const state = item.status === 'ready' ? '' : `<span class="bl-state ${item.status === 'failed' ? 'error' : ''}">`
            + `<span class="bl-dot ${item.status === 'failed' ? 'bad' : 'warn'}"></span>`
            + `${escapeHtml(item.status === 'failed' ? item.error ?? 'processing failed' : item.status)}</span>`;
        return `<article class="bl-lib-card${item.status === 'failed' ? ' is-failed' : ''}" data-item="${escapeHtml(item.id)}">
<div class="bl-lib-poster"><img src="/api/assets/${encodeURIComponent(item.assetId)}/thumbnail?w=240" alt="" loading="lazy" onerror="this.remove()">
<span class="bl-lib-badge">${escapeHtml(duration(item))}</span></div>
<div class="bl-lib-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
<div class="bl-lib-meta"><span>${item.width}×${item.height}</span><span>${escapeHtml(usedLabel(item))}</span>${item.normalized ? '<span>normalised</span>' : ''}</div>
${state}
<div class="bl-lib-tags">${tagChips(item.tags)}</div>
<div class="bl-lib-actions">
<button type="button" class="bl-btn bl-btn-sm" data-edit-item="${escapeHtml(item.id)}" data-tags="${escapeHtml(item.tags.join(', '))}" data-hashtags="${escapeHtml(item.hashtags.join(', '))}" data-caption="${escapeHtml(item.caption ?? '')}">Edit</button>
<button type="button" class="bl-btn bl-btn-sm" data-delete-item="${escapeHtml(item.id)}">Delete</button>
</div>
</article>`;
    }).join('');
    return `<div id="content-library" class="bl-lib-grid">${cards}</div>`;
}

export function renderSets(sets: Array<ContentSetRow & { itemCount: number }>): string {
    if (!sets.length) return '<div id="content-sets" class="bl-empty">No sets yet. A set is a pool a drip rule can post from.</div>';
    const rows = sets.map((set) => `<tr><td>${escapeHtml(set.name)}</td>`
        + `<td class="bl-muted">${escapeHtml(set.notes ?? '')}</td>`
        + `<td>${set.itemCount}</td>`
        + `<td><button type="button" class="bl-btn bl-btn-sm" data-delete-set="${escapeHtml(set.id)}">Delete</button></td></tr>`).join('');
    return `<div id="content-sets"><table class="bl-table"><thead><tr><th>Set</th><th>Notes</th><th>Items</th><th></th></tr></thead>`
        + `<tbody>${rows}</tbody></table></div>`;
}

export function renderTemplates(templates: CaptionTemplateRow[]): string {
    if (!templates.length) {
        return '<div id="caption-templates" class="bl-empty">No caption templates yet. A rule without one posts the media\'s own caption.</div>';
    }
    const rows = templates.map((template) => `<tr><td>${escapeHtml(template.name)}</td>`
        + `<td class="bl-muted">${escapeHtml(template.template)}</td>`
        + `<td><button type="button" class="bl-btn bl-btn-sm" data-delete-template="${escapeHtml(template.id)}">Delete</button></td></tr>`).join('');
    return `<div id="caption-templates"><table class="bl-table"><thead><tr><th>Name</th><th>Template</th><th></th></tr></thead>`
        + `<tbody>${rows}</tbody></table></div>`;
}

export interface RuleView {
    rule: DripRuleRow;
    plans: Array<DripPlanRow & { status: string | null }>;
}

/** Minutes from midnight, so a window can be drawn as a bar across the day. */
function minutesOfDay(value: string): number {
    const [hours, minutes] = value.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
    return (hours as number) * 60 + (minutes as number);
}

/** A window that ends at or before it starts crosses midnight; it draws as two pieces. */
function windowBar(rule: DripRuleRow, colour: AccountColour): string {
    const start = minutesOfDay(rule.windowStart);
    const end = minutesOfDay(rule.windowEnd);
    const piece = (from: number, to: number) => `<span class="bl-window-fill" style="left:${(from / 14.4).toFixed(2)}%;`
        + `width:${((to - from) / 14.4).toFixed(2)}%;background:${colour.fill}"></span>`;
    const fills = end > start ? piece(start, end) : piece(start, 1440) + piece(0, end);
    return `<div class="bl-window" role="img" aria-label="Posts between ${escapeHtml(rule.windowStart)} and ${escapeHtml(rule.windowEnd)}">${fills}</div>`;
}

function ruleRow(view: RuleView, colour: AccountColour): string {
    const { rule, plans } = view;
    const source = rule.source === 'set' ? `set ${escapeHtml(rule.setId ?? '—')}` : `tag ${escapeHtml(rule.tag ?? '—')}`;
    const next = plans.slice(0, 5).map((plan) => `<span>${escapeHtml(plan.plannedFor.toISOString().slice(11, 16))} UTC`
        + `${plan.status && plan.status !== 'active' ? ` · ${escapeHtml(plan.status)}` : ''}</span>`).join('');
    return `<article class="bl-rule" data-rule="${escapeHtml(rule.id)}">
<div class="bl-rule-head"><span class="bl-rule-swatch" style="background:${colour.fill};border-color:${colour.line}"></span>
<strong>${escapeHtml(rule.account)}</strong>
<span class="bl-muted">${escapeHtml(rule.deviceUdid)}</span>
<span class="bl-state ${rule.enabled ? 'online' : ''}"><span class="bl-dot ${rule.enabled ? 'ok' : ''}"></span>${rule.enabled ? 'enabled' : 'paused'}</span>
<span class="bl-rule-actions">
<button type="button" class="bl-btn bl-btn-sm" data-toggle-rule="${escapeHtml(rule.id)}" data-enabled="${rule.enabled ? 'false' : 'true'}">${rule.enabled ? 'Pause' : 'Enable'}</button>
<button type="button" class="bl-btn bl-btn-sm" data-delete-rule="${escapeHtml(rule.id)}">Delete</button>
</span></div>
<p class="bl-rule-meta">${rule.postsPerDay}× a day between ${escapeHtml(rule.windowStart)} and ${escapeHtml(rule.windowEnd)} ${escapeHtml(rule.timezone)},
 at least ${rule.minGapMinutes} minutes apart · ${escapeHtml(rule.destination)} · ${source} · ${escapeHtml(rule.pickOrder)} · reuse after ${rule.avoidReuseDays} days</p>
${windowBar(rule, colour)}
<div class="bl-rule-next">${next || '<span>Nothing planned yet.</span>'}</div>
</article>`;
}

export function renderRules(views: RuleView[], colours?: ReadonlyMap<string, AccountColour>): string {
    if (!views.length) {
        return '<div id="drip-rules" class="bl-empty">No drip rules yet. A rule turns tagged media into scheduled posts on one account.</div>';
    }
    const palette = colours ?? assignAccountColours(views.map(({ rule }) => rule.account));
    return `<div id="drip-rules">${views.map((view) => ruleRow(view, colourFor(palette, view.rule.account))).join('')}</div>`;
}

// ---- the page itself -------------------------------------------------------

function panel(title: string, body: string, action = ''): string {
    return `<section class="bl-panel"><div class="bl-panel-head">${escapeHtml(title)}`
        + `${action ? `<span style="margin-left:auto">${action}</span>` : ''}</div>`
        + `<div class="bl-panel-body">${body}</div></section>`;
}

function ingestPanel(): string {
    return `<section class="bl-panel"><div class="bl-panel-head">Add media</div><div class="bl-panel-body">
<form id="upload-form" enctype="multipart/form-data">
<div class="bl-drop" id="upload-drop" tabindex="0" role="button" aria-label="Choose files to upload">
${icon('upload', 20)}<strong>Drop clips and images here</strong>
<span>Vertical video and images. Everything is normalised to 9:16 in the background.</span>
<span><button type="button" class="bl-btn" id="upload-choose">Choose files</button></span>
<span id="upload-chosen" class="bl-faint" aria-live="polite"></span>
</div>
<input id="upload-media" name="media" type="file" multiple accept="video/*,image/*" class="bl-visually-hidden" required>
<div class="bl-inline-form" style="margin-top:12px">
<label class="bl-field"><span>Tags</span><input id="upload-tags" name="tags" type="text" class="bl-input" placeholder="fitness, ugc"></label>
<label class="bl-check"><input id="upload-crop" name="crop" type="checkbox">Crop to 9:16 instead of padding</label>
<button class="bl-btn bl-btn-primary" type="submit">Upload</button>
</div>
<p id="upload-result" class="bl-muted" aria-live="polite"></p>
</form>
<ul id="upload-progress" class="bl-uploads"></ul>
<div class="bl-ingest-more">
<form id="ingest-form">
<span class="bl-section-title">From a folder on this host</span>
<label class="bl-field"><span>Path</span><input id="ingest-directory" name="directory" type="text" class="bl-input" placeholder="/Users/me/clips" required></label>
<label class="bl-field"><span>Tags</span><input id="ingest-tags" name="tags" type="text" class="bl-input" placeholder="fitness"></label>
<button class="bl-btn" type="submit">Ingest folder</button>
<p id="ingest-result" class="bl-muted" aria-live="polite"></p>
</form>
<form id="ingest-url-form">
<span class="bl-section-title">From a URL</span>
<label class="bl-field"><span>Link</span><input id="ingest-url" name="url" type="url" class="bl-input" placeholder="https://…" required></label>
<label class="bl-field"><span>Tags</span><input id="ingest-url-tags" name="tags" type="text" class="bl-input"></label>
<button class="bl-btn" type="submit">Download</button>
<p id="ingest-url-result" class="bl-muted" aria-live="polite">Needs yt-dlp on the host.</p>
</form>
</div>
</div></section>`;
}

function rulesForm(): string {
    return `<form id="rule-form">
<div class="bl-form-grid">
<label class="bl-field"><span>Phone</span><select id="rule-device" name="deviceUdid" class="bl-select" required></select></label>
<label class="bl-field"><span>Account</span><input id="rule-account" name="account" type="text" class="bl-input" placeholder="@handle" required></label>
<label class="bl-field"><span>Posts per day</span><input id="rule-posts" name="postsPerDay" type="number" class="bl-input" min="1" max="24" value="2"></label>
<label class="bl-field"><span>Window start</span><input id="rule-start" name="windowStart" type="time" class="bl-input" value="09:00"></label>
<label class="bl-field"><span>Window end</span><input id="rule-end" name="windowEnd" type="time" class="bl-input" value="21:00"></label>
<label class="bl-field"><span>Timezone</span><input id="rule-timezone" name="timezone" type="text" class="bl-input" value="UTC"></label>
<label class="bl-field"><span>Minimum gap (minutes)</span><input id="rule-gap" name="minGapMinutes" type="number" class="bl-input" min="0" max="1440" value="120"></label>
<label class="bl-field"><span>Avoid reuse (days)</span><input id="rule-reuse" name="avoidReuseDays" type="number" class="bl-input" min="0" max="3650" value="30"></label>
<label class="bl-field"><span>Destination</span><select id="rule-destination" name="destination" class="bl-select"><option value="draft">Draft</option><option value="publish">Publish</option></select></label>
<label class="bl-field"><span>Source</span><select id="rule-source" name="source" class="bl-select"><option value="tag">Tag</option><option value="set">Set</option></select></label>
<label class="bl-field"><span>Tag</span><input id="rule-tag" name="tag" type="text" class="bl-input" placeholder="fitness"></label>
<label class="bl-field"><span>Set</span><select id="rule-set" name="setId" class="bl-select"><option value="">—</option></select></label>
<label class="bl-field"><span>Caption template</span><select id="rule-template" name="captionTemplateId" class="bl-select"><option value="">—</option></select></label>
<label class="bl-field"><span>Order</span><select id="rule-order" name="order" class="bl-select"><option value="random">Random</option><option value="fifo">FIFO</option></select></label>
</div>
<div class="bl-form-actions"><button class="bl-btn bl-btn-primary" type="submit">Create rule</button>
<button id="plan-now" class="bl-btn" type="button">Plan now</button></div>
<p id="rule-result" class="bl-muted" aria-live="polite"></p>
</form>`;
}

/**
 * The whole /content page, as the shell's page slots. `createShellContext`'s `shell` turns it into
 * a document with the sidebar's rig block and unread count already filled in — see src/ui/context.ts.
 */
export function contentPage(assetVersion = ''): ShellPage {
    const version = assetVersion;
    const load = (url: string, id: string) => `<div id="${id}" hx-get="${url}" hx-trigger="load" hx-swap="outerHTML">`
        + '<p class="bl-muted">Loading…</p></div>';
    const body = `<div class="bl-content-page">
<div class="bl-content-col">
${ingestPanel()}
<section class="bl-panel"><div class="bl-panel-head">Library
<span style="margin-left:auto"><input id="library-filter" type="text" class="bl-input" style="width:180px" placeholder="Filter by tag" aria-label="Filter by tag"></span></div>
<div class="bl-panel-body">${load('/api/content/items', 'content-library')}</div></section>
<section class="bl-panel"><div class="bl-panel-head">Drip rules</div>
<div class="bl-panel-body">${rulesForm()}</div>
${load('/api/drip/rules', 'drip-rules')}</section>
</div>
<div class="bl-content-col">
${panel('Sets', `<form id="set-form" class="bl-inline-form">
<label class="bl-field"><span>Name</span><input name="name" type="text" class="bl-input" placeholder="Gym b-roll" required></label>
<label class="bl-field"><span>Notes</span><input name="notes" type="text" class="bl-input"></label>
<button class="bl-btn" type="submit">Create set</button></form>
<p class="bl-faint">One to three images post as a single slideshow; anything larger is a pool of individual posts.</p>
${load('/api/content/sets', 'content-sets')}`)}
${panel('Caption templates', `<form id="template-form" class="bl-inline-form">
<label class="bl-field"><span>Name</span><input name="name" type="text" class="bl-input" placeholder="Hook" required></label>
<label class="bl-field"><span>Template</span><input name="template" type="text" class="bl-input" placeholder="{title} {hashtags}" required></label>
<button class="bl-btn" type="submit">Save</button>
<button id="template-preview-button" class="bl-btn" type="button">Preview</button></form>
<p id="template-preview" class="bl-faint" aria-live="polite">Supports {title}, {hashtags}, {account}, {date} and {random:a|b|c} spintax.</p>
${load('/api/content/templates', 'caption-templates')}`)}
</div>
</div>`;
    return {
        title: 'Content',
        active: 'content',
        toolbar: `<button type="button" class="bl-btn" id="refresh-content">${icon('refresh')}Refresh</button>`,
        body,
        head: `<link rel="stylesheet" href="/assets/pages.css${version}">`
            + `<script type="module" src="/assets/content.js${version}" defer></script>`,
    };
}
