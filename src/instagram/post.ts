import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { remote, type Browser } from 'webdriverio';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/backline';
import { assertFormat, MAX_CAPTION_LENGTH, type InstagramPostManifest } from './post-manifest.js';
import type { InstagramCoordinates } from './coordinates.js';
import { coordinateProfile, registeredAccounts } from './runtime-settings.js';
import { tapCoordinate } from '../tiktok/actions.js';
import { findHandleMatch, pointFromWord, recognizeWords } from '../tiktok/ocr.js';

/**
 * The iOS Instagram post routine: WebDriverAgent + XCUITest, driven from the device's coordinate
 * profile exactly the way `src/tiktok/post.ts` is.
 *
 * XCUITest can barely see inside Instagram — most of the composer is drawn rather than built from
 * accessibility elements — so, as with TikTok on iOS, this is a coordinate flow with OCR only
 * where a *value* has to be read back (which account is active). Every coordinate comes from the
 * profile's `instagram` section, and **every one of those defaults is unverified**: calibrate them
 * before trusting a publish. See docs/coordinates.md and docs/instagram.md.
 *
 * Entrypoint: `node --import tsx src/instagram/post.ts <manifest.json>`.
 */

function positiveInteger(name: string, fallback: number): number {
    const raw = process.env[name] ?? String(fallback);
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
}

/** Photos Recents is newest-first, so a reversed import makes cell 0 the manifest's first file. */
async function importMedia(manifest: InstagramPostManifest): Promise<number> {
    const wdaUrl = process.env.WDA_URL ?? 'http://127.0.0.1:8100';
    let assetCount = 0;
    for (const [index, file] of [...manifest.files].reverse().entries()) {
        console.log(`Importing media ${manifest.files.length - index}/${manifest.files.length}: ${file.name}`);
        const data = await readFile(file.path);
        // WDA's /wda/import-media takes the whole file base64-encoded in a JSON body; base64 plus
        // JSON.stringify's second copy caps the input well below Node's max string length.
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

/**
 * Profile tab → the username in the header → the row for the handle, then back to the profile to
 * check. The check is OCR because the header is the one place Instagram reliably renders the
 * active handle as text; posting from the wrong account is the failure that cannot be undone, so
 * the routine refuses to continue without confirming it.
 */
async function switchInstagramAccount(
    driver: Browser, remoteControl: WdaRemoteControl, udid: string, handle: string, coordinates: InstagramCoordinates,
): Promise<void> {
    await tapCoordinate(driver, coordinates.profileTab.x, coordinates.profileTab.y, 'Profile tab');
    await driver.pause(2_000);

    const { scale } = await remoteControl.getScreenInfo(udid);
    if (findHandleMatch(await recognizeWords(await remoteControl.getScreenshot(udid)), handle)) {
        console.log(`Already on Instagram account ${handle}`);
        return;
    }

    await tapCoordinate(driver, coordinates.accountSwitcher.x, coordinates.accountSwitcher.y, 'Account switcher');
    await driver.pause(1_500);
    const switcherWords = await recognizeWords(await remoteControl.getScreenshot(udid));
    const match = findHandleMatch(switcherWords, handle);
    if (!match) {
        const seen = switcherWords.map((word) => word.text).join(', ') || '(nothing recognized)';
        throw new Error(`Could not find Instagram account "${handle}" in the account switcher. OCR saw: ${seen}`);
    }
    const point = pointFromWord(match, scale);
    await tapCoordinate(driver, point.x, point.y, `Account row for ${handle}`);
    // Instagram fully reloads app state after switching accounts.
    await driver.pause(4_000);

    await tapCoordinate(driver, coordinates.profileTab.x, coordinates.profileTab.y, 'Profile tab (verify)');
    await driver.pause(1_500);
    if (!findHandleMatch(await recognizeWords(await remoteControl.getScreenshot(udid)), handle)) {
        throw new Error(`Switched but could not confirm Instagram account "${handle}" is active afterward`);
    }
    console.log(`Confirmed active Instagram account: ${handle}`);
}

/** Picker cell centres for the newest `count` items, newest first. */
function pickerTargets(assetCount: number, count: number, picker: InstagramCoordinates['picker']): Array<{ x: number; y: number }> {
    if (!Number.isSafeInteger(assetCount) || assetCount < count || count < 1) {
        throw new Error('Photos asset count cannot satisfy the requested media selection');
    }
    const latestIndex = assetCount - 1;
    const latestRow = Math.floor(latestIndex / 3);
    return Array.from({ length: count }, (_, selection) => {
        const assetIndex = latestIndex - selection;
        return {
            x: picker.cellX + ((assetIndex % 3) * picker.cellStep),
            y: picker.cellY + ((latestRow - Math.floor(assetIndex / 3)) * picker.rowStep),
        };
    });
}

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('An Instagram post manifest path is required');
const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')) as InstagramPostManifest;

// Format and media are checked before the phone is unlocked: a mismatch found later leaves an
// orphan asset in Photos and a half-open composer.
assertFormat(manifest.format, manifest.files);
if (manifest.caption && manifest.caption.length > MAX_CAPTION_LENGTH) {
    throw new Error(`Caption is ${manifest.caption.length} characters; Instagram accepts at most ${MAX_CAPTION_LENGTH}`);
}

const switchAccountName = manifest.account?.trim() || undefined;
const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === manifest.device.udid);
const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), registeredDevice?.coordinates);
const instagram = coordinates.instagram;

