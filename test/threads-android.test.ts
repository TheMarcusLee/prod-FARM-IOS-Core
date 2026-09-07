import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { DeviceDriver, MediaFile, Point, Rect, TimedPoint, UiNode } from '../src/drivers/types.js';
import { createMotionSource } from '../src/motion/source.js';
import type { ThreadsPostManifest } from '../src/threads/post-manifest.js';
import { MAX_THREAD_LENGTH, threadFormat } from '../src/threads/post-manifest.js';
import {
    POST_SELECTORS, assertTextIsTypeable, galleryCells, postOnAndroid, switchAccount,
} from '../src/threads/android/post.js';
import { warmupOnAndroid } from '../src/threads/android/warmup.js';
import { createThreadsPlugin } from '../src/threads-plugin.js';
import { defaultPersona } from '../src/persona/model.js';
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

/** Controls the script marks STAY leave the app on the same screen (picker cells, the composer). */
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
 * recorded. The same fake the TikTok Android tests use, pointed at Threads' screens.
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

/** Every tap is jittered out of a seeded motion source, so the taps land in the same pixels. */
const FAST = {
    settleMs: 0, pollIntervalMs: 1, screenTimeoutMs: 50, successTimeoutMs: 50,
    get motion() { return createMotionSource({ udid: 'R58N1ABCDE', seed: 'threads-android-test' }); },
};

/** Compose → composer (text) → publish → confirmation. */
function textPostScreens(confirmation: string): UiNode[] {
    return [
        screen({ text: 'Create', bounds: { left: 700, top: 2200, right: 820, bottom: 2320 } }),
        screen(
            { id: 'com.instagram.barcelona:id/text_post_composer_edit_text', type: STAY, text: "What's new?", bounds: { left: 40, top: 200, right: 1040, bottom: 400 } },
            { text: 'Post', bounds: { left: 800, top: 2200, right: 1040, bottom: 2300 } },
        ),
        screen({ text: confirmation, bounds: { left: 40, top: 1000, right: 1040, bottom: 1100 }, clickable: false }),
    ];
}

/** Compose → composer → picker (cells + Add) → publish → confirmation. */
function mediaPostScreens(confirmation: string): UiNode[] {
    return [
        screen({ text: 'Create', bounds: { left: 700, top: 2200, right: 820, bottom: 2320 } }),
        screen(
            { id: 'com.instagram.barcelona:id/text_post_composer_edit_text', type: STAY, text: "What's new?", bounds: { left: 40, top: 200, right: 1040, bottom: 400 } },
            { id: 'com.instagram.barcelona:id/composer_attach_media', description: 'Add photos', bounds: { left: 40, top: 500, right: 200, bottom: 640 } },
        ),
        screen(
            // Deliberately out of layout order: the routine must sort top-left (newest) first.
            { id: 'com.instagram.barcelona:id/gallery_grid_item', type: STAY, text: 'oldest', bounds: { left: 720, top: 300, right: 1070, bottom: 650 } },
            { id: 'com.instagram.barcelona:id/gallery_grid_item', type: STAY, text: 'newest', bounds: { left: 10, top: 300, right: 360, bottom: 650 } },
            { id: 'com.instagram.barcelona:id/gallery_grid_item', type: STAY, text: 'middle', bounds: { left: 365, top: 300, right: 715, bottom: 650 } },
            { text: 'Add', bounds: { left: 800, top: 2200, right: 1000, bottom: 2300 } },
        ),
        screen(
            { id: 'com.instagram.barcelona:id/text_post_composer_edit_text', text: 'a caption', bounds: { left: 40, top: 200, right: 1040, bottom: 400 } },
            { text: 'Post', bounds: { left: 800, top: 2200, right: 1040, bottom: 2300 } },
        ),
        screen({ text: confirmation, bounds: { left: 40, top: 1000, right: 1040, bottom: 1100 }, clickable: false }),
    ];
}

