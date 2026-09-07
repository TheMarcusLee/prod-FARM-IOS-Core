import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inject } from './support.js';
import { createApp } from '../src/api/app.js';
import { defaultDashboardTheme } from '../src/dashboard-theme.js';
import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import { createFakeAgentRunner } from '../src/agent/runner.js';
import { loadPersonas, validatePersona, type Persona } from '../src/persona/model.js';
import {
    extraInterests, rankPresets, recommendLocally, stem, tokenise, type Recommendation,
} from '../src/persona/recommend.js';
import {
    buildRecommendationPrompt, extractJson, parseAgentRecommendation, presetCatalogue, recommendWithAgent,
} from '../src/persona/recommend-agent.js';
import {
    createProduct, deleteProduct, loadProducts, personaForProduct, readProduct, updateProduct,
    validateProduct, type Product,
} from '../src/persona/products.js';
import { registerProductRoutes } from '../src/api/routes/products.js';

/** The description an operator would actually paste in for a SaaS product. */
const NOTES_APP = {
    name: 'Reflect',
    description: 'A SaaS AI note-taking app that transcribes your meetings, then turns them into notes, '
        + 'flashcards and to-dos and syncs them with Notion and Obsidian. Revision, task management '
        + 'and productivity in one place.',
    audience: 'Students, and knowledge workers who live in their calendar.',
};

const BAKERY_APP = {
    name: 'Crumb',
    description: 'A sourdough bakery app with proofing timers, hydration maths, pastry schedules and '
        + 'weeknight dinner recipes for home bakers who bake bread at the weekend.',
};

function ids(list: ReadonlyArray<{ id: string }>): string[] {
    return list.map(({ id }) => id);
}

/* ---- The ranker -------------------------------------------------------- */

test('the ranker puts a SaaS note-taking app in front of the right niches', () => {
    const ranked = rankPresets(`${NOTES_APP.name}\n${NOTES_APP.description}\n${NOTES_APP.audience}`);
    const shortlist = ids(ranked);
    assert.ok(shortlist.includes('saas-productivity'), `productivity apps missing from ${shortlist.join(', ')}`);
    assert.ok(shortlist.includes('study-productivity'), `study missing from ${shortlist.join(', ')}`);
    assert.ok(shortlist.includes('ai-tools'), `ai tools missing from ${shortlist.join(', ')}`);
    // And nothing with nothing to do with it.
    assert.ok(!shortlist.includes('fishing'));
    assert.ok(!shortlist.includes('birding'));

    // Best first, and every place on the list is earned by words the operator can see.
    assert.equal(shortlist[0], 'saas-productivity');
    assert.ok(ranked[0]!.score > ranked[ranked.length - 1]!.score);
    assert.ok(ranked[0]!.matched.includes('notion'));
    assert.ok(ranked.find(({ id }) => id === 'study-productivity')!.matched.includes('note taking'),
        'the hyphenated "note-taking" met the preset\'s "note taking"');
    // A shorter list is a shorter list, not a different one.
    assert.deepEqual(ids(rankPresets(NOTES_APP.description, { limit: 2 })), ids(rankPresets(NOTES_APP.description)).slice(0, 2));
});

test('the ranker reads a bakery app as baking and cooking', () => {
    const shortlist = ids(rankPresets(`${BAKERY_APP.name}\n${BAKERY_APP.description}`));
    assert.equal(shortlist[0], 'baking');
    assert.ok(shortlist.includes('cooking'), `cooking missing from ${shortlist.join(', ')}`);
    assert.ok(!shortlist.includes('saas-productivity'));

    // Plurals and -ing meet their preset's singular: both sides go through the same stemmer.
    assert.equal(stem('recipes'), stem('recipe'));
    assert.equal(stem('flashcards'), 'flashcard');
    assert.deepEqual(tokenise('Sourdough BREAD, proofing!'), ['sourdough', 'bread', 'proof']);
});

test('a preset whose avoid list matches the product is pushed down', () => {
    const text = 'A get rich quick crypto and NFT trading app for day traders chasing on-chain gains.';
    const ranked = rankPresets(text, { limit: 20 });
    const byId = new Map(ranked.map((entry) => [entry.id, entry]));
    // Crypto and web3 is what this is; the presets that list crypto as a turn-off are not offered.
    assert.equal(ranked[0]!.id, 'crypto-web3');
    assert.ok(!byId.has('saas-productivity'), 'productivity avoids crypto and get rich quick');
    assert.ok(!byId.has('ai-tools'), 'ai tools avoids crypto, nft and get rich quick');

    // The penalty is real arithmetic, not a filter: without the avoid words the preset scores.
    const scoredWithout = rankPresets('An AI agent app with prompts and copilot workflow automation', { limit: 20 });
    assert.ok(ids(scoredWithout).includes('ai-tools'));
});

