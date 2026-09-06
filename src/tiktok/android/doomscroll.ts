import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeviceDriver } from '../../drivers/types.js';
import type { Recognize } from '../../drivers/verify.js';
import type { MotionSettings } from '../../motion/profile.js';
import { createMotionSource, type MotionSource } from '../../motion/source.js';
import {
    PROFILES, clampToDeadline, decideLike, decideLinger, decideSave, hasTimeRemaining, isPersonality,
    pickWatchDurationMs, type Personality,
} from '../doomscroll-profile.js';
import { driverFromEnv } from './driver-from-env.js';
import { recognizeOnDevice, tapIfPresent, type SelectorList } from './ui.js';
import { TIKTOK_ANDROID_PACKAGE, switchAccount } from './post.js';

/**
 * The Android doomscroll: same personality timing model as the iOS routine
 * (`src/tiktok/doomscroll-profile.ts` is platform-neutral and shared verbatim), driven through
 * the DeviceDriver interface instead of WebDriverAgent.
 *
 * The iOS routine locates the like and save controls by template-matching the heart and bookmark
 * icons in a screenshot (`engagement-controls.ts`) because XCUITest cannot see into TikTok's
 * feed. On Android the same controls carry content-descs, so tree-first targeting handles them
 * and the pixel search is not needed here.
 */
export const FEED_SELECTORS = {
    /** Bottom navigation "Home"; only used after an account switch leaves the app on Profile. */
    homeTab: [{ id: 'home_tab' }, { text: 'Home', exact: true }, { text: 'For You', exact: true }] as SelectorList,
    /** The heart. Content-desc changes once the video is liked, so both states are listed. GUESS. */
    like: [{ id: 'ivm_like' }, { id: 'like_button' }, { text: 'Like', exact: true }, { text: 'Liked', exact: true }] as SelectorList,
    /** The bookmark. GUESS. */
    save: [
        { id: 'ivm_collect' }, { id: 'favorite_button' },
        { text: 'Add to Favorites' }, { text: 'Favorites', exact: true }, { text: 'Save', exact: true },
    ] as SelectorList,
} as const;

export interface DoomscrollOnAndroidOptions {
    durationMinutes: number;
    personality: Personality;
    likeEnabled: boolean;
    saveEnabled: boolean;
    account?: string;
    packageName?: string;
    recognize?: Recognize;
    signal?: AbortSignal;
    /** Injectable for tests. */
    random?: () => number;
    now?: () => number;
    /**
     * One seed for the whole run: every swipe arc and every pause is drawn from it, so a run is
     * reproducible from its execution id and different from every other run. The executor exports
     * it as MOTION_SEED.
     */
    seed?: string;
    /** Handedness and pace; defaults to the device's own stable profile. */
    motion?: MotionSettings;
}

export interface DoomscrollSummary {
    videosViewed: number;
    swipes: number;
    likes: number;
    saves: number;
    elapsedMs: number;
    reason: 'completed' | 'stopped';
}

/**
 * The flick to the next video: an arc starting somewhere in this device's thumb zone, with its
 * own length, curvature and speed. Two of these are never the same shape (src/motion/gesture.ts).
 */
async function swipeToNextVideo(driver: DeviceDriver, motion: MotionSource): Promise<void> {
    await driver.gesture(motion.swipe(await driver.screen(), { direction: 'up' }));
}

/** ±15%: nobody puts the phone down after exactly the number of minutes they meant to. */
export function sessionMinutes(requested: number, random: () => number): number {
    return requested * (0.85 + random() * 0.3);
}

