import { inject } from './support.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CommandResult, CommandRunner } from '../src/drivers/common.js';
import type { DeviceDriver, Key, Point, ScreenGeometry, Swipe } from '../src/drivers/types.js';
import type { Device } from '../src/devices/discovery.js';
import type { RegisteredDevice } from '../src/devices/registry.js';
import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

// Never let a test touch real hardware: adb is faked below, and Android discovery
// (which the app calls directly) is switched off.
process.env.ANDROID_DISCOVERY = 'off';

// devices.json resolves once, when the registry module is first loaded, so the whole
// file shares one temporary path and every module below is imported after it is set.
const workspace = await mkdtemp(path.join(os.tmpdir(), 'pf-android-'));
const configPath = path.join(workspace, 'devices.json');
process.env.DEVICES_CONFIG_PATH = configPath;

const { createApp } = await import('../src/api/app.js');
const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
const { DeviceRegistrationService, checkNamesForPlatform } = await import('../src/devices/registration.js');
const androidParsers = await import('../src/devices/registration-android.js');

const SERIAL = 'R58N12ABCDE';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const TIKTOK = 'com.zhiliaoapp.musically';

const androidCandidate: Device = {
    name: 'Pixel 7', osVersion: '14', udid: SERIAL, platform: 'android', modelName: 'Pixel 7',
};

interface DriverCalls { taps: Point[]; swipes: Swipe[]; keys: Key[]; typed: string[] }

function fakeDriver(calls: DriverCalls): DeviceDriver {
    const screen: ScreenGeometry = { width: 1080, height: 2400, scale: 1 };
    return {
        kind: 'adb', platform: 'android', udid: SERIAL,
        async launchApp() {}, async terminateApp() {},
        async tap(point) { calls.taps.push(point); },
        async swipe(swipe) { calls.swipes.push(swipe); },
        async type(text) { calls.typed.push(text); },
        async pressKey(key) { calls.keys.push(key); },
        async screenshot() { return PNG; },
        async uiTree() { throw new Error('not used'); },
        async screen() { return screen; },
        async pushMedia() {},
        async pause() {},
    };
}

/** An adb that answers from a table instead of spawning anything. */
function fakeAdb(overrides: Record<string, string> = {}): CommandRunner {
    return async (file, args): Promise<CommandResult> => {
        assert.equal(file, 'adb');
        const key = args.join(' ');
        const table: Record<string, string> = {
            'version': 'Android Debug Bridge version 1.0.41',
            'devices -l': `List of devices attached\n${SERIAL}         device product:panther model:Pixel_7`,
            [`-s ${SERIAL} shell pm list packages ${TIKTOK}`]: `package:${TIKTOK}`,
            ...overrides,
        };
        const stdout = table[key];
        if (stdout === undefined) throw new Error(`unexpected adb call: ${key}`);
        return { stdout, stderr: '' };
    };
}

async function settle(get: () => Promise<{ busy: boolean } | undefined>): Promise<void> {
    // Generous: under a full parallel test run a wizard action can take well over a second.
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
        const snapshot = await get();
        if (snapshot && !snapshot.busy) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('registration action never finished');
}

test('an Android candidate gets the Android check set, verifies through its driver, and finalizes into devices.json', async () => {
    await writeFile(configPath, '[]');
    const directory = path.join(workspace, 'first');
    const calls: DriverCalls = { taps: [], swipes: [], keys: [], typed: [] };
    const service = new DeviceRegistrationService({
        stateDirectory: path.join(directory, 'registrations'),
        discoverDevices: async () => [androidCandidate],
        loadDevices: async () => [],
        runCommand: fakeAdb(),
        createDriver: () => fakeDriver(calls),
        // Nothing should reach the network on the Android path.
        fetchImpl: async () => { throw new Error('fetch must not be used for the adb driver'); },
    });

    const created = await service.create(SERIAL);
    assert.equal(created.platform, 'android');
    assert.equal(created.driver, 'adb');
    assert.deepEqual(created.checkNames, checkNamesForPlatform('android'));
    // The iOS-only checks are absent, not merely pending.
    for (const name of ['wda', 'signing', 'appium'] as const) assert.equal(created.checks[name], undefined);
    assert.equal(created.wdaLocalPort, 0);

    await service.run(SERIAL, 'refresh');
    await settle(() => service.get(SERIAL));
    const refreshed = (await service.get(SERIAL))!;
    for (const name of ['host', 'connection', 'developer', 'driver', 'tiktok'] as const) {
        assert.equal(refreshed.checks[name]?.state, 'passed', `${name}: ${refreshed.checks[name]?.message}`);
    }

    await service.run(SERIAL, 'verify');
    await settle(() => service.get(SERIAL));
    const verified = (await service.get(SERIAL))!;
    assert.equal(verified.checks.video?.state, 'passed');
    assert.equal(verified.checks.touch?.state, 'passed');
    assert.deepEqual(calls.keys, ['home']);
    assert.equal(verified.canFinalize, true);

    const finalized = await service.run(SERIAL, 'finalize');
    assert.equal(finalized.finalized, true);
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as RegisteredDevice[];
    assert.deepEqual(saved, [{
        name: 'Pixel 7', udid: SERIAL, platform: 'android', driver: 'adb',
        android: { serial: SERIAL },
        pluginData: { 'com.git-agni.tiktok': { accounts: [] } },
    }]);
    // No WebDriverAgent port was ever claimed or written.
    assert.equal(saved[0]!.wdaLocalPort, undefined);
});

