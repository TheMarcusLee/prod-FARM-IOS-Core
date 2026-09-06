import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { inject } from './support.js';

// Every module that resolves a path from the environment does so on first load,
// so the workspace is set before the app modules are imported.
const workspace = await mkdtemp(path.join(os.tmpdir(), 'pf-uploads-'));
process.env.SCHEDULER_DATA_DIR = path.join(workspace, 'data');
process.env.CONTENT_DIR = path.join(workspace, 'content');
// A small chunk keeps the fixtures small; the protocol does not care.
process.env.UPLOAD_CHUNK_BYTES = '64';
process.env.UPLOAD_MAX_BYTES = '4096';
process.env.UPLOAD_MAX_CONCURRENT = '2';

const { registerUploadRoutes } = await import('../src/api/routes/uploads.js');
const { sweepUploads, uploadsRoot, UPLOAD_TTL_MS } = await import('../src/content/uploads.js');
const { setMediaTools } = await import('../src/content/ffmpeg.js');
const { bucketFor } = await import('../src/api/routes/mobile.js');
const { createFarmMcpServer } = await import('../src/mcp/server.js');

import type { ContentItemRow } from '../src/database/schema.js';
import type { ContentStore, NewAsset } from '../src/content/store.js';
import type { McpDependencies } from '../src/mcp/types.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

// ffprobe never runs on these fixtures; `/usr/bin/false` fails fast so the
// background normalisation marks the row failed instead of hanging on a probe.
setMediaTools({ ffmpeg: '/usr/bin/false', ffprobe: '/usr/bin/false' });

interface Context { after(fn: () => unknown): void }

interface StoreState { assets: NewAsset[]; items: ContentItemRow[] }

function fakeStore(): { store: ContentStore; state: StoreState } {
    const state: StoreState = { assets: [], items: [] };
    const store = {
        insertAsset: async (asset: NewAsset) => {
            state.assets.push(asset);
            return { id: `asset-${state.assets.length}` };
        },
        insertItem: async (values: Partial<ContentItemRow>) => {
            const row = {
                id: `item-${state.items.length + 1}`, originalAssetId: null, durationMs: null,
                width: null, height: null, normalized: false, posterPath: null, usedCount: 0,
                lastUsedAt: null, error: null, createdAt: new Date(), ...values,
            } as ContentItemRow;
            state.items.push(row);
            return row;
        },
        updateItem: async (id: string, patch: Partial<ContentItemRow>) => {
            const index = state.items.findIndex((entry) => entry.id === id);
            if (index < 0) return null;
            state.items[index] = { ...state.items[index] as ContentItemRow, ...patch };
            return state.items[index] as ContentItemRow;
        },
    } as unknown as ContentStore;
    return { store, state };
}

/**
 * The routes on a bare Fastify instance with a fake store — the same shape
 * `test/content-routes.test.ts` uses, so no database is anywhere near this.
 */
async function uploadApi(
    context: Context, identity: string = `token-${crypto.randomBytes(4).toString('hex')}`,
): Promise<{ app: FastifyInstance; state: StoreState }> {
    const { store, state } = fakeStore();
    const app = Fastify();
    app.addHook('onRequest', async (request) => { request.apiToken = { id: identity, name: identity }; });
    await registerUploadRoutes(app, {
        scheduler: {} as unknown as SchedulerRepository, store, sweepIntervalMinutes: 0,
    });
    await app.ready();
    context.after(() => app.close());
    return { app, state };
}

const digest = (body: Buffer) => crypto.createHash('sha256').update(body).digest('hex');

function chunksOf(body: Buffer, size: number): Buffer[] {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < body.length; offset += size) parts.push(body.subarray(offset, offset + size));
    return parts;
}

async function begin(app: FastifyInstance, body: Buffer, extra: Record<string, unknown> = {}) {
    const response = await inject(app, {
        method: 'POST', url: '/api/uploads',
        payload: { name: 'clip.mp4', size: body.length, mimeType: 'video/mp4', ...extra },
    });
    return { response, session: response.json() as { id: string; chunkSize: number } };
}

function putChunk(app: FastifyInstance, id: string, index: number, chunk: Buffer, sha = digest(chunk)) {
    return inject(app, {
        method: 'PUT', url: `/api/uploads/${id}/chunks/${index}`,
        headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha },
        payload: chunk,
    });
}

