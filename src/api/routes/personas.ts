/**
 * The persona editor on the Accounts page, and the three routes behind it.
 *
 * One panel per account: who this handle is (niche, interests, what it avoids), how it behaves
 * (warmth, curiosity, budgets, watch bands, active hours), and — read-only, from the memory file —
 * what it has actually been doing. Everything swaps through htmx, so the page needs no script of
 * its own; the form posts, the panel comes back rendered, and the operator sees what was stored
 * rather than what they typed.
 *
 * The body is a whitelist. Only the fields named in `personaFromForm` are read, and each one goes
 * through `validatePersona` before it can reach the store, so a hand-crafted POST can neither add
 * keys nor set a budget of ten thousand likes.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { escapeHtml } from '../../ui/shell.js';
import { icon } from '../../ui/icons.js';
import {
    LANGUAGES, PersonaError, defaultPersona, deletePersona, loadPersonas, normaliseHandle, savePersona,
    type Persona,
} from '../../persona/model.js';
import { readMemory, summariseMemory, type MemorySummary } from '../../persona/memory.js';
import { PERSONA_PRESETS, applyPreset, findPreset } from '../../persona/presets.js';
import { NETWORK_IDS, networkLabel, type NetworkId } from '../../content/networks.js';
import { parseCreatorAccountInput, parseCreatorInput } from '../../content/validate.js';
import type { ContentStore } from '../../content/store.js';
import type { CreatorAccountRow, CreatorRow } from '../../database/schema.js';

export interface PersonaRouteOptions {
    /** Overrides SCHEDULER_DATA_DIR; tests point it at a temporary directory. */
    dataDirectory?: string;
    /**
     * The content store, if this process has a database. Creators live in
     * Postgres while personas live on disk, so the Accounts page needs both and
     * has to keep working with only one of them.
     */
    store?: () => ContentStore | null;
    /** The phones a creator can be pinned to, for the picker. */
    loadDevices?: () => Promise<ReadonlyArray<{ udid: string; name: string }>>;
}

/* ---- Reading the form -------------------------------------------------- */

type FormBody = Record<string, unknown>;

function text(body: FormBody, name: string): string | undefined {
    const value = body[name];
    return typeof value === 'string' ? value : undefined;
}

/** A `{min,max}` pair from two form fields, or undefined when neither was sent. */
function pair(body: FormBody, minName: string, maxName: string): { min: unknown; max: unknown } | undefined {
    const min = text(body, minName);
    const max = text(body, maxName);
    if (min === undefined && max === undefined) return undefined;
    return { min: min === undefined ? undefined : Number(min), max: max === undefined ? undefined : Number(max) };
}

/** The whitelist. Anything else in the body is ignored. */
export function personaFromForm(body: FormBody): Record<string, unknown> {
    return {
        niche: text(body, 'niche'),
        interests: text(body, 'interests'),
        avoid: text(body, 'avoid'),
        language: text(body, 'language'),
        warmth: text(body, 'warmth'),
        curiosity: text(body, 'curiosity'),
        activeHours: text(body, 'activeHours'),
        budgets: {
            likes: pair(body, 'likesMin', 'likesMax'),
            saves: pair(body, 'savesMin', 'savesMax'),
            follows: pair(body, 'followsMin', 'followsMax'),
            searches: pair(body, 'searchesMin', 'searchesMax'),
        },
        watch: {
            match: pair(body, 'watchMatchMin', 'watchMatchMax'),
            other: pair(body, 'watchOtherMin', 'watchOtherMax'),
        },
        sessionMinutes: pair(body, 'sessionMin', 'sessionMax'),
        followRule: { likes: text(body, 'followLikes'), withinSessions: text(body, 'followSessions') },
    };
}

/* ---- Rendering --------------------------------------------------------- */

export interface PanelState {
    /** True when this persona was configured rather than derived from the handle. */
    stored: boolean;
    /** A sentence under the panel head: what just happened, or what went wrong. */
    note?: string;
    tone?: 'ok' | 'bad';
    /**
     * The preset the form in front of the operator was filled from. Nothing has been saved: the
     * panel is showing what pressing Save would store, which is the point of "Apply".
     */
    preset?: string;
}

function field(label: string, control: string, hint = ''): string {
    return `<label class="bl-field"><span>${escapeHtml(label)}</span>${control}`
        + `${hint ? `<span class="bl-faint">${escapeHtml(hint)}</span>` : ''}</label>`;
}

