import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { DatabaseConnection } from '../database/client.js';
import { eventAcks } from '../database/schema.js';
import { tokenIdentity } from './identity.js';

export interface EventAckStore {
    /** The highest acknowledged event id for a token identity; 0 when it has never acknowledged. */
    mark(tokenId: string): Promise<number>;
    /** Monotonic: an older `upToId` never rewinds the mark. Returns the stored mark. */
    acknowledge(tokenId: string, upToId: number, now?: Date): Promise<number>;
}

export function createMemoryAckStore(seed: Readonly<Record<string, number>> = {}): EventAckStore {
    const marks = new Map<string, number>(Object.entries(seed));
    return {
        async mark(tokenId) { return marks.get(tokenId) ?? 0; },
        async acknowledge(tokenId, upToId) {
            const next = Math.max(marks.get(tokenId) ?? 0, upToId);
            marks.set(tokenId, next);
            return next;
        },
    };
}

export function createAckStore(connection: DatabaseConnection): EventAckStore {
    const { db } = connection;
    return {
        async mark(tokenId) {
            const [row] = await db.select().from(eventAcks).where(eq(eventAcks.tokenId, tokenId));
            return Number(row?.upToId ?? 0);
        },
        async acknowledge(tokenId, upToId, now = new Date()) {
            const [row] = await db.insert(eventAcks).values({ tokenId, upToId, updatedAt: now })
                .onConflictDoUpdate({
                    target: eventAcks.tokenId,
                    // greatest() keeps the mark monotonic when two phones race.
                    set: { upToId: sql`greatest(${eventAcks.upToId}, ${upToId})`, updatedAt: now },
                }).returning();
            return Number(row?.upToId ?? upToId);
        },
    };
}

/**
 * `GET /api/events?acknowledged=false` lives on the fleet routes, but the ack
 * store is owned by the push routes. Rather than widen the fleet options (and
 * collide with the branches editing them), the push routes attach their store to
 * the Fastify instance here and the fleet handler looks it up at request time.
 */
const attached = new WeakMap<FastifyInstance, EventAckStore>();

export function attachAckStore(app: FastifyInstance, store: EventAckStore): void {
    attached.set(app, store);
}

/**
 * The caller's acknowledgement mark, or undefined when acknowledgement is not
 * wired up — in which case `?acknowledged=false` degrades to "everything".
 */
export async function acknowledgedMark(app: FastifyInstance, request: FastifyRequest): Promise<number | undefined> {
    const store = attached.get(app);
    if (!store) return undefined;
    return store.mark(tokenIdentity(request).id);
}
