import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import { inject, INJECT_ORIGIN } from './support.js';
import { createApp } from '../src/api/app.js';
import { createLocalAuthProvider, isTokenActive, SESSION_COOKIE } from '../src/auth/local.js';
import { createApiToken, defaultAuthStatePath, revokeApiToken, setPassword } from '../src/auth/state.js';
import { loadAuthProvider } from '../src/loader.js';
import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

const PASSWORD = 'correct-horse-battery';

/**
 * A throwaway state file, exported as AUTH_STATE_PATH too: in production the
 * provider and the /mcp route both resolve the same default, and the /mcp route
 * has no way to be told about a private one.
 */
async function statePath(context: { after(fn: () => unknown): void }): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'farm-auth-'));
    const previous = process.env.AUTH_STATE_PATH;
    const state = path.join(directory, '.auth.json');
    process.env.AUTH_STATE_PATH = state;
    context.after(async () => {
        if (previous === undefined) delete process.env.AUTH_STATE_PATH; else process.env.AUTH_STATE_PATH = previous;
        await rm(directory, { recursive: true, force: true });
    });
    return state;
}

async function appWith(state: string, context: { after(fn: () => unknown): void }): Promise<FastifyInstance> {
    const app = await createApp({
        plugins: new PluginRegistry([]),
        scheduler: {} as SchedulerRepository,
        authProvider: createLocalAuthProvider({ statePath: state }),
    });
    context.after(() => app.close());
    return app;
}

function sessionCookie(setCookie: string | string[] | undefined): string {
    const values = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
    const found = values.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(found, 'expected a session cookie');
    return found.split(';')[0] ?? '';
}

test('PHONE_FARM_AUTH_PLUGIN=local resolves to the built-in provider', async () => {
    const provider = await loadAuthProvider('local');
    assert.equal(provider?.id, 'local');
    assert.equal(provider?.logoutPath, '/auth/logout');
    assert.ok(provider?.isPublicPath('/login'));
    assert.ok(provider?.isPublicPath('/health'));
    assert.ok(provider?.isPublicPath('/assets/backline.css'));
    assert.equal(provider?.isPublicPath('/api/devices'), false);
});

test('the state file lives beside devices.json and is written 0600', async (context) => {
    const state = await statePath(context);
    await setPassword(state, PASSWORD);
    assert.equal((await stat(state)).mode & 0o777, 0o600);
    assert.equal(
        defaultAuthStatePath({ DEVICES_CONFIG_PATH: '/srv/farm/devices.json' } as NodeJS.ProcessEnv),
        '/srv/farm/.auth.json',
    );
});

test('the login form is public and a correct password opens a session', async (context) => {
    const state = await statePath(context);
    await setPassword(state, PASSWORD);
    const app = await appWith(state, context);

    const form = await inject(app, { method: 'GET', url: '/login' });
    assert.equal(form.statusCode, 200);
    assert.match(form.body, /name="password"/);

    const denied = await inject(app, { method: 'GET', url: '/api/plugins' });
    assert.equal(denied.statusCode, 401);

    const browser = await inject(app, { method: 'GET', url: '/', headers: { accept: 'text/html' } });
    assert.equal(browser.statusCode, 303);
    assert.match(String(browser.headers.location), /^\/login\?next=/);

    const login = await inject(app, { method: 'POST', url: '/login', payload: { password: PASSWORD, next: '/tasks' } });
    assert.equal(login.statusCode, 303);
    assert.equal(login.headers.location, '/tasks');
    const cookie = sessionCookie(login.headers['set-cookie']);
    assert.match(String(login.headers['set-cookie']), /HttpOnly/);
    assert.match(String(login.headers['set-cookie']), /SameSite=Lax/);

    const allowed = await inject(app, { method: 'GET', url: '/api/plugins', headers: { cookie } });
    assert.equal(allowed.statusCode, 200);

    const loggedOut = await inject(app, { method: 'GET', url: '/auth/logout' });
    assert.equal(loggedOut.statusCode, 303);
    assert.match(String(loggedOut.headers['set-cookie']), /Max-Age=0/);
});

test('a forged session cookie is rejected', async (context) => {
    const state = await statePath(context);
    await setPassword(state, PASSWORD);
    const app = await appWith(state, context);
    const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 60_000 })).toString('base64url');
    const response = await inject(app, {
        method: 'GET', url: '/api/plugins', headers: { cookie: `${SESSION_COOKIE}=${forged}.notasignature` },
    });
    assert.equal(response.statusCode, 401);
});

