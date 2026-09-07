import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { DeviceDriver, MediaFile, Point, Rect, TimedPoint, UiNode } from '../src/drivers/types.js';
import { createMotionSource } from '../src/motion/source.js';
import type { YouTubePostManifest } from '../src/youtube/post-manifest.js';
import {
    MAX_TITLE_LENGTH, POST_SELECTORS, galleryCells, postOnAndroid, switchAccount,
} from '../src/youtube/android/post.js';
import { COMMENT_PHRASES, decideComment, warmupOnAndroid } from '../src/youtube/android/warmup.js';
import { createYouTubePlugin } from '../src/youtube-plugin.js';
import { defaultPersona } from '../src/persona/model.js';
import type { VideoDecision } from '../src/persona/decide.js';
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

/** Controls the script marks STAY leave the app on the same screen (picker cells, the title box). */
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

/**
 * A driver whose `uiTree` walks a script of screens: a tap advances to the next one unless the
 * control is marked STAY, which is how a real routine experiences the app. Everything else is
 * recorded. Same fake as the TikTok Android tests, kept here so the two suites cannot drift.
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
        gesture: async (gesturePath: TimedPoint[]) => {
            const first = gesturePath[0]!;
            const last = gesturePath[gesturePath.length - 1]!;
            if (first.x === last.x && first.y === last.y) press(first);
            else { state.swipes += 1; state.paths.push(gesturePath); }
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

/** Seeded so every jittered tap lands in the same pixels each run. */
const FAST = {
    settleMs: 0, pollIntervalMs: 1, screenTimeoutMs: 50, successTimeoutMs: 50,
    get motion() { return createMotionSource({ udid: 'R58N1ABCDE', seed: 'youtube-android-test' }); },
};

const bottom = (left: number, right: number) => ({ left, top: 2200, right, bottom: 2320 });

/**
 * Create → Upload a video → picker → Next → Next → details (title, visibility, audience, finish)
 * → confirmation. The details screen keeps every control on it, so the routine's tolerant steps
 * are exercised in the order a phone would offer them.
 */
function postFlowScreens(confirmation: string): UiNode[] {
    return [
        screen({ text: 'Create', bounds: bottom(480, 600) }),
        screen({ text: 'Upload a video', bounds: { left: 300, top: 1400, right: 800, bottom: 1500 } }),
        screen(
            // Deliberately out of layout order: the routine must sort top-left (newest) first.
            { id: 'com.google.android.youtube:id/thumbnail', type: STAY, text: 'oldest', bounds: { left: 720, top: 300, right: 1070, bottom: 650 } },
            { id: 'com.google.android.youtube:id/thumbnail', type: STAY, text: 'newest', bounds: { left: 10, top: 300, right: 360, bottom: 650 } },
            { text: 'Next', bounds: bottom(800, 1000) },
        ),
        screen({ text: 'Next', bounds: bottom(800, 1000) }),
        screen(
            { id: 'com.google.android.youtube:id/title_edit_text', type: STAY, text: 'Add a title', bounds: { left: 40, top: 200, right: 1040, bottom: 320 } },
            { text: 'Visibility', type: STAY, bounds: { left: 40, top: 700, right: 1040, bottom: 800 } },
            { text: 'Public', type: STAY, bounds: { left: 40, top: 850, right: 1040, bottom: 950 } },
            { text: "No, it's not made for kids", type: STAY, bounds: { left: 40, top: 1100, right: 1040, bottom: 1200 } },
            { text: 'Save draft', bounds: bottom(40, 400) },
            { text: 'Upload Short', bounds: bottom(600, 1040) },
        ),
        screen({ text: confirmation, bounds: { left: 40, top: 1000, right: 1040, bottom: 1100 }, clickable: false }),
    ];
}

const manifest = (overrides: Partial<YouTubePostManifest> = {}): YouTubePostManifest => ({
    device: { udid: 'R58N1ABCDE', name: 'pixel-03', platform: 'android' },
    files: [{ path: '/tmp/clip.mp4', name: 'clip.mp4', mimeType: 'video/mp4' }],
    title: 'first light',
    destination: 'publish',
    ...overrides,
});

