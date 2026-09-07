import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

import type { PhoneFarmPlugin, TaskDefinition, TaskExecutionContext } from './plugin.js';
import type { JsonObject, JsonValue, ScheduleTiming } from './types.js';
import { farmEntryPath } from './runtime/farm-entry.js';
import {
    CAROUSEL_MAX, CAROUSEL_MIN, MAX_CAPTION_LENGTH, formatForMedia, formatProblem, isInstagramFormat,
    type InstagramFormat,
} from './instagram/post-manifest.js';
import { INSTAGRAM_PLUGIN_ID } from './instagram/runtime-settings.js';

/**
 * Instagram automation, built the same way as the TikTok plugin next door: two versioned tasks,
 * one routine per platform behind each, a device panel and a handful of routes the dashboard's
 * network picker posts to.
 *
 * What is *not* shared with TikTok is the shape of a post. Instagram makes the operator pick a
 * surface up front, so `format` is part of the payload and of the manifest
 * (src/instagram/post-manifest.ts), and validation is per format: a reel is one video, a photo is
 * one image, a carousel is 2–20 images, and nothing mixes the two kinds of media.
 */

export interface InstagramPluginConfiguration {
    warmupEntrypoint?: string;
    postEntrypoint?: string;
    /** Android routines; picked when the device's platform is 'android'. */
    androidWarmupEntrypoint?: string;
    androidPostEntrypoint?: string;
    /** iOS bundle id. Defaults to com.burbn.instagram. */
    bundleId?: string;
    /** Android package name. Defaults to com.instagram.android. */
    packageName?: string;
}

export const INSTAGRAM_BUNDLE_ID = 'com.burbn.instagram';
export const INSTAGRAM_PACKAGE = 'com.instagram.android';

export { INSTAGRAM_PLUGIN_ID };

type WarmupSurface = 'feed' | 'reels' | 'both';

type WarmupPayload = JsonObject & {
    /** Absent means "let the persona decide how long it feels like browsing". */
    durationMinutes?: number;
    surface: WarmupSurface;
    /** The fallback model, for runs with no persona to be. */
    personality: 'skimmer' | 'casual' | 'engaged';
    likeEnabled: boolean;
    saveEnabled: boolean;
    account?: string;
    /** Browse as the account's persona (src/persona/**). Defaults on whenever an account is named. */
    persona?: boolean;
};

type PostMedia = JsonObject & {
    assetId: string;
    name: string;
    mimeType: string;
};

type PostPayload = JsonObject & {
    media: PostMedia[];
    format: InstagramFormat;
    destination: 'draft' | 'publish';
    /** Optional: an unnamed account posts from whichever one the phone is already on. */
    account?: string;
    caption?: string;
    recurringPublishConfirmed?: boolean;
};

function objectPayload(value: JsonValue): Record<string, JsonValue> {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Payload must be an object');
    return value;
}

function optionalString(value: JsonValue | undefined, name: string): string | undefined {
    if (value === undefined) return;
    if (typeof value !== 'string') throw new Error(`${name} must be a string`);
    return value;
}

/** One routine per platform behind the same task, exactly as the TikTok plugin does it. */
function isAndroid(context: TaskExecutionContext): boolean {
    return context.device.platform === 'android';
}

function entrypointFor(
    context: TaskExecutionContext,
    configuration: InstagramPluginConfiguration,
    routine: 'warmup' | 'post',
): string {
    if (isAndroid(context)) {
        const configured = routine === 'post' ? configuration.androidPostEntrypoint : configuration.androidWarmupEntrypoint;
        return configured ?? farmEntryPath(fileURLToPath(new URL(`./instagram/android/${routine}.ts`, import.meta.url)));
    }
    const configured = routine === 'post' ? configuration.postEntrypoint : configuration.warmupEntrypoint;
    return configured ?? farmEntryPath(fileURLToPath(new URL(`./instagram/${routine}.ts`, import.meta.url)));
}

