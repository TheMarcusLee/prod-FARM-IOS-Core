import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ANDROID_PROPERTY_TTL_MS, discoverConnectedAndroidDevices, parseAndroidProperties, resetAndroidDiscoveryCache,
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
