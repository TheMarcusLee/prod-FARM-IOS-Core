import type { FastifyInstance } from 'fastify';

import { defaultAuthStatePath, listApiTokens, revokeApiTokenById, type ApiToken } from './state.js';

export interface TokenRouteOptions {
    /** Where the API tokens live. Defaults to AUTH_STATE_PATH / `.auth.json`. */
    statePath?: string;
}

export interface PublicApiToken {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
}

/** Never the digest: knowing sha256 of a token is knowing enough to attack it offline. */
export function publicToken(token: ApiToken): PublicApiToken {
    return { id: token.id, name: token.name, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt ?? null };
}

/**
 * Listing and revoking the named tokens from `npm run token:create`. This is
 * what makes "my phone was stolen" one `DELETE`, instead of a rotation that
 * logs out the desktop app and the push relay at the same time.
 */
export async function registerTokenRoutes(app: FastifyInstance, options: TokenRouteOptions = {}): Promise<void> {
    const statePath = options.statePath ?? defaultAuthStatePath();

    app.get('/api/tokens', async () => ({ tokens: (await listApiTokens(statePath)).map(publicToken) }));

    app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (request, reply) => {
        const removed = await revokeApiTokenById(statePath, request.params.id);
        if (!removed) return reply.code(404).send({ error: 'Token not found' });
        app.log.info({ revokedToken: removed.name, by: request.apiToken?.name ?? 'unknown' }, 'API token revoked');
        return reply.code(204).send();
    });
}
