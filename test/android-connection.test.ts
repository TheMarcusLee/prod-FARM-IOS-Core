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

test('a bridge device with no bridgeUrl is an error, not a healthy adb phone', async () => {
    const devices: RegisteredDevice[] = [{
        name: 'pixel', udid: 'R58N1', platform: 'android', driver: 'a11y-bridge',
        android: { serial: 'R58N1' }, pluginData: {},
    }];
    const { instance } = manager(devices, ['R58N1'], () => true);
    await instance.reconcile();
    assert.equal(instance.status('R58N1')?.wda, 'error');
    assert.match(instance.status('R58N1')?.message ?? '', /android\.bridgeUrl/);
});

test('reconnect on an Android phone waits for a fresh pass instead of a poll already in flight', async () => {
    const devices: RegisteredDevice[] = [{ name: 'pixel', udid: 'R58N1', platform: 'android', pluginData: {} }];
    let connected: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let firstLoad = true;
    const instance = new DeviceConnectionManager({
        loadDevices: async () => {
            // Hold the first pass open so the reconnect below arrives while it is still running.
            if (firstLoad) { firstLoad = false; entered(); await gate; }
            return devices;
        },
        connectedUdids: async () => connected,
        endpointReady: async () => false,
        spawnSupervisor: () => { throw new Error('should not spawn WDA for Android'); },
        now: () => 0,
    });
    const slow = instance.reconcile();
    await started;
    // The phone is plugged back in while the slow pass is still reading a stale, empty listing.
    connected = ['R58N1'];
    release();
    await slow;
    assert.equal(instance.status('R58N1')?.wda, 'disconnected');
    assert.equal((await instance.reconnect('R58N1'))?.wda, 'ready');
});

test('a disabled Android device is forgotten rather than reported as ready', async () => {
    const devices: RegisteredDevice[] = [{ name: 'pixel', udid: 'R58N1', platform: 'android', pluginData: {} }];
    const { instance } = manager(devices, ['R58N1'], () => false);
    await instance.reconcile();
    assert.equal(instance.status('R58N1')?.wda, 'ready');
    devices[0]!.disabled = true;
    await instance.reconcile();
    assert.equal(instance.status('R58N1'), undefined);
    assert.deepEqual(instance.statuses(), []);
});
