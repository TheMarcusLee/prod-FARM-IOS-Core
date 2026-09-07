import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { DeviceDriver, MediaFile, Point, Rect, TimedPoint, UiNode } from '../src/drivers/types.js';
import { createMotionSource } from '../src/motion/source.js';
import type { InstagramPostManifest } from '../src/instagram/post-manifest.js';
import { formatForMedia, formatProblem } from '../src/instagram/post-manifest.js';
import { POST_SELECTORS, galleryCells, postOnAndroid, switchAccount } from '../src/instagram/android/post.js';
import { warmupOnAndroid } from '../src/instagram/android/warmup.js';
import { createInstagramPlugin } from '../src/instagram-plugin.js';
import type { TaskDefinition, TaskExecutionContext } from '../src/plugin.js';

/**
 * The same fake-driver pattern the TikTok Android tests use: a scripted list of screens, a tap
 * advances to the next one unless the control is marked STAY, and everything the routine does to
 * the "phone" is recorded. No adb, no phone, no OCR.
 */

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
    paths: unknown[][];
}

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

/** A getter, so each use starts the same seeded stream and taps land in the same pixels. */
const FAST = {
    settleMs: 0, pollIntervalMs: 1, screenTimeoutMs: 50, successTimeoutMs: 50,
    get motion() { return createMotionSource({ udid: 'R58N1ABCDE', seed: 'instagram-android-test' }); },
};

const CELL_ID = 'com.instagram.android:id/gallery_grid_item_thumbnail';

function cell(name: string, left: number): Partial<UiNode> {
    return { id: CELL_ID, type: STAY, text: name, bounds: { left, top: 300, right: left + 340, bottom: 650 } };
}

/**
 * Create → surface tab → picker (cells + Next) → editor Next → share screen → confirmation.
 * `cells` are laid out deliberately out of order so the routine has to sort them.
 */
function postFlowScreens(confirmation: string, options: { surface: string; cells: Array<Partial<UiNode>>; multiSelect?: boolean }): UiNode[] {
    return [
        screen({ text: 'Create', bounds: { left: 480, top: 2200, right: 600, bottom: 2320 } }),
        screen({ text: options.surface, bounds: { left: 400, top: 2100, right: 700, bottom: 2200 } }),
        ...(options.multiSelect
            ? [screen({ text: 'Select multiple', bounds: { left: 60, top: 1900, right: 400, bottom: 2000 } })]
            : []),
        screen(
            ...options.cells,
            { text: 'Next', bounds: { left: 800, top: 2200, right: 1000, bottom: 2300 } },
        ),
        screen({ text: 'Next', bounds: { left: 800, top: 2200, right: 1000, bottom: 2300 } }),
        screen(
            { id: 'com.instagram.android:id/caption_input_text_view', type: STAY, text: 'Write a caption', bounds: { left: 40, top: 200, right: 1040, bottom: 400 } },
            { text: 'Save draft', bounds: { left: 40, top: 2200, right: 400, bottom: 2300 } },
            { text: 'Share', bounds: { left: 600, top: 2200, right: 1040, bottom: 2300 } },
        ),
        screen({ text: confirmation, bounds: { left: 40, top: 1000, right: 1040, bottom: 1100 }, clickable: false }),
    ];
}

const manifest = (overrides: Partial<InstagramPostManifest> = {}): InstagramPostManifest => ({
    device: { udid: 'R58N1ABCDE', name: 'pixel-03', platform: 'android' },
    files: [{ path: '/tmp/clip.mp4', name: 'clip.mp4', mimeType: 'video/mp4' }],
    format: 'reel',
    destination: 'publish',
    ...overrides,
});

/* ---- the three formats -------------------------------------------------- */

test('a reel is one video: the routine picks REEL, takes the newest clip and confirms the upload', async () => {
    const fake = fakeDriver(postFlowScreens('Your reel is being shared', {
        surface: 'Reel', cells: [cell('newest', 10)],
    }));
    await postOnAndroid(fake.driver, manifest({ caption: 'hello farm' }), FAST);

    assert.deepEqual(fake.taps, ['Create', 'Reel', 'newest', 'Next', 'Next', 'Write a caption', 'Share']);
    assert.deepEqual(fake.launched, ['com.instagram.android']);
    assert.deepEqual(fake.pushed, ['clip.mp4']);
    assert.deepEqual(fake.typed, ['hello farm']);
    // Wake before the app, back to dismiss the keyboard, Home at the end.
    assert.deepEqual(fake.keys, ['wake', 'back', 'home']);
});