function number(name: string, value: number, min: number, max: number, step = 1): string {
    return `<input class="bl-input" type="number" name="${name}" value="${value}" min="${min}" max="${max}" step="${step}">`;
}

function rangeRow(label: string, name: string, value: { min: number; max: number }, bounds: { min: number; max: number }, unit: string): string {
    return `<div class="bl-persona-range"><span>${escapeHtml(label)}</span>`
        + number(`${name}Min`, value.min, bounds.min, bounds.max)
        + '<span class="bl-faint">to</span>'
        + number(`${name}Max`, value.max, bounds.min, bounds.max)
        + `<span class="bl-faint">${escapeHtml(unit)}</span></div>`;
}

function slider(label: string, name: string, value: number, hint: string): string {
    // The readout is a plain <output> nudged by the range itself, so the panel needs no script.
    return `<label class="bl-field"><span>${escapeHtml(label)}</span>
<span class="bl-persona-slider"><input class="bl-slider" type="range" name="${name}" min="0" max="1" step="0.05" value="${value}"
 oninput="this.nextElementSibling.value = this.value"><output>${value}</output></span>
<span class="bl-faint">${escapeHtml(hint)}</span></label>`;
}

function hoursText(persona: Persona): string {
    return persona.activeHours.map(({ start, end }) =>
        `${String(start).padStart(2, '0')}-${String(end).padStart(2, '0')}`).join(', ');
}

/** The read-only half: what this account has actually been doing, from its memory file. */
export function renderMemorySummary(summary: MemorySummary): string {
    const favourites = summary.favourites.length
        ? summary.favourites.map(({ creator, likes }) =>
            `<span class="bl-chip bl-chip-sm">${escapeHtml(creator)} · ${likes}</span>`).join('')
        : '<span class="bl-faint">nobody yet</span>';
    const followed = summary.followed.length
        ? summary.followed.slice(0, 8).map((creator) => `<span class="bl-chip bl-chip-sm">${escapeHtml(creator)}</span>`).join('')
        : '<span class="bl-faint">nobody yet</span>';
    const matched = summary.matched.length
        ? summary.matched.map((term) => `<span class="bl-chip bl-chip-sm">${escapeHtml(term)}</span>`).join('')
        : '<span class="bl-faint">nothing yet</span>';
    const sessions = summary.recent.length
        ? `<div class="bl-rows">${summary.recent.map((session) => `<div><span>${escapeHtml(String(session.startedAt).slice(0, 16).replace('T', ' '))}</span>`
            + `<span>${session.videos} videos · ${session.likes} likes · ${session.saves} saves · ${session.follows} follows · ${session.searches} searches</span></div>`).join('')}</div>`
        : '';
    return `<p class="bl-muted">${escapeHtml(summary.headline)}</p>
<div class="bl-rows"><div><span>Keeps liking</span><span class="bl-chip-row">${favourites}</span></div>
<div><span>Following</span><span class="bl-chip-row">${followed}</span></div>
<div><span>What matched</span><span class="bl-chip-row">${matched}</span></div></div>${sessions}`;
}

/** The select behind "Start from a preset", for an account that already has values in the form. */
function presetChooser(action: string, chosen?: string): string {
    const options = PERSONA_PRESETS.map((preset) =>
        `<option value="${escapeHtml(preset.id)}"${preset.id === chosen ? ' selected' : ''}>${escapeHtml(preset.label)}</option>`).join('');
    return `<form class="bl-persona-presets" hx-get="${action}" hx-target="closest section" hx-swap="outerHTML">
<label class="bl-field"><span>Start from a preset</span>
<select class="bl-select" name="preset">${options}</select></label>
<button class="bl-btn" type="submit">Apply</button>
<span class="bl-faint">Fills the form in. Nothing is stored until you press Save persona.</span></form>`;
}

/**
 * What an account with no persona sees instead of twenty empty fields: the niches, one line each,
 * one press to fill the form in with one. The blank form is still there, folded away.
 */
function presetPicker(action: string): string {
    const cards = PERSONA_PRESETS.map((preset) => `<button class="bl-btn bl-persona-preset" type="submit" name="preset"
 value="${escapeHtml(preset.id)}"><strong>${escapeHtml(preset.label)}</strong>
<span class="bl-faint">${escapeHtml(preset.description)}</span></button>`).join('');
    return `<p class="bl-muted">Start from a preset — pick the one closest to this account and adjust it.</p>
<form class="bl-persona-picker" hx-get="${action}" hx-target="closest section" hx-swap="outerHTML">${cards}</form>`;
}

