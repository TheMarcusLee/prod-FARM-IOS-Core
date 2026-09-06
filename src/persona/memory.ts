/**
 * What an account remembers between runs.
 *
 * The follow rule — "like three videos from the same creator inside four sessions, then follow
 * them" — is meaningless inside a single run: a session is twenty minutes and nobody likes the same
 * creator three times in twenty minutes. So the counters live on disk, one small JSON file per
 * handle under `SCHEDULER_DATA_DIR/persona-memory/`, written temp-file-then-rename like everything
 * else in Backline. The same file is what "already followed" reads, and what the Accounts page
 * shows the operator as "what it did lately".
 *
 * A memory file is disposable. Delete it and the account simply starts over as a stranger.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normaliseHandle } from './model.js';

/** Which sessions this account liked a given creator in. */
export interface CreatorMemory {
    /** Session indices, newest last, capped. */
    likes: number[];
    /** Session index the follow happened in, when it has. */
    followedAt?: number;
}

/** One line of "what it did lately". */
export interface SessionRecord {
    index: number;
    startedAt: string;
    minutes: number;
    videos: number;
    likes: number;
    saves: number;
    follows: number;
    searches: number;
    /** The interests that actually matched something, most frequent first. */
    matched: string[];
    followedCreators: string[];
    /** 'completed' or 'stopped', in the doomscroll summary's words. */
    ending: string;
}

export interface PersonaMemory {
    handle: string;
    /** Incremented once per session; the follow rule's window is measured in these. */
    sessionIndex: number;
    creators: Record<string, CreatorMemory>;
    followed: string[];
    /** Newest first. */
    sessions: SessionRecord[];
}

/** How many sessions of history are kept, and how many like marks per creator. */
export const MEMORY_LIMITS = { sessions: 12, likesPerCreator: 40, creators: 500 } as const;

export function emptyMemory(handle: string): PersonaMemory {
    return { handle: normaliseHandle(handle), sessionIndex: 0, creators: {}, followed: [], sessions: [] };
}

export function memoryDirectory(directory?: string): string {
    const root = directory ?? path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
    return path.join(root, 'persona-memory');
}

/**
 * One file per handle. The handle is validated first and then percent-encoded, so nothing a handle
 * could contain — a dot run, a separator — can reach outside the directory.
 */
export function memoryPath(handle: string, directory?: string): string {
    return path.join(memoryDirectory(directory), `${encodeURIComponent(normaliseHandle(handle))}.json`);
}

function coerce(handle: string, value: unknown): PersonaMemory {
    const base = emptyMemory(handle);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
    const input = value as Record<string, unknown>;
    const creators: Record<string, CreatorMemory> = {};
    if (input.creators && typeof input.creators === 'object' && !Array.isArray(input.creators)) {
        for (const [creator, entry] of Object.entries(input.creators as Record<string, unknown>)) {
            const record = entry as { likes?: unknown; followedAt?: unknown } | null;
            const likes = Array.isArray(record?.likes)
                ? record!.likes.filter((index): index is number => Number.isInteger(index)) : [];
            creators[creator] = {
                likes: likes.slice(-MEMORY_LIMITS.likesPerCreator),
                ...(Number.isInteger(record?.followedAt) ? { followedAt: record!.followedAt as number } : {}),
            };
        }
    }
    return {
        handle: base.handle,
        sessionIndex: Number.isInteger(input.sessionIndex) ? input.sessionIndex as number : 0,
        creators,
        followed: Array.isArray(input.followed) ? input.followed.filter((entry): entry is string => typeof entry === 'string') : [],
        sessions: Array.isArray(input.sessions)
            ? (input.sessions.filter((entry) => entry && typeof entry === 'object') as SessionRecord[]).slice(0, MEMORY_LIMITS.sessions)
            : [],
    };
}

/** Never throws: a missing or corrupt memory file means this account is a stranger again. */
export async function readMemory(handle: string, directory?: string): Promise<PersonaMemory> {
    try {
        return coerce(handle, JSON.parse(await readFile(memoryPath(handle, directory), 'utf8')));
    } catch {
        return emptyMemory(handle);
    }
}

