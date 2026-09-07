import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { DeviceDriver, MediaFile, Point, Rect, TimedPoint, UiNode } from '../src/drivers/types.js';
import { createMotionSource } from '../src/motion/source.js';
import type { PostManifest } from '../src/tiktok/post-manifest.js';
import {
    MAX_CAPTION_LENGTH, POST_SELECTORS, galleryCells, postOnAndroid, switchAccount,
} from '../src/tiktok/android/post.js';
import { doomscrollOnAndroid } from '../src/tiktok/android/doomscroll.js';
import { driverFromEnv, driverKindFromEnv } from '../src/tiktok/android/driver-from-env.js';
import { createTikTokPlugin } from '../src/tiktok-plugin.js';
import type { TaskDefinition, TaskExecutionContext } from '../src/plugin.js';

const SCREEN: Rect = { left: 0, top: 0, right: 1080, bottom: 2340 };

function element(partial: Partial<UiNode>): UiNode {
    return {
        id: '', type: 'android.widget.TextView', text: '', description: '',
        bounds: { left: 40, top: 200, right: 400, bottom: 280 },
        clickable: true, enabled: true, children: [], ...partial,
    };
}

function screen(...children: Array<Partial<UiNode>>): UiNode {
    return element({
        type: 'android.widget.FrameLayout', bounds: SCREEN, clickable: false,
        children: children.map(element),
    });
}