export function renderPersonaPanel(persona: Persona, summary: MemorySummary, state: PanelState): string {
    const action = `/accounts/${encodeURIComponent(persona.handle)}/persona`;
    const chips = persona.interests.map((interest) =>
        `<span class="bl-chip bl-chip-sm">${escapeHtml(interest)}</span>`).join('');
    const note = state.note
        ? `<p class="bl-muted${state.tone === 'bad' ? ' bl-persona-bad' : ''}" role="status">${escapeHtml(state.note)}</p>`
        : `<p class="bl-muted">${state.stored ? 'This persona is set up.' : 'No persona set up yet — these values are derived from the handle.'}</p>`;
    // Nothing has been stored yet and nothing has been picked: offer the niches, not a blank form.
    const picking = !state.stored && !state.preset;
    const languages = LANGUAGES.map((code) =>
        `<option value="${code}"${code === persona.language ? ' selected' : ''}>${code}</option>`).join('');

    return `<section class="bl-panel" id="persona-${escapeHtml(persona.handle.replace(/[^A-Za-z0-9]/g, '-'))}">
<div class="bl-panel-head">${escapeHtml(persona.handle)}<span class="bl-spacer"></span>
<span class="bl-chip bl-chip-sm">${escapeHtml(persona.niche)}</span></div>
<div class="bl-panel-body">
${note}
<div class="bl-chip-row">${chips}</div>
${picking ? presetPicker(action) : presetChooser(action, state.preset)}
${picking ? '<details class="bl-persona-byhand"><summary>Or fill it in by hand</summary>' : ''}
<form hx-post="${action}" hx-target="closest section" hx-swap="outerHTML" class="bl-persona-form">
${field('Niche', `<input class="bl-input" type="text" name="niche" value="${escapeHtml(persona.niche)}" maxlength="40">`,
        'A short name for what this account is into.')}
${field('Interests', `<input class="bl-input" type="text" name="interests" value="${escapeHtml(persona.interests.join(', '))}">`,
        'Keywords and hashtags, separated by commas. Content that hits one of these gets watched right through.')}
${field('Avoid', `<input class="bl-input" type="text" name="avoid" value="${escapeHtml(persona.avoid.join(', '))}">`,
        'Anything here is scrolled past on sight, and never liked.')}
${field('Language', `<select class="bl-select" name="language">${languages}</select>`)}
${slider('Warmth', 'warmth', persona.warmth, 'How willing it is to like something it enjoyed.')}
${slider('Curiosity', 'curiosity', persona.curiosity, 'How often it lingers on something outside its niche.')}
<div class="bl-persona-grid">
${rangeRow('Likes', 'likes', persona.budgets.likes, { min: 0, max: 200 }, 'per session')}
${rangeRow('Saves', 'saves', persona.budgets.saves, { min: 0, max: 200 }, 'per session')}
${rangeRow('Follows', 'follows', persona.budgets.follows, { min: 0, max: 200 }, 'per session')}
${rangeRow('Searches', 'searches', persona.budgets.searches, { min: 0, max: 200 }, 'per session')}
${rangeRow('Watches a match', 'watchMatch', persona.watch.match, { min: 1, max: 600 }, 'seconds')}
${rangeRow('Watches the rest', 'watchOther', persona.watch.other, { min: 1, max: 600 }, 'seconds')}
${rangeRow('Session length', 'session', persona.sessionMinutes, { min: 1, max: 180 }, 'minutes')}
</div>
${field('Awake between', `<input class="bl-input" type="text" name="activeHours" value="${escapeHtml(hoursText(persona))}">`,
        'Local hours, written as 08-23. A run outside these hours does not scroll.')}
<div class="bl-persona-range"><span>Follows a creator after</span>
${number('followLikes', persona.followRule.likes, 1, 20)}<span class="bl-faint">likes within</span>
${number('followSessions', persona.followRule.withinSessions, 1, 30)}<span class="bl-faint">sessions</span></div>
<div class="bl-btn-row"><button type="submit" class="bl-btn bl-btn-primary">${icon('check')}Save persona</button>
${state.stored ? `<button type="button" class="bl-btn" hx-delete="${action}" hx-target="closest section" hx-swap="outerHTML">Reset to the default</button>` : ''}</div>
</form>
${picking ? '</details>' : ''}
<div class="bl-persona-memory"><div class="bl-panel-head">What it did lately</div>
${renderMemorySummary(summary)}</div>
</div></section>`;
}