test('a photo is one image: the routine picks POST and the single cell', async () => {
    const fake = fakeDriver(postFlowScreens('Posting', { surface: 'Post', cells: [cell('newest', 10)] }));
    await postOnAndroid(fake.driver, manifest({
        format: 'photo', files: [{ path: '/tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' }],
    }), FAST);

    assert.deepEqual(fake.taps, ['Create', 'Post', 'newest', 'Next', 'Next', 'Share']);
    assert.deepEqual(fake.pushed, ['a.jpg']);
    // No caption in this manifest, so the caption field is never opened and nothing is typed.
    assert.deepEqual(fake.typed, []);
    assert.deepEqual(fake.keys, ['wake', 'home']);
});

test('a carousel pushes newest-last and taps its slides in manifest order', async () => {
    const fake = fakeDriver(postFlowScreens('Posting', {
        surface: 'Post', multiSelect: true,
        // Out of layout order on purpose: the routine must sort top-left (newest) first.
        cells: [cell('third', 720), cell('first', 10), cell('second', 365)],
    }));
    await postOnAndroid(fake.driver, manifest({
        format: 'carousel',
        files: [
            { path: '/tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' },
            { path: '/tmp/b.jpg', name: 'b.jpg', mimeType: 'image/jpeg' },
            { path: '/tmp/c.jpg', name: 'c.jpg', mimeType: 'image/jpeg' },
        ],
    }), FAST);

    // Reversed push makes slide 1 the newest gallery cell…
    assert.deepEqual(fake.pushed, ['c.jpg', 'b.jpg', 'a.jpg']);
    // …and the cells are then tapped top-left first, which is slide order.
    assert.deepEqual(fake.taps, [
        'Create', 'Post', 'Select multiple', 'first', 'second', 'third', 'Next', 'Next', 'Share',
    ]);
});

test('a draft backs out of the share screen and waits for the draft confirmation', async () => {
    const fake = fakeDriver(postFlowScreens('Draft saved', { surface: 'Post', cells: [cell('newest', 10)] }));
    await postOnAndroid(fake.driver, manifest({
        format: 'photo', destination: 'draft',
        files: [{ path: '/tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' }],
    }), FAST);

    assert.deepEqual(fake.taps, ['Create', 'Post', 'newest', 'Next', 'Next', 'Save draft']);
    assert.deepEqual(fake.keys, ['wake', 'back', 'home']);
});

/* ---- what a format refuses ---------------------------------------------- */

test('mixed media is rejected before anything is pushed or opened', async () => {
    const fake = fakeDriver(postFlowScreens('Posting', { surface: 'Post', cells: [cell('newest', 10)] }));
    await assert.rejects(
        postOnAndroid(fake.driver, manifest({
            format: 'carousel',
            files: [
                { path: '/tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' },
                { path: '/tmp/clip.mp4', name: 'clip.mp4', mimeType: 'video/mp4' },
            ],
        }), FAST),
        /either video or images/,
    );
    // Nothing reached the phone, so there is no orphan file and no open composer to clean up.
    assert.deepEqual(fake.pushed, []);
    assert.deepEqual(fake.launched, []);
});

test('every format states exactly what it accepts', () => {
    const video = { mimeType: 'video/mp4' };
    const image = { mimeType: 'image/jpeg' };
    assert.equal(formatProblem('reel', [video]), undefined);
    assert.match(formatProblem('reel', [image]) ?? '', /exactly one video/);
    assert.equal(formatProblem('photo', [image]), undefined);
    assert.match(formatProblem('photo', [image, image]) ?? '', /exactly one image/);
    assert.equal(formatProblem('carousel', Array.from({ length: 20 }, () => image)), undefined);
    assert.match(formatProblem('carousel', [image]) ?? '', /2–20 images/);
    assert.match(formatProblem('carousel', Array.from({ length: 21 }, () => image)) ?? '', /2–20 images/);
    assert.match(formatProblem('carousel', [image, video]) ?? '', /either video or images/);

    // What the Control Center relies on: the format a set of files can only be.
    assert.equal(formatForMedia([video]), 'reel');
    assert.equal(formatForMedia([image]), 'photo');
    assert.equal(formatForMedia([image, image]), 'carousel');
    assert.throws(() => formatForMedia([video, video]), /2–20 images/);
});

test('the task validator refuses a carousel with a clip in it, and infers a missing format', () => {
    const post = createInstagramPlugin().tasks.find(({ type }) => type === 'post') as TaskDefinition;
    const media = (mimeType: string, name: string) => ({ assetId: name, name, mimeType });
    const validationContext = { timingKind: 'now' as const, devicePluginData: {} };

    assert.throws(() => post.validate({
        media: [media('image/jpeg', 'a.jpg'), media('video/mp4', 'clip.mp4')],
        format: 'carousel', destination: 'draft',
    }, validationContext), /either video or images/);

    const inferred = post.validate({
        media: [media('image/jpeg', 'a.jpg'), media('image/jpeg', 'b.jpg')], destination: 'draft',
    }, validationContext);
    assert.equal(inferred.format, 'carousel');

    assert.throws(() => post.validate({
        media: [media('video/mp4', 'clip.mp4')], format: 'photo', destination: 'draft',
    }, validationContext), /exactly one image/);
});