test('the extra interests are the product words no preset covers', () => {
    const local = recommendLocally(NOTES_APP);
    assert.equal(local.source, 'ranker');
    assert.ok(local.extraInterests.includes('reflect'), `no brand word in ${local.extraInterests.join(', ')}`);
    assert.ok(local.extraInterests.some((term) => term.includes('transcribe') || term.includes('meeting')),
        `no product words in ${local.extraInterests.join(', ')}`);
    assert.ok(local.extraInterests.length >= 3 && local.extraInterests.length <= 8);
    // Nothing a chosen preset already has, and nothing that is only filler.
    assert.ok(!local.extraInterests.includes('notion'), 'notion is already a productivity interest');
    assert.ok(!local.extraInterests.some((term) => ['app', 'the', 'and', 'them'].includes(term)));
    // Every term is storable on a persona as it stands.
    assert.doesNotThrow(() => validatePersona('@farm.one', {
        niche: 'test', interests: local.extraInterests,
    }));
    // A bigram wins over its own words: "meeting notes" does not also appear as "meeting".
    for (const term of local.extraInterests.filter((entry) => entry.includes(' '))) {
        for (const word of term.split(' ')) assert.ok(!local.extraInterests.includes(word));
    }
    assert.deepEqual(extraInterests('the and of it to a for with', { presets: [] }), []);
});

/* ---- The agent --------------------------------------------------------- */

test('the agent prompt carries the catalogue and asks for strict JSON', () => {
    const prompt = buildRecommendationPrompt(NOTES_APP);
    assert.ok(prompt.includes(NOTES_APP.description));
    assert.ok(prompt.includes(NOTES_APP.audience));
    assert.match(prompt, /saas-productivity \| Productivity apps \| Tech & product/);
    assert.match(prompt, /"presets"/);
    assert.match(prompt, /an id you invent is discarded/);
    // Compact: one line per preset, first six interests only.
    const catalogue = presetCatalogue().split('\n');
    assert.equal(catalogue.length, 100);
    assert.ok(!catalogue.some((line) => line.split('|').pop()!.split(',').length > 6));
});

test('a valid agent answer is used, and anything the catalogue does not know is dropped', async () => {
    const answer = {
        presets: [
            { id: 'saas-productivity', why: 'Notion and Obsidian people are already watching this' },
            { id: 'productivity-pro', why: 'invented' },
            { id: 'study-productivity', why: 'Revision and note taking' },
            { id: 'saas-productivity', why: 'a duplicate' },
        ],
        extraInterests: ['reflect', '#meetingnotes', 'not a *valid* term!'],
        avoid: ['crypto'],
        audienceSummary: 'Students and knowledge workers.',
        networks: ['tiktok', 'myspace'],
    };
    const runner = createFakeAgentRunner({
        result: { ok: true, status: 'SUCCESS', exitCode: 0, lastMessage: `Sure!\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\nHope that helps.` },
    });
    const result = await recommendWithAgent(NOTES_APP, { runner });
    assert.equal(result.source, 'agent');
    assert.deepEqual(ids(result.presets), ['saas-productivity', 'study-productivity']);
    assert.equal(result.presets[0]!.label, 'Productivity apps');
    assert.match(result.presets[0]!.why, /already watching/);
    assert.deepEqual(result.extraInterests, ['reflect', '#meetingnotes']);
    assert.deepEqual(result.avoid, ['crypto']);
    assert.deepEqual(result.networks, ['tiktok']);
    assert.equal(result.audienceSummary, 'Students and knowledge workers.');
    assert.equal(result.note, undefined);
    // The model was asked once, on Flash, with no tools at all.
    assert.equal(runner.requests.length, 1);
    assert.deepEqual(runner.requests[0]!.mcpServers, []);
    assert.match(runner.requests[0]!.model, /flash/);
});

