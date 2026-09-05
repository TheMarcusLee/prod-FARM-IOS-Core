import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findByText, walk, type Recognize } from '../../drivers/verify.js';
import { DriverError, type DeviceDriver, type UiNode } from '../../drivers/types.js';
import type { PostManifest } from '../post-manifest.js';
import { driverFromEnv } from './driver-from-env.js';
import {
    isPresent, recognizeOnDevice, screenSummary, tapFirst, tapIfPresent, waitForAny,
    type SelectorList,
} from './ui.js';

export const TIKTOK_ANDROID_PACKAGE = 'com.zhiliaoapp.musically';

/**
 * Every on-screen control this routine touches, in one table.
 *
 * TikTok's Android labels and resource-ids move between builds, regions and A/B buckets, and the
 * exact strings are not knowable without a phone in hand. Each entry is therefore a list of
 * alternates tried in order — correct the list here (and in docs/android-tiktok.md) rather than
 * editing the flow below. Entries marked GUESS have not been confirmed against a real device.
 */
export const POST_SELECTORS = {
    /** Bottom navigation. Content-desc is what TalkBack reads out, so it is the most stable handle. */
    profileTab: [{ id: 'profile_tab' }, { text: 'Profile', exact: true }, { text: 'Me', exact: true }] as SelectorList,
    /** The account name / chevron in the profile header that opens the account list. GUESS. */
    accountSwitcher: [
        { id: 'account_switch' }, { id: 'title_container' }, { id: 'tv_nickname' },
        { text: 'Switch account' }, { text: 'Switch accounts' },
    ] as SelectorList,
    /** The centre "+" in the bottom navigation. */
    create: [{ id: 'create_tab' }, { id: 'iv_create' }, { text: 'Create', exact: true }, { text: 'Add', exact: true }] as SelectorList,
    /** The gallery entry on the camera screen. */
    upload: [{ id: 'upload' }, { id: 'tv_upload' }, { text: 'Upload', exact: true }, { text: 'Gallery', exact: true }] as SelectorList,
    /** Multi-select toggle in the picker; only tapped when more than one file is being posted. GUESS. */
    selectMultiple: [{ id: 'multi_select' }, { text: 'Select multiple' }, { text: 'Multiple' }] as SelectorList,
    /** Advances the picker, then the editor. Both screens label the control "Next". */
    next: [{ id: 'btn_next' }, { id: 'next' }, { text: 'Next', exact: true }] as SelectorList,
    /** The caption box on the publish screen. */
    captionField: [
        { id: 'caption_edit_view' }, { id: 'et_caption' }, { id: 'edit_text' },
        { text: 'Add a caption' }, { text: 'Describe your video' }, { text: 'Add description' },
    ] as SelectorList,
    /** Publish. */
    post: [{ id: 'btn_post' }, { id: 'publish_button' }, { text: 'Post', exact: true }] as SelectorList,
    /** Save without publishing. */
    drafts: [{ id: 'btn_draft' }, { id: 'draft_button' }, { text: 'Drafts', exact: true }, { text: 'Save draft' }] as SelectorList,
    /** What the app shows once the upload has been accepted. GUESS — TikTok varies this string. */
    publishSuccess: [
        { text: 'Your video is being uploaded' }, { text: 'being uploaded' },
        { text: 'Posted' }, { text: 'Uploading' }, { text: 'Your post is being uploaded' },
    ] as SelectorList,
    /** What the app shows after Drafts. GUESS. */
    draftSuccess: [{ text: 'Saved to Drafts' }, { text: 'Draft saved' }, { text: 'Drafts' }] as SelectorList,
    /**
     * Gallery thumbnails carry no text. These are the resource-id fragments and content-desc
     * substrings TikTok's picker cells have been seen with; matching nodes are ordered top-left
     * first, which is newest first in the Recents album. GUESS.
     */
    galleryCellIds: ['iv_image', 'iv_cover', 'image_view', 'album_image', 'cover'] as readonly string[],
    galleryCellDescriptions: ['video', 'photo', 'image'] as readonly string[],
} as const;

