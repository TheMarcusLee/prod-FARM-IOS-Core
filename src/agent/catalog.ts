import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
    loadSelectorOverrides, overrideFor, selectorOverridesPath,
    type SelectorEntryList, type SelectorOverride, type SelectorTable,
} from '../drivers/selector-overrides.js';
import { INSTAGRAM_PLUGIN_ID, THREADS_PLUGIN_ID, TIKTOK_PLUGIN_ID, YOUTUBE_PLUGIN_ID } from '../plugin-ids.js';

import { POST_SELECTORS as TIKTOK_POST, TIKTOK_ANDROID_PACKAGE } from '../tiktok/android/post.js';
import { FEED_SELECTORS as TIKTOK_FEED } from '../tiktok/android/doomscroll.js';
import { POST_SELECTORS as INSTAGRAM_POST, INSTAGRAM_ANDROID_PACKAGE } from '../instagram/android/post.js';
import { FEED_SELECTORS as INSTAGRAM_FEED } from '../instagram/android/warmup.js';
import { POST_SELECTORS as YOUTUBE_POST, YOUTUBE_ANDROID_PACKAGE } from '../youtube/android/post.js';
import { FEED_SELECTORS as YOUTUBE_FEED } from '../youtube/android/warmup.js';
import { POST_SELECTORS as THREADS_POST, THREADS_ANDROID_PACKAGE } from '../threads/android/post.js';
import { FEED_SELECTORS as THREADS_FEED } from '../threads/android/warmup.js';

/**
 * What there is to calibrate: every Android selector table in the farm, with the plugin that owns
 * it, the app it drives, the flow it belongs to and the doc page an operator would read.
 *
 * The tables themselves stay where they are — at the top of the routine that uses them — because
 * that is where somebody correcting a flow will look. This module is the index over them, and the
 * only place that knows a "flow" is a pair of (plugin, post|warmup).
 */

export type FlowName = 'post' | 'warmup';

export interface SelectorFlow {
    plugin: string;
    flow: FlowName;
    /** What the network is called in the UI: TikTok, Instagram, … */
    network: string;
    /** Android package the routine drives. */
    appPackage: string;
    /** One paragraph an agent can act on: what the routine does, in order. */
    description: string;
    /** Doc page under docs/, without the extension. */
    docs: string;
    table: SelectorTable;
    /** Absolute path of the module declaring the table, so the GUESS markers can be read back. */
    sourcePath: string;
    /** The exported name of the table in that module. */
    tableName: string;
}

function here(relative: string): string {
    return fileURLToPath(new URL(relative, import.meta.url));
}

export const SELECTOR_FLOWS: readonly SelectorFlow[] = [
    {
        plugin: TIKTOK_PLUGIN_ID, flow: 'post', network: 'TikTok', appPackage: TIKTOK_ANDROID_PACKAGE,
        description: 'Publish or draft a TikTok: profile tab → optional account switch → the "+" create button → '
            + 'Upload → gallery picker (photo tab and multi-select for a slideshow) → Next through the editor → '
            + 'caption field → Post or Drafts → the confirmation toast.',
        docs: 'android-tiktok', table: TIKTOK_POST, sourcePath: here('../tiktok/android/post.ts'), tableName: 'POST_SELECTORS',
    },
    {
        plugin: TIKTOK_PLUGIN_ID, flow: 'warmup', network: 'TikTok', appPackage: TIKTOK_ANDROID_PACKAGE,
        description: 'Warm an account up on the For You feed: Home tab → swipe through videos, liking, saving and '
            + 'following as the persona decides, occasionally opening search and a top result.',
        docs: 'android-tiktok', table: TIKTOK_FEED, sourcePath: here('../tiktok/android/doomscroll.ts'), tableName: 'FEED_SELECTORS',
    },
    {
        plugin: INSTAGRAM_PLUGIN_ID, flow: 'post', network: 'Instagram', appPackage: INSTAGRAM_ANDROID_PACKAGE,
        description: 'Publish or draft an Instagram post or reel: profile tab → optional account switch → create → '
            + 'the REEL or POST tab → gallery → Next through the editor → caption → Share, or save as a draft.',
        docs: 'instagram', table: INSTAGRAM_POST, sourcePath: here('../instagram/android/post.ts'), tableName: 'POST_SELECTORS',
    },
    {
        plugin: INSTAGRAM_PLUGIN_ID, flow: 'warmup', network: 'Instagram', appPackage: INSTAGRAM_ANDROID_PACKAGE,
        description: 'Warm an account up on the feed or on Reels: home or Reels tab → scroll, liking, saving and '
            + 'following, occasionally searching and opening a top result.',
        docs: 'instagram', table: INSTAGRAM_FEED, sourcePath: here('../instagram/android/warmup.ts'), tableName: 'FEED_SELECTORS',
    },
    {
        plugin: YOUTUBE_PLUGIN_ID, flow: 'post', network: 'YouTube', appPackage: YOUTUBE_ANDROID_PACKAGE,
        description: 'Upload a Short: account avatar → optional channel switch → create → Upload → the clip → Next → '
            + 'title and description → visibility → the made-for-kids question → Upload Short, or save a draft.',
        docs: 'youtube', table: YOUTUBE_POST, sourcePath: here('../youtube/android/post.ts'), tableName: 'POST_SELECTORS',
    },
    {
        plugin: YOUTUBE_PLUGIN_ID, flow: 'warmup', network: 'YouTube', appPackage: YOUTUBE_ANDROID_PACKAGE,
        description: 'Warm a channel up on the Shorts feed: Shorts tab → swipe through Shorts, liking, subscribing '
            + 'and occasionally leaving a comment.',
        docs: 'youtube', table: YOUTUBE_FEED, sourcePath: here('../youtube/android/warmup.ts'), tableName: 'FEED_SELECTORS',
    },
    {
        plugin: THREADS_PLUGIN_ID, flow: 'post', network: 'Threads', appPackage: THREADS_ANDROID_PACKAGE,
        description: 'Publish or draft a Thread: profile tab → optional account switch → compose → the text field → '
            + 'optional media attachment and picker confirm → Post, or save a draft.',
        docs: 'threads', table: THREADS_POST, sourcePath: here('../threads/android/post.ts'), tableName: 'POST_SELECTORS',
    },
    {
        plugin: THREADS_PLUGIN_ID, flow: 'warmup', network: 'Threads', appPackage: THREADS_ANDROID_PACKAGE,
        description: 'Warm an account up on the Threads feed: home tab → scroll, liking, reposting and following, '
            + 'occasionally searching.',
        docs: 'threads', table: THREADS_FEED, sourcePath: here('../threads/android/warmup.ts'), tableName: 'FEED_SELECTORS',
    },
];

