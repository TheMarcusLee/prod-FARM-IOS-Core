import { inject, INJECT_ORIGIN } from './support.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { PluginRegistry } from '../src/registry.js';
import type { McpDependencies } from '../src/mcp/types.js';
import type { RegisteredDevice } from '../src/devices/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

// `src/devices/registry.ts` resolves DEVICES_CONFIG_PATH once at first import,
// so it has to be set before the dynamic import of the app below.
const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'pf-harden-')), 'devices.json');
process.env.DEVICES_CONFIG_PATH = configPath;
process.env.ANDROID_DISCOVERY = 'off';

const { createApp } = await import('../src/api/app.js');
const { createLocalAuthProvider, SESSION_COOKIE } = await import('../src/auth/local.js');
const { setPassword } = await import('../src/auth/state.js');
const { resolveUploadPath } = await import('../src/mcp/uploads.js');
const { originAllowed } = await import('../src/api/routes/mcp.js');
const { shrinkScreenshot, createFarmMcpServer } = await import('../src/mcp/server.js');
const { redactDevice, saveRegisteredDevices, loadRegisteredDevices } = await import('../src/devices/registry.js');

const seed = (devices: unknown[]) => writeFile(configPath, JSON.stringify(devices));
const onDisk = async () => JSON.parse(await readFile(configPath, 'utf8')) as Array<Record<string, unknown>>;

const scheduler = {
    async activeExecution() { return null; },
    async listSchedules() { return []; },
    async listExecutions() { return []; },
    async deleteAssets() { /* nothing to delete in these tests */ },
} as unknown as SchedulerRepository;

const json = { 'content-type': 'application/json' };

async function plainApp(context: { after(fn: () => unknown): void }) {
    const app = await createApp({ plugins: new PluginRegistry([]), scheduler });
    context.after(() => app.close());
    return app;
}

// ---- device id validation (adb -s reaches execFile with this value) --------

test('a udid adb would read as a flag, or that carries shell metacharacters, is refused', async (context) => {
    await seed([]);
    const app = await plainApp(context);

    for (const udid of ['-s', '--help', 'a b', 'a;rm -rf /', 'a/../b', 'a$(id)', '../devices', 'a\nb', '']) {
        const created = await inject(app, {
            method: 'POST', url: '/api/devices', headers: json, payload: { udid, name: 'Phone' },
        });
        assert.equal(created.statusCode, 400, `expected ${JSON.stringify(udid)} to be refused`);
    }
    assert.deepEqual(await onDisk(), []);

    // The shapes a real fleet uses still register: iOS UDIDs and adb serials,
    // including a wireless `host:port` one.
    for (const udid of ['00008030-001A2B3C4D5E802E', 'R58N12ABCDE', '192.168.1.40:5555']) {
        const created = await inject(app, {
            method: 'POST', url: '/api/devices', headers: json, payload: { udid, name: 'Phone' },
        });
        assert.equal(created.statusCode, 201, udid);
    }
});

test('android.serial is validated before it can reach an adb argument vector', async (context) => {
    await seed([]);
    const app = await plainApp(context);

    const refused = await inject(app, {
        method: 'POST', url: '/api/devices', headers: json,
        payload: { udid: 'phone-1', platform: 'android', android: { serial: '-e' } },
    });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.json().error, /android\.serial/);
    assert.deepEqual(await onDisk(), []);

    const accepted = await inject(app, {
        method: 'POST', url: '/api/devices', headers: json,
        payload: { udid: 'phone-1', platform: 'android', android: { serial: 'R58N12ABCDE' } },
    });
    assert.equal(accepted.statusCode, 201);
});