test('unauthorized adb blocks the wizard with the "allow USB debugging" hint, and the bridge driver reports what is missing', async () => {
    const directory = path.join(workspace, 'blocked');
    const unauthorized = new DeviceRegistrationService({
        stateDirectory: path.join(directory, 'registrations'),
        discoverDevices: async () => [androidCandidate],
        loadDevices: async () => [],
        runCommand: fakeAdb({ 'devices -l': `List of devices attached\n${SERIAL}\tunauthorized` }),
    });
    await unauthorized.create(SERIAL);
    await unauthorized.run(SERIAL, 'refresh');
    await settle(() => unauthorized.get(SERIAL));
    const blocked = (await unauthorized.get(SERIAL))!;
    assert.equal(blocked.checks.connection?.state, 'blocked');
    assert.equal(blocked.checks.developer?.state, 'blocked');
    assert.match(blocked.checks.developer!.message, /Allow USB debugging/i);
    assert.equal(blocked.canFinalize, false);

    const bridge = new DeviceRegistrationService({
        stateDirectory: path.join(directory, 'bridge-registrations'),
        discoverDevices: async () => [androidCandidate],
        loadDevices: async () => [],
        runCommand: fakeAdb({
            '-s R58N12ABCDE shell pm list packages com.linecorp.simuse.devicebridge': '',
        }),
    });
    await bridge.create(SERIAL);
    const picked = await bridge.update(SERIAL, { driver: 'a11y-bridge' });
    assert.equal(picked.driver, 'a11y-bridge');
    await bridge.run(SERIAL, 'refresh');
    await settle(() => bridge.get(SERIAL));
    const missing = (await bridge.get(SERIAL))!;
    assert.equal(missing.checks.driver?.state, 'blocked');
    assert.match(missing.checks.driver!.message, /com\.linecorp\.simuse\.devicebridge is not installed/);
});

test('remote screenshot and input for an Android device go through its driver, and the grid shows platform badges', async (context) => {
    await writeFile(configPath, JSON.stringify([
        { name: 'Pixel 7', udid: SERIAL, platform: 'android', driver: 'adb', android: { serial: SERIAL }, pluginData: {} },
        { name: 'Test iPhone', udid: 'ios-udid', pluginData: {} },
    ]));
    const calls: DriverCalls = { taps: [], swipes: [], keys: [], typed: [] };
    const app = await createApp({
        plugins: new PluginRegistry([]),
        scheduler: { async activeExecution() { return null; } } as unknown as SchedulerRepository,
        dashboardTheme: defaultDashboardTheme,
        createDriver: (device) => { assert.equal(device.udid, SERIAL); return fakeDriver(calls); },
    });
    context.after(() => app.close());

    const shot = await inject(app, { method: 'GET', url: `/api/devices/${SERIAL}/remote/screenshot` });
    assert.equal(shot.statusCode, 200);
    assert.equal(shot.headers['content-type'], 'image/png');
    assert.ok(shot.rawPayload.equals(PNG));

    const tapped = await inject(app, {
        method: 'POST', url: `/api/devices/${SERIAL}/remote/action`, payload: { type: 'tap', x: 100, y: 220 },
    });
    assert.equal(tapped.statusCode, 200);
    assert.deepEqual(calls.taps, [{ x: 100, y: 220 }]);

    const typed = await inject(app, {
        method: 'POST', url: `/api/devices/${SERIAL}/remote/action`, payload: { type: 'text', text: 'hello' },
    });
    assert.equal(typed.statusCode, 200);
    assert.deepEqual(calls.typed, ['hello']);

    const home = await inject(app, { method: 'POST', url: `/api/devices/${SERIAL}/remote/action`, payload: { type: 'home' } });
    assert.equal(home.statusCode, 200);
    assert.deepEqual(calls.keys, ['home']);

    // WDA-only verbs have no adb equivalent and must not silently do nothing.
    const locked = await inject(app, { method: 'POST', url: `/api/devices/${SERIAL}/remote/action`, payload: { type: 'lock' } });
    assert.equal(locked.statusCode, 400);
    assert.match(locked.json().error, /iOS-only/);

    // The Android device's connection never probes WebDriverAgent.
    const connection = await inject(app, { method: 'GET', url: `/api/devices/${SERIAL}/connection` });
    assert.equal(connection.statusCode, 200);
    assert.equal(connection.json().appium, 'unavailable');

    // The registry names each phone's platform and driver, so a mixed fleet reads at a glance.
    const registry = await inject(app, { method: 'GET', url: '/devices' });
    assert.equal(registry.statusCode, 200);
    assert.match(registry.body, /<td>Android<\/td><td class="bl-muted">adb<\/td>/);
    assert.match(registry.body, /<td>iOS<\/td><td class="bl-muted">wda<\/td>/);
});