test('the Android Shorts routine taps the flow in order, types the title and confirms the upload', async () => {
    const fake = fakeDriver(postFlowScreens('Uploading'));
    await postOnAndroid(fake.driver, manifest(), FAST);

    assert.deepEqual(fake.taps, [
        'Create', 'Upload a video', 'newest', 'Next', 'Next', 'Add a title',
        // Publishing sets Public and answers the audience question before it uploads.
        'Visibility', 'Public', "No, it's not made for kids", 'Upload Short',
    ]);
    assert.deepEqual(fake.launched, ['com.google.android.youtube']);
    assert.deepEqual(fake.pushed, ['clip.mp4']);
    assert.deepEqual(fake.typed, ['first light']);
    // Wake before the app opens, back to close the keyboard, Home at the end.
    assert.deepEqual(fake.keys, ['wake', 'back', 'home']);
});

test('destination draft keeps the clip and waits for the draft confirmation instead', async () => {
    const fake = fakeDriver(postFlowScreens('Draft saved'));
    await postOnAndroid(fake.driver, manifest({ destination: 'draft' }), FAST);

    // A draft never touches the visibility rows; the audience question is still answered.
    assert.deepEqual(fake.taps, [
        'Create', 'Upload a video', 'newest', 'Next', 'Next', 'Add a title',
        "No, it's not made for kids", 'Save draft',
    ]);
    assert.deepEqual(fake.keys, ['wake', 'back', 'home']);
});

test('a details screen with no visibility or audience rows still posts', async () => {
    const screens = postFlowScreens('Uploading');
    screens[4] = screen(
        { id: 'com.google.android.youtube:id/title_edit_text', type: STAY, text: 'Add a title', bounds: { left: 40, top: 200, right: 1040, bottom: 320 } },
        { text: 'Upload Short', bounds: bottom(600, 1040) },
    );
    const fake = fakeDriver(screens);
    await postOnAndroid(fake.driver, manifest(), FAST);
    assert.deepEqual(fake.taps.slice(-2), ['Add a title', 'Upload Short']);
});

test('a missing success indicator fails with a message naming the control and the screen', async () => {
    const screens = postFlowScreens('Uploading');
    screens[screens.length - 1] = screen({ text: 'Something else entirely', clickable: false });
    const fake = fakeDriver(screens);

    await assert.rejects(
        postOnAndroid(fake.driver, manifest(), FAST),
        (error: Error) => /Timed out waiting for the upload confirmation/.test(error.message)
            && /Something else entirely/.test(error.message),
    );
});

test('a control that is nowhere on screen fails with the alternates that were tried', async () => {
    const fake = fakeDriver([screen({ text: 'Subscriptions' })]);
    await assert.rejects(
        postOnAndroid(fake.driver, manifest(), FAST),
        /YouTube control not found: Create .*"Create".*Screen showed: Subscriptions/s,
    );
});

test('an over-long or untypeable title is refused before anything is pushed or opened', async () => {
    const fake = fakeDriver(postFlowScreens('Uploading'));
    await assert.rejects(postOnAndroid(fake.driver, manifest({ title: 'a'.repeat(MAX_TITLE_LENGTH + 1) }), FAST), /at most 100/);
    await assert.rejects(postOnAndroid(fake.driver, manifest({ title: 'summer vibes 🌴' }), FAST), /adb shell input text.*a11y-bridge/s);
    // Nothing was pushed and YouTube was never opened, so there is no half-finished Short.
    assert.deepEqual(fake.pushed, []);
    assert.deepEqual(fake.launched, []);
});

test('a manifest that is not exactly one video is refused', async () => {
    const fake = fakeDriver(postFlowScreens('Uploading'));
    await assert.rejects(postOnAndroid(fake.driver, manifest({ files: [] }), FAST), /exactly one video/);
});

test('channel switching goes avatar → account row → verify', async () => {
    const fake = fakeDriver([
        screen({ id: 'com.google.android.youtube:id/avatar', text: 'Account', bounds: { left: 960, top: 40, right: 1060, bottom: 140 } }),
        // The sheet's header names the channel that is active; the rows below it are the others.
        screen(
            { id: 'com.google.android.youtube:id/account_name', text: '@other.channel', type: 'stay', bounds: { left: 40, top: 200, right: 1040, bottom: 300 }, clickable: false },
            { text: '@farm.one', bounds: { left: 40, top: 1550, right: 1040, bottom: 1650 } },
        ),
        screen({ id: 'com.google.android.youtube:id/avatar', text: 'Account', bounds: { left: 960, top: 40, right: 1060, bottom: 140 } }),
        screen({ id: 'com.google.android.youtube:id/account_name', text: '@farm.one', bounds: { left: 40, top: 200, right: 1040, bottom: 300 }, clickable: false }),
    ]);
    await switchAccount(fake.driver, '@farm.one', FAST);
    assert.deepEqual(fake.taps, ['Account', '@farm.one', 'Account']);
});