/* ---- selectors, account switching, warm-up ------------------------------ */

test('gallery cells are found by resource-id and ordered top-left first', () => {
    const root = screen(
        { id: 'x:id/image_view', text: 'b', bounds: { left: 400, top: 100, right: 700, bottom: 400 } },
        { id: 'x:id/image_view', text: 'a', bounds: { left: 10, top: 100, right: 300, bottom: 400 } },
        { description: 'Photo, 3 October', text: 'c', bounds: { left: 10, top: 500, right: 300, bottom: 800 } },
        { id: 'x:id/unrelated', text: 'toolbar', bounds: { left: 0, top: 0, right: 1080, bottom: 90 } },
    );
    assert.deepEqual(galleryCells(root).map((found) => found.text), ['a', 'b', 'c']);
    assert.ok(POST_SELECTORS.galleryCellIds.includes('image_view'));
});

test('a control the selector table no longer matches reports what was on screen', async () => {
    const fake = fakeDriver([screen({ text: 'For you' }, { text: 'Following' })]);
    await assert.rejects(
        postOnAndroid(fake.driver, manifest(), FAST),
        (error: Error) => /Instagram control not found: Create/.test(error.message)
            && /Screen showed: For you, Following/.test(error.message),
    );
});

test('account switching goes profile tab → switcher → account row → verify', async () => {
    const fake = fakeDriver([
        screen({ text: 'Profile', bounds: { left: 900, top: 2200, right: 1040, bottom: 2320 } }),
        screen({ id: 'com.instagram.android:id/title_view', text: '@other.account', bounds: { left: 300, top: 100, right: 780, bottom: 200 } }),
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
        screen({ id: 'com.instagram.android:id/title_view', text: '@other.account' }),
        screen({ text: '@farm.one' }),
        screen({ text: 'Profile' }),
        screen({ text: '@other.account', clickable: false }),
    ]);
    await assert.rejects(switchAccount(fake.driver, '@farm.one', FAST), /could not confirm Instagram account "@farm.one"/);
});

test('the warm-up browses, engages through the tree and leaves the phone on the home screen', async () => {
    const feed = screen(
        { id: 'com.instagram.android:id/feed_tab', description: 'Home', bounds: { left: 20, top: 2200, right: 180, bottom: 2320 } },
        { id: 'com.instagram.android:id/row_feed_button_like', description: 'Like', bounds: { left: 40, top: 1400, right: 140, bottom: 1480 } },
        { id: 'com.instagram.android:id/row_feed_button_save', description: 'Save', bounds: { left: 940, top: 1400, right: 1040, bottom: 1480 } },
    );
    const fake = fakeDriver([feed]);
    let clock = 0;
    const summary = await warmupOnAndroid(fake.driver, {
        durationMinutes: 1, surface: 'feed', personality: 'engaged', likeEnabled: true, saveEnabled: true,
        // Always engage, and advance the clock a fixed step per call so the run ends.
        random: () => 0,
        now: () => (clock += 2_000),
        seed: 'test-seed',
    });

    assert.equal(summary.reason, 'completed');
    assert.ok(summary.postsViewed >= 1);
    assert.ok(summary.swipes >= 1, 'expected at least one swipe');
    assert.ok(fake.taps.includes('Like'));
    assert.ok(fake.taps.includes('Save'));
    assert.equal(fake.swipes, summary.swipes);
    // Every flick is a sampled arc, not a two-point drag.
    assert.ok(fake.paths.every((sampled) => sampled.length >= 12));
    assert.deepEqual(fake.launched, ['com.instagram.android']);
    // The point of the test: a warm-up never leaves a phone sitting inside Instagram.
    assert.equal(fake.keys.at(0), 'wake');
    assert.equal(fake.keys.at(-1), 'home');
});

test('an aborted warm-up stops instead of failing, and still presses Home', async () => {
    const controller = new AbortController();
    const fake = fakeDriver([screen({ id: 'com.instagram.android:id/feed_tab', description: 'Home' })]);
    controller.abort();
    const summary = await warmupOnAndroid(fake.driver, {
        durationMinutes: 5, surface: 'both', likeEnabled: false, saveEnabled: false,
        signal: controller.signal, random: () => 0.99,
    });
    assert.equal(summary.reason, 'stopped');
    assert.equal(summary.swipes, 0);
    assert.equal(fake.keys.at(-1), 'home');
});

/* ---- the plugin --------------------------------------------------------- */

interface RunProcessCall { entrypoint: string; args?: string[]; env?: Record<string, string> }

