import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { DatabaseConnection } from '../database/client.js';
import { pushRegistrations, type PushRegistrationRow } from '../database/schema.js';
import {
    isEventKind, isEventSeverity, severityRank, type EventKind, type EventSeverity, type FarmEvent,
} from '../fleet/events.js';
import type { JsonObject } from '../types.js';

export interface PushRegistration {
    id: string;
    expoPushToken: string;
    name: string;
    minSeverity: EventSeverity;
    /** Null means "every kind at or above minSeverity". */
    kinds: EventKind[] | null;
    tokenId: string;
    createdAt: Date;
    lastSeenAt: Date;
    lastError: string | null;
}

export interface RegistrationInput {
    expoPushToken: string;
    name: string;
    minSeverity: EventSeverity;
    kinds: EventKind[] | null;
    tokenId: string;
}

export interface PushRegistrationStore {
    /** Idempotent on the Expo token: an existing row is updated and its lastSeenAt bumped. */
    upsert(input: RegistrationInput, now?: Date): Promise<{ registration: PushRegistration; created: boolean }>;
    list(): Promise<PushRegistration[]>;
    remove(id: string): Promise<boolean>;
    /** Records the last Expo receipt error against a registration; unknown ids are ignored. */
    recordError(id: string, error: string | null): Promise<boolean>;
}

/** Expo hands out `ExponentPushToken[…]`; the newer SDKs also emit `ExpoPushToken[…]`. */
const EXPO_TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_\-%]{1,128}\]$/;

export function isExpoPushToken(value: unknown): value is string {
    return typeof value === 'string' && EXPO_TOKEN_PATTERN.test(value);
}

/** Never log or return a whole push token — the last six characters identify it well enough. */
export function tokenSuffix(expoPushToken: string): string {
    const inner = expoPushToken.replace(/^Expo(?:nent)?PushToken\[|\]$/g, '');
    return inner.slice(-6);
}

function badRequest(message: string): Error & { statusCode: number } {
    return Object.assign(new Error(message), { statusCode: 400 });
}

/** Explicit whitelist: anything the app sends beyond these four fields is dropped. */
export function parseRegistration(body: unknown, tokenId: string): RegistrationInput {
    const source = (body ?? {}) as Record<string, unknown>;
    if (!isExpoPushToken(source.expoPushToken)) {
        throw badRequest('expoPushToken must look like ExponentPushToken[…] or ExpoPushToken[…]');
    }
    const name = typeof source.name === 'string' ? source.name.trim() : '';
    if (!name) throw badRequest('name is required');
    const minSeverity = source.minSeverity ?? 'warning';
    if (!isEventSeverity(minSeverity)) throw badRequest('minSeverity must be info, warning or error');
    let kinds: EventKind[] | null = null;
    if (source.kinds !== undefined && source.kinds !== null) {
        if (!Array.isArray(source.kinds)) throw badRequest('kinds must be an array of event kinds, or null');
        for (const kind of source.kinds) {
            if (!isEventKind(kind)) throw badRequest(`Unknown event kind "${String(kind)}"`);
        }
        kinds = [...new Set(source.kinds as EventKind[])];
        if (!kinds.length) throw badRequest('kinds must not be empty — omit it for every kind');
    }
    return { expoPushToken: source.expoPushToken, name: name.slice(0, 80), minSeverity, kinds, tokenId };
}

/** The wire shape. The push token itself never leaves the farm. */
export function serializeRegistration(registration: PushRegistration): JsonObject {
    return {
        id: registration.id,
        name: registration.name,
        tokenSuffix: tokenSuffix(registration.expoPushToken),
        minSeverity: registration.minSeverity,
        kinds: registration.kinds,
        tokenId: registration.tokenId,
        createdAt: registration.createdAt.toISOString(),
        lastSeenAt: registration.lastSeenAt.toISOString(),
        lastError: registration.lastError,
    };
}

/** `kinds` wins when it is set; otherwise the severity floor applies. */
export function matchesRegistration(
    registration: Pick<PushRegistration, 'minSeverity' | 'kinds'>, event: Pick<FarmEvent, 'kind' | 'severity'>,
): boolean {
    if (registration.kinds?.length) return registration.kinds.includes(event.kind);
    return severityRank(event.severity) >= severityRank(registration.minSeverity);
}

function toRegistration(row: PushRegistrationRow): PushRegistration {
    return {
        id: row.id, expoPushToken: row.expoPushToken, name: row.name, minSeverity: row.minSeverity,
        kinds: (row.kinds as EventKind[] | null) ?? null, tokenId: row.tokenId,
        createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, lastError: row.lastError,
    };
}

/** Array-backed twin of the SQL store, for tests and for a farm without a database. */
export function createMemoryRegistrationStore(seed: readonly PushRegistration[] = []): PushRegistrationStore {
    const rows: PushRegistration[] = [...seed];
    return {
        async upsert(input, now = new Date()) {
            const existing = rows.find((row) => row.expoPushToken === input.expoPushToken);
            if (existing) {
                Object.assign(existing, {
                    name: input.name, minSeverity: input.minSeverity, kinds: input.kinds,
                    tokenId: input.tokenId, lastSeenAt: now, lastError: null,
                });
                return { registration: { ...existing }, created: false };
            }
            const registration: PushRegistration = {
                id: randomUUID(), ...input, createdAt: now, lastSeenAt: now, lastError: null,
            };
            rows.push(registration);
            return { registration: { ...registration }, created: true };
        },
        async list() { return rows.map((row) => ({ ...row })); },
        async remove(id) {
            const index = rows.findIndex((row) => row.id === id);
            if (index < 0) return false;
            rows.splice(index, 1);
            return true;
        },
        async recordError(id, error) {
            const row = rows.find((candidate) => candidate.id === id);
            if (!row) return false;
            row.lastError = error;
            return true;
        },
    };
}

export function createRegistrationStore(connection: DatabaseConnection): PushRegistrationStore {
    const { db } = connection;
    return {
        async upsert(input, now = new Date()) {
            const before = await db.select({ id: pushRegistrations.id }).from(pushRegistrations)
                .where(eq(pushRegistrations.expoPushToken, input.expoPushToken));
            const [row] = await db.insert(pushRegistrations)
                .values({ ...input, createdAt: now, lastSeenAt: now })
                .onConflictDoUpdate({
                    target: pushRegistrations.expoPushToken,
                    set: {
                        name: input.name, minSeverity: input.minSeverity, kinds: input.kinds,
                        tokenId: input.tokenId, lastSeenAt: now, lastError: null,
                    },
                }).returning();
            if (!row) throw new Error('Unable to store the push registration');
            return { registration: toRegistration(row), created: before.length === 0 };
        },
        async list() {
            const rows = await db.select().from(pushRegistrations).orderBy(pushRegistrations.createdAt);
            return rows.map(toRegistration);
        },
        async remove(id) {
            const removed = await db.delete(pushRegistrations).where(eq(pushRegistrations.id, id)).returning();
            return removed.length > 0;
        },
        async recordError(id, error) {
            const updated = await db.update(pushRegistrations).set({ lastError: error })
                .where(eq(pushRegistrations.id, id)).returning();
            return updated.length > 0;
        },
    };
}

/** Postgres rejects a malformed uuid outright; the routes answer 404 instead of 500. */
export function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