function createWarmupTask(configuration: InstagramPluginConfiguration): TaskDefinition<WarmupPayload> {
    return {
        type: 'warmup', version: 1, displayName: 'Instagram warm-up',
        validate(value) {
            const input = objectPayload(value);
            const durationMinutes = input.durationMinutes;
            if (durationMinutes !== undefined && durationMinutes !== null
                && (typeof durationMinutes !== 'number' || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 180)) {
                throw new Error('durationMinutes must be between 1 and 180');
            }
            const surface = input.surface ?? 'both';
            if (surface !== 'feed' && surface !== 'reels' && surface !== 'both') {
                throw new Error('surface must be feed, reels or both');
            }
            const personality = input.personality ?? 'casual';
            if (personality !== 'skimmer' && personality !== 'casual' && personality !== 'engaged') {
                throw new Error('Invalid personality');
            }
            if (typeof input.likeEnabled !== 'boolean' || typeof input.saveEnabled !== 'boolean') {
                throw new Error('Engagement settings must be boolean');
            }
            if (input.persona !== undefined && typeof input.persona !== 'boolean') {
                throw new Error('persona must be true or false');
            }
            const account = optionalString(input.account, 'account')?.trim() || undefined;
            // No account means no handle, and a persona is a handle's — so the fallback model stands.
            const persona = input.persona ?? Boolean(account);
            if (persona && !account) throw new Error('Warming up as a persona needs an account');
            if (!persona && durationMinutes === undefined) {
                throw new Error('durationMinutes is required unless the run browses as a persona');
            }
            return {
                surface, personality, likeEnabled: input.likeEnabled, saveEnabled: input.saveEnabled, persona,
                ...(typeof durationMinutes === 'number' ? { durationMinutes } : {}),
                ...(account ? { account } : {}),
            };
        },
        summarize: (payload) => `Instagram warm-up · ${payload.surface} · ${payload.persona ? `as ${payload.account}` : payload.personality}`
            + ` · ${payload.durationMinutes ? `${payload.durationMinutes} min` : 'its own session length'}`,
        // A persona picks its own length at run time; the scheduler still needs a slot to book, so
        // an unstated duration is estimated at the middle of the default session band.
        estimateDurationMs: (payload) => (payload.durationMinutes ?? 15) * 60_000,
        retryPolicy: () => ({ retryLimit: 2, retryDelaySeconds: 60, retryBackoff: true }),
        supportsStop: () => true,
        execute: async (context, payload) => context.runProcess({
            entrypoint: entrypointFor(context, configuration, 'warmup'),
            env: {
                ...(isAndroid(context)
                    ? { INSTAGRAM_PACKAGE: configuration.packageName ?? INSTAGRAM_PACKAGE }
                    : { IOS_UDID: context.device.udid, INSTAGRAM_BUNDLE_ID: configuration.bundleId ?? INSTAGRAM_BUNDLE_ID }),
                ...(payload.durationMinutes ? { WARMUP_DURATION_MINUTES: String(payload.durationMinutes) } : {}),
                WARMUP_SURFACE: payload.surface,
                WARMUP_PERSONALITY: payload.personality,
                WARMUP_PERSONA: String(payload.persona ?? false),
                WARMUP_LIKE_ENABLED: String(payload.likeEnabled),
                WARMUP_SAVE_ENABLED: String(payload.saveEnabled),
                ...(payload.account ? { INSTAGRAM_SWITCH_ACCOUNT: payload.account } : {}),
            },
        }),
    };
}

