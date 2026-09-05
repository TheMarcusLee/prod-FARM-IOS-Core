import type { FastifyRequest } from 'fastify';

export interface TokenIdentity {
    id: string;
    name: string;
}

/** A cookie session, or loopback with no auth at all, is one shared local identity. */
export const LOCAL_IDENTITY: TokenIdentity = { id: 'local', name: 'local' };

/**
 * The named-token work decorates the request with `apiToken`. It lands on a
 * sibling branch, so this reads the decoration defensively and falls back to the
 * local identity rather than depending on it.
 */
export function tokenIdentity(request: FastifyRequest): TokenIdentity {
    const decorated = (request as FastifyRequest & { apiToken?: { id?: unknown; name?: unknown } }).apiToken;
    const id = typeof decorated?.id === 'string' ? decorated.id.trim() : '';
    if (!id) return LOCAL_IDENTITY;
    const name = typeof decorated?.name === 'string' && decorated.name.trim() ? decorated.name.trim() : id;
    return { id, name };
}
