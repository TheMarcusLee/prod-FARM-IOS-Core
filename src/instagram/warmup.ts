import { remote, type Browser } from 'webdriverio';

import {
    createMotionSource, gestureActions, loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl,
    type MotionSettings,
} from '@git-agni/backline';
import type { InstagramCoordinates } from './coordinates.js';
import { coordinateProfile } from './runtime-settings.js';
import { tapCoordinate } from '../tiktok/actions.js';
import {
    PROFILES, clampToDeadline, decideLike, decideLinger, decideSave, hasTimeRemaining, isPersonality,
    pickWatchDurationMs,
} from '../tiktok/doomscroll-profile.js';
import { decideForVideo, decideSearch } from '../persona/decide.js';
import { personaFor } from '../persona/model.js';
import { readMemory, writeMemory } from '../persona/memory.js';
import { findWordBounds, readVideo } from '../persona/observe.js';
import { beginSession, describeSession, finishSession, noteDecision, noteSearch } from '../persona/session.js';
import type { Recognize } from '../drivers/verify.js';
import { isWarmupSurface } from './android/warmup.js';

/**
 * The iOS Instagram warm-up: WebDriverAgent + XCUITest, coordinate-driven from the device's
 * profile, mirroring `src/tiktok/doomscroll.ts`.
 *
 * XCUITest cannot see into Instagram's feed or reels, so everything the persona reads — the
 * caption, the hashtags, the creator, the Follow button it might tap — comes from OCR over a
 * screenshot, and everything it taps comes from the profile's `instagram` section. **Those
 * defaults are unverified**; see docs/coordinates.md.
 *
 * Entrypoint: `node --import tsx src/instagram/warmup.ts`.
 */

function positiveInteger(name: string, fallback: number): number {
    const raw = process.env[name] ?? String(fallback);
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer; received ${raw}`);
    return value;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
    const value = positiveInteger(name, fallback);
    if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}; received ${value}`);
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
if (!udid) throw new Error('IOS_UDID is required for the iOS Instagram warm-up');

const personality = process.env.WARMUP_PERSONALITY ?? 'casual';
if (!isPersonality(personality)) {
    throw new Error(`WARMUP_PERSONALITY must be one of skimmer, casual, engaged; received ${personality}`);
}
const surface = process.env.WARMUP_SURFACE ?? 'both';
if (!isWarmupSurface(surface)) {
    throw new Error(`WARMUP_SURFACE must be one of feed, reels, both; received ${surface}`);
}
const profile = PROFILES[personality];
const explicitDurationMinutes = process.env.WARMUP_DURATION_MINUTES === undefined
    ? undefined : boundedInteger('WARMUP_DURATION_MINUTES', 5, 1, 180);
const likeEnabled = booleanEnv('WARMUP_LIKE_ENABLED', true);
const saveEnabled = booleanEnv('WARMUP_SAVE_ENABLED', true);
const followEnabled = booleanEnv('WARMUP_FOLLOW_ENABLED', true);
const searchEnabled = booleanEnv('WARMUP_SEARCH_ENABLED', true);
const switchAccountName = process.env.INSTAGRAM_SWITCH_ACCOUNT?.trim() || undefined;

const persona = booleanEnv('WARMUP_PERSONA', false) && switchAccountName
    ? await personaFor(switchAccountName) : undefined;
const personaMemory = persona ? await readMemory(persona.handle) : undefined;
const session = persona && personaMemory ? beginSession(persona, personaMemory, Math.random, new Date()) : undefined;
if (session && !session.plan.active && explicitDurationMinutes === undefined) {
    console.log(`Not warming up as ${persona!.handle}: ${session.plan.reason}`);
    process.exit(0);
}
const durationMinutes = explicitDurationMinutes ?? session?.plan.minutes ?? 5;

const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === udid);
const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), registeredDevice?.coordinates);
const instagram: InstagramCoordinates = coordinates.instagram;
const screenSize = coordinates.screenSize;
const wdaUrl = process.env.WDA_URL;
const bundleId = process.env.INSTAGRAM_BUNDLE_ID ?? 'com.burbn.instagram';

