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
import { decideForVideo, decideSearch } from '../../persona/decide.js';
import { personaFor, type Persona } from '../../persona/model.js';
import { readMemory, writeMemory, type PersonaMemory } from '../../persona/memory.js';
import { readVideo } from '../../persona/observe.js';
import { beginSession, describeSession, finishSession, noteDecision, noteSearch } from '../../persona/session.js';
import { driverFromEnv } from './driver-from-env.js';
import { recognizeOnDevice, tapIfPresent, type SelectorList } from './ui.js';
import { TIKTOK_ANDROID_PACKAGE, switchAccount } from './post.js';

/**
 * The Android doomscroll, driven through the DeviceDriver interface instead of WebDriverAgent.
 *
 * There are two decision models behind the same loop. The persona model (`src/persona/**`) reads
 * the video that is actually on screen and decides from the account's own interests — it is what
 * runs whenever the account has a persona, which is every account by default. The old three
 * personality profiles remain as the fallback for a run that explicitly asks for them.
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
    /** The "+" badge on the creator's avatar. Absent once the account already follows them. GUESS. */
    follow: [
        { id: 'ivm_follow' }, { id: 'follow_button' }, { id: 'iv_follow' },
        { text: 'Follow', exact: true },
    ] as SelectorList,
    /** The creator's handle under the caption; read, never tapped. GUESS. */
    creatorName: [{ id: 'title_author' }, { id: 'author_name' }, { id: 'tv_author' }, { id: 'nickname' }] as SelectorList,
    /** The magnifier in the feed's top bar. GUESS. */
    searchEntry: [{ id: 'search_icon' }, { id: 'iv_search' }, { text: 'Search', exact: true }] as SelectorList,
    /** The text field on the search screen, which sometimes needs a tap before it takes input. GUESS. */
    searchField: [{ id: 'et_search_kw' }, { id: 'search_input' }, { text: 'Search', exact: false }] as SelectorList,
    /** The first result card. GUESS. */
    searchResult: [{ id: 'search_result_item' }, { id: 'iv_cover' }, { id: 'video_cover' }] as SelectorList,
} as const;

export interface DoomscrollOnAndroidOptions {
    /** Absent with a persona means "ask the persona how long it feels like scrolling". */
    durationMinutes?: number;
    personality: Personality;
    likeEnabled: boolean;
    saveEnabled: boolean;
    /** The persona to scroll as. Absent falls back to the personality coin flips. */
    persona?: Persona;
    /** What the account remembers; the run reads the follow rule and "already followed" from it. */
    memory?: PersonaMemory;
    /** Where to put the memory back. The env runner writes the file; tests keep it in hand. */
    saveMemory?: (memory: PersonaMemory) => Promise<void>;
    followEnabled?: boolean;
    searchEnabled?: boolean;
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
    follows: number;
    searches: number;
    elapsedMs: number;
    /** 'asleep' is a persona refusing to scroll outside its active hours — not a failure. */
    reason: 'completed' | 'stopped' | 'asleep';
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
    const { personality, likeEnabled, saveEnabled, signal, persona } = options;
    const random = options.random ?? Math.random;
    const now = options.now ?? Date.now;
    const profile = PROFILES[personality];
    const packageName = options.packageName ?? TIKTOK_ANDROID_PACKAGE;
    const seed = options.seed ?? process.env.MOTION_SEED ?? `${Date.now()}:${driver.udid}`;
    const motion = createMotionSource({
        udid: driver.udid, seed, ...(options.motion ? { settings: options.motion } : {}),
    });
    const followEnabled = options.followEnabled ?? true;
    const searchEnabled = options.searchEnabled ?? true;

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

    // The persona decides the session before anything is launched, so an account that is asleep
    // costs one clock read rather than an app launch and a screen unlock.
    const session = persona
        ? beginSession(persona, options.memory ?? { handle: persona.handle, sessionIndex: 0, creators: {}, followed: [], sessions: [] }, random, new Date(now()))
        : undefined;
    if (session && !session.plan.active && options.durationMinutes === undefined) {
        console.log(`Not scrolling as ${persona!.handle}: ${session.plan.reason}`);
        return { videosViewed: 0, swipes: 0, likes: 0, saves: 0, follows: 0, searches: 0, elapsedMs: 0, reason: 'asleep' };
    }
    const durationMinutes = options.durationMinutes ?? session?.plan.minutes ?? 5;

