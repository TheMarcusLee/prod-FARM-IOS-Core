/**
 * Products, and the recommendation panel above the personas.
 *
 * The operator writes what they are promoting in plain words. Backline answers with the presets
 * the promoting accounts should run — instantly from the local ranker, or from the agent when they
 * ask for it — and applies the answer to an account, or to every account a creator owns, in one
 * press. What lands is an ordinary persona: the same blend the picker makes, plus the words the
 * presets did not cover.
 *
 * Everything swaps through htmx, like the persona editor beside it, so the section needs no script:
 * every button is a form submit and the server re-renders the list. The two rules that matter:
 *
 * - **the agent is never called on a render.** `GET /accounts/products` reads the store and shows
 *   whatever the last recommendation was. Only a POST — an operator pressing "Ask the agent" —
 *   spawns anything.
 * - **the operator sees the shortlist before it lands.** Presets arrive as ticked checkboxes and
 *   the extra interests as an editable field, so applying is always a choice rather than an answer.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { escapeHtml } from '../../ui/shell.js';
import { icon } from '../../ui/icons.js';
import { AGY_INSTALL_COMMAND, createAgyRunner, type AgentRunner } from '../../agent/runner.js';
import { networkLabel, type NetworkId } from '../../content/networks.js';
import type { ContentStore } from '../../content/store.js';
import { loadPersonas, normaliseHandle, savePersona, type Persona } from '../../persona/model.js';
import { recommendLocally, type Recommendation } from '../../persona/recommend.js';
import { agentUnavailable, recommendWithAgent } from '../../persona/recommend-agent.js';
import {
    ProductError, applyError, createProduct, deleteProduct, loadProducts,
    personaForProduct, readProduct, updateProduct, type Product,
} from '../../persona/products.js';

export interface ProductRouteOptions {
    /** Overrides SCHEDULER_DATA_DIR; tests point it at a temporary directory. */
    dataDirectory?: string;
    /** The content store, when this process has a database. Creators come from it. */
    store?: () => ContentStore | null;
    /** Injected in tests. Defaults to the Antigravity CLI, like the calibrate job. */
    runner?: AgentRunner;
}

type FormBody = Record<string, unknown>;

function text(body: FormBody, name: string): string | undefined {
    const value = body[name];
    if (typeof value === 'string') return value;
    return value === undefined || value === null ? undefined : String(value);
}

/** A repeated form field (`presets` on every ticked checkbox) as a list. */
function list(body: FormBody, name: string): string[] {
    const value = body[name];
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
    return typeof value === 'string' ? [value] : [];
}

/** The whitelist for a product form. Anything else in the body is ignored. */
export function productFromForm(body: FormBody): Record<string, unknown> {
    return {
        name: text(body, 'name'),
        description: text(body, 'description'),
        url: text(body, 'url'),
        audience: text(body, 'audience'),
    };
}

/* ---- Rendering --------------------------------------------------------- */

export interface ProductsView {
    products: readonly Product[];
    /** Handles that already have a stored persona, for the apply picker. */
    handles: readonly string[];
    /** Which handles are already promoting which product. */
    promoting: Readonly<Record<string, string[]>>;
    creators: ReadonlyArray<{ id: string; name: string; accounts: number }>;
    /** Undefined when the Antigravity CLI is installed; the reason when it is not. */
    agentMissing?: string;
    note?: string;
    tone?: 'ok' | 'bad';
}

function chip(term: string): string {
    return `<span class="bl-chip bl-chip-sm">${escapeHtml(term)}</span>`;
}

function sourceLine(recommendation: Recommendation): string {
    const when = recommendation.createdAt.slice(0, 16).replace('T', ' ');
    const from = recommendation.source === 'agent' ? 'the agent' : 'the local ranker';
    return `${from} · ${when}`;
}

