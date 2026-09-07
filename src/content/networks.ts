/**
 * One place that knows which plugin posts to which network.
 *
 * Before creators existed the drip queue only had one answer — TikTok — and the
 * plugin id was a constant in `runner.ts`. A creator owns accounts on several
 * networks at once, so every planned post now has to name its own plugin, its
 * own task, and the payload shape that plugin's `post` validator will accept.
 * Those three things disagree between the four plugins (YouTube wants a `title`,
 * Threads wants `text`, Instagram calls a slideshow a `carousel`), so they are
 * settled here rather than in the planner.
 *
 * `NETWORK_TASKS` is the fallback, not the authority: `taskForNetwork` prefers
 * the registry the app actually booted with, so a farm that ships a replacement
 * TikTok plugin under a different version gets the version it registered.
 */

import type { PluginRegistry } from '../registry.js';
import type { JsonObject } from '../types.js';
import { NETWORKS, limitsFor, type Network, type PostFormat } from './formats.js';
import type { PostDestination } from '../database/schema-content.js';

/** Every network an account can live on. The order is the order the UI lists them in. */
export const NETWORK_IDS = ['tiktok', 'instagram', 'youtube', 'threads'] as const;

export type NetworkId = (typeof NETWORK_IDS)[number];

export interface NetworkTask {
    pluginId: string;
    taskType: string;
    taskVersion: number;
}

/** network → the plugin and task that posts to it. Every one is `post` at version 1 today. */
export const NETWORK_TASKS: Record<NetworkId, NetworkTask> = {
    tiktok: { pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1 },
    instagram: { pluginId: 'com.backline.instagram', taskType: 'post', taskVersion: 1 },
    youtube: { pluginId: 'com.backline.youtube', taskType: 'post', taskVersion: 1 },
    threads: { pluginId: 'com.backline.threads', taskType: 'post', taskVersion: 1 },
};

export function isNetwork(value: unknown): value is NetworkId {
    return typeof value === 'string' && (NETWORK_IDS as readonly string[]).includes(value);
}

/** The label the dashboard and the plan report use. Reads the format table so the two never drift. */
export function networkLabel(network: NetworkId): string {
    return NETWORKS[network as Network]?.label ?? network;
}

/**
 * The task a post on this network becomes. When a registry is handed over, the
 * highest `post` version that plugin actually registered wins — the static table
 * is only the answer for a process that has no registry to ask (the planner in a
 * worker built without the dashboard's plugin list, and every unit test).
 */
export function taskForNetwork(network: NetworkId, plugins?: PluginRegistry): NetworkTask {
    const fallback = NETWORK_TASKS[network];
    if (!plugins) return fallback;
    const plugin = plugins.list().find(({ id }) => id === fallback.pluginId);
    const versions = (plugin?.tasks ?? [])
        .filter(({ type }) => type === fallback.taskType)
        .map(({ version }) => version);
    if (!versions.length) return fallback;
    return { ...fallback, taskVersion: Math.max(...versions) };
}

export interface PostMedia extends JsonObject {
    assetId: string;
    name: string;
    mimeType: string;
}

export interface NetworkPostInput {
    network: NetworkId;
    media: PostMedia[];
    format: PostFormat;
    destination: PostDestination;
    account: string;
    caption?: string;
    /** Index into `media` of the slide the post leads with. Slideshow only. */
    cover?: number;
}

/** Instagram's own three words for the same three things. */
const INSTAGRAM_FORMAT: Record<PostFormat, string> = {
    video: 'reel', photo: 'photo', slideshow: 'carousel',
};

/**
 * Why this network cannot carry this post, or undefined when it can.
 *
 * A sentence, because it goes straight into the plan report an operator reads: a
 * 35-slide TikTok slideshow fanned out to Instagram has to say *why* it was
 * dropped, rather than arriving there silently truncated to twenty.
 */
export function formatProblemFor(network: NetworkId, format: PostFormat, count: number): string | undefined {
    const limits = limitsFor(network as Network, format);
    if (!limits) return `${networkLabel(network)} does not take ${format} posts`;
    if (count < limits.minFiles || count > limits.maxFiles) {
        return `${networkLabel(network)} takes ${limits.minFiles}–${limits.maxFiles} files in a ${format}, not ${count}`;
    }
    return undefined;
}

/**
 * The payload the network's own `post` validator accepts. The four plugins do not
 * agree on a shape and there is no value in pretending they do: YouTube's Short is
 * a title plus an optional description, a thread is `text`, and only TikTok has a
 * cover index. Each branch below is the shape its plugin validates.
 */
export function postPayloadFor(input: NetworkPostInput): JsonObject {
    const { network, media, destination, account, caption } = input;
    if (network === 'youtube') {
        // A Short's title is required and short; the caption becomes the description.
        const title = (caption ?? media[0]?.name ?? account).slice(0, 100).trim() || account;
        return {
            media, title, destination, account,
            ...(caption && caption !== title ? { caption } : {}),
        };
    }
    if (network === 'threads') {
        return { media, destination, account, ...(caption ? { text: caption } : {}) };
    }
    if (network === 'instagram') {
        return {
            media, format: INSTAGRAM_FORMAT[input.format], destination, account,
            ...(caption ? { caption } : {}),
        };
    }
    return {
        media, format: input.format, destination, account,
        ...(input.cover === undefined ? {} : { cover: input.cover }),
        ...(caption ? { caption } : {}),
    };
}
