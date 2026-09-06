/**
 * Chunked, resumable uploads.
 *
 * A content clip is routinely hundreds of megabytes and the dashboard is often
 * reached through a tunnel that caps a single body. So a big file arrives as a
 * sequence of bounded `PUT`s instead: the session records what the file will
 * be, every chunk is written straight into its final offset of one `data` file,
 * and completion is a readdir plus an optional hash rather than a copy.
 *
 * Nothing in here speaks HTTP — `src/api/routes/uploads.ts` is the transport
 * and the MCP server calls the same functions in-process.
 */

import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { dataRoot, safeFileName } from './paths.js';

/** Sessions are named by us and never by the client; nothing else is accepted. */
export const UPLOAD_ID_PATTERN = /^[0-9a-f]{32}$/;

/** A chunk's `X-Chunk-Sha256` — lower-case hex, exactly one digest. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Sessions older than this are swept, finished or not. */
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const META_FILE = 'meta.json';
const DATA_FILE = 'data';
const PARTS_DIRECTORY = 'parts';

function positiveEnv(name: string, fallback: number, environment: NodeJS.ProcessEnv): number {
    const parsed = Number(environment[name]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** One chunk, and therefore one request body. 8 MiB clears every tunnel we have met. */
export function uploadChunkBytes(environment: NodeJS.ProcessEnv = process.env): number {
    return positiveEnv('UPLOAD_CHUNK_BYTES', 8 * 1024 * 1024, environment);
}

/** The largest file a session may declare. */
export function uploadMaxBytes(environment: NodeJS.ProcessEnv = process.env): number {
    return positiveEnv('UPLOAD_MAX_BYTES', 4 * 1024 * 1024 * 1024, environment);
}

/** How many unfinished sessions one token identity may hold open at once. */
export function maxConcurrentUploads(environment: NodeJS.ProcessEnv = process.env): number {
    return positiveEnv('UPLOAD_MAX_CONCURRENT', 4, environment);
}

/** `SCHEDULER_DATA_DIR/uploads` — one directory per session lives under it. */
export function uploadsRoot(): string {
    return path.join(dataRoot(), 'uploads');
}

export interface UploadSession {
    id: string;
    /** Already run through `safeFileName`; it is what the asset row will show. */
    name: string;
    size: number;
    mimeType: string;
    /** Whole-file digest, when the client committed to one up front. */
    sha256?: string;
    chunkSize: number;
    chunkCount: number;
    /** The token id that opened the session. Another identity gets a 404. */
    identity: string;
    createdAt: string;
    expiresAt: string;
}

/** Carries the status the route should answer with, so the routes stay thin. */
export class UploadError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.name = 'UploadError';
        this.statusCode = statusCode;
    }
}

function notFound(): UploadError {
    return new UploadError(404, 'Upload session not found');
}

export function sessionDirectory(id: string): string {
    if (!UPLOAD_ID_PATTERN.test(id)) throw notFound();
    return path.join(uploadsRoot(), id);
}

/** Every path this module touches is built from an id we generated, never from client text. */
function sessionFile(id: string, ...parts: string[]): string {
    return path.join(sessionDirectory(id), ...parts);
}

export function chunkCountFor(size: number, chunkSize: number): number {
    return Math.max(1, Math.ceil(size / chunkSize));
}

/** The declared length of one chunk; the last one is the remainder. */
export function chunkLength(session: Pick<UploadSession, 'size' | 'chunkSize' | 'chunkCount'>, index: number): number {
    return index === session.chunkCount - 1 ? session.size - index * session.chunkSize : session.chunkSize;
}

async function hashFile(file: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await pipeline(createReadStream(file), hash);
    return hash.digest('hex');
}

function requireText(value: unknown, field: string, limit: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new UploadError(400, `${field} is required`);
    if (value.length > limit) throw new UploadError(400, `${field} must be at most ${limit} characters`);
    return value.trim();
}

export interface CreateUploadInput {
    name: unknown;
    size: unknown;
    mimeType: unknown;
    sha256?: unknown;
    identity: string;
    now?: Date;
}

/**
 * Validates the declaration and lays out the session directory. The data file
 * is created empty; chunks extend it by writing at their own offset, so a
 * session never holds more than one chunk in memory anywhere.
 */