/** The shortlist, grouped by category, every preset a ticked checkbox with its reason under it. */
function renderPicks(recommendation: Recommendation): string {
    const groups = new Map<string, Recommendation['presets']>();
    for (const preset of recommendation.presets) {
        const category = preset.category || 'Suggested';
        groups.set(category, [...(groups.get(category) ?? []), preset]);
    }
    if (!groups.size) return '<p class="bl-muted">Nothing in the library is close to that description yet.</p>';
    return [...groups.entries()].map(([category, presets]) => `<div class="bl-product-group">
<div class="bl-product-group-head">${escapeHtml(category)}</div>
${presets.map((preset) => `<label class="bl-product-pick">
<input type="checkbox" name="presets" value="${escapeHtml(preset.id)}" checked>
<span><strong>${escapeHtml(preset.label)}</strong>
<span class="bl-faint">${escapeHtml(preset.why)}${preset.score === undefined ? '' : ` · score ${preset.score}`}</span></span></label>`).join('')}
</div>`).join('');
}

function renderRecommendation(product: Product, view: ProductsView): string {
    const recommendation = product.recommendation;
    if (!recommendation) {
        return '<p class="bl-muted">No recommendation yet — press Recommend for the instant one, or ask the agent.</p>';
    }
    const networks = recommendation.networks.length
        ? recommendation.networks.map((network: NetworkId) => chip(networkLabel(network))).join('')
        : '<span class="bl-faint">no preference</span>';
    const handles = view.handles.map((handle) => `<option value="${escapeHtml(handle)}"></option>`).join('');
    const creators = view.creators.map(({ id, name, accounts }) =>
        `<option value="${escapeHtml(id)}">${escapeHtml(name)} · ${accounts} account${accounts === 1 ? '' : 's'}</option>`).join('');
    const action = `/accounts/products/${encodeURIComponent(product.id)}`;

    return `<p class="bl-faint">Recommended by ${escapeHtml(sourceLine(recommendation))}</p>
${recommendation.note ? `<p class="bl-muted">${escapeHtml(recommendation.note)}</p>` : ''}
${recommendation.audienceSummary ? `<p class="bl-muted">${escapeHtml(recommendation.audienceSummary)}</p>` : ''}
<form class="bl-product-apply" hx-post="${action}/apply" hx-target="#products" hx-swap="outerHTML">
${renderPicks(recommendation)}
<label class="bl-field"><span>Extra interests</span>
<input class="bl-input" type="text" name="extraInterests" value="${escapeHtml(recommendation.extraInterests.join(', '))}">
<span class="bl-faint">Words the presets do not cover — the brand, the product, its features. Edit them freely.</span></label>
<label class="bl-field"><span>Avoid</span>
<input class="bl-input" type="text" name="avoid" value="${escapeHtml(recommendation.avoid.join(', '))}">
<span class="bl-faint">Anything here is scrolled past on sight by the accounts you apply this to.</span></label>
<div class="bl-rows"><div><span>Suggested networks</span><span class="bl-chip-row">${networks}</span></div></div>
<div class="bl-product-applyrow">
<label class="bl-field"><span>Account</span>
<input class="bl-input" type="text" name="handle" list="product-handles-${escapeHtml(product.id)}" placeholder="@handle">
<datalist id="product-handles-${escapeHtml(product.id)}">${handles}</datalist></label>
<button type="submit" class="bl-btn bl-btn-primary">${icon('check')}Apply to account</button>
</div>
${creators ? `<div class="bl-product-applyrow">
<label class="bl-field"><span>Creator</span>
<select class="bl-select" name="creatorId"><option value="">—</option>${creators}</select></label>
<button type="button" class="bl-btn" hx-post="${action}/apply-creator" hx-include="closest form"
 hx-target="#products" hx-swap="outerHTML">Apply to every account of a creator</button></div>`
        : '<p class="bl-faint">Creators need a database connection.</p>'}
</form>`;
}

