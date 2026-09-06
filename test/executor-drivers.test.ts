import assert from 'node:assert/strict';
import test from 'node:test';

import type { RegisteredDevice } from '../src/devices/registry.js';
import type { DeviceDriver } from '../src/drivers/types.js';
import { motionProfileFor } from '../src/motion/profile.js';
import { automationFromDriver, createLogRedactor, pluginEnvironment, readinessProblem } from '../src/scheduler/executor.js';

const ios: RegisteredDevice = { name: 'iphone', udid: 'UDID-1', wdaLocalPort: 8101, pluginData: {} };
const adb: RegisteredDevice = { name: 'pixel', udid: 'R58N1', platform: 'android', pluginData: {} };
const bridge: RegisteredDevice = {
    name: 'pixel', udid: 'R58N1', platform: 'android', driver: 'a11y-bridge',
    android: { serial: 'R58N1', bridgeUrl: 'http://192.168.1.40:18300', bridgeToken: 'secret' }, pluginData: {},
};

test('readiness follows the driver: WDA+Appium on iOS, adb visibility, or the bridge ping', async () => {
    const up = async () => true;
    const down = async () => false;
    assert.equal(await readinessProblem(ios, false, up), 'device is offline');
    assert.match((await readinessProblem(ios, true, down)) ?? '', /WDA is unavailable at http:\/\/127\.0\.0\.1:8101/);
    assert.equal(await readinessProblem(ios, true, up), undefined);

    assert.equal(await readinessProblem(adb, false, up), 'device is not visible to adb');
    assert.equal(await readinessProblem(adb, true, down), undefined);

    const probed: string[] = [];
    assert.equal(await readinessProblem(bridge, true, async (url) => { probed.push(url); return true; }), undefined);
    assert.deepEqual(probed, ['http://192.168.1.40:18300/ping']);
    assert.match((await readinessProblem(bridge, true, down)) ?? '', /bridge is unavailable/);
    assert.match((await readinessProblem({ ...adb, driver: 'a11y-bridge' }, true, up)) ?? '', /no android.bridgeUrl/);
});

test('a bridge device still needs adb, because launch, terminate and push fall back to it', async () => {
    const up = async () => true;
    // The bridge answers, but the phone is not visible to adb: the run would fail on its first
    // launchApp, so it is held rather than started.
    assert.match((await readinessProblem(bridge, false, up)) ?? '', /not visible to adb/);
    assert.match((await readinessProblem(bridge, false, up)) ?? '', /android\.bridgeOnly/);

    // Opted in: the bridge alone is enough, and adb is never consulted.
    const bridgeOnly = { ...bridge, android: { ...bridge.android!, bridgeOnly: true } };
    assert.equal(await readinessProblem(bridgeOnly, false, up), undefined);

    // bridgeOnly does not excuse a bridge that is down.
    assert.match((await readinessProblem(bridgeOnly, false, async () => false)) ?? '', /bridge is unavailable/);
});

test('plugin environment is platform-specific and never leaks iOS variables to Android', () => {
    assert.deepEqual(pluginEnvironment(ios, '1234'), {
        DEVICE_UDID: 'UDID-1', DEVICE_PLATFORM: 'ios', DEVICE_DRIVER: 'wda',
        MOTION_HAND: motionProfileFor('UDID-1').hand, MOTION_SPEED: motionProfileFor('UDID-1').speed,
        IOS_UDID: 'UDID-1', WDA_URL: 'http://127.0.0.1:8101', IOS_PASSCODE: '1234',
    });
    assert.deepEqual(pluginEnvironment(adb, undefined), {
        DEVICE_UDID: 'R58N1', DEVICE_PLATFORM: 'android', DEVICE_DRIVER: 'adb', ANDROID_SERIAL: 'R58N1',
        MOTION_HAND: motionProfileFor('R58N1').hand, MOTION_SPEED: motionProfileFor('R58N1').speed,
    });
    assert.deepEqual(pluginEnvironment(bridge, undefined), {
        DEVICE_UDID: 'R58N1', DEVICE_PLATFORM: 'android', DEVICE_DRIVER: 'a11y-bridge', ANDROID_SERIAL: 'R58N1',
        MOTION_HAND: motionProfileFor('R58N1').hand, MOTION_SPEED: motionProfileFor('R58N1').speed,
        A11Y_BRIDGE_URL: 'http://192.168.1.40:18300', A11Y_BRIDGE_TOKEN: 'secret',
    });
    // One seed per execution, handed to the routine so its gestures replay.
    assert.equal(pluginEnvironment(adb, undefined, '4242').MOTION_SEED, '4242');
});

test('the legacy automation surface forwards to the driver', async () => {
    const calls: unknown[] = [];
    const driver = {
        kind: 'adb', platform: 'android', udid: 'R58N1',
        launchApp: async (id: string) => { calls.push(['launch', id]); },
        terminateApp: async (id: string) => { calls.push(['terminate', id]); },
        tap: async (point: { x: number; y: number }) => { calls.push(['tap', point]); },
        swipe: async (swipe: unknown) => { calls.push(['swipe', swipe]); },
        screenshot: async () => Buffer.from('png'),
        pause: async () => { calls.push(['pause']); },
    } as unknown as DeviceDriver;
    const automation = automationFromDriver(driver);
    await automation.activateApp('com.zhiliaoapp.musically');
    await automation.tap(1, 2);
    await automation.swipe(0, 0, 10, 20, 300);
    await automation.pause(1);
    assert.equal((await automation.screenshot()).toString(), 'png');
    assert.deepEqual(calls, [
        ['launch', 'com.zhiliaoapp.musically'],
        ['tap', { x: 1, y: 2 }],
        ['swipe', { from: { x: 0, y: 0 }, to: { x: 10, y: 20 }, durationMs: 300 }],
        ['pause'],
    ]);
});

test('run logs never carry the bridge token or the passcode the child process was given', () => {
    const redact = createLogRedactor(['b3a1f0de-4c2d-4f0a-9b77-11ee22ff33aa', '4821', undefined]);
    assert.equal(
        redact('POST http://192.168.1.40:8080/tap authorization=Bearer b3a1f0de-4c2d-4f0a-9b77-11ee22ff33aa'),
        'POST http://192.168.1.40:8080/tap authorization=Bearer <redacted>',
    );
    assert.equal(redact('env: A11Y_BRIDGE_TOKEN=whatever-else IOS_PASSCODE="4821"'),
        'env: A11Y_BRIDGE_TOKEN=<redacted> IOS_PASSCODE=<redacted>');
    assert.equal(redact("a11y_bridge_token: 'nested value'"), 'a11y_bridge_token=<redacted>');
    // Exact-value replacement is not limited to an assignment: a token pasted into a URL goes too.
    assert.equal(redact('curl http://x/?token=b3a1f0de-4c2d-4f0a-9b77-11ee22ff33aa&y=1'),
        'curl http://x/?token=<redacted>&y=1');
    assert.equal(redact('unlocking with 4821'), 'unlocking with <redacted>');
    assert.equal(redact('nothing secret here'), 'nothing secret here');
});

test('the redactor tolerates a device with no secrets at all', () => {
    const redact = createLogRedactor([undefined, '', '12']);
    assert.equal(redact('plain line'), 'plain line');
    // Too short to be a secret, so it is not blanked out everywhere it appears.
    assert.equal(redact('12 items'), '12 items');
    assert.equal(redact('A11Y_BRIDGE_TOKEN=abc'), 'A11Y_BRIDGE_TOKEN=<redacted>');
});
