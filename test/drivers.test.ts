import assert from 'node:assert/strict';
import test from 'node:test';

import { createA11yBridgeDriver, normaliseBridgeNode } from '../src/drivers/a11y-bridge.js';
import { createAdbDriver, discoverAdbDevices, escapeForInputText } from '../src/drivers/adb.js';
import { driverForDevice, driverKindOf, platformOf } from '../src/drivers/select.js';
import { parseUiautomatorXml } from '../src/drivers/uiautomator-xml.js';
import { findById, findByText, locateText, tappableBounds, waitForText } from '../src/drivers/verify.js';
import type { CommandRunner } from '../src/drivers/common.js';
import type { DeviceDriver, UiNode } from '../src/drivers/types.js';

const SAMPLE_DUMP = `UI hierchary dumped to: /dev/tty
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.zhiliaoapp.musically" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2340]">
    <node index="0" text="" resource-id="com.zhiliaoapp.musically:id/post_button" class="android.widget.LinearLayout" content-desc="" clickable="true" enabled="true" bounds="[540,2100][1060,2220]">
      <node index="0" text="Post" resource-id="" class="android.widget.TextView" content-desc="" clickable="false" enabled="true" bounds="[760,2130][840,2190]" />
    </node>
    <node index="1" text="Tom &amp; Jerry" resource-id="" class="android.widget.TextView" content-desc="caption" clickable="false" enabled="true" bounds="[20,300][500,360]" />
  </node>
</hierarchy>`;

test('uiautomator dump parses into a nested tree with decoded entities', () => {
    const root = parseUiautomatorXml(SAMPLE_DUMP.slice(SAMPLE_DUMP.indexOf('<?xml')));
    assert.equal(root.type, 'android.widget.FrameLayout');
    assert.equal(root.children.length, 2);
    const post = findByText(root, { text: 'post', exact: true });
    assert.ok(post);
    assert.deepEqual(post.bounds, { left: 760, top: 2130, right: 840, bottom: 2190 });
    assert.equal(findByText(root, { text: 'Tom & Jerry' })?.description, 'caption');
});

test('tap targets the nearest clickable ancestor, and ids match with or without the package prefix', () => {
    const root = parseUiautomatorXml(SAMPLE_DUMP.slice(SAMPLE_DUMP.indexOf('<?xml')));
    const label = findByText(root, { text: 'Post' })!;
    assert.deepEqual(tappableBounds(root, label), { left: 540, top: 2100, right: 1060, bottom: 2220 });
    assert.equal(findById(root, 'post_button')?.clickable, true);
    assert.equal(findById(root, 'com.zhiliaoapp.musically:id/post_button')?.clickable, true);
});

test('adb driver issues the expected shell commands', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (file, args, options) => {
        calls.push([file, ...args]);
        if (args.includes('screencap')) return { stdout: Buffer.from('png'), stderr: Buffer.alloc(0) };
        if (args.includes('wm')) return { stdout: 'Physical size: 1080x2340\n', stderr: '' };
        if (args.includes('uiautomator')) return { stdout: SAMPLE_DUMP, stderr: '' };
        void options;
        return { stdout: '', stderr: '' };
    };
    const driver = createAdbDriver({ serial: 'R58N1', run });
    await driver.tap({ x: 10.4, y: 20.6 });
    await driver.swipe({ from: { x: 0, y: 0 }, to: { x: 100, y: 200 }, durationMs: 300 });
    await driver.type('hello world');
    await driver.launchApp('com.zhiliaoapp.musically');
    await driver.pushMedia({ localPath: '/tmp/clip.mp4' });
    assert.deepEqual(await driver.screen(), { width: 1080, height: 2340, scale: 1 });
    assert.equal((await driver.screenshot()).toString(), 'png');
    assert.ok(findByText(await driver.uiTree(), { text: 'Post' }));

    assert.deepEqual(calls[0], ['adb', '-s', 'R58N1', 'shell', 'input', 'tap', '10', '21']);
    assert.deepEqual(calls[1], ['adb', '-s', 'R58N1', 'shell', 'input', 'swipe', '0', '0', '100', '200', '300']);
    assert.deepEqual(calls[2], ['adb', '-s', 'R58N1', 'shell', 'input', 'text', 'hello%sworld']);
    assert.deepEqual(calls[3]?.slice(3, 6), ['shell', 'monkey', '-p']);
    assert.deepEqual(calls[4], ['adb', '-s', 'R58N1', 'push', '/tmp/clip.mp4', '/sdcard/DCIM/Camera/clip.mp4']);
    assert.ok(calls[5]?.join(' ').includes('MEDIA_SCANNER_SCAN_FILE'));
});

test('input text escaping handles spaces and shell metacharacters', () => {
    assert.equal(escapeForInputText("it's a $test (ok)"), "it\\'s%sa%s\\$test%s\\(ok\\)");
});