export async function writeMemory(memory: PersonaMemory, directory?: string): Promise<void> {
    const target = memoryPath(memory.handle, directory);
    await mkdir(path.dirname(target), { recursive: true });
    const temporaryPath = `${target}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(memory, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, target);
}

/**
 * Likes per creator inside the follow rule's window. Older marks are ignored rather than deleted:
 * an account that liked a creator twice a month ago and once today has not "kept enjoying" them.
 */
export function creatorLikeCounts(memory: PersonaMemory, withinSessions: number, currentIndex = memory.sessionIndex): Record<string, number> {
    const floor = currentIndex - withinSessions + 1;
    const counts: Record<string, number> = {};
    for (const [creator, entry] of Object.entries(memory.creators)) {
        const recent = entry.likes.filter((index) => index >= floor).length;
        if (recent > 0) counts[creator] = recent;
    }
    return counts;
}

/** Starts a new session; returns the index the run should record its likes against. */
export function startSession(memory: PersonaMemory): number {
    memory.sessionIndex += 1;
    return memory.sessionIndex;
}

export function noteLike(memory: PersonaMemory, creator: string, sessionIndex: number): void {
    if (!creator) return;
    const entry = memory.creators[creator] ?? { likes: [] };
    entry.likes = [...entry.likes, sessionIndex].slice(-MEMORY_LIMITS.likesPerCreator);
    memory.creators[creator] = entry;
    // Keep the file small on a farm that scrolls for months: drop the creators with the oldest marks.
    const creators = Object.entries(memory.creators);
    if (creators.length > MEMORY_LIMITS.creators) {
        creators.sort((a, b) => (b[1].likes.at(-1) ?? 0) - (a[1].likes.at(-1) ?? 0));
        memory.creators = Object.fromEntries(creators.slice(0, MEMORY_LIMITS.creators));
    }
}

export function noteFollow(memory: PersonaMemory, creator: string, sessionIndex: number): void {
    if (!creator) return;
    const entry = memory.creators[creator] ?? { likes: [] };
    entry.followedAt = sessionIndex;
    memory.creators[creator] = entry;
    if (!memory.followed.includes(creator)) memory.followed.push(creator);
}

export function recordSession(memory: PersonaMemory, record: SessionRecord): void {
    memory.sessions = [record, ...memory.sessions].slice(0, MEMORY_LIMITS.sessions);
}

/* ---- Reading it back --------------------------------------------------- */

export interface MemorySummary {
    sessions: number;
    followed: string[];
    /** The creators this account keeps liking, most-liked first. */
    favourites: Array<{ creator: string; likes: number }>;
    /** Interests that actually matched something recently, most frequent first. */
    matched: string[];
    recent: SessionRecord[];
    /** One sentence for the Accounts panel. */
    headline: string;
}

/** What the Accounts page shows: what this account has actually been doing, in plain words. */
export function summariseMemory(memory: PersonaMemory): MemorySummary {
    const favourites = Object.entries(memory.creators)
        .map(([creator, entry]) => ({ creator, likes: entry.likes.length }))
        .filter(({ likes }) => likes > 0)
        .sort((a, b) => b.likes - a.likes)
        .slice(0, 6);
    const tally = new Map<string, number>();
    for (const session of memory.sessions) {
        for (const term of session.matched ?? []) tally.set(term, (tally.get(term) ?? 0) + 1);
    }
    const matched = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([term]) => term).slice(0, 8);
    const recent = memory.sessions.slice(0, 5);
    const totals = recent.reduce((sum, session) => ({
        likes: sum.likes + (session.likes ?? 0),
        saves: sum.saves + (session.saves ?? 0),
        follows: sum.follows + (session.follows ?? 0),
        videos: sum.videos + (session.videos ?? 0),
    }), { likes: 0, saves: 0, follows: 0, videos: 0 });
    const headline = recent.length
        ? `Last ${recent.length} ${recent.length === 1 ? 'session' : 'sessions'}: ${totals.videos} videos, ${totals.likes} likes, ${totals.saves} saves, ${totals.follows} follows.`
        : 'This account has not scrolled with a persona yet.';
    return { sessions: memory.sessionIndex, followed: [...memory.followed], favourites, matched, recent, headline };
}

/** Convenience for the Accounts page and the routines: read and summarise in one call. */
export async function readMemorySummary(handle: string, directory?: string): Promise<MemorySummary> {
    return summariseMemory(await readMemory(handle, directory));
}