export function flowsForPlugin(plugin: string): SelectorFlow[] {
    return SELECTOR_FLOWS.filter((entry) => entry.plugin === plugin);
}

export function findFlow(plugin: string, flow: FlowName): SelectorFlow | undefined {
    return SELECTOR_FLOWS.find((entry) => entry.plugin === plugin && entry.flow === flow);
}

/** The plugins that have Android selector tables at all — what `calibrate` and the UI can offer. */
export function calibratablePlugins(): string[] {
    return [...new Set(SELECTOR_FLOWS.map(({ plugin }) => plugin))];
}

function isEntryList(value: SelectorEntryList | readonly string[]): value is SelectorEntryList {
    return value.every((item) => typeof item === 'object');
}

/** The named selector lists in a table, skipping the bare `resource-id` fragment arrays. */
export function selectorNames(table: SelectorTable): string[] {
    return Object.entries(table)
        .filter(([, value]) => Array.isArray(value) && isEntryList(value as SelectorEntryList | readonly string[]))
        .map(([name]) => name);
}

/**
 * Which selectors are still guesses.
 *
 * The routines mark them in prose — a doc comment ending "GUESS." above the key — because that is
 * the note the person editing the table needs to read. Rather than keep a second list that would
 * drift from the first, this reads the marker back out of the source. A table whose source cannot
 * be read (a packaged install with the sources stripped) reports nothing unverified rather than
 * pretending everything is.
 */
export async function unverifiedNames(flow: SelectorFlow, read = readFile): Promise<string[]> {
    let source: string;
    try {
        source = await read(flow.sourcePath, 'utf8') as string;
    } catch {
        return [];
    }
    return unverifiedNamesIn(source, flow.tableName);
}

export function unverifiedNamesIn(source: string, tableName: string): string[] {
    const start = source.indexOf(`export const ${tableName} = {`);
    if (start < 0) return [];
    const end = source.indexOf('\n} as const;', start);
    const body = source.slice(start, end < 0 ? source.length : end);
    const names: string[] = [];
    let comment = '';
    for (const line of body.split('\n').slice(1)) {
        const trimmed = line.trim();
        // A key at the table's own indentation, e.g. `    captionField: [...]`.
        const key = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(trimmed);
        if (key) {
            // The marker sits either in the comment block above the key or trailing the key's line.
            if (/GUESS/.test(comment) || /GUESS/.test(trimmed)) names.push(key[1]!);
            comment = '';
            continue;
        }
        if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) comment += `${trimmed}\n`;
        else if (!trimmed) comment = '';
    }
    return names;
}

export interface SelectorStatus {
    plugin: string;
    flow: FlowName;
    name: string;
    /** The alternates the routine ships, in the order it tries them. */
    builtIn: SelectorEntryList;
    /** True when the table still marks this one GUESS. */
    guess: boolean;
    /** The confirmed entry that goes in front of the alternates, when there is one. */
    override: SelectorOverride | null;
}

/**
 * Everything the dashboard's Selectors panel and the `list_selectors` tool show: each selector
 * with its alternates, whether it is still a guess, and whether this phone has a confirmed answer.
 */
export async function selectorStatuses(
    plugin: string, udid = '*', filePath = selectorOverridesPath(),
): Promise<SelectorStatus[]> {
    const overrides = await loadSelectorOverrides(filePath);
    const rows: SelectorStatus[] = [];
    for (const flow of flowsForPlugin(plugin)) {
        const guesses = new Set(await unverifiedNames(flow));
        for (const name of selectorNames(flow.table)) {
            rows.push({
                plugin, flow: flow.flow, name,
                builtIn: flow.table[name] as SelectorEntryList,
                guess: guesses.has(name),
                override: overrideFor(overrides, plugin, udid, name) ?? null,
            });
        }
    }
    return rows;
}

/** The selectors still worth an agent's time: a guess with nothing confirmed behind it. */
export async function unverifiedStatuses(
    plugin: string, udid = '*', filePath = selectorOverridesPath(),
): Promise<SelectorStatus[]> {
    return (await selectorStatuses(plugin, udid, filePath)).filter((row) => row.guess && !row.override);
}
