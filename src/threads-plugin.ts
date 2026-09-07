import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PhoneFarmPlugin, TaskDefinition, TaskExecutionContext } from './plugin.js';
import type { JsonObject, JsonValue } from './types.js';
import { farmEntryPath } from './runtime/farm-entry.js';
import {
    MAX_THREAD_IMAGES, MAX_THREAD_LENGTH, describeFormat, threadFormat, type ThreadFormat,
} from './threads/post-manifest.js';

/**
 * Threads (Meta), phone-driven, built the same way as the TikTok plugin: one task per thing an
 * operator asks a phone to do, one routine per platform behind it, and nothing here touching a
 * device itself — `execute` writes a manifest and spawns the routine.
 */
export interface ThreadsPluginConfiguration {
    /** iOS routines, driven through WebDriverAgent. */
    postEntrypoint?: string;
    warmupEntrypoint?: string;
    /** Android routines; picked when the device's platform is 'android'. See docs/threads.md. */
    androidPostEntrypoint?: string;
    androidWarmupEntrypoint?: string;
    /** iOS bundle id. Threads ships under Instagram's "Barcelona" codename. */
    bundleId?: string;
    /** Android package name. */
    packageName?: string;
}

export { THREADS_PLUGIN_ID } from './plugin-ids.js';
import { THREADS_PLUGIN_ID } from './plugin-ids.js';
export const THREADS_IOS_BUNDLE_ID = 'com.burbn.barcelona';
export const THREADS_ANDROID_PACKAGE = 'com.instagram.barcelona';

type PostMedia = JsonObject & {
    assetId: string;
    name: string;
    mimeType: string;
};

type PostPayload = JsonObject & {
    /** Ordered: media[0] is the first card of a carousel. Empty for a text-only thread. */
    media: PostMedia[];
    destination: 'draft' | 'publish';
    account: string;
    text?: string;
    recurringPublishConfirmed?: boolean;
};

