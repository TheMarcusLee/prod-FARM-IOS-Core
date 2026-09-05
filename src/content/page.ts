import type { CaptionTemplateRow, ContentItemRow, ContentSetRow, DripPlanRow, DripRuleRow } from '../database/schema.js';

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

function tagPills(tags: string[]): string {
    return tags.map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join('');
}

export function renderLibrary(items: ContentItemRow[]): string {
    if (!items.length) {
        return '<div id="content-library" class="empty-state">No media yet. Upload a file or ingest a folder.</div>';
    }
    const cards = items.map((item) => {
        const poster = item.posterPath
            ? `<img src="/api/content/items/${item.id}/poster" alt="" loading="lazy">`
            : '<div class="device-preview-frame unavailable">no preview</div>';
        const state = item.status === 'failed'
            ? `<p class="run-error">${escapeHtml(item.error ?? 'Processing failed')}</p>` : '';
        return `<article class="device-card" data-item="${item.id}">
<div class="device-preview">${poster}</div>
<div class="device-copy">
<h3>${escapeHtml(item.caption?.slice(0, 60) || duration(item))}</h3>
<p class="muted">${escapeHtml(item.kind)} · ${escapeHtml(duration(item))} · ${item.width}×${item.height}${item.normalized ? ' · normalised' : ''}</p>
<p class="muted">used ${item.usedCount}× ${item.lastUsedAt ? `· last ${escapeHtml(item.lastUsedAt.toISOString().slice(0, 10))}` : ''}</p>
<div class="device-badges"><span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>${tagPills(item.tags)}</div>
${state}
</div>
<div class="device-card-actions">
<button type="button" class="button secondary" data-edit-item="${item.id}" data-tags="${escapeHtml(item.tags.join(', '))}" data-hashtags="${escapeHtml(item.hashtags.join(', '))}" data-caption="${escapeHtml(item.caption ?? '')}">Edit</button>
<button type="button" class="button secondary" data-delete-item="${item.id}">Delete</button>
</div>
</article>`;
    }).join('');
    return `<div id="content-library" class="device-list">${cards}</div>`;
}

export function renderSets(sets: Array<ContentSetRow & { itemCount: number }>): string {
    const rows = sets.map((set) => `<tr><td>${escapeHtml(set.name)}</td><td class="muted">${escapeHtml(set.notes ?? '')}</td>`
        + `<td>${set.itemCount}</td><td><code>${escapeHtml(set.id)}</code></td>`
        + `<td><button type="button" class="icon-button" data-delete-set="${set.id}">Delete</button></td></tr>`).join('');
    return `<div id="content-sets"><table><tr><th>Set</th><th>Notes</th><th>Items</th><th>ID</th><th></th></tr>`
        + `${rows || '<tr><td colspan="5" class="muted">No sets yet.</td></tr>'}</table></div>`;
}

export function renderTemplates(templates: CaptionTemplateRow[]): string {
    const rows = templates.map((template) => `<tr><td>${escapeHtml(template.name)}</td>`
        + `<td><code>${escapeHtml(template.template)}</code></td>`
        + `<td><button type="button" class="icon-button" data-delete-template="${template.id}">Delete</button></td></tr>`).join('');
    return `<div id="caption-templates"><table><tr><th>Name</th><th>Template</th><th></th></tr>`
        + `${rows || '<tr><td colspan="3" class="muted">No caption templates yet.</td></tr>'}</table></div>`;
}

export interface RuleView {
    rule: DripRuleRow;
    plans: Array<DripPlanRow & { status: string | null }>;
}

export function renderRules(views: RuleView[]): string {
    if (!views.length) return '<div id="drip-rules" class="empty-state">No drip rules yet.</div>';
    const cards = views.map(({ rule, plans }) => {
        const upcoming = plans.slice(0, 6).map((plan) => `<li>${escapeHtml(plan.plannedFor.toISOString().replace('T', ' ').slice(0, 16))} UTC`
            + ` · <span class="status ${escapeHtml(plan.status ?? 'unknown')}">${escapeHtml(plan.status ?? 'unknown')}</span></li>`).join('');
        const source = rule.source === 'set' ? `set ${escapeHtml(rule.setId ?? '—')}` : `tag #${escapeHtml(rule.tag ?? '—')}`;
        return `<article class="panel" data-rule="${rule.id}">
<div class="section-heading"><div><span class="eyebrow">${escapeHtml(rule.deviceUdid)}</span><h3>${escapeHtml(rule.account)}</h3></div>
<span class="status ${rule.enabled ? 'ready' : 'paused'}">${rule.enabled ? 'enabled' : 'paused'}</span></div>
<p class="muted">${rule.postsPerDay}×/day · ${escapeHtml(rule.windowStart)}–${escapeHtml(rule.windowEnd)} ${escapeHtml(rule.timezone)}
 · ≥${rule.minGapMinutes} min apart · ${escapeHtml(rule.destination)} · ${source} · ${escapeHtml(rule.pickOrder)} · reuse after ${rule.avoidReuseDays}d</p>
<ul class="task-list">${upcoming || '<li class="muted">Nothing planned yet.</li>'}</ul>
<div class="inline-actions">
<button type="button" class="button secondary" data-toggle-rule="${rule.id}" data-enabled="${rule.enabled ? 'false' : 'true'}">${rule.enabled ? 'Pause' : 'Enable'}</button>
<button type="button" class="button secondary" data-delete-rule="${rule.id}">Delete</button>
</div>
</article>`;
    }).join('');
    return `<div id="drip-rules" class="workspace-grid">${cards}</div>`;
}
