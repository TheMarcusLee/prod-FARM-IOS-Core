import { remote, type Browser } from 'webdriverio';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/backline';
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
import { decideForVideo, decideSearch } from '../persona/decide.js';
import { personaFor } from '../persona/model.js';
import { readMemory, writeMemory } from '../persona/memory.js';
import { findWordBounds, readVideo } from '../persona/observe.js';
import { beginSession, describeSession, finishSession, noteDecision, noteSearch } from '../persona/session.js';
import type { Recognize } from '../drivers/verify.js';

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

const explicitDurationMinutes = process.env.DOOMSCROLL_DURATION_MINUTES === undefined
    ? undefined : boundedInteger('DOOMSCROLL_DURATION_MINUTES', 5, 1, 180);
const likeEnabled = booleanEnv('DOOMSCROLL_LIKE_ENABLED', true);
const saveEnabled = booleanEnv('DOOMSCROLL_SAVE_ENABLED', true);
const switchAccountName = process.env.TIKTOK_SWITCH_ACCOUNT?.trim() || undefined;
const followEnabled = booleanEnv('DOOMSCROLL_FOLLOW_ENABLED', true);
const searchEnabled = booleanEnv('DOOMSCROLL_SEARCH_ENABLED', true);

/**
 * The persona replaces the three personality profiles when the account has one. A persona is keyed
 * by handle, so a run that does not switch accounts has no persona to be and keeps the old model.
 * Session length, budgets and active hours all come from `sessionPlan`; an explicit
 * DOOMSCROLL_DURATION_MINUTES still wins, and is also how an operator overrides the sleep window.
 */
const persona = booleanEnv('DOOMSCROLL_PERSONA', false) && switchAccountName
    ? await personaFor(switchAccountName) : undefined;
const personaMemory = persona ? await readMemory(persona.handle) : undefined;
const session = persona && personaMemory ? beginSession(persona, personaMemory, Math.random, new Date()) : undefined;
if (session && !session.plan.active && explicitDurationMinutes === undefined) {
    console.log(`Not scrolling as ${persona!.handle}: ${session.plan.reason}`);
    process.exit(0);
}
const durationMinutes = explicitDurationMinutes ?? session?.plan.minutes ?? 5;
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
const { x: swipeX, startY: swipeStartY, endY: swipeEndY, durationMs: swipeDurationMs } = tiktokCoordinates.swipe;
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