export async function doomscrollOnAndroid(driver: DeviceDriver, options: DoomscrollOnAndroidOptions): Promise<DoomscrollSummary> {
    const { durationMinutes, personality, likeEnabled, saveEnabled, signal } = options;
    const random = options.random ?? Math.random;
    const now = options.now ?? Date.now;
    const profile = PROFILES[personality];
    const packageName = options.packageName ?? TIKTOK_ANDROID_PACKAGE;
    const seed = options.seed ?? process.env.MOTION_SEED ?? `${Date.now()}:${driver.udid}`;
    const motion = createMotionSource({
        udid: driver.udid, seed, ...(options.motion ? { settings: options.motion } : {}),
    });

    let stopped = false;
    // driver.pause rejects with the abort reason; a stop is a normal end to the run, not a failure.
    const sleep = async (milliseconds: number): Promise<void> => {
        if (stopped || milliseconds <= 0) return;
        try {
            await driver.pause(milliseconds, signal);
        } catch {
            stopped = true;
        }
    };

    let videosViewed = 0;
    let swipes = 0;
    let likes = 0;
    let saves = 0;
    const runStartedAt = now();
    const sessionLength = sessionMinutes(durationMinutes, motion.random);
    console.log(
        `Starting doomscroll: seed=${seed} hand=${motion.profile.hand} speed=${motion.profile.speed} `
        + `profile=${personality} requestedDurationMinutes=${durationMinutes} `
        + `sessionMinutes=${sessionLength.toFixed(1)} likeEnabled=${likeEnabled} saveEnabled=${saveEnabled}`,
    );

    console.log(`Launching ${packageName} on ${driver.udid}`);
    await driver.launchApp(packageName);
    await sleep(motion.pause('afterOpenApp'));

    if (options.account) {
        const switchOptions = { ...(options.recognize ? { recognize: options.recognize } : {}), ...(signal ? { signal } : {}) };
        await switchAccount(driver, options.account, switchOptions);
        // The switch leaves the app on the Profile tab; the loop below expects the feed.
        await tapIfPresent(driver, 'Home tab', FEED_SELECTORS.homeTab, options.recognize);
        await sleep(motion.pause('reaction'));
    }

    const deadline = now() + sessionLength * 60_000;
    const running = () => !stopped && !signal?.aborted && hasTimeRemaining(now(), deadline);

    while (running()) {
        await sleep(clampToDeadline(now(), deadline, pickWatchDurationMs(profile, random)));
        videosViewed += 1;
        if (!running()) break;

        if (likeEnabled && decideLike(profile, random)) {
            await sleep(clampToDeadline(now(), deadline, motion.pause('beforeLike')));
            if (!running()) break;
            if (await tapIfPresent(driver, 'Like', FEED_SELECTORS.like, options.recognize)) likes += 1;
        }
        if (!running()) break;

        if (saveEnabled && decideSave(profile, random)) {
            await sleep(clampToDeadline(now(), deadline, motion.pause('afterLike')));
            if (!running()) break;
            if (await tapIfPresent(driver, 'Save', FEED_SELECTORS.save, options.recognize)) saves += 1;
        }
        if (!running()) break;

        const { linger, extraMs } = decideLinger(profile, random);
        if (linger) await sleep(clampToDeadline(now(), deadline, extraMs));
        if (!running()) break;

        await sleep(clampToDeadline(now(), deadline, motion.pause('beforeSwipe')));
        if (!running()) break;

        await swipeToNextVideo(driver, motion);
        swipes += 1;
    }

    const summary: DoomscrollSummary = {
        videosViewed, swipes, likes, saves,
        elapsedMs: now() - runStartedAt,
        reason: stopped || signal?.aborted ? 'stopped' : 'completed',
    };
    console.log(`Finished doomscroll: videosViewed=${summary.videosViewed} swipes=${summary.swipes} likes=${summary.likes} saves=${summary.saves} elapsedMs=${summary.elapsedMs} reason=${summary.reason}`);
    return summary;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name] ?? String(fallback);
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be between ${min} and ${max}; received ${raw}`);
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

/** MOTION_HAND / MOTION_SPEED are exported by the executor from the device's registration. */
function motionFromEnvironment(): MotionSettings | undefined {
    const hand = process.env.MOTION_HAND;
    const speed = process.env.MOTION_SPEED;
    const settings: MotionSettings = {
        ...(hand === 'right' || hand === 'left' ? { hand } : {}),
        ...(speed === 'slow' || speed === 'normal' || speed === 'fast' ? { speed } : {}),
    };
    return Object.keys(settings).length ? settings : undefined;
}

/** Reads the same environment contract as the iOS routine. */
export async function runFromEnvironment(): Promise<void> {
    const personality = process.env.DOOMSCROLL_PERSONALITY ?? 'casual';
    if (!isPersonality(personality)) {
        throw new Error(`DOOMSCROLL_PERSONALITY must be one of skimmer, casual, engaged; received ${personality}`);
    }
    const account = process.env.TIKTOK_SWITCH_ACCOUNT?.trim() || undefined;
    // Stop is a SIGTERM from the executor; every wait races the abort so it lands immediately.
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
    await doomscrollOnAndroid(driverFromEnv(), {
        durationMinutes: boundedInteger('DOOMSCROLL_DURATION_MINUTES', 5, 1, 180),
        personality,
        likeEnabled: booleanEnv('DOOMSCROLL_LIKE_ENABLED', true),
        saveEnabled: booleanEnv('DOOMSCROLL_SAVE_ENABLED', true),
        packageName: process.env.TIKTOK_PACKAGE?.trim() || TIKTOK_ANDROID_PACKAGE,
        ...(process.env.MOTION_SEED ? { seed: process.env.MOTION_SEED } : {}),
        ...(motionFromEnvironment() ? { motion: motionFromEnvironment()! } : {}),
        recognize: recognizeOnDevice,
        signal: controller.signal,
        ...(account ? { account } : {}),
    });
}

/** Entrypoint: `node --import tsx src/tiktok/android/doomscroll.ts`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runFromEnvironment();
}
