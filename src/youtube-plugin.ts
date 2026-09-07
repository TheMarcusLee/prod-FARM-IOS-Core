import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PhoneFarmPlugin, TaskDefinition, TaskExecutionContext } from './plugin.js';
import type { JsonObject, JsonValue } from './types.js';
import { farmEntryPath } from './runtime/farm-entry.js';
import {
    MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH, YOUTUBE_ANDROID_PACKAGE, YOUTUBE_IOS_BUNDLE_ID,
} from './youtube/app.js';

/**
 * YouTube Shorts, phone-driven, built the same way the TikTok plugin is: two tasks, one routine
 * per platform behind each of them, and nothing in this file that knows how a phone works.
 *
 * - `post` uploads one vertical clip (≤ 60 s) as a Short, with a title and an optional
 *   description, either published publicly or kept as a draft.
 * - `warmup` browses the Shorts feed as the account's persona (src/persona), liking, subscribing
 *   and occasionally commenting, with human pacing from src/motion, and ends on the home screen.
 */

export interface YouTubePluginConfiguration {
    /** Android routines; picked when the device's platform is 'android'. */
    androidPostEntrypoint?: string;
    androidWarmupEntrypoint?: string;
    /** iOS routines, driven through WebDriverAgent. */
    postEntrypoint?: string;
    warmupEntrypoint?: string;
    /** iOS bundle id, default com.google.ios.youtube. */
    bundleId?: string;
    /** Android package name, default com.google.android.youtube. */
    packageName?: string;
}

export { YOUTUBE_PLUGIN_ID } from './plugin-ids.js';
import { YOUTUBE_PLUGIN_ID } from './plugin-ids.js';

type PostMedia = JsonObject & {
    assetId: string;
    name: string;
    mimeType: string;
};

type PostPayload = JsonObject & {
    media: PostMedia[];
    title: string;
    destination: 'draft' | 'publish';
    account: string;
    caption?: string;
    madeForKids?: boolean;
    recurringPublishConfirmed?: boolean;
};