async function executeOn(
    plugin: ReturnType<typeof createInstagramPlugin>, type: string, platform: 'ios' | 'android',
    payload: Record<string, unknown>, workspaceDirectory: string,
): Promise<RunProcessCall> {
    let call: RunProcessCall | undefined;
    const task = plugin.tasks.find((candidate) => candidate.type === type);
    assert.ok(task, `plugin has no ${type} task`);
    const context = {
        executionId: 'exec-1', attempt: 1, workspaceDirectory,
        device: { udid: 'device-1', name: 'phone', platform },
        devicePluginData: {},
        driver: { kind: platform === 'android' ? 'adb' : 'wda' },
        assets: [
            { id: 'asset-1', path: '/tmp/clip.mp4', name: 'clip.mp4', mimeType: 'video/mp4', size: 1, sha256: 'x' },
        ],
        signal: new AbortController().signal,
        log: async () => {},
        runProcess: async (specification: RunProcessCall) => { call = specification; return { exitCode: 0, stopped: false }; },
    } as unknown as TaskExecutionContext;
    await task.execute(context, payload as never);
    assert.ok(call, 'runProcess was not called');
    return call;
}

test('the plugin picks the Android routines for Android phones and the iOS ones for iPhones', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'farm-instagram-'));
    try {
        const plugin = createInstagramPlugin();
        assert.equal(plugin.id, 'com.backline.instagram');

        const warmupPayload = { durationMinutes: 5, surface: 'both', personality: 'casual', likeEnabled: true, saveEnabled: false };
        const androidWarmup = await executeOn(plugin, 'warmup', 'android', warmupPayload, workspace);
        assert.match(androidWarmup.entrypoint, /instagram\/android\/warmup\.ts$/);
        assert.equal(androidWarmup.env?.INSTAGRAM_PACKAGE, 'com.instagram.android');
        assert.equal(androidWarmup.env?.WARMUP_SURFACE, 'both');
        assert.equal(androidWarmup.env?.IOS_UDID, undefined);

        const iosWarmup = await executeOn(plugin, 'warmup', 'ios', warmupPayload, workspace);
        assert.match(iosWarmup.entrypoint, /instagram\/warmup\.ts$/);
        assert.equal(iosWarmup.env?.IOS_UDID, 'device-1');
        assert.equal(iosWarmup.env?.INSTAGRAM_BUNDLE_ID, 'com.burbn.instagram');

        const postPayload = {
            media: [{ assetId: 'asset-1', name: 'clip.mp4', mimeType: 'video/mp4' }],
            format: 'reel', destination: 'draft', account: '@farm.one', caption: 'hi',
        };
        const androidPost = await executeOn(plugin, 'post', 'android', postPayload, workspace);
        assert.match(androidPost.entrypoint, /instagram\/android\/post\.ts$/);
        const written = JSON.parse(await readFile(androidPost.args![0]!, 'utf8')) as InstagramPostManifest;
        assert.equal(written.format, 'reel');
        assert.equal(written.account, '@farm.one');
        assert.equal(written.files[0]!.path, '/tmp/clip.mp4');

        const iosPost = await executeOn(plugin, 'post', 'ios', postPayload, workspace);
        assert.match(iosPost.entrypoint, /instagram\/post\.ts$/);
        assert.equal(iosPost.env?.INSTAGRAM_BUNDLE_ID, 'com.burbn.instagram');
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test('a warm-up with no account and no duration is refused rather than run forever', () => {
    const warmup = createInstagramPlugin().tasks.find(({ type }) => type === 'warmup') as TaskDefinition;
    const validationContext = { timingKind: 'now' as const, devicePluginData: {} };
    assert.throws(
        () => warmup.validate({ surface: 'feed', likeEnabled: true, saveEnabled: false }, validationContext),
        /durationMinutes is required/,
    );
    // Naming an account is what turns the persona on, and a persona picks its own session length.
    const withPersona = warmup.validate(
        { surface: 'feed', likeEnabled: true, saveEnabled: false, account: '@farm.one' }, validationContext,
    );
    assert.equal(withPersona.persona, true);
    assert.equal(withPersona.durationMinutes, undefined);
});

test('a recurring public post needs explicit confirmation, the way TikTok does', () => {
    const post = createInstagramPlugin().tasks.find(({ type }) => type === 'post') as TaskDefinition;
    const payload = {
        media: [{ assetId: 'a', name: 'clip.mp4', mimeType: 'video/mp4' }], format: 'reel', destination: 'publish',
    };
    assert.throws(
        () => post.validate(payload, { timingKind: 'daily', devicePluginData: {} }),
        /Recurring public posts require explicit confirmation/,
    );
    assert.ok(post.validate({ ...payload, recurringPublishConfirmed: true }, { timingKind: 'daily', devicePluginData: {} }));
});
