import { readFile } from 'node:fs/promises';
import { resolveTable } from '../../drivers/selector-overrides.js';
import { THREADS_PLUGIN_ID } from '../../plugin-ids.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findByText, walk, type Recognize } from '../../drivers/verify.js';
import { DriverError, type DeviceDriver, type UiNode } from '../../drivers/types.js';
import { driverFromEnv } from '../../tiktok/android/driver-from-env.js';
import type { MotionSource } from '../../motion/source.js';
import {
    MAX_THREAD_LENGTH, threadFormat, type ThreadsPostManifest,
} from '../post-manifest.js';
import {
    humanTapAt, isPresent, recognizeOnDevice, screenSummary, tapFirst, tapIfPresent, waitForAny,
    type SelectorList, type TapOptions,
} from './ui.js';

/** Threads ships under Instagram's "Barcelona" codename on both stores. */
export const THREADS_ANDROID_PACKAGE = 'com.instagram.barcelona';

export { MAX_THREAD_LENGTH };

/**
 * Every on-screen control this routine touches, in one table.
 *
 * Threads' Android labels and resource-ids move between builds, regions and A/B buckets, and the
 * exact strings are not knowable without a phone in hand. Each entry is therefore a list of
 * alternates tried in order — correct the list here (and in docs/threads.md) rather than editing
 * the flow below. Entries marked GUESS have not been confirmed against a real device.
 */
export const POST_SELECTORS = {
    /** Bottom navigation. Content-desc is what TalkBack reads out, so it is the most stable handle. */
    profileTab: [
        { id: 'profile_tab' }, { id: 'tab_avatar' }, { text: 'Profile', exact: true }, { text: 'Your profile' },
    ] as SelectorList,
    /** The handle / chevron in the profile header that opens the account list. GUESS. */
    accountSwitcher: [
        { id: 'action_bar_textview_title' }, { id: 'account_switcher' }, { id: 'username' },
        { text: 'Switch account' }, { text: 'Switch accounts' },
    ] as SelectorList,
    /** The compose pencil in the bottom navigation. GUESS. */
    compose: [
        { id: 'compose_tab' }, { id: 'creation_tab' }, { id: 'tab_composer' },
        { text: 'Create', exact: true }, { text: 'Compose', exact: true }, { text: 'New thread' },
    ] as SelectorList,
    /** The text box inside the composer. GUESS. */
    composerField: [
        { id: 'text_post_composer_edit_text' }, { id: 'composer_edit_text' }, { id: 'edit_text' },
        { text: "What's new?" }, { text: 'Start a thread' }, { text: 'What’s new?' },
    ] as SelectorList,
    /** The image / paperclip button inside the composer that opens the picker. GUESS. */
    attach: [
        { id: 'composer_attach_media' }, { id: 'gallery_button' }, { id: 'media_button' },
        { text: 'Add photos', exact: false }, { text: 'Attach media' }, { text: 'Photo', exact: true },
    ] as SelectorList,
    /** Threads' picker confirms with "Add"; some builds label it "Done" or "Next". GUESS. */
    pickerConfirm: [
        { id: 'gallery_done_button' }, { id: 'next_button_textview' }, { id: 'btn_next' },
        { text: 'Add', exact: true }, { text: 'Done', exact: true }, { text: 'Next', exact: true },
    ] as SelectorList,
    /** Publish. */
    post: [{ id: 'share_button' }, { id: 'post_button' }, { text: 'Post', exact: true }] as SelectorList,
    /** Threads has no Drafts button: leaving the composer offers to keep the draft. GUESS. */
    saveDraft: [
        { id: 'save_draft_button' }, { text: 'Save draft' }, { text: 'Save as draft' }, { text: 'Save', exact: true },
    ] as SelectorList,
    /** What the app shows once the thread has been accepted. GUESS. */
    publishSuccess: [
        { text: 'Posted' }, { text: 'Your thread was posted' }, { text: 'Thread posted' }, { text: 'Posting' },
    ] as SelectorList,
    /** What the app shows after the draft is kept. GUESS. */
    draftSuccess: [{ text: 'Draft saved' }, { text: 'Saved to drafts' }, { text: 'Drafts' }] as SelectorList,
    /**
     * Sheets Threads throws up on a cold start — the picker's permission prompt, the "turn on
     * notifications" card, the activity-status nudge. Tapping any of them is optional by design.
     * GUESS.
     */
    dismissable: [
        { text: 'Not now' }, { text: 'Allow', exact: true }, { text: 'Continue', exact: true },
        { text: 'Skip', exact: true }, { text: 'Maybe later' },
    ] as SelectorList,
    /**
     * Picker thumbnails carry no text. These are the resource-id fragments and content-desc
     * substrings Threads' gallery cells have been seen with; matching nodes are ordered top-left
     * first, which is newest first in the Recents album. GUESS.
     */
    galleryCellIds: ['gallery_grid_item', 'media_thumbnail', 'image_view', 'iv_image', 'thumbnail'] as readonly string[],
    galleryCellDescriptions: ['photo', 'image', 'video'] as readonly string[],
} as const;