test('the adb output parsers read states, packages, services and tokens', async () => {
    const {
        BRIDGE_PACKAGE, parseAdbDeviceState, parseAccessibilityEnabled, parseBridgeToken, parsePackageInstalled,
    } = androidParsers;

    const listing = `List of devices attached\n${SERIAL}\tdevice product:panther\nother\tunauthorized`;
    assert.equal(parseAdbDeviceState(listing, SERIAL), 'device');
    assert.equal(parseAdbDeviceState(listing, 'other'), 'unauthorized');
    assert.equal(parseAdbDeviceState(listing, 'absent'), 'missing');

    assert.equal(parsePackageInstalled(`package:${TIKTOK}\n`, TIKTOK), true);
    assert.equal(parsePackageInstalled('', TIKTOK), false);

    assert.equal(parseAccessibilityEnabled(`com.other/.Svc:${BRIDGE_PACKAGE}/.BridgeService\n`, BRIDGE_PACKAGE), true);
    assert.equal(parseAccessibilityEnabled('null\n', BRIDGE_PACKAGE), false);

    assert.equal(parseBridgeToken('Row: 0 auth_token=abc123\n'), 'abc123');
    assert.equal(parseBridgeToken('Row: 0 result={"status":"success","result":"1f0a-uuid"}\n'), '1f0a-uuid');
    assert.equal(parseBridgeToken('Row: 0 result={"status":"error","error":"denied"}\n'), undefined);
    assert.equal(parseBridgeToken('No result found.\n'), undefined);
});

test('the adb parsers survive the daemon banner, multi-column rows and odd states', async () => {
    const { parseAdbDeviceState, parseBridgeToken, localBridgePort } = androidParsers;

    const banner = '* daemon not running; starting now at tcp:5037 *\n* daemon started successfully *\n'
        + `List of devices attached\n${SERIAL}\tdevice product:panther\n192.168.1.40:5555\toffline\nsideloader\tsideload\n`;
    assert.equal(parseAdbDeviceState(banner, SERIAL), 'device');
    // A Wi-Fi debugging serial has a colon in it and must not be split on.
    assert.equal(parseAdbDeviceState(banner, '192.168.1.40:5555'), 'offline');
    // Anything that is neither device nor unauthorized cannot be driven.
    assert.equal(parseAdbDeviceState(banner, 'sideloader'), 'offline');
    assert.equal(parseAdbDeviceState('List of devices attached\n', SERIAL), 'missing');

    // A provider that returns an _id column first used to hand back "1, auth_token=abc123".
    assert.equal(parseBridgeToken('Row: 0 _id=1, auth_token=abc123\n'), 'abc123');
    assert.equal(parseBridgeToken('Row: 0 _id=1, result={"status":"success","result":"1f0a-uuid"}\n'), '1f0a-uuid');
    assert.equal(parseBridgeToken('Row: 0 auth_token=NULL\n'), undefined);

    assert.equal(localBridgePort('http://127.0.0.1:18300'), 18_300);
    assert.equal(localBridgePort('http://192.168.1.40:8080'), undefined);
    assert.equal(localBridgePort('not a url'), undefined);
    assert.equal(localBridgePort(undefined), undefined);
});

test('each Android phone gets its own bridge forward port', async () => {
    const directory = path.join(workspace, 'ports');
    const second = 'R58N2ZZZZZZ';
    const registered: RegisteredDevice[] = [{
        name: 'first', udid: SERIAL, platform: 'android', driver: 'a11y-bridge',
        android: { serial: SERIAL, bridgeUrl: 'http://127.0.0.1:18300' }, pluginData: {},
    }];
    const service = new DeviceRegistrationService({
        stateDirectory: path.join(directory, 'registrations'),
        discoverDevices: async () => [{ ...androidCandidate, udid: second }],
        loadDevices: async () => registered,
        runCommand: fakeAdb({ 'devices -l': `List of devices attached\n${second}\tdevice` }),
    });
    const created = await service.create(second);
    // 18300 already belongs to the registered phone; adb forward would silently rebind it.
    assert.notEqual(created.bridgePort, 18_300);
    assert.ok(created.bridgePort! > 18_300);
});