test('ports and the bridge URL are validated rather than stored as given', async (context) => {
    await seed([]);
    const app = await plainApp(context);

    for (const payload of [
        { udid: 'p1', wdaLocalPort: 0 },
        { udid: 'p1', wdaLocalPort: 99_999 },
        { udid: 'p1', mjpegLocalPort: -1 },
        { udid: 'p1', name: 'x'.repeat(201) },
        { udid: 'p1', android: { serial: 'S1', bridgeUrl: 'file:///etc/passwd' } },
        { udid: 'p1', android: { serial: 'S1', bridgeUrl: 'not a url' } },
    ]) {
        const refused = await inject(app, { method: 'POST', url: '/api/devices', headers: json, payload });
        assert.equal(refused.statusCode, 400, JSON.stringify(payload));
    }
    assert.deepEqual(await onDisk(), []);
});

test('android.bridgeOnly is whitelisted, typed, and only stored when true', async (context) => {
    await seed([]);
    const app = await plainApp(context);

    const refused = await inject(app, {
        method: 'POST', url: '/api/devices', headers: json,
        payload: { udid: 'p1', platform: 'android', android: { serial: 'S1', bridgeOnly: 'yes' } },
    });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.json().error, /android\.bridgeOnly/);

    const created = await inject(app, {
        method: 'POST', url: '/api/devices', headers: json,
        payload: {
            udid: 'p1', platform: 'android', driver: 'a11y-bridge',
            android: { serial: 'S1', bridgeUrl: 'http://127.0.0.1:8080', bridgeOnly: true, nonsense: 1 },
        },
    });
    assert.equal(created.statusCode, 201);
    const [stored] = await onDisk();
    assert.deepEqual(stored!.android, { serial: 'S1', bridgeUrl: 'http://127.0.0.1:8080', bridgeOnly: true });
});

test('devices.json is held to the same id shape as the API, so a hand edit cannot reach adb -s', async () => {
    const registryPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'pf-registry-')), 'devices.json');
    const device = (overrides: Record<string, unknown>) => ({ name: 'Phone', udid: 'R58N1', pluginData: {}, ...overrides });

    for (const udid of ['-s', '--help', 'a b', 'a;rm -rf /', 'a/../b', '', '-e']) {
        await assert.rejects(
            saveRegisteredDevices([device({ udid })] as never, registryPath),
            /must be a device id/,
            JSON.stringify(udid),
        );
    }
    for (const serial of ['-e', 'a b', '']) {
        await assert.rejects(
            saveRegisteredDevices([device({ android: { serial } })] as never, registryPath),
            /android\.serial .* must be a device id/,
            JSON.stringify(serial),
        );
    }

    // Nothing was written by any of the refusals, and the shapes a real fleet uses still save.
    await assert.rejects(readFile(registryPath, 'utf8'));
    const good = [
        device({ udid: '00008030-001A2B3C4D5E802E' }),
        device({ udid: '192.168.1.40:5555', android: { serial: '192.168.1.40:5555' } }),
    ];
    await saveRegisteredDevices(good as never, registryPath);
    assert.deepEqual((await loadRegisteredDevices(registryPath)).map(({ udid }) => udid),
        ['00008030-001A2B3C4D5E802E', '192.168.1.40:5555']);
});

// ---- secret redaction ------------------------------------------------------

test('neither the passcode nor the bridge token leaves in a device response', async (context) => {
    await seed([{
        name: 'Phone', udid: 'phone-1', platform: 'android', pluginData: {}, passcode: '123456',
        android: { serial: 'R58N12ABCDE', bridgeUrl: 'http://127.0.0.1:8080', bridgeToken: 'super-secret-bridge' },
    }]);
    const app = await plainApp(context);

    const list = await inject(app, { method: 'GET', url: '/api/devices' });
    assert.equal(list.statusCode, 200);
    assert.doesNotMatch(list.body, /super-secret-bridge/);
    assert.doesNotMatch(list.body, /123456/);
    assert.equal(list.json()[0].hasPasscode, true);
    assert.equal(list.json()[0].android.hasBridgeToken, true);
    assert.equal(list.json()[0].android.bridgeToken, undefined);

    const patched = await inject(app, {
        method: 'PATCH', url: '/api/devices/phone-1', headers: json, payload: { name: 'Renamed' },
    });
    assert.equal(patched.statusCode, 200);
    assert.doesNotMatch(patched.body, /super-secret-bridge/);
    assert.equal(patched.json().android.bridgeToken, undefined);

    // Still on disk — redaction is about the wire, not about forgetting the value.
    assert.equal(((await onDisk())[0]!.android as { bridgeToken: string }).bridgeToken, 'super-secret-bridge');
});