/**
 * What the flow below actually reads.
 *
 * It starts as the built-in guesses and is replaced, once per run, by the same table with any
 * confirmed overrides for this phone in front (src/drivers/selector-overrides.ts). A selector an
 * operator or the calibration agent has verified against a real device therefore wins without
 * anybody editing this file, and an override that has itself gone stale still falls through to
 * the alternates below it.
 */
let selectors: typeof POST_SELECTORS = POST_SELECTORS;

export interface PostOnAndroidOptions {
    /** Android package; overridden with THREADS_PACKAGE from the environment. */
    packageName?: string;
    /** OCR fallback for screens Threads draws without accessibility nodes. */
    recognize?: Recognize;
    signal?: AbortSignal;
    /** Settle time after a tap before the next tree read. Tests pass 0. */
    settleMs?: number;
    /** How long to wait for the post/draft confirmation. */
    successTimeoutMs?: number;
    /** Tree poll interval for the waits. */
    pollIntervalMs?: number;
    /** How long to wait for a screen to appear before giving up on it. */
    screenTimeoutMs?: number;
    /**
     * The run's hand: every tap is jittered and held out of this one seeded stream. Absent falls
     * back to a source seeded from the udid, which still jitters.
     */
    motion?: MotionSource;
}

/** What a tap needs out of the routine's options: where to look, and whose hand is doing it. */
function tapping(options: PostOnAndroidOptions): TapOptions {
    return {
        ...(options.recognize ? { recognize: options.recognize } : {}),
        ...(options.motion ? { motion: options.motion } : {}),
    };
}

interface Timing {
    settleMs: number;
    successTimeoutMs: number;
    pollIntervalMs: number;
    screenTimeoutMs: number;
    signal?: AbortSignal;
}

function timingOf(options: PostOnAndroidOptions): Timing {
    return {
        settleMs: options.settleMs ?? 2_000,
        successTimeoutMs: options.successTimeoutMs ?? 180_000,
        pollIntervalMs: options.pollIntervalMs ?? 1_000,
        screenTimeoutMs: options.screenTimeoutMs ?? 30_000,
        ...(options.signal ? { signal: options.signal } : {}),
    };
}

/**
 * The adb driver cannot type anything outside printable ASCII, and finding that out after the
 * media is pushed and the composer is open leaves a half-finished draft on the phone. Check first.
 *
 * This is the same check `src/tiktok/android/post.ts` makes, against Threads' own 500-character
 * limit — a thread body is far more likely than a TikTok caption to be pure text, so the failure
 * has to arrive before anything is touched.
 */
export function assertTextIsTypeable(driver: DeviceDriver, text: string): void {
    if (text.length > MAX_THREAD_LENGTH) {
        throw new DriverError(`Thread text is ${text.length} characters; Threads accepts at most ${MAX_THREAD_LENGTH}`);
    }
    if (driver.kind !== 'adb') return;
    const offending = [...text].find((character) => {
        const code = character.codePointAt(0)!;
        return code < 0x20 || code > 0x7e;
    });
    if (offending === undefined) return;
    throw new DriverError(
        `The thread text contains ${JSON.stringify(offending)}, which "adb shell input text" cannot type. `
        + 'Switch this device to the a11y-bridge driver, or use ASCII-only text.',
    );
}

