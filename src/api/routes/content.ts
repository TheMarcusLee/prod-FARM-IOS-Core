import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DEVICE_LIMITS, type DripRuleRow } from '../../database/schema.js';
import type { PluginRegistry } from '../../registry.js';
import type { SchedulerRepository } from '../../scheduler/repository.js';
import { downloadWithYtDlp, ytDlpPath } from '../../content/ffmpeg.js';
import { ingestDirectory, ingestMedia, listMediaFiles, mimeTypeFor, removeItemFiles } from '../../content/ingest.js';
import {
    contentPage, escapeHtml, renderDeviceLimits, renderLibrary, renderRules, renderSets, renderTemplates,
} from '../../content/page.js';
import type { ShellRenderer } from '../../ui/context.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../../devices/registry.js';
import { assignAccountColours, collectAccounts } from '../../schedule/accounts.js';
import { contentRoot } from '../../content/paths.js';
import { renderCaptionTemplate } from '../../content/templates.js';
import { replanRule, runDripPlanner, startDripPlannerTick } from '../../content/runner.js';
import { createContentStore, type ContentStore } from '../../content/store.js';
import {
    asObject, parseCreatorAccountInput, parseCreatorInput, parseCreatorPatch, parseDeviceLimitInput,
    parseIngestRequest, parseIngestUrl, parseItemPatch, parseRuleInput, parseRulePatch,
    parseSetInput, parseSetItems, parseSetPatch, parseTemplateInput, requiredText, tagList,
} from '../../content/validate.js';

export interface ContentRouteOptions {
    scheduler: SchedulerRepository;
    /** Injected by tests; otherwise derived from the scheduler's own connection. */
    store?: ContentStore;
    /** Overrides DRIP_PLANNER_INTERVAL_MINUTES. Zero or less disables the tick. */
    plannerIntervalMinutes?: number;
    /** The one shell renderer, from `createShellContext`; every page goes through it. */
    shell: ShellRenderer;
    /** Test seam for the device registry, which supplies the account colour order. */
    loadDevices?: () => Promise<RegisteredDevice[]>;
    /** The plugins this process booted with, so a planned post names a task that exists. */
    plugins?: PluginRegistry;
}

const STATIC_ROOT = fileURLToPath(new URL('../../../static/dashboard/', import.meta.url));

const NO_DATABASE = 'The content library needs a database connection';

function notConfigured(reply: FastifyReply): FastifyReply {
    return reply.code(503).send({ error: NO_DATABASE });
}

/**
 * htmx does not swap a non-2xx response, so a fragment that answered 503 left
 * the operator staring at a spinner with no explanation. Fragment routes send
 * the message in the element the page is waiting for instead.
 */
function unavailableFragment(request: FastifyRequest, reply: FastifyReply, targetId: string): FastifyReply {
    if (!request.headers['hx-request']) return notConfigured(reply);
    return reply.type('text/html').send(`<div id="${targetId}" class="empty-state">${escapeHtml(NO_DATABASE)}</div>`);
}

function badRequest(reply: FastifyReply, error: unknown): FastifyReply {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
}

/** Fields that decide *when* and *what* a rule posts; changing one invalidates the planned queue. */
const PLANNING_FIELDS = [
    'deviceUdid', 'account', 'postsPerDay', 'windowStart', 'windowEnd', 'timezone', 'minGapMinutes',
    'destination', 'source', 'format', 'setId', 'tag', 'captionTemplateId', 'pickOrder', 'avoidReuseDays',
    'network', 'creatorId', 'crossPostGapMinutes', 'slideSize',
] as const satisfies ReadonlyArray<keyof DripRuleRow>;

/** The two planning-relevant fields that are not scalars, compared by value. */
function sameShape(before: unknown, after: unknown): boolean {
    return JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
}