test('a channel that never becomes active is reported rather than silently posted from', async () => {
    const fake = fakeDriver([
        screen({ id: 'com.google.android.youtube:id/avatar', text: 'Account' }),
        screen({ id: 'com.google.android.youtube:id/account_name', text: '@other.channel', clickable: false, bounds: { left: 40, top: 200, right: 1040, bottom: 300 } },
            { text: '@farm.one', bounds: { left: 40, top: 1550, right: 1040, bottom: 1650 } }),
        screen({ id: 'com.google.android.youtube:id/avatar', text: 'Account' }),
        screen({ id: 'com.google.android.youtube:id/account_name', text: '@other.channel', clickable: false, bounds: { left: 40, top: 200, right: 1040, bottom: 300 } }),
    ]);
    await assert.rejects(switchAccount(fake.driver, '@farm.one', FAST), /could not confirm YouTube channel "@farm.one"/);
});

test('a channel that is already active is left alone, and a near-miss handle is not mistaken for it', async () => {
    const sheet = (active: string) => screen(
        { id: 'com.google.android.youtube:id/account_name', text: active, clickable: false, bounds: { left: 40, top: 200, right: 1040, bottom: 300 } },
        { text: '@bob', bounds: { left: 40, top: 1550, right: 1040, bottom: 1650 } },
    );
    const already = fakeDriver([
        screen({ id: 'com.google.android.youtube:id/avatar', text: 'Account', bounds: { left: 960, top: 40, right: 1060, bottom: 140 } }),
        sheet('@bob'),
    ]);
    await switchAccount(already.driver, '@bob', FAST);
    // The sheet is opened to read the header, then closed again; no row is ever tapped.
    assert.deepEqual(already.taps, ['Account']);
    assert.deepEqual(already.keys, ['back']);

    // The phone is on @bobby and the run wants @bob: the header must not read as a match.
    const nearMiss = fakeDriver([
        screen({ id: 'com.google.android.youtube:id/avatar', text: 'Account', bounds: { left: 960, top: 40, right: 1060, bottom: 140 } }),
        sheet('@bobby'),
        screen({ id: 'com.google.android.youtube:id/avatar', text: 'Account', bounds: { left: 960, top: 40, right: 1060, bottom: 140 } }),
        sheet('@bob'),
    ]);
    await switchAccount(nearMiss.driver, '@bob', FAST);
    assert.ok(nearMiss.taps.includes('@bob'), `expected the @bob row to be tapped, got ${nearMiss.taps.join(' → ')}`);
});

test('gallery cells are found by resource-id and content-desc, ordered top-left first', () => {
    const root = screen(
        { id: 'x:id/thumbnail', text: 'b', bounds: { left: 400, top: 100, right: 700, bottom: 400 } },
        { id: 'x:id/thumbnail', text: 'a', bounds: { left: 10, top: 100, right: 300, bottom: 400 } },
        { description: 'Video, 12 seconds', text: 'c', bounds: { left: 10, top: 500, right: 300, bottom: 800 } },
        { id: 'x:id/unrelated', text: 'toolbar', bounds: { left: 0, top: 0, right: 1080, bottom: 90 } },
    );
    assert.deepEqual(galleryCells(root).map((cell) => cell.text), ['a', 'b', 'c']);
    assert.ok(POST_SELECTORS.galleryCellIds.includes('thumbnail'));
});

/* ---- warm-up ----------------------------------------------------------- */

function shortsFeed(): UiNode {
    return screen(
        { text: 'Shorts', bounds: { left: 200, top: 2200, right: 340, bottom: 2320 } },
        { id: 'com.google.android.youtube:id/reel_like_button', description: 'Like', bounds: { left: 980, top: 1400, right: 1060, bottom: 1480 } },
        { id: 'com.google.android.youtube:id/reel_subscribe_button', text: 'Subscribe', bounds: { left: 700, top: 1900, right: 900, bottom: 1980 } },
    );
}