/** Picker cells, ordered the way they are laid out: top-left (newest) first. */
export function galleryCells(root: UiNode): UiNode[] {
    const matches = [...walk(root)].filter((node) => {
        const byId = selectors.galleryCellIds.some((id) => node.id === id || node.id.endsWith(`:id/${id}`));
        const description = node.description.toLowerCase();
        const byDescription = description.length > 0
            && selectors.galleryCellDescriptions.some((word) => description.includes(word));
        return byId || byDescription;
    });
    const seen = new Set<string>();
    return matches
        .filter(({ bounds }) => bounds.right > bounds.left && bounds.bottom > bounds.top)
        // A cell whose container and image both match the table is still one cell.
        .filter(({ bounds }) => {
            const key = `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
}

/** Media lands in DCIM/Camera newest-last-pushed, so push in reverse to make file 1 the newest cell. */
async function pushAllMedia(driver: DeviceDriver, manifest: ThreadsPostManifest): Promise<void> {
    if (!manifest.files.length) return;
    const files = [...manifest.files].reverse();
    for (const [index, file] of files.entries()) {
        console.log(`Pushing media ${files.length - index}/${files.length}: ${file.name}`);
        await driver.pushMedia({ localPath: file.path, fileName: file.name, mimeType: file.mimeType });
    }
    console.log(`Pushed ${manifest.files.length} media file(s) to the device gallery`);
}

/**
 * Profile tab → handle dropdown → the row matching the handle, mirroring the TikTok routine.
 * A Threads account is an Instagram account, so the switcher is the Instagram one and the row is
 * the bare handle.
 */
export async function switchAccount(driver: DeviceDriver, handle: string, options: PostOnAndroidOptions = {}): Promise<void> {
    const timing = timingOf(options);
    console.log(`Switching to Threads account "${handle}"`);
    await tapFirst(driver, 'Profile tab', selectors.profileTab, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);

    const handleSelector: SelectorList = [{ text: handle }];
    // Exact here on purpose: a substring match would read "@bobby" as "@bob" and post from the
    // wrong account, which is the one outcome that cannot be undone.
    if (await isPresent(driver, [{ text: handle, exact: true }])) {
        console.log(`Already on Threads account ${handle}`);
        return;
    }

    await tapFirst(driver, 'account switcher', selectors.accountSwitcher, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    await waitForAny(driver, `the account row for ${handle}`, handleSelector, {
        timeoutMs: timing.screenTimeoutMs, intervalMs: timing.pollIntervalMs, ...(timing.signal ? { signal: timing.signal } : {}),
    });
    await tapFirst(driver, `account row for ${handle}`, handleSelector, tapping(options));
    // Threads reloads app state after a switch.
    await driver.pause(timing.settleMs * 2, timing.signal);

    await tapFirst(driver, 'Profile tab (verify)', selectors.profileTab, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    const root = await driver.uiTree();
    if (!findByText(root, { text: handle })) {
        throw new DriverError(`Switched but could not confirm Threads account "${handle}" is active. Screen showed: ${screenSummary(root)}`);
    }
    console.log(`Confirmed active Threads account: ${handle}`);
}

/** Threads' cold-start nudges. Never fatal, and never more than a couple deep. */
async function dismissInterstitials(driver: DeviceDriver, options: PostOnAndroidOptions, rounds = 2): Promise<void> {
    const timing = timingOf(options);
    for (let round = 0; round < rounds; round += 1) {
        if (!await tapIfPresent(driver, 'an optional prompt', selectors.dismissable, tapping(options))) return;
        await driver.pause(timing.settleMs, timing.signal);
    }
}

async function attachMedia(driver: DeviceDriver, count: number, options: PostOnAndroidOptions): Promise<void> {
    const timing = timingOf(options);
    await tapFirst(driver, 'Attach media', selectors.attach, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    // The gallery permission sheet only shows the first time media is attached on a phone.
    await dismissInterstitials(driver, options, 1);

    const root = await driver.uiTree();
    const cells = galleryCells(root);
    if (cells.length < count) {
        throw new DriverError(
            `Threads' picker showed ${cells.length} selectable item(s) but ${count} are needed. Screen showed: ${screenSummary(root)}`,
        );
    }
    // Tap order is carousel order: the cells were sorted top-left first, and the media was pushed
    // so that manifest file 1 is the newest — that is, the first cell.
    for (const [index, cell] of cells.slice(0, count).entries()) {
        const { left, top, right, bottom } = cell.bounds;
        await humanTapAt(driver, { x: (left + right) / 2, y: (top + bottom) / 2 }, options.motion);
        console.log(`Tapped media ${index + 1}/${count}`);
        await driver.pause(timing.settleMs, timing.signal);
    }
    // A single-tap picker may have closed itself already; confirming is optional either way.
    await tapIfPresent(driver, 'the picker confirmation', selectors.pickerConfirm, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
}

async function writeText(driver: DeviceDriver, text: string, options: PostOnAndroidOptions): Promise<void> {
    const timing = timingOf(options);
    await tapFirst(driver, 'the composer', selectors.composerField, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    await driver.type(text);
    // Back closes the soft keyboard without leaving the composer.
    await driver.pressKey('back');
    await driver.pause(timing.settleMs, timing.signal);
    console.log(`Wrote ${text.length} characters`);
}

/**
 * Threads has no Drafts button: backing out of a composer with content in it offers to keep it.
 * Try a direct control first for the builds that grew one, then fall back to the sheet.
 */
async function keepAsDraft(driver: DeviceDriver, options: PostOnAndroidOptions): Promise<void> {
    const timing = timingOf(options);
    if (await tapIfPresent(driver, 'Save draft', selectors.saveDraft, tapping(options))) return;
    console.log('No draft control in the composer; leaving it to raise the "keep draft?" sheet');
    await driver.pressKey('back');
    await driver.pause(timing.settleMs, timing.signal);
    await tapFirst(driver, 'Save draft', selectors.saveDraft, tapping(options));
}

/**
 * The whole Android posting flow, driven through the `DeviceDriver` interface: push media, launch
 * Threads, optionally switch account, compose → text → media → Post (or keep as a draft), then
 * confirm and go home. Exported so it can be tested without spawning the entrypoint below.
 */
export async function postOnAndroid(driver: DeviceDriver, manifest: ThreadsPostManifest, options: PostOnAndroidOptions = {}): Promise<void> {
    // One read of the override store per run, before the first tap: the flow below then uses
    // the corrected table exactly as it used the built-in one.
    selectors = await resolveTable(THREADS_PLUGIN_ID, driver.udid, POST_SELECTORS);
    const timing = timingOf(options);
    const packageName = options.packageName ?? THREADS_ANDROID_PACKAGE;

    // Both of these throw before a byte is pushed or the app is opened, which is the whole point:
    // a rejected post must leave no trace on the phone.
    const format = threadFormat(manifest.files, manifest.text);
    if (manifest.text) assertTextIsTypeable(driver, manifest.text);
    console.log(`Posting a ${format} thread with ${manifest.files.length} media file(s)`);

    await pushAllMedia(driver, manifest);

    console.log(`Launching ${packageName} on ${driver.udid}`);
    await driver.pressKey('wake');
    await driver.launchApp(packageName);
    await driver.pause(timing.settleMs, timing.signal);
    await dismissInterstitials(driver, options);

    const account = manifest.account?.trim();
    if (account) await switchAccount(driver, account, options);

    await tapFirst(driver, 'Compose', selectors.compose, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    await waitForAny(driver, 'the composer', selectors.composerField, {
        timeoutMs: timing.screenTimeoutMs, intervalMs: timing.pollIntervalMs, ...(timing.signal ? { signal: timing.signal } : {}),
    });

    if (manifest.text) await writeText(driver, manifest.text, options);
    if (manifest.files.length) await attachMedia(driver, manifest.files.length, options);

    const publishing = manifest.destination === 'publish';
    if (publishing) {
        await tapFirst(driver, 'Post', selectors.post, tapping(options));
        console.log('Thread submitted');
    } else {
        await keepAsDraft(driver, options);
        console.log('Thread kept as a draft');
    }

    const confirmation = publishing ? selectors.publishSuccess : selectors.draftSuccess;
    const confirmed = await waitForAny(driver, publishing ? 'the post confirmation' : 'the draft confirmation', confirmation, {
        timeoutMs: timing.successTimeoutMs, intervalMs: timing.pollIntervalMs, ...(timing.signal ? { signal: timing.signal } : {}),
    });
    console.log(`Confirmed: ${confirmed.text || confirmed.description}`);
    if (publishing) {
        // The upload continues in the background; leave the app alone while it finishes.
        await driver.pause(timing.settleMs * 4, timing.signal);
    }
    // Then go home: a phone left inside Threads keeps whatever it landed on awake.
    await driver.pressKey('home');
    console.log('Left Threads on the home screen');
}

export async function runFromManifest(manifestPath: string, signal?: AbortSignal): Promise<void> {
    const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')) as ThreadsPostManifest;
    const driver = driverFromEnv();
    await postOnAndroid(driver, manifest, {
        packageName: process.env.THREADS_PACKAGE?.trim() || THREADS_ANDROID_PACKAGE,
        recognize: recognizeOnDevice,
        ...(signal ? { signal } : {}),
    });
}

/** Entrypoint: `node --import tsx src/threads/android/post.ts <manifest.json>`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const manifestPath = process.argv[2];
    if (!manifestPath) throw new Error('A post manifest path is required');
    // The executor stops a routine with SIGTERM; every pause races the abort so it lands promptly
    // instead of the process being torn down between two taps.
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
    await runFromManifest(manifestPath, controller.signal);
}