test('a bridge URL is normalised, and switching to one invalidates the stored token', async () => {
    const directory = path.join(workspace, 'urls');
    const service = new DeviceRegistrationService({
        stateDirectory: path.join(directory, 'registrations'),
        discoverDevices: async () => [androidCandidate],
        loadDevices: async () => [],
        runCommand: fakeAdb(),
    });
    await service.create(SERIAL);
    const updated = await service.update(SERIAL, { driver: 'a11y-bridge', bridgeUrl: ' http://192.168.1.40:8080// ' });
    assert.equal(updated.bridgeUrl, 'http://192.168.1.40:8080');
    assert.equal(updated.checks.driver?.state, 'pending');
    await assert.rejects(service.update(SERIAL, { bridgeUrl: '192.168.1.40:8080' }), /http\(s\) origin/);
    await assert.rejects(service.update(SERIAL, { bridgePort: 70_000 }), /TCP port/);
});

test('the bridge token never reaches a snapshot, a log line or the state file', async () => {
    const { sanitizedLine } = await import('../src/devices/registration.js');
    const token = 'b1f0a2c3-d4e5-4f60-9a7b-8c9d0e1f2a3b';
    assert.match(sanitizedLine(`adb shell content query --uri ... failed: Row: 0 auth_token=${token}`), /auth_token=<redacted>/);
    assert.match(sanitizedLine(`GET /tap 401 authorization: Bearer ${token}`), /Bearer <redacted>/);
    assert.equal(sanitizedLine(`the phone answered with ${token}`, [token]), 'the phone answered with <redacted>');

    // Every named credential a wizard step can put on a command line or in an environment dump.
    for (const name of ['A11Y_BRIDGE_TOKEN', 'FARM_API_TOKEN', 'NOTIFY_SLACK_TOKEN', 'NOTIFY_TELEGRAM_TOKEN', 'EXPO_ACCESS_TOKEN']) {
        assert.equal(sanitizedLine(`env: ${name}=${token} DEVICE_UDID=R58N1`),
            `env: ${name}=<redacted> DEVICE_UDID=R58N1`, name);
        // Short values and quoted ones too — the generic "token=" rule missed both.
        assert.equal(sanitizedLine(`${name}="ab"`), `${name}=<redacted>`, name);
    }

    // A farm API token is redacted wherever it appears, named or not.
    assert.equal(sanitizedLine('curl -H "authorization: pf_QQb2VuZG9mdGhlbGluZXNhcmVsb25n" http://x'),
        'curl -H "authorization: <redacted>" http://x');
    assert.equal(sanitizedLine('pf_short stays'), 'pf_short stays');

    // Ordinary lines are untouched, and nothing that merely mentions a token is blanked out.
    assert.equal(sanitizedLine('adb -s R58N1 shell input tap 100 200'), 'adb -s R58N1 shell input tap 100 200');

    const directory = path.join(workspace, 'redaction');
    const stateDirectory = path.join(directory, 'registrations');
    const service = new DeviceRegistrationService({
        stateDirectory,
        discoverDevices: async () => [androidCandidate],
        loadDevices: async () => [],
        runCommand: fakeAdb({
            [`-s ${SERIAL} shell pm list packages com.linecorp.simuse.devicebridge`]: 'package:com.linecorp.simuse.devicebridge',
            [`-s ${SERIAL} shell settings get secure enabled_accessibility_services`]: 'com.linecorp.simuse.devicebridge/.BridgeService',
            [`-s ${SERIAL} shell content query --uri content://com.linecorp.simuse.devicebridge/auth_token`]: `Row: 0 auth_token=${token}`,
        }),
        fetchImpl: async () => new Response('ok', { status: 200 }),
    });
    await service.create(SERIAL);
    await service.update(SERIAL, { driver: 'a11y-bridge' });
    await service.run(SERIAL, 'refresh');
    await settle(() => service.get(SERIAL));

    const snapshot = (await service.get(SERIAL))!;
    assert.equal(snapshot.checks.driver?.state, 'passed');
    assert.ok(!JSON.stringify(snapshot).includes(token), 'the public snapshot must not carry the token');
    const stateFile = await readFile(path.join(stateDirectory, `${SERIAL}.json`), 'utf8');
    assert.ok(!stateFile.includes(token), 'the on-disk draft must not carry the token');
});