test('a missing CLI, a failed run and nonsense all fall back to the ranker', async () => {
    const missing = await recommendWithAgent(NOTES_APP, {
        runner: createFakeAgentRunner({ unavailable: 'The Antigravity CLI (agy) is not installed.' }),
    });
    assert.equal(missing.source, 'ranker');
    assert.match(missing.note!, /not installed/);
    assert.ok(ids(missing.presets).includes('saas-productivity'));

    const failed = await recommendWithAgent(NOTES_APP, {
        runner: createFakeAgentRunner({ result: { ok: false, status: 'FAILED', exitCode: 1, error: 'not signed in' } }),
    });
    assert.equal(failed.source, 'ranker');
    assert.match(failed.note!, /not signed in/);

    for (const lastMessage of ['I could not decide.', '{ "presets": [ broken', '{"presets":[{"id":"nope"}]}', '']) {
        const bad = await recommendWithAgent(NOTES_APP, {
            runner: createFakeAgentRunner({ result: { ok: true, status: 'SUCCESS', exitCode: 0, lastMessage } }),
        });
        assert.equal(bad.source, 'ranker', `"${lastMessage}" should not have been believed`);
        assert.match(bad.note!, /Ranked locally instead/);
        assert.ok(bad.presets.length > 0);
    }

    // The parser itself: prose around the object is fine, an unknown shape is not.
    assert.deepEqual(extractJson('before {"a": {"b": "}"}} after'), { a: { b: '}' } });
    assert.equal(extractJson('no json here'), undefined);
    assert.equal(parseAgentRecommendation({ presets: 'not a list' }), undefined);
    assert.deepEqual(ids(parseAgentRecommendation({ presets: ['baking', 'cooking'] })!.presets), ['baking', 'cooking']);
});

/* ---- The store --------------------------------------------------------- */

test('products are created, edited, listed and deleted on disk', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'products-store-'));
    context.after(async () => rm(directory, { recursive: true, force: true }));

    const created = await createProduct({ ...NOTES_APP, url: 'https://reflect.example' }, directory);
    assert.match(created.id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
    assert.equal(created.url, 'https://reflect.example/');
    assert.equal(created.recommendation, undefined);
    assert.ok(Date.parse(created.createdAt) > 0);

    const second = await createProduct(BAKERY_APP, directory);
    // Newest first: a farm promotes the thing it just added.
    assert.deepEqual(ids(await loadProducts(directory)).sort(), [created.id, second.id].sort());
    assert.equal((await readProduct(created.id, directory))?.name, 'Reflect');

    const edited = await updateProduct(created.id, { audience: 'Students only' }, directory);
    assert.equal(edited.audience, 'Students only');
    assert.equal(edited.description, created.description, 'an edit of one field keeps the rest');
    assert.equal(edited.id, created.id);
    assert.equal(edited.createdAt, created.createdAt);

    // The whitelist: free text is capped, a bad URL is a sentence, unknown keys never land.
    await assert.rejects(() => createProduct({ name: '', description: 'x' }, directory), /Name is required/);
    await assert.rejects(() => createProduct({ name: 'x' }, directory), /Description is required/);
    await assert.rejects(() => createProduct({ name: 'x', description: 'y', url: 'javascript:alert(1)' }, directory), /http or https/);
    await assert.rejects(() => createProduct({ name: 'x', description: 'y'.repeat(2001) }, directory), /at most 2000/);
    await assert.rejects(() => updateProduct('nope', {}, directory), /no longer exists/);
    assert.equal((validateProduct({ name: 'x', description: 'y', evil: true }) as unknown as Record<string, unknown>).evil, undefined);

    assert.equal(await deleteProduct(second.id, directory), true);
    assert.equal(await deleteProduct(second.id, directory), false);
    assert.deepEqual(ids(await loadProducts(directory)), [created.id]);

    // The file is a list an operator can read, and a broken entry costs only itself.
    const stored = JSON.parse(await readFile(path.join(directory, 'products.json'), 'utf8')) as Product[];
    assert.equal(stored.length, 1);
    await writeFile(path.join(directory, 'products.json'), JSON.stringify([...stored, { id: 'ok-2', name: 'No description' }]));
    assert.deepEqual(ids(await loadProducts(directory)), [created.id]);
});

test('applying a recommendation blends the presets and records the product', () => {
    const persona = personaForProduct({
        handle: 'farm.one',
        presets: ['saas-productivity', 'study-productivity'],
        extraInterests: ['reflect', 'meeting notes'],
        avoid: ['gambling'],
        productId: 'product-1',
    });
    assert.equal(persona.handle, '@farm.one');
    assert.deepEqual(persona.presets, ['saas-productivity', 'study-productivity']);
    assert.equal(persona.productId, 'product-1');
    // The blend first, then the extras, in the order the operator saw them.
    assert.equal(persona.interests[0], 'notion');
    assert.ok(persona.interests.includes('note taking'));
    assert.ok(persona.interests.includes('reflect'));
    assert.ok(persona.interests.includes('meeting notes'));
    assert.ok(persona.avoid.includes('gambling'));
    // A word that is an interest never also becomes an avoid term.
    const crypto = personaForProduct({
        handle: '@farm.two', presets: ['crypto-web3'], extraInterests: ['crypto'], avoid: ['crypto', 'nft'],
    });
    assert.ok(crypto.interests.includes('crypto'));
    assert.ok(!crypto.avoid.includes('crypto'));
    assert.equal(crypto.productId, undefined);
});