function createPostTask(configuration: InstagramPluginConfiguration): TaskDefinition<PostPayload> {
    return {
        type: 'post', version: 1, displayName: 'Instagram post',
        validate(value, context) {
            const input = objectPayload(value);
            if (!Array.isArray(input.media) || input.media.length < 1 || input.media.length > CAROUSEL_MAX) {
                throw new Error(`Choose between 1 and ${CAROUSEL_MAX} media files`);
            }
            const media = input.media.map((item) => {
                const candidate = objectPayload(item);
                if (typeof candidate.assetId !== 'string' || typeof candidate.name !== 'string' || typeof candidate.mimeType !== 'string') {
                    throw new Error('Invalid media item');
                }
                return { assetId: candidate.assetId, name: candidate.name, mimeType: candidate.mimeType };
            });
            // An unstated format is inferred from the media, which is what the Control Center's
            // "Schedule post" does — it uploads first and never asks the operator to name a surface.
            const format = input.format === undefined || input.format === null ? formatForMedia(media) : input.format;
            if (!isInstagramFormat(format)) throw new Error('format must be reel, photo or carousel');
            const problem = formatProblem(format, media);
            if (problem) throw new Error(problem);
            if (input.destination !== 'draft' && input.destination !== 'publish') throw new Error('Invalid post destination');
            const account = optionalString(input.account, 'account')?.trim() || undefined;
            const caption = optionalString(input.caption, 'caption');
            if (caption && caption.length > MAX_CAPTION_LENGTH) {
                throw new Error(`Caption must be ${MAX_CAPTION_LENGTH.toLocaleString('en-US')} characters or fewer`);
            }
            const recurring = context.timingKind === 'daily' || context.timingKind === 'weekly';
            if (recurring && input.destination === 'publish' && input.recurringPublishConfirmed !== true) {
                throw new Error('Recurring public posts require explicit confirmation');
            }
            return {
                media, format, destination: input.destination,
                ...(account ? { account } : {}), ...(caption ? { caption } : {}),
                ...(input.recurringPublishConfirmed === true ? { recurringPublishConfirmed: true } : {}),
            };
        },
        summarize: (payload) => `Instagram ${payload.format} · ${payload.destination === 'publish' ? 'public' : 'draft'} · ${payload.media.length} media`,
        estimateDurationMs: () => 90_000,
        retryPolicy: () => ({ retryLimit: 0, retryDelaySeconds: 0, retryBackoff: false }),
        supportsStop: () => false,
        async execute(context: TaskExecutionContext, payload) {
            const byId = new Map(context.assets.map((asset) => [asset.id, asset]));
            const files = payload.media.map((media) => {
                const asset = byId.get(media.assetId);
                if (!asset) throw new Error(`Scheduled media asset ${media.assetId} is missing`);
                return { path: asset.path, name: media.name, mimeType: media.mimeType };
            });
            const manifestPath = path.join(context.workspaceDirectory, 'instagram-manifest.json');
            await writeFile(manifestPath, JSON.stringify({
                device: context.device, files, format: payload.format, destination: payload.destination,
                ...(payload.account ? { account: payload.account } : {}),
                ...(payload.caption ? { caption: payload.caption } : {}),
            }));
            return context.runProcess({
                entrypoint: entrypointFor(context, configuration, 'post'),
                args: [manifestPath],
                env: isAndroid(context)
                    ? { INSTAGRAM_PACKAGE: configuration.packageName ?? INSTAGRAM_PACKAGE }
                    : { IOS_UDID: context.device.udid, INSTAGRAM_BUNDLE_ID: configuration.bundleId ?? INSTAGRAM_BUNDLE_ID },
            });
        },
    };
}

/** The timing a form's fields describe. Shared by the panel's warm-up route and the post route. */
function timingFrom(body: Record<string, string>): ScheduleTiming {
    const kind = body.scheduleKind ?? 'now';
    if (kind === 'once') return { kind: 'once', runAt: body.runAt ?? '' };
    if (kind === 'daily') return { kind: 'daily', localTime: body.localTime ?? '', timezone: body.timezone ?? 'UTC' };
    if (kind === 'weekly') {
        return {
            kind: 'weekly', localTime: body.localTime ?? '', timezone: body.timezone ?? 'UTC',
            weekdays: (body.weekdays ?? '').split(',').filter(Boolean).map(Number),
        };
    }
    return { kind: 'now' };
}