test('no surface that serialises a device carries the bridge token', async (context) => {
    const device = {
        name: 'Phone', udid: 'phone-1', platform: 'android', driver: 'a11y-bridge', pluginData: {}, passcode: '123456',
        android: { serial: 'R58N12ABCDE', bridgeUrl: 'http://127.0.0.1:8080', bridgeToken: 'super-secret-bridge' },
    };
    await seed([device]);
    const app = await plainApp(context);

    // Everything that turns a RegisteredDevice into a response: the device API, the mobile
    // bootstrap, the fleet page and the MCP tools.
    for (const url of ['/api/devices', '/api/devices/discovered', '/api/mobile/bootstrap', '/fleet']) {
        const response = await inject(app, { method: 'GET', url });
        assert.equal(response.statusCode, 200, url);
        assert.doesNotMatch(response.body, /super-secret-bridge/, url);
        assert.doesNotMatch(response.body, /123456/, url);
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFarmMcpServer({
        async loadDevices() { return [device]; },
        async discoverDevices() { return []; },
        scheduler, listPlugins: () => [], async listAssets() { return []; },
        async screenshot() { return Buffer.alloc(0); },
    } as unknown as McpDependencies);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
        for (const call of [
            { name: 'list_devices', arguments: {} },
            { name: 'get_device', arguments: { udid: 'phone-1' } },
        ]) {
            const result = await client.callTool(call) as { content: Array<{ text?: string }> };
            const text = result.content.map((part) => part.text ?? '').join('');
            assert.match(text, /phone-1/, call.name);
            assert.doesNotMatch(text, /super-secret-bridge/, call.name);
            assert.doesNotMatch(text, /123456/, call.name);
        }
        const status = await client.readResource({ uri: 'farm://status' }) as { contents: Array<{ text?: string }> };
        assert.doesNotMatch(status.contents.map((part) => part.text ?? '').join(''), /super-secret-bridge/);
    } finally {
        await client.close();
        await server.close();
    }
});

test('redaction lives in the registry, so it cannot be skipped by a new call site', () => {
    const stored: RegisteredDevice = {
        name: 'Phone', udid: 'phone-1', pluginData: {}, passcode: '1234',
        android: { serial: 'S1', bridgeUrl: 'http://x', bridgeToken: 'secret', bridgeOnly: true },
    };
    const redacted = redactDevice(stored);
    assert.deepEqual(redacted, {
        name: 'Phone', udid: 'phone-1', pluginData: {}, hasPasscode: true,
        android: { serial: 'S1', bridgeUrl: 'http://x', bridgeOnly: true, hasBridgeToken: true },
    });
    // No android block, and no secrets: the markers are still there and say so.
    const plain: RegisteredDevice = { name: 'iPhone', udid: 'u', pluginData: {} };
    assert.deepEqual(redactDevice(plain), { name: 'iPhone', udid: 'u', pluginData: {}, hasPasscode: false });
    const noToken: RegisteredDevice = { name: 'p', udid: 'u', pluginData: {}, android: { serial: 'S1' } };
    assert.deepEqual(redactDevice(noToken).android, { serial: 'S1', hasBridgeToken: false });
});

// ---- remote actions --------------------------------------------------------

test('a remote action is validated against the verb union before it reaches a device', async (context) => {
    await seed([{ name: 'Phone', udid: 'phone-1', pluginData: {} }]);
    const app = await plainApp(context);

    for (const payload of [
        {},
        { type: 'exec' },
        { type: 'tap', x: 'NaN', y: 10 },
        { type: 'tap', x: 10 },
        { type: 'swipe', startX: 1, startY: 1, endX: 2, endY: 2 },
        { type: 'text', text: 'x'.repeat(5_000) },
        { type: 'text' },
    ]) {
        const refused = await inject(app, {
            method: 'POST', url: '/api/devices/phone-1/remote/action', headers: json, payload,
        });
        assert.equal(refused.statusCode, 400, JSON.stringify(payload));
    }
});