test('a persona file written before products existed still loads', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'products-old-'));
    context.after(async () => rm(directory, { recursive: true, force: true }));

    const old = {
        '@homegym.dan': {
            handle: '@homegym.dan', niche: 'home gym', interests: ['kettlebell', '#homegym'], avoid: ['makeup'],
            language: 'en', curiosity: 0.2, warmth: 0.6, presets: ['home-gym'],
            budgets: { likes: { min: 4, max: 10 }, saves: { min: 2, max: 6 }, follows: { min: 0, max: 1 }, searches: { min: 1, max: 3 } },
            watch: { match: { min: 18, max: 45 }, other: { min: 2, max: 5 } },
            sessionMinutes: { min: 10, max: 25 }, activeHours: [{ start: 6, end: 8 }],
            followRule: { likes: 3, withinSessions: 5 },
        },
    };
    await writeFile(path.join(directory, 'personas.json'), JSON.stringify(old, null, 2));

    const persona = (await loadPersonas(directory))['@homegym.dan'];
    assert.ok(persona);
    assert.deepEqual(persona.presets, ['home-gym']);
    assert.equal(persona.productId, undefined, 'nothing was invented for it');
    assert.ok(!Object.hasOwn(persona, 'productId'), 'and no empty key was added either');
    assert.throws(() => validatePersona('@homegym.dan', { ...persona, productId: 'not a product id!' }),
        /Product id must be/);
    // A products.json that was never written is an empty list, not a failure.
    assert.deepEqual(await loadProducts(directory), []);
});

/* ---- The panel --------------------------------------------------------- */