    let videosViewed = 0;
    let swipes = 0;
    let likes = 0;
    let saves = 0;
    let follows = 0;
    let searches = 0;
    const runStartedAt = now();
    const sessionLength = sessionMinutes(durationMinutes, motion.random);
    console.log(
        `Starting doomscroll${session ? ` as ${persona!.handle}` : ''}: seed=${seed} hand=${motion.profile.hand} speed=${motion.profile.speed} `
        + (session ? `plan=${session.plan.reason} ` : `profile=${personality} `)
        + `requestedDurationMinutes=${durationMinutes} sessionMinutes=${sessionLength.toFixed(1)} `
        + `likeEnabled=${likeEnabled} saveEnabled=${saveEnabled}`,
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

    /**
     * Search, then come back. The results open into a feed of their own, so the same flick that
     * advances the main feed scrolls them; two Back presses land on the feed the run came from.
     */
    const runSearch = async (term: string): Promise<boolean> => {
        if (!await tapIfPresent(driver, 'Search', FEED_SELECTORS.searchEntry, options.recognize)) return false;
        await sleep(1_200);
        await tapIfPresent(driver, 'Search field', FEED_SELECTORS.searchField, options.recognize);
        await driver.type(term);
        await driver.pressKey('enter');
        await sleep(2_500);
        if (await tapIfPresent(driver, 'Top result', FEED_SELECTORS.searchResult, options.recognize)) {
            await sleep(2_000);
            for (let index = 0; index < 3 && running(); index += 1) {
                await swipeToNextVideo(driver, motion);
                await sleep(clampToDeadline(now(), deadline, motion.pause('betweenVideos')));
            }
            await driver.pressKey('back');
            await sleep(800);
        }
        await driver.pressKey('back');
        await sleep(1_200);
        return true;
    };

    while (running()) {
        if (session && persona) {
            // ---- The persona loop: read the video, then decide from who this account is. ----
            const video = await readVideo(driver, options.recognize);
            const decision = decideForVideo(persona, video, session.state, random);
            console.log(decision.reason);

            await sleep(clampToDeadline(now(), deadline, decision.watchMs));
            videosViewed += 1;
            if (!running()) break;

            if (likeEnabled && decision.like) {
                await sleep(clampToDeadline(now(), deadline, motion.pause('beforeLike')));
                if (await tapIfPresent(driver, 'Like', FEED_SELECTORS.like, options.recognize)) likes += 1;
            }
            if (saveEnabled && decision.save && running()) {
                await sleep(clampToDeadline(now(), deadline, motion.pause('afterLike')));
                if (await tapIfPresent(driver, 'Save', FEED_SELECTORS.save, options.recognize)) saves += 1;
            }
            if (followEnabled && decision.follow && running()) {
                await sleep(clampToDeadline(now(), deadline, motion.pause('beforeLike')));
                if (await tapIfPresent(driver, 'Follow', FEED_SELECTORS.follow, options.recognize)) follows += 1;
            }
            noteDecision(session, video, decision);
            if (!running()) break;

            const search = decideSearch(persona, session.state, random);
            if (search && searchEnabled) {
                console.log(search.reason);
                if (await runSearch(search.term)) {
                    noteSearch(session, search);
                    searches += 1;
                }
            }
            if (!running()) break;

            await sleep(clampToDeadline(now(), deadline, motion.pause('beforeSwipe')));
            if (!running()) break;

            await swipeToNextVideo(driver, motion);
            swipes += 1;
            continue;
        }

        // ---- The fallback loop: the original three-personality coin flips. ----
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
        videosViewed, swipes, likes, saves, follows, searches,
        elapsedMs: now() - runStartedAt,
        reason: stopped || signal?.aborted ? 'stopped' : 'completed',
    };
    if (session) {
        finishSession(session, { minutes: summary.elapsedMs / 60_000, ending: summary.reason });
        console.log(`Finished doomscroll as ${persona!.handle}: ${describeSession(session)} · ${summary.reason}`);
        await options.saveMemory?.(session.memory);
    } else {
        console.log(`Finished doomscroll: videosViewed=${summary.videosViewed} swipes=${summary.swipes} likes=${summary.likes} saves=${summary.saves} elapsedMs=${summary.elapsedMs} reason=${summary.reason}`);
    }
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
    // DOOMSCROLL_PERSONA is set by the plugin whenever the account has one; the personality profile
    // stays behind it as the fallback for a run that asked for the old model.
    const usePersona = booleanEnv('DOOMSCROLL_PERSONA', false) && Boolean(account);
    const persona = usePersona ? await personaFor(account!) : undefined;
    const memory = persona ? await readMemory(persona.handle) : undefined;
    // Stop is a SIGTERM from the executor; every wait races the abort so it lands immediately.
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
    // With a persona and no explicit duration, the session picks its own length.
    const explicitDuration = process.env.DOOMSCROLL_DURATION_MINUTES !== undefined || !persona;
    await doomscrollOnAndroid(driverFromEnv(), {
        ...(explicitDuration ? { durationMinutes: boundedInteger('DOOMSCROLL_DURATION_MINUTES', 5, 1, 180) } : {}),
        personality,
        likeEnabled: booleanEnv('DOOMSCROLL_LIKE_ENABLED', true),
        saveEnabled: booleanEnv('DOOMSCROLL_SAVE_ENABLED', true),
        followEnabled: booleanEnv('DOOMSCROLL_FOLLOW_ENABLED', true),
        searchEnabled: booleanEnv('DOOMSCROLL_SEARCH_ENABLED', true),
        packageName: process.env.TIKTOK_PACKAGE?.trim() || TIKTOK_ANDROID_PACKAGE,
        ...(process.env.MOTION_SEED ? { seed: process.env.MOTION_SEED } : {}),
        ...(motionFromEnvironment() ? { motion: motionFromEnvironment()! } : {}),
        recognize: recognizeOnDevice,
        signal: controller.signal,
        ...(account ? { account } : {}),
        ...(persona ? { persona } : {}),
        ...(memory ? { memory, saveMemory: (updated) => writeMemory(updated) } : {}),
    });
}

/** Entrypoint: `node --import tsx src/tiktok/android/doomscroll.ts`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runFromEnvironment();
}