test('the warm-up browses the Shorts feed, engages through the tree and ends on Home', async () => {
    const fake = fakeDriver([shortsFeed()]);
    let clock = 0;
    const summary = await warmupOnAndroid(fake.driver, {
        durationMinutes: 1, personality: 'engaged', likeEnabled: true, subscribeEnabled: true, commentEnabled: false,
        // Always engage, and advance the clock a fixed step per call so the run ends.
        random: () => 0,
        now: () => (clock += 2_000),
        seed: 'test-seed',
    });
    assert.equal(summary.reason, 'completed');
    assert.ok(summary.videosViewed >= 1);
    assert.ok(summary.swipes >= 1, 'expected at least one flick');
    assert.ok(fake.taps.includes('Like'));
    assert.equal(fake.swipes, summary.swipes);
    // Every flick is a sampled arc, not a two-point drag.
    assert.ok(fake.paths.every((gesturePath) => gesturePath.length >= 12));
    assert.deepEqual(fake.launched, ['com.google.android.youtube']);
    // The run always leaves the phone on its home screen.
    assert.equal(fake.keys.at(-1), 'home');
    assert.equal(fake.keys[0], 'wake');
});

test('a warm-up that is stopped before it starts still presses Home', async () => {
    const controller = new AbortController();
    const fake = fakeDriver([shortsFeed()]);
    controller.abort();
    const summary = await warmupOnAndroid(fake.driver, {
        durationMinutes: 5, personality: 'casual', likeEnabled: false, subscribeEnabled: false, commentEnabled: false,
        signal: controller.signal, random: () => 0.99,
    });
    assert.equal(summary.reason, 'stopped');
    assert.equal(summary.swipes, 0);
    assert.equal(fake.keys.at(-1), 'home');
});

test('a persona warm-up likes and subscribes through the persona layer', async () => {
    const persona = defaultPersona('@farm.one');
    const fake = fakeDriver([shortsFeed()]);
    let clock = 0;
    const summary = await warmupOnAndroid(fake.driver, {
        durationMinutes: 1, personality: 'casual', likeEnabled: true, subscribeEnabled: true, commentEnabled: false,
        persona, random: () => 0, now: () => (clock += 2_000), seed: 'persona-seed',
    });
    assert.equal(summary.reason, 'completed');
    assert.ok(summary.videosViewed >= 1);
    // Every draw is 0, so the persona takes every option its budget allows.
    assert.ok(summary.likes >= 1, 'expected the persona to like something');
});

test('commenting is budgeted, only ever on a match, and never says the same thing twice in a row', () => {
    const persona = defaultPersona('@farm.one');
    const matched = { matched: true, like: true } as VideoDecision;
    const unmatched = { matched: false, like: false } as VideoDecision;

    assert.equal(decideComment(persona, unmatched, 0, 3, 0, 0).comment, false);
    assert.equal(decideComment(persona, matched, 3, 3, 0, 0).comment, false, 'a spent budget says nothing');
    const said = decideComment(persona, matched, 0, 3, 0, 0);
    assert.equal(said.comment, true);
    assert.ok(COMMENT_PHRASES.includes(said.text));
    // A draw at the top of the range never comments, whatever the video was.
    assert.equal(decideComment(persona, matched, 0, 3, 0.99, 0).comment, false);
    // The phrase is picked from the pool by the second draw, not the first.
    assert.notEqual(decideComment(persona, matched, 0, 3, 0, 0.99).text, said.text);
});

/* ---- the plugin -------------------------------------------------------- */

function taskOf(plugin: ReturnType<typeof createYouTubePlugin>, type: string): TaskDefinition {
    const task = plugin.tasks.find((candidate) => candidate.type === type);
    assert.ok(task, `plugin has no ${type} task`);
    return task;
}

interface RunProcessCall { entrypoint: string; args?: string[]; env?: Record<string, string> }