test('an upload round trips with its chunks sent out of order', async (context) => {
    const { app, state } = await uploadApi(context);
    const body = crypto.randomBytes(200);
    const { response, session } = await begin(app, body, { sha256: digest(body) });
    assert.equal(response.statusCode, 201);
    assert.equal(session.chunkSize, 64);
    assert.equal(response.json().chunkCount, 4);

    const parts = chunksOf(body, 64);
    for (const index of [3, 0, 2, 1]) {
        const put = await putChunk(app, session.id, index, parts[index] as Buffer);
        assert.equal(put.statusCode, 200, put.body);
    }

    const done = await inject(app, {
        method: 'POST', url: `/api/uploads/${session.id}/complete`, payload: { tags: 'fitness' },
    });
    assert.equal(done.statusCode, 201, done.body);
    const { items } = done.json() as { items: Array<{ id: string; sha256: string; tags: string[] }> };
    assert.equal(items.length, 1);
    assert.equal(items[0]?.sha256, digest(body));
    assert.deepEqual(items[0]?.tags, ['fitness']);

    // The asset row the multipart dropzone would have produced: same digest,
    // same size, same original name, stored under the content root.
    const asset = state.assets[0];
    assert.equal(asset?.sha256, digest(body));
    assert.equal(asset?.size, body.length);
    assert.equal(asset?.originalName, 'clip.mp4');
    assert.equal(asset?.mimeType, 'video/mp4');
    const stored = path.resolve(process.env.SCHEDULER_DATA_DIR!, asset!.relativePath);
    assert.deepEqual(await readFile(stored), body);

    // The session directory is gone once its bytes are the library's.
    assert.equal((await readdir(uploadsRoot())).includes(session.id), false);
});

test('a session lists what it has so an interrupted upload can resume', async (context) => {
    const { app } = await uploadApi(context);
    const body = crypto.randomBytes(200);
    const { session } = await begin(app, body);
    const parts = chunksOf(body, 64);
    // Chunk 2 never arrives — a dropped connection mid-upload.
    for (const index of [0, 1, 3]) await putChunk(app, session.id, index, parts[index] as Buffer);

    const listed = await inject(app, { method: 'GET', url: `/api/uploads/${session.id}` });
    assert.equal(listed.statusCode, 200);
    const view = listed.json() as { received: number[]; size: number; chunkCount: number };
    assert.deepEqual(view.received, [0, 1, 3]);
    assert.equal(view.size, body.length);
    assert.equal(view.chunkCount, 4);

    const early = await inject(app, { method: 'POST', url: `/api/uploads/${session.id}/complete` });
    assert.equal(early.statusCode, 409);
    assert.match(early.json().error, /1 chunk\(s\) are still missing: 2/);

    await putChunk(app, session.id, 2, parts[2] as Buffer);
    const done = await inject(app, { method: 'POST', url: `/api/uploads/${session.id}/complete` });
    assert.equal(done.statusCode, 201, done.body);
});

test('a chunk whose bytes do not match its header is refused and not recorded', async (context) => {
    const { app } = await uploadApi(context);
    const body = crypto.randomBytes(128);
    const { session } = await begin(app, body);
    const parts = chunksOf(body, 64);

    const wrong = await putChunk(app, session.id, 0, parts[0] as Buffer, digest(Buffer.from('something else')));
    assert.equal(wrong.statusCode, 400);
    assert.match(wrong.json().error, /X-Chunk-Sha256/);

    const missing = await inject(app, {
        method: 'PUT', url: `/api/uploads/${session.id}/chunks/0`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: parts[0] as Buffer,
    });
    assert.equal(missing.statusCode, 400);

    const listed = await inject(app, { method: 'GET', url: `/api/uploads/${session.id}` });
    assert.deepEqual(listed.json().received, []);
});

test('a short chunk and an out-of-range index are both rejected', async (context) => {
    const { app } = await uploadApi(context);
    const body = crypto.randomBytes(128);
    const { session } = await begin(app, body);

    const short = await putChunk(app, session.id, 0, Buffer.alloc(10));
    assert.equal(short.statusCode, 400);
    assert.match(short.json().error, /exactly 64 bytes/);

    const past = await putChunk(app, session.id, 2, Buffer.alloc(64));
    assert.equal(past.statusCode, 400);
    assert.match(past.json().error, /between 0 and 1/);
});

test('completion refuses a file that does not match the declared whole-file hash', async (context) => {
    const { app, state } = await uploadApi(context);
    const body = crypto.randomBytes(128);
    // The client declares one file and then sends a different one.
    const { session } = await begin(app, body, { sha256: digest(Buffer.from('a different file')) });
    for (const [index, chunk] of chunksOf(body, 64).entries()) await putChunk(app, session.id, index, chunk);

    const done = await inject(app, { method: 'POST', url: `/api/uploads/${session.id}/complete` });
    assert.equal(done.statusCode, 422);
    assert.match(done.json().error, /does not match the sha256/);
    assert.equal(state.assets.length, 0);
});

