import { readFile } from 'node:fs/promises';
import { resolveTable } from '../../drivers/selector-overrides.js';
import { INSTAGRAM_PLUGIN_ID } from '../../plugin-ids.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findByText, walk, type Recognize } from '../../drivers/verify.js';
import { DriverError, type DeviceDriver, type UiNode } from '../../drivers/types.js';
import { driverFromEnv } from '../../tiktok/android/driver-from-env.js';
import type { MotionSource } from '../../motion/source.js';
import {
    assertFormat, MAX_CAPTION_LENGTH, type InstagramFormat, type InstagramPostManifest,
} from '../post-manifest.js';
import {
    humanTapAt, isPresent, recognizeOnDevice, screenSummary, tapFirst, tapIfPresent, waitForAny,
    type SelectorList, type TapOptions,
} from './ui.js';

export const INSTAGRAM_ANDROID_PACKAGE = 'com.instagram.android';

export { MAX_CAPTION_LENGTH };

/**
 * Every on-screen control this routine touches, in one table.
 *
 * Instagram's Android labels and resource-ids move between builds, regions and A/B buckets, and
 * the exact strings are not knowable without a phone in hand. Each entry is therefore a list of
 * alternates tried in order — correct the list here (and in docs/instagram.md) rather than
 * editing the flow below. **Entries marked GUESS have not been confirmed against a real device**,
 * which today is nearly all of them.
 */
export const POST_SELECTORS = {
    /** Bottom navigation. Content-desc is what TalkBack reads out, so it is the most stable handle. */
    profileTab: [
        { id: 'profile_tab' }, { id: 'tab_avatar' },
        { text: 'Profile', exact: true }, { text: 'Your profile' },
    ] as SelectorList,
    /** The username / chevron in the profile header that opens the account list. GUESS. */
    accountSwitcher: [
        { id: 'action_bar_title_chevron' }, { id: 'action_bar_large_title_auto_size' },
        { id: 'title_view' }, { text: 'Switch accounts' }, { text: 'Switch account' },
    ] as SelectorList,
    /** The centre "+" in the bottom navigation. GUESS. */
    create: [
        { id: 'creation_tab' }, { id: 'tab_icon_create' },
        { text: 'Create', exact: true }, { text: 'New post' }, { text: 'New', exact: true },
    ] as SelectorList,
    /**
     * The strip under the gallery that chooses the surface: POST / STORY / REEL / LIVE. Some
     * builds put the "+" straight onto a sheet with the same words. GUESS.
     */
    reelTab: [{ id: 'tab_reel' }, { text: 'Reel', exact: true }, { text: 'REEL', exact: true }] as SelectorList,
    postTab: [{ id: 'tab_post' }, { text: 'Post', exact: true }, { text: 'POST', exact: true }] as SelectorList,
    /** The gallery grid entry, on builds whose "+" opens the camera first. GUESS. Optional. */
    gallery: [{ id: 'gallery_button' }, { text: 'Gallery', exact: true }, { text: 'Add', exact: true }] as SelectorList,
    /** Multi-select toggle in the picker; only tapped for a carousel. GUESS. */
    selectMultiple: [
        { id: 'gallery_multi_select_button' }, { id: 'multi_select' },
        { text: 'Select multiple' }, { text: 'Multiple' },
    ] as SelectorList,
    /** Advances the picker, then the editor, then the filter screen. GUESS. */
    next: [{ id: 'next_button_textview' }, { id: 'next_button' }, { text: 'Next', exact: true }] as SelectorList,
    /** Optional sheets Instagram interposes on some builds; skipped when absent. GUESS. */
    dismissAudio: [{ text: 'Not now' }, { text: 'Skip', exact: true }, { text: 'Dismiss' }] as SelectorList,
    /** The caption box on the share screen. GUESS. */
    captionField: [
        { id: 'caption_input_text_view' }, { id: 'caption_text_view' }, { id: 'caption' },
        { text: 'Write a caption' }, { text: 'Add a caption' }, { text: 'Write a caption...' },
    ] as SelectorList,
    /** Publish. GUESS. */
    share: [
        { id: 'share_footer_button' }, { id: 'next_button_textview' },
        { text: 'Share', exact: true }, { text: 'Share to' },
    ] as SelectorList,
    /**
     * Save without publishing. Instagram has no "Drafts" button on the share screen — backing out
     * of it offers "Save draft" instead — so the draft path is Back, then that sheet. GUESS.
     */
    saveDraft: [{ text: 'Save draft' }, { text: 'Save as draft' }, { text: 'Save Draft' }] as SelectorList,
    /** What the app shows once the upload has been accepted. GUESS — Instagram varies this string. */
    publishSuccess: [
        { text: 'Posting' }, { text: 'Your post is being shared' }, { text: 'Sharing' },
        { text: 'Uploading' }, { text: 'Your reel is being shared' }, { text: 'Shared' },
    ] as SelectorList,
    /** What the app shows after Save draft. GUESS. */
    draftSuccess: [{ text: 'Draft saved' }, { text: 'Saved to drafts' }, { text: 'Drafts', exact: true }] as SelectorList,
    /**
     * Gallery thumbnails carry no text. These are the resource-id fragments and content-desc
     * substrings Instagram's picker cells have been seen with; matching nodes are ordered
     * top-left first, which is newest first in the Recents album. GUESS.
     */
    galleryCellIds: ['gallery_grid_item_thumbnail', 'image_view', 'media_thumbnail', 'thumbnail'] as readonly string[],
    galleryCellDescriptions: ['photo', 'video', 'image'] as readonly string[],
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
    /** Android package; overridden with INSTAGRAM_PACKAGE from the environment. */
    packageName?: string;
    /** OCR fallback for screens Instagram draws without accessibility nodes. */
    recognize?: Recognize;
    signal?: AbortSignal;
    /** Settle time after a tap before the next tree read. Tests pass 0. */
    settleMs?: number;
    /** How long to wait for the upload/draft confirmation. */
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
        settleMs: options.settleMs ?? 2_500,
        successTimeoutMs: options.successTimeoutMs ?? 180_000,
        pollIntervalMs: options.pollIntervalMs ?? 1_000,
        screenTimeoutMs: options.screenTimeoutMs ?? 30_000,
        ...(options.signal ? { signal: options.signal } : {}),
    };
}

