/**
 * Who is making the request. Every authenticated request carries one: an API
 * token minted by `npm run token:create`, or the browser's cookie session.
 *
 * The declaration lives here rather than in `local.ts` so a third-party
 * `AuthProvider` can populate the same field without importing the built-in
 * provider, and so the rate limiter can key on it.
 */
export interface ApiTokenIdentity {
    /** The token id from `.auth.json`, or `'session'` for a cookie login. */
    id: string;
    /** The token name, or the dashboard login user for a session. */
    name: string;
}

/** The session identity: one shared operator account, so one fixed name. */
export const SESSION_IDENTITY: ApiTokenIdentity = { id: 'session', name: 'local' };

declare module 'fastify' {
    interface FastifyRequest {
        /** Set by the auth provider on every authenticated request; absent when auth is off. */
        apiToken?: ApiTokenIdentity;
    }
}
