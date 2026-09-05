import assert from 'node:assert/strict';
import test from 'node:test';

import type { RegisteredDevice } from '../src/devices/registry.js';
import type { DeviceDriver } from '../src/drivers/types.js';
import { automationFromDriver, pluginEnvironment, readinessProblem } from '../src/scheduler/executor.js';

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
    assert.equal(await readinessProblem(bridge, false, async (url) => { probed.push(url); return true; }), undefined);
    assert.deepEqual(probed, ['http://192.168.1.40:18300/ping']);
    assert.match((await readinessProblem(bridge, true, down)) ?? '', /bridge is unavailable/);
    assert.match((await readinessProblem({ ...adb, driver: 'a11y-bridge' }, true, up)) ?? '', /no android.bridgeUrl/);
});

test('plugin environment is platform-specific and never leaks iOS variables to Android', () => {
    assert.deepEqual(pluginEnvironment(ios, '1234'), {
        DEVICE_UDID: 'UDID-1', DEVICE_PLATFORM: 'ios', DEVICE_DRIVER: 'wda',
        IOS_UDID: 'UDID-1', WDA_URL: 'http://127.0.0.1:8101', IOS_PASSCODE: '1234',
    });
    assert.deepEqual(pluginEnvironment(adb, undefined), {
        DEVICE_UDID: 'R58N1', DEVICE_PLATFORM: 'android', DEVICE_DRIVER: 'adb', ANDROID_SERIAL: 'R58N1',
    });
    assert.deepEqual(pluginEnvironment(bridge, undefined), {
        DEVICE_UDID: 'R58N1', DEVICE_PLATFORM: 'android', DEVICE_DRIVER: 'a11y-bridge', ANDROID_SERIAL: 'R58N1',
        A11Y_BRIDGE_URL: 'http://192.168.1.40:18300', A11Y_BRIDGE_TOKEN: 'secret',
    });
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
