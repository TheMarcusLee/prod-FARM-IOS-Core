import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import type { ContentItemRow } from '../database/schema.js';
import { extractPoster, normalizeVideo, posterSecondsFor, probeMedia, TIKTOK_MAX_SECONDS } from './ffmpeg.js';
import { contentRoot, dataRoot, relativeToData, safeFileName } from './paths.js';
import type { ContentStore } from './store.js';

/** Extensions the directory scanner will pick up. */
export const MEDIA_EXTENSIONS = new Set([
    '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi',
    '.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif',
]);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

export function mimeTypeFor(fileName: string): string {
    const extension = path.extname(fileName).toLowerCase();
    if (VIDEO_EXTENSIONS.has(extension)) return extension === '.webm' ? 'video/webm' : 'video/mp4';
    if (extension === '.png') return 'image/png';
    if (extension === '.webp') return 'image/webp';
    if (extension === '.gif') return 'image/gif';
    if (extension === '.heic') return 'image/heic';
    return 'image/jpeg';
}

/**
 * A tiny fixed-width queue. FFmpeg saturates a core per job, so more than a
 * couple of concurrent transcodes just starves the web process.
 */
export function createLimiter(concurrency: number) {
    let active = 0;
    const waiting: Array<() => void> = [];
    const next = () => {
        if (active >= concurrency) return;
        const start = waiting.shift();
        if (!start) return;
        active += 1;
        start();
    };
    return function run<T>(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            waiting.push(() => {
                // `task` throwing synchronously must still release the slot, or
                // one bad call permanently shrinks the pool until it deadlocks.
                const started = (async () => task())();
                started.then(resolve, reject).finally(() => { active -= 1; next(); });
            });
            next();
        });
    };
}

export const processingLimiter = createLimiter(Number(process.env.CONTENT_CONCURRENCY ?? 2) || 2);

async function hashFile(file: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await pipeline(createReadStream(file), hash);
    return hash.digest('hex');
}

/** Streams a source into the content directory and returns what the assets table needs. */
export async function storeOriginal(
    source: Readable | string,
    originalName: string,
    mimeType: string,
): Promise<{ relativePath: string; absolutePath: string; originalName: string; mimeType: string; size: number; sha256: string }> {
    const name = safeFileName(originalName);
    const directory = path.join(contentRoot(), 'originals');
    await mkdir(directory, { recursive: true });
    const absolutePath = path.join(directory, `${crypto.randomUUID()}${path.extname(name)}`);
    const input = typeof source === 'string' ? createReadStream(source) : source;
    await pipeline(input, createWriteStream(absolutePath, { flags: 'wx', mode: 0o600 }));
    const [{ size }, sha256] = await Promise.all([stat(absolutePath), hashFile(absolutePath)]);
    return { relativePath: relativeToData(absolutePath), absolutePath, originalName: name, mimeType, size, sha256 };
}

export interface IngestInput {
    source: Readable | string;
    originalName: string;
    mimeType: string;
    tags?: string[];
    caption?: string | null;
    hashtags?: string[];
    crop?: boolean;
}

/**
 * Registers the upload immediately as a `processing` item so the library grid
 * can show it, then hands the slow FFmpeg work to the limiter. The returned
 * promise resolves once the row exists, not once the transcode finishes.
 */
export async function ingestMedia(store: ContentStore, input: IngestInput): Promise<ContentItemRow> {
    const stored = await storeOriginal(input.source, input.originalName, input.mimeType);
    const original = await store.insertAsset({
        relativePath: stored.relativePath, originalName: stored.originalName,
        mimeType: stored.mimeType, size: stored.size, sha256: stored.sha256,
    });
    const item = await store.insertItem({
        assetId: original.id,
        originalAssetId: original.id,
        kind: input.mimeType.startsWith('video/') ? 'video' : 'image',
        sha256: stored.sha256,
        tags: input.tags ?? [],
        hashtags: input.hashtags ?? [],
        caption: input.caption ?? null,
        status: 'processing',
    });
    void processingLimiter(() => processItem(store, item.id, stored.absolutePath, input.crop === true))
        .catch(() => { /* recorded on the row by processItem */ });
    return item;
}

/**
 * Probes the original and, for video, produces the TikTok-safe copy the drip
 * queue will actually upload. The original is never modified or deleted.
 */
