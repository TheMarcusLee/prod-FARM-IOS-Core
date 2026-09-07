import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findByText, walk, type Recognize } from '../../drivers/verify.js';
import { DriverError, type DeviceDriver, type UiNode } from '../../drivers/types.js';
import type { YouTubePostManifest } from '../post-manifest.js';
// Rebuilding a driver from DEVICE_* / ANDROID_SERIAL is platform plumbing rather than anything
// TikTok-specific; it lives under src/tiktok/android/ because that routine needed it first.
import { driverFromEnv } from '../../tiktok/android/driver-from-env.js';
import type { MotionSource } from '../../motion/source.js';
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH, YOUTUBE_ANDROID_PACKAGE } from '../app.js';
import {
    findAny, humanTapAt, isPresent, recognizeOnDevice, screenSummary, tapFirst, tapIfPresent, waitForAny,
    type SelectorList, type TapOptions,
} from './ui.js';

export { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH, YOUTUBE_ANDROID_PACKAGE } from '../app.js';

/**
 * Every on-screen control this routine touches, in one table.
 *
 * YouTube's Android labels and resource-ids move between builds, regions and A/B buckets, and the
 * exact strings are not knowable without a phone in hand. Each entry is therefore a list of
 * alternates tried in order — correct the list here (and in docs/youtube.md) rather than editing
 * the flow below. Entries marked GUESS have not been confirmed against a real device.
 *
 * As it happens *none* of these have been confirmed against a real device yet; GUESS marks the
 * ones that are outright inventions rather than the conventional label YouTube is known to use.
 */
