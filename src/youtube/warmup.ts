import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remote, type Browser } from 'webdriverio';

import {
    createMotionSource, gestureActions, loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl,
    type MotionSettings,
} from '@git-agni/backline';
import type { DeviceCoordinates } from '../devices/coordinates.js';
import type { Recognize } from '../drivers/verify.js';
import { tapCoordinate } from '../tiktok/actions.js';
import { clampToDeadline, hasTimeRemaining } from '../tiktok/doomscroll-profile.js';
import { decideForVideo } from '../persona/decide.js';
import { personaFor } from '../persona/model.js';
import { readMemory, writeMemory } from '../persona/memory.js';
import { findWordBounds, readVideo } from '../persona/observe.js';
import { beginSession, describeSession, finishSession, noteDecision } from '../persona/session.js';
import { commentBudget, decideComment } from './android/warmup.js';
import { coordinateProfile } from './runtime-settings.js';
import { YOUTUBE_IOS_BUNDLE_ID } from './app.js';

/**
 * The iPhone YouTube warm-up: the same persona-driven browse of the Shorts feed as the Android
 * routine, driven through WebDriverAgent instead of the DeviceDriver interface.
 *
 * XCUITest cannot see into the Shorts player, so everything the persona reads — the title, the
 * hashtags, the channel — is OCR over a screenshot, and every control is a coordinate out of the
 * device's `youtube` profile block. **Those coordinates are unverified** (docs/coordinates.md).
 * The run ends by pressing Home, whatever happened on the way.
 */

type YouTubePoints = DeviceCoordinates['youtube'];

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

export interface IosWarmupSummary {
    videosViewed: number;
    swipes: number;
    likes: number;
    subscribes: number;
    comments: number;
    elapsedMs: number;
    reason: 'completed' | 'stopped' | 'asleep';
}