export function createInstagramPlugin(configuration: InstagramPluginConfiguration = {}): PhoneFarmPlugin {
    return {
        id: INSTAGRAM_PLUGIN_ID,
        version: '0.1.0',
        displayName: 'Instagram automation',
        tasks: [createWarmupTask(configuration), createPostTask(configuration)],
        devicePanels: [{
            id: 'instagram-controls', title: 'Instagram',
            fragmentPath: fileURLToPath(new URL('../static/instagram/device-panel.html', import.meta.url)), order: 110,
        }],
        async registerRoutes(context) {
            const deviceData = async (udid: string) => (await context.loadDevices()).find((device) => device.udid === udid);

            /**
             * A phone's Instagram handles. They are not its TikTok handles, so they live under this
             * plugin's own pluginData key and get their own route rather than sharing
             * `PATCH /api/devices/:udid/accounts`.
             */
            context.app.patch<{ Params: { udid: string }; Body: { accounts?: string[] } }>(
                '/api/devices/:udid/instagram/accounts', async (request, reply) => {
                    if (!Array.isArray(request.body.accounts)) return reply.code(400).send({ error: 'accounts must be an array' });
                    const accounts = [...new Set(request.body.accounts.map((value) => value.trim()).filter(Boolean)
                        .map((value) => value.startsWith('@') ? value : `@${value}`))];
                    if (accounts.some((value) => !/^@[A-Za-z0-9._]{1,30}$/.test(value))) {
                        return reply.code(400).send({ error: 'Instagram handles may contain letters, numbers, periods and underscores, up to 30 characters' });
                    }
                    const found = await context.mutateDevices((devices) => {
                        const device = devices.find(({ udid }) => udid === request.params.udid);
                        if (!device) return false;
                        device.pluginData = {
                            ...device.pluginData,
                            [INSTAGRAM_PLUGIN_ID]: { ...device.pluginData[INSTAGRAM_PLUGIN_ID], accounts },
                        };
                        return true;
                    });
                    if (!found) return reply.code(404).send({ error: 'Device is not registered' });
                    return { accounts };
                },
            );

            /** The device panel's "Warm up" form, and the built-in dialog when Instagram is picked. */
            context.app.post<{ Params: { udid: string }; Body: Record<string, string> }>(
                '/api/devices/:udid/fragments/instagram-warmup-run', async (request, reply) => {
                    const device = await deviceData(request.params.udid);
                    if (!device) return reply.code(404).send({ error: 'Device is not registered' });
                    if (device.disabled) {
                        return reply.code(409).send({ error: 'This device is disconnected — reconnect it before scheduling automation' });
                    }
                    const body = request.body;
                    try {
                        await context.scheduler.createTask({
                            deviceUdid: device.udid,
                            task: {
                                pluginId: INSTAGRAM_PLUGIN_ID, taskType: 'warmup', taskVersion: 1,
                                payload: {
                                    surface: body.surface?.trim() || 'both',
                                    personality: body.personality?.trim() || 'casual',
                                    likeEnabled: body.likeEnabled === 'on', saveEnabled: body.saveEnabled === 'on',
                                    // Blank duration on the panel means "let the persona decide".
                                    ...(body.durationMinutes?.trim() ? { durationMinutes: Number(body.durationMinutes) } : {}),
                                    ...(body.account?.trim() ? { account: body.account.trim() } : {}),
                                    ...(body.persona === undefined ? {} : { persona: body.persona === 'on' }),
                                },
                            },
                            timing: timingFrom(body),
                            runWindowMinutes: body.runWindowMinutes ? Number(body.runWindowMinutes) : undefined,
                        }, device.pluginData[INSTAGRAM_PLUGIN_ID] ?? {});
                        return reply.code(202).type('text/html').send(await context.renderActivity(device.udid));
                    } catch (error) {
                        return reply.type('text/html')
                            .send(await context.renderActivity(device.udid, error instanceof Error ? error.message : String(error)));
                    }
                },
            );

            context.app.get<{ Params: { udid: string } }>('/api/devices/:udid/instagram/posts/current', async (request) => {
                const latest = (await context.scheduler.listExecutions(25, request.params.udid))
                    .find(({ pluginId, taskType }) => pluginId === INSTAGRAM_PLUGIN_ID && taskType === 'post');
                if (!latest) return { status: 'idle', logs: [] };
                const detail = await context.scheduler.execution(latest.id);
                return { ...latest, destination: latest.payload.destination ?? null, logs: detail?.logs ?? [] };
            });

            /**
             * Upload and schedule, the twin of the TikTok plugin's `/api/devices/:udid/posts`.
             * `format` may be sent explicitly; when it is not, it is inferred from the uploaded
             * media, and either way it is validated against the files before anything is stored.
             */
            context.app.post<{ Params: { udid: string } }>('/api/devices/:udid/instagram/posts', async (request, reply) => {
                const device = await deviceData(request.params.udid);
                if (!device) return reply.code(404).send({ error: 'Device is not registered' });
                if (device.disabled) return reply.code(409).send({ error: 'This device is disconnected — reconnect it before posting' });
                const dataRoot = path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
                const assetRoot = path.join(dataRoot, 'assets');
                await mkdir(assetRoot, { recursive: true });
                const directory = await mkdtemp(path.join(assetRoot, 'instagram-post-'));
                const files: Array<{ path: string; name: string; mimeType: string }> = [];
                const fields = new Map<string, string>();
                let assetIds: string[] = [];
                try {
                    for await (const part of request.parts()) {
                        if (part.type === 'field') { fields.set(part.fieldname, String(part.value)); continue; }
                        if (part.fieldname !== 'media') continue;
                        const name = path.basename(part.filename || `upload-${files.length + 1}`).replace(/[^a-zA-Z0-9._-]/g, '_');
                        const filePath = path.join(directory, `${String(files.length).padStart(2, '0')}-${name}`);
                        await pipeline(part.file, createWriteStream(filePath, { flags: 'wx' }));
                        if (part.file.truncated) throw new Error(`${name} exceeds the upload limit`);
                        files.push({ path: filePath, name, mimeType: part.mimetype });
                    }
                    if (files.length < 1 || files.length > CAROUSEL_MAX) {
                        throw new Error(`Choose between 1 and ${CAROUSEL_MAX} media files (a carousel is ${CAROUSEL_MIN}–${CAROUSEL_MAX} images)`);
                    }
                    const requested = fields.get('format')?.trim();
                    const format = requested ? requested : formatForMedia(files);
                    if (!isInstagramFormat(format)) throw new Error('format must be reel, photo or carousel');
                    const problem = formatProblem(format, files);
                    if (problem) throw new Error(problem);
                    const destination = fields.get('destination');
                    if (destination !== 'draft' && destination !== 'publish') throw new Error('Choose Draft or Post');
                    const account = fields.get('account')?.trim();
                    const timing = fields.has('timing') ? JSON.parse(fields.get('timing')!) as ScheduleTiming : { kind: 'now' } as const;
                    const stored = await context.scheduler.registerAssets(await Promise.all(files.map(async (file) => ({
                        relativePath: path.relative(dataRoot, file.path), originalName: file.name, mimeType: file.mimeType,
                        size: (await stat(file.path)).size,
                        sha256: await new Promise<string>((resolve, reject) => {
                            const hash = crypto.createHash('sha256');
                            createReadStream(file.path).on('data', (chunk) => hash.update(chunk)).once('error', reject).once('end', () => resolve(hash.digest('hex')));
                        }),
                    }))));
                    assetIds = stored.map(({ id }) => id);
                    const schedule = await context.scheduler.createTask({
                        deviceUdid: device.udid,
                        task: {
                            pluginId: INSTAGRAM_PLUGIN_ID, taskType: 'post', taskVersion: 1,
                            payload: {
                                media: stored.map(({ id, name, mimeType }) => ({ assetId: id, name, mimeType })),
                                format, destination,
                                ...(account ? { account } : {}),
                                ...(fields.get('caption')?.trim() ? { caption: fields.get('caption')!.trim() } : {}),
                                ...(fields.get('recurringPublishConfirmed') === 'true' ? { recurringPublishConfirmed: true } : {}),
                            },
                        },
                        timing,
                        runWindowMinutes: fields.get('runWindowMinutes') ? Number(fields.get('runWindowMinutes')) : undefined,
                    }, device.pluginData[INSTAGRAM_PLUGIN_ID] ?? {}, new Date(), assetIds);
                    return reply.code(202).send(schedule);
                } catch (error) {
                    if (assetIds.length) await context.scheduler.deleteAssets(assetIds);
                    await rm(directory, { recursive: true, force: true });
                    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
                }
            });
        },
    };
}

export default createInstagramPlugin;
