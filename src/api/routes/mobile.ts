import rateLimit from '@fastify/rate-limit';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { registerTokenRoutes } from '../../auth/tokens.js';
import { contentRoot, dataRoot } from '../../content/paths.js';
import { resolveMediaTools } from '../../content/ffmpeg.js';
import { createContentStore, type ContentStore, type QueuePlanRow } from '../../content/store.js';
import type { ExecutionRow, ScheduleRow } from '../../database/schema.js';
import { discoverConnectedDevices } from '../../devices/discovery.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../../devices/registry.js';
import { platformOf } from '../../drivers/select.js';
import { createEventStore, serializeEvent, type EventStore, type FarmEvent } from '../../fleet/events.js';
import { derivedDeviceState, type DerivedDeviceState } from '../../fleet/summary.js';
import { acknowledgedMark } from '../../push/acks.js';
import type { PluginRegistry } from '../../registry.js';
import { ScheduleTransitionError, type KeysetCursor, type SchedulerRepository } from '../../scheduler/repository.js';
import type { JsonObject } from '../../types.js';

const run = promisify(execFile);

export interface MobileRouteOptions {
    scheduler: SchedulerRepository;
    plugins: PluginRegistry;
    /** Test seams. Production leaves every one of these unset. */
    store?: ContentStore;
    events?: EventStore;
    authStatePath?: string;
    loadDevices?: () => Promise<RegisteredDevice[]>;
    connectedUdids?: () => Promise<string[]>;
    now?: () => Date;
}

// ---- screenshot thumbnails (gap 3) -----------------------------------------

export const MIN_SCREENSHOT_WIDTH = 120;
export const MAX_SCREENSHOT_WIDTH = 1080;

/**
 * `?width=` for the fleet grid. Out-of-range values clamp rather than fail: a
 * grid cell asking for 40 px wants the smallest thumbnail there is, not a 400.
 * Anything that is not a number means "full resolution", the old behaviour.
 */
export function clampScreenshotWidth(value: unknown): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(MAX_SCREENSHOT_WIDTH, Math.max(MIN_SCREENSHOT_WIDTH, Math.round(parsed)));
}

