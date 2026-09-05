import type { FastifyRequest } from 'fastify';

export interface TokenIdentity {
    id: string;
    name: string;
}

/** Loopback with no auth provider at all. A cookie session is `{ id: 'session' }`, not this. */
export const LOCAL_IDENTITY: TokenIdentity = { id: 'local', name: 'local' };

/**
 * The auth provider decorates the request with `apiToken` — the token's own
 * `{ id, name }` for a bearer request, `SESSION_IDENTITY` for a cookie session.
 * This reads the decoration defensively and falls back to the local identity so
 * a farm with no auth provider configured still has one stable ack bucket.
 */
export function tokenIdentity(request: FastifyRequest): TokenIdentity {
    const decorated = (request as FastifyRequest & { apiToken?: { id?: unknown; name?: unknown } }).apiToken;
    const id = typeof decorated?.id === 'string' ? decorated.id.trim() : '';
    if (!id) return LOCAL_IDENTITY;
    const name = typeof decorated?.name === 'string' && decorated.name.trim() ? decorated.name.trim() : id;
    return { id, name };
}