// ---- CSRF ------------------------------------------------------------------

test('a cookie session cannot buy the bearer CSRF exemption', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-harden-auth-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const statePath = path.join(directory, '.auth.json');
    await setPassword(statePath, 'correct-horse-battery');
    await seed([{ name: 'Phone', udid: 'phone-1', pluginData: {} }]);

    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler, authProvider: createLocalAuthProvider({ statePath }),
    });
    context.after(() => app.close());

    const signedIn = await inject(app, {
        method: 'POST', url: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'password=correct-horse-battery',
    });
    const setCookie = signedIn.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie : [String(setCookie)])
        .find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]!;

    // Same request a cross-site page would make if it could attach a header:
    // a browser cookie, no Origin, and a bearer prefix to slip past the guard.
    const forged = await app.inject({
        method: 'PATCH', url: '/api/devices/phone-1', payload: { name: 'Owned' },
        headers: { ...json, cookie, authorization: 'Bearer anything' },
    });
    assert.equal(forged.statusCode, 403);
    assert.match(forged.json().error, /Cross-origin write blocked/);

    // The same cookie with a matching Origin is a legitimate dashboard write.
    const allowed = await app.inject({
        method: 'PATCH', url: '/api/devices/phone-1', payload: { name: 'Renamed' },
        headers: { ...json, cookie, origin: INJECT_ORIGIN },
    });
    assert.equal(allowed.statusCode, 200);
});

test('signing out revokes the session cookie, not just the browser copy', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-harden-logout-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const statePath = path.join(directory, '.auth.json');
    await setPassword(statePath, 'correct-horse-battery');
    await seed([]);

    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler, authProvider: createLocalAuthProvider({ statePath }),
    });
    context.after(() => app.close());

    const signedIn = await inject(app, {
        method: 'POST', url: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'password=correct-horse-battery',
    });
    const setCookie = signedIn.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie : [String(setCookie)])
        .find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]!;
    assert.equal((await app.inject({ method: 'GET', url: '/api/devices', headers: { cookie } })).statusCode, 200);

    await app.inject({ method: 'GET', url: '/auth/logout', headers: { cookie } });

    // The captured copy of the cookie is what an attacker would hold; it must
    // stop working the moment the operator signs out.
    const after = await app.inject({ method: 'GET', url: '/api/devices', headers: { cookie } });
    assert.equal(after.statusCode, 401);
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { revokedSessions?: unknown[] };
    assert.equal(state.revokedSessions?.length, 1);
});

// ---- error handling --------------------------------------------------------

test('a fault answers 500 without its internal message; a deliberate 4xx keeps both', async (context) => {
    const app = await createApp({
        plugins: new PluginRegistry([{
            id: 'com.example.boom', version: '1.0.0', displayName: 'Boom', tasks: [],
            registerRoutes({ app: instance }) {
                instance.get('/boom', async () => {
                    throw Object.assign(new Error('ENOENT: no such file or directory, open \'/Users/op/.auth.json\''),
                        { code: 'ENOENT' });
                });
                instance.get('/refused', async () => {
                    throw Object.assign(new Error('That schedule is already cancelled'), { statusCode: 409 });
                });
            },
        }]),
        scheduler,
    });
    context.after(() => app.close());

    const fault = await inject(app, { method: 'GET', url: '/boom' });
    assert.equal(fault.statusCode, 500);
    assert.equal(fault.json().error, 'Internal server error');
    assert.doesNotMatch(fault.body, /auth\.json|ENOENT/);

    const refused = await inject(app, { method: 'GET', url: '/refused' });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, 'That schedule is already cancelled');
});