test('a session belongs to the identity that opened it', async (context) => {
    const mine = await uploadApi(context, 'token-a');
    const theirs = await uploadApi(context, 'token-b');
    const body = crypto.randomBytes(64);
    const { session } = await begin(mine.app, body);

    for (const request of [
        { method: 'GET' as const, url: `/api/uploads/${session.id}` },
        { method: 'POST' as const, url: `/api/uploads/${session.id}/complete` },
        { method: 'DELETE' as const, url: `/api/uploads/${session.id}` },
    ]) {
        const response = await inject(theirs.app, request);
        // A 404 and not a 403: an owner check that said "forbidden" would
        // confirm the id exists.
        assert.equal(response.statusCode, 404, `${request.method} ${request.url}`);
        assert.equal(response.json().error, 'Upload session not found');
    }
    const chunk = await putChunk(theirs.app, session.id, 0, body);
    assert.equal(chunk.statusCode, 404);

    // The owner is unaffected, and its own abort works.
    assert.equal((await inject(mine.app, { method: 'GET', url: `/api/uploads/${session.id}` })).statusCode, 200);
    assert.equal((await inject(mine.app, { method: 'DELETE', url: `/api/uploads/${session.id}` })).statusCode, 204);
    assert.equal((await inject(mine.app, { method: 'GET', url: `/api/uploads/${session.id}` })).statusCode, 404);
});

test('the id pattern is strict, so no client path ever reaches the filesystem', async (context) => {
    const { app } = await uploadApi(context);
    for (const id of ['../../etc', 'not-an-id', '00', `${'a'.repeat(31)}`, 'ABCDEF0123456789abcdef0123456789']) {
        const response = await inject(app, { method: 'GET', url: `/api/uploads/${encodeURIComponent(id)}` });
        assert.equal(response.statusCode, 404, id);
    }
});

test('a session is bounded by size and by how many one identity may hold open', async (context) => {
    const { app } = await uploadApi(context, 'token-limits');
    const tooBig = await inject(app, {
        method: 'POST', url: '/api/uploads',
        payload: { name: 'huge.mp4', size: 5000, mimeType: 'video/mp4' },
    });
    assert.equal(tooBig.statusCode, 413);
    assert.match(tooBig.json().error, /at most 4096 bytes/);

    for (const size of [0, -1, 1.5, '10']) {
        const response = await inject(app, {
            method: 'POST', url: '/api/uploads', payload: { name: 'clip.mp4', size, mimeType: 'video/mp4' },
        });
        assert.equal(response.statusCode, 400, String(size));
    }

    const first = await begin(app, Buffer.alloc(64));
    const second = await begin(app, Buffer.alloc(64));
    assert.equal(first.response.statusCode, 201);
    assert.equal(second.response.statusCode, 201);
    const third = await begin(app, Buffer.alloc(64));
    assert.equal(third.response.statusCode, 429);
    assert.match(third.response.json().error, /Only 2 uploads may be open at once/);

    // Cancelling one frees the slot again.
    await inject(app, { method: 'DELETE', url: `/api/uploads/${first.session.id}` });
    assert.equal((await begin(app, Buffer.alloc(64))).response.statusCode, 201);
});

/** A data root of its own, so the count a sweep reports is only about this test. */
async function ownDataRoot(context: Context): Promise<void> {
    const previous = process.env.SCHEDULER_DATA_DIR;
    process.env.SCHEDULER_DATA_DIR = await mkdtemp(path.join(workspace, 'sweep-'));
    context.after(() => { process.env.SCHEDULER_DATA_DIR = previous; });
}

test('the sweep drops expired sessions and leaves live ones (and plain asset files) alone', async (context) => {
    await ownDataRoot(context);
    const { app } = await uploadApi(context, 'token-sweep');
    const live = await begin(app, Buffer.alloc(64));
    const stale = await begin(app, Buffer.alloc(64));

    // `POST /api/assets` writes plain files into the same directory; the sweep
    // must not touch them.
    const bystander = path.join(uploadsRoot(), crypto.randomUUID());
    await writeFile(bystander, 'an asset uploaded the old way');

    // Nothing has expired yet, so a sweep now is a no-op.
    assert.equal(await sweepUploads(new Date()), 0);
    assert.equal((await inject(app, { method: 'GET', url: `/api/uploads/${live.session.id}` })).statusCode, 200);

    const future = new Date(Date.now() + UPLOAD_TTL_MS + 60_000);
    assert.equal(await sweepUploads(future), 2);
    assert.equal((await inject(app, { method: 'GET', url: `/api/uploads/${live.session.id}` })).statusCode, 404);
    assert.equal((await inject(app, { method: 'GET', url: `/api/uploads/${stale.session.id}` })).statusCode, 404);
    await stat(bystander);
});

