import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ingestMedia, mimeTypeFor } from '../../content/ingest.js';
import { createContentStore, type ContentStore } from '../../content/store.js';
import { tagList } from '../../content/validate.js';
import {
    abortUpload, completeUpload, createUpload, publicUpload, readOwnedUpload, receivedChunks,
    startUploadSweep, uploadChunkBytes, UploadError, writeChunk,
} from '../../content/uploads.js';
import type { SchedulerRepository } from '../../scheduler/repository.js';

export interface UploadRouteOptions {
    scheduler: SchedulerRepository;
    /** Injected by tests; otherwise derived from the scheduler's own connection. */
    store?: ContentStore;
    /** Overrides the hourly expiry sweep. Zero or less runs the boot sweep only. */
    sweepIntervalMinutes?: number;
}

/**
 * A session belongs to the token that opened it. With auth switched off every
 * request shares one identity, which is the same trust boundary the rest of an
 * unauthenticated deployment already has.
 */
export function uploadIdentity(request: FastifyRequest): string {
    return request.apiToken?.id ?? 'anonymous';
}

function failed(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof UploadError) return reply.code(error.statusCode).send({ error: error.message });
    throw error;
}

/**
 * The chunked upload protocol. Big clips arrive as a sequence of bounded `PUT`s
 * so a tunnel's body limit stops being the ceiling on what the farm can ingest;
 * completion hands the assembled file to the very same `ingestMedia` the
 * multipart dropzone has always used, so the asset and item rows are identical.
 *
 * Registered inside its own encapsulated scope: the raw-body parser for chunks
 * must not become the parser for the rest of the API. Root hooks — auth, CSRF,
 * rate limits — still run, because Fastify runs them for child contexts too.
 */
export async function registerUploadRoutes(app: FastifyInstance, options: UploadRouteOptions): Promise<void> {
    let resolved: ContentStore | null | undefined;
    const store = (): ContentStore | null => {
        if (resolved !== undefined) return resolved;
        try {
            resolved = options.store ?? createContentStore(options.scheduler.connection.db);
        } catch {
            resolved = null;
        }
        return resolved;
    };

    const sweep = startUploadSweep({
        ...(options.sweepIntervalMinutes === undefined ? {} : { intervalMinutes: options.sweepIntervalMinutes }),
        log: (error) => app.log.error(error),
    });
    if (sweep) app.addHook('onClose', async () => sweep.stop());

    // Deliberately not awaited: `await app.register(...)` part-way through
    // `createApp` boots the instance early, and the `setErrorHandler` registered
    // at the end of it would be silently dropped. Fastify still loads the plugin
    // before the server is ready, so the routes exist by the time anything calls
    // them. `registerRateLimits` does the same for the same reason.
    void app.register(async (scope) => {
        const chunkSize = uploadChunkBytes();
        // Chunks are opaque bytes, not JSON. `parseAs: 'buffer'` keeps the whole
        // chunk in memory for exactly one request, which is what makes the
        // digest check possible before anything touches the disk.
        scope.addContentTypeParser(
            ['application/octet-stream', 'application/x-chunk'],
            { parseAs: 'buffer', bodyLimit: chunkSize },
            (_request, body, done) => { done(null, body); },
        );

        scope.post('/api/uploads', async (request, reply) => {
            const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
            try {
                const session = await createUpload({
                    name: body.name,
                    size: body.size,
                    mimeType: body.mimeType,
                    ...(body.sha256 === undefined ? {} : { sha256: body.sha256 }),
                    identity: uploadIdentity(request),
                });
                return reply.code(201).send(publicUpload(session, []));
            } catch (error) {
                return failed(reply, error);
            }
        });

        scope.get<{ Params: { id: string } }>('/api/uploads/:id', async (request, reply) => {
            try {
                const session = await readOwnedUpload(request.params.id, uploadIdentity(request));
                return publicUpload(session, await receivedChunks(session.id));
            } catch (error) {
                return failed(reply, error);
            }
        });

        scope.put<{ Params: { id: string; index: string } }>('/api/uploads/:id/chunks/:index', {
            bodyLimit: chunkSize,
        }, async (request, reply) => {
            try {
                const session = await readOwnedUpload(request.params.id, uploadIdentity(request));
                if (!/^\d{1,7}$/.test(request.params.index)) {
                    throw new UploadError(400, 'The chunk index must be a whole number');
                }
                if (!Buffer.isBuffer(request.body)) {
                    throw new UploadError(415, 'Send the chunk as a raw application/octet-stream body');
                }
                const written = await writeChunk({
                    session,
                    index: Number(request.params.index),
                    body: request.body,
                    sha256: request.headers['x-chunk-sha256'],
                });
                return { ...written, chunkCount: session.chunkCount };
            } catch (error) {
                return failed(reply, error);
            }
        });

        scope.post<{ Params: { id: string } }>('/api/uploads/:id/complete', async (request, reply) => {
            const active = store();
            if (!active) return reply.code(503).send({ error: 'The content library needs a database connection' });
            const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
            let session;
            try {
                session = await readOwnedUpload(request.params.id, uploadIdentity(request));
                const assembled = await completeUpload(session);
                // `tagList` speaks in plain Errors; a bad tag is the caller's
                // mistake, not a 500.
                let tags: string[] | undefined;
                try {
                    tags = tagList(body.tags, 'tags');
                } catch (error) {
                    throw new UploadError(400, error instanceof Error ? error.message : String(error));
                }
                const item = await ingestMedia(active, {
                    source: assembled.path,
                    originalName: session.name,
                    mimeType: session.mimeType || mimeTypeFor(session.name),
                    ...(tags ? { tags } : {}),
                    ...(body.crop === true ? { crop: true } : {}),
                });
                // The bytes now live under the content root; the session is spent.
                await abortUpload(session.id);
                return reply.code(201).send({ items: [item] });
            } catch (error) {
                return failed(reply, error);
            }
        });

        scope.delete<{ Params: { id: string } }>('/api/uploads/:id', async (request, reply) => {
            try {
                const session = await readOwnedUpload(request.params.id, uploadIdentity(request));
                await abortUpload(session.id);
                return reply.code(204).send();
            } catch (error) {
                return failed(reply, error);
            }
        });
    });
}