export async function createUpload(input: CreateUploadInput): Promise<UploadSession> {
    const name = safeFileName(requireText(input.name, 'name', 300));
    const mimeType = requireText(input.mimeType, 'mimeType', 200);
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new UploadError(400, 'mimeType must be a media type');
    const size = typeof input.size === 'number' ? input.size : Number.NaN;
    if (!Number.isSafeInteger(size) || size <= 0) throw new UploadError(400, 'size must be a positive whole number of bytes');
    const limit = uploadMaxBytes();
    if (size > limit) throw new UploadError(413, `size must be at most ${limit} bytes`);
    let sha256: string | undefined;
    if (input.sha256 !== undefined && input.sha256 !== null && input.sha256 !== '') {
        if (typeof input.sha256 !== 'string' || !SHA256_PATTERN.test(input.sha256)) {
            throw new UploadError(400, 'sha256 must be a lower-case hex sha256 digest');
        }
        sha256 = input.sha256;
    }

    const now = input.now ?? new Date();
    const openCount = await countOpenUploads(input.identity, now);
    const concurrent = maxConcurrentUploads();
    if (openCount >= concurrent) {
        throw new UploadError(429, `Only ${concurrent} uploads may be open at once — finish or cancel one first`);
    }

    const chunkSize = uploadChunkBytes();
    const session: UploadSession = {
        id: crypto.randomBytes(16).toString('hex'),
        name, size, mimeType,
        ...(sha256 ? { sha256 } : {}),
        chunkSize,
        chunkCount: chunkCountFor(size, chunkSize),
        identity: input.identity,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + UPLOAD_TTL_MS).toISOString(),
    };
    await mkdir(sessionFile(session.id, PARTS_DIRECTORY), { recursive: true });
    await writeFile(sessionFile(session.id, META_FILE), JSON.stringify(session), { mode: 0o600 });
    // `wx` so a session id collision fails loudly rather than quietly reusing
    // a stranger's bytes.
    const handle = await open(sessionFile(session.id, DATA_FILE), 'wx', 0o600);
    await handle.close();
    return session;
}

/** Reads a session back, or throws the 404 the routes should answer with. */
export async function readUpload(id: string): Promise<UploadSession> {
    const raw = await readFile(sessionFile(id, META_FILE), 'utf8').catch(() => null);
    if (raw === null) throw notFound();
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw notFound();
    }
    const session = parsed as UploadSession;
    if (!session || typeof session !== 'object' || session.id !== id) throw notFound();
    return session;
}

/**
 * The session, if this identity owns it. A session belonging to someone else is
 * indistinguishable from one that never existed — an owner check that answered
 * 403 would confirm the id.
 */
export async function readOwnedUpload(id: string, identity: string, now: Date = new Date()): Promise<UploadSession> {
    const session = await readUpload(id);
    if (session.identity !== identity) throw notFound();
    if (Date.parse(session.expiresAt) <= now.getTime()) throw notFound();
    return session;
}

/** Chunk indices already on disk, ascending. */
export async function receivedChunks(id: string): Promise<number[]> {
    const names = await readdir(sessionFile(id, PARTS_DIRECTORY)).catch(() => [] as string[]);
    return names
        .filter((name) => /^\d+$/.test(name))
        .map((name) => Number(name))
        .sort((a, b) => a - b);
}

export interface WriteChunkInput {
    session: UploadSession;
    index: number;
    body: Buffer;
    /** The `X-Chunk-Sha256` header. A chunk that arrives without one is refused. */
    sha256: unknown;
}

/**
 * Writes one chunk at its own offset and only then records it as received, so a
 * connection that dies mid-write leaves the chunk missing rather than short.
 */
export async function writeChunk(input: WriteChunkInput): Promise<{ index: number; received: number }> {
    const { session, index, body } = input;
    if (!Number.isInteger(index) || index < 0 || index >= session.chunkCount) {
        throw new UploadError(400, `index must be a whole number between 0 and ${session.chunkCount - 1}`);
    }
    if (typeof input.sha256 !== 'string' || !SHA256_PATTERN.test(input.sha256)) {
        throw new UploadError(400, 'X-Chunk-Sha256 must be a lower-case hex sha256 digest of the chunk');
    }
    const expected = chunkLength(session, index);
    if (body.length !== expected) {
        throw new UploadError(400, `Chunk ${index} must be exactly ${expected} bytes`);
    }
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    if (digest !== input.sha256) throw new UploadError(400, `Chunk ${index} does not match its X-Chunk-Sha256`);

    const handle = await open(sessionFile(session.id, DATA_FILE), 'r+');
    try {
        await handle.write(body, 0, body.length, index * session.chunkSize);
    } finally {
        await handle.close();
    }
    // The marker is the record that the bytes landed; it is written last on
    // purpose, and its content is only ever there for a human reading the disk.
    await writeFile(sessionFile(session.id, PARTS_DIRECTORY, String(index)), digest, { mode: 0o600 });
    return { index, received: (await receivedChunks(session.id)).length };
}