const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': udid,
    'appium:bundleId': bundleId, 'appium:noReset': true, 'appium:forceAppLaunch': true,
    'appium:shouldTerminateApp': true, 'appium:newCommandTimeout': 120,
    'appium:wdaLaunchTimeout': 120_000, 'appium:wdaConnectionTimeout': 120_000,
    // Instagram's video surfaces never become fully idle; waiting for quiescence makes otherwise
    // completed gestures block until the WDA proxy times out.
    'appium:waitForIdleTimeout': 0,
};
if (wdaUrl) {
    capabilities['appium:webDriverAgentUrl'] = wdaUrl;
    capabilities['appium:wdaRemotePort'] = positiveInteger('WDA_REMOTE_PORT', 8100);
}

// Cooperative cancellation: Stop sends SIGTERM, and every wait races it so the run ends between
// two taps rather than being torn down mid-gesture.
let stopRequested = false;
let resolveStop: () => void = () => {};
const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { stopRequested = true; resolveStop(); });
}

function cancellableDelay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        void stopPromise.then(() => { clearTimeout(timer); resolve(); });
    });
}

const motionSeed = process.env.MOTION_SEED ?? `${Date.now()}:${udid}`;
const motionSettings: MotionSettings = {
    ...(process.env.MOTION_HAND === 'right' || process.env.MOTION_HAND === 'left' ? { hand: process.env.MOTION_HAND } : {}),
    ...(process.env.MOTION_SPEED === 'slow' || process.env.MOTION_SPEED === 'normal' || process.env.MOTION_SPEED === 'fast'
        ? { speed: process.env.MOTION_SPEED } : {}),
};
const motion = createMotionSource({ udid, seed: motionSeed, settings: motionSettings });

async function swipeToNextPost(browser: Browser): Promise<void> {
    const path = motion.swipe(screenSize, { direction: 'up' });
    await browser.performActions(gestureActions(path) as unknown as Parameters<Browser['performActions']>[0]);
    await browser.releaseActions();
}

let driver: Browser | undefined;
let postsViewed = 0;
let swipes = 0;
let likes = 0;
let saves = 0;
let follows = 0;
let searches = 0;
let surfaceSwitches = 0;
const runStartedAt = Date.now();
// ±15%: nobody puts the phone down after exactly the number of minutes they meant to.
const sessionLength = durationMinutes * (0.85 + motion.random() * 0.3);

console.log(
    `Starting Instagram warm-up${session ? ` as ${persona!.handle}` : ''}: seed=${motionSeed} hand=${motion.profile.hand} `
    + `speed=${motion.profile.speed} surface=${surface} `
    + (session ? `plan=${session.plan.reason} ` : `profile=${personality} `)
    + `requestedDurationMinutes=${durationMinutes} sessionMinutes=${sessionLength.toFixed(1)} `
    + `likeEnabled=${likeEnabled} saveEnabled=${saveEnabled}`,
);