type WarmupPayload = JsonObject & {
    /** Absent means "let the persona decide how long it feels like watching". */
    durationMinutes?: number;
    /** The fallback model, kept for runs that predate personas or deliberately ask for it. */
    personality: 'skimmer' | 'casual' | 'engaged';
    likeEnabled: boolean;
    subscribeEnabled: boolean;
    commentEnabled: boolean;
    account?: string;
    /** Browse as the account's persona rather than the personality coin flips. */
    persona?: boolean;
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

function isAndroid(context: TaskExecutionContext): boolean {
    return context.device.platform === 'android';
}

function entrypointFor(
    context: TaskExecutionContext, configuration: YouTubePluginConfiguration, routine: 'warmup' | 'post',
): string {
    if (isAndroid(context)) {
        const configured = routine === 'post' ? configuration.androidPostEntrypoint : configuration.androidWarmupEntrypoint;
        return configured ?? farmEntryPath(fileURLToPath(new URL(`./youtube/android/${routine}.ts`, import.meta.url)));
    }
    const configured = routine === 'post' ? configuration.postEntrypoint : configuration.warmupEntrypoint;
    return configured ?? farmEntryPath(fileURLToPath(new URL(`./youtube/${routine}.ts`, import.meta.url)));
}

function appEnvironment(context: TaskExecutionContext, configuration: YouTubePluginConfiguration): Record<string, string> {
    return isAndroid(context)
        ? { YOUTUBE_PACKAGE: configuration.packageName ?? YOUTUBE_ANDROID_PACKAGE }
        : { IOS_UDID: context.device.udid, YOUTUBE_BUNDLE_ID: configuration.bundleId ?? YOUTUBE_IOS_BUNDLE_ID };
}

function createPostTask(configuration: YouTubePluginConfiguration): TaskDefinition<PostPayload> {
    return {
        type: 'post', version: 1, displayName: 'YouTube Short',
        validate(value, context) {
            const input = objectPayload(value);
            if (!Array.isArray(input.media) || input.media.length !== 1) {
                throw new Error('A Short is exactly one video file');
            }
            const media = input.media.map((item) => {
                const candidate = objectPayload(item);
                if (typeof candidate.assetId !== 'string' || typeof candidate.name !== 'string' || typeof candidate.mimeType !== 'string') {
                    throw new Error('Invalid media item');
                }
                if (!candidate.mimeType.startsWith('video/')) throw new Error('A Short must be a video, not an image');
                return { assetId: candidate.assetId, name: candidate.name, mimeType: candidate.mimeType };
            });
            const title = optionalString(input.title, 'title')?.trim();
            if (!title) throw new Error('A Short needs a title');
            if (title.length > MAX_TITLE_LENGTH) throw new Error(`Title must be ${MAX_TITLE_LENGTH} characters or fewer`);
            if (input.destination !== 'draft' && input.destination !== 'publish') throw new Error('Invalid post destination');
            if (typeof input.account !== 'string' || !input.account.trim()) throw new Error('Choose a YouTube channel');
            const caption = optionalString(input.caption, 'caption');
            if (caption && caption.length > MAX_DESCRIPTION_LENGTH) {
                throw new Error(`Description must be ${MAX_DESCRIPTION_LENGTH.toLocaleString('en-US')} characters or fewer`);
            }
            if (input.madeForKids !== undefined && typeof input.madeForKids !== 'boolean') {
                throw new Error('madeForKids must be true or false');
            }
            // Publishing on a repeating schedule posts publicly again and again; make it deliberate.
            const recurring = context.timingKind === 'daily' || context.timingKind === 'weekly';
            if (recurring && input.destination === 'publish' && input.recurringPublishConfirmed !== true) {
                throw new Error('Recurring public posts require explicit confirmation');
            }
            return {
                media, title, destination: input.destination, account: input.account,
                ...(caption ? { caption } : {}),
                ...(input.madeForKids === true ? { madeForKids: true } : {}),
                ...(input.recurringPublishConfirmed === true ? { recurringPublishConfirmed: true } : {}),
            };
        },
        summarize: (payload) => `Short · ${payload.destination === 'publish' ? 'public' : 'draft'} · ${payload.title}`,
        estimateDurationMs: () => 90_000,
        // Never retried: a second attempt after a tap that did land is a duplicate upload.
        retryPolicy: () => ({ retryLimit: 0, retryDelaySeconds: 0, retryBackoff: false }),
        supportsStop: () => false,
        async execute(context, payload) {
            const byId = new Map(context.assets.map((asset) => [asset.id, asset]));
            const files = payload.media.map((media) => {
                const asset = byId.get(media.assetId);
                if (!asset) throw new Error(`Scheduled media asset ${media.assetId} is missing`);
                return { path: asset.path, name: media.name, mimeType: media.mimeType };
            });
            const manifestPath = path.join(context.workspaceDirectory, 'manifest.json');
            await writeFile(manifestPath, JSON.stringify({
                device: context.device, files, title: payload.title,
                destination: payload.destination, account: payload.account,
                ...(payload.caption ? { caption: payload.caption } : {}),
                ...(payload.madeForKids === true ? { madeForKids: true } : {}),
            }));
            return context.runProcess({
                entrypoint: entrypointFor(context, configuration, 'post'),
                args: [manifestPath],
                env: appEnvironment(context, configuration),
            });
        },
    };
}

function createWarmupTask(configuration: YouTubePluginConfiguration): TaskDefinition<WarmupPayload> {
    return {
        type: 'warmup', version: 1, displayName: 'YouTube warm-up',
        validate(value) {
            const input = objectPayload(value);
            const durationMinutes = input.durationMinutes;
            if (durationMinutes !== undefined && durationMinutes !== null
                && (typeof durationMinutes !== 'number' || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 180)) {
                throw new Error('durationMinutes must be between 1 and 180');
            }
            // The dashboard's plugin-driven picker sends only a duration, so everything else has a
            // sensible default rather than being required.
            const personality = input.personality ?? 'casual';
            if (personality !== 'skimmer' && personality !== 'casual' && personality !== 'engaged') {
                throw new Error('Invalid personality');
            }
            for (const name of ['likeEnabled', 'subscribeEnabled', 'commentEnabled', 'persona'] as const) {
                if (input[name] !== undefined && typeof input[name] !== 'boolean') {
                    throw new Error(`${name} must be true or false`);
                }
            }
            const account = optionalString(input.account, 'account')?.trim();
            // No account means no handle, and a persona is a handle's — so the old model stands.
            const persona = (input.persona as boolean | undefined) ?? Boolean(account);
            if (persona && !account) throw new Error('Warming up as a persona needs an account');
            if (!persona && durationMinutes === undefined) {
                throw new Error('durationMinutes is required unless the run browses as a persona');
            }
            return {
                personality, persona,
                likeEnabled: (input.likeEnabled as boolean | undefined) ?? true,
                subscribeEnabled: (input.subscribeEnabled as boolean | undefined) ?? true,
                // Commenting is off unless it is asked for: it is the one thing here that is public.
                commentEnabled: (input.commentEnabled as boolean | undefined) ?? false,
                ...(typeof durationMinutes === 'number' ? { durationMinutes } : {}),
                ...(account ? { account } : {}),
            };
        },
        summarize: (payload) => `Warm up · ${payload.persona ? `as ${payload.account}` : payload.personality} · `
            + `${payload.durationMinutes ? `${payload.durationMinutes} min` : 'its own session length'}`,
        // A persona picks its own length at run time; the scheduler still needs a slot to book.
        estimateDurationMs: (payload) => (payload.durationMinutes ?? 15) * 60_000,
        retryPolicy: () => ({ retryLimit: 2, retryDelaySeconds: 60, retryBackoff: true }),
        supportsStop: () => true,
        execute: async (context, payload) => context.runProcess({
            entrypoint: entrypointFor(context, configuration, 'warmup'),
            env: {
                ...appEnvironment(context, configuration),
                ...(payload.durationMinutes ? { YOUTUBE_DURATION_MINUTES: String(payload.durationMinutes) } : {}),
                YOUTUBE_PERSONALITY: payload.personality,
                YOUTUBE_PERSONA: String(payload.persona ?? false),
                YOUTUBE_LIKE_ENABLED: String(payload.likeEnabled),
                YOUTUBE_SUBSCRIBE_ENABLED: String(payload.subscribeEnabled),
                YOUTUBE_COMMENT_ENABLED: String(payload.commentEnabled),
                ...(payload.account ? { YOUTUBE_SWITCH_ACCOUNT: payload.account } : {}),
            },
        }),
    };
}

export function createYouTubePlugin(configuration: YouTubePluginConfiguration = {}): PhoneFarmPlugin {
    return {
        id: YOUTUBE_PLUGIN_ID,
        version: '0.1.0',
        displayName: 'YouTube Shorts',
        tasks: [createPostTask(configuration), createWarmupTask(configuration)],
    };
}
