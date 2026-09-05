import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
    password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions,
) => Promise<Buffer>;

/** Deliberately conservative; a farm operator logs in rarely and the Mac is not a login server. */
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;

export interface ApiToken {
    id: string;
    name: string;
    /** sha256 of the token text, hex. The token itself is never stored. */
    sha256: string;
    createdAt: string;
}

export interface AuthState {
    /** "scrypt$N$r$p$saltBase64$hashBase64". Absent until `npm run auth:set-password`. */
    password?: string;
    /** HMAC key for session cookies, hex. Created on first write. */
    sessionSecret: string;
    tokens: ApiToken[];
}

/** `.auth.json` next to devices.json unless AUTH_STATE_PATH says otherwise. */
export function defaultAuthStatePath(environment: NodeJS.ProcessEnv = process.env): string {
    if (environment.AUTH_STATE_PATH) return path.resolve(environment.AUTH_STATE_PATH);
    const devices = path.resolve(environment.DEVICES_CONFIG_PATH ?? 'devices.json');
    return path.join(path.dirname(devices), '.auth.json');
}

function emptyState(): AuthState {
    return { sessionSecret: crypto.randomBytes(32).toString('hex'), tokens: [] };
}

export async function readAuthState(statePath: string): Promise<AuthState | null> {
    let raw: string;
    try {
        raw = await readFile(statePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    if (typeof parsed.sessionSecret !== 'string') throw new Error(`${statePath} is missing sessionSecret`);
    return { ...parsed, sessionSecret: parsed.sessionSecret, tokens: parsed.tokens ?? [] };
}

/** Always 0600 — it holds the session signing key and every token digest. */
export async function writeAuthState(statePath: string, state: AuthState): Promise<void> {
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, statePath);
}

/** Load → mutate → save under one in-process lock so two CLI writes can't clobber each other. */
let stateMutation: Promise<unknown> = Promise.resolve();

export function mutateAuthState<T>(statePath: string, mutate: (state: AuthState) => T | Promise<T>): Promise<T> {
    const run = stateMutation.then(async () => {
        const state = await readAuthState(statePath) ?? emptyState();
        const result = await mutate(state);
        await writeAuthState(statePath, state);
        return result;
    });
    stateMutation = run.catch(() => undefined);
    return run;
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    const derived = await scrypt(password, salt, KEY_LENGTH, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(stored: string | undefined, password: string): Promise<boolean> {
    if (!stored) return false;
    const [scheme, n, r, p, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const derived = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
        N: Number(n), r: Number(r), p: Number(p),
    });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

export function tokenDigest(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/** The only moment the token text exists; the caller prints it and forgets it. */
export function generateToken(): string {
    return `pf_${crypto.randomBytes(32).toString('base64url')}`;
}

export async function setPassword(statePath: string, password: string): Promise<void> {
    const hashed = await hashPassword(password);
    await mutateAuthState(statePath, (state) => { state.password = hashed; });
}

export async function createApiToken(statePath: string, name: string): Promise<{ token: string; record: ApiToken }> {
    const token = generateToken();
    const record: ApiToken = {
        id: crypto.randomUUID(), name, sha256: tokenDigest(token), createdAt: new Date().toISOString(),
    };
    await mutateAuthState(statePath, (state) => {
        if (state.tokens.some((existing) => existing.name === name)) {
            throw new Error(`A token named ${name} already exists — revoke it first`);
        }
        state.tokens.push(record);
    });
    return { token, record };
}

/** Accepts a token name or its id. Returns the tokens that were removed. */
export async function revokeApiToken(statePath: string, nameOrId: string): Promise<ApiToken[]> {
    return mutateAuthState(statePath, (state) => {
        const removed = state.tokens.filter((token) => token.name === nameOrId || token.id === nameOrId);
        state.tokens = state.tokens.filter((token) => !removed.includes(token));
        return removed;
    });
}

export async function listApiTokens(statePath: string): Promise<ApiToken[]> {
    return (await readAuthState(statePath))?.tokens ?? [];
}

/** The token named by an `Authorization: Bearer …` header, or null. Never throws on a missing state file. */
export async function tokenForAuthorization(
    statePath: string, authorization: string | undefined,
): Promise<ApiToken | null> {
    const value = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!value) return null;
    const state = await readAuthState(statePath).catch(() => null);
    if (!state?.tokens.length) return null;
    const digest = Buffer.from(tokenDigest(value), 'hex');
    // Compare every candidate so the reply time doesn't leak which prefix matched.
    let matched: ApiToken | null = null;
    for (const token of state.tokens) {
        const candidate = Buffer.from(token.sha256, 'hex');
        if (candidate.length === digest.length && crypto.timingSafeEqual(candidate, digest)) matched = token;
    }
    return matched;
}
