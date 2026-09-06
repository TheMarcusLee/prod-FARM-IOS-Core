/**
 * Reading the video that is on screen right now.
 *
 * A persona cannot decide anything without knowing what it is looking at, and TikTok gives that up
 * grudgingly. On Android the feed carries accessibility nodes — the creator's handle, the caption,
 * the sound row — with resource-ids that move between builds. On iOS XCUITest cannot see into the
 * feed at all, so the only reading is OCR over a screenshot.
 *
 * Both paths end at the same place: a bag of strings. `videoFromTexts` is the pure part that turns
 * that bag into `{ creator, caption, hashtags, sound }`, which is why it is testable from a fake
 * tree and from a list of OCR words with the same assertions.
 *
 * Everything here is defensive. A partial read is the normal case — the caption scrolls, the
 * creator row is behind a tooltip, OCR drops a word — and a missing field must degrade the decision
 * (fewer matches, shorter watch) rather than fail the run.
 */

import { visibleTexts, walk, type OcrWord, type Recognize } from '../drivers/verify.js';
import type { Rect, UiNode } from '../drivers/types.js';

export interface ObservedVideo {
    /** `@handle`, or an empty string when it could not be read. */
    creator: string;
    caption: string;
    /** Lowercase, without the leading `#`. */
    hashtags: string[];
    /** The sound row's text when one was visible. */
    sound: string;
    /** Everything that was legible, in reading order — the raw material the decision falls back to. */
    texts: string[];
}

/** The little a read needs from a driver. `DeviceDriver` satisfies it structurally. */
export interface VideoSource {
    uiTree?: () => Promise<UiNode>;
    screenshot?: () => Promise<Buffer>;
}

export const EMPTY_VIDEO: ObservedVideo = { creator: '', caption: '', hashtags: [], sound: '', texts: [] };

/** Resource-id fragments that carry the creator handle on the builds seen so far. GUESS. */
const CREATOR_IDS = ['author', 'nickname', 'unique_id', 'title_author', 'user_name'];
/** Resource-id fragments that carry the caption. GUESS. */
const CAPTION_IDS = ['desc', 'title_desc', 'video_desc', 'caption'];
/** Resource-id fragments that carry the sound row. GUESS. */
const SOUND_IDS = ['music', 'sound', 'music_title'];

const HANDLE_SHAPE = /^@[A-Za-z0-9._]{2,64}$/;

/** Chrome that is on every feed screen and says nothing about the video. */
const CHROME = new Set([
    'home', 'shop', 'friends', 'inbox', 'profile', 'following', 'for you', 'explore', 'live',
    'search', 'follow', 'like', 'liked', 'comment', 'share', 'save', 'favorites', 'add to favorites',
]);

export function isChrome(text: string): boolean {
    return CHROME.has(text.trim().toLowerCase());
}