function renderProductCard(product: Product, view: ProductsView): string {
    const action = `/accounts/products/${encodeURIComponent(product.id)}`;
    const promoting = view.promoting[product.id] ?? [];
    const agentButton = view.agentMissing
        ? `<button type="submit" class="bl-btn" name="useAgent" value="1" disabled
 title="${escapeHtml(view.agentMissing)}">Ask the agent</button>`
        : `<button type="submit" class="bl-btn" name="useAgent" value="1">${icon('bolt')}Ask the agent</button>`;
    return `<section class="bl-panel" id="product-${escapeHtml(product.id)}">
<div class="bl-panel-head">${escapeHtml(product.name)}<span class="bl-spacer"></span>
${promoting.length ? `<span class="bl-chip bl-chip-sm">${promoting.length} account${promoting.length === 1 ? '' : 's'}</span>` : ''}
<button type="button" class="bl-btn bl-btn-sm" hx-delete="${action}"
 hx-confirm="Delete this product? The personas already applied from it are left alone."
 hx-target="#products" hx-swap="outerHTML">Delete</button></div>
<div class="bl-panel-body">
<form class="bl-product-form" hx-post="${action}" hx-target="#products" hx-swap="outerHTML">
<label class="bl-field"><span>Name</span>
<input class="bl-input" type="text" name="name" value="${escapeHtml(product.name)}" maxlength="80" required></label>
<label class="bl-field"><span>Description</span>
<textarea class="bl-input bl-product-text" name="description" rows="4" maxlength="2000" required>${escapeHtml(product.description)}</textarea>
<span class="bl-faint">What it is, what it does, who it is for. This is what everything is matched against.</span></label>
<div class="bl-product-grid">
<label class="bl-field"><span>URL</span>
<input class="bl-input" type="url" name="url" value="${escapeHtml(product.url ?? '')}" maxlength="500"></label>
<label class="bl-field"><span>Audience</span>
<input class="bl-input" type="text" name="audience" value="${escapeHtml(product.audience ?? '')}" maxlength="500"></label>
</div>
<div class="bl-btn-row"><button type="submit" class="bl-btn">${icon('check')}Save</button></div>
</form>
<form class="bl-product-ask" hx-post="${action}/recommend" hx-target="#products" hx-swap="outerHTML">
<div class="bl-btn-row"><button type="submit" class="bl-btn bl-btn-primary">${icon('search')}Recommend</button>
${agentButton}</div>
<p class="bl-faint">Recommend ranks the hundred presets against your words and answers at once. The agent
reads the description instead and says why, which costs one Gemini Flash call.</p>
</form>
<div class="bl-product-result">${renderRecommendation(product, view)}</div>
${promoting.length ? `<div class="bl-rows"><div><span>Already promoting</span>
<span class="bl-chip-row">${promoting.map((handle) => chip(handle)).join('')}</span></div></div>` : ''}
</div></section>`;
}

export function renderProducts(view: ProductsView): string {
    const cards = view.products.map((product) => renderProductCard(product, view)).join('');
    return `<div class="bl-page" id="products">
<h2 class="bl-persona-heading">Products</h2>
<p class="bl-muted">What this farm is promoting. Describe it in your own words and Backline picks the
personas whose feed it belongs in, then applies them to an account or to everything a creator owns.
<a href="/docs/personas">How personas work</a>.</p>
${view.note ? `<p class="bl-muted${view.tone === 'bad' ? ' bl-persona-bad' : ''}" role="status">${escapeHtml(view.note)}</p>` : ''}
<section class="bl-panel"><div class="bl-panel-head">New product</div><div class="bl-panel-body">
<form class="bl-product-form" hx-post="/accounts/products" hx-target="#products" hx-swap="outerHTML">
<label class="bl-field"><span>Name</span>
<input class="bl-input" type="text" name="name" placeholder="Reflect" maxlength="80" required></label>
<label class="bl-field"><span>Description</span>
<textarea class="bl-input bl-product-text" name="description" rows="3" maxlength="2000" required
 placeholder="A note-taking app that turns your meetings into notes and to-dos."></textarea></label>
<div class="bl-product-grid">
<label class="bl-field"><span>URL</span><input class="bl-input" type="url" name="url" maxlength="500"></label>
<label class="bl-field"><span>Audience</span><input class="bl-input" type="text" name="audience" maxlength="500"
 placeholder="Students and knowledge workers"></label></div>
<div class="bl-btn-row"><button type="submit" class="bl-btn bl-btn-primary">${icon('plus')}Add product</button></div>
</form></div></section>
${cards}</div>`;
}

/** The placeholder the Accounts page drops in; it loads itself, like the persona panels. */
export function renderProductsSection(): string {
    return '<div id="products" hx-get="/accounts/products" hx-trigger="load" hx-swap="outerHTML">'
        + '<div class="bl-page"><p class="bl-faint">Reading products…</p></div></div>';
}