async function executeOn(
    plugin: ReturnType<typeof createYouTubePlugin>, type: string, platform: 'ios' | 'android',
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

function validate(type: string, payload: unknown, timingKind: 'now' | 'daily' = 'now'): unknown {
    return taskOf(createYouTubePlugin(), type).validate(payload as never, { timingKind, devicePluginData: {} });
}

test('the post task validates one video, a title within the limit, and a channel', () => {
    const media = [{ assetId: 'a', name: 'clip.mp4', mimeType: 'video/mp4' }];
    assert.deepEqual(validate('post', { media, title: ' first light ', destination: 'draft', account: '@farm.one' }), {
        media, title: 'first light', destination: 'draft', account: '@farm.one',
    });
    assert.throws(() => validate('post', { media: [], title: 'x', destination: 'draft', account: '@a' }), /exactly one video/);
    assert.throws(() => validate('post', { media: [...media, ...media], title: 'x', destination: 'draft', account: '@a' }), /exactly one video/);
    assert.throws(() => validate('post', {
        media: [{ assetId: 'a', name: 'a.jpg', mimeType: 'image/jpeg' }], title: 'x', destination: 'draft', account: '@a',
    }), /must be a video/);
    assert.throws(() => validate('post', { media, title: '', destination: 'draft', account: '@a' }), /needs a title/);
    assert.throws(() => validate('post', { media, title: 'a'.repeat(101), destination: 'draft', account: '@a' }), /100 characters or fewer/);
    assert.throws(() => validate('post', { media, title: 'x', destination: 'somewhere', account: '@a' }), /Invalid post destination/);
    assert.throws(() => validate('post', { media, title: 'x', destination: 'draft', account: ' ' }), /Choose a YouTube channel/);
    // A repeating public post is the one that keeps going out; it has to be asked for.
    assert.throws(() => validate('post', { media, title: 'x', destination: 'publish', account: '@a' }, 'daily'), /explicit confirmation/);
});

test('the warm-up task defaults its switches and needs a duration without a persona', () => {
    assert.deepEqual(validate('warmup', { durationMinutes: 10 }), {
        personality: 'casual', persona: false, likeEnabled: true, subscribeEnabled: true, commentEnabled: false,
        durationMinutes: 10,
    });
    // An account means a persona, and a persona picks its own session length.
    assert.deepEqual(validate('warmup', { account: '@farm.one' }), {
        personality: 'casual', persona: true, likeEnabled: true, subscribeEnabled: true, commentEnabled: false,
        account: '@farm.one',
    });
    assert.throws(() => validate('warmup', {}), /durationMinutes is required/);
    assert.throws(() => validate('warmup', { persona: true }), /needs an account/);
    assert.throws(() => validate('warmup', { durationMinutes: 999 }), /between 1 and 180/);
    assert.throws(() => validate('warmup', { durationMinutes: 5, personality: 'frantic' }), /Invalid personality/);
});

test('the plugin picks the Android entrypoints for Android devices and the iOS ones otherwise', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'farm-youtube-'));
    try {
        const plugin = createYouTubePlugin();
        const warmup = { durationMinutes: 5, personality: 'casual', likeEnabled: true, subscribeEnabled: false, commentEnabled: false };

        const android = await executeOn(plugin, 'warmup', 'android', warmup, workspace);
        assert.match(android.entrypoint, /youtube\/android\/warmup\.ts$/);
        assert.equal(android.env?.YOUTUBE_PACKAGE, 'com.google.android.youtube');
        assert.equal(android.env?.IOS_UDID, undefined);
        assert.equal(android.env?.YOUTUBE_SUBSCRIBE_ENABLED, 'false');

        const ios = await executeOn(plugin, 'warmup', 'ios', warmup, workspace);
        assert.match(ios.entrypoint, /youtube\/warmup\.ts$/);
        assert.equal(ios.env?.IOS_UDID, 'device-1');
        assert.equal(ios.env?.YOUTUBE_BUNDLE_ID, 'com.google.ios.youtube');

        const postPayload = {
            media: [{ assetId: 'asset-1', name: 'clip.mp4', mimeType: 'video/mp4' }],
            title: 'first light', destination: 'draft', account: '@farm.one', caption: 'hi',
        };
        const androidPost = await executeOn(plugin, 'post', 'android', postPayload, workspace);
        assert.match(androidPost.entrypoint, /youtube\/android\/post\.ts$/);
        const written = JSON.parse(await readFile(androidPost.args![0]!, 'utf8')) as YouTubePostManifest;
        assert.equal(written.title, 'first light');
        assert.equal(written.account, '@farm.one');
        assert.equal(written.files[0]!.path, '/tmp/clip.mp4');

        const iosPost = await executeOn(plugin, 'post', 'ios', postPayload, workspace);
        assert.match(iosPost.entrypoint, /youtube\/post\.ts$/);
        assert.equal(iosPost.env?.YOUTUBE_BUNDLE_ID, 'com.google.ios.youtube');
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test('configured entrypoints override the built-in ones', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'farm-youtube-'));
    try {
        const plugin = createYouTubePlugin({ androidWarmupEntrypoint: '/example/android-warmup.js' });
        const call = await executeOn(plugin, 'warmup', 'android',
            { durationMinutes: 5, personality: 'casual', likeEnabled: false, subscribeEnabled: false, commentEnabled: false }, workspace);
        assert.equal(call.entrypoint, '/example/android-warmup.js');
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