export interface PostOnAndroidOptions {
    /** Android package; overridden with TIKTOK_PACKAGE from the environment. */
    packageName?: string;
    /** OCR fallback for screens TikTok draws without accessibility nodes. */
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

/** Picker cells, ordered the way they are laid out: top-left (newest) first. */
export function galleryCells(root: UiNode): UiNode[] {
    const matches = [...walk(root)].filter((node) => {
        const byId = POST_SELECTORS.galleryCellIds.some((id) => node.id === id || node.id.endsWith(`:id/${id}`));
        const description = node.description.toLowerCase();
        const byDescription = description.length > 0
            && POST_SELECTORS.galleryCellDescriptions.some((word) => description.includes(word));
        return byId || byDescription;
    });
    return matches
        .filter(({ bounds }) => bounds.right > bounds.left && bounds.bottom > bounds.top)
        .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
}

/** Media lands in DCIM/Camera newest-last-pushed, so push in reverse to make file 1 the newest cell. */
async function pushAllMedia(driver: DeviceDriver, manifest: PostManifest): Promise<void> {
    const files = [...manifest.files].reverse();
    for (const [index, file] of files.entries()) {
        console.log(`Pushing media ${files.length - index}/${files.length}: ${file.name}`);
        await driver.pushMedia({ localPath: file.path, fileName: file.name, mimeType: file.mimeType });
    }
    console.log(`Pushed ${manifest.files.length} media file(s) to the device gallery`);
}

/**
 * Profile tab → account name dropdown → the row matching the handle, mirroring the iOS routine.
 * The tree makes this cheaper than the iOS OCR version: the handle either is on the profile
 * header already, or it is a row in the switcher sheet.
 */
export async function switchAccount(driver: DeviceDriver, handle: string, options: PostOnAndroidOptions = {}): Promise<void> {
    const timing = timingOf(options);
    console.log(`Switching to TikTok account "${handle}"`);
    await tapFirst(driver, 'Profile tab', POST_SELECTORS.profileTab, options.recognize);
    await driver.pause(timing.settleMs, timing.signal);

    const handleSelector: SelectorList = [{ text: handle }];
    if (await isPresent(driver, handleSelector)) {
        console.log(`Already on TikTok account ${handle}`);
        return;
    }

    await tapFirst(driver, 'account switcher', POST_SELECTORS.accountSwitcher, options.recognize);
    await driver.pause(timing.settleMs, timing.signal);
    await waitForAny(driver, `the account row for ${handle}`, handleSelector, {
        timeoutMs: timing.screenTimeoutMs, intervalMs: timing.pollIntervalMs, ...(timing.signal ? { signal: timing.signal } : {}),
    });
    await tapFirst(driver, `account row for ${handle}`, handleSelector, options.recognize);
    // TikTok reloads app state after a switch.
    await driver.pause(timing.settleMs * 2, timing.signal);

    await tapFirst(driver, 'Profile tab (verify)', POST_SELECTORS.profileTab, options.recognize);
    await driver.pause(timing.settleMs, timing.signal);
    const root = await driver.uiTree();
    if (!findByText(root, { text: handle })) {
        throw new DriverError(`Switched but could not confirm TikTok account "${handle}" is active. Screen showed: ${screenSummary(root)}`);
    }
    console.log(`Confirmed active TikTok account: ${handle}`);
}

async function selectMedia(driver: DeviceDriver, count: number, options: PostOnAndroidOptions): Promise<void> {
    const timing = timingOf(options);
    if (count > 1) {
        await tapIfPresent(driver, 'Select multiple', POST_SELECTORS.selectMultiple, options.recognize);
        await driver.pause(timing.settleMs, timing.signal);
    }
    const root = await driver.uiTree();
    const cells = galleryCells(root);
    if (cells.length < count) {
        throw new DriverError(
            `Gallery picker showed ${cells.length} selectable item(s) but ${count} are needed. Screen showed: ${screenSummary(root)}`,
        );
    }
    for (const [index, cell] of cells.slice(0, count).entries()) {
        const { left, top, right, bottom } = cell.bounds;
        await driver.tap({ x: (left + right) / 2, y: (top + bottom) / 2 });
        console.log(`Tapped media ${index + 1}/${count}`);
        await driver.pause(timing.settleMs, timing.signal);
    }
}

/** Picker Next, then editor Next, stopping as soon as the caption screen is up. */
async function advanceToCaptionScreen(driver: DeviceDriver, options: PostOnAndroidOptions, maxSteps = 3): Promise<void> {
    const timing = timingOf(options);
    for (let step = 1; step <= maxSteps; step += 1) {
        if (await isPresent(driver, POST_SELECTORS.captionField)) {
            console.log('Reached the caption screen');
            return;
        }
        await tapFirst(driver, `Next (${step})`, POST_SELECTORS.next, options.recognize);
        await driver.pause(timing.settleMs, timing.signal);
    }
    if (await isPresent(driver, POST_SELECTORS.captionField)) {
        console.log('Reached the caption screen');
        return;
    }
    throw new DriverError(`Could not reach the TikTok caption screen after ${maxSteps} Next taps. Screen showed: ${screenSummary(await driver.uiTree())}`);
}

async function addCaption(driver: DeviceDriver, caption: string, options: PostOnAndroidOptions): Promise<void> {
    const timing = timingOf(options);
    await tapFirst(driver, 'caption field', POST_SELECTORS.captionField, options.recognize);
    await driver.pause(timing.settleMs, timing.signal);
    await driver.type(caption);
    // Back closes the soft keyboard without leaving the publish form.
    await driver.pressKey('back');
    await driver.pause(timing.settleMs, timing.signal);
    console.log('Caption added');
}

/**
 * The whole Android posting flow, driven through the `DeviceDriver` interface: push media,
 * launch TikTok, optionally switch account, Upload → picker → editor → caption → Post/Drafts,
 * then confirm. Exported so it can be tested without spawning the entrypoint below.
 */
export async function postOnAndroid(driver: DeviceDriver, manifest: PostManifest, options: PostOnAndroidOptions = {}): Promise<void> {
    const timing = timingOf(options);
    const packageName = options.packageName ?? TIKTOK_ANDROID_PACKAGE;

    await pushAllMedia(driver, manifest);

    console.log(`Launching ${packageName} on ${driver.udid}`);
    await driver.launchApp(packageName);
    await driver.pause(timing.settleMs, timing.signal);

    const account = manifest.account?.trim();
    if (account) await switchAccount(driver, account, options);

    await tapFirst(driver, 'Create', POST_SELECTORS.create, options.recognize);
    await driver.pause(timing.settleMs, timing.signal);
    await tapFirst(driver, 'Upload', POST_SELECTORS.upload, options.recognize);
    await driver.pause(timing.settleMs, timing.signal);

    await selectMedia(driver, manifest.files.length, options);
    await advanceToCaptionScreen(driver, options);

    if (manifest.caption) await addCaption(driver, manifest.caption, options);

    const publishing = manifest.destination === 'publish';
    await tapFirst(driver, publishing ? 'Post' : 'Drafts', publishing ? POST_SELECTORS.post : POST_SELECTORS.drafts, options.recognize);
    console.log(publishing ? 'TikTok post submitted' : 'TikTok draft submitted');

    const confirmation = publishing ? POST_SELECTORS.publishSuccess : POST_SELECTORS.draftSuccess;
    const confirmed = await waitForAny(driver, publishing ? 'the upload confirmation' : 'the draft confirmation', confirmation, {
        timeoutMs: timing.successTimeoutMs, intervalMs: timing.pollIntervalMs, ...(timing.signal ? { signal: timing.signal } : {}),
    });
    console.log(`Confirmed: ${confirmed.text || confirmed.description}`);
    if (publishing) {
        // The upload continues in the background; leave the app alone while it finishes.
        await driver.pause(timing.settleMs * 4, timing.signal);
    }
}

/** The manifest's `musicUrl` is an iOS-only deep-link flow and is ignored on Android. */
export async function runFromManifest(manifestPath: string): Promise<void> {
    const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')) as PostManifest;
    if (manifest.musicUrl) console.log('Ignoring musicUrl: the Android routine does not drive the sound deep link yet');
    const driver = driverFromEnv();
    await postOnAndroid(driver, manifest, {
        packageName: process.env.TIKTOK_PACKAGE?.trim() || TIKTOK_ANDROID_PACKAGE,
        recognize: recognizeOnDevice,
    });
}

/** Entrypoint: `node --import tsx src/tiktok/android/post.ts <manifest.json>`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const manifestPath = process.argv[2];
    if (!manifestPath) throw new Error('A post manifest path is required');
    await runFromManifest(manifestPath);
}