const manifest = (overrides: Partial<ThreadsPostManifest> = {}): ThreadsPostManifest => ({
    device: { udid: 'R58N1ABCDE', name: 'pixel-03', platform: 'android' },
    files: [],
    text: 'morning from the workshop',
    destination: 'publish',
    ...overrides,
});

/* ---- the post routine -------------------------------------------------- */

test('a text-only thread opens the composer, types the body and confirms — no media is pushed', async () => {
    const fake = fakeDriver(textPostScreens('Posted'));
    await postOnAndroid(fake.driver, manifest(), FAST);

    assert.deepEqual(fake.taps, ['Create', "What's new?", 'Post']);
    assert.deepEqual(fake.launched, ['com.instagram.barcelona']);
    assert.deepEqual(fake.pushed, [], 'a text thread has nothing to push');
    assert.deepEqual(fake.typed, ['morning from the workshop']);
    // Wake before the app, back to dismiss the keyboard, Home at the end.
    assert.deepEqual(fake.keys, ['wake', 'back', 'home']);
});

test('a carousel pushes newest-last and taps its cells top-left first, so file 1 is card 1', async () => {
    const fake = fakeDriver(mediaPostScreens('Posted'));
    await postOnAndroid(fake.driver, manifest({
        text: 'a caption',
        files: [
            { path: '/tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' },
            { path: '/tmp/b.jpg', name: 'b.jpg', mimeType: 'image/jpeg' },
            { path: '/tmp/c.jpg', name: 'c.jpg', mimeType: 'image/jpeg' },
        ],
    }), FAST);

    // Reverse push order makes manifest file 1 the newest item in the gallery…
    assert.deepEqual(fake.pushed, ['c.jpg', 'b.jpg', 'a.jpg']);
    // …and the cells are tapped in layout order, which is that same order back again.
    assert.deepEqual(fake.taps, ['Create', "What's new?", 'Add photos', 'newest', 'middle', 'oldest', 'Add', 'Post']);
});

test('a thread that mixes images and a video is refused before anything is pushed or opened', async () => {
    const fake = fakeDriver(mediaPostScreens('Posted'));
    await assert.rejects(
        postOnAndroid(fake.driver, manifest({
            files: [
                { path: '/tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' },
                { path: '/tmp/clip.mp4', name: 'clip.mp4', mimeType: 'video/mp4' },
            ],
        }), FAST),
        /images or one video, not both/,
    );
    assert.deepEqual(fake.pushed, []);
    assert.deepEqual(fake.launched, []);
});

test('destination draft leaves the composer and takes the "keep it?" sheet', async () => {
    const screens = textPostScreens('Draft saved');
    screens[1] = screen(
        { id: 'com.instagram.barcelona:id/text_post_composer_edit_text', type: STAY, text: "What's new?", bounds: { left: 40, top: 200, right: 1040, bottom: 400 } },
        { text: 'Save draft', bounds: { left: 40, top: 2200, right: 500, bottom: 2300 } },
    );
    const fake = fakeDriver(screens);
    await postOnAndroid(fake.driver, manifest({ destination: 'draft' }), FAST);
    assert.deepEqual(fake.taps, ['Create', "What's new?", 'Save draft']);
});

test('a control the selector table no longer matches reports what was on screen', async () => {
    const fake = fakeDriver([screen({ text: 'For you' }, { text: 'Following' })]);
    await assert.rejects(
        postOnAndroid(fake.driver, manifest(), FAST),
        /Threads control not found: Compose .*Screen showed: For you, Following/s,
    );
});

test('a missing confirmation fails with a message naming the control and the screen', async () => {
    const screens = textPostScreens('Posted');
    screens[screens.length - 1] = screen({ text: 'Something else entirely', clickable: false });
    await assert.rejects(
        postOnAndroid(fakeDriver(screens).driver, manifest(), FAST),
        (error: Error) => /Timed out waiting for the post confirmation/.test(error.message)
            && /Something else entirely/.test(error.message),
    );
});