export const POST_SELECTORS = {
    /** The avatar in the top-right corner, which opens the account sheet. GUESS. */
    accountAvatar: [
        { id: 'image_view' }, { id: 'avatar' }, { id: 'account_button' },
        { text: 'Account', exact: true }, { text: 'Your account' }, { text: 'Profile', exact: true },
    ] as SelectorList,
    /**
     * The name at the top of the account sheet — the channel that is *active*, as opposed to the
     * rows underneath it, which are the ones it could switch to. Read, never tapped. GUESS.
     */
    activeChannel: [
        { id: 'account_name' }, { id: 'channel_name' }, { id: 'account_title' }, { id: 'header_name' },
    ] as SelectorList,
    /** The row inside the account sheet that opens the full channel list. GUESS. */
    switchAccount: [
        { id: 'switch_account' }, { text: 'Switch account' }, { text: 'Switch accounts' }, { text: 'Use another account' },
    ] as SelectorList,
    /** The centre "+" in the bottom navigation. */
    create: [
        { id: 'create_tab' }, { id: 'fab_create' }, { id: 'image_create' },
        { text: 'Create', exact: true }, { text: 'Create a Short' }, { text: 'Add', exact: true },
    ] as SelectorList,
    /** The gallery entry on the create sheet / Shorts camera. */
    upload: [
        { id: 'upload_video' }, { id: 'gallery_button' }, { id: 'shorts_camera_gallery' },
        { text: 'Upload a video' }, { text: 'Upload video' }, { text: 'Gallery', exact: true }, { text: 'Add', exact: true },
    ] as SelectorList,
    /** Advances the Shorts editor; each of these screens labels the control "Next". */
    next: [{ id: 'btn_next' }, { id: 'next_button' }, { text: 'Next', exact: true }, { text: 'Done', exact: true }] as SelectorList,
    /** The title box on the "Add details" screen. */
    titleField: [
        { id: 'title_edit_text' }, { id: 'video_title' }, { id: 'edit_text' },
        { text: 'Add a title' }, { text: 'Add a title that describes your Short' }, { text: 'Title', exact: true },
    ] as SelectorList,
    /** The description box, which some builds only show behind "Add description". GUESS. */
    descriptionField: [
        { id: 'description_edit_text' }, { id: 'video_description' },
        { text: 'Add description' }, { text: 'Description', exact: true },
    ] as SelectorList,
    /** The visibility row on the details screen. GUESS. */
    visibility: [
        { id: 'privacy_button' }, { id: 'visibility_button' },
        { text: 'Visibility', exact: true }, { text: 'Who can see' }, { text: 'Private', exact: true }, { text: 'Unlisted', exact: true },
    ] as SelectorList,
    /** "Public" inside the visibility sheet. */
    publicOption: [{ text: 'Public', exact: true }, { text: 'Everyone' }] as SelectorList,
    /**
     * The audience question ("Is this video made for kids?"). Some builds ask it inline on the
     * details screen, some behind a row, some not at all — every step around it is tolerant. GUESS.
     */
    audience: [
        { id: 'audience_button' }, { id: 'made_for_kids' },
        { text: 'Audience', exact: true }, { text: 'made for kids' }, { text: 'Select audience' },
    ] as SelectorList,
    /** The answer a farm account wants. GUESS. */
    notMadeForKids: [
        { text: "No, it's not made for kids" }, { text: 'not made for kids' }, { text: 'No, it’s not made for kids' },
    ] as SelectorList,
    madeForKids: [{ text: "Yes, it's made for kids" }, { text: 'Yes, it’s made for kids' }] as SelectorList,
    /** Publish. */
    uploadShort: [
        { id: 'upload_button' }, { id: 'publish_button' },
        { text: 'Upload Short', exact: true }, { text: 'Upload', exact: true }, { text: 'Post', exact: true },
    ] as SelectorList,
    /** Save without publishing. GUESS — YouTube hides drafts behind the editor's back button. */
    saveDraft: [
        { id: 'save_draft' }, { text: 'Save draft' }, { text: 'Save as draft' }, { text: 'Drafts', exact: true },
    ] as SelectorList,
    /** What the app shows once the upload has been accepted. GUESS. */
    publishSuccess: [
        { text: 'Uploading' }, { text: 'being uploaded' }, { text: 'Your Short is uploading' },
        { text: 'Upload complete' }, { text: 'Posted' },
    ] as SelectorList,
    /** What the app shows after the draft is kept. GUESS. */
    draftSuccess: [{ text: 'Draft saved' }, { text: 'Saved to drafts' }, { text: 'Drafts', exact: true }] as SelectorList,
    /**
     * Gallery thumbnails carry no text. These are the resource-id fragments and content-desc
     * substrings a picker cell has been seen with; matching nodes are ordered top-left first,
     * which is newest first in the Recents album. GUESS.
     */
    galleryCellIds: ['thumbnail', 'iv_thumbnail', 'image_view', 'video_thumbnail', 'media_item'] as readonly string[],
    galleryCellDescriptions: ['video', 'seconds', 'photo', 'image'] as readonly string[],
} as const;