export const PRODUCT_STYLE = `<style>
.bl-product-form { display: grid; gap: 12px; }
.bl-product-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.bl-product-text { font-family: inherit; line-height: 1.45; resize: vertical; }
.bl-product-ask { border-top: 1px solid var(--bl-line); margin-top: 14px; padding-top: 12px; }
.bl-product-result { border-top: 1px solid var(--bl-line); margin-top: 14px; padding-top: 12px; }
.bl-product-apply { display: grid; gap: 12px; }
.bl-product-group-head { color: var(--bl-text-3); font-size: 11.5px; font-weight: 600; letter-spacing: .04em;
 text-transform: uppercase; margin-top: 8px; }
.bl-product-pick { align-items: flex-start; display: flex; gap: 8px; font-size: 12.5px; padding: 4px 0; }
.bl-product-pick strong { display: block; font-size: 12.5px; }
.bl-product-pick span span { display: block; font-weight: 400; white-space: normal; }
.bl-product-applyrow { align-items: flex-end; display: flex; flex-wrap: wrap; gap: 10px; }
.bl-product-applyrow .bl-field { min-width: 220px; }
</style>`;

export function productsHead(): string {
    return PRODUCT_STYLE;
}

/* ---- Routes ------------------------------------------------------------ */

/** Which stored personas were built from which product, for the "already promoting" chips. */
function promotingMap(personas: Readonly<Record<string, Persona>>): Record<string, string[]> {
    const promoting: Record<string, string[]> = {};
    for (const persona of Object.values(personas)) {
        if (!persona.productId) continue;
        (promoting[persona.productId] ??= []).push(persona.handle);
    }
    return promoting;
}

function anchorFor(handle: string): string {
    return `/accounts#persona-${handle.replace(/[^A-Za-z0-9]/g, '-')}`;
}

