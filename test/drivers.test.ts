import assert from 'node:assert/strict';
import test from 'node:test';

import {
    BRIDGE_RETRY_BACKOFF_MS, bridgePingUrl, createA11yBridgeDriver, decodeScreenshot, normaliseBridgeNode, screenFromTree,
} from '../src/drivers/a11y-bridge.js';
import { createAdbDriver, discoverAdbDevices, escapeForInputText, parseAdbDevices, parseWmSize } from '../src/drivers/adb.js';
import { createWdaDriver } from '../src/drivers/wda.js';
import { driverForDevice, driverKindOf, platformOf } from '../src/drivers/select.js';
import { parseUiautomatorXml } from '../src/drivers/uiautomator-xml.js';
import { findById, findByText, locateText, tappableBounds, waitForText } from '../src/drivers/verify.js';
import type { CommandRunner } from '../src/drivers/common.js';
import { DriverError, type DeviceDriver, type UiNode } from '../src/drivers/types.js';

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('body')]);

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
        if (args.includes('screencap')) return { stdout: PNG_BYTES, stderr: Buffer.alloc(0) };
        if (args.includes('wm')) return { stdout: 'Physical size: 1080x2340\n', stderr: '' };
        if (args.includes('uiautomator')) return { stdout: 'UI hierchary dumped to: /sdcard/window_dump.xml\n', stderr: '' };
        if (args.includes('cat')) return { stdout: SAMPLE_DUMP, stderr: '' };
        if (args.includes('monkey')) return { stdout: 'Events injected: 1\n', stderr: '' };
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
    assert.deepEqual(await driver.screenshot(), PNG_BYTES);
    assert.ok(findByText(await driver.uiTree(), { text: 'Post' }));

    assert.deepEqual(calls[0], ['adb', '-s', 'R58N1', 'shell', 'input', 'tap', '10', '21']);
    // A plain swipe is now a generated arc played as one motionevent chain; `straight: true` and
    // the motionevent-less fallback are covered in motion.test.ts.
    assert.match(calls[1]!.at(-1)!, /^input motionevent DOWN 0 0;.*input motionevent UP \d+ \d+$/);
    assert.deepEqual(calls[2], ['adb', '-s', 'R58N1', 'shell', 'input', 'text', "'hello world'"]);
    assert.deepEqual(calls[3]?.slice(3, 6), ['shell', 'monkey', '-p']);
    assert.deepEqual(calls[4], ['adb', '-s', 'R58N1', 'push', '/tmp/clip.mp4', '/sdcard/DCIM/Camera/clip.mp4']);
    assert.ok(calls[5]?.join(' ').includes('scan_file'));
    assert.deepEqual(calls[8]?.slice(3), ['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml']);
    assert.deepEqual(calls[9]?.slice(3), ['shell', 'cat', '/sdcard/window_dump.xml']);
});

test('a real screenshot has to be a PNG, not an adb error on stdout', async () => {
    const run: CommandRunner = async () => ({ stdout: Buffer.from('error: device offline\n'), stderr: Buffer.alloc(0) });
    await assert.rejects(createAdbDriver({ serial: 'R58N1', run }).screenshot(), /not a PNG/);
});

test('the media scan falls back to the legacy broadcast when scan_file is missing', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (file, args) => {
        calls.push(args);
        if (args.includes('content')) throw new DriverError('Unknown method scan_file');
        return { stdout: '', stderr: '' };
    };
    await createAdbDriver({ serial: 'R58N1', run }).pushMedia({ localPath: '/tmp/a b.mp4' });
    assert.deepEqual(calls[1]?.slice(2), ['shell', 'content', 'call', '--uri', 'content://media/external/file', '--method', 'scan_file', '--arg', "'/sdcard/DCIM/Camera/a b.mp4'"]);
    assert.ok(calls[2]?.join(' ').includes('MEDIA_SCANNER_SCAN_FILE'));
    // The remote path is quoted so the device shell does not split it on the space.
    assert.ok(calls[2]?.includes("'file:///sdcard/DCIM/Camera/a b.mp4'"));
});

test('a flaky monkey launch falls back to resolving the launcher activity', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (file, args) => {
        calls.push(args);
        if (args.includes('monkey')) return { stdout: '** No activities found to run, monkey aborted.\n', stderr: '' };
        if (args.includes('resolve-activity')) return { stdout: 'priority=0 preferredOrder=0\ncom.zhiliaoapp.musically/.main.MainActivity\n', stderr: '' };
        return { stdout: '', stderr: '' };
    };
    await createAdbDriver({ serial: 'R58N1', run }).launchApp('com.zhiliaoapp.musically');
    assert.deepEqual(calls[2]?.slice(2), [
        'shell', 'am', 'start', '-W', '-a', 'android.intent.action.MAIN',
        '-c', 'android.intent.category.LAUNCHER', '-n', "'com.zhiliaoapp.musically/.main.MainActivity'",
    ]);
});

