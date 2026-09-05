import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ANDROID_PROPERTY_TTL_MS, DEVICE_PROPERTY_TTL_MS, discoverConnectedAndroidDevices,
    discoverConnectedIosDevices, parseAndroidProperties, resetAndroidDiscoveryCache, resetDiscoveryCaches, ttlCache,
} from '../src/devices/discovery.js';
import type { CommandRunner } from '../src/drivers/common.js';

const LISTING = 'List of devices attached\nR58N1\tdevice usb:1-1 product:a52 model:SM_A525F device:a52q\n192.168.1.40:5555\tdevice product:panther model:Pixel_7\nemu\tunauthorized\n';

test('Android discovery lists adb devices with model and OS version, asking each phone once', async (context) => {
    context.after(resetAndroidDiscoveryCache);
    resetAndroidDiscoveryCache();
    const getprops: string[] = [];
    const run: CommandRunner = async (_file, args) => {
        if (args[0] === 'devices') return { stdout: LISTING, stderr: '' };
        getprops.push(args[1]!);
        return { stdout: args[1] === 'R58N1' ? '14\nSM-A525F\n' : '13\n\n', stderr: '' };
    };
    const first = await discoverConnectedAndroidDevices(run);
    assert.deepEqual(first, [
        { udid: 'R58N1', platform: 'android', name: 'SM-A525F', osVersion: '14', modelName: 'SM-A525F' },
        { udid: '192.168.1.40:5555', platform: 'android', name: 'Pixel_7', osVersion: '13' },
    ]);
    await discoverConnectedAndroidDevices(run);
    assert.deepEqual(getprops, ['R58N1', '192.168.1.40:5555']);
});

test('Android discovery is empty, not fatal, when adb is missing or switched off', async (context) => {
    context.after(() => { delete process.env.ANDROID_DISCOVERY; resetAndroidDiscoveryCache(); });
    resetAndroidDiscoveryCache();
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => { warnings.push(message); };
    try {
        const missing: CommandRunner = async () => { throw new Error('spawn adb ENOENT'); };
        assert.deepEqual(await discoverConnectedAndroidDevices(missing), []);
        assert.deepEqual(await discoverConnectedAndroidDevices(missing), []);
        assert.equal(warnings.length, 1, 'the same failure is reported once');
    } finally {
        console.warn = warn;
    }
    process.env.ANDROID_DISCOVERY = 'off';
    let called = false;
    await discoverConnectedAndroidDevices(async () => { called = true; return { stdout: LISTING, stderr: '' }; });
    assert.equal(called, false);
});

test('getprop output falls back to the listing model and unknown version', () => {
    assert.deepEqual(parseAndroidProperties('\n\n', { name: 'SM_A525F', osVersion: 'unknown' }), { name: 'SM_A525F', osVersion: 'unknown' });
    assert.deepEqual(parseAndroidProperties('12\r\nPixel 4a\r\n', { name: 'x', osVersion: 'unknown' }), { name: 'Pixel 4a', osVersion: '12', modelName: 'Pixel 4a' });
});

test('a phone whose OS was upgraded is re-read once the cache entry expires', async (context) => {
    context.after(resetAndroidDiscoveryCache);
    resetAndroidDiscoveryCache();
    let release = '13';
    const run: CommandRunner = async (_file, args) => {
        if (args[0] === 'devices') return { stdout: 'List of devices attached\nR58N1\tdevice model:SM_A525F\n', stderr: '' };
        return { stdout: `${release}\nSM-A525F\n`, stderr: '' };
    };
    let clock = 1_000;
    const now = () => clock;
    assert.equal((await discoverConnectedAndroidDevices(run, now))[0]?.osVersion, '13');
    release = '14';
    assert.equal((await discoverConnectedAndroidDevices(run, now))[0]?.osVersion, '13', 'still cached');
    clock += ANDROID_PROPERTY_TTL_MS + 1;
    assert.equal((await discoverConnectedAndroidDevices(run, now))[0]?.osVersion, '14');
});

test('the adb daemon banner is not mistaken for the OS version', () => {
    const stdout = '* daemon not running; starting now at tcp:5037 *\n* daemon started successfully *\n14\nPixel 7\n';
    assert.deepEqual(parseAndroidProperties(stdout, { name: 'x', osVersion: 'unknown' }), { name: 'Pixel 7', osVersion: '14', modelName: 'Pixel 7' });
});

test('the shared enumeration cache collapses concurrent and repeated polls into one pass', async () => {
    let clock = 1_000;
    const now = () => clock;
    let passes = 0;
    const cache = ttlCache(async () => { passes += 1; return [`pass-${passes}`]; });

    // Two executions reaching the cache at the same instant share one enumeration.
    const [a, b] = await Promise.all([cache.read(now, 2_500), cache.read(now, 2_500)]);
    assert.deepEqual(a, ['pass-1']);
    assert.deepEqual(b, ['pass-1']);
    assert.equal(passes, 1);

    // A second poll inside the window is served from the cache.
    clock += 2_400;
    assert.deepEqual(await cache.read(now, 2_500), ['pass-1']);
    assert.equal(passes, 1);

    // Past it, the phones are enumerated again — plugging one in is noticed.
    clock += 200;
    assert.deepEqual(await cache.read(now, 2_500), ['pass-2']);
    assert.equal(passes, 2);

    // A failed enumeration is not cached as an answer.
    const failing = ttlCache(async () => { throw new Error('adb died'); });
    await assert.rejects(failing.read(now, 2_500), /adb died/);
    await assert.rejects(failing.read(now, 2_500), /adb died/);

    cache.clear();
    assert.deepEqual(await cache.read(now, 2_500), ['pass-3']);
});

test('iOS device names and OS versions are asked for once per device, then cached until the TTL', async (context) => {
    context.after(resetDiscoveryCaches);
    resetDiscoveryCaches();
    let clock = 1_000;
    const calls: string[] = [];
    const ios = {
        getConnectedDevices: async () => ['UDID-A', 'UDID-B'],
        getDeviceName: async (udid: string) => { calls.push(`name:${udid}`); return `iPhone ${udid}`; },
        getOSVersion: async (udid: string) => { calls.push(`os:${udid}`); return '17.5'; },
        getDeviceInfo: async (udid: string) => { calls.push(`info:${udid}`); return { ProductType: 'iPhone14,5' }; },
    };
    const first = await discoverConnectedIosDevices(ios, () => clock);
    assert.equal(first.length, 2);
    assert.equal(first[0]!.name, 'iPhone UDID-A');
    assert.equal(first[0]!.osVersion, '17.5');
    assert.equal(first[0]!.productType, 'iPhone14,5');
    assert.equal(calls.length, 6, 'three usbmuxd round trips per device on the first pass');

    // Three more polls inside the window: the UDID listing still happens, the per-device blobs do not.
    for (let poll = 0; poll < 3; poll += 1) {
        clock += 5_000;
        assert.deepEqual(await discoverConnectedIosDevices(ios, () => clock), first);
    }
    assert.equal(calls.length, 6);

    // Past the TTL an OS update is picked up rather than following the phone around for ever.
    clock += DEVICE_PROPERTY_TTL_MS;
    ios.getOSVersion = async (udid: string) => { calls.push(`os:${udid}`); return '18.0'; };
    const refreshed = await discoverConnectedIosDevices(ios, () => clock);
    assert.equal(refreshed[0]!.osVersion, '18.0');
    assert.equal(calls.length, 12);
});
