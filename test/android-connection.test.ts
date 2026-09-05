import assert from 'node:assert/strict';
import test from 'node:test';

import { DeviceConnectionManager } from '../src/devices/connection-manager.js';
import type { RegisteredDevice } from '../src/devices/registry.js';

function manager(devices: RegisteredDevice[], connected: string[], reachable: (url: string) => boolean) {
    const spawned: string[] = [];
    const instance = new DeviceConnectionManager({
        loadDevices: async () => devices,
        connectedUdids: async () => connected,
        endpointReady: async (url) => reachable(url),
        spawnSupervisor: (device) => { spawned.push(device.udid); throw new Error('should not spawn WDA for Android'); },
        now: () => 0,
    });
    return { instance, spawned };
}

test('Android devices never get a WDA supervisor and report adb visibility', async () => {
    const devices: RegisteredDevice[] = [{ name: 'pixel', udid: 'R58N1', platform: 'android', pluginData: {} }];
    const { instance, spawned } = manager(devices, ['R58N1'], () => false);
    await instance.reconcile();
    assert.deepEqual(spawned, []);
    assert.equal(instance.status('R58N1')?.physical, 'connected');
    assert.equal(instance.status('R58N1')?.wda, 'ready');

    const offline = manager(devices, [], () => false);
    await offline.instance.reconcile();
    assert.equal(offline.instance.status('R58N1')?.wda, 'disconnected');
    assert.match(offline.instance.status('R58N1')?.message ?? '', /adb/);
});

test('a11y-bridge devices are ready when /ping answers, even with nothing attached', async () => {
    const devices: RegisteredDevice[] = [{
        name: 'pixel', udid: 'R58N1', platform: 'android', driver: 'a11y-bridge',
        android: { serial: 'R58N1', bridgeUrl: 'http://192.168.1.40:18300/', bridgeToken: 't' }, pluginData: {},
    }];
    const pinged: string[] = [];
    const wifi = manager(devices, [], (url) => { pinged.push(url); return true; });
    await wifi.instance.reconcile();
    // The manager also probes Appium each cycle; only the bridge ping matters here.
    assert.deepEqual(pinged.filter((url) => url.endsWith('/ping')), ['http://192.168.1.40:18300/ping']);
    assert.equal(wifi.instance.status('R58N1')?.physical, 'connected');
    assert.equal(wifi.instance.status('R58N1')?.wda, 'ready');

    const bridgeDown = manager(devices, ['R58N1'], () => false);
    await bridgeDown.instance.reconcile();
    assert.equal(bridgeDown.instance.status('R58N1')?.physical, 'connected');
    assert.equal(bridgeDown.instance.status('R58N1')?.wda, 'connecting');
    assert.equal(bridgeDown.spawned.length, 0);
});