/** Aspect preserved, never upscaled — a 320 px request on a 300 px frame stays 300. */
export async function resizeScreenshot(image: Buffer, width: number): Promise<Buffer> {
    return sharp(image).resize({ width, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}

// ---- keyset pagination (gap 9) ---------------------------------------------

export const DEFAULT_PAGE_LIMIT = 200;
export const MAX_PAGE_LIMIT = 200;

export interface KeysetQuery { deviceUdid?: string; limit?: string; before?: string }

export interface KeysetPage<T> { rows: readonly T[]; nextBefore: string | null }

function pageLimit(value: string | undefined): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_LIMIT;
    return Math.min(MAX_PAGE_LIMIT, Math.floor(parsed));
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
    return Object.assign(new Error(message), { statusCode });
}

/** `before` is either a row id or the ISO `createdAt` of the last row a client rendered. */
async function cursorFor(
    before: string | undefined, lookup: (id: string) => Promise<{ createdAt: Date } | null>,
): Promise<KeysetCursor | undefined> {
    if (before === undefined) return undefined;
    const asDate = new Date(before);
    if (before.includes('T') && Number.isFinite(asDate.getTime())) return { createdAt: asDate };
    const row = await lookup(before);
    if (!row) throw httpError(400, 'before must be a row id or an ISO createdAt timestamp');
    return { createdAt: row.createdAt, id: before };
}

/**
 * Shared by `/api/schedules` and `/api/executions`. With no `limit`/`before` the
 * response is byte-identical to what it always was — 200 newest rows, no header.
 */
export async function keysetPage<T extends { id: string }>(
    query: KeysetQuery,
    lookup: (id: string) => Promise<{ createdAt: Date } | null>,
    fetch: (limit: number, deviceUdid: string | undefined, before: KeysetCursor | undefined) => Promise<readonly T[]>,
): Promise<KeysetPage<T>> {
    const limit = pageLimit(query.limit);
    const before = await cursorFor(query.before, lookup);
    const rows = await fetch(limit, query.deviceUdid, before);
    const paginating = query.limit !== undefined || query.before !== undefined;
    const last = rows[rows.length - 1];
    return { rows, nextBefore: paginating && rows.length === limit && last ? last.id : null };
}

// ---- rate limits (gap 10) --------------------------------------------------

interface Bucket { name: string; max: number; windowMs: number; scope: string }

function envNumber(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const REMOTE_ROUTE = /^\/api\/devices\/([^/]+)\/remote\/(action|screenshot)$/;

/** Where `registerMcpRoutes` mounts, and the one path the rate-limit hook cares about outside /api. */
export const MCP_PATH = '/mcp';

/**
 * These protect the *phones*, not the server: a retry loop hammering
 * `remote/action` is a real way to wedge a WDA session, so the two device
 * routes are counted per second and per device as well as per token.
 */
export function bucketFor(method: string, url: string): Bucket {
    // Every MCP call is one POST to the same path, so without a bucket of its own an agent's
    // normal tool loop lands in the 60/min write budget and stalls after a minute of work. The
    // point here is a ceiling on a runaway agent, not throttling: 600/min is ten calls a second.
    if (url === MCP_PATH || url.startsWith(`${MCP_PATH}/`)) {
        return { name: 'mcp', max: envNumber('RATE_LIMIT_MCP', 600), windowMs: 60_000, scope: '' };
    }
    const remote = REMOTE_ROUTE.exec(url);
    if (remote?.[2] === 'action') {
        return { name: 'action', max: envNumber('RATE_LIMIT_ACTION', 10), windowMs: 1_000, scope: remote[1] ?? '' };
    }
    if (remote?.[2] === 'screenshot') {
        return { name: 'screenshot', max: envNumber('RATE_LIMIT_SCREENSHOT', 5), windowMs: 1_000, scope: remote[1] ?? '' };
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        return { name: 'read', max: envNumber('RATE_LIMIT_READ', 300), windowMs: 60_000, scope: '' };
    }
    return { name: 'write', max: envNumber('RATE_LIMIT_WRITE', 60), windowMs: 60_000, scope: '' };
}

function pathOf(request: FastifyRequest): string {
    return request.url.split('?')[0] ?? request.url;
}

/** Keyed on the token, because every request arrives from the same tailnet address. */
function rateKey(request: FastifyRequest): string {
    const bucket = bucketFor(request.method, pathOf(request));
    const identity = request.apiToken?.id ?? `ip:${request.ip}`;
    return `${bucket.name}:${identity}:${bucket.scope}`;
}

export function rateLimitsEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
    return environment.RATE_LIMITS !== 'off';
}

/**
 * The plugin is registered in non-global mode and driven by our own hook:
 * `global: true` only attaches to routes registered *after* the plugin loads,
 * and every farm route already exists by the time the mobile routes mount. A
 * plain `onRequest` hook applies to all of them, in the order Fastify added it
 * — after the auth hook, so `request.apiToken` is already set.
 *
 * Not awaited either: `await app.register(...)` part-way through `createApp`
 * boots the instance early and the `setErrorHandler` at the end of `createApp`
 * would be silently dropped.
 */
function registerRateLimits(app: FastifyInstance): void {
    void app.register(rateLimit, { global: false });
    let limiter: ReturnType<FastifyInstance['createRateLimit']> | null = null;

    app.addHook('onRequest', async (request, reply) => {
        // The dashboard's own HTMX fragments and static assets are not the
        // threat here, and a 1 s polling fragment would trip a read budget.
        // `/mcp` is not under /api but is a token endpoint, so it is counted too.
        const path = pathOf(request);
        if (!path.startsWith('/api/') && path !== MCP_PATH && !path.startsWith(`${MCP_PATH}/`)) return;
        limiter ??= app.createRateLimit({
            keyGenerator: rateKey,
            max: (candidate) => bucketFor(candidate.method, pathOf(candidate)).max,
            timeWindow: (candidate) => bucketFor(candidate.method, pathOf(candidate)).windowMs,
        });
        const result = await limiter(request);
        // `isAllowed` means "skipped by the allow list"; a counted request
        // reports its budget instead, and only `isExceeded` is a refusal.
        if (result.isAllowed) return;
        reply.header('x-ratelimit-limit', result.max)
            .header('x-ratelimit-remaining', result.remaining)
            .header('x-ratelimit-reset', result.ttlInSeconds);
        if (!result.isExceeded) return;
        return reply.header('retry-after', result.ttlInSeconds).code(429)
            .send({ error: `Rate limit exceeded — retry in ${result.ttlInSeconds} seconds` });
    });
}

// ---- asset thumbnails (gap 7) ----------------------------------------------

export const THUMBNAIL_MAX_PX = 320;

const CACHE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The digest names a cache file, so it has to be a bare name and not a relative path. */
function thumbnailCachePath(sha256: string): string | null {
    return CACHE_KEY_PATTERN.test(sha256) ? path.join(dataRoot(), 'thumbnails', `${sha256}.jpg`) : null;
}

/**
 * `relativePath` comes from the assets table, where the API and the MCP tools
 * write a generated `uploads/<uuid>`. The content ingest path writes rows too,
 * so this route reads a value it did not itself produce — resolve it and check
 * containment the same way the poster route does, rather than trusting it.
 */
function containedPath(root: string, relativePath: string): string | null {
    const resolved = path.resolve(root, relativePath);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

async function exists(file: string): Promise<boolean> {
    return stat(file).then(() => true, () => false);
}

async function writeImageThumbnail(source: string, destination: string): Promise<void> {
    await sharp(source)
        .resize({ width: THUMBNAIL_MAX_PX, height: THUMBNAIL_MAX_PX, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 72 })
        .toFile(destination);
}

/**
 * First frame, scaled down by ffmpeg itself so nothing decodes a 1080p frame
 * into the API process. execFile with an argument array — never a shell.
 */
async function writeVideoThumbnail(source: string, destination: string): Promise<void> {
    const { ffmpeg } = await resolveMediaTools();
    await run(ffmpeg, [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-i', source,
        '-frames:v', '1',
        '-vf', `scale=${THUMBNAIL_MAX_PX}:${THUMBNAIL_MAX_PX}:force_original_aspect_ratio=decrease`,
        destination,
    ], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
}

// ---- content queue (gap 8) -------------------------------------------------

export type QueueStatus = 'planned' | 'approved' | 'skipped' | 'posted';

/**
 * The drip queue models a planned post as a `drip_plans` row pointing at a real
 * schedule, so the schedule *is* the approval state: active means it will go
 * out, paused means it is being held, cancelled means it was skipped. Nothing
 * else needs storing, which is why there is no new column here.
 */
export function queueStatus(plan: Pick<QueuePlanRow, 'scheduleStatus' | 'usedMarkedAt'>): QueueStatus {
    if (plan.scheduleStatus === 'cancelled') return 'skipped';
    if (plan.scheduleStatus === 'completed') return 'posted';
    if (plan.usedMarkedAt) return 'posted';
    if (plan.scheduleStatus === 'active') return 'approved';
    return 'planned';
}

function queueItem(plan: QueuePlanRow): JsonObject {
    return {
        id: plan.id,
        status: queueStatus(plan),
        deviceUdid: plan.deviceUdid,
        caption: plan.caption,
        assetId: plan.assetId,
        thumbnailUrl: `/api/assets/${plan.assetId}/thumbnail`,
        plannedFor: plan.plannedFor.toISOString(),
        scheduleId: plan.scheduleId,
    };
}

// ---- bootstrap (gap 4) -----------------------------------------------------

const require = createRequire(import.meta.url);
let cachedSha: Promise<string | null> | null = null;

/** The app shows this next to its own version; "which halves are talking" is the first support question. */
async function gitSha(): Promise<string | null> {
    cachedSha ??= run('git', ['rev-parse', '--short', 'HEAD'], { timeout: 2_000 })
        .then(({ stdout }) => stdout.trim() || null)
        .catch(() => null);
    return cachedSha;
}

async function release(): Promise<JsonObject> {
    const { version } = require('../../../package.json') as { version: string };
    const sha = await gitSha();
    return { version, sha };
}

interface BootstrapDevice {
    udid: string;
    name: string;
    platform: string;
    tags: string[];
    state: DerivedDeviceState;
    connection: { connected: boolean };
    currentExecution: JsonObject | null;
    nextRunAt: string | null;
    lastError: string | null;
}

function currentExecutionOf(
    executions: readonly ExecutionRow[], plugins: PluginRegistry, udid: string,
): JsonObject | null {
    const running = executions.find((row) => row.deviceUdid === udid && row.status === 'running')
        ?? executions.find((row) => row.deviceUdid === udid && row.status === 'queued');
    if (!running) return null;
    let summary = `${running.pluginId}/${running.taskType}@${running.taskVersion}`;
    try {
        summary = plugins.task({
            pluginId: running.pluginId, taskType: running.taskType,
            taskVersion: running.taskVersion, payload: running.payload,
        }).summarize(running.payload);
    } catch { /* the plugin was uninstalled; the identifiers still say what ran */ }
    return {
        id: running.id, taskType: running.taskType, status: running.status,
        startedAt: running.startedAt?.toISOString() ?? null, summary,
    };
}

function nextRunOf(schedules: readonly ScheduleRow[], udid: string): string | null {
    const times = schedules
        .filter((row) => row.deviceUdid === udid && row.status === 'active' && row.nextRunAt)
        .map((row) => row.nextRunAt!.getTime());
    return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

function countStates(devices: readonly BootstrapDevice[]): JsonObject {
    const count = (state: DerivedDeviceState) => devices.filter((device) => device.state === state).length;
    return {
        total: devices.length, online: count('online'), busy: count('busy'),
        offline: count('offline'), disabled: count('disabled'), error: count('error'),
    };
}

// ---- routes ----------------------------------------------------------------

/**
 * Everything the companion app needs that the dashboard never did: token
 * identity, rate limits, one-round-trip bootstrap, asset thumbnails and the
 * content approval queue. Mounted from `createApp` with a single call.
 */
export async function registerMobileRoutes(app: FastifyInstance, options: MobileRouteOptions): Promise<void> {
    const clock = options.now ?? (() => new Date());
    const loadDevices = options.loadDevices ?? loadRegisteredDevices;
    const connectedUdids = options.connectedUdids
        ?? (async () => (await discoverConnectedDevices()).map(({ udid }) => udid));

    let contentStore: ContentStore | null | undefined;
    const store = (): ContentStore | null => {
        if (contentStore !== undefined) return contentStore;
        try {
            contentStore = options.store ?? createContentStore(options.scheduler.connection.db);
        } catch {
            contentStore = null;
        }
        return contentStore;
    };
    const requireStore = (reply: FastifyReply): ContentStore | null => {
        const resolved = store();
        if (!resolved) void reply.code(503).send({ error: 'The content library needs a database connection' });
        return resolved;
    };

    let events: EventStore | null | undefined = options.events;
    const eventStore = (): EventStore | null => {
        if (events === undefined) {
            try {
                events = options.scheduler.connection ? createEventStore(options.scheduler.connection) : null;
            } catch {
                events = null;
            }
        }
        return events;
    };

    await registerTokenRoutes(app, options.authStatePath ? { statePath: options.authStatePath } : {});
    if (rateLimitsEnabled()) registerRateLimits(app);

    app.get('/api/mobile/bootstrap', async (request) => {
        // Events past this token's acknowledgement mark; with no ack store attached the
        // mark is undefined and every recorded event counts as unread.
        const unacknowledgedCountFor = async (request: FastifyRequest): Promise<number> => {
            const store = eventStore();
            if (!store) return 0;
            const mark = await acknowledgedMark(app, request);
            return store.countAfter(mark ?? 0);
        };
        const [devices, connected, recent] = await Promise.all([
            loadDevices().catch(() => [] as RegisteredDevice[]),
            connectedUdids().catch(() => [] as string[]),
            eventStore()?.list({ limit: 200 }).catch(() => [] as FarmEvent[]) ?? Promise.resolve([] as FarmEvent[]),
        ]);
        const [executions, schedules] = await Promise.all([
            options.scheduler.listExecutions(500).catch(() => [] as ExecutionRow[]),
            options.scheduler.listSchedules(500).catch(() => [] as ScheduleRow[]),
        ]);
        const online = new Set(connected);
        const busy = new Set(executions
            .filter(({ status }) => status === 'queued' || status === 'running')
            .map(({ deviceUdid }) => deviceUdid));
        const latestEvent = new Map<string, FarmEvent>();
        for (const event of recent) {
            if (event.deviceUdid && !latestEvent.has(event.deviceUdid)) latestEvent.set(event.deviceUdid, event);
        }
        const fleetDevices: BootstrapDevice[] = devices.map((device) => {
            const last = latestEvent.get(device.udid);
            const errored = last?.severity === 'error';
            return {
                udid: device.udid,
                name: device.name,
                platform: platformOf(device),
                tags: device.tags ?? [],
                state: derivedDeviceState({
                    disabled: device.disabled, connected: online.has(device.udid),
                    busy: busy.has(device.udid), errored,
                }),
                connection: { connected: online.has(device.udid) },
                currentExecution: currentExecutionOf(executions, options.plugins, device.udid),
                nextRunAt: nextRunOf(schedules, device.udid),
                lastError: errored ? last?.title ?? null : null,
            };
        });
        return {
            serverTime: clock().toISOString(),
            release: await release(),
            plugins: options.plugins.list().map((plugin) => ({
                id: plugin.id, version: plugin.version, displayName: plugin.displayName,
                tasks: plugin.tasks.map(({ type, version, displayName }) => ({ type, version, displayName })),
            })),
            fleet: { counts: countStates(fleetDevices), devices: fleetDevices },
            recentEvents: recent.slice(0, 20).map(serializeEvent),
            unacknowledgedCount: await unacknowledgedCountFor(request),
            capabilities: {
                push: true,
                eventAck: true,
                thumbnails: true,
                contentQueue: true,
                tokens: true,
                rateLimits: rateLimitsEnabled(),
            },
        };
    });

    app.get<{ Params: { id: string } }>('/api/assets/:id/thumbnail', async (request, reply) => {
        const active = requireStore(reply);
        if (!active) return reply;
        const asset = await active.thumbnailAsset(request.params.id);
        if (!asset) return reply.code(404).send({ error: 'Asset not found' });
        const cached = thumbnailCachePath(asset.sha256);
        if (!cached) return reply.code(404).send({ error: 'The asset file is missing' });
        const send = () => reply.type('image/jpeg').header('cache-control', 'private, max-age=300')
            .send(createReadStream(cached));
        if (await exists(cached)) return send();

        const source = containedPath(dataRoot(), asset.relativePath);
        if (!source || !await exists(source)) return reply.code(404).send({ error: 'The asset file is missing' });
        await mkdir(path.dirname(cached), { recursive: true });
        // Rendered beside the cache entry and renamed in, so a crashed ffmpeg
        // never leaves a truncated JPEG that every later request would serve.
        const temporary = `${cached}.${process.pid}.tmp`;
        const item = asset.mimeType.startsWith('video/') ? await active.itemForAsset(asset.id) : null;
        const poster = item?.posterPath ? containedPath(contentRoot(), item.posterPath) : null;
        try {
            if (poster && await exists(poster)) await writeImageThumbnail(poster, temporary);
            else if (asset.mimeType.startsWith('video/')) await writeVideoThumbnail(source, temporary);
            else await writeImageThumbnail(source, temporary);
            await rename(temporary, cached);
        } catch (error) {
            request.log.warn({ assetId: asset.id, error: String(error) }, 'thumbnail render failed');
            return reply.code(503).send({ error: 'A thumbnail could not be rendered for this asset' });
        }
        return send();
    });

    app.get<{ Querystring: { limit?: string } }>('/api/content/queue', async (request, reply) => {
        const active = requireStore(reply);
        if (!active) return reply;
        const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
        // A day of history keeps a just-posted item on screen instead of having
        // it vanish out of the list the moment its schedule fires.
        const from = new Date(clock().getTime() - 86_400_000);
        return { items: (await active.queuePlans(from, limit)).map(queueItem) };
    });

    app.post<{ Params: { id: string } }>('/api/content/queue/:id/approve', async (request, reply) => {
        const active = requireStore(reply);
        if (!active) return reply;
        const plan = await active.queuePlan(request.params.id);
        if (!plan) return reply.code(404).send({ error: 'Queued post not found' });
        if (plan.scheduleId && plan.scheduleStatus === 'paused') {
            await options.scheduler.setScheduleStatus(plan.scheduleId, 'active');
            return { item: queueItem({ ...plan, scheduleStatus: 'active' }) };
        }
        // Already approved (or already posted): the operator's thumb landed
        // twice on a train, which must not be an error.
        return { item: queueItem(plan) };
    });

    app.post<{ Params: { id: string } }>('/api/content/queue/:id/skip', async (request, reply) => {
        const active = requireStore(reply);
        if (!active) return reply;
        const plan = await active.queuePlan(request.params.id);
        if (!plan) return reply.code(404).send({ error: 'Queued post not found' });
        if (plan.scheduleId && plan.scheduleStatus !== 'cancelled') {
            try {
                await options.scheduler.setScheduleStatus(plan.scheduleId, 'cancelled');
            } catch (error) {
                if (!(error instanceof ScheduleTransitionError)) throw error;
                return reply.code(409).send({ error: error.message });
            }
        }
        await active.markPlanSkipped(plan.id, clock());
        return { item: queueItem({ ...plan, scheduleStatus: 'cancelled' }) };
    });
}
