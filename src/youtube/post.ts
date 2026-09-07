import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remote, type Browser } from 'webdriverio';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/backline';
import type { DeviceCoordinates } from '../devices/coordinates.js';
import type { YouTubePostManifest } from './post-manifest.js';
import { YOUTUBE_IOS_BUNDLE_ID } from './app.js';
import { tapCoordinate } from '../tiktok/actions.js';
import { coordinateProfile } from './runtime-settings.js';

/**
 * Posting a Short from an iPhone.
 *
 * XCUITest cannot see into YouTube's Shorts surfaces any more reliably than it can into TikTok's,
 * so this routine drives the same way its TikTok twin does: coordinate taps out of the device's
 * coordinate profile (`youtube` block in `src/devices/coordinates.ts`), with a human hand's jitter
 * on every one of them. **Every one of those points is unverified** — see docs/coordinates.md.
 *
 * The flow is the Android flow: Create (+) → Upload a video → newest clip → Next through the
 * editor → title → visibility → the audience question → Upload Short (or keep the draft).
 */

type YouTubePoints = DeviceCoordinates['youtube'];

function positiveInteger(name: string, fallback: number): number {
    const raw = process.env[name] ?? String(fallback);
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
}

/** WDA's /wda/import-media takes the file base64-encoded in a JSON body; the cap is Node's own. */
async function importVideo(file: { path: string; name: string; mimeType: string }): Promise<void> {
    const wdaUrl = process.env.WDA_URL ?? 'http://127.0.0.1:8100';
    const data = await readFile(file.path);
    if (data.length > 350 * 1024 * 1024) {
        throw new Error(`${file.name} is ${(data.length / 1_048_576).toFixed(0)} MB — the media import limit is 350 MB`);
    }
    console.log(`Importing ${file.name} into the camera roll`);
    const response = await fetch(`${wdaUrl}/wda/import-media`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, mimeType: file.mimeType, data: data.toString('base64') }),
    });
    const result = await response.json() as { value?: { error?: unknown } };
    if (!response.ok || (result.value && typeof result.value === 'object' && 'error' in result.value)) {
        throw new Error(`WDA could not import ${file.name}: ${JSON.stringify(result)}`);
    }
}

/** Appium's /keys endpoint types into whatever has focus, which is how the TikTok routine does it. */
async function typeText(driver: Browser, text: string): Promise<void> {
    const appiumHost = process.env.APPIUM_HOST ?? '127.0.0.1';
    const appiumPort = positiveInteger('APPIUM_PORT', 4725);
    const response = await fetch(`http://${appiumHost}:${appiumPort}/session/${driver.sessionId}/keys`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: [text] }),
    });
    if (!response.ok) throw new Error(`Appium could not type the text: ${await response.text()}`);
    await driver.pause(500);
}

/**
 * The details screen, everything after the clip is chosen. Split out so the flow above it reads as
 * one list, and so a change to the tolerant steps (visibility, audience) is one function.
 */
async function fillDetails(driver: Browser, points: YouTubePoints, manifest: YouTubePostManifest): Promise<void> {
    await tapCoordinate(driver, points.titleField.x, points.titleField.y, 'title field');
    await driver.pause(1_200);
    await typeText(driver, manifest.title);
    await tapCoordinate(driver, points.keyboardBack.x, points.keyboardBack.y, 'keyboard back');
    await driver.pause(1_200);

    if (manifest.caption) {
        await tapCoordinate(driver, points.descriptionField.x, points.descriptionField.y, 'description field');
        await driver.pause(1_200);
        await typeText(driver, manifest.caption);
        await tapCoordinate(driver, points.keyboardBack.x, points.keyboardBack.y, 'keyboard back');
        await driver.pause(1_200);
    }

    if (manifest.destination === 'publish') {
        await tapCoordinate(driver, points.visibility.x, points.visibility.y, 'Visibility');
        await driver.pause(1_500);
        await tapCoordinate(driver, points.publicOption.x, points.publicOption.y, 'Public');
        await driver.pause(1_500);
    }

    // The audience question moves around between builds and is sometimes not asked at all. Tapping
    // where it usually is cannot be verified from here, so it is logged and never fatal.
    await tapCoordinate(driver, points.audience.x, points.audience.y, 'Audience');
    await driver.pause(1_500);
    const answer = manifest.madeForKids === true ? points.publicOption : points.notMadeForKids;
    await tapCoordinate(driver, answer.x, answer.y, manifest.madeForKids ? 'made for kids' : 'not made for kids');
    await driver.pause(1_500);
}