test('account switching goes profile tab → switcher → account row → verify', async () => {
    const fake = fakeDriver([
        screen({ text: 'Profile', bounds: { left: 900, top: 2200, right: 1040, bottom: 2320 } }),
        screen({ id: 'com.instagram.barcelona:id/account_switcher', text: '@other.account', bounds: { left: 300, top: 100, right: 780, bottom: 200 } }),
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

test('gallery cells are found by resource-id and ordered top-left first', () => {
    const root = screen(
        { id: 'x:id/gallery_grid_item', text: 'b', bounds: { left: 400, top: 100, right: 700, bottom: 400 } },
        { id: 'x:id/gallery_grid_item', text: 'a', bounds: { left: 10, top: 100, right: 300, bottom: 400 } },
        { description: 'Photo, 2 May', text: 'c', bounds: { left: 10, top: 500, right: 300, bottom: 800 } },
        { id: 'x:id/unrelated', text: 'toolbar', bounds: { left: 0, top: 0, right: 1080, bottom: 90 } },
    );
    assert.deepEqual(galleryCells(root).map((cell) => cell.text), ['a', 'b', 'c']);
    assert.ok(POST_SELECTORS.galleryCellIds.includes('gallery_grid_item'));
});

test('non-ASCII text is refused on adb and accepted on the bridge, which types UTF-8', () => {
    const fake = fakeDriver(textPostScreens('Posted'));
    assert.throws(
        () => assertTextIsTypeable(fake.driver, 'summer vibes 🌴'),
        /adb shell input text.*cannot type.*a11y-bridge/s,
    );
    assert.doesNotThrow(() => assertTextIsTypeable({ ...fake.driver, kind: 'a11y-bridge' }, 'summer vibes 🌴'));
    assert.throws(() => assertTextIsTypeable(fake.driver, 'a'.repeat(MAX_THREAD_LENGTH + 1)), /at most 500/);
});

test('threadFormat names the four shapes a thread comes in', () => {
    const image = { name: 'a.jpg', mimeType: 'image/jpeg' };
    const video = { name: 'a.mp4', mimeType: 'video/mp4' };
    assert.equal(threadFormat([], 'hello'), 'text');
    assert.equal(threadFormat([image]), 'photo');
    assert.equal(threadFormat([image, image]), 'carousel');
    assert.equal(threadFormat([video]), 'video');
    assert.throws(() => threadFormat([video, video]), /at most one video/);
    assert.throws(() => threadFormat(Array.from({ length: 21 }, () => image)), /at most 20 images/);
    assert.throws(() => threadFormat([]), /needs text/);
});

/* ---- the warm-up ------------------------------------------------------- */

test('the warm-up browses the feed, engages through the tree and ends by pressing Home', async () => {
    const feed = screen(
        { id: 'com.instagram.barcelona:id/feed_tab', type: STAY, description: 'Home', bounds: { left: 20, top: 2240, right: 140, bottom: 2320 } },
        { type: STAY, text: '@homegym.dan', clickable: false, bounds: { left: 40, top: 900, right: 600, bottom: 980 } },
        { type: STAY, text: 'rack pulls again #homegym', clickable: false, bounds: { left: 40, top: 1000, right: 1040, bottom: 1120 } },
        { id: 'com.instagram.barcelona:id/row_feed_button_like', type: STAY, description: 'Like', bounds: { left: 60, top: 1400, right: 160, bottom: 1480 } },
        { id: 'com.instagram.barcelona:id/row_feed_button_repost', type: STAY, description: 'Repost', bounds: { left: 260, top: 1400, right: 360, bottom: 1480 } },
    );
    const fake = fakeDriver([feed]);
    // A persona with something to spend: `random: () => 0` draws the bottom of every range, so a
    // default persona would open the session with a budget of zero reposts.
    const persona = {
        ...defaultPersona('@homegym.dan'),
        interests: ['homegym'],
        budgets: {
            likes: { min: 5, max: 5 }, saves: { min: 5, max: 5 },
            follows: { min: 0, max: 0 }, searches: { min: 0, max: 0 },
        },
        activeHours: [{ start: 0, end: 24 }],
    };
    let clock = 0;
    const summary = await warmupOnAndroid(fake.driver, {
        durationMinutes: 1, likeEnabled: true, repostEnabled: true, searchEnabled: false,
        persona,
        // Always engage, and advance the clock a fixed step per call so the run ends.
        random: () => 0,
        now: () => (clock += 2_000),
        seed: 'test-seed',
    });

    assert.equal(summary.reason, 'completed');
    assert.ok(summary.postsViewed >= 1);
    assert.ok(summary.swipes >= 1, 'expected at least one flick');
    assert.equal(fake.swipes, summary.swipes);
    assert.ok(fake.taps.includes('Like'));
    assert.ok(fake.taps.includes('Repost'), 'the persona’s "keep this" signal is spent on a repost');
    assert.deepEqual(fake.launched, ['com.instagram.barcelona']);
    // Every flick is a sampled arc, not a two-point drag.
    assert.ok(fake.paths.every((path) => path.length >= 12));
    // The run always leaves the phone on the home screen.
    assert.equal(fake.keys.at(0), 'wake');
    assert.equal(fake.keys.at(-1), 'home');
});

test('an aborted warm-up stops instead of failing, and still presses Home', async () => {
    const controller = new AbortController();
    const fake = fakeDriver([screen({ text: 'For you' })]);
    controller.abort();
    const summary = await warmupOnAndroid(fake.driver, {
        durationMinutes: 5, likeEnabled: false, repostEnabled: false,
        signal: controller.signal, random: () => 0.99,
    });
    assert.equal(summary.reason, 'stopped');
    assert.equal(summary.swipes, 0);
    assert.equal(fake.keys.at(-1), 'home');
});

/* ---- the plugin -------------------------------------------------------- */

function taskOf(plugin: ReturnType<typeof createThreadsPlugin>, type: string): TaskDefinition {
    const task = plugin.tasks.find((candidate) => candidate.type === type);
    assert.ok(task, `plugin has no ${type} task`);
    return task;
}

interface RunProcessCall { entrypoint: string; args?: string[]; env?: Record<string, string> }

async function executeOn(
    plugin: ReturnType<typeof createThreadsPlugin>, type: string, platform: 'ios' | 'android',
    payload: Record<string, unknown>, workspaceDirectory: string,
): Promise<RunProcessCall> {
    let call: RunProcessCall | undefined;
    const context = {
        executionId: 'exec-1', attempt: 1, workspaceDirectory,
        device: { udid: 'device-1', name: 'phone', platform },
        devicePluginData: {},
        driver: { kind: platform === 'android' ? 'adb' : 'wda' },
        assets: [
            { id: 'asset-1', path: '/tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', size: 1, sha256: 'x' },
            { id: 'asset-2', path: '/tmp/b.jpg', name: 'b.jpg', mimeType: 'image/jpeg', size: 1, sha256: 'y' },
        ],
        signal: new AbortController().signal,
        log: async () => {},
        runProcess: async (specification: RunProcessCall) => { call = specification; return { exitCode: 0, stopped: false }; },
    } as unknown as TaskExecutionContext;
    await taskOf(plugin, type).execute(context, payload as never);
    assert.ok(call, 'runProcess was not called');
    return call;
}

test('the plugin picks the Android routine on Android and the WDA one on iOS', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'farm-threads-'));
    try {
        const plugin = createThreadsPlugin();
        assert.equal(plugin.id, 'com.backline.threads');

        const warmup = { durationMinutes: 10, likeEnabled: true, repostEnabled: false, account: '@farm.one', persona: true };
        const android = await executeOn(plugin, 'warmup', 'android', warmup, workspace);
        assert.match(android.entrypoint, /threads\/android\/warmup\.ts$/);
        assert.equal(android.env?.THREADS_PACKAGE, 'com.instagram.barcelona');
        assert.equal(android.env?.IOS_UDID, undefined);
        assert.equal(android.env?.THREADS_SWITCH_ACCOUNT, '@farm.one');
        assert.equal(android.env?.WARMUP_PERSONA, 'true');

        const ios = await executeOn(plugin, 'warmup', 'ios', warmup, workspace);
        assert.match(ios.entrypoint, /threads\/warmup\.ts$/);
        assert.equal(ios.env?.IOS_UDID, 'device-1');
        assert.equal(ios.env?.THREADS_BUNDLE_ID, 'com.burbn.barcelona');

        const post = {
            media: [
                { assetId: 'asset-1', name: 'a.jpg', mimeType: 'image/jpeg' },
                { assetId: 'asset-2', name: 'b.jpg', mimeType: 'image/jpeg' },
            ],
            destination: 'draft', account: '@farm.one', text: 'hi',
        };
        const androidPost = await executeOn(plugin, 'post', 'android', post, workspace);
        assert.match(androidPost.entrypoint, /threads\/android\/post\.ts$/);
        const written = JSON.parse(await readFile(androidPost.args![0]!, 'utf8')) as ThreadsPostManifest;
        assert.equal(written.account, '@farm.one');
        assert.equal(written.text, 'hi');
        // Manifest order is carousel order.
        assert.deepEqual(written.files.map(({ name }) => name), ['a.jpg', 'b.jpg']);

        const iosPost = await executeOn(plugin, 'post', 'ios', post, workspace);
        assert.match(iosPost.entrypoint, /threads\/post\.ts$/);
        assert.equal(iosPost.env?.THREADS_BUNDLE_ID, 'com.burbn.barcelona');
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test('the post task refuses what Threads will not accept', () => {
    const post = taskOf(createThreadsPlugin(), 'post');
    const validate = (payload: Record<string, unknown>) =>
        post.validate(payload as never, { timingKind: 'now', devicePluginData: {} });
    const image = { assetId: 'a', name: 'a.jpg', mimeType: 'image/jpeg' };
    const video = { assetId: 'v', name: 'v.mp4', mimeType: 'video/mp4' };

    assert.doesNotThrow(() => validate({ media: [], destination: 'draft', account: '@a', text: 'hello' }));
    assert.doesNotThrow(() => validate({ media: [image], destination: 'publish', account: '@a' }));
    assert.throws(() => validate({ media: [image, video], destination: 'draft', account: '@a' }), /not both/);
    assert.throws(() => validate({ media: [video, video], destination: 'draft', account: '@a' }), /at most one video/);
    assert.throws(
        () => validate({ media: Array.from({ length: 21 }, () => image), destination: 'draft', account: '@a' }),
        /at most 20 images/,
    );
    assert.throws(() => validate({ media: [], destination: 'draft', account: '@a' }), /needs text, media, or both/);
    assert.throws(
        () => validate({ media: [], destination: 'draft', account: '@a', text: 'a'.repeat(501) }),
        /500 characters or fewer/,
    );
    assert.throws(() => validate({ media: [image], destination: 'draft', account: '  ' }), /Choose a Threads account/);
});

test('the warm-up task needs either a duration or a persona to browse as', () => {
    const warmup = taskOf(createThreadsPlugin(), 'warmup');
    const validate = (payload: Record<string, unknown>) =>
        warmup.validate(payload as never, { timingKind: 'now', devicePluginData: {} });

    assert.deepEqual(
        validate({ durationMinutes: 12, likeEnabled: true, repostEnabled: false }),
        { likeEnabled: true, repostEnabled: false, persona: false, durationMinutes: 12 },
    );
    // Naming an account turns the persona on, and a persona may pick its own session length.
    assert.deepEqual(
        validate({ likeEnabled: true, repostEnabled: true, account: '@farm.one' }),
        { likeEnabled: true, repostEnabled: true, persona: true, account: '@farm.one' },
    );
    assert.throws(() => validate({ likeEnabled: true, repostEnabled: false }), /durationMinutes is required/);
    assert.throws(() => validate({ likeEnabled: true, repostEnabled: false, persona: true }), /needs an account/);
    assert.throws(() => validate({ durationMinutes: 999, likeEnabled: true, repostEnabled: false }), /between 1 and 180/);
});
