import { flowsForPlugin, selectorStatuses, type SelectorStatus } from './catalog.js';
import type { SelectorEntryList } from '../drivers/selector-overrides.js';

/**
 * The Selectors block on a device page: what each Android routine is looking for on this phone,
 * whether anybody has ever checked it, and a button that sends the agent to go and check.
 *
 * Plain server-rendered HTML on the dashboard's own classes, loaded as an HTMX fragment like the
 * summary and activity blocks beside it.
 */

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character
    ));
}

function describe(entries: SelectorEntryList): string {
    return entries.map((entry) => entry.id ? `#${entry.id}` : `"${entry.text ?? ''}"`).join(', ');
}

/** ok when confirmed, warn while it is still a guess, blank when it is a built-in nobody flagged. */
function statusCell(row: SelectorStatus): string {
    if (row.override) {
        const who = `${row.override.confirmedBy} · ${row.override.confirmedAt.slice(0, 10)}`;
        return `<span class="bl-state"><span class="bl-dot ok"></span>${escapeHtml(describe([row.override.entry]))}</span>`
            + `<div class="bl-faint">${escapeHtml(who)}${row.override.note ? ` · ${escapeHtml(row.override.note)}` : ''}</div>`;
    }
    if (row.guess) return '<span class="bl-state"><span class="bl-dot warn"></span>unverified</span>';
    return '<span class="bl-faint">built-in</span>';
}

export interface SelectorPanelInput {
    udid: string;
    /** Whether the calibrate task can be offered at all — false when the agent plugin is not loaded. */
    agentAvailable: boolean;
    groups: ReadonlyArray<{
        plugin: string;
        network: string;
        flow: string;
        rows: readonly SelectorStatus[];
    }>;
}

export function renderSelectorsPanel(input: SelectorPanelInput): string {
    const sections = input.groups.map((group) => {
        const unverified = group.rows.filter((row) => row.guess && !row.override).length;
        const rows = group.rows.map((row) => `<tr>
<td>${escapeHtml(row.name)}</td>
<td class="bl-faint">${escapeHtml(describe(row.builtIn))}</td>
<td>${statusCell(row)}</td></tr>`).join('');
        const button = input.agentAvailable
            ? `<button type="button" class="bl-btn bl-btn-sm" data-calibrate data-plugin="${escapeHtml(group.plugin)}"
 data-flow="${escapeHtml(group.flow)}" data-udid="${escapeHtml(input.udid)}">Calibrate with agent</button>`
            : '<span class="bl-faint">The calibration agent plugin is not loaded</span>';
        return `<div class="bl-selector-group">
<div class="bl-panel-head">${escapeHtml(group.network)} · ${escapeHtml(group.flow)}<span class="bl-spacer"></span>
<span class="bl-chip bl-chip-sm">${unverified} unverified</span>${button}</div>
<table class="bl-table"><thead><tr><th>Control</th><th>Built-in alternates</th><th>Confirmed</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
    }).join('');
    return `<section class="bl-panel" id="selectors">
<div class="bl-panel-head">Selectors</div>
<div class="bl-panel-body">
<p class="bl-muted">What each Android routine looks for on this phone. An unverified control is a guess that
nobody has checked against a real device; calibrating sends a cheap agent through the flow to confirm it.</p>
${sections || '<p class="bl-muted">No Android routines have selector tables for this phone.</p>'}
<p class="bl-muted" id="calibrate-result" aria-live="polite"></p>
</div></section>`;
}

/** Everything the panel needs, read for one device. */
export async function selectorPanelInput(
    udid: string, plugins: readonly string[], agentAvailable: boolean, overridesPath?: string,
): Promise<SelectorPanelInput> {
    const groups: SelectorPanelInput['groups'] = [];
    for (const plugin of plugins) {
        const all = await selectorStatuses(plugin, udid, overridesPath);
        for (const flow of flowsForPlugin(plugin)) {
            const rows = all.filter((row) => row.flow === flow.flow);
            if (rows.length) (groups as Array<SelectorPanelInput['groups'][number]>).push({
                plugin, network: flow.network, flow: flow.flow, rows,
            });
        }
    }
    return { udid, agentAvailable, groups };
}