export function affectsPlanning(before: DripRuleRow, after: DripRuleRow): boolean {
    if (PLANNING_FIELDS.some((field) => before[field] !== after[field])) return true;
    return !sameShape(before.networks, after.networks) || !sameShape(before.networkCaptions, after.networkCaptions);
}

/**
 * The content library, ingest pipeline and drip queue. Mounted from
 * `createApp` with one call so the rest of the API surface is untouched.
 */
export async function registerContentRoutes(app: FastifyInstance, options: ContentRouteOptions): Promise<void> {
    let resolved: ContentStore | null | undefined;
    const store = (): ContentStore | null => {
        if (resolved !== undefined) return resolved;
        try {
            resolved = options.store ?? createContentStore(options.scheduler.connection.db);
        } catch {
            resolved = null;
        }
        return resolved;
    };

    const loadDevices = options.loadDevices ?? loadRegisteredDevices;
    const [pageScript, pageStyles] = await Promise.all([
        readFile(path.join(STATIC_ROOT, 'assets/content.js'), 'utf8').catch(() => '/* run npm run build:web */'),
        // Only for the cache key: a CSS-only edit has to give the page a fresh
        // asset URL too, and /assets/pages.css is served by the schedule routes.
        readFile(path.join(STATIC_ROOT, 'pages.css'), 'utf8').catch(() => ''),
    ]);
    const version = `?v=${crypto.createHash('sha1').update(pageScript + pageStyles).digest('base64url').slice(0, 10)}`;
    const page = contentPage(version);

    /** Colours follow the same registration order the Schedule timeline uses. */
    const ruleColours = async (accounts: readonly string[]) => {
        const devices = await loadDevices().catch(() => [] as RegisteredDevice[]);
        return assignAccountColours(collectAccounts(devices, accounts));
    };

    app.get('/content', async (request, reply) => reply.type('text/html').send(await options.shell(request, page)));
    app.get('/assets/content.js', async (_request, reply) => reply.type('text/javascript').send(pageScript));

    // ---- library ------------------------------------------------------------

    app.get<{ Querystring: { status?: string; tag?: string } }>('/api/content/items', async (request, reply) => {
        const active = store();
        if (!active) return unavailableFragment(request, reply, 'content-library');
        const items = await active.listItems({
            ...(request.query.status ? { status: request.query.status } : {}),
            ...(request.query.tag ? { tag: request.query.tag } : {}),
        });
        if (request.headers['hx-request']) return reply.type('text/html').send(renderLibrary(items));
        return { items };
    });

    app.get<{ Params: { id: string } }>('/api/content/items/:id/poster', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const item = await active.item(request.params.id);
        if (!item?.posterPath) return reply.code(404).send({ error: 'No poster for this item' });
        const file = path.resolve(contentRoot(), item.posterPath);
        if (!file.startsWith(`${contentRoot()}${path.sep}`)) return reply.code(404).send({ error: 'No poster for this item' });
        if (!await stat(file).then(() => true, () => false)) return reply.code(404).send({ error: 'No poster for this item' });
        return reply.type('image/jpeg').header('cache-control', 'private, max-age=300').send(createReadStream(file));
    });

    app.post('/api/content/items', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        if (typeof request.isMultipart !== 'function' || !request.isMultipart()) {
            return reply.code(415).send({ error: 'Upload media as multipart/form-data' });
        }
        const fields = new Map<string, string>();
        const created = [];
        try {
            for await (const part of request.parts()) {
                if (part.type === 'field') { fields.set(part.fieldname, String(part.value)); continue; }
                if (part.fieldname !== 'media') continue;
                created.push(await ingestMedia(active, {
                    source: part.file,
                    originalName: part.filename || 'upload',
                    mimeType: part.mimetype || mimeTypeFor(part.filename || 'upload'),
                    ...(tagList(fields.get('tags'), 'tags') ? { tags: tagList(fields.get('tags'), 'tags') as string[] } : {}),
                    ...(fields.get('crop') === 'true' ? { crop: true } : {}),
                }));
            }
        } catch (error) {
            return badRequest(reply, error);
        }
        if (!created.length) return reply.code(400).send({ error: 'No media was uploaded' });
        return reply.code(201).send({ items: created });
    });

    app.patch<{ Params: { id: string } }>('/api/content/items/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        try {
            const updated = await active.updateItem(request.params.id, parseItemPatch(request.body));
            return updated ?? reply.code(404).send({ error: 'Content item not found' });
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    app.delete<{ Params: { id: string } }>('/api/content/items/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const item = await active.item(request.params.id);
        if (!item) return reply.code(404).send({ error: 'Content item not found' });
        await active.deleteItem(item.id);
        await removeItemFiles(item, active);
        return reply.code(204).send();
    });

    // ---- ingest -------------------------------------------------------------

    app.post('/api/content/ingest', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        try {
            const input = parseIngestRequest(request.body);
            const result = await ingestDirectory(active, input.directory, {
                ...(input.tags ? { tags: input.tags } : {}),
                ...(input.crop === undefined ? {} : { crop: input.crop }),
            });
            return reply.code(202).send({ ingested: result.ingested, skipped: result.skipped });
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    app.post('/api/content/ingest-url', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        let input;
        try {
            input = parseIngestUrl(request.body);
        } catch (error) {
            return badRequest(reply, error);
        }
        const binary = await ytDlpPath();
        if (!binary) {
            return reply.code(501).send({
                error: 'URL ingest needs yt-dlp. Install it and put it on PATH (or set YT_DLP_PATH), then retry.',
            });
        }
        await mkdir(contentRoot(), { recursive: true });
        const workspace = await mkdtemp(path.join(contentRoot(), 'download-'));
        try {
            await downloadWithYtDlp(binary, input.url, path.join(workspace, '%(id)s.%(ext)s'));
            const files = await listMediaFiles(workspace);
            if (!files.length) return reply.code(422).send({ error: 'yt-dlp produced no media' });
            const items = [];
            for (const file of files) {
                items.push(await ingestMedia(active, {
                    source: file, originalName: path.basename(file), mimeType: mimeTypeFor(file),
                    ...(input.tags ? { tags: input.tags } : {}),
                    ...(input.crop === undefined ? {} : { crop: input.crop }),
                }));
            }
            return reply.code(202).send({ items });
        } catch (error) {
            return badRequest(reply, error);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    // ---- sets ---------------------------------------------------------------

    app.get('/api/content/sets', async (request, reply) => {
        const active = store();
        if (!active) return unavailableFragment(request, reply, 'content-sets');
        const sets = await active.listSets();
        if (request.headers['hx-request']) return reply.type('text/html').send(renderSets(sets));
        return { sets };
    });

    app.post('/api/content/sets', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        try {
            return reply.code(201).send(await active.createSet(parseSetInput(request.body)));
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    /** One set with its members in order — what the slideshow builder opens. */
    app.get<{ Params: { id: string } }>('/api/content/sets/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const found = await active.set(request.params.id);
        if (!found) return reply.code(404).send({ error: 'Set not found' });
        return { ...found, items: await active.setItems(found.id) };
    });

    /**
     * Turning a set into a slideshow, or moving its cover. Membership and order
     * go through `PUT …/items`; this is the set's own shape.
     */
    app.patch<{ Params: { id: string } }>('/api/content/sets/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        try {
            const updated = await active.updateSet(request.params.id, parseSetPatch(request.body));
            return updated ?? reply.code(404).send({ error: 'Set not found' });
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    app.delete<{ Params: { id: string } }>('/api/content/sets/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const removed = await active.deleteSet(request.params.id);
        return removed ? reply.code(204).send() : reply.code(404).send({ error: 'Set not found' });
    });

    app.put<{ Params: { id: string } }>('/api/content/sets/:id/items', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        try {
            const { itemIds } = parseSetItems(request.body);
            await active.setSetItems(request.params.id, itemIds);
            return { itemIds };
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    // ---- caption templates --------------------------------------------------

    app.get('/api/content/templates', async (request, reply) => {
        const active = store();
        if (!active) return unavailableFragment(request, reply, 'caption-templates');
        const templates = await active.listTemplates();
        if (request.headers['hx-request']) return reply.type('text/html').send(renderTemplates(templates));
        return { templates };
    });

    app.post('/api/content/templates', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        try {
            return reply.code(201).send(await active.createTemplate(parseTemplateInput(request.body)));
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    app.delete<{ Params: { id: string } }>('/api/content/templates/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const removed = await active.deleteTemplate(request.params.id);
        return removed ? reply.code(204).send() : reply.code(404).send({ error: 'Caption template not found' });
    });

    /** Preview a caption without saving it — the templating language is easy to get wrong. */
    app.post('/api/content/templates/preview', async (request, reply) => {
        try {
            const input = asObject(request.body);
            const template = requiredText(input.template, 'template', 2200);
            const preview = renderCaptionTemplate(template, {
                title: typeof input.title === 'string' ? input.title : 'Sample title',
                hashtags: tagList(input.hashtags, 'hashtags') ?? ['fyp', 'viral'],
                account: typeof input.account === 'string' ? input.account : '@account',
                date: new Date().toISOString().slice(0, 10),
            });
            return { preview };
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    // ---- drip rules ---------------------------------------------------------

    app.get('/api/drip/rules', async (request, reply) => {
        const active = store();
        if (!active) return unavailableFragment(request, reply, 'drip-rules');
        const rules = await active.listRules();
        const views = await Promise.all(rules.map(async (rule) => ({
            rule, plans: await active.upcomingPlans(rule.id, 20),
        })));
        if (request.headers['hx-request']) {
            // A creator rule shows the creator's name, not the placeholder handle
            // stored in `account`, so the list reads as what it will actually do.
            const creators = new Map((await active.listCreators()).map(({ id, name }) => [id, name]));
            const colours = await ruleColours(rules.map(({ account }) => account));
            return reply.type('text/html').send(renderRules(views, colours, creators));
        }
        return { rules: views };
    });

    app.post('/api/drip/rules', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        try {
            return reply.code(201).send(await active.createRule(parseRuleInput(request.body)));
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    app.patch<{ Params: { id: string } }>('/api/drip/rules/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const current = await active.rule(request.params.id);
        if (!current) return reply.code(404).send({ error: 'Drip rule not found' });
        try {
            const patch = parseRulePatch(request.body, current);
            const updated = await active.updateRule(request.params.id, patch);
            if (!updated) return reply.code(404).send({ error: 'Drip rule not found' });
            // An edited window or source has to reach today's queue: drop the
            // posts this rule planned but has not yet run, and let the next
            // planning pass rebuild them from the new settings.
            const released = affectsPlanning(current, updated)
                ? await replanRule({ store: active, scheduler: options.scheduler, ruleId: updated.id })
                : { cancelled: 0, released: 0 };
            return { ...updated, replanned: released };
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    app.delete<{ Params: { id: string } }>('/api/drip/rules/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const removed = await active.deleteRule(request.params.id);
        return removed ? reply.code(204).send() : reply.code(404).send({ error: 'Drip rule not found' });
    });

    app.get<{ Querystring: { ruleId?: string } }>('/api/drip/plans', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        return { plans: await active.upcomingPlans(request.query.ruleId, 200) };
    });

    const plan = async () => {
        const active = store();
        if (!active) throw new Error('The content library needs a database connection');
        return runDripPlanner({
            store: active, scheduler: options.scheduler,
            ...(options.plugins ? { plugins: options.plugins } : {}),
        });
    };

    app.post('/api/drip/plan', async (_request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        return reply.code(202).send(await plan());
    });

    // ---- creators and their accounts ----------------------------------------

    app.get('/api/creators', async (_request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const [rows, accounts] = await Promise.all([active.listCreators(), active.listCreatorAccounts()]);
        return {
            creators: rows.map((creator) => ({
                ...creator, accounts: accounts.filter(({ creatorId }) => creatorId === creator.id),
            })),
        };
    });

    app.post('/api/creators', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        try {
            return reply.code(201).send(await active.createCreator(parseCreatorInput(request.body)));
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    app.patch<{ Params: { id: string } }>('/api/creators/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        try {
            const updated = await active.updateCreator(request.params.id, parseCreatorPatch(request.body));
            return updated ?? reply.code(404).send({ error: 'Creator not found' });
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    app.delete<{ Params: { id: string } }>('/api/creators/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const removed = await active.deleteCreator(request.params.id);
        return removed ? reply.code(204).send() : reply.code(404).send({ error: 'Creator not found' });
    });

    app.post<{ Params: { id: string } }>('/api/creators/:id/accounts', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const creator = await active.creator(request.params.id);
        if (!creator) return reply.code(404).send({ error: 'Creator not found' });
        try {
            const input = parseCreatorAccountInput(request.body);
            return reply.code(201).send(await active.createCreatorAccount({ creatorId: creator.id, ...input }));
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    app.patch<{ Params: { id: string }; Body: { enabled?: unknown } }>('/api/creator-accounts/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const enabled = asObject(request.body ?? {}).enabled;
        if (typeof enabled !== 'boolean') return badRequest(reply, new Error('enabled must be true or false'));
        const updated = await active.updateCreatorAccount(request.params.id, { enabled });
        return updated ?? reply.code(404).send({ error: 'Account not found' });
    });

    app.delete<{ Params: { id: string } }>('/api/creator-accounts/:id', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        const removed = await active.deleteCreatorAccount(request.params.id);
        return removed ? reply.code(204).send() : reply.code(404).send({ error: 'Account not found' });
    });

    // ---- per-phone limits ---------------------------------------------------

    app.get('/api/device-limits', async (request, reply) => {
        const active = store();
        if (!active) return unavailableFragment(request, reply, 'device-limits');
        const devices = await loadDevices().catch(() => [] as RegisteredDevice[]);
        const stored = new Map((await active.listDeviceLimits()).map((row) => [row.deviceUdid, row]));
        const rows = devices.map(({ udid, name }) => ({
            deviceUdid: udid,
            name,
            maxPostsPerDay: stored.get(udid)?.maxPostsPerDay ?? DEFAULT_DEVICE_LIMITS.maxPostsPerDay,
            minMinutesBetweenPosts:
                stored.get(udid)?.minMinutesBetweenPosts ?? DEFAULT_DEVICE_LIMITS.minMinutesBetweenPosts,
            /** False means "still on the defaults" — worth showing, so the card is not a lie. */
            configured: stored.has(udid),
        }));
        if (request.headers['hx-request']) return reply.type('text/html').send(renderDeviceLimits(rows));
        return { limits: rows };
    });

    app.put<{ Params: { udid: string } }>('/api/device-limits/:udid', async (request, reply) => {
        const active = store();
        if (!active) return notConfigured(reply);
        try {
            const input = parseDeviceLimitInput(request.body);
            return await active.setDeviceLimits(requiredText(request.params.udid, 'udid', 128), input);
        } catch (error) {
            return badRequest(reply, error);
        }
    });

    // ---- hourly tick --------------------------------------------------------

    // The same tick the worker runs (src/scheduler/worker.ts). Both take the
    // planner's advisory lock, so however many processes tick, a given moment
    // is planned once.
    const tick = startDripPlannerTick({
        store: store(), scheduler: options.scheduler,
        ...(options.plannerIntervalMinutes === undefined ? {} : { intervalMinutes: options.plannerIntervalMinutes }),
        log: (error) => app.log.error(error),
    });
    if (tick) app.addHook('onClose', async () => tick.stop());
}