/**
 * The section the Accounts page drops in. Each panel loads itself, so a farm with forty accounts
 * does not read forty memory files to draw one page.
 */
export function renderPersonaSection(handles: readonly string[]): string {
    if (!handles.length) return '';
    const panels = handles.map((handle) => {
        const url = `/accounts/${encodeURIComponent(handle)}/persona`;
        return `<div hx-get="${url}" hx-trigger="load" hx-swap="outerHTML">`
            + `<section class="bl-panel"><div class="bl-panel-head">${escapeHtml(handle)}</div>`
            + '<div class="bl-panel-body"><p class="bl-faint">Reading the persona…</p></div></section></div>';
    }).join('');
    return `<div class="bl-page" id="personas"><h2 class="bl-persona-heading">Personas</h2>
<p class="bl-muted">A persona is who an account behaves like: what it watches right through, what it
scrolls past, and how much it engages in one sitting. Every handle has one — a stored persona, or
one derived from the handle until you set it up. <a href="/docs/personas">How personas work</a>.</p>${panels}</div>`;
}

/* ---- Routes ------------------------------------------------------------ */

const PERSONA_STYLE = `<style>
.bl-persona-heading { font-size: 14px; font-weight: 600; margin: 20px 0 6px; }
.bl-persona-form { display: grid; gap: 12px; margin-top: 12px; }
.bl-persona-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; }
.bl-persona-range { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.bl-persona-range > span:first-child { color: var(--bl-text-3); min-width: 140px; }
.bl-persona-range input { width: 74px; }
.bl-persona-slider { display: flex; align-items: center; gap: 10px; }
.bl-persona-slider output { color: var(--bl-text-3); font-size: 12.5px; min-width: 30px; }
.bl-persona-memory { margin-top: 16px; border-top: 1px solid var(--bl-line); padding-top: 12px; }
.bl-persona-bad { color: var(--bl-bad); }
.bl-persona-presets { align-items: end; display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.bl-persona-picker { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin: 10px 0 14px; }
.bl-persona-preset { display: block; height: auto; padding: 8px 10px; text-align: left; }
.bl-persona-preset strong { display: block; font-size: 12.5px; }
.bl-persona-preset span { display: block; font-weight: 400; white-space: normal; }
.bl-persona-byhand { margin-top: 4px; }
</style>`;

/** The markup the Accounts page appends to its `<head>`. */
export function personaHead(): string {
    return PERSONA_STYLE;
}

async function panelFor(handle: string, directory: string | undefined, state: Omit<PanelState, 'stored'>): Promise<string> {
    const key = normaliseHandle(handle);
    const personas = await loadPersonas(directory);
    // A chosen preset fills the form and is not stored; the stored persona is what is shown otherwise.
    const preset = findPreset(state.preset);
    const persona = preset ? applyPreset(key, preset.id) : personas[key] ?? defaultPersona(key);
    const summary = summariseMemory(await readMemory(key, directory));
    return renderPersonaPanel(persona, summary, {
        ...state,
        ...(preset ? { preset: preset.id, note: state.note ?? presetNote(preset.label), tone: state.tone ?? 'ok' } : {}),
        stored: Object.hasOwn(personas, key),
    });
}

function presetNote(label: string): string {
    return `Filled in from the ${label} preset — press Save persona to keep it.`;
}