export interface PostOnAndroidOptions {
    /** Android package; overridden with YOUTUBE_PACKAGE from the environment. */
    packageName?: string;
    /** OCR fallback for screens YouTube draws without accessibility nodes. */
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
 * video is pushed and the editor is open leaves a half-finished Short on the phone. Check first.
 */
export function assertTextIsTypeable(driver: DeviceDriver, text: string, field: string, limit: number): void {
    if (text.length > limit) {
        throw new DriverError(`The ${field} is ${text.length} characters; YouTube accepts at most ${limit}`);
    }
    if (driver.kind !== 'adb') return;
    const offending = [...text].find((character) => {
        const code = character.codePointAt(0)!;
        return code < 0x20 || code > 0x7e;
    });
    if (offending === undefined) return;
    throw new DriverError(
        `The ${field} contains ${JSON.stringify(offending)}, which "adb shell input text" cannot type. `
        + 'Switch this device to the a11y-bridge driver, or use ASCII-only text.',
    );
}

/** Picker cells, ordered the way they are laid out: top-left (newest) first. */
export function galleryCells(root: UiNode): UiNode[] {
    const matches = [...walk(root)].filter((node) => {
        const byId = POST_SELECTORS.galleryCellIds.some((id) => node.id === id || node.id.endsWith(`:id/${id}`));
        const description = node.description.toLowerCase();
        const byDescription = description.length > 0
            && POST_SELECTORS.galleryCellDescriptions.some((word) => description.includes(word));
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

/** The channel named at the top of the open account sheet, or '' when no header could be read. */
export function activeChannel(root: UiNode): string {
    const node = findAny(root, POST_SELECTORS.activeChannel);
    return (node?.text || node?.description || '').trim();
}

/**
 * Avatar → account list → the row matching the handle, the YouTube shape of the same idea as the
 * TikTok routine's profile-tab switch. The channel name either is already in the account sheet
 * header, or it is a row inside it.
 */
export async function switchAccount(driver: DeviceDriver, handle: string, options: PostOnAndroidOptions = {}): Promise<void> {
    const timing = timingOf(options);
    console.log(`Switching to YouTube channel "${handle}"`);
    await tapFirst(driver, 'account avatar', POST_SELECTORS.accountAvatar, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);

    // The sheet lists every channel on the phone, so "the handle is on screen" says nothing about
    // which one is active — only the header does. Comparison is exact: a substring match would
    // read "@bobby" as "@bob" and post from the wrong channel, the one outcome that cannot be undone.
    if (activeChannel(await driver.uiTree()) === handle) {
        console.log(`Already on YouTube channel ${handle}`);
        await driver.pressKey('back');
        await driver.pause(timing.settleMs, timing.signal);
        return;
    }

    // Some builds list every channel in the account sheet; others hide them behind "Switch account".
    await tapIfPresent(driver, 'Switch account', POST_SELECTORS.switchAccount, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);

    // Exact, so "@bob" can never land on the "@bobby" row (or on the sheet's own header).
    const handleSelector: SelectorList = [{ text: handle, exact: true }];
    await waitForAny(driver, `the account row for ${handle}`, handleSelector, {
        timeoutMs: timing.screenTimeoutMs, intervalMs: timing.pollIntervalMs, ...(timing.signal ? { signal: timing.signal } : {}),
    });
    await tapFirst(driver, `account row for ${handle}`, handleSelector, tapping(options));
    // YouTube reloads the whole app after a channel switch.
    await driver.pause(timing.settleMs * 2, timing.signal);

    await tapFirst(driver, 'account avatar (verify)', POST_SELECTORS.accountAvatar, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    const root = await driver.uiTree();
    // The header again where a build has one; where it has none, fall back to an exact match
    // anywhere on the sheet, which is weaker but still refuses a near-miss handle.
    const active = activeChannel(root);
    const confirmed = active ? active === handle : Boolean(findByText(root, { text: handle, exact: true }));
    if (!confirmed) {
        throw new DriverError(`Switched but could not confirm YouTube channel "${handle}" is active. Screen showed: ${screenSummary(root)}`);
    }
    console.log(`Confirmed active YouTube channel: ${handle}`);
    await driver.pressKey('back');
    await driver.pause(timing.settleMs, timing.signal);
}

/** The newest cell in the gallery is the clip this run just pushed. */
async function selectNewestVideo(driver: DeviceDriver, options: PostOnAndroidOptions): Promise<void> {
    const timing = timingOf(options);
    const root = await driver.uiTree();
    const cells = galleryCells(root);
    if (!cells.length) {
        throw new DriverError(`The gallery picker showed no selectable video. Screen showed: ${screenSummary(root)}`);
    }
    const { left, top, right, bottom } = cells[0]!.bounds;
    await humanTapAt(driver, { x: (left + right) / 2, y: (top + bottom) / 2 }, options.motion);
    console.log('Tapped the newest video in the gallery');
    await driver.pause(timing.settleMs, timing.signal);
}

/**
 * Next through the Shorts editor — trim, then the effects/sound pass — stopping as soon as the
 * details screen with the title box is up. The number of Next screens differs by build, so this
 * counts taps rather than assuming a fixed number.
 */
async function advanceToDetailsScreen(driver: DeviceDriver, options: PostOnAndroidOptions, maxSteps = 4): Promise<void> {
    const timing = timingOf(options);
    for (let step = 1; step <= maxSteps; step += 1) {
        if (await isPresent(driver, POST_SELECTORS.titleField)) {
            console.log('Reached the Shorts details screen');
            return;
        }
        await tapFirst(driver, `Next (${step})`, POST_SELECTORS.next, tapping(options));
        await driver.pause(timing.settleMs, timing.signal);
    }
    if (await isPresent(driver, POST_SELECTORS.titleField)) {
        console.log('Reached the Shorts details screen');
        return;
    }
    throw new DriverError(
        `Could not reach the Shorts details screen after ${maxSteps} Next taps. Screen showed: ${screenSummary(await driver.uiTree())}`,
    );
}

async function typeInto(
    driver: DeviceDriver, label: string, selectors: SelectorList, text: string, options: PostOnAndroidOptions,
): Promise<void> {
    const timing = timingOf(options);
    await tapFirst(driver, label, selectors, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    await driver.type(text);
    // Back closes the soft keyboard without leaving the details form.
    await driver.pressKey('back');
    await driver.pause(timing.settleMs, timing.signal);
    console.log(`${label} filled in`);
}

/**
 * Visibility → Public. Tolerant: a build that has no visibility row on the details screen (Shorts
 * default to Public) is not a failure, and neither is a sheet that closes itself.
 */
async function setPublicVisibility(driver: DeviceDriver, options: PostOnAndroidOptions): Promise<void> {
    const timing = timingOf(options);
    if (!await tapIfPresent(driver, 'Visibility', POST_SELECTORS.visibility, tapping(options))) {
        console.log('No visibility row on the details screen; leaving YouTube on its default');
        return;
    }
    await driver.pause(timing.settleMs, timing.signal);
    if (!await tapIfPresent(driver, 'Public', POST_SELECTORS.publicOption, tapping(options))) {
        console.log('The visibility sheet did not offer Public; leaving it as it was');
        return;
    }
    await driver.pause(timing.settleMs, timing.signal);
    // Some builds need the sheet confirmed with a Done/Next before it closes.
    await tapIfPresent(driver, 'Done (visibility)', POST_SELECTORS.next, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
}

/**
 * The "made for kids" question. YouTube asks it in three different places depending on the build,
 * and on some accounts not at all because the channel already answered it — so every step here is
 * optional and the routine logs what it found rather than failing.
 */
export async function answerAudience(driver: DeviceDriver, madeForKids: boolean, options: PostOnAndroidOptions): Promise<boolean> {
    const timing = timingOf(options);
    const answer = madeForKids ? POST_SELECTORS.madeForKids : POST_SELECTORS.notMadeForKids;
    const label = madeForKids ? '"made for kids"' : '"not made for kids"';

    // The answer is sometimes right there on the details screen; otherwise it is behind a row.
    if (await tapIfPresent(driver, label, answer, tapping(options))) {
        await driver.pause(timing.settleMs, timing.signal);
        await tapIfPresent(driver, 'Done (audience)', POST_SELECTORS.next, tapping(options));
        await driver.pause(timing.settleMs, timing.signal);
        return true;
    }
    if (!await tapIfPresent(driver, 'Audience', POST_SELECTORS.audience, tapping(options))) {
        console.log('No audience question on this screen; the channel has probably already answered it');
        return false;
    }
    await driver.pause(timing.settleMs, timing.signal);
    const answered = await tapIfPresent(driver, label, answer, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    await tapIfPresent(driver, 'Done (audience)', POST_SELECTORS.next, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    if (!answered) console.log('The audience screen did not offer the expected answer; left as it was');
    return answered;
}

/**
 * The whole Android Shorts posting flow, driven through the `DeviceDriver` interface: push the
 * clip, wake and launch YouTube, optionally switch channel, Create → Upload a video → newest cell
 * → Next through the editor → title → description → Public → audience → Upload Short (or keep the
 * draft), then confirm and go Home. Exported so it can be tested without spawning the entrypoint.
 */
export async function postOnAndroid(driver: DeviceDriver, manifest: YouTubePostManifest, options: PostOnAndroidOptions = {}): Promise<void> {
    const timing = timingOf(options);
    const packageName = options.packageName ?? YOUTUBE_ANDROID_PACKAGE;

    const file = manifest.files[0];
    if (!file || manifest.files.length !== 1) {
        throw new DriverError(`A Short is exactly one video; this manifest has ${manifest.files.length} file(s)`);
    }
    if (!manifest.title?.trim()) throw new DriverError('A Short needs a title');
    assertTextIsTypeable(driver, manifest.title, 'title', MAX_TITLE_LENGTH);
    if (manifest.caption) assertTextIsTypeable(driver, manifest.caption, 'description', MAX_DESCRIPTION_LENGTH);

    console.log(`Pushing ${file.name} to the device gallery`);
    await driver.pushMedia({ localPath: file.path, fileName: file.name, mimeType: file.mimeType });

    console.log(`Launching ${packageName} on ${driver.udid}`);
    await driver.pressKey('wake');
    await driver.launchApp(packageName);
    await driver.pause(timing.settleMs, timing.signal);

    const account = manifest.account?.trim();
    if (account) await switchAccount(driver, account, options);

    await tapFirst(driver, 'Create', POST_SELECTORS.create, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);
    await tapFirst(driver, 'Upload a video', POST_SELECTORS.upload, tapping(options));
    await driver.pause(timing.settleMs, timing.signal);

    await selectNewestVideo(driver, options);
    await advanceToDetailsScreen(driver, options);

    await typeInto(driver, 'title field', POST_SELECTORS.titleField, manifest.title, options);
    if (manifest.caption) {
        // Not every build shows a description box on the Shorts details screen.
        if (await isPresent(driver, POST_SELECTORS.descriptionField)) {
            await typeInto(driver, 'description field', POST_SELECTORS.descriptionField, manifest.caption, options);
        } else {
            console.log('No description box on this details screen; the Short goes out with its title only');
        }
    }

    const publishing = manifest.destination === 'publish';
    if (publishing) await setPublicVisibility(driver, options);
    await answerAudience(driver, manifest.madeForKids === true, options);

    await tapFirst(
        driver, publishing ? 'Upload Short' : 'Save draft',
        publishing ? POST_SELECTORS.uploadShort : POST_SELECTORS.saveDraft, tapping(options),
    );
    console.log(publishing ? 'YouTube Short submitted' : 'YouTube Short kept as a draft');

    const confirmation = publishing ? POST_SELECTORS.publishSuccess : POST_SELECTORS.draftSuccess;
    const confirmed = await waitForAny(driver, publishing ? 'the upload confirmation' : 'the draft confirmation', confirmation, {
        timeoutMs: timing.successTimeoutMs, intervalMs: timing.pollIntervalMs, ...(timing.signal ? { signal: timing.signal } : {}),
    });
    console.log(`Confirmed: ${confirmed.text || confirmed.description}`);
    if (publishing) {
        // The upload continues in the background; leave the app alone while it finishes.
        await driver.pause(timing.settleMs * 4, timing.signal);
    }
    // Then go home: a phone left inside YouTube keeps playing whatever it landed on.
    await driver.pressKey('home');
    console.log('Left YouTube on the home screen');
}

export async function runFromManifest(manifestPath: string, signal?: AbortSignal): Promise<void> {
    const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')) as YouTubePostManifest;
    const driver = driverFromEnv();
    await postOnAndroid(driver, manifest, {
        packageName: process.env.YOUTUBE_PACKAGE?.trim() || YOUTUBE_ANDROID_PACKAGE,
        recognize: recognizeOnDevice,
        ...(signal ? { signal } : {}),
    });
}

/** Entrypoint: `node --import tsx src/youtube/android/post.ts <manifest.json>`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const manifestPath = process.argv[2];
    if (!manifestPath) throw new Error('A post manifest path is required');
    // The executor stops a routine with SIGTERM; every pause races the abort so it lands promptly
    // instead of the process being torn down between two taps.
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
    await runFromManifest(manifestPath, controller.signal);
}