/**
 * The adb driver cannot type anything outside printable ASCII, and finding that out after the
 * media is pushed and the composer is open leaves a half-finished draft on the phone. Check first.
 */
export function assertCaptionIsTypeable(driver: DeviceDriver, caption: string): void {
    if (caption.length > MAX_CAPTION_LENGTH) {
        throw new DriverError(`Caption is ${caption.length} characters; Instagram accepts at most ${MAX_CAPTION_LENGTH}`);
    }
    if (driver.kind !== 'adb') return;
    const offending = [...caption].find((character) => {
        const code = character.codePointAt(0)!;
        return code < 0x20 || code > 0x7e;
    });
    if (offending === undefined) return;
    throw new DriverError(
        `The caption contains ${JSON.stringify(offending)}, which "adb shell input text" cannot type. `
        + 'Switch this device to the a11y-bridge driver, or use an ASCII-only caption.',
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

/**
 * Media lands in DCIM/Camera newest-last-pushed, so push in reverse to make file 1 the newest
 * cell. That ordering *is* the carousel's slide order — Instagram numbers a multi-select in the
 * order the cells are tapped, and the routine taps them top-left first.
 */
async function pushAllMedia(driver: DeviceDriver, manifest: InstagramPostManifest): Promise<void> {
    const files = [...manifest.files].reverse();
    for (const [index, file] of files.entries()) {
        console.log(`Pushing media ${files.length - index}/${files.length}: ${file.name}`);
        await driver.pushMedia({ localPath: file.path, fileName: file.name, mimeType: file.mimeType });
    }
    console.log(`Pushed ${manifest.files.length} media file(s) to the device gallery`);
}

/**
 * Profile tab → account name dropdown → the row matching the handle, exactly as the TikTok
 * routine does it. The tree makes this cheap: the handle either is on the profile header already,
 * or it is a row in the switcher sheet.
 */
export async function switchAccount(driver: DeviceDriver, handle: string, options: PostOnAndroidOptions = {}): Promise<void> {
    const timing = timingOf(options);
    console.log(`Switching to Instagram account "${handle}"`);
    await tapFirst(driver, 'Profile tab', selectors.profileTab, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);

    const handleSelector: SelectorList = [{ text: handle }];
    // Exact here on purpose: a substring match would read "@bobby" as "@bob" and post from the
    // wrong account, which is the one outcome that cannot be undone.
    if (await isPresent(driver, [{ text: handle, exact: true }])) {
        console.log(`Already on Instagram account ${handle}`);
        return;
    }

    await tapFirst(driver, 'account switcher', selectors.accountSwitcher, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    await waitForAny(driver, `the account row for ${handle}`, handleSelector, {
        timeoutMs: timing.screenTimeoutMs, intervalMs: timing.pollIntervalMs, ...(timing.signal ? { signal: timing.signal } : {}),
    });
    await tapFirst(driver, `account row for ${handle}`, handleSelector, tapping(options));
    // Instagram reloads app state after a switch.
    await driver.pause(timing.settleMs * 2, timing.signal);

    await tapFirst(driver, 'Profile tab (verify)', selectors.profileTab, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    const root = await driver.uiTree();
    if (!findByText(root, { text: handle })) {
        throw new DriverError(`Switched but could not confirm Instagram account "${handle}" is active. Screen showed: ${screenSummary(root)}`);
    }
    console.log(`Confirmed active Instagram account: ${handle}`);
}

/**
 * The surface strip under the gallery. Optional on purpose: several builds open the "+" straight
 * onto the grid for a post, and a reel gets its own entry point. A missing tab is logged and the
 * flow carries on with whatever Instagram opened.
 */
async function chooseSurface(driver: DeviceDriver, format: InstagramFormat, options: PostOnAndroidOptions): Promise<void> {
    const timing = timingOf(options);
    const tab = format === 'reel' ? selectors.reelTab : selectors.postTab;
    await tapIfPresent(driver, format === 'reel' ? 'REEL tab' : 'POST tab', tab, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    // Builds that open the camera instead of the grid need one more tap to get to the gallery.
    await tapIfPresent(driver, 'Gallery', selectors.gallery, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
}

async function selectMedia(driver: DeviceDriver, count: number, options: PostOnAndroidOptions): Promise<void> {
    const timing = timingOf(options);
    if (count > 1) {
        await tapIfPresent(driver, 'Select multiple', selectors.selectMultiple, tapping(options));
        await driver.pause(timing.settleMs, timing.signal);
    }
    const root = await driver.uiTree();
    const cells = galleryCells(root);
    if (cells.length < count) {
        throw new DriverError(
            `Gallery picker showed ${cells.length} selectable item(s) but ${count} are needed. Screen showed: ${screenSummary(root)}`,
        );
    }
    // Tapped newest-first, which after the reversed push is manifest order — slide 1 first.
    for (const [index, cell] of cells.slice(0, count).entries()) {
        const { left, top, right, bottom } = cell.bounds;
        await humanTapAt(driver, { x: (left + right) / 2, y: (top + bottom) / 2 }, options.motion);
        console.log(`Tapped media ${index + 1}/${count}`);
        await driver.pause(timing.settleMs, timing.signal);
    }
}

/**
 * Picker Next, then the editor's and the filter screen's, stopping as soon as the caption screen
 * is up. Instagram interposes a different number of screens per format and per build, so this
 * counts taps rather than assuming a fixed depth.
 */
async function advanceToCaptionScreen(driver: DeviceDriver, options: PostOnAndroidOptions, maxSteps = 4): Promise<void> {
    const timing = timingOf(options);
    for (let step = 1; step <= maxSteps; step += 1) {
        if (await isPresent(driver, selectors.captionField)) {
            console.log('Reached the caption screen');
            return;
        }
        // "Add audio" / "Try a template" prompts sit on top of Next on some reel builds.
        await tapIfPresent(driver, 'an optional prompt', selectors.dismissAudio, tapping(options));
        await tapFirst(driver, `Next (${step})`, selectors.next, tapping(options));
        await driver.pause(timing.settleMs, timing.signal);
    }
    if (await isPresent(driver, selectors.captionField)) {
        console.log('Reached the caption screen');
        return;
    }
    throw new DriverError(`Could not reach the Instagram caption screen after ${maxSteps} Next taps. Screen showed: ${screenSummary(await driver.uiTree())}`);
}

async function addCaption(driver: DeviceDriver, caption: string, options: PostOnAndroidOptions): Promise<void> {
    const timing = timingOf(options);
    await tapFirst(driver, 'caption field', selectors.captionField, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    await driver.type(caption);
    // Back closes the soft keyboard without leaving the share form.
    await driver.pressKey('back');
    await driver.pause(timing.settleMs, timing.signal);
    console.log('Caption added');
}

/**
 * The whole Android posting flow, driven through the `DeviceDriver` interface: push media, launch
 * Instagram, optionally switch account, "+" → surface → picker → editor → caption →
 * Share / Save draft, then confirm and go Home. Exported so it can be tested without spawning the
 * entrypoint below.
 */
export async function postOnAndroid(
    driver: DeviceDriver, manifest: InstagramPostManifest, options: PostOnAndroidOptions = {},
): Promise<void> {
    // One read of the override store per run, before the first tap: the flow below then uses
    // the corrected table exactly as it used the built-in one.
    selectors = await resolveTable(INSTAGRAM_PLUGIN_ID, driver.udid, POST_SELECTORS);
    const timing = timingOf(options);
    const packageName = options.packageName ?? INSTAGRAM_ANDROID_PACKAGE;

    // Format and media are checked before a byte is pushed: a mismatch found halfway through
    // leaves an orphan file in the gallery and a composer open on the phone.
    assertFormat(manifest.format, manifest.files);
    if (manifest.caption) assertCaptionIsTypeable(driver, manifest.caption);
    await pushAllMedia(driver, manifest);

    console.log(`Launching ${packageName} on ${driver.udid} for a ${manifest.format}`);
    await driver.pressKey('wake');
    await driver.launchApp(packageName);
    await driver.pause(timing.settleMs, timing.signal);

    const account = manifest.account?.trim();
    if (account) await switchAccount(driver, account, options);

    await tapFirst(driver, 'Create', selectors.create, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    await chooseSurface(driver, manifest.format, options);

    await selectMedia(driver, manifest.files.length, options);
    await advanceToCaptionScreen(driver, options);

    if (manifest.caption) await addCaption(driver, manifest.caption, options);

    const publishing = manifest.destination === 'publish';
    if (publishing) {
        await tapFirst(driver, 'Share', selectors.share, tapping(options));
        console.log('Instagram post submitted');
    } else {
        // There is no Drafts button on the share screen; backing out of it is what offers one.
        await driver.pressKey('back');
        await driver.pause(timing.settleMs, timing.signal);
        await tapFirst(driver, 'Save draft', selectors.saveDraft, tapping(options));
        console.log('Instagram draft submitted');
    }

    const confirmation = publishing ? selectors.publishSuccess : selectors.draftSuccess;
    const confirmed = await waitForAny(driver, publishing ? 'the upload confirmation' : 'the draft confirmation', confirmation, {
        timeoutMs: timing.successTimeoutMs, intervalMs: timing.pollIntervalMs, ...(timing.signal ? { signal: timing.signal } : {}),
    });
    console.log(`Confirmed: ${confirmed.text || confirmed.description}`);
    if (publishing) {
        // The upload continues in the background; leave the app alone while it finishes.
        await driver.pause(timing.settleMs * 4, timing.signal);
    }
    // Then go home: a phone left inside Instagram keeps playing whatever it landed on.
    await driver.pressKey('home');
    console.log('Left Instagram on the home screen');
}

export async function runFromManifest(manifestPath: string, signal?: AbortSignal): Promise<void> {
    const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')) as InstagramPostManifest;
    const driver = driverFromEnv();
    await postOnAndroid(driver, manifest, {
        packageName: process.env.INSTAGRAM_PACKAGE?.trim() || INSTAGRAM_ANDROID_PACKAGE,
        recognize: recognizeOnDevice,
        ...(signal ? { signal } : {}),
    });
}

/** Entrypoint: `node --import tsx src/instagram/android/post.ts <manifest.json>`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const manifestPath = process.argv[2];
    if (!manifestPath) throw new Error('An Instagram post manifest path is required');
    // The executor stops a routine with SIGTERM; every pause races the abort so it lands promptly
    // instead of the process being torn down between two taps.
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
    await runFromManifest(manifestPath, controller.signal);
}