test('a directory with no readable meta is only swept once it is older than the ttl', async (context) => {
    await ownDataRoot(context);
    await uploadApi(context, 'token-orphan');
    const orphan = path.join(uploadsRoot(), crypto.randomBytes(16).toString('hex'));
    await mkdir(orphan, { recursive: true });

    assert.equal(await sweepUploads(new Date()), 0);
    await stat(orphan);

    const old = new Date(Date.now() - UPLOAD_TTL_MS - 60_000);
    await utimes(orphan, old, old);
    assert.equal(await sweepUploads(new Date()), 1);
    await assert.rejects(stat(orphan));
});

test('chunk puts get a bucket of their own, not the shared write budget', () => {
    const id = crypto.randomBytes(16).toString('hex');
    assert.equal(bucketFor('PUT', `/api/uploads/${id}/chunks/7`).name, 'chunk');
    assert.equal(bucketFor('PUT', `/api/uploads/${id}/chunks/7`).max, 600);
    // Opening and completing a session are ordinary writes.
    assert.equal(bucketFor('POST', '/api/uploads').name, 'write');
    assert.equal(bucketFor('POST', `/api/uploads/${id}/complete`).name, 'write');
    assert.equal(bucketFor('PUT', '/api/uploads/not-an-id/chunks/7').name, 'write');
});

// ---- the MCP tool ----------------------------------------------------------

/**
 * `upload_asset` with a `path` bigger than one chunk goes through the very same
 * session machinery, in process — no HTTP, and never the whole file in memory.
 */
test('upload_asset chunks a host file over one chunk and registers the same asset', async (context) => {
    await ownDataRoot(context);
    const allowed = await mkdtemp(path.join(workspace, 'mcp-'));
    const registered: Array<{ relativePath: string; size: number; sha256: string; originalName: string }> = [];
    const dependencies = {
        scheduler: {
            async registerAssets(files: readonly { relativePath: string; size: number; sha256: string; originalName: string; mimeType: string }[]) {
                registered.push(...files);
                return files.map((file) => ({ id: 'asset-1', name: file.originalName, mimeType: file.mimeType }));
            },
        },
        async loadDevices() { return []; },
        async discoverDevices() { return []; },
        async screenshot() { return Buffer.alloc(0); },
        async listAssets() { return []; },
        listPlugins() { return []; },
        dataDirectory: process.env.SCHEDULER_DATA_DIR,
        uploadDirectories: [allowed],
    } as unknown as McpDependencies;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFarmMcpServer(dependencies);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
        // 200 bytes over a 64-byte chunk: four chunks, and a remainder.
        const body = crypto.randomBytes(200);
        const source = path.join(allowed, 'big.mp4');
        await writeFile(source, body);

        const result = await client.callTool({
            name: 'upload_asset', arguments: { name: 'big.mp4', mimeType: 'video/mp4', path: source },
        }) as { isError?: boolean; content: Array<{ text?: string }> };
        assert.notEqual(result.isError, true, result.content[0]?.text ?? 'upload rejected');

        const asset = registered[0];
        assert.equal(asset?.size, 200);
        assert.equal(asset?.sha256, digest(body));
        assert.deepEqual(await readFile(path.resolve(process.env.SCHEDULER_DATA_DIR!, asset!.relativePath)), body);
        // The session directory it used is cleaned up behind it.
        assert.deepEqual(
            (await readdir(uploadsRoot())).filter((entry) => /^[0-9a-f]{32}$/.test(entry)),
            [],
        );

        // A small file still takes the plain read-and-write path.
        const small = path.join(allowed, 'small.jpg');
        await writeFile(small, Buffer.alloc(10, 7));
        const tiny = await client.callTool({
            name: 'upload_asset', arguments: { name: 'small.jpg', mimeType: 'image/jpeg', path: small },
        }) as { isError?: boolean };
        assert.notEqual(tiny.isError, true);
        assert.equal(registered[1]?.size, 10);
    } finally {
        await client.close();
        await server.close();
    }
});