test('DELETE /api/assets refuses an assetIds that is not an array of ids', async (context) => {
    await seed([]);
    const app = await plainApp(context);
    const refused = await inject(app, {
        method: 'DELETE', url: '/api/assets', headers: json, payload: { assetIds: 'everything' },
    });
    assert.equal(refused.statusCode, 400);
});

// ---- MCP -------------------------------------------------------------------

test('upload_asset cannot read outside the allowed directories, symlink or not', async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pf-harden-upload-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const allowed = path.join(root, 'inbox');
    await mkdir(allowed, { recursive: true });
    await writeFile(path.join(allowed, 'clip.mp4'), 'video');
    await writeFile(path.join(root, 'devices.json'), '[{"passcode":"123456"}]');

    // The resolver returns the real path, and on macOS /var is a symlink to /private/var.
    assert.equal(
        await resolveUploadPath(path.join(allowed, 'clip.mp4'), [allowed]),
        path.join(await realpath(allowed), 'clip.mp4'),
    );

    await assert.rejects(
        resolveUploadPath(path.join(allowed, '..', 'devices.json'), [allowed]),
        /outside the allowed upload directories/,
    );
    await assert.rejects(resolveUploadPath('/etc/passwd', [allowed]), /outside the allowed upload directories/);

    // A symlink planted inside the allowed directory is resolved before the
    // containment check, so it cannot be used to step out of it.
    await symlink(path.join(root, 'devices.json'), path.join(allowed, 'escape.json'));
    await assert.rejects(
        resolveUploadPath(path.join(allowed, 'escape.json'), [allowed]),
        /outside the allowed upload directories/,
    );
});

test('/mcp refuses a request carrying an untrusted Origin', async () => {
    const empty = {} as NodeJS.ProcessEnv;
    // An agent sends no Origin at all; a browser always sends one.
    assert.equal(originAllowed(undefined, empty), true);
    assert.equal(originAllowed('https://evil.example', empty), false);
    assert.equal(
        originAllowed('https://farm.example', { PHONE_FARM_TRUSTED_ORIGINS: 'https://farm.example/' } as NodeJS.ProcessEnv),
        true,
    );
    assert.equal(originAllowed('https://evil.example', { PUBLIC_ORIGIN: 'https://farm.example' } as NodeJS.ProcessEnv), false);
});

test('the MCP screenshot tool shrinks the image instead of sending the whole screen', async () => {
    const { default: sharp } = await import('sharp');
    const full = await sharp({
        create: { width: 1290, height: 2796, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer();

    const shrunk = await shrinkScreenshot(full);
    assert.equal((await sharp(shrunk).metadata()).width, 800);
    assert.ok(shrunk.length < full.length);

    // A frame that is already small is not upscaled.
    const small = await sharp({ create: { width: 200, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .png().toBuffer();
    assert.equal((await sharp(await shrinkScreenshot(small)).metadata()).width, 200);
});

// ---- password hashing ------------------------------------------------------

test('passwords are hashed with the current scrypt cost, and old parameters still verify', async () => {
    const { hashPassword, verifyPassword } = await import('../src/auth/state.js');

    const hashed = await hashPassword('correct-horse-battery');
    const [scheme, n, r, p] = hashed.split('$');
    assert.equal(scheme, 'scrypt');
    assert.ok(Number(n) >= 131_072, `N should be at least 2^17, got ${n}`);
    assert.equal(r, '8');
    assert.equal(p, '1');
    assert.equal(await verifyPassword(hashed, 'correct-horse-battery'), true);
    assert.equal(await verifyPassword(hashed, 'correct-horse-batterz'), false);

    // A password hashed before the cost went up keeps working: the parameters
    // travel with the hash, so no operator is locked out by the change.
    const legacy = 'scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$'
        + (await import('node:crypto')).default.scryptSync('legacy-password',
            Buffer.from('c2FsdHNhbHRzYWx0c2FsdA==', 'base64'), 32, { N: 16384, r: 8, p: 1 }).toString('base64');
    assert.equal(await verifyPassword(legacy, 'legacy-password'), true);
    assert.equal(await verifyPassword(legacy, 'nope'), false);
});
