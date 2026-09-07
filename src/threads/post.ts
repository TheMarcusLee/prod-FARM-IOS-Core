import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'webdriverio';

import { tapCoordinate } from '../tiktok/actions.js';
import type { ThreadsCoordinates } from '../devices/coordinates.js';
import {
    bundleId, openSession, prepareDevice, switchThreadsAccount,
} from './ios-session.js';
import { MAX_THREAD_LENGTH, threadFormat, type ThreadsPostManifest } from './post-manifest.js';

/**
 * Posting a thread from an iPhone, through WebDriverAgent.
 *
 * The shape of the run is the Android routine's, with the accessibility tree swapped for the
 * device's `threads` coordinate profile: import the media into Photos, open the composer, write
 * the body, attach the media in manifest order, then Post or keep it as a draft.
 *
 * **Every coordinate is unverified.** See docs/coordinates.md before trusting a run.
 */

async function importMedia(manifest: ThreadsPostManifest): Promise<number> {
    if (!manifest.files.length) return 0;
    const wdaUrl = process.env.WDA_URL ?? 'http://127.0.0.1:8100';
    let assetCount = 0;
    // Photos Recents is newest-first. Reverse import makes cell 0 the operator's first file, which
    // is what makes a carousel come out in the order it was uploaded in.
    for (const [index, file] of [...manifest.files].reverse().entries()) {
        console.log(`Importing media ${manifest.files.length - index}/${manifest.files.length}: ${file.name}`);
        const data = await readFile(file.path);
        // WDA's /wda/import-media takes the whole file base64-encoded in a JSON body; base64 plus
        // JSON.stringify's copy caps the input near Node's max string length, so refuse early.
        if (data.length > 350 * 1024 * 1024) {
            throw new Error(`${file.name} is ${(data.length / 1_048_576).toFixed(0)} MB — the media import limit is 350 MB`);
        }
        const response = await fetch(`${wdaUrl}/wda/import-media`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name, mimeType: file.mimeType, data: data.toString('base64') }),
        });
        const result = await response.json() as { value?: { error?: unknown; assetCount?: number } };
        if (!response.ok || (result.value && typeof result.value === 'object' && 'error' in result.value)) {
            throw new Error(`WDA could not import ${file.name}: ${JSON.stringify(result)}`);
        }
        assetCount = result.value?.assetCount ?? 0;
    }
    if (!assetCount) throw new Error('WDA did not return the Photos asset count');
    return assetCount;
}

/** Types into whatever has focus, through Appium's /keys — the same route the TikTok caption takes. */
async function typeText(driver: Browser, text: string): Promise<void> {
    const host = process.env.APPIUM_HOST ?? '127.0.0.1';
    const port = Number.parseInt(process.env.APPIUM_PORT ?? '4725', 10);
    const response = await fetch(`http://${host}:${port}/session/${driver.sessionId}/keys`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: [text] }),
    });
    if (!response.ok) throw new Error(`Appium could not type the thread text: ${await response.text()}`);
}

/**
 * Threads' picker is a grid three cells wide with the newest first, so the nth manifest file is
 * the nth cell — the same arithmetic the TikTok picker uses.
 */
async function attachMedia(driver: Browser, count: number, coordinates: ThreadsCoordinates): Promise<void> {
    await tapCoordinate(driver, coordinates.attach.x, coordinates.attach.y, 'Attach media');
    await driver.pause(2_500);
    for (let index = 0; index < count; index += 1) {
        const column = index % 3;
        const row = Math.floor(index / 3);
        await tapCoordinate(
            driver,
            coordinates.pickerFirstCell.x + (column * coordinates.pickerColumnStep),
            coordinates.pickerFirstCell.y + (row * coordinates.pickerRowStep),
            `media ${index + 1}/${count}`,
        );
        await driver.pause(700);
    }
    await tapCoordinate(driver, coordinates.pickerAdd.x, coordinates.pickerAdd.y, 'Add');
    await driver.pause(2_500);
}

export async function runFromManifest(manifestPath: string): Promise<void> {
    const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')) as ThreadsPostManifest;
    const udid = process.env.IOS_UDID?.trim() || manifest.device.udid;
    if (!udid) throw new Error('IOS_UDID is required for the iOS Threads routine');

    // Both checks throw before Photos is touched or Threads is opened.
    const format = threadFormat(manifest.files, manifest.text);
    if (manifest.text && manifest.text.length > MAX_THREAD_LENGTH) {
        throw new Error(`Thread text is ${manifest.text.length} characters; Threads accepts at most ${MAX_THREAD_LENGTH}`);
    }
    console.log(`Posting a ${format} thread with ${manifest.files.length} media file(s)`);

    const device = await prepareDevice(udid);
    await importMedia(manifest);

    const driver = await openSession(udid);
    try {
        const account = manifest.account?.trim();
        if (account) {
            await driver.pause(2_000);
            await switchThreadsAccount(driver, device.remote, udid, account, device.threads);
        }
        await driver.activateApp(bundleId());
        await driver.pause(2_500);
        await tapCoordinate(driver, device.threads.compose.x, device.threads.compose.y, 'Compose');
        await driver.pause(2_500);

        if (manifest.text) {
            await tapCoordinate(driver, device.threads.composerField.x, device.threads.composerField.y, 'the composer');
            await driver.pause(800);
            await typeText(driver, manifest.text);
            await driver.pause(500);
            await tapCoordinate(driver, device.threads.keyboardDone.x, device.threads.keyboardDone.y, 'keyboard Done');
            await driver.pause(800);
            console.log(`Wrote ${manifest.text.length} characters`);
        }
        if (manifest.files.length) await attachMedia(driver, manifest.files.length, device.threads);

        if (manifest.destination === 'publish') {
            await tapCoordinate(driver, device.threads.post.x, device.threads.post.y, 'Post');
            console.log('Thread submitted');
            // The upload continues in the background after this tap; tearing the session down too
            // soon can interrupt it.
            await driver.pause(45_000);
        } else {
            // Threads has no Drafts button: leaving the composer offers to keep the draft.
            await tapCoordinate(driver, device.threads.draft.x, device.threads.draft.y, 'Close the composer');
            await driver.pause(1_500);
            await tapCoordinate(driver, device.threads.post.x, device.threads.post.y, 'Save draft');
            console.log('Thread kept as a draft');
            await driver.pause(2_500);
        }
    } finally {
        await driver.deleteSession();
    }
    // A phone left inside Threads keeps whatever it landed on awake.
    await device.remote.performAction(udid, { type: 'home' });
    console.log('Left Threads on the home screen');
}

/** Entrypoint: `node --import tsx src/threads/post.ts <manifest.json>`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const manifestPath = process.argv[2];
    if (!manifestPath) throw new Error('A post manifest path is required');
    await runFromManifest(manifestPath);
}
