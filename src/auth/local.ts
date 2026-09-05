import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedUser, AuthProvider } from '../plugin.js';
import {
    defaultAuthStatePath, readAuthState, revokeSession, sessionRevoked, touchApiToken, tokenForAuthorization,
    verifyPassword, type AuthState,
} from './state.js';
import { SESSION_IDENTITY } from './types.js';

export const SESSION_COOKIE = 'phone_farm_session';

/**
 * Whether this token id is still in the state file. Authentication happens once, at the start of
 * a request — which is fine for a request, and wrong for a connection that stays open for hours:
 * a revoked phone kept receiving the fleet's whole event stream over SSE until it disconnected.
 * Long-lived handlers call this on a timer, so it does only what it has to: one small JSON read,
 * no scrypt, no hashing.
 */
export async function isTokenActive(id: string, statePath = defaultAuthStatePath()): Promise<boolean> {
    // A cookie session is not a token; its own revocation is checked by `authenticate`, and there
    // is no sid on the request to re-check here.
    if (id === SESSION_IDENTITY.id) return true;
    const state = await readAuthState(statePath).catch(() => null);
    return Boolean(state?.tokens.some((token) => token.id === id));
}

export interface LocalAuthOptions {
    /** Defaults to AUTH_STATE_PATH, else `.auth.json` beside devices.json. */
    statePath?: string;
    sessionHours?: number;
    maxLoginAttempts?: number;
    loginWindowMinutes?: number;
}

interface AttemptBucket { count: number; resetAt: number }