test('a wrong password is rejected and repeated attempts are rate limited', async (context) => {
    const state = await statePath(context);
    await setPassword(state, PASSWORD);
    const app = await createApp({
        plugins: new PluginRegistry([]),
        scheduler: {} as SchedulerRepository,
        authProvider: createLocalAuthProvider({ statePath: state, maxLoginAttempts: 3, loginWindowMinutes: 15 }),
    });
    context.after(() => app.close());

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const wrong = await inject(app, { method: 'POST', url: '/login', payload: { password: 'nope' } });
        assert.equal(wrong.statusCode, 401, `attempt ${attempt}`);
        assert.equal(wrong.headers['set-cookie'], undefined);
    }

    const limited = await inject(app, { method: 'POST', url: '/login', payload: { password: 'nope' } });
    assert.equal(limited.statusCode, 429);

    // The limit is on attempts, not on knowing the password.
    const correct = await inject(app, { method: 'POST', url: '/login', payload: { password: PASSWORD } });
    assert.equal(correct.statusCode, 429);
});

test('a bearer token authenticates the API, survives no Origin, and dies when revoked', async (context) => {
    const state = await statePath(context);
    await setPassword(state, PASSWORD);
    const { token } = await createApiToken(state, 'agent-1');
    const app = await appWith(state, context);

    const authorization = `Bearer ${token}`;
    const read = await app.inject({ method: 'GET', url: '/api/plugins', headers: { authorization } });
    assert.equal(read.statusCode, 200);

    const wrong = await app.inject({ method: 'GET', url: '/api/plugins', headers: { authorization: 'Bearer pf_nope' } });
    assert.equal(wrong.statusCode, 401);

    // A bearer write with no Origin at all is exempt from the CSRF guard…
    const write = await app.inject({
        method: 'POST', url: '/api/device-registrations', headers: { authorization }, payload: { udid: 'x' },
    });
    assert.notEqual(write.statusCode, 403);

    // …but a cookie session is not.
    const login = await inject(app, { method: 'POST', url: '/login', payload: { password: PASSWORD } });
    const cookie = sessionCookie(login.headers['set-cookie']);
    const forged = await app.inject({
        method: 'POST', url: '/api/device-registrations', headers: { cookie }, payload: { udid: 'x' },
    });
    assert.equal(forged.statusCode, 403);
    const sameOrigin = await app.inject({
        method: 'POST', url: '/api/device-registrations',
        headers: { cookie, origin: INJECT_ORIGIN }, payload: { udid: 'x' },
    });
    assert.notEqual(sameOrigin.statusCode, 403);

    await revokeApiToken(state, 'agent-1');
    const revoked = await app.inject({ method: 'GET', url: '/api/plugins', headers: { authorization } });
    assert.equal(revoked.statusCode, 401);
});

test('a bearer token reaches /mcp and a revoked one does not', async (context) => {
    const state = await statePath(context);
    const { token } = await createApiToken(state, 'agent-2');
    const app = await appWith(state, context);

    const initialize = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

    // No Origin and no token is a browser-shaped write: the CSRF guard turns it away first.
    const browserShaped = await app.inject({ method: 'POST', url: '/mcp', headers, payload: initialize });
    assert.equal(browserShaped.statusCode, 403);

    const anonymous = await inject(app, { method: 'POST', url: '/mcp', headers, payload: initialize });
    assert.equal(anonymous.statusCode, 401);

    const accepted = await app.inject({
        method: 'POST', url: '/mcp', headers: { ...headers, authorization: `Bearer ${token}` }, payload: initialize,
    });
    assert.equal(accepted.statusCode, 200);
    assert.match(accepted.body, /"serverInfo"/);

    await revokeApiToken(state, 'agent-2');
    const revoked = await app.inject({
        method: 'POST', url: '/mcp', headers: { ...headers, authorization: `Bearer ${token}` }, payload: initialize,
    });
    assert.equal(revoked.statusCode, 401);
});

test('isTokenActive answers from the state file, so a long-lived connection can re-check', async (context) => {
    const state = await statePath(context);
    await setPassword(state, PASSWORD);
    const { record } = await createApiToken(state, 'agent-9');
    const id = record.id;

    assert.equal(await isTokenActive(id, state), true);
    assert.equal(await isTokenActive('never-existed', state), false);
    // A cookie session is not a token; its revocation is checked where the cookie is read.
    assert.equal(await isTokenActive('session', state), true);

    await revokeApiToken(state, 'agent-9');
    assert.equal(await isTokenActive(id, state), false);

    // A missing or unreadable state file is "not active", never a throw into a stream handler.
    assert.equal(await isTokenActive(id, path.join(path.dirname(state), 'gone.json')), false);
});