/** `reply.type` is set before the body is built, so the JSON error resets it or Fastify refuses it. */
function badHandle(reply: FastifyReply, error: unknown): FastifyReply {
    return reply.code(400).type('application/json')
        .send(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}

/* ---- creators ---------------------------------------------------------- */

/**
 * A creator is a person and their phone: three TikToks, three Instagrams and
 * three YouTube channels signed in on one handset. The per-device handle list is
 * untouched and still what the phone's account switcher reads — these rows are
 * the addition that says which network a handle is on and whose it is, which is
 * what a cross-posting drip rule needs to know.
 */
export function renderCreators(
    creators: ReadonlyArray<CreatorRow & { accounts: CreatorAccountRow[] }>,
    devices: ReadonlyArray<{ udid: string; name: string }>,
    note?: string,
): string {
    const deviceOptions = devices.map(({ udid, name }) =>
        `<option value="${escapeHtml(udid)}">${escapeHtml(name)}</option>`).join('');
    const networkOptions = NETWORK_IDS.map((network) =>
        `<option value="${network}">${escapeHtml(networkLabel(network))}</option>`).join('');
    const byUdid = new Map(devices.map(({ udid, name }) => [udid, name]));
    const cards = creators.map((creator) => {
        const grouped = NETWORK_IDS.map((network) => {
            const handles = creator.accounts.filter((account) => account.network === network);
            if (!handles.length) return '';
            return `<div><span>${escapeHtml(networkLabel(network))}</span><span class="bl-chip-row">`
                + handles.map((account) => `<span class="bl-chip bl-chip-sm${account.enabled ? '' : ' bl-faint'}">`
                    + `${escapeHtml(account.handle)}`
                    + `<button type="button" class="bl-linkish" hx-delete="/accounts/creators/accounts/${escapeHtml(account.id)}"`
                    + ' hx-target="#creators" hx-swap="outerHTML" aria-label="Remove this account">×</button></span>').join('')
                + '</span></div>';
        }).join('');
        return `<section class="bl-panel"><div class="bl-panel-head">${escapeHtml(creator.name)}
<span class="bl-spacer"></span>
<span class="bl-chip bl-chip-sm">${escapeHtml(byUdid.get(creator.deviceUdid) ?? creator.deviceUdid)}</span>
<button type="button" class="bl-btn bl-btn-sm" hx-delete="/accounts/creators/${escapeHtml(creator.id)}"
 hx-confirm="Delete this creator? Their accounts go with them; rules pointing at them stop fanning out."
 hx-target="#creators" hx-swap="outerHTML">Delete</button></div>
<div class="bl-panel-body">
${creator.notes ? `<p class="bl-muted">${escapeHtml(creator.notes)}</p>` : ''}
<div class="bl-rows">${grouped || '<div><span class="bl-faint">No accounts yet.</span></div>'}</div>
<form class="bl-inline-form" hx-post="/accounts/creators/${escapeHtml(creator.id)}/accounts"
 hx-target="#creators" hx-swap="outerHTML">
<label class="bl-field"><span>Network</span><select class="bl-select" name="network">${networkOptions}</select></label>
<label class="bl-field"><span>Handle</span><input class="bl-input" type="text" name="handle" placeholder="@handle" required></label>
<button class="bl-btn" type="submit">Add account</button></form>
</div></section>`;
    }).join('');
    return `<div class="bl-page" id="creators">
<h2 class="bl-persona-heading">Creators</h2>
<p class="bl-muted">A creator is one person and one phone. Group their accounts here and a drip rule
can post each item to every one of them, staggered so no two copies land in the same minute.</p>
${note ? `<p class="bl-muted bl-persona-bad" role="status">${escapeHtml(note)}</p>` : ''}
<section class="bl-panel"><div class="bl-panel-head">New creator</div><div class="bl-panel-body">
<form class="bl-inline-form" hx-post="/accounts/creators" hx-target="#creators" hx-swap="outerHTML">
<label class="bl-field"><span>Name</span><input class="bl-input" type="text" name="name" placeholder="Mia" required></label>
<label class="bl-field"><span>Phone</span><select class="bl-select" name="deviceUdid" required>${deviceOptions}</select></label>
<label class="bl-field"><span>Notes</span><input class="bl-input" type="text" name="notes"></label>
<button class="bl-btn bl-btn-primary" type="submit">Create</button></form>
</div></section>
${cards}</div>`;
}

/** The placeholder the Accounts page drops in; it loads itself, like the persona panels. */
export function renderCreatorsSection(): string {
    return '<div id="creators" hx-get="/accounts/creators" hx-trigger="load" hx-swap="outerHTML">'
        + '<div class="bl-page"><p class="bl-faint">Reading creators…</p></div></div>';
}

export function registerPersonaRoutes(app: FastifyInstance, options: PersonaRouteOptions = {}): void {
    const directory = options.dataDirectory;
    const store = options.store ?? (() => null);
    const loadDevices = options.loadDevices ?? (async () => []);

    /**
     * The creators fragment, rendered from scratch after every change. It is one
     * small list; re-reading it is cheaper than keeping a client-side copy in
     * step, and it means a rejected form comes back as the list with the reason
     * on it rather than as a status code htmx will not swap.
     */
    const creatorsFragment = async (note?: string): Promise<string> => {
        const active = store();
        if (!active) {
            return '<div id="creators" class="bl-page"><p class="bl-muted">Creators need a database connection.</p></div>';
        }
        const [rows, accounts, devices] = await Promise.all([
            active.listCreators(), active.listCreatorAccounts(), loadDevices().catch(() => []),
        ]);
        return renderCreators(
            rows.map((creator) => ({
                ...creator, accounts: accounts.filter(({ creatorId }) => creatorId === creator.id),
            })),
            devices,
            note,
        );
    };
    const sendCreators = async (reply: FastifyReply, note?: string): Promise<FastifyReply> =>
        reply.type('text/html').send(await creatorsFragment(note));

    app.get('/accounts/creators', async (_request, reply) => sendCreators(reply));

    app.post<{ Body: FormBody }>('/accounts/creators', async (request, reply) => {
        const active = store();
        if (!active) return sendCreators(reply);
        try {
            await active.createCreator(parseCreatorInput(request.body ?? {}));
            return await sendCreators(reply);
        } catch (error) {
            return sendCreators(reply, error instanceof Error ? error.message : String(error));
        }
    });

    app.delete<{ Params: { id: string } }>('/accounts/creators/:id', async (request, reply) => {
        const active = store();
        if (active) await active.deleteCreator(request.params.id).catch(() => false);
        return sendCreators(reply);
    });

    app.post<{ Params: { id: string }; Body: FormBody }>('/accounts/creators/:id/accounts', async (request, reply) => {
        const active = store();
        if (!active) return sendCreators(reply);
        try {
            const input = parseCreatorAccountInput(request.body ?? {});
            await active.createCreatorAccount({ creatorId: request.params.id, ...input });
            return await sendCreators(reply);
        } catch (error) {
            return sendCreators(reply, error instanceof Error ? error.message : String(error));
        }
    });

    app.delete<{ Params: { id: string } }>('/accounts/creators/accounts/:id', async (request, reply) => {
        const active = store();
        if (active) await active.deleteCreatorAccount(request.params.id).catch(() => false);
        return sendCreators(reply);
    });

    app.get<{ Params: { handle: string }; Querystring: { preset?: string } }>('/accounts/:handle/persona', async (request, reply) => {
        try {
            // `preset` is a whitelist lookup, not a value: an unknown one falls back to the panel
            // as it was, rather than being reported as an error nobody asked a question to get.
            const preset = findPreset(request.query.preset)?.id;
            const html = await panelFor(request.params.handle, directory, { ...(preset ? { preset } : {}) });
            return reply.type('text/html').send(html);
        } catch (error) {
            return badHandle(reply, error);
        }
    });

    app.post<{ Params: { handle: string }; Body: FormBody }>('/accounts/:handle/persona', async (request, reply) => {
        let handle: string;
        try {
            handle = normaliseHandle(request.params.handle);
        } catch (error) {
            return badHandle(reply, error);
        }
        try {
            const persona = await savePersona(handle, personaFromForm(request.body ?? {}), directory);
            const html = await panelFor(persona.handle, directory, { note: 'Saved.', tone: 'ok' });
            return reply.type('text/html').send(html);
        } catch (error) {
            // A rejected edit must come back as the panel with the reason on it, not as a 400 htmx
            // will not swap — the operator would be left looking at their own unsaved form.
            const note = error instanceof PersonaError ? error.message : 'That persona could not be saved.';
            const html = await panelFor(handle, directory, { note, tone: 'bad' });
            return reply.type('text/html').send(html);
        }
    });

    /**
     * The same "start from a preset", server-side and in one call: applies it and stores it. The
     * body is one whitelisted field, and the value has to be one of the shipped preset ids.
     */
    app.post<{ Params: { handle: string }; Body: { preset?: unknown } }>('/api/accounts/:handle/persona/preset', async (request, reply) => {
        try {
            const handle = normaliseHandle(request.params.handle);
            const persona = applyPreset(handle, (request.body ?? {}).preset);
            return reply.send(await savePersona(handle, persona as unknown as Record<string, unknown>, directory));
        } catch (error) {
            return badHandle(reply, error);
        }
    });

    /** What the picker offers, for anything that wants to build its own. */
    app.get('/api/persona-presets', async () => ({
        presets: PERSONA_PRESETS.map(({ id, label, description }) => ({ id, label, description })),
    }));

    app.delete<{ Params: { handle: string } }>('/accounts/:handle/persona', async (request, reply) => {
        try {
            const handle = normaliseHandle(request.params.handle);
            await deletePersona(handle, directory);
            const html = await panelFor(handle, directory, {
                note: 'Reset — this account is back to the persona derived from its handle.', tone: 'ok',
            });
            return reply.type('text/html').send(html);
        } catch (error) {
            return badHandle(reply, error);
        }
    });
}