// Fail fast, before unlocking or launching Instagram, if the requested account is one this device
// has never been told about. An empty list means "nobody said", not "nobody is signed in".
const allowedAccounts = switchAccountName ? registeredAccounts(registeredDevice) : [];
if (switchAccountName && allowedAccounts.length && !allowedAccounts.includes(switchAccountName)) {
    throw new Error(`Instagram account "${switchAccountName}" is not listed in devices.json for device ${manifest.device.udid}`);
}

const deviceRemote = new WdaRemoteControl({
    deviceUdid: manifest.device.udid,
    passcodeKeypadLayout: coordinates.passcodeKeypad,
});
console.log('Checking device lock state');
await deviceRemote.unlock(manifest.device.udid);

const assetCount = await importMedia(manifest);

const bundleId = process.env.INSTAGRAM_BUNDLE_ID ?? 'com.burbn.instagram';
const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': manifest.device.udid,
    'appium:bundleId': bundleId, 'appium:noReset': true, 'appium:forceAppLaunch': true,
    'appium:shouldTerminateApp': true, 'appium:newCommandTimeout': 180,
    'appium:waitForIdleTimeout': 0,
};
if (process.env.WDA_URL) {
    capabilities['appium:webDriverAgentUrl'] = process.env.WDA_URL;
    capabilities['appium:wdaRemotePort'] = positiveInteger('WDA_REMOTE_PORT', 8100);
}

console.log(`Posting a ${manifest.format} to Instagram on ${manifest.device.udid}`);
const driver: Browser = await remote({
    hostname: process.env.APPIUM_HOST ?? '127.0.0.1', port: positiveInteger('APPIUM_PORT', 4725),
    path: '/', logLevel: 'info', connectionRetryCount: 0, connectionRetryTimeout: 180_000, capabilities,
});

try {
    await driver.updateSettings({ defaultActiveApplication: bundleId });
    await driver.pause(2_500);

    if (switchAccountName) {
        console.log(`Switching to Instagram account "${switchAccountName}"`);
        await switchInstagramAccount(driver, deviceRemote, manifest.device.udid, switchAccountName, instagram);
    }

    await tapCoordinate(driver, instagram.create.x, instagram.create.y, 'Create');
    await driver.pause(2_500);
    // The surface strip under the picker. A build that opened straight onto the right surface just
    // takes a harmless tap in the same row.
    const surface = manifest.format === 'reel' ? instagram.reelTab : instagram.postTab;
    await tapCoordinate(driver, surface.x, surface.y, manifest.format === 'reel' ? 'REEL' : 'POST');
    await driver.pause(2_500);

    if (manifest.files.length > 1) {
        await tapCoordinate(driver, instagram.selectMultiple.x, instagram.selectMultiple.y, 'Select multiple');
        await driver.pause(1_000);
    }
    for (const [selection, { x, y }] of pickerTargets(assetCount, manifest.files.length, instagram.picker).entries()) {
        await tapCoordinate(driver, x, y, `media ${selection + 1}/${manifest.files.length}`);
        await driver.pause(700);
    }

    await tapCoordinate(driver, instagram.pickerNext.x, instagram.pickerNext.y, 'picker Next');
    await driver.pause(3_000);
    await tapCoordinate(driver, instagram.editorNext.x, instagram.editorNext.y, 'editor Next');
    await driver.pause(3_000);

    if (manifest.caption) {
        await tapCoordinate(driver, instagram.caption.x, instagram.caption.y, 'caption');
        await driver.pause(800);
        await driver.keys(manifest.caption);
        await driver.pause(500);
        await tapCoordinate(driver, instagram.keyboardBack.x, instagram.keyboardBack.y, 'keyboard Back');
        console.log('Caption added');
    }

    if (manifest.destination === 'publish') {
        await tapCoordinate(driver, instagram.share.x, instagram.share.y, 'Share');
        console.log('Instagram post submitted');
        // The upload continues in the background after this tap; tearing the session down too soon
        // can interrupt it.
        await driver.pause(60_000);
    } else {
        // Instagram has no Drafts button on the share screen — backing out of it is what offers one.
        await tapCoordinate(driver, instagram.keyboardBack.x, instagram.keyboardBack.y, 'back out of the share screen');
        await driver.pause(1_500);
        await tapCoordinate(driver, instagram.draft.x, instagram.draft.y, 'Save draft');
        console.log('Instagram draft saved');
        await driver.pause(2_500);
    }
} finally {
    await driver.deleteSession();
}