export function extractHashtags(texts: readonly string[]): string[] {
    const tags: string[] = [];
    for (const text of texts) {
        for (const match of text.matchAll(/#([\p{L}\p{N}_]{1,50})/gu)) {
            const tag = match[1]!.toLowerCase();
            if (!tags.includes(tag)) tags.push(tag);
        }
    }
    return tags;
}

function looksLikeHandle(text: string): boolean {
    return /^@[A-Za-z0-9._]{2,64}$/.test(text.trim());
}

function looksLikeSound(text: string): boolean {
    return /original sound|^♪|♬|\bsound\b|\bremix\b/i.test(text.trim());
}

/**
 * The pure read: creator, caption, hashtags and sound out of whatever strings were legible.
 * The caption is the longest non-chrome line that is not the handle and not the sound — TikTok
 * draws it as one text node on Android and OCR usually keeps it on one or two lines.
 */
export function videoFromTexts(rawTexts: readonly string[]): ObservedVideo {
    const texts = rawTexts.map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const creator = texts.find(looksLikeHandle) ?? '';
    const sound = texts.find((text) => text !== creator && looksLikeSound(text)) ?? '';
    const captionCandidates = texts.filter((text) =>
        text !== creator && text !== sound && !isChrome(text) && !/^\d[\d.,kmb]*$/i.test(text));
    const caption = captionCandidates.reduce((best, text) => (text.length > best.length ? text : best), '');
    return { creator, caption, hashtags: extractHashtags(texts), sound, texts };
}

function nodeText(node: UiNode): string {
    return (node.text || node.description || '').replace(/\s+/g, ' ').trim();
}

function byId(root: UiNode, fragments: readonly string[]): string {
    for (const node of walk(root)) {
        const id = node.id.toLowerCase();
        if (!id) continue;
        if (fragments.some((fragment) => id.endsWith(`:id/${fragment}`) || id.endsWith(`/${fragment}`) || id === fragment)) {
            const text = nodeText(node);
            if (text) return text;
        }
    }
    return '';
}

/**
 * Android: the tree read. Resource-ids first — they name the field, which no heuristic can — and
 * the text heuristics fill whatever the ids did not answer.
 */
export function videoFromTree(root: UiNode): ObservedVideo {
    const texts = visibleTexts(root).map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const heuristic = videoFromTexts(texts);
    const creatorById = byId(root, CREATOR_IDS);
    const creator = creatorById
        ? (creatorById.startsWith('@') ? creatorById : `@${creatorById.replace(/^@+/, '')}`)
        : heuristic.creator;
    const caption = byId(root, CAPTION_IDS) || heuristic.caption;
    const sound = byId(root, SOUND_IDS) || heuristic.sound;
    return { creator: HANDLE_SHAPE.test(creator) ? creator : heuristic.creator, caption, hashtags: extractHashtags(texts), sound, texts };
}

/** OCR words, top-to-bottom then left-to-right, so the caption lines stay in reading order. */
export function orderWords(words: readonly OcrWord[]): string[] {
    const sorted = [...words].sort((a, b) => (a.bounds.top - b.bounds.top) || (a.bounds.left - b.bounds.left));
    const lines: Array<{ top: number; parts: string[] }> = [];
    for (const word of sorted) {
        const height = Math.max(1, word.bounds.bottom - word.bounds.top);
        const line = lines.find((candidate) => Math.abs(candidate.top - word.bounds.top) <= height * 0.6);
        if (line) line.parts.push(word.text);
        else lines.push({ top: word.bounds.top, parts: [word.text] });
    }
    return lines.map((line) => line.parts.join(' ').trim()).filter(Boolean);
}

export function videoFromWords(words: readonly OcrWord[]): ObservedVideo {
    return videoFromTexts(orderWords(words));
}

/** Where an OCR word sits, for the routines that must tap something OCR found (iOS Follow, Search). */
export function findWordBounds(words: readonly OcrWord[], match: string): Rect | undefined {
    const needle = match.trim().toLowerCase();
    return words.find((word) => word.text.trim().toLowerCase() === needle)?.bounds
        ?? words.find((word) => word.text.trim().toLowerCase().includes(needle))?.bounds;
}

/**
 * Read whatever is on screen. Tree first when the source has one and it produced anything; OCR when
 * it did not and a recognizer was supplied. Never throws — an unreadable screen is an empty read,
 * and the decision layer treats that as "not a match", which is the safe direction.
 */
export async function readVideo(source: VideoSource, recognize?: Recognize): Promise<ObservedVideo> {
    if (source.uiTree) {
        try {
            const video = videoFromTree(await source.uiTree());
            if (video.texts.length) return video;
        } catch { /* fall through to OCR */ }
    }
    if (recognize && source.screenshot) {
        try {
            return videoFromWords(await recognize(await source.screenshot()));
        } catch { /* fall through to the empty read */ }
    }
    return { ...EMPTY_VIDEO, hashtags: [], texts: [] };
}