test('the Accounts page recommends a product and applies it to an account', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'products-routes-'));
    const previous = process.env.SCHEDULER_DATA_DIR;
    process.env.SCHEDULER_DATA_DIR = directory;
    context.after(async () => {
        if (previous === undefined) delete process.env.SCHEDULER_DATA_DIR; else process.env.SCHEDULER_DATA_DIR = previous;
        await rm(directory, { recursive: true, force: true });
    });

    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler: {} as SchedulerRepository, dashboardTheme: defaultDashboardTheme,
    });
    context.after(() => app.close());

    // Empty, and the agent button says why it is greyed out rather than failing when pressed.
    const empty = await inject(app, { method: 'GET', url: '/accounts/products' });
    assert.equal(empty.statusCode, 200);
    assert.match(empty.body, /New product/);
    assert.doesNotMatch(empty.body, /Recommended by/);

    const added = await inject(app, {
        method: 'POST', url: '/accounts/products',
        payload: new URLSearchParams({ ...NOTES_APP, url: 'https://reflect.example' }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(added.statusCode, 200);
    assert.match(added.body, /Added Reflect\./);
    const product = (await loadProducts(directory))[0]!;

    // A render never asks anything: the card is the store, and no recommendation exists yet.
    assert.match(added.body, /No recommendation yet/);

    const recommended = await inject(app, {
        method: 'POST', url: `/accounts/products/${encodeURIComponent(product.id)}/recommend`,
        payload: '', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(recommended.statusCode, 200);
    assert.match(recommended.body, /Recommended by the local ranker/);
    assert.match(recommended.body, /Productivity apps/);
    assert.match(recommended.body, /name="presets" value="saas-productivity" checked/);
    const stored = (await loadProducts(directory))[0]!;
    assert.equal(stored.recommendation?.source, 'ranker');

    // The operator unticks one, edits the extra interests, and applies it to a handle.
    const applied = await inject(app, {
        method: 'POST', url: `/accounts/products/${encodeURIComponent(product.id)}/apply`,
        payload: new URLSearchParams([
            ['handle', '@promo.one'],
            ['presets', 'saas-productivity'],
            ['presets', 'study-productivity'],
            ['presets', 'fishing'],
            ['extraInterests', 'reflect, meeting notes'],
            ['avoid', 'gambling'],
        ]).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(applied.statusCode, 200);
    assert.match(applied.body, /Applied Reflect to @promo\.one/);
    assert.equal(applied.headers['hx-redirect'], '/accounts#persona--promo-one');

    const persona = (await loadPersonas(directory))['@promo.one'];
    assert.ok(persona, 'the persona was written');
    // "fishing" was never recommended, so a hand-made POST could not sneak it into the blend.
    assert.deepEqual(persona.presets, ['saas-productivity', 'study-productivity']);
    assert.equal(persona.productId, product.id);
    assert.ok(persona.interests.includes('reflect'));
    assert.ok(persona.interests.includes('meeting notes'));
    assert.ok(persona.avoid.includes('gambling'));

    // And the section now says which account is promoting it.
    const listed = await inject(app, { method: 'GET', url: '/accounts/products' });
    assert.match(listed.body, /Already promoting/);
    assert.match(listed.body, /@promo\.one/);

    // Applying nothing is a sentence on the panel, not a 400 htmx would refuse to swap.
    const nothing = await inject(app, {
        method: 'POST', url: `/accounts/products/${encodeURIComponent(product.id)}/apply`,
        payload: new URLSearchParams({ handle: '@promo.two' }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(nothing.statusCode, 200);
    assert.match(nothing.body, /Tick at least one preset/);
    assert.equal((await loadPersonas(directory))['@promo.two'], undefined);

    // The JSON side: the same store, the same ranker, and the recommendation without the agent.
    const json = await inject(app, {
        method: 'POST', url: '/api/products', payload: { name: 'Crumb', description: BAKERY_APP.description },
    });
    assert.equal(json.statusCode, 201);
    const bakery = json.json() as Product;
    const ranked = await inject(app, {
        method: 'POST', url: `/api/products/${encodeURIComponent(bakery.id)}/recommend`, payload: {},
    });
    assert.equal(ranked.statusCode, 200);
    const recommendation = ranked.json() as Recommendation;
    assert.equal(recommendation.source, 'ranker');
    assert.equal(recommendation.presets[0]!.id, 'baking');

    const appliedJson = await inject(app, {
        method: 'POST', url: `/api/products/${encodeURIComponent(bakery.id)}/apply`,
        payload: { handle: '@bake.one', presets: ['baking'] },
    });
    assert.equal(appliedJson.statusCode, 200);
    assert.deepEqual((appliedJson.json() as Persona).presets, ['baking']);

    const all = await inject(app, { method: 'GET', url: '/api/products' });
    assert.equal((all.json() as { products: Product[] }).products.length, 2);
    assert.equal((await inject(app, { method: 'DELETE', url: `/api/products/${bakery.id}` })).statusCode, 204);
    assert.equal((await inject(app, { method: 'GET', url: `/api/products/${bakery.id}` })).statusCode, 404);

    const suggestion = await inject(app, {
        method: 'POST', url: '/api/recommend-presets', payload: { description: BAKERY_APP.description },
    });
    assert.equal((suggestion.json() as Recommendation).presets[0]!.id, 'baking');
    assert.equal((await inject(app, { method: 'POST', url: '/api/recommend-presets', payload: {} })).statusCode, 400);
});

test('the panel greys out the agent button when the CLI is not installed', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'products-agent-'));
    context.after(async () => rm(directory, { recursive: true, force: true }));
    const { default: Fastify } = await import('fastify');
    const { default: formbody } = await import('@fastify/formbody');

    const app = Fastify();
    await app.register(formbody);
    const runner = createFakeAgentRunner({
        unavailable: 'The Antigravity CLI (agy) is not installed. Install it with: curl …',
        result: { ok: true, status: 'SUCCESS', exitCode: 0 },
    });
    registerProductRoutes(app, { dataDirectory: directory, runner });
    context.after(() => app.close());

    const product = await createProduct(NOTES_APP, directory);
    const fragment = await app.inject({ method: 'GET', url: '/accounts/products' });
    assert.match(fragment.body, /Ask the agent/);
    assert.match(fragment.body, /disabled\s+title="The Antigravity CLI \(agy\) is not installed/);
    assert.equal(runner.requests.length, 0, 'a render never runs the agent');

    // Pressing it anyway falls back to the ranker and says so on the panel.
    const asked = await app.inject({
        method: 'POST', url: `/accounts/products/${encodeURIComponent(product.id)}/recommend`,
        payload: new URLSearchParams({ useAgent: '1' }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(asked.statusCode, 200);
    assert.match(asked.body, /Recommended by the local ranker/);
    assert.equal(runner.requests.length, 0);
    assert.match((await readProduct(product.id, directory))!.recommendation!.note!, /not installed/);
});