function contains({ bounds }: UiNode, { x, y }: Point): boolean {
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function hitAt(root: UiNode, point: Point): UiNode | undefined {
    const hits = root.children.filter((child) => contains(child, point));
    return hits[hits.length - 1];
}

/** What a human would call the thing that was tapped, for the tap-order assertions. */
function label(node: UiNode | undefined): string {
    if (!node) return '(nothing)';
    return node.text || node.description || node.id || '(unlabelled)';
}

/** Controls the script marks STAY leave the app on the same screen (picker cells, caption box). */
const STAY = 'stay';

interface FakeDriver {
    driver: DeviceDriver;
    taps: string[];
    typed: string[];
    keys: string[];
    pushed: string[];
    launched: string[];
    swipes: number;
    /** Every path handed to `gesture`, so a test can look at the shape of a swipe. */
    paths: unknown[][];
}

/**
 * A driver whose `uiTree` walks a script of screens: a tap advances to the next one unless the
 * control is marked STAY, which is how a real routine experiences the app. Everything else is
 * recorded.
 */
function fakeDriver(screens: UiNode[]): FakeDriver {
    const state: FakeDriver = {
        taps: [], typed: [], keys: [], pushed: [], launched: [], swipes: 0, paths: [],
        driver: undefined as unknown as DeviceDriver,
    };
    let index = 0;
    const current = () => screens[Math.min(index, screens.length - 1)]!;
    const press = (point: Point): void => {
        const hit = hitAt(current(), point);
        state.taps.push(label(hit));
        if (hit?.type !== STAY) index = Math.min(index + 1, screens.length - 1);
    };
    state.driver = {
        kind: 'adb', platform: 'android', udid: 'R58N1ABCDE',
        launchApp: async (appId: string) => { state.launched.push(appId); },
        terminateApp: async () => {},
        tap: async (point: Point) => { press(point); },
        swipe: async () => { state.swipes += 1; },
        // A tap is a two-sample path that does not move; anything else is a swipe.
        gesture: async (path: TimedPoint[]) => {
            const first = path[0]!;
            const last = path[path.length - 1]!;
            if (first.x === last.x && first.y === last.y) press(first);
            else { state.swipes += 1; state.paths.push(path); }
        },
        type: async (text: string) => { state.typed.push(text); },
        pressKey: async (key: string) => { state.keys.push(key); },
        screenshot: async () => Buffer.alloc(0),
        uiTree: async () => current(),
        screen: async () => ({ width: 1080, height: 2340, scale: 1 }),
        pushMedia: async (file: MediaFile) => { state.pushed.push(file.fileName ?? file.localPath); },
        pause: async () => {},
    } as unknown as DeviceDriver;
    return state;
}

/**
 * Every tap the routines make is jittered out of a motion source; a seeded one keeps the taps in
 * these tests landing in the same pixels every run. A getter, so each use starts the same stream.
 */
const FAST = {
    settleMs: 0, pollIntervalMs: 1, screenTimeoutMs: 50, successTimeoutMs: 50,
    get motion() { return createMotionSource({ udid: 'R58N1ABCDE', seed: 'tiktok-android-test' }); },
};

/** Create → Upload → picker (cells + Next) → editor Next → publish screen → confirmation. */
function postFlowScreens(confirmation: string): UiNode[] {
    return [
        screen({ text: 'Create', bounds: { left: 480, top: 2200, right: 600, bottom: 2320 } }),
        screen({ text: 'Upload', bounds: { left: 800, top: 2100, right: 1000, bottom: 2200 } }),
        screen(
            // Deliberately out of layout order: the routine must sort top-left (newest) first.
            { id: 'com.zhiliaoapp.musically:id/iv_image', type: STAY, text: 'oldest', bounds: { left: 720, top: 300, right: 1070, bottom: 650 } },
            { id: 'com.zhiliaoapp.musically:id/iv_image', type: STAY, text: 'newest', bounds: { left: 10, top: 300, right: 360, bottom: 650 } },
            { id: 'com.zhiliaoapp.musically:id/iv_image', type: STAY, text: 'middle', bounds: { left: 365, top: 300, right: 715, bottom: 650 } },
            { text: 'Next', bounds: { left: 800, top: 2200, right: 1000, bottom: 2300 } },
        ),
        screen({ text: 'Next', bounds: { left: 800, top: 2200, right: 1000, bottom: 2300 } }),
        screen(
            { id: 'com.zhiliaoapp.musically:id/et_caption', type: STAY, text: 'Add a caption', bounds: { left: 40, top: 200, right: 1040, bottom: 400 } },
            { text: 'Drafts', bounds: { left: 40, top: 2200, right: 400, bottom: 2300 } },
            { text: 'Post', bounds: { left: 600, top: 2200, right: 1040, bottom: 2300 } },
        ),
        screen({ text: confirmation, bounds: { left: 40, top: 1000, right: 1040, bottom: 1100 }, clickable: false }),
    ];
}

const manifest = (overrides: Partial<PostManifest> = {}): PostManifest => ({
    device: { udid: 'R58N1ABCDE', name: 'pixel-03', platform: 'android' },
    files: [{ path: '/tmp/clip.mp4', name: 'clip.mp4', mimeType: 'video/mp4' }],
    destination: 'publish',
    ...overrides,
});

test('the Android post routine taps the flow in order, types the caption and confirms the upload', async () => {
    const fake = fakeDriver(postFlowScreens('Your video is being uploaded'));
    await postOnAndroid(fake.driver, manifest({ caption: 'hello farm' }), FAST);

    assert.deepEqual(fake.taps, ['Create', 'Upload', 'newest', 'Next', 'Next', 'Add a caption', 'Post']);
    assert.deepEqual(fake.launched, ['com.zhiliaoapp.musically']);
    assert.deepEqual(fake.pushed, ['clip.mp4']);
    assert.deepEqual(fake.typed, ['hello farm']);
    // The routine wakes the phone before opening the app, then dismisses the keyboard with back.
    assert.deepEqual(fake.keys, ['wake', 'back']);
});

test('destination draft taps Drafts and waits for the draft confirmation instead', async () => {
    const fake = fakeDriver(postFlowScreens('Saved to Drafts'));
    await postOnAndroid(fake.driver, manifest({ destination: 'draft' }), FAST);

    assert.deepEqual(fake.taps, ['Create', 'Upload', 'newest', 'Next', 'Next', 'Drafts']);
    // No caption in this manifest, so the caption field is never opened and nothing is typed.
    assert.deepEqual(fake.typed, []);
    assert.deepEqual(fake.keys, ['wake']);
});

test('media is pushed newest-last so the first manifest file is the first gallery cell', async () => {
    const fake = fakeDriver(postFlowScreens('Posted'));
    await postOnAndroid(fake.driver, manifest({
        files: [
            { path: '/tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' },
            { path: '/tmp/b.jpg', name: 'b.jpg', mimeType: 'image/jpeg' },
        ],
    }), FAST);
    assert.deepEqual(fake.pushed, ['b.jpg', 'a.jpg']);
    // Two files means the multi-select toggle is attempted; it is absent here and skipped.
    assert.deepEqual(fake.taps.slice(0, 4), ['Create', 'Upload', 'newest', 'middle']);
});

test('a missing success indicator fails with a message naming the control and the screen', async () => {
    const screens = postFlowScreens('Your video is being uploaded');
    screens[screens.length - 1] = screen({ text: 'Something else entirely', clickable: false });
    const fake = fakeDriver(screens);

    await assert.rejects(
        postOnAndroid(fake.driver, manifest(), FAST),
        (error: Error) => /Timed out waiting for the upload confirmation/.test(error.message)
            && /Something else entirely/.test(error.message),
    );
});

test('a control that is nowhere on screen fails with the alternates that were tried', async () => {
    const fake = fakeDriver([screen({ text: 'For You' })]);
    await assert.rejects(
        postOnAndroid(fake.driver, manifest(), FAST),
        /TikTok control not found: Create .*"Create"/s,
    );
});

test('account switching goes profile tab → switcher → account row → verify', async () => {
    const fake = fakeDriver([
        screen({ text: 'Profile', bounds: { left: 900, top: 2200, right: 1040, bottom: 2320 } }),
        screen({ id: 'com.zhiliaoapp.musically:id/account_switch', text: '@other.account', bounds: { left: 300, top: 100, right: 780, bottom: 200 } }),
        screen(
            { text: '@other.account', bounds: { left: 40, top: 1400, right: 1040, bottom: 1500 } },
            { text: '@farm.one', bounds: { left: 40, top: 1550, right: 1040, bottom: 1650 } },
        ),
        screen({ text: 'Profile', bounds: { left: 900, top: 2200, right: 1040, bottom: 2320 } }),
        screen({ text: '@farm.one', bounds: { left: 300, top: 100, right: 780, bottom: 200 }, clickable: false }),
    ]);
    await switchAccount(fake.driver, '@farm.one', FAST);
    assert.deepEqual(fake.taps, ['Profile', '@other.account', '@farm.one', 'Profile']);
});

test('an account that never becomes active is reported rather than silently posted from', async () => {
    const fake = fakeDriver([
        screen({ text: 'Profile' }),
        screen({ id: 'com.zhiliaoapp.musically:id/account_switch', text: '@other.account' }),
        screen({ text: '@farm.one' }),
        screen({ text: 'Profile' }),
        screen({ text: '@other.account', clickable: false }),
    ]);
    await assert.rejects(switchAccount(fake.driver, '@farm.one', FAST), /could not confirm TikTok account "@farm.one"/);
});

test('gallery cells are found by resource-id and ordered top-left first', () => {
    const root = screen(
        { id: 'x:id/iv_image', text: 'b', bounds: { left: 400, top: 100, right: 700, bottom: 400 } },
        { id: 'x:id/iv_image', text: 'a', bounds: { left: 10, top: 100, right: 300, bottom: 400 } },
        { description: 'Video, 12 seconds', text: 'c', bounds: { left: 10, top: 500, right: 300, bottom: 800 } },
        { id: 'x:id/unrelated', text: 'toolbar', bounds: { left: 0, top: 0, right: 1080, bottom: 90 } },
    );
    assert.deepEqual(galleryCells(root).map((cell) => cell.text), ['a', 'b', 'c']);
    assert.ok(POST_SELECTORS.galleryCellIds.includes('iv_image'));
});

test('the Android doomscroll swipes, engages through the tree and reports a summary', async () => {
    const feed = screen(
        { id: 'com.zhiliaoapp.musically:id/ivm_like', description: 'Like', bounds: { left: 980, top: 1400, right: 1060, bottom: 1480 } },
        { id: 'com.zhiliaoapp.musically:id/ivm_collect', description: 'Add to Favorites', bounds: { left: 980, top: 1550, right: 1060, bottom: 1630 } },
    );
    const fake = fakeDriver([feed]);
    let clock = 0;
    const summary = await doomscrollOnAndroid(fake.driver, {
        durationMinutes: 1, personality: 'engaged', likeEnabled: true, saveEnabled: true,
        // Always engage, and advance the clock a fixed step per call so the run ends.
        random: () => 0,
        now: () => (clock += 2_000),
        seed: 'test-seed',
    });
    assert.equal(summary.reason, 'completed');
    assert.ok(summary.videosViewed >= 1);
    assert.ok(summary.swipes >= 1, 'expected at least one swipe');
    assert.ok(fake.taps.includes('Like'));
    assert.ok(fake.taps.includes('Add to Favorites'));
    assert.equal(fake.swipes, summary.swipes);
    // Every flick is a sampled arc, not a two-point drag.
    assert.ok(fake.paths.every((path) => path.length >= 12));
    assert.deepEqual(fake.launched, ['com.zhiliaoapp.musically']);
});

test('an aborted doomscroll stops instead of failing', async () => {
    const controller = new AbortController();
    const fake = fakeDriver([screen({ text: 'For You' })]);
    controller.abort();
    const summary = await doomscrollOnAndroid(fake.driver, {
        durationMinutes: 5, personality: 'casual', likeEnabled: false, saveEnabled: false,
        signal: controller.signal, random: () => 0.99,
    });
    assert.equal(summary.reason, 'stopped');
    assert.equal(summary.swipes, 0);
});

test('the driver is rebuilt from the child process environment', () => {
    assert.equal(driverKindFromEnv({ DEVICE_DRIVER: 'a11y-bridge' }), 'a11y-bridge');
    assert.equal(driverFromEnv({ DEVICE_PLATFORM: 'android', ANDROID_SERIAL: 'R58N1' }).kind, 'adb');
    const bridge = driverFromEnv({
        DEVICE_DRIVER: 'a11y-bridge', ANDROID_SERIAL: 'R58N1',
        A11Y_BRIDGE_URL: 'http://192.168.1.40:18300', A11Y_BRIDGE_TOKEN: 'secret',
    });
    assert.equal(bridge.kind, 'a11y-bridge');
    assert.equal(bridge.udid, 'R58N1');
    assert.throws(() => driverFromEnv({ DEVICE_DRIVER: 'a11y-bridge', ANDROID_SERIAL: 'R58N1' }), /A11Y_BRIDGE_URL/);
    assert.throws(() => driverFromEnv({}), /ANDROID_SERIAL/);
});

function taskOf(plugin: ReturnType<typeof createTikTokPlugin>, type: string): TaskDefinition {
    const task = plugin.tasks.find((candidate) => candidate.type === type);
    assert.ok(task, `plugin has no ${type} task`);
    return task;
}

interface RunProcessCall { entrypoint: string; args?: string[]; env?: Record<string, string> }

async function executeOn(
    plugin: ReturnType<typeof createTikTokPlugin>, type: string, platform: 'ios' | 'android',
    payload: Record<string, unknown>, workspaceDirectory: string,
): Promise<RunProcessCall> {
    let call: RunProcessCall | undefined;
    const context = {
        executionId: 'exec-1', attempt: 1, workspaceDirectory,
        device: { udid: 'device-1', name: 'phone', platform },
        devicePluginData: {},
        driver: { kind: platform === 'android' ? 'adb' : 'wda' },
        assets: [{ id: 'asset-1', path: '/tmp/clip.mp4', name: 'clip.mp4', mimeType: 'video/mp4', size: 1, sha256: 'x' }],
        signal: new AbortController().signal,
        log: async () => {},
        runProcess: async (specification: RunProcessCall) => { call = specification; return { exitCode: 0, stopped: false }; },
    } as unknown as TaskExecutionContext;
    await taskOf(plugin, type).execute(context, payload as never);
    assert.ok(call, 'runProcess was not called');
    return call;
}

test('the plugin picks the Android entrypoints for Android devices and leaves iOS untouched', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'farm-android-'));
    try {
        const plugin = createTikTokPlugin();
        const doomscrollPayload = { durationMinutes: 5, personality: 'casual', likeEnabled: true, saveEnabled: false };

        const android = await executeOn(plugin, 'doomscroll', 'android', doomscrollPayload, workspace);
        assert.match(android.entrypoint, /tiktok\/android\/doomscroll\.ts$/);
        assert.equal(android.env?.TIKTOK_PACKAGE, 'com.zhiliaoapp.musically');
        assert.equal(android.env?.IOS_UDID, undefined);
        assert.equal(android.env?.DOOMSCROLL_PERSONALITY, 'casual');

        const ios = await executeOn(plugin, 'doomscroll', 'ios', doomscrollPayload, workspace);
        assert.match(ios.entrypoint, /tiktok\/doomscroll\.ts$/);
        assert.equal(ios.env?.IOS_UDID, 'device-1');
        assert.equal(ios.env?.TIKTOK_BUNDLE_ID, 'com.zhiliaoapp.musically');
        assert.equal(ios.env?.TIKTOK_PACKAGE, undefined);

        const postPayload = {
            media: [{ assetId: 'asset-1', name: 'clip.mp4', mimeType: 'video/mp4' }],
            destination: 'draft', account: '@farm.one', caption: 'hi',
        };
        const androidPost = await executeOn(plugin, 'post', 'android', postPayload, workspace);
        assert.match(androidPost.entrypoint, /tiktok\/android\/post\.ts$/);
        const written = JSON.parse(await readFile(androidPost.args![0]!, 'utf8')) as PostManifest;
        assert.equal(written.account, '@farm.one');
        assert.equal(written.files[0]!.path, '/tmp/clip.mp4');

        const iosPost = await executeOn(plugin, 'post', 'ios', postPayload, workspace);
        assert.match(iosPost.entrypoint, /tiktok\/post\.ts$/);
        assert.equal(iosPost.env, undefined);
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test('configured Android entrypoints override the built-in ones', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'farm-android-'));
    try {
        const plugin = createTikTokPlugin({
            androidDoomscrollEntrypoint: '/example/android-doomscroll.js',
            androidPostEntrypoint: '/example/android-post.js',
            doomscrollEntrypoint: '/example/doomscroll.js',
        });
        const call = await executeOn(plugin, 'doomscroll', 'android',
            { durationMinutes: 5, personality: 'casual', likeEnabled: false, saveEnabled: false }, workspace);
        assert.equal(call.entrypoint, '/example/android-doomscroll.js');
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test('a non-ASCII caption fails before anything is pushed or opened', async () => {
    const fake = fakeDriver(postFlowScreens('Posted'));
    await assert.rejects(
        postOnAndroid(fake.driver, manifest({ caption: 'summer vibes 🌴' }), FAST),
        /adb shell input text.*cannot type.*a11y-bridge/s,
    );
    // Nothing was pushed and TikTok was never opened, so there is no half-finished draft to clean up.
    assert.deepEqual(fake.pushed, []);
    assert.deepEqual(fake.launched, []);
});

test('the same caption is fine on the bridge driver, which types UTF-8', async () => {
    const fake = fakeDriver(postFlowScreens('Posted'));
    const bridge = { ...fake.driver, kind: 'a11y-bridge' as const };
    await postOnAndroid(bridge, manifest({ caption: 'summer vibes 🌴' }), FAST);
    assert.deepEqual(fake.typed, ['summer vibes 🌴']);
});

test('an over-long caption is rejected rather than silently truncated by TikTok', async () => {
    const fake = fakeDriver(postFlowScreens('Posted'));
    await assert.rejects(
        postOnAndroid(fake.driver, manifest({ caption: 'a'.repeat(MAX_CAPTION_LENGTH + 1) }), FAST),
        /2,?200/,
    );
});

test('a control the selector table no longer matches reports what was on screen', async () => {
    const fake = fakeDriver([screen({ text: 'For You' }, { text: 'Following' })]);
    await assert.rejects(
        postOnAndroid(fake.driver, manifest(), FAST),
        /Screen showed: For You, Following/,
    );
});

test('a handle that is a prefix of the active one is not read as already active', async () => {
    // The phone is on @bobby; the manifest wants @bob. A substring match would post from @bobby.
    const fake = fakeDriver([
        screen({ text: 'Profile', bounds: { left: 900, top: 2200, right: 1040, bottom: 2320 } }),
        screen({ id: 'com.zhiliaoapp.musically:id/tv_nickname', text: '@bobby', bounds: { left: 40, top: 300, right: 400, bottom: 380 } }),
        screen({ text: '@bob', bounds: { left: 40, top: 600, right: 400, bottom: 680 } }),
        screen({ text: 'Profile', bounds: { left: 900, top: 2200, right: 1040, bottom: 2320 } }),
        screen({ text: '@bob', clickable: false, bounds: { left: 40, top: 300, right: 400, bottom: 380 } }),
    ]);
    await switchAccount(fake.driver, '@bob', FAST);
    assert.ok(fake.taps.includes('@bob'), `expected the @bob row to be tapped, got ${fake.taps.join(' → ')}`);
});

test('a gallery cell whose container and image both match counts once', () => {
    const root = element({
        type: 'android.widget.FrameLayout', bounds: SCREEN, clickable: false,
        children: [element({
            id: 'com.zhiliaoapp.musically:id/album_image', description: 'video',
            bounds: { left: 10, top: 300, right: 360, bottom: 650 },
            children: [element({
                id: 'com.zhiliaoapp.musically:id/iv_image', description: 'video, 12 seconds',
                bounds: { left: 10, top: 300, right: 360, bottom: 650 },
            })],
        })],
    });
    assert.equal(galleryCells(root).length, 1);
});

test('the picker refusing to show enough media names the count and the screen', async () => {
    const screens = postFlowScreens('Posted');
    const fake = fakeDriver(screens);
    await assert.rejects(
        postOnAndroid(fake.driver, manifest({
            files: [
                { path: '/tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' },
                { path: '/tmp/b.jpg', name: 'b.jpg', mimeType: 'image/jpeg' },
                { path: '/tmp/c.jpg', name: 'c.jpg', mimeType: 'image/jpeg' },
                { path: '/tmp/d.jpg', name: 'd.jpg', mimeType: 'image/jpeg' },
            ],
        }), FAST),
        /showed 3 selectable item\(s\) but 4 are needed.*Screen showed/s,
    );
});

test('driverFromEnv refuses an a11y-bridge device with no token, and rejects an unknown driver', () => {
    assert.throws(() => driverFromEnv({ ANDROID_SERIAL: 'R58N1', DEVICE_DRIVER: 'a11y-bridge', A11Y_BRIDGE_URL: 'http://127.0.0.1:18300' }), /A11Y_BRIDGE_TOKEN/);
    assert.throws(() => driverKindFromEnv({ DEVICE_DRIVER: 'wda' }), /must be adb or a11y-bridge/);
    assert.throws(() => driverFromEnv({ DEVICE_DRIVER: 'adb' }), /ANDROID_SERIAL/);
});