test('adb device discovery reads serials in the device state', async () => {
    const run: CommandRunner = async () => ({
        stdout: 'List of devices attached\nR58N1\tdevice usb:1-1 product:a52 model:SM_A525F device:a52q\n192.168.1.40:5555\toffline\nemulator-5554\tdevice product:sdk\n',
        stderr: '',
    });
    assert.deepEqual(await discoverAdbDevices(run), [
        { serial: 'R58N1', model: 'SM_A525F' },
        { serial: 'emulator-5554' },
    ]);
});

test('a11y-bridge driver sends bearer auth, form bodies, and decodes envelopes', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const tree = { className: 'root', boundsInScreen: { left: 0, top: 0, right: 1080, bottom: 2340 }, children: [
        { className: 'android.widget.Button', text: 'Post', clickable: true, boundsInScreen: { left: 500, top: 2000, right: 700, bottom: 2100 } },
    ] };
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        const route = new URL(String(url)).pathname;
        const result = route === '/screenshot' ? Buffer.from('png').toString('base64')
            : route === '/a11y_tree_full' ? tree
                : 'ok';
        return new Response(JSON.stringify({ status: 'success', result }), { status: 200 });
    }) as typeof fetch;
    const driver = createA11yBridgeDriver({ serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300/', token: 'secret', fetchImpl });

    await driver.tap({ x: 1, y: 2 });
    assert.equal(requests[0]!.url, 'http://127.0.0.1:18300/tap');
    assert.equal((requests[0]!.init.headers as Record<string, string>).authorization, 'Bearer secret');
    assert.equal(requests[0]!.init.body, 'x=1&y=2');

    await driver.type('hi');
    // Form-encoded, so the base64 padding "=" arrives as %3D and the bridge's parser URL-decodes it.
    assert.equal(requests[1]!.init.body, `base64_text=${encodeURIComponent(Buffer.from('hi').toString('base64'))}&clear=false`);

    assert.equal((await driver.screenshot()).toString(), 'png');
    assert.deepEqual(await driver.screen(), { width: 1080, height: 2340, scale: 1 });
    assert.deepEqual(await locateText(driver, { text: 'post' }), { x: 600, y: 2050 });
    await assert.rejects(driver.launchApp('x'), /without a fallback driver/);
});

test('bridge node normalisation fills defaults', () => {
    const node = normaliseBridgeNode({ text: 'x' });
    assert.equal(node.enabled, true);
    assert.equal(node.clickable, false);
    assert.deepEqual(node.bounds, { left: 0, top: 0, right: 0, bottom: 0 });
});

test('driver selection defaults and rejects platform mismatches', () => {
    assert.equal(platformOf({}), 'ios');
    assert.equal(driverKindOf({}), 'wda');
    assert.equal(platformOf({ android: { serial: 'a' } }), 'android');
    assert.equal(driverKindOf({ platform: 'android' }), 'adb');
    assert.equal(driverKindOf({ platform: 'android', driver: 'a11y-bridge' }), 'a11y-bridge');

    const base = { name: 'phone', udid: 'R58N1', pluginData: {} };
    assert.equal(driverForDevice({ ...base, platform: 'android' }).kind, 'adb');
    assert.equal(driverForDevice({ ...base, platform: 'android', driver: 'a11y-bridge', android: { serial: 'R58N1', bridgeUrl: 'http://127.0.0.1:18300', bridgeToken: 't' } }).kind, 'a11y-bridge');
    assert.equal(driverForDevice({ ...base, udid: '00008030-000', wdaLocalPort: 8100 }).kind, 'wda');
    assert.throws(() => driverForDevice({ ...base, driver: 'adb' }), /not valid for iOS/);
    assert.throws(() => driverForDevice({ ...base, platform: 'android', driver: 'wda' }), /not valid for Android/);
    assert.throws(() => driverForDevice({ ...base, platform: 'android', driver: 'a11y-bridge' }), /bridgeUrl/);
});

test('waitForText polls until the element appears and reports what it saw on timeout', async () => {
    let calls = 0;
    const tree = (text: string): UiNode => ({
        id: '', type: 'root', text: '', description: '', bounds: { left: 0, top: 0, right: 10, bottom: 10 }, clickable: false, enabled: true,
        children: [{ id: '', type: 'TextView', text, description: '', bounds: { left: 0, top: 0, right: 5, bottom: 5 }, clickable: true, enabled: true, children: [] }],
    });
    const driver = { uiTree: async () => tree(++calls >= 3 ? 'Posted' : 'Uploading') } as unknown as DeviceDriver;
    const node = await waitForText(driver, { text: 'posted' }, { intervalMs: 1 });
    assert.equal(node.text, 'Posted');
    await assert.rejects(waitForText(driver, { text: 'nope' }, { timeoutMs: 5, intervalMs: 1 }), /Screen showed: Posted/);
});
