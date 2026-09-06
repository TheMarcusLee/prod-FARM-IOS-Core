import { remote, type Browser } from 'webdriverio';

import {
    createMotionSource, gestureActions, loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl,
    type MotionSettings,
} from '@git-agni/backline';
import { coordinateProfile, registeredAccounts } from './runtime-settings.js';
import { switchTikTokAccount, tapCoordinate } from './actions.js';
import { detectEngagementControls } from './engagement-controls.js';
import {
    PROFILES,
    clampToDeadline,
    decideLike,
    decideLinger,
    decideSave,
    hasTimeRemaining,
    isPersonality,
    pickWatchDurationMs,
} from './doomscroll-profile.js';

function positiveInteger(name: string, fallback: number): number {
    const rawValue = process.env[name] ?? String(fallback);
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer; received ${rawValue}`);
    }
    return value;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
    const value = positiveInteger(name, fallback);
    if (value < min || value > max) {
        throw new Error(`${name} must be between ${min} and ${max}; received ${value}`);
    }
    return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`${name} must be 'true' or 'false'; received ${raw}`);
}

const udid = process.env.IOS_UDID;
if (!udid) {
    throw new Error('IOS_UDID is required. Copy .env.example to .env and set the connected device UDID.');
}

const personalityRaw = process.env.DOOMSCROLL_PERSONALITY ?? 'casual';
if (!isPersonality(personalityRaw)) {
    throw new Error(`DOOMSCROLL_PERSONALITY must be one of skimmer, casual, engaged; received ${personalityRaw}`);
}
const personality = personalityRaw;
const profile = PROFILES[personality];

const durationMinutes = boundedInteger('DOOMSCROLL_DURATION_MINUTES', 5, 1, 180);
const likeEnabled = booleanEnv('DOOMSCROLL_LIKE_ENABLED', true);
const saveEnabled = booleanEnv('DOOMSCROLL_SAVE_ENABLED', true);
const switchAccountName = process.env.TIKTOK_SWITCH_ACCOUNT?.trim() || undefined;
const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === udid);
const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), registeredDevice?.coordinates);
const tiktokCoordinates = coordinates.tiktok;
const accountSwitchCoords = {
    profileTabX: tiktokCoordinates.profileTab.x,
    profileTabY: tiktokCoordinates.profileTab.y,
    switcherTriggerX: tiktokCoordinates.accountSwitcher.x,
    switcherTriggerY: tiktokCoordinates.accountSwitcher.y,
};
// switchTikTokAccount ends on the Profile tab (it re-checks there to verify
// the switch). The scroll loop below expects the Home feed, so only
// doomscroll needs to navigate back — tiktok-post.ts's Create button works
// from any bottom-nav tab.
const { x: homeTabX, y: homeTabY } = tiktokCoordinates.homeTab;

// Fail fast, before unlocking or launching TikTok, if the requested account
// isn't one this device is registered for.
const allowedAccounts = switchAccountName
    ? registeredAccounts(registeredDevice)
    : [];
if (switchAccountName && !allowedAccounts.includes(switchAccountName)) {
    throw new Error(`TikTok account "${switchAccountName}" is not listed in devices.json for device ${udid}`);
}
let { x: likeX, y: likeY } = tiktokCoordinates.like;
let { x: saveX, y: saveY } = tiktokCoordinates.save;
const screenSize = coordinates.screenSize;
const wdaUrl = process.env.WDA_URL;
const tiktokBundleId = process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically';

const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': udid,
    'appium:bundleId': tiktokBundleId,
    'appium:noReset': true,
    'appium:forceAppLaunch': true,
    'appium:shouldTerminateApp': true,
    'appium:newCommandTimeout': 120,
    'appium:wdaLaunchTimeout': 120000,
    'appium:wdaConnectionTimeout': 120000,
    // TikTok's video feed never becomes fully idle. Waiting for quiescence can
    // make otherwise-completed gestures block until the WDA proxy times out.
    'appium:waitForIdleTimeout': 0,
    'appium:showXcodeLog': process.env.SHOW_XCODE_LOG === 'true',
};

if (wdaUrl) {
    capabilities['appium:webDriverAgentUrl'] = wdaUrl;
    capabilities['appium:wdaRemotePort'] = positiveInteger('WDA_REMOTE_PORT', 8100);
} else if (process.env.XCODE_ORG_ID) {
    capabilities['appium:xcodeOrgId'] = process.env.XCODE_ORG_ID;
    capabilities['appium:xcodeSigningId'] = process.env.XCODE_SIGNING_ID ?? 'Apple Development';
}
if (!wdaUrl && process.env.WDA_BUNDLE_ID) {
    capabilities['appium:updatedWDABundleId'] = process.env.WDA_BUNDLE_ID;
}
if (!wdaUrl && process.env.ALLOW_PROVISIONING_DEVICE_REGISTRATION === 'true') {
    capabilities['appium:allowProvisioningDeviceRegistration'] = true;
}
if (!wdaUrl && process.env.WDA_BOOTSTRAP_PATH) {
    capabilities['appium:useXctestrunFile'] = true;
    capabilities['appium:bootstrapPath'] = process.env.WDA_BOOTSTRAP_PATH;
}

// Cooperative cancellation: a Stop request sends SIGTERM (see
// src/automations/runner.ts). Every wait below races against stopPromise so
// a stop interrupts immediately instead of waiting out the current sleep.
let stopRequested = false;
let resolveStop: () => void = () => {};
const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        stopRequested = true;
        resolveStop();
    });
}

function cancellableDelay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        void stopPromise.then(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/**
 * Everything this run does — every arc, every pause — is drawn from this one seed, so a run can
 * be replayed from its execution id (the executor exports it as MOTION_SEED) and is different
 * from every other run. Handedness and pace come from the device's registration.
 */
const motionSeed = process.env.MOTION_SEED ?? `${Date.now()}:${udid}`;
const motionSettings: MotionSettings = {
    ...(process.env.MOTION_HAND === 'right' || process.env.MOTION_HAND === 'left' ? { hand: process.env.MOTION_HAND } : {}),
    ...(process.env.MOTION_SPEED === 'slow' || process.env.MOTION_SPEED === 'normal' || process.env.MOTION_SPEED === 'fast'
        ? { speed: process.env.MOTION_SPEED } : {}),
};
const motion = createMotionSource({ udid, seed: motionSeed, settings: motionSettings });

/**
 * The flick to the next video. Coordinate actions bypass XCTest's expensive application-element
 * lookup, which can hang on TikTok's continuously updating feed — but instead of the same two
 * points every time, the pointer follows a generated thumb arc: jittered start inside the thumb
 * zone, a slight bow, and uneven speed within the stroke (src/motion/gesture.ts).
 */
async function swipeToNextVideo(session: Browser): Promise<void> {
    const path = motion.swipe(screenSize, { direction: 'up' });
    await session.performActions(gestureActions(path) as unknown as Parameters<Browser['performActions']>[0]);
    await session.releaseActions();
}

async function doubleTapCoordinate(driver: Browser, x: number, y: number, label: string): Promise<void> {
    await tapCoordinate(driver, x, y, label);
    // Short, fixed gap so TikTok's gesture recognizer reads this as a
    // double-tap-to-like rather than two separate taps.
    await driver.pause(130);
    await tapCoordinate(driver, x, y, label);
}

let driver: Browser | undefined;
let videosViewed = 0;
let swipes = 0;
let likes = 0;
let saves = 0;
const runStartedAt = Date.now();

// ±15%: nobody puts the phone down after exactly the number of minutes they meant to.
const sessionMinutes = durationMinutes * (0.85 + motion.random() * 0.3);

console.log(
    `Starting doomscroll: seed=${motionSeed} hand=${motion.profile.hand} speed=${motion.profile.speed} `
    + `profile=${personality} requestedDurationMinutes=${durationMinutes} `
    + `sessionMinutes=${sessionMinutes.toFixed(1)} likeEnabled=${likeEnabled} saveEnabled=${saveEnabled}`,
);

try {
    const remoteControl = new WdaRemoteControl({
        deviceUdid: udid,
        wdaUrl,
        passcodeKeypadLayout: coordinates.passcodeKeypad,
    });
    console.log('Checking device lock state');
    await remoteControl.unlock(udid);

    console.log(`Opening TikTok on ${udid}`);
    driver = await remote({
        hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
        port: positiveInteger('APPIUM_PORT', 4725),
        path: '/',
        logLevel: 'info',
        connectionRetryCount: 0,
        connectionRetryTimeout: 180000,
        capabilities,
    });

    await driver.updateSettings({ defaultActiveApplication: tiktokBundleId });
    await driver.pause(motion.pause('afterOpenApp'));

    if (switchAccountName) {
        console.log(`Switching to TikTok account "${switchAccountName}"`);
        await switchTikTokAccount(driver, remoteControl, udid, switchAccountName, accountSwitchCoords);
        // switchTikTokAccount leaves the app on the Profile tab; the loop
        // below expects the Home feed.
        await tapCoordinate(driver, homeTabX, homeTabY, 'Home tab');
        await driver.pause(motion.pause('reaction'));
    }

    try {
        const [screenshot, screen] = await Promise.all([
            remoteControl.getScreenshot(udid),
            remoteControl.getScreenInfo(udid),
        ]);
        const detected = await detectEngagementControls(screenshot, screen.scale);
        if (detected) {
            ({ x: likeX, y: likeY } = detected.like);
            ({ x: saveX, y: saveY } = detected.save);
            console.log(`Detected TikTok engagement controls: like=(${likeX}, ${likeY}) save=(${saveX}, ${saveY}) confidence=${detected.confidence.toFixed(3)}`);
        } else {
            console.log(`Could not confidently detect TikTok engagement controls; using ${coordinateProfile(registeredDevice)} profile coordinates`);
        }
    } catch (error) {
        console.log(`Engagement control detection failed; using profile coordinates: ${error instanceof Error ? error.message : String(error)}`);
    }

    const deadline = Date.now() + sessionMinutes * 60_000;

    while (!stopRequested && hasTimeRemaining(Date.now(), deadline)) {
        await cancellableDelay(clampToDeadline(Date.now(), deadline, pickWatchDurationMs(profile)));
        videosViewed += 1;
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (likeEnabled && decideLike(profile)) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, motion.pause('beforeLike')));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            await doubleTapCoordinate(driver, likeX, likeY, 'Like');
            likes += 1;
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (saveEnabled && decideSave(profile)) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, motion.pause('afterLike')));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            await tapCoordinate(driver, saveX, saveY, 'Save');
            saves += 1;
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        const { linger, extraMs } = decideLinger(profile);
        if (linger) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, extraMs));
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        await cancellableDelay(clampToDeadline(Date.now(), deadline, motion.pause('beforeSwipe')));
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        await swipeToNextVideo(driver);
        swipes += 1;
    }

    const elapsedMs = Date.now() - runStartedAt;
    const reason = stopRequested ? 'stopped' : 'completed';
    console.log(`Finished doomscroll: videosViewed=${videosViewed} swipes=${swipes} likes=${likes} saves=${saves} elapsedMs=${elapsedMs} reason=${reason}`);
} finally {
    if (driver) {
        await driver.deleteSession();
    }
}
