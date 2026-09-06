/**
 * `uploadAsset` against a fake farm: what it sends, what it resumes, and what
 * it does when the caller pulls the plug half way through.
 */

import { createFarmClient, sha256Bytes, uploadFileFromBlob, type UploadFile, type UploadProgress } from '../src';

const CHUNK = 64;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function bytes(length: number): Uint8Array {
    // Deterministic, and not all one value, so a mis-sliced chunk shows up.
    return Uint8Array.from({ length }, (_, index) => (index * 31 + 7) % 251);
}

/** A `File` stand-in; React Native's `Blob` has exactly this much surface. */
function fileOf(body: Uint8Array, name = 'clip.mp4'): UploadFile {
    return {
        name,
        size: body.length,
        mimeType: 'video/mp4',
        slice: (start, end) => ({
            arrayBuffer: async () => body.slice(start, end).buffer as ArrayBuffer,
        }),
    };
}

interface Call { method: string; url: string; headers: Record<string, string>; body?: ArrayBuffer }

/**
 * A farm that keeps the chunks it is given. `received` seeds a session that is
 * already part way through — which is what a resume looks like from here.
 */
function fakeFarm(options: { size: number; received?: number[]; failChunk?: number } = { size: 0 }) {
    const calls: Call[] = [];
    const stored = new Map<number, Uint8Array>();
    let sessions = 0;

    const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        const href = String(url);
        const path = href.slice(href.indexOf('/api/'));
        const method = init?.method ?? 'GET';
        const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
        calls.push({ method, url: path, headers });

        if (method === 'POST' && path === '/api/uploads') {
            sessions += 1;
            return json({
                id: 'a'.repeat(32), name: 'clip.mp4', size: options.size, mimeType: 'video/mp4',
                chunkSize: CHUNK, chunkCount: Math.ceil(options.size / CHUNK),
                received: [], expiresAt: '2026-09-07T00:00:00.000Z',
            }, 201);
        }
        if (method === 'GET' && /^\/api\/uploads\/[0-9a-f]{32}$/.test(path)) {
            return json({
                id: 'a'.repeat(32), name: 'clip.mp4', size: options.size, mimeType: 'video/mp4',
                chunkSize: CHUNK, chunkCount: Math.ceil(options.size / CHUNK),
                received: options.received ?? [], expiresAt: '2026-09-07T00:00:00.000Z',
            });
        }
        const chunk = /^\/api\/uploads\/[0-9a-f]{32}\/chunks\/(\d+)$/.exec(path);
        if (method === 'PUT' && chunk) {
            const index = Number(chunk[1]);
            if (index === options.failChunk) return json({ error: 'Chunk does not match its X-Chunk-Sha256' }, 400);
            const body = new Uint8Array(init?.body as ArrayBuffer);
            // The farm checks the digest; so does this, so a client that hashed
            // the wrong slice cannot pass.
            if (headers['X-Chunk-Sha256'] !== sha256Bytes(body)) return json({ error: 'bad digest' }, 400);
            stored.set(index, body);
            return json({ index, received: stored.size });
        }
        if (method === 'POST' && path.endsWith('/complete')) {
            return json({ items: [{ id: 'item-1', assetId: 'asset-1', originalAssetId: null, kind: 'video', status: 'processing', sha256: 'abc', tags: [], hashtags: [], caption: null }] }, 201);
        }
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return json({ error: `unexpected ${method} ${path}` }, 500);
    };

    const client = createFarmClient({
        baseUrl: 'http://farm.test:3000', token: 'pf_live_abc', retries: 0, fetch: fetchImpl,
    });
    return { client, calls, stored, sessions: () => sessions };
}

describe('uploadAsset', () => {
    it('sends every chunk with its digest and reports progress up to the whole file', async () => {
        const body = bytes(200);
        const farm = fakeFarm({ size: body.length });
        const progress: UploadProgress[] = [];

        const item = await farm.client.uploadAsset(fileOf(body), {
            tags: ['fitness'],
            onProgress: (update) => progress.push(update),
        });

        expect(item.id).toBe('item-1');
        expect(farm.stored.size).toBe(4);
        // Reassembled in index order, the chunks are the file.
        const assembled = new Uint8Array(body.length);
        for (const [index, chunk] of farm.stored) assembled.set(chunk, index * CHUNK);
        expect([...assembled]).toEqual([...body]);

        expect(progress[0]?.sent).toBe(0);
        const last = progress[progress.length - 1];
        expect(last?.sent).toBe(200);
        expect(last?.fraction).toBe(1);
        expect(last?.bytesPerSecond).toBeGreaterThan(0);

        const complete = farm.calls.find((call) => call.url.endsWith('/complete'));
        expect(complete?.method).toBe('POST');
    });

    it('resumes a session and re-sends only the chunks the farm is missing', async () => {
        const body = bytes(200);
        const farm = fakeFarm({ size: body.length, received: [0, 2] });
        const progress: UploadProgress[] = [];

        await farm.client.uploadAsset(fileOf(body), {
            uploadId: 'a'.repeat(32),
            onProgress: (update) => progress.push(update),
        });

        // No new session was opened, and only 1 and 3 went over the wire.
        expect(farm.sessions()).toBe(0);
        expect([...farm.stored.keys()].sort()).toEqual([1, 3]);
        // The two chunks the farm already had count towards the progress from
        // the first report, or the bar would jump backwards on resume.
        expect(progress[0]?.sent).toBe(128);
    });

    it('opens a fresh session when the remembered one is gone', async () => {
        const body = bytes(64);
        const farm = fakeFarm({ size: body.length });
        // The GET answers with a session for a different size, which is not this file.
        await farm.client.uploadAsset(fileOf(bytes(128)), { uploadId: 'b'.repeat(32) }).catch(() => undefined);
        expect(farm.sessions()).toBe(1);
        expect(body.length).toBe(64);
    });

    it('stops on an aborted signal and never completes the session', async () => {
        const body = bytes(500);
        const farm = fakeFarm({ size: body.length });
        const controller = new AbortController();
        const failed = farm.client
            .uploadAsset(fileOf(body), {
                signal: controller.signal,
                parallel: 1,
                onProgress: (update) => { if (update.sent >= 64) controller.abort(); },
            })
            .catch((error: Error & { kind?: string }) => error);

        const error = await failed;
        expect((error as { kind?: string }).kind).toBe('aborted');
        expect(farm.calls.some((call) => call.url.endsWith('/complete'))).toBe(false);
        expect(farm.stored.size).toBeLessThan(8);
    });

    it('surfaces a refused chunk as a validation failure', async () => {
        const body = bytes(200);
        const farm = fakeFarm({ size: body.length, failChunk: 2 });
        const error = await farm.client
            .uploadAsset(fileOf(body), { parallel: 1 })
            .catch((caught: Error & { kind?: string }) => caught);
        expect((error as { kind?: string }).kind).toBe('validation');
        expect((error as Error).message).toMatch(/X-Chunk-Sha256/);
        expect(farm.calls.some((call) => call.url.endsWith('/complete'))).toBe(false);
    });

    it('takes a Blob straight from the picker', () => {
        const file = uploadFileFromBlob(new Blob([bytes(10)], { type: 'video/quicktime' }), 'IMG_0042.mov');
        expect(file.size).toBe(10);
        expect(file.mimeType).toBe('video/quicktime');
        expect(file.name).toBe('IMG_0042.mov');
    });
});