type WarmupPayload = JsonObject & {
    /** Absent means "let the persona decide how long it feels like browsing". */
    durationMinutes?: number;
    likeEnabled: boolean;
    repostEnabled: boolean;
    followEnabled?: boolean;
    account?: string;
    /**
     * Browse as the account's persona (src/persona/**). Defaults on whenever the task names an
     * account, because every handle has a persona — a stored one, or the default from the handle.
     */
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

/** One routine per platform behind the same task, exactly as the TikTok plugin does it. */
function isAndroid(context: TaskExecutionContext): boolean {
    return context.device.platform === 'android';
}

function entrypointFor(
    context: TaskExecutionContext,
    configuration: ThreadsPluginConfiguration,
    routine: 'warmup' | 'post',
): string {
    if (isAndroid(context)) {
        const configured = routine === 'post' ? configuration.androidPostEntrypoint : configuration.androidWarmupEntrypoint;
        return configured ?? farmEntryPath(fileURLToPath(new URL(`./threads/android/${routine}.ts`, import.meta.url)));
    }
    const configured = routine === 'post' ? configuration.postEntrypoint : configuration.warmupEntrypoint;
    return configured ?? farmEntryPath(fileURLToPath(new URL(`./threads/${routine}.ts`, import.meta.url)));
}

function appEnvironment(context: TaskExecutionContext, configuration: ThreadsPluginConfiguration): Record<string, string> {
    return isAndroid(context)
        ? { THREADS_PACKAGE: configuration.packageName ?? THREADS_ANDROID_PACKAGE }
        : { IOS_UDID: context.device.udid, THREADS_BUNDLE_ID: configuration.bundleId ?? THREADS_IOS_BUNDLE_ID };
}

function createWarmupTask(configuration: ThreadsPluginConfiguration): TaskDefinition<WarmupPayload> {
    return {
        type: 'warmup', version: 1, displayName: 'Threads warm-up',
        validate(value) {
            const input = objectPayload(value);
            const durationMinutes = input.durationMinutes;
            if (durationMinutes !== undefined && durationMinutes !== null
                && (typeof durationMinutes !== 'number' || !Number.isInteger(durationMinutes)
                    || durationMinutes < 1 || durationMinutes > 180)) {
                throw new Error('durationMinutes must be between 1 and 180');
            }
            if (typeof input.likeEnabled !== 'boolean' || typeof input.repostEnabled !== 'boolean') {
                throw new Error('Engagement settings must be boolean');
            }
            if (input.followEnabled !== undefined && typeof input.followEnabled !== 'boolean') {
                throw new Error('followEnabled must be true or false');
            }
            if (input.persona !== undefined && typeof input.persona !== 'boolean') {
                throw new Error('persona must be true or false');
            }
            const account = optionalString(input.account, 'account');
            // No account means no handle, and a persona is a handle's.
            const persona = input.persona ?? Boolean(account);
            if (persona && !account) throw new Error('Browsing as a persona needs an account');
            if (!persona && durationMinutes === undefined) {
                throw new Error('durationMinutes is required unless the run browses as a persona');
            }
            return {
                likeEnabled: input.likeEnabled, repostEnabled: input.repostEnabled, persona,
                ...(typeof input.followEnabled === 'boolean' ? { followEnabled: input.followEnabled } : {}),
                ...(typeof durationMinutes === 'number' ? { durationMinutes } : {}),
                ...(account ? { account } : {}),
            };
        },
        summarize: (payload) => `Threads warm-up · ${payload.persona ? `as ${payload.account}` : 'no persona'} · `
            + `${payload.durationMinutes ? `${payload.durationMinutes} min` : 'its own session length'}`,
        // A persona picks its own length at run time; the scheduler still needs a slot to book, so
        // an unstated duration is estimated at the middle of the default session band.
        estimateDurationMs: (payload) => (payload.durationMinutes ?? 15) * 60_000,
        retryPolicy: () => ({ retryLimit: 2, retryDelaySeconds: 60, retryBackoff: true }),
        supportsStop: () => true,
        execute: async (context, payload) => context.runProcess({
            entrypoint: entrypointFor(context, configuration, 'warmup'),
            env: {
                ...appEnvironment(context, configuration),
                ...(payload.durationMinutes ? { WARMUP_DURATION_MINUTES: String(payload.durationMinutes) } : {}),
                WARMUP_PERSONA: String(payload.persona ?? false),
                WARMUP_LIKE_ENABLED: String(payload.likeEnabled),
                WARMUP_REPOST_ENABLED: String(payload.repostEnabled),
                ...(payload.followEnabled === undefined ? {} : { WARMUP_FOLLOW_ENABLED: String(payload.followEnabled) }),
                ...(payload.account ? { THREADS_SWITCH_ACCOUNT: payload.account } : {}),
            },
        }),
    };
}

/**
 * Validation of a thread's shape lives in `threadFormat` so the plugin, the routines and the
 * dashboard cannot disagree about what "carousel" means or how many images fit in one.
 */
export function validatePostShape(
    media: ReadonlyArray<{ name: string; mimeType: string }>,
    text?: string,
): ThreadFormat {
    if (media.length > MAX_THREAD_IMAGES) {
        throw new Error(`A thread carries at most ${MAX_THREAD_IMAGES} images; ${media.length} were given`);
    }
    if (text !== undefined && text.length > MAX_THREAD_LENGTH) {
        throw new Error(`Thread text must be ${MAX_THREAD_LENGTH} characters or fewer`);
    }
    if (!media.length && !text?.trim()) throw new Error('A thread needs text, media, or both');
    return threadFormat(media, text);
}

function createPostTask(configuration: ThreadsPluginConfiguration): TaskDefinition<PostPayload> {
    return {
        type: 'post', version: 1, displayName: 'Threads post',
        validate(value, context) {
            const input = objectPayload(value);
            const rawMedia = input.media ?? [];
            if (!Array.isArray(rawMedia)) throw new Error('media must be an array');
            const media = rawMedia.map((item) => {
                const candidate = objectPayload(item);
                if (typeof candidate.assetId !== 'string' || typeof candidate.name !== 'string' || typeof candidate.mimeType !== 'string') {
                    throw new Error('Invalid media item');
                }
                return { assetId: candidate.assetId, name: candidate.name, mimeType: candidate.mimeType };
            });
            if (input.destination !== 'draft' && input.destination !== 'publish') throw new Error('Invalid post destination');
            if (typeof input.account !== 'string' || !input.account.trim()) throw new Error('Choose a Threads account');
            const text = optionalString(input.text, 'text');
            // Throws on an over-long body, on a mix of images and video, on more than one video,
            // on more than twenty images, and on a post that is neither text nor media.
            validatePostShape(media, text);
            const recurring = context.timingKind === 'daily' || context.timingKind === 'weekly';
            if (recurring && input.destination === 'publish' && input.recurringPublishConfirmed !== true) {
                throw new Error('Recurring public posts require explicit confirmation');
            }
            return {
                media, destination: input.destination, account: input.account,
                ...(text ? { text } : {}),
                ...(input.recurringPublishConfirmed === true ? { recurringPublishConfirmed: true } : {}),
            };
        },
        summarize: (payload) => `Thread · ${payload.destination === 'publish' ? 'public' : 'draft'} · `
            + describeFormat(threadFormat(payload.media, payload.text), payload.media.length),
        estimateDurationMs: (payload) => 45_000 + (payload.media.length * 10_000),
        retryPolicy: () => ({ retryLimit: 0, retryDelaySeconds: 0, retryBackoff: false }),
        supportsStop: () => false,
        async execute(context: TaskExecutionContext, payload) {
            const byId = new Map(context.assets.map((asset) => [asset.id, asset]));
            const files = payload.media.map((media) => {
                const asset = byId.get(media.assetId);
                if (!asset) throw new Error(`Scheduled media asset ${media.assetId} is missing`);
                return { path: asset.path, name: media.name, mimeType: media.mimeType };
            });
            const manifestPath = path.join(context.workspaceDirectory, 'threads-manifest.json');
            await writeFile(manifestPath, JSON.stringify({
                device: context.device, files, destination: payload.destination, account: payload.account,
                ...(payload.text ? { text: payload.text } : {}),
            }));
            return context.runProcess({
                entrypoint: entrypointFor(context, configuration, 'post'),
                args: [manifestPath],
                env: appEnvironment(context, configuration),
            });
        },
    };
}

export function createThreadsPlugin(configuration: ThreadsPluginConfiguration = {}): PhoneFarmPlugin {
    return {
        id: THREADS_PLUGIN_ID,
        version: '0.1.0',
        displayName: 'Threads automation',
        tasks: [createWarmupTask(configuration), createPostTask(configuration)],
    };
}