export async function runFromEnvironment(): Promise<IosWarmupSummary> {
    const udid = process.env.IOS_UDID;
    if (!udid) throw new Error('IOS_UDID is required. Copy .env.example to .env and set the connected device UDID.');

    const account = process.env.YOUTUBE_SWITCH_ACCOUNT?.trim() || undefined;
    const usePersona = booleanEnv('YOUTUBE_PERSONA', false) && Boolean(account);
    const persona = usePersona ? await personaFor(account!) : undefined;
    const memory = persona ? await readMemory(persona.handle) : undefined;
    const likeEnabled = booleanEnv('YOUTUBE_LIKE_ENABLED', true);
    const subscribeEnabled = booleanEnv('YOUTUBE_SUBSCRIBE_ENABLED', true);
    const commentEnabled = booleanEnv('YOUTUBE_COMMENT_ENABLED', false);
    const explicitMinutes = process.env.YOUTUBE_DURATION_MINUTES === undefined
        ? undefined : boundedInteger('YOUTUBE_DURATION_MINUTES', 5, 1, 180);

    const session = persona && memory ? beginSession(persona, memory, Math.random, new Date()) : undefined;
    if (session && !session.plan.active && explicitMinutes === undefined) {
        console.log(`Not warming up as ${persona!.handle}: ${session.plan.reason}`);
        return { videosViewed: 0, swipes: 0, likes: 0, subscribes: 0, comments: 0, elapsedMs: 0, reason: 'asleep' };
    }
    const durationMinutes = explicitMinutes ?? session?.plan.minutes ?? 5;

    const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === udid);
    const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), registeredDevice?.coordinates);
    const points: YouTubePoints = coordinates.youtube;

    // One seed for the run: every arc and every pause is drawn from it, so a run replays from its
    // execution id and differs from every other run.
    const motionSettings: MotionSettings = {
        ...(process.env.MOTION_HAND === 'right' || process.env.MOTION_HAND === 'left' ? { hand: process.env.MOTION_HAND } : {}),
        ...(process.env.MOTION_SPEED === 'slow' || process.env.MOTION_SPEED === 'normal' || process.env.MOTION_SPEED === 'fast'
            ? { speed: process.env.MOTION_SPEED } : {}),
    };
    const motion = createMotionSource({ udid, seed: process.env.MOTION_SEED ?? `${Date.now()}:${udid}`, settings: motionSettings });

    // Stop is a SIGTERM from the executor; every wait races it so a stop lands between two taps.
    let stopRequested = false;
    let resolveStop: () => void = () => {};
    const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => { stopRequested = true; resolveStop(); });
    }
    const delay = (ms: number): Promise<void> => ms <= 0 ? Promise.resolve() : new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        void stopPromise.then(() => { clearTimeout(timer); resolve(); });
    });

    const bundleId = process.env.YOUTUBE_BUNDLE_ID ?? YOUTUBE_IOS_BUNDLE_ID;
    const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
        platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': udid,
        'appium:bundleId': bundleId, 'appium:noReset': true, 'appium:forceAppLaunch': true,
        'appium:shouldTerminateApp': true, 'appium:newCommandTimeout': 120, 'appium:waitForIdleTimeout': 0,
    };
    if (process.env.WDA_URL) {
        capabilities['appium:webDriverAgentUrl'] = process.env.WDA_URL;
        capabilities['appium:wdaRemotePort'] = positiveInteger('WDA_REMOTE_PORT', 8100);
    }

    const remoteControl = new WdaRemoteControl({
        deviceUdid: udid, ...(process.env.WDA_URL ? { wdaUrl: process.env.WDA_URL } : {}),
        passcodeKeypadLayout: coordinates.passcodeKeypad,
    });
    console.log('Checking device lock state');
    await remoteControl.unlock(udid);

    /** OCR, imported lazily so a run with no persona never loads the native binding. */
    const recognize: Recognize = async (png) => {
        const { recognizeWords } = await import('../tiktok/ocr.js');
        return (await recognizeWords(png)).map((word) => ({
            text: word.text,
            bounds: { left: word.x, top: word.y, right: word.x + word.width, bottom: word.y + word.height },
        }));
    };
    const videoSource = { screenshot: () => remoteControl.getScreenshot(udid) };
    const scale = (await remoteControl.getScreenInfo(udid).catch(() => undefined))?.scale ?? 1;

    let videosViewed = 0;
    let swipes = 0;
    let likes = 0;
    let subscribes = 0;
    let comments = 0;
    const runStartedAt = Date.now();
    const sessionLength = durationMinutes * (0.85 + motion.random() * 0.3);
    console.log(
        `Starting YouTube warm-up${session ? ` as ${persona!.handle}` : ''}: hand=${motion.profile.hand} `
        + `speed=${motion.profile.speed} requestedDurationMinutes=${durationMinutes} sessionMinutes=${sessionLength.toFixed(1)}`,
    );

    const driver = await remote({
        hostname: process.env.APPIUM_HOST ?? '127.0.0.1', port: positiveInteger('APPIUM_PORT', 4725), path: '/',
        logLevel: 'info', connectionRetryCount: 0, connectionRetryTimeout: 180_000, capabilities,
    });
    try {
        await driver.updateSettings({ defaultActiveApplication: bundleId });
        await delay(motion.pause('afterOpenApp'));
        // Whatever YouTube opened on, the Shorts tab is one tap away from the bottom bar.
        await tapCoordinate(driver, points.shortsTab.x, points.shortsTab.y, 'Shorts tab', motion);
        await delay(2_000);

        const swipeToNext = async (): Promise<void> => {
            const pathPoints = motion.swipe(coordinates.screenSize, { direction: 'up' });
            await driver.performActions(gestureActions(pathPoints) as unknown as Parameters<Browser['performActions']>[0]);
            await driver.releaseActions();
        };
        /** Taps a word OCR can see; a control that is not on screen is skipped, never fatal. */
        const tapWord = async (word: string, label: string): Promise<boolean> => {
            let bounds;
            try {
                bounds = findWordBounds(await recognize(await remoteControl.getScreenshot(udid)), word);
            } catch { bounds = undefined; }
            if (!bounds) {
                console.log(`Skipped ${label}: not on screen`);
                return false;
            }
            // OCR reads the PNG's pixel grid; iOS taps are in points.
            await tapCoordinate(driver, (bounds.left + bounds.right) / 2 / scale, (bounds.top + bounds.bottom) / 2 / scale, label, motion);
            return true;
        };

        const deadline = Date.now() + sessionLength * 60_000;
        const commentsAllowed = session ? commentBudget(session.state) : 0;

        while (!stopRequested && hasTimeRemaining(Date.now(), deadline)) {
            const video = session ? await readVideo(videoSource, recognize) : undefined;
            const decision = session && persona && video ? decideForVideo(persona, video, session.state, Math.random) : undefined;
            if (decision) console.log(decision.reason);

            await delay(clampToDeadline(Date.now(), deadline, decision?.watchMs ?? 6_000));
            videosViewed += 1;
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

            if (likeEnabled && decision?.like) {
                await delay(clampToDeadline(Date.now(), deadline, motion.pause('beforeLike')));
                await tapCoordinate(driver, points.like.x, points.like.y, 'Like', motion);
                likes += 1;
            }
            // Subscribing is the persona's follow; the pill is only there when it is not subscribed.
            if (subscribeEnabled && decision?.follow && !stopRequested) {
                await delay(clampToDeadline(Date.now(), deadline, motion.pause('afterLike')));
                if (await tapWord('Subscribe', 'Subscribe')) subscribes += 1;
            }
            if (session && video && decision) noteDecision(session, video, decision);
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

            if (commentEnabled && session && persona && decision) {
                const said = decideComment(persona, decision, comments, commentsAllowed, Math.random(), Math.random());
                if (said.comment) {
                    console.log(said.reason);
                    await tapCoordinate(driver, points.comment.x, points.comment.y, 'Comments', motion);
                    await delay(2_000);
                    await tapCoordinate(driver, points.commentField.x, points.commentField.y, 'comment box', motion);
                    await delay(1_200);
                    await driver.keys(said.text);
                    await delay(motion.pause('beforeLike'));
                    await tapCoordinate(driver, points.commentSend.x, points.commentSend.y, 'Send comment', motion);
                    comments += 1;
                    await delay(1_500);
                    // Back out of the sheet the only way iOS offers: a downward flick over it.
                    await tapCoordinate(driver, points.shortsTab.x, points.shortsTab.y, 'back to Shorts', motion);
                    await delay(1_500);
                }
            }
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

            await delay(clampToDeadline(Date.now(), deadline, motion.pause('beforeSwipe')));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            await swipeToNext();
            swipes += 1;
        }
    } finally {
        await driver.deleteSession().catch(() => {});
        try {
            await remoteControl.performAction(udid, { type: 'home' });
            console.log('Left YouTube on the home screen');
        } catch (error) {
            console.log(`Could not press Home at the end: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const summary: IosWarmupSummary = {
        videosViewed, swipes, likes, subscribes, comments,
        elapsedMs: Date.now() - runStartedAt,
        reason: stopRequested ? 'stopped' : 'completed',
    };
    if (session && persona) {
        finishSession(session, { minutes: summary.elapsedMs / 60_000, ending: summary.reason });
        console.log(`Finished YouTube warm-up as ${persona.handle}: ${describeSession(session)} · ${summary.comments} comments · ${summary.reason}`);
        await writeMemory(session.memory);
    } else {
        console.log(
            `Finished YouTube warm-up: videosViewed=${summary.videosViewed} swipes=${summary.swipes} likes=${summary.likes} `
            + `subscribes=${summary.subscribes} comments=${summary.comments} elapsedMs=${summary.elapsedMs} reason=${summary.reason}`,
        );
    }
    return summary;
}

/** Entrypoint: `node --import tsx src/youtube/warmup.ts`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runFromEnvironment();
}