export function registerProductRoutes(app: FastifyInstance, options: ProductRouteOptions = {}): void {
    const directory = options.dataDirectory;
    const store = options.store ?? (() => null);
    const runner = options.runner ?? createAgyRunner();

    const creatorList = async (): Promise<ProductsView['creators']> => {
        const active = store();
        if (!active) return [];
        try {
            const [creators, accounts] = await Promise.all([active.listCreators(), active.listCreatorAccounts()]);
            return creators.map((creator) => ({
                id: creator.id, name: creator.name,
                accounts: accounts.filter((account) => account.creatorId === creator.id && account.enabled).length,
            }));
        } catch {
            return [];
        }
    };

    /**
     * The section, rendered from scratch after every change. `unavailable()` is the calibrate
     * job's own check and costs one stat call — it is what greys out "Ask the agent" — and it is
     * the only thing about the agent that happens on a render.
     */
    const fragment = async (state: Partial<ProductsView> = {}): Promise<string> => {
        const [products, personas, creators, agentMissing] = await Promise.all([
            loadProducts(directory),
            loadPersonas(directory),
            creatorList(),
            runner.unavailable().catch(() => 'The agent could not be checked.'),
        ]);
        return renderProducts({
            products, creators,
            handles: Object.keys(personas).sort(),
            promoting: promotingMap(personas),
            ...(agentMissing ? { agentMissing } : {}),
            ...state,
        });
    };

    const send = async (reply: FastifyReply, state: Partial<ProductsView> = {}): Promise<FastifyReply> =>
        reply.type('text/html').send(await fragment(state));

    const failed = (reply: FastifyReply, error: unknown, code = 400): FastifyReply =>
        reply.code(code).type('application/json')
            .send(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));

    /** One recommendation, stored on the product and returned. The only path that runs the agent. */
    const recommend = async (product: Product, useAgent: boolean): Promise<Product> => {
        const input = {
            name: product.name, description: product.description,
            ...(product.audience ? { audience: product.audience } : {}),
            ...(product.url ? { url: product.url } : {}),
        };
        const recommendation = useAgent
            ? await recommendWithAgent(input, { runner })
            : recommendLocally(input);
        return updateProduct(product.id, { recommendation }, directory);
    };

    /** Blends and stores one persona from a recommendation. Returns the handle it wrote. */
    const applyTo = async (product: Product, handle: string, body: FormBody): Promise<string> => {
        const recommendation = product.recommendation;
        if (!recommendation) throw new ProductError('Ask for a recommendation before applying it');
        // The ticked boxes, restricted to what was actually recommended: a hand-made POST cannot
        // apply presets nobody suggested, and unticking is how the operator narrows the blend.
        const offered = new Set(recommendation.presets.map(({ id }) => id));
        const chosen = list(body, 'presets').filter((id) => offered.has(id));
        if (!chosen.length) throw new ProductError('Tick at least one preset to apply');
        const persona = personaForProduct({
            handle,
            presets: chosen,
            extraInterests: (text(body, 'extraInterests') ?? recommendation.extraInterests.join(', ')).split(/[,\n]/),
            avoid: (text(body, 'avoid') ?? recommendation.avoid.join(', ')).split(/[,\n]/),
            productId: product.id,
        });
        await savePersona(persona.handle, persona as unknown as Record<string, unknown>, directory);
        return persona.handle;
    };

    app.get('/accounts/products', async (_request, reply) => send(reply));

    app.post<{ Body: FormBody }>('/accounts/products', async (request, reply) => {
        try {
            const product = await createProduct(productFromForm(request.body ?? {}), directory);
            return await send(reply, { note: `Added ${product.name}.`, tone: 'ok' });
        } catch (error) {
            return send(reply, { note: error instanceof Error ? error.message : String(error), tone: 'bad' });
        }
    });

    app.post<{ Params: { id: string }; Body: FormBody }>('/accounts/products/:id', async (request, reply) => {
        try {
            const product = await updateProduct(request.params.id, productFromForm(request.body ?? {}), directory);
            return await send(reply, { note: `Saved ${product.name}.`, tone: 'ok' });
        } catch (error) {
            return send(reply, { note: error instanceof Error ? error.message : String(error), tone: 'bad' });
        }
    });

    app.delete<{ Params: { id: string } }>('/accounts/products/:id', async (request, reply) => {
        await deleteProduct(request.params.id, directory).catch(() => false);
        return send(reply, { note: 'Deleted.', tone: 'ok' });
    });

    app.post<{ Params: { id: string }; Body: FormBody }>('/accounts/products/:id/recommend', async (request, reply) => {
        try {
            const product = await readProduct(request.params.id, directory);
            if (!product) throw new ProductError('That product no longer exists');
            const useAgent = Boolean(text(request.body ?? {}, 'useAgent'));
            const updated = await recommend(product, useAgent);
            const source = updated.recommendation?.source === 'agent' ? 'the agent' : 'the local ranker';
            return await send(reply, {
                note: `Recommended by ${source}: ${updated.recommendation?.presets.length ?? 0} preset(s).`,
                tone: 'ok'
            });
        } catch (error) {
            return send(reply, { note: error instanceof Error ? error.message : String(error), tone: 'bad' });
        }
    });

    app.post<{ Params: { id: string }; Body: FormBody }>('/accounts/products/:id/apply', async (request, reply) => {
        try {
            const product = await readProduct(request.params.id, directory);
            if (!product) throw new ProductError('That product no longer exists');
            const handle = normaliseHandle(text(request.body ?? {}, 'handle') ?? '');
            const written = await applyTo(product, handle, request.body ?? {});
            // Back to the editor for the account that just changed, with the panel it belongs to.
            reply.header('HX-Redirect', anchorFor(written));
            return await send(reply, { note: `Applied ${product.name} to ${written}.`, tone: 'ok' });
        } catch (error) {
            return send(reply, { note: applyError(error).message, tone: 'bad' });
        }
    });

    /**
     * The same blend across one creator's whole phone: every enabled account they own, on every
     * network. One person promoting one product should not have to be pointed at four times.
     */
    app.post<{ Params: { id: string }; Body: FormBody }>('/accounts/products/:id/apply-creator', async (request, reply) => {
        try {
            const product = await readProduct(request.params.id, directory);
            if (!product) throw new ProductError('That product no longer exists');
            const creatorId = text(request.body ?? {}, 'creatorId') ?? '';
            if (!creatorId) throw new ProductError('Choose a creator first');
            const active = store();
            if (!active) throw new ProductError('Creators need a database connection');
            const accounts = (await active.listCreatorAccounts(creatorId)).filter(({ enabled }) => enabled);
            if (!accounts.length) throw new ProductError('That creator has no enabled accounts');
            const written: string[] = [];
            for (const account of accounts) {
                try {
                    written.push(await applyTo(product, account.handle, request.body ?? {}));
                } catch { /* one bad handle must not stop the rest of the creator's accounts */ }
            }
            if (!written.length) throw new ProductError('None of that creator\'s accounts could be given a persona');
            if (written[0]) reply.header('HX-Redirect', anchorFor(written[0]));
            return await send(reply, {
                note: `Applied ${product.name} to ${written.join(', ')}.`, tone: 'ok',
            });
        } catch (error) {
            return send(reply, { note: applyError(error).message, tone: 'bad' });
        }
    });

    /* ---- JSON ---------------------------------------------------------- */

    app.get('/api/products', async () => ({ products: await loadProducts(directory) }));

    app.post<{ Body: unknown }>('/api/products', async (request, reply) => {
        try {
            return reply.code(201).send(await createProduct(request.body ?? {}, directory));
        } catch (error) {
            return failed(reply, error);
        }
    });

    app.get<{ Params: { id: string } }>('/api/products/:id', async (request, reply) => {
        try {
            const product = await readProduct(request.params.id, directory);
            return product ? reply.send(product) : failed(reply, new ProductError('No such product'), 404);
        } catch (error) {
            return failed(reply, error);
        }
    });

    app.patch<{ Params: { id: string }; Body: unknown }>('/api/products/:id', async (request, reply) => {
        try {
            return reply.send(await updateProduct(request.params.id, request.body ?? {}, directory));
        } catch (error) {
            return failed(reply, error, 404);
        }
    });

    app.delete<{ Params: { id: string } }>('/api/products/:id', async (request, reply) => {
        try {
            const gone = await deleteProduct(request.params.id, directory);
            return gone ? reply.code(204).send() : failed(reply, new ProductError('No such product'), 404);
        } catch (error) {
            return failed(reply, error);
        }
    });

    /**
     * The recommendation, stored and returned. A POST because it is not free: `useAgent` spawns
     * the Antigravity CLI. Without it this is the local ranker and answers in a millisecond.
     */
    app.post<{ Params: { id: string }; Body: { useAgent?: unknown } }>('/api/products/:id/recommend', async (request, reply) => {
        try {
            const product = await readProduct(request.params.id, directory);
            if (!product) return failed(reply, new ProductError('No such product'), 404);
            const updated = await recommend(product, request.body?.useAgent === true || request.body?.useAgent === 'true');
            return reply.send(updated.recommendation);
        } catch (error) {
            return failed(reply, error);
        }
    });

    /** Applying, for a script seeding a batch of accounts. Same blend, same store, no browser. */
    app.post<{ Params: { id: string }; Body: FormBody }>('/api/products/:id/apply', async (request, reply) => {
        try {
            const product = await readProduct(request.params.id, directory);
            if (!product) return failed(reply, new ProductError('No such product'), 404);
            const body = request.body ?? {};
            const handle = normaliseHandle(text(body, 'handle') ?? '');
            const written = await applyTo(product, handle, {
                ...body,
                presets: body.presets ?? (product.recommendation?.presets ?? []).map(({ id }) => id),
            });
            const personas = await loadPersonas(directory);
            return reply.send(personas[written]);
        } catch (error) {
            return failed(reply, applyError(error));
        }
    });

    /** What the ranker says about any text, without storing anything. */
    app.post<{ Body: { description?: unknown; audience?: unknown; name?: unknown; limit?: unknown } }>('/api/recommend-presets', async (request, reply) => {
        const body = request.body ?? {};
        const description = typeof body.description === 'string' ? body.description.trim() : '';
        if (!description) return failed(reply, new ProductError('description is required'));
        return reply.send(recommendLocally({
            description,
            ...(typeof body.audience === 'string' ? { audience: body.audience } : {}),
            ...(typeof body.name === 'string' ? { name: body.name } : {}),
        }, typeof body.limit === 'number' ? { limit: body.limit } : {}));
    });
}

export { AGY_INSTALL_COMMAND };
