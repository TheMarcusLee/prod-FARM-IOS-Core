/**
 * The client half of the chunked upload protocol (`src/api/routes/uploads.ts`).
 *
 * A phone on a train uploading a 400 MB clip is the case this exists for: the
 * connection will drop, and what has already landed must not have to be sent
 * again. So the session id is handed back to the caller, `received` is asked for
 * on every resume, and only the missing chunks go over the wire.
 *
 * Free of React, of `window` and of any native module — `Blob.slice` and
 * `fetch` are all it needs, which React Native, Electron and Node all have.
 */

import { FarmError } from './errors';
import type { HttpTransport } from './http';
import type { ContentLibraryItem } from './models';
import { sha256Hex } from './sha256';

/** Three in flight fills a tunnel without starving the rest of the app. */
export const UPLOAD_PARALLEL_CHUNKS = 3;

/** Anything the caller can slice bytes out of. A DOM `File` needs `mimeType` naming its `type`. */
export interface UploadFile {
    name: string;
    size: number;
    mimeType: string;
    slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** `expo-image-picker` hands back a uri; `fetch(uri).then((r) => r.blob())` gets here. */
export function uploadFileFromBlob(blob: Blob, name: string, mimeType?: string): UploadFile {
    return {
        name,
        size: blob.size,
        mimeType: mimeType ?? blob.type ?? 'application/octet-stream',
        slice: (start, end) => blob.slice(start, end),
    };
}

export interface UploadProgress {
    /** Bytes the farm has, this session and every earlier one together. */
    sent: number;
    total: number;
    /** 0…1, and 1 only once every chunk is in. */
    fraction: number;
    /** Bytes per second over this run; zero until the first chunk lands. */
    bytesPerSecond: number;
}

export interface UploadAssetOptions {
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
    /** Tags for the library item, exactly as the dropzone sends them. */
    tags?: string[];
    crop?: boolean;
    /**
     * Resume this session instead of opening one. The farm answers 404 for an
     * expired or someone else's id, and a fresh session is opened instead.
     */
    uploadId?: string;
    /** Called as soon as there is an id worth persisting for a later resume. */
    onSession?: (uploadId: string) => void;
    /** Test seam, and the escape hatch for a platform with a faster digest. */
    digest?: (bytes: ArrayBuffer) => Promise<string>;
    parallel?: number;
}

export interface UploadSessionView {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    chunkSize: number;
    chunkCount: number;
    received: number[];
    expiresAt: string;
}

function aborted(): FarmError {
    return new FarmError('aborted', 'Upload cancelled.');
}

/** Opens a session, or reuses the one the caller asked to resume. */
async function openSession(http: HttpTransport, file: UploadFile, options: UploadAssetOptions): Promise<UploadSessionView> {
    if (options.uploadId) {
        const existing = await http
            .request<UploadSessionView>(`/api/uploads/${encodeURIComponent(options.uploadId)}`, { retries: 0 })
            .catch(() => null);
        // Same file or nothing: a session whose size disagrees is not this file.
        if (existing && existing.size === file.size) return { ...existing, received: existing.received ?? [] };
    }
    const created = await http.request<UploadSessionView>('/api/uploads', {
        method: 'POST',
        body: { name: file.name, size: file.size, mimeType: file.mimeType },
    });
    return { ...created, received: created.received ?? [] };
}

/**
 * Uploads one file and returns the library item the farm created — the same row
 * the dashboard's dropzone produces, because completion runs the same ingest.
 */
export async function uploadAsset(
    http: HttpTransport, file: UploadFile, options: UploadAssetOptions = {},
): Promise<ContentLibraryItem> {
    if (file.size <= 0) throw new FarmError('validation', 'That file is empty.');
    if (options.signal?.aborted) throw aborted();

    const session = await openSession(http, file, options);
    options.onSession?.(session.id);

    const done = new Set(session.received);
    const pending: number[] = [];
    for (let index = 0; index < session.chunkCount; index += 1) if (!done.has(index)) pending.push(index);

    const lengthOf = (index: number) =>
        index === session.chunkCount - 1 ? session.size - index * session.chunkSize : session.chunkSize;
    const startedAt = Date.now();
    let sentThisRun = 0;
    const report = () => {
        let sent = 0;
        for (const index of done) sent += lengthOf(index);
        const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
        options.onProgress?.({
            sent, total: session.size, fraction: sent / session.size,
            bytesPerSecond: sentThisRun === 0 ? 0 : sentThisRun / elapsed,
        });
    };
    report();

    const digest = options.digest ?? sha256Hex;
    const sendChunk = async (index: number): Promise<void> => {
        if (options.signal?.aborted) throw aborted();
        const start = index * session.chunkSize;
        const bytes = await file.slice(start, start + lengthOf(index)).arrayBuffer();
        await http.sendBytes(`/api/uploads/${session.id}/chunks/${index}`, bytes, {
            headers: { 'X-Chunk-Sha256': await digest(bytes) },
            ...(options.signal ? { signal: options.signal } : {}),
        });
        done.add(index);
        sentThisRun += lengthOf(index);
        report();
    };

    const next = () => pending.shift();
    const worker = async () => {
        for (let index = next(); index !== undefined; index = next()) await sendChunk(index);
    };
    const parallel = Math.max(1, options.parallel ?? UPLOAD_PARALLEL_CHUNKS);
    await Promise.all(Array.from({ length: Math.min(parallel, Math.max(1, pending.length)) }, worker));

    if (options.signal?.aborted) throw aborted();
    const body = await http.request<{ items: ContentLibraryItem[] }>(
        `/api/uploads/${session.id}/complete`,
        {
            method: 'POST',
            body: { ...(options.tags ? { tags: options.tags } : {}), ...(options.crop ? { crop: true } : {}) },
            ...(options.signal ? { signal: options.signal } : {}),
        },
    );
    const item = body?.items?.[0];
    if (!item) throw new FarmError('parse', 'The farm completed the upload without returning an item.');
    return item;
}

/** Abandons a session; the farm frees the disk and the identity's slot. */
export async function abortUpload(http: HttpTransport, uploadId: string): Promise<void> {
    await http.request<void>(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE', retries: 0 });
}