/**
 * Verifies the session is whole and hands back the assembled file. Because
 * every chunk was written in place there is nothing to concatenate: this is a
 * readdir, a stat, and the whole-file digest when one was declared.
 */
export async function completeUpload(session: UploadSession): Promise<{ path: string; size: number; sha256: string }> {
    const received = new Set(await receivedChunks(session.id));
    const missing: number[] = [];
    for (let index = 0; index < session.chunkCount; index += 1) {
        if (!received.has(index)) missing.push(index);
    }
    if (missing.length) {
        const shown = missing.slice(0, 20).join(', ');
        throw new UploadError(409, `${missing.length} chunk(s) are still missing: ${shown}${missing.length > 20 ? ', …' : ''}`);
    }
    const file = sessionFile(session.id, DATA_FILE);
    const info = await stat(file).catch(() => null);
    if (!info || info.size !== session.size) {
        throw new UploadError(409, `The assembled file is ${info?.size ?? 0} bytes, not the declared ${session.size}`);
    }
    const digest = await hashFile(file);
    if (session.sha256 && digest !== session.sha256) {
        throw new UploadError(422, 'The assembled file does not match the sha256 the upload declared');
    }
    return { path: file, size: info.size, sha256: digest };
}

/** Drops a session and everything it wrote. Missing is success — abort is idempotent. */
export async function abortUpload(id: string): Promise<void> {
    await rm(sessionDirectory(id), { recursive: true, force: true });
}

/** Unfinished, unexpired sessions this identity holds — the concurrency budget. */
export async function countOpenUploads(identity: string, now: Date = new Date()): Promise<number> {
    let open = 0;
    for (const session of await listUploads()) {
        if (session.identity === identity && Date.parse(session.expiresAt) > now.getTime()) open += 1;
    }
    return open;
}

/**
 * Every readable session. `POST /api/assets` writes plain files into the same
 * directory, so only directories whose name is one of our ids are considered.
 */
export async function listUploads(): Promise<UploadSession[]> {
    const entries = await readdir(uploadsRoot(), { withFileTypes: true }).catch(() => []);
    const sessions: UploadSession[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !UPLOAD_ID_PATTERN.test(entry.name)) continue;
        const session = await readUpload(entry.name).catch(() => null);
        if (session) sessions.push(session);
    }
    return sessions;
}

/**
 * Removes expired sessions. A directory whose meta is unreadable is only
 * removed once it is older than the TTL, so a session being created right now
 * is never swept out from under its own first chunk.
 */
export async function sweepUploads(now: Date = new Date()): Promise<number> {
    const entries = await readdir(uploadsRoot(), { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory() || !UPLOAD_ID_PATTERN.test(entry.name)) continue;
        const session = await readUpload(entry.name).catch(() => null);
        let expired: boolean;
        if (session) {
            expired = Date.parse(session.expiresAt) <= now.getTime();
        } else {
            const info = await stat(path.join(uploadsRoot(), entry.name)).catch(() => null);
            expired = !info || now.getTime() - info.mtimeMs > UPLOAD_TTL_MS;
        }
        if (!expired) continue;
        await abortUpload(entry.name);
        removed += 1;
    }
    return removed;
}

export interface UploadSweepOptions {
    intervalMinutes?: number;
    now?: () => Date;
    log?: (error: unknown) => void;
}

/**
 * Sweeps once at boot and then hourly. `unref` so a sweep timer never holds the
 * process open — the same shape the drip planner tick uses.
 */
export function startUploadSweep(options: UploadSweepOptions = {}): { stop: () => void } | null {
    const minutes = options.intervalMinutes ?? 60;
    const clock = options.now ?? (() => new Date());
    const run = () => { void sweepUploads(clock()).catch((error) => options.log?.(error)); };
    run();
    if (minutes <= 0) return null;
    const timer = setInterval(run, minutes * 60_000);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
}

/** Public view of a session — the identity that owns it is never echoed back. */
export function publicUpload(session: UploadSession, received: number[]): Record<string, unknown> {
    return {
        id: session.id,
        name: session.name,
        size: session.size,
        mimeType: session.mimeType,
        chunkSize: session.chunkSize,
        chunkCount: session.chunkCount,
        received,
        expiresAt: session.expiresAt,
        ...(session.sha256 ? { sha256: session.sha256 } : {}),
    };
}