function positiveNumber(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface SessionPayload { exp: number; sid: string }

/** The `sid` is what makes one cookie revocable without invalidating every other one. */
function signSession(secret: string, expiresAt: number, sid: string): string {
    const payload = Buffer.from(JSON.stringify({ exp: expiresAt, sid })).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

/** The signed, unexpired payload a cookie carries, or null. Revocation is checked by the caller. */
function sessionPayload(secret: string, value: string | undefined, now: number): SessionPayload | null {
    const [payload, signature] = (value ?? '').split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const given = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
    try {
        const { exp, sid } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SessionPayload>;
        // A cookie minted before sessions carried an id cannot be revoked, so it
        // is not honoured: the operator signs in once more and gets one that can.
        if (typeof exp !== 'number' || typeof sid !== 'string' || !sid || exp <= now) return null;
        return { exp, sid };
    } catch { return null; }
}

function sessionValid(state: AuthState, value: string | undefined, now: number): boolean {
    const payload = sessionPayload(state.sessionSecret, value, now);
    return payload !== null && !sessionRevoked(state, payload.sid, now);
}

function readCookie(header: string | undefined, name: string): string | undefined {
    for (const part of (header ?? '').split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return decodeURIComponent(rest.join('='));
    }
    return undefined;
}

/** Behind a TLS proxy the cookie must still get `Secure`; loopback http must not. */
function secureRequest(request: FastifyRequest): boolean {
    return request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(request: FastifyRequest, reply: FastifyReply, value: string, maxAgeSeconds: number): void {
    const attributes = [
        `${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`,
    ];
    if (secureRequest(request)) attributes.push('Secure');
    reply.header('set-cookie', attributes.join('; '));
}

function escapeHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Only same-site paths; never an absolute URL or a protocol-relative `//host`. */
function safeNext(value: unknown): string {
    const next = typeof value === 'string' ? value : '';
    return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

/** Standalone markup — the login page renders before any dashboard asset route is reachable. */
function loginPage(options: { message?: string; next: string; passwordSet: boolean }): string {
    const notice = options.passwordSet
        ? (options.message ? `<p class="error">${escapeHtml(options.message)}</p>` : '')
        : '<p class="error">No password is set yet. Run <code>npm run auth:set-password</code> on the farm host.</p>';
    const form = options.passwordSet
        ? `<form method="post" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(options.next)}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Sign in</button>
    </form>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Backline</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--bg:#080b10;--panel:#11161e;--border:#242c38;--text:#f5f7fa;--muted:#929cab;--accent:#ff365e}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% -20%,#1a2330 0,var(--bg) 42%);color:var(--text)}
.card{width:min(380px,100%);padding:28px;border:1px solid var(--border);border-radius:15px;background:var(--panel)}
h1{margin:0 0 6px;font-size:26px;letter-spacing:-.03em}p{margin:0 0 18px;color:var(--muted);font-size:13px;line-height:1.55}
.error{color:#fb7185}code{color:var(--text)}label{display:block;margin-bottom:7px;color:var(--muted);font-size:13px}
input{width:100%;min-height:42px;padding:0 12px;border:1px solid var(--border);border-radius:10px;background:#171d26;color:var(--text);font:inherit}
button{width:100%;min-height:42px;margin-top:14px;border:0;border-radius:10px;background:var(--accent);color:var(--text);font:inherit;font-weight:750;cursor:pointer}
button:hover{filter:brightness(1.08)}
</style></head><body><main class="card"><h1>Backline</h1><p>Sign in to reach the dashboard.</p>${notice}${form}</main></body></html>`;
}

/**
 * The built-in `PHONE_FARM_AUTH_PLUGIN=local` provider: a password login for the
 * browser and `Authorization: Bearer …` API tokens for agents and the MCP server.
 */
export function createLocalAuthProvider(options: LocalAuthOptions = {}): AuthProvider {
    const statePath = options.statePath ?? defaultAuthStatePath();
    const sessionHours = options.sessionHours ?? positiveNumber(process.env.AUTH_SESSION_HOURS, 12);
    const maxAttempts = options.maxLoginAttempts ?? positiveNumber(process.env.AUTH_LOGIN_MAX_ATTEMPTS, 5);
    const windowMinutes = options.loginWindowMinutes ?? positiveNumber(process.env.AUTH_LOGIN_WINDOW_MINUTES, 15);
    const attempts = new Map<string, AttemptBucket>();

    const throttled = (key: string, now: number): boolean => {
        const bucket = attempts.get(key);
        if (!bucket || bucket.resetAt <= now) return false;
        return bucket.count >= maxAttempts;
    };
    const recordFailure = (key: string, now: number): void => {
        // Every distinct source address that ever fails a login would otherwise
        // stay in this map for the life of the process.
        if (attempts.size > 1_000) {
            for (const [candidate, bucket] of attempts) if (bucket.resetAt <= now) attempts.delete(candidate);
        }
        const bucket = attempts.get(key);
        if (!bucket || bucket.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + windowMinutes * 60_000 });
        else bucket.count += 1;
    };

    return {
        id: 'local',
        logoutPath: '/auth/logout',

        isPublicPath(path) {
            return path === '/login' || path === '/health' || path === '/auth/logout' || path.startsWith('/assets/');
        },

        registerRoutes(app: FastifyInstance) {
            app.get<{ Querystring: { next?: string } }>('/login', async (request, reply) => {
                const state = await readAuthState(statePath);
                return reply.type('text/html')
                    .send(loginPage({ next: safeNext(request.query.next), passwordSet: Boolean(state?.password) }));
            });

            app.post<{ Body: { password?: string; next?: string } }>('/login', async (request, reply) => {
                const now = Date.now();
                const next = safeNext(request.body?.next);
                const state = await readAuthState(statePath);
                const passwordSet = Boolean(state?.password);
                const render = (message: string, code: number) => reply.code(code).type('text/html')
                    .send(loginPage({ message, next, passwordSet }));
                if (throttled(request.ip, now)) {
                    return render(`Too many attempts. Try again in ${windowMinutes} minutes.`, 429);
                }
                if (!state || !await verifyPassword(state.password, request.body?.password ?? '')) {
                    recordFailure(request.ip, now);
                    return render('That password is not correct.', 401);
                }
                attempts.delete(request.ip);
                const maxAge = Math.round(sessionHours * 3600);
                const sid = crypto.randomBytes(16).toString('base64url');
                setSessionCookie(request, reply, signSession(state.sessionSecret, now + maxAge * 1000, sid), maxAge);
                return reply.redirect(next, 303);
            });

            app.get('/auth/logout', async (request, reply) => {
                // Clearing the browser's copy is not sign-out: the cookie is a
                // self-contained HMAC, so the farm has to remember the revocation.
                const now = Date.now();
                const state = await readAuthState(statePath).catch(() => null);
                const payload = state
                    && sessionPayload(state.sessionSecret, readCookie(request.headers.cookie, SESSION_COOKIE), now);
                if (payload) await revokeSession(statePath, payload.sid, payload.exp, now).catch(() => undefined);
                setSessionCookie(request, reply, '', 0);
                return reply.redirect('/login', 303);
            });
        },

        async authenticate(request, reply): Promise<AuthenticatedUser | null> {
            const token = await tokenForAuthorization(statePath, request.headers.authorization);
            if (token) {
                // Every downstream consumer — rate limits, per-token event
                // acknowledgement, the mobile app's Settings screen — needs to
                // know *which* token this is, not just that one matched.
                request.apiToken = { id: token.id, name: token.name };
                // A failed write here must never fail the request: it is a
                // liveness hint, not part of the authentication decision.
                await touchApiToken(statePath, token.id).catch(() => undefined);
                // A named agent changed something — say so in the log, once, per request.
                if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
                    request.log.info({ apiToken: token.name, method: request.method, url: request.url },
                        'authenticated API token request');
                }
                return { id: `token:${token.id}`, roles: ['api', `token:${token.name}`] };
            }
            if (request.headers.authorization) return null;

            const state = await readAuthState(statePath).catch(() => null);
            if (state && sessionValid(state, readCookie(request.headers.cookie, SESSION_COOKIE), Date.now())) {
                request.apiToken = SESSION_IDENTITY;
                return { id: 'local', roles: ['operator'] };
            }
            // A browser navigation deserves the form, not a JSON 401.
            if (request.method === 'GET' && (request.headers.accept ?? '').includes('text/html')) {
                await reply.redirect(`/login?next=${encodeURIComponent(request.url)}`, 303);
            }
            return null;
        },
    };
}

export default createLocalAuthProvider();