test('an override display size wins over the physical panel size', () => {
    assert.deepEqual(parseWmSize('Physical size: 1440x3120\nOverride size: 1080x2340\n'), { width: 1080, height: 2340, scale: 1 });
    assert.deepEqual(parseWmSize('Physical size: 1080x2340\n'), { width: 1080, height: 2340, scale: 1 });
    assert.throws(() => parseWmSize('cmd: Failure calling service window\n'), /Could not read screen size/);
});

test('input text quotes for the device shell and refuses what it cannot type', () => {
    assert.equal(escapeForInputText("it's a $test (ok)"), "'it'\\''s a $test (ok)'");
    assert.equal(escapeForInputText('a*b?c;d|e'), "'a*b?c;d|e'");
    // adb cannot type these at all, so say so instead of posting mojibake.
    assert.throws(() => escapeForInputText('nice clip 🎉'), /a11y-bridge/);
    assert.throws(() => escapeForInputText('caf\u00e9'), /only printable ASCII/);
    assert.throws(() => escapeForInputText('line one\nline two'), /cannot type/);
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

test('the device listing survives the daemon banner and keeps non-device states', () => {
    const stdout = '* daemon not running; starting now at tcp:5037 *\n* daemon started successfully *\n'
        + 'List of devices attached\n'
        + 'R58N1                  unauthorized usb:1-1\n'
        + '192.168.1.40:5555      device product:raven model:Pixel_6_Pro\n';
    assert.deepEqual(parseAdbDevices(stdout), [
        { serial: 'R58N1', state: 'unauthorized' },
        { serial: '192.168.1.40:5555', state: 'device', model: 'Pixel_6_Pro' },
    ]);
});

test('a listing with no header at all still yields the devices', () => {
    assert.deepEqual(parseAdbDevices('R58N1\tdevice\n'), [{ serial: 'R58N1', state: 'device' }]);
});

test('a11y-bridge driver sends bearer auth, form bodies, and decodes envelopes', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const tree = { className: 'root', boundsInScreen: { left: 0, top: 0, right: 1080, bottom: 2340 }, children: [
        { className: 'android.widget.Button', text: 'Post', clickable: true, boundsInScreen: { left: 500, top: 2000, right: 700, bottom: 2100 } },
    ] };
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        const route = new URL(String(url)).pathname;
        const result = route === '/screenshot' ? PNG_BYTES.toString('base64')
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

    assert.deepEqual(await driver.screenshot(), PNG_BYTES);
    assert.deepEqual(await driver.screen(), { width: 1080, height: 2340, scale: 1 });
    assert.deepEqual(await locateText(driver, { text: 'post' }), { x: 600, y: 2050 });
    await assert.rejects(driver.launchApp('x'), /without a fallback driver/);
});

test('a bridge that answers with something other than its envelope is a driver error', async () => {
    const html = (async () => new Response('<html>Sign in to the hotel Wi-Fi</html>', { status: 200 })) as unknown as typeof fetch;
    const driver = createA11yBridgeDriver({ serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300', token: 't', fetchImpl: html });
    await assert.rejects(driver.tap({ x: 1, y: 1 }), /did not return JSON/);

    const failure = (async () => new Response(JSON.stringify({ status: 'error', error: 'service not bound' }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(
        createA11yBridgeDriver({ serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300', token: 't', fetchImpl: failure }).pressKey('home'),
        /bridge \/keyboard\/key failed: service not bound/,
    );
});

test('a busy bridge is retried with backoff, and gives up with a message that says why', async () => {
    const slept: number[] = [];
    const sleep = async (milliseconds: number) => { slept.push(milliseconds); };
    let calls = 0;
    const busyThenFine = (async () => {
        calls += 1;
        return calls < 3
            ? new Response(JSON.stringify({ status: 'error', code: 'server_busy' }), { status: 503 })
            : new Response(JSON.stringify({ status: 'success', result: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    const driver = createA11yBridgeDriver({
        serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300', token: 't', fetchImpl: busyThenFine, sleep,
    });
    await driver.tap({ x: 1, y: 1 });
    assert.equal(calls, 3, 'two 503s, then the answer');
    assert.deepEqual(slept, [200, 400]);

    // Busy for good: four attempts in all, then a step failure naming the cause.
    slept.length = 0;
    let attempts = 0;
    const alwaysBusy = (async () => {
        attempts += 1;
        return new Response(JSON.stringify({ status: 'error', code: 'server_busy' }), { status: 503 });
    }) as unknown as typeof fetch;
    await assert.rejects(
        createA11yBridgeDriver({ serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300', token: 't', fetchImpl: alwaysBusy, sleep })
            .tap({ x: 1, y: 1 }),
        /still busy after 4 attempts.*server_busy/s,
    );
    assert.equal(attempts, 4);
    assert.deepEqual(slept, [200, 400, 800]);
    assert.deepEqual([...BRIDGE_RETRY_BACKOFF_MS], [200, 400, 800]);
});

test('a connection reset is retried; a timeout is not', async () => {
    const slept: number[] = [];
    const sleep = async (milliseconds: number) => { slept.push(milliseconds); };
    let calls = 0;
    const resetThenFine = (async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new TypeError('fetch failed'), { cause: new Error('read ECONNRESET') });
        return new Response(JSON.stringify({ status: 'success', result: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    await createA11yBridgeDriver({
        serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300', token: 't', fetchImpl: resetThenFine, sleep,
    }).pressKey('home');
    assert.equal(calls, 3);
    assert.deepEqual(slept, [200, 400]);

    // A deadline is the caller's own budget; burning it three more times helps nobody.
    let timeouts = 0;
    const slow = (async () => { timeouts += 1; throw new DOMException('The operation timed out.', 'TimeoutError'); }) as unknown as typeof fetch;
    await assert.rejects(
        createA11yBridgeDriver({ serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300', token: 't', fetchImpl: slow, sleep })
            .pressKey('home'),
        /is unavailable/,
    );
    assert.equal(timeouts, 1);
});

test('408 and 411 from the bridge are surfaced as what they mean, not as a bare status', async () => {
    const answering = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    const sleep = async () => { /* nothing is retried here */ };

    await assert.rejects(
        createA11yBridgeDriver({
            serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300', token: 't', sleep,
            fetchImpl: answering(408, 'request timeout'),
        }).tap({ x: 1, y: 1 }),
        /timed out reading the request \(408\).*request timeout/s,
    );

    await assert.rejects(
        createA11yBridgeDriver({
            serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300', token: 't', sleep,
            fetchImpl: answering(411, 'length required'),
        }).tap({ x: 1, y: 1 }),
        /rejected a chunked request \(411\).*Content-Length/s,
    );

    // Anything else keeps the old shape: the URL and the status.
    await assert.rejects(
        createA11yBridgeDriver({
            serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300', token: 't', sleep,
            fetchImpl: answering(401, 'bad token'),
        }).tap({ x: 1, y: 1 }),
        /http:\/\/127\.0\.0\.1:18300\/tap returned 401: bad token/,
    );
});

test('every bridge request asks for the connection to be closed afterwards', async () => {
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
        headers.push(init?.headers as Record<string, string>);
        return new Response(JSON.stringify({ status: 'success', result: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    const driver = createA11yBridgeDriver({ serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300', token: 't', fetchImpl });
    await driver.tap({ x: 1, y: 1 });
    await driver.pressKey('back');
    assert.equal(headers.length, 2);
    for (const header of headers) assert.equal(header.connection, 'close');
});

test('a screenshot that is not a PNG is rejected, and a data: prefix is tolerated', () => {
    assert.deepEqual(decodeScreenshot(`data:image/png;base64,${PNG_BYTES.toString('base64')}`), PNG_BYTES);
    assert.throws(() => decodeScreenshot(''), /not base64 text/);
    assert.throws(() => decodeScreenshot({ image: 'x' }), /not base64 text/);
    assert.throws(() => decodeScreenshot(Buffer.from('nope').toString('base64')), /not a PNG/);
});

test('screen size comes from the widest node, not a root with empty bounds', () => {
    const node = (right: number, bottom: number, children: UiNode[] = []): UiNode => ({
        id: '', type: '', text: '', description: '', bounds: { left: 0, top: 0, right, bottom }, clickable: false, enabled: true, children,
    });
    assert.deepEqual(screenFromTree(node(0, 0, [node(1080, 2340), node(1080, 100)])), { width: 1080, height: 2340, scale: 1 });
    assert.throws(() => screenFromTree(node(0, 0)), /no bounds/);
});

test('a bridge base URL keeps working with any number of trailing slashes', () => {
    assert.equal(bridgePingUrl('http://127.0.0.1:18300//'), 'http://127.0.0.1:18300/ping');
    assert.equal(bridgePingUrl(' http://127.0.0.1:18300 '), 'http://127.0.0.1:18300/ping');
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

test('recents and power are keyevents on Android and the lock button on iOS', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: '', stderr: '' };
    };
    const adb = createAdbDriver({ serial: 'R58N1', run });
    await adb.pressKey('recents');
    await adb.pressKey('power');
    assert.deepEqual(calls, [
        ['adb', '-s', 'R58N1', 'shell', 'input', 'keyevent', '187'],
        ['adb', '-s', 'R58N1', 'shell', 'input', 'keyevent', '26'],
    ]);

    // The bridge sends the same two codes over its own keyboard endpoint.
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({ status: 'success', result: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    const bridge = createA11yBridgeDriver({ serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300', token: 't', fetchImpl });
    await bridge.pressKey('recents');
    await bridge.pressKey('power');
    assert.deepEqual(bodies, ['key_code=187', 'key_code=26']);

    // iOS: power is the lock WDA already speaks; recents is refused rather than faked.
    const urls: string[] = [];
    const wdaFetch = (async (url: string) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ value: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const wda = createWdaDriver({ udid: 'ios-udid', wdaUrl: 'http://127.0.0.1:8100', fetchImpl: wdaFetch });
    await wda.pressKey('power');
    assert.deepEqual(urls, ['http://127.0.0.1:8100/wda/lock']);
    await assert.rejects(wda.pressKey('recents'), /does not support pressKey\(recents\)/);
});