function interactionPauseMs(): number {
    return Math.round(200 + Math.random() * 400);
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
let follows = 0;
let searches = 0;
const runStartedAt = Date.now();

console.log(session
    ? `Starting doomscroll as ${persona!.handle}: ${session.plan.reason}`
    : `Starting doomscroll: profile=${personality} requestedDurationMinutes=${durationMinutes} likeEnabled=${likeEnabled} saveEnabled=${saveEnabled}`);

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
    await driver.pause(3000);

    if (switchAccountName) {
        console.log(`Switching to TikTok account "${switchAccountName}"`);
        await switchTikTokAccount(driver, remoteControl, udid, switchAccountName, accountSwitchCoords);
        // switchTikTokAccount leaves the app on the Profile tab; the loop
        // below expects the Home feed.
        await tapCoordinate(driver, homeTabX, homeTabY, 'Home tab');
        await driver.pause(1500);
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

    /**
     * XCUITest cannot see into TikTok's feed, so on iOS everything the persona reads — the caption,
     * the hashtags, the creator, and the Follow button it might tap — comes from OCR over a
     * screenshot. One screenshot per video is the price of behaving like a person rather than a
     * coin flip. The recognizer is imported lazily so a run with no persona never loads it.
     */
    const recognize: Recognize = async (png) => {
        const { recognizeWords } = await import('./ocr.js');
        return (await recognizeWords(png)).map((word) => ({
            text: word.text,
            bounds: { left: word.x, top: word.y, right: word.x + word.width, bottom: word.y + word.height },
        }));
    };
    const videoSource = { screenshot: () => remoteControl.getScreenshot(udid) };
    const screenScale = (await remoteControl.getScreenInfo(udid).catch(() => undefined))?.scale ?? 1;
    /** Taps a word OCR can see. A control that is not on screen is skipped, never fatal. */
    const tapWord = async (browser: Browser, word: string, label: string): Promise<boolean> => {
        let bounds;
        try {
            bounds = findWordBounds(await recognize(await remoteControl.getScreenshot(udid)), word);
        } catch { bounds = undefined; }
        if (!bounds) {
            console.log(`Skipped ${label}: not on screen`);
            return false;
        }
        // OCR reads the PNG's pixel grid; iOS taps are in points.
        await tapCoordinate(browser, (bounds.left + bounds.right) / 2 / screenScale, (bounds.top + bounds.bottom) / 2 / screenScale, label);
        return true;
    };

    const deadline = Date.now() + durationMinutes * 60_000;

    while (!stopRequested && hasTimeRemaining(Date.now(), deadline)) {
        // One decision model or the other. With a persona the video on screen is read first and
        // every choice below comes out of `decideForVideo`; without one it is the old coin flips.
        const video = session ? await readVideo(videoSource, recognize) : undefined;
        const decision = session && persona && video ? decideForVideo(persona, video, session.state, Math.random) : undefined;
        if (decision) console.log(decision.reason);

        await cancellableDelay(clampToDeadline(Date.now(), deadline, decision ? decision.watchMs : pickWatchDurationMs(profile)));
        videosViewed += 1;
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (likeEnabled && (decision ? decision.like : decideLike(profile))) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            await doubleTapCoordinate(driver, likeX, likeY, 'Like');
            likes += 1;
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (saveEnabled && (decision ? decision.save : decideSave(profile))) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            await tapCoordinate(driver, saveX, saveY, 'Save');
            saves += 1;
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (decision?.follow && followEnabled) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            if (await tapWord(driver, 'Follow', 'Follow')) follows += 1;
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (session && video && decision) {
            noteDecision(session, video, decision);
        } else {
            // The persona folds its curiosity into the watch time; only the profile model lingers.
            const { linger, extraMs } = decideLinger(profile);
            if (linger) {
                await cancellableDelay(clampToDeadline(Date.now(), deadline, extraMs));
            }
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        // Occasionally the account goes looking for its own niche instead of taking the feed's
        // word for it. There is no Back button on iOS, so the return trip is the Home tab.
        const search = session && persona && searchEnabled ? decideSearch(persona, session.state, Math.random) : undefined;
        if (search && session) {
            console.log(search.reason);
            if (await tapWord(driver, 'Search', 'Search')) {
                await cancellableDelay(1_500);
                await driver.keys(search.term);
                await driver.keys(['Enter']);
                await cancellableDelay(4_000);
                // Dwell on the results the way somebody reading them would, then go home.
                await cancellableDelay(clampToDeadline(Date.now(), deadline, 4_000 + Math.round(Math.random() * 6_000)));
                await tapCoordinate(driver, homeTabX, homeTabY, 'Home tab');
                await cancellableDelay(1_500);
                noteSearch(session, search);
                searches += 1;
            }
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        // Coordinate actions bypass XCTest's expensive application-element
        // lookup, which can hang on TikTok's continuously updating feed.
        await driver.performActions([{
            type: 'pointer',
            id: 'finger',
            parameters: { pointerType: 'touch' },
            actions: [
                { type: 'pointerMove', duration: 0, x: swipeX, y: swipeStartY },
                { type: 'pointerDown', button: 0 },
                { type: 'pause', duration: 100 },
                { type: 'pointerMove', duration: swipeDurationMs, x: swipeX, y: swipeEndY },
                { type: 'pointerUp', button: 0 },
            ],
        }]);
        await driver.releaseActions();
        swipes += 1;
    }

    const elapsedMs = Date.now() - runStartedAt;
    const reason = stopRequested ? 'stopped' : 'completed';
    if (session && persona) {
        finishSession(session, { minutes: elapsedMs / 60_000, ending: reason });
        console.log(`Finished doomscroll as ${persona.handle}: ${describeSession(session)} · ${reason}`);
        await writeMemory(session.memory);
    } else {
        console.log(`Finished doomscroll: videosViewed=${videosViewed} swipes=${swipes} likes=${likes} saves=${saves} elapsedMs=${elapsedMs} reason=${reason}`);
    }
} finally {
    if (driver) {
        await driver.deleteSession();
    }
}