try {
    const remoteControl = new WdaRemoteControl({
        deviceUdid: udid, wdaUrl, passcodeKeypadLayout: coordinates.passcodeKeypad,
    });
    console.log('Checking device lock state');
    await remoteControl.unlock(udid);

    console.log(`Opening Instagram on ${udid}`);
    driver = await remote({
        hostname: process.env.APPIUM_HOST ?? '127.0.0.1', port: positiveInteger('APPIUM_PORT', 4725),
        path: '/', logLevel: 'info', connectionRetryCount: 0, connectionRetryTimeout: 180_000, capabilities,
    });
    await driver.updateSettings({ defaultActiveApplication: bundleId });
    await driver.pause(motion.pause('afterOpenApp'));

    const recognize: Recognize = async (png) => {
        const { recognizeWords } = await import('../tiktok/ocr.js');
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
        await tapCoordinate(browser, (bounds.left + bounds.right) / 2 / screenScale, (bounds.top + bounds.bottom) / 2 / screenScale, label, motion);
        return true;
    };

    let current: 'feed' | 'reels' = surface === 'reels' ? 'reels' : 'feed';
    const goToSurface = async (target: 'feed' | 'reels'): Promise<void> => {
        const point = target === 'reels' ? instagram.reelsTab : instagram.homeTab;
        await tapCoordinate(driver!, point.x, point.y, target === 'reels' ? 'Reels tab' : 'Home tab', motion);
        await cancellableDelay(motion.pause('reaction'));
    };
    await goToSurface(current);

    if (switchAccountName) {
        // The switcher is coordinate + OCR on iOS: the profile header's username opens the list,
        // and the row is wherever OCR finds the handle. Then back to the surface being warmed.
        console.log(`Switching to Instagram account "${switchAccountName}"`);
        await tapCoordinate(driver, instagram.profileTab.x, instagram.profileTab.y, 'Profile tab', motion);
        await cancellableDelay(2_000);
        await tapCoordinate(driver, instagram.accountSwitcher.x, instagram.accountSwitcher.y, 'Account switcher', motion);
        await cancellableDelay(1_500);
        if (!await tapWord(driver, switchAccountName, `Account row for ${switchAccountName}`)) {
            throw new Error(`Could not find Instagram account "${switchAccountName}" in the account switcher`);
        }
        await cancellableDelay(4_000);
        await goToSurface(current);
    }

    const startedAt = Date.now();
    const deadline = startedAt + sessionLength * 60_000;
    // 'both' spends the first half on the feed and the rest in reels.
    const switchAt = surface === 'both' ? startedAt + (sessionLength * 60_000) / 2 : Number.POSITIVE_INFINITY;

    while (!stopRequested && hasTimeRemaining(Date.now(), deadline)) {
        if (current === 'feed' && Date.now() >= switchAt) {
            current = 'reels';
            surfaceSwitches += 1;
            console.log('Moving from the feed to reels');
            await goToSurface(current);
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
        }

        const post = session ? await readVideo(videoSource, recognize) : undefined;
        const decision = session && persona && post ? decideForVideo(persona, post, session.state, Math.random) : undefined;
        if (decision) console.log(decision.reason);

        await cancellableDelay(clampToDeadline(Date.now(), deadline, decision ? decision.watchMs : pickWatchDurationMs(profile)));
        postsViewed += 1;
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (likeEnabled && (decision ? decision.like : decideLike(profile))) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, motion.pause('beforeLike')));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            await tapCoordinate(driver, instagram.like.x, instagram.like.y, 'Like', motion);
            likes += 1;
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (saveEnabled && (decision ? decision.save : decideSave(profile))) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, motion.pause('afterLike')));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            await tapCoordinate(driver, instagram.save.x, instagram.save.y, 'Save', motion);
            saves += 1;
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (decision?.follow && followEnabled) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, motion.pause('reaction')));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            if (await tapWord(driver, 'Follow', 'Follow')) follows += 1;
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (session && post && decision) {
            noteDecision(session, post, decision);
        } else {
            // The persona folds its curiosity into the watch time; only the profile model lingers.
            const { linger, extraMs } = decideLinger(profile);
            if (linger) await cancellableDelay(clampToDeadline(Date.now(), deadline, extraMs));
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        const search = session && persona && searchEnabled ? decideSearch(persona, session.state, Math.random) : undefined;
        if (search && session) {
            console.log(search.reason);
            if (await tapWord(driver, 'Search', 'Search')) {
                await cancellableDelay(1_500);
                await driver.keys(search.term);
                await driver.keys(['Enter']);
                await cancellableDelay(4_000);
                await cancellableDelay(clampToDeadline(Date.now(), deadline, 4_000 + Math.round(Math.random() * 6_000)));
                await goToSurface(current);
                noteSearch(session, search);
                searches += 1;
            }
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        await cancellableDelay(clampToDeadline(Date.now(), deadline, motion.pause('beforeSwipe')));
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        await swipeToNextPost(driver);
        swipes += 1;
    }

    // Leave the phone on its home screen rather than looping the last reel until the next run.
    try {
        await remoteControl.performAction(udid, { type: 'home' });
        console.log('Left Instagram on the home screen');
    } catch (error) {
        console.log(`Could not press Home at the end: ${error instanceof Error ? error.message : String(error)}`);
    }

    const elapsedMs = Date.now() - runStartedAt;
    const reason = stopRequested ? 'stopped' : 'completed';
    if (session && persona) {
        finishSession(session, { minutes: elapsedMs / 60_000, ending: reason });
        console.log(`Finished Instagram warm-up as ${persona.handle}: ${describeSession(session)} · ${reason}`);
        await writeMemory(session.memory);
    } else {
        console.log(
            `Finished Instagram warm-up: postsViewed=${postsViewed} swipes=${swipes} likes=${likes} saves=${saves} `
            + `follows=${follows} searches=${searches} surfaceSwitches=${surfaceSwitches} elapsedMs=${elapsedMs} reason=${reason}`,
        );
    }
} finally {
    if (driver) await driver.deleteSession();
}