export async function runFromManifest(manifestPath: string): Promise<void> {
    const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')) as YouTubePostManifest;
    const file = manifest.files[0];
    if (!file || manifest.files.length !== 1) {
        throw new Error(`A Short is exactly one video; this manifest has ${manifest.files.length} file(s)`);
    }
    if (!manifest.title?.trim()) throw new Error('A Short needs a title');

    const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === manifest.device.udid);
    const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), registeredDevice?.coordinates);
    const points = coordinates.youtube;

    const deviceRemote = new WdaRemoteControl({
        deviceUdid: manifest.device.udid,
        passcodeKeypadLayout: coordinates.passcodeKeypad,
    });
    console.log('Checking device lock state');
    await deviceRemote.unlock(manifest.device.udid);
    await importVideo(file);

    const bundleId = process.env.YOUTUBE_BUNDLE_ID ?? YOUTUBE_IOS_BUNDLE_ID;
    const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
        platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': manifest.device.udid,
        'appium:bundleId': bundleId, 'appium:noReset': true, 'appium:forceAppLaunch': true,
        'appium:shouldTerminateApp': true, 'appium:newCommandTimeout': 180, 'appium:waitForIdleTimeout': 0,
    };
    if (process.env.WDA_URL) {
        capabilities['appium:webDriverAgentUrl'] = process.env.WDA_URL;
        capabilities['appium:wdaRemotePort'] = positiveInteger('WDA_REMOTE_PORT', 8100);
    }

    const driver = await remote({
        hostname: process.env.APPIUM_HOST ?? '127.0.0.1', port: positiveInteger('APPIUM_PORT', 4725), path: '/',
        logLevel: 'info', connectionRetryCount: 0, connectionRetryTimeout: 180_000, capabilities,
    });
    try {
        await driver.updateSettings({ defaultActiveApplication: bundleId });
        await driver.pause(3_000);

        const account = manifest.account?.trim();
        if (account) {
            // The account list is a sheet behind the avatar; the row is found by its visible name.
            await tapCoordinate(driver, points.accountAvatar.x, points.accountAvatar.y, 'account avatar');
            await driver.pause(2_000);
            const row = await driver.$(`-ios predicate string:(label CONTAINS[c] "${account}") OR (name CONTAINS[c] "${account}")`);
            if (!await row.isExisting()) throw new Error(`Could not find YouTube channel "${account}" in the account list`);
            await row.click();
            console.log(`Switched to YouTube channel ${account}`);
            await driver.pause(4_000);
        }

        await tapCoordinate(driver, points.create.x, points.create.y, 'Create');
        await driver.pause(2_500);
        await tapCoordinate(driver, points.upload.x, points.upload.y, 'Upload a video');
        await driver.pause(3_000);
        await tapCoordinate(driver, points.firstCell.x, points.firstCell.y, 'newest clip');
        await driver.pause(2_500);
        // Trim, then the effects pass. Both label the control Next; a build with only one screen
        // lands on the details screen after the first tap and the second is harmless.
        await tapCoordinate(driver, points.next.x, points.next.y, 'Next (editor)');
        await driver.pause(3_000);
        await tapCoordinate(driver, points.next.x, points.next.y, 'Next (details)');
        await driver.pause(3_000);

        await fillDetails(driver, points, manifest);

        if (manifest.destination === 'publish') {
            await tapCoordinate(driver, points.uploadShort.x, points.uploadShort.y, 'Upload Short');
            console.log('YouTube Short submitted');
            // The upload continues in the background after this tap; do not tear the session down.
            await driver.pause(60_000);
        } else {
            await tapCoordinate(driver, points.saveDraft.x, points.saveDraft.y, 'Save draft');
            console.log('YouTube Short kept as a draft');
            await driver.pause(2_500);
        }
    } finally {
        await driver.deleteSession();
        // A phone left inside the composer is a phone that fails the next run.
        await deviceRemote.performAction(manifest.device.udid, { type: 'home' }).catch(() => {});
    }
}

/** Entrypoint: `node --import tsx src/youtube/post.ts <manifest.json>`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const manifestPath = process.argv[2];
    if (!manifestPath) throw new Error('A post manifest path is required');
    await runFromManifest(manifestPath);
}