export async function processItem(
    store: ContentStore,
    itemId: string,
    absoluteOriginal: string,
    crop: boolean,
): Promise<void> {
    try {
        const probe = await probeMedia(absoluteOriginal);
        let assetId: string | undefined;
        let width = probe.width;
        let height = probe.height;
        let normalized = false;

        if (probe.kind === 'video') {
            const directory = path.join(contentRoot(), 'normalized');
            await mkdir(directory, { recursive: true });
            const output = path.join(directory, `${crypto.randomUUID()}.mp4`);
            try {
                await normalizeVideo({ input: absoluteOriginal, output, crop, maxSeconds: TIKTOK_MAX_SECONDS });
            } catch (error) {
                // FFmpeg leaves a truncated file behind when it dies mid-encode.
                // Nothing references it, so nothing would ever clean it up.
                await rm(output, { force: true });
                throw error;
            }
            const [{ size }, sha256] = await Promise.all([stat(output), hashFile(output)]);
            const asset = await store.insertAsset({
                relativePath: relativeToData(output),
                originalName: `${path.basename(absoluteOriginal, path.extname(absoluteOriginal))}.mp4`,
                mimeType: 'video/mp4', size, sha256,
            });
            assetId = asset.id;
            width = 1080;
            height = 1920;
            normalized = true;
        }

        const posterDirectory = path.join(contentRoot(), 'posters');
        await mkdir(posterDirectory, { recursive: true });
        const poster = path.join(posterDirectory, `${itemId}.jpg`);
        let posterPath: string | null = null;
        try {
            await extractPoster({
                input: absoluteOriginal, output: poster,
                atSeconds: probe.kind === 'video' ? posterSecondsFor(probe.durationMs) : 0,
            });
            posterPath = path.relative(contentRoot(), poster);
        } catch {
            // A poster is a nicety, not a reason to fail ingest — but a partial
            // JPEG would be served as a broken image, so drop it.
            await rm(poster, { force: true });
        }

        await store.updateItem(itemId, {
            ...(assetId ? { assetId } : {}),
            kind: probe.kind,
            ...(probe.durationMs === undefined ? {} : { durationMs: probe.durationMs }),
            width, height, normalized, posterPath,
            status: 'ready', error: null,
        });
    } catch (error) {
        await store.updateItem(itemId, {
            status: 'failed', error: error instanceof Error ? error.message : String(error),
        });
    }
}

/** Files a directory ingest would take, sorted so a re-run is deterministic. */
export async function listMediaFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => path.join(directory, entry.name))
        .sort();
}

export interface IngestDirectoryResult { ingested: number; items: ContentItemRow[]; skipped: string[] }

export async function ingestDirectory(
    store: ContentStore,
    directory: string,
    options: { tags?: string[]; crop?: boolean; limit?: number } = {},
): Promise<IngestDirectoryResult> {
    const resolved = path.resolve(directory);
    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`${resolved} is not a readable directory`);
    const files = (await listMediaFiles(resolved)).slice(0, options.limit ?? 200);
    const items: ContentItemRow[] = [];
    const skipped: string[] = [];
    for (const file of files) {
        try {
            items.push(await ingestMedia(store, {
                source: file, originalName: path.basename(file), mimeType: mimeTypeFor(file),
                ...(options.tags ? { tags: options.tags } : {}),
                ...(options.crop === undefined ? {} : { crop: options.crop }),
            }));
        } catch (error) {
            skipped.push(`${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { ingested: items.length, items, skipped };
}

/** Removes the files an item owns once its rows are gone. */
export async function removeItemFiles(item: ContentItemRow, store: ContentStore): Promise<void> {
    const root = dataRoot();
    for (const assetId of new Set([item.assetId, item.originalAssetId].filter((id): id is string => Boolean(id)))) {
        const asset = await store.assetPath(assetId);
        if (!asset) continue;
        const file = path.resolve(root, asset.relativePath);
        if (file.startsWith(`${root}${path.sep}`)) await rm(file, { force: true });
    }
    if (item.posterPath) {
        const poster = path.resolve(contentRoot(), item.posterPath);
        if (poster.startsWith(`${contentRoot()}${path.sep}`)) await rm(poster, { force: true });
    }
}
