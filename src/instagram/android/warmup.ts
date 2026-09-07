import path from 'node:path';
import { resolveTable } from '../../drivers/selector-overrides.js';
import { INSTAGRAM_PLUGIN_ID } from '../../plugin-ids.js';
import { fileURLToPath } from 'node:url';

import type { DeviceDriver } from '../../drivers/types.js';
import type { Recognize } from '../../drivers/verify.js';
import type { MotionSettings } from '../../motion/profile.js';
import { createMotionSource, type MotionSource } from '../../motion/source.js';
import {
    PROFILES, clampToDeadline, decideLike, decideLinger, decideSave, hasTimeRemaining, isPersonality,
    pickWatchDurationMs, type Personality,
} from '../../tiktok/doomscroll-profile.js';
import { decideForVideo, decideSearch } from '../../persona/decide.js';
import { personaFor, type Persona } from '../../persona/model.js';
import { readMemory, writeMemory, type PersonaMemory } from '../../persona/memory.js';
import { readVideo } from '../../persona/observe.js';
import { beginSession, describeSession, finishSession, noteDecision, noteSearch } from '../../persona/session.js';
import { driverFromEnv } from '../../tiktok/android/driver-from-env.js';
import { recognizeOnDevice, tapIfPresent, waitForAny, type SelectorList, type TapOptions } from './ui.js';
import { INSTAGRAM_ANDROID_PACKAGE, switchAccount } from './post.js';

/**
 * The Instagram warm-up: an account browsing its own feed and reels for a while, liking, saving
 * and occasionally following, the way the TikTok doomscroll does.
 *
 * The decision model is `src/persona/**` — the account's own interests read off the post that is
 * actually on screen. The three personality profiles from the TikTok routine remain as the
 * fallback for a run with no persona; they are coin flips over watch time and engagement and have
 * nothing TikTok-specific in them, so they are imported rather than copied.
 *
 * Instagram has two scrollable surfaces, and an account that only ever touched one of them looks
 * exactly as odd as it sounds — `surface: 'both'` spends the first half of the session on the
 * feed and the rest in reels.
 */
export const FEED_SELECTORS = {
    /** Bottom navigation "Home". GUESS. */
    homeTab: [{ id: 'feed_tab' }, { text: 'Home', exact: true }, { text: 'Home feed' }] as SelectorList,
    /** Bottom navigation "Reels". GUESS. */
    reelsTab: [{ id: 'clips_tab' }, { id: 'reels_tab' }, { text: 'Reels', exact: true }] as SelectorList,
    /** The heart. Content-desc changes once the post is liked, so both states are listed. GUESS. */
    like: [
        { id: 'row_feed_button_like' }, { id: 'like_button' },
        { text: 'Like', exact: true }, { text: 'Unlike', exact: true }, { text: 'Liked', exact: true },
    ] as SelectorList,
    /** The bookmark. GUESS. */
    save: [
        { id: 'row_feed_button_save' }, { id: 'save_button' },
        { text: 'Save', exact: true }, { text: 'Saved', exact: true }, { text: 'Remove from saved' },
    ] as SelectorList,
    /** The "Follow" button on a suggested or reel author. Absent once followed. GUESS. */
    follow: [{ id: 'row_feed_follow_button' }, { id: 'follow_button' }, { text: 'Follow', exact: true }] as SelectorList,
    /** The magnifier / Search tab. GUESS. */
    searchEntry: [{ id: 'search_tab' }, { id: 'action_bar_search_edit_text' }, { text: 'Search', exact: true }] as SelectorList,
    /** The text field on the search screen, which sometimes needs a tap before it takes input. GUESS. */
    searchField: [{ id: 'action_bar_search_edit_text' }, { id: 'search_input' }, { text: 'Search' }] as SelectorList,
    /** The first result card. GUESS. */
    searchResult: [{ id: 'image_button' }, { id: 'media_thumbnail' }, { id: 'gallery_grid_item_thumbnail' }] as SelectorList,
} as const;

/**
 * What the flow below actually reads.
 *
 * It starts as the built-in guesses and is replaced, once per run, by the same table with any
 * confirmed overrides for this phone in front (src/drivers/selector-overrides.ts). A selector an
 * operator or the calibration agent has verified against a real device therefore wins without
 * anybody editing this file, and an override that has itself gone stale still falls through to
 * the alternates below it.
 */
let selectors: typeof FEED_SELECTORS = FEED_SELECTORS;

export type WarmupSurface = 'feed' | 'reels' | 'both';

export function isWarmupSurface(value: string): value is WarmupSurface {
    return value === 'feed' || value === 'reels' || value === 'both';
}

export interface WarmupOnAndroidOptions {
    /** Absent with a persona means "ask the persona how long it feels like browsing". */
    durationMinutes?: number;
    surface?: WarmupSurface;
    personality?: Personality;
    likeEnabled: boolean;
    saveEnabled: boolean;
    /** The persona to browse as. Absent falls back to the personality coin flips. */
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
    /** One seed for the whole run; the executor exports it as MOTION_SEED. */
    seed?: string;
    /** Handedness and pace; defaults to the device's own stable profile. */
    motion?: MotionSettings;
}

export interface WarmupSummary {
    postsViewed: number;
    swipes: number;
    likes: number;
    saves: number;
    follows: number;
    searches: number;
    /** How many times the run moved between the feed and reels. */
    surfaceSwitches: number;
    elapsedMs: number;
    /** 'asleep' is a persona refusing to browse outside its active hours — not a failure. */
    reason: 'completed' | 'stopped' | 'asleep';
}

/**
 * A warm-up must start on a scrollable surface. Instagram may open on a story, a DM, a half
 * finished upload or a login sheet, so: back out of anything modal, tap the tab, then check.
 * Never fatal — the run logs what it saw and carries on.
 */
async function ensureSurface(
    driver: DeviceDriver, surface: 'feed' | 'reels', tapping: TapOptions | undefined,
    sleep: (ms: number) => Promise<void>,
): Promise<void> {
    const tab = surface === 'reels' ? selectors.reelsTab : selectors.homeTab;
    const label = surface === 'reels' ? 'Reels tab' : 'Home tab';
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await tapIfPresent(driver, label, tab, tapping)) {
            console.log(`On the ${surface}`);
            await sleep(1_200);
            return;
        }
        console.log(`No tab bar on screen (attempt ${attempt + 1}); pressing back`);
        await driver.pressKey('back');
        await sleep(900);
    }
    try {
        await waitForAny(driver, `the Instagram ${surface}`, tab, { timeoutMs: 8_000 });
        console.log(`On the ${surface}`);
    } catch (error) {
        console.log(`Could not confirm the ${surface}; scrolling anyway. ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function swipeToNextPost(driver: DeviceDriver, motion: MotionSource): Promise<void> {
    await driver.gesture(motion.swipe(await driver.screen(), { direction: 'up' }));
}

/** ±15%: nobody puts the phone down after exactly the number of minutes they meant to. */
export function sessionMinutes(requested: number, random: () => number): number {
    return requested * (0.85 + random() * 0.3);
}

export async function warmupOnAndroid(driver: DeviceDriver, options: WarmupOnAndroidOptions): Promise<WarmupSummary> {
    // One read of the override store per run, before the first tap: the flow below then uses
    // the corrected table exactly as it used the built-in one.
    selectors = await resolveTable(INSTAGRAM_PLUGIN_ID, driver.udid, FEED_SELECTORS);
    const { likeEnabled, saveEnabled, signal, persona } = options;
    const random = options.random ?? Math.random;
    const now = options.now ?? Date.now;
    const personality = options.personality ?? 'casual';
    const profile = PROFILES[personality];
    const surface = options.surface ?? 'both';
    const packageName = options.packageName ?? INSTAGRAM_ANDROID_PACKAGE;
    const seed = options.seed ?? process.env.MOTION_SEED ?? `${Date.now()}:${driver.udid}`;
    const motion = createMotionSource({
        udid: driver.udid, seed, ...(options.motion ? { settings: options.motion } : {}),
    });
    // Every tap in the run comes out of the run's own seeded hand, the same one the swipes do.
    const tapping: TapOptions = { ...(options.recognize ? { recognize: options.recognize } : {}), motion };
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
        console.log(`Not warming up as ${persona!.handle}: ${session.plan.reason}`);
        return {
            postsViewed: 0, swipes: 0, likes: 0, saves: 0, follows: 0, searches: 0,
            surfaceSwitches: 0, elapsedMs: 0, reason: 'asleep',
        };
    }
    const durationMinutes = options.durationMinutes ?? session?.plan.minutes ?? 5;

    let postsViewed = 0;
    let swipes = 0;
    let likes = 0;
    let saves = 0;
    let follows = 0;
    let searches = 0;
    let surfaceSwitches = 0;
    const runStartedAt = now();
    const sessionLength = sessionMinutes(durationMinutes, motion.random);
    console.log(
        `Starting Instagram warm-up${session ? ` as ${persona!.handle}` : ''}: seed=${seed} hand=${motion.profile.hand} `
        + `speed=${motion.profile.speed} surface=${surface} `
        + (session ? `plan=${session.plan.reason} ` : `profile=${personality} `)
        + `requestedDurationMinutes=${durationMinutes} sessionMinutes=${sessionLength.toFixed(1)} `
        + `likeEnabled=${likeEnabled} saveEnabled=${saveEnabled}`,
    );

    // A phone that dozed off shows nothing and launches nothing; wake it first.
    await driver.pressKey('wake');
    console.log(`Launching ${packageName} on ${driver.udid}`);
    await driver.launchApp(packageName);
    await sleep(motion.pause('afterOpenApp'));

    let current: 'feed' | 'reels' = surface === 'reels' ? 'reels' : 'feed';
    await ensureSurface(driver, current, tapping, sleep);

    if (options.account) {
        const switchOptions = {
            ...(options.recognize ? { recognize: options.recognize } : {}), ...(signal ? { signal } : {}), motion,
        };
        await switchAccount(driver, options.account, switchOptions);
        // The switch leaves the app on the Profile tab; the loop below expects a scrollable surface.
        await ensureSurface(driver, current, tapping, sleep);
    }

    const startedAt = now();
    const deadline = startedAt + sessionLength * 60_000;
    // 'both' spends the first half on the feed and the rest in reels.
    const switchAt = surface === 'both' ? startedAt + (sessionLength * 60_000) / 2 : Number.POSITIVE_INFINITY;
    const running = () => !stopped && !signal?.aborted && hasTimeRemaining(now(), deadline);

    /**
     * Search, then come back. Results open into a grid; opening one and flicking through a few
     * posts is what a person does, and two Back presses land on the surface the run came from.
     */
    const runSearch = async (term: string): Promise<boolean> => {
        if (!await tapIfPresent(driver, 'Search', selectors.searchEntry, tapping)) return false;
        await sleep(1_200);
        await tapIfPresent(driver, 'Search field', selectors.searchField, tapping);
        await driver.type(term);
        await driver.pressKey('enter');
        await sleep(2_500);
        if (await tapIfPresent(driver, 'Top result', selectors.searchResult, tapping)) {
            await sleep(2_000);
            for (let index = 0; index < 3 && running(); index += 1) {
                await swipeToNextPost(driver, motion);
                await sleep(clampToDeadline(now(), deadline, motion.pause('betweenVideos')));
            }
            await driver.pressKey('back');
            await sleep(800);
        }
        await driver.pressKey('back');
        await sleep(1_200);
        await ensureSurface(driver, current, tapping, sleep);
        return true;
    };

    while (running()) {
        if (current === 'feed' && now() >= switchAt) {
            current = 'reels';
            surfaceSwitches += 1;
            console.log('Moving from the feed to reels');
            await ensureSurface(driver, current, tapping, sleep);
            if (!running()) break;
        }

        if (session && persona) {
            // ---- The persona loop: read the post, then decide from who this account is. ----
            const post = await readVideo(driver, options.recognize);
            const decision = decideForVideo(persona, post, session.state, random);
            console.log(decision.reason);

            await sleep(clampToDeadline(now(), deadline, decision.watchMs));
            postsViewed += 1;
            if (!running()) break;

            if (likeEnabled && decision.like) {
                await sleep(clampToDeadline(now(), deadline, motion.pause('beforeLike')));
                if (await tapIfPresent(driver, 'Like', selectors.like, tapping)) likes += 1;
            }
            if (saveEnabled && decision.save && running()) {
                await sleep(clampToDeadline(now(), deadline, motion.pause('afterLike')));
                if (await tapIfPresent(driver, 'Save', selectors.save, tapping)) saves += 1;
            }
            if (followEnabled && decision.follow && running()) {
                await sleep(clampToDeadline(now(), deadline, motion.pause('beforeLike')));
                if (await tapIfPresent(driver, 'Follow', selectors.follow, tapping)) follows += 1;
            }
            noteDecision(session, post, decision);
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

            await swipeToNextPost(driver, motion);
            swipes += 1;
            continue;
        }

        // ---- The fallback loop: the three-personality coin flips, with no persona to ask. ----
        await sleep(clampToDeadline(now(), deadline, pickWatchDurationMs(profile, random)));
        postsViewed += 1;
        if (!running()) break;

        if (likeEnabled && decideLike(profile, random)) {
            await sleep(clampToDeadline(now(), deadline, motion.pause('beforeLike')));
            if (!running()) break;
            if (await tapIfPresent(driver, 'Like', selectors.like, tapping)) likes += 1;
        }
        if (!running()) break;

        if (saveEnabled && decideSave(profile, random)) {
            await sleep(clampToDeadline(now(), deadline, motion.pause('afterLike')));
            if (!running()) break;
            if (await tapIfPresent(driver, 'Save', selectors.save, tapping)) saves += 1;
        }
        if (!running()) break;

        const { linger, extraMs } = decideLinger(profile, random);
        if (linger) await sleep(clampToDeadline(now(), deadline, extraMs));
        if (!running()) break;

        await sleep(clampToDeadline(now(), deadline, motion.pause('beforeSwipe')));
        if (!running()) break;

        await swipeToNextPost(driver, motion);
        swipes += 1;
    }

    // Leave the phone on its home screen rather than looping the last reel until the next run.
    try {
        await driver.pressKey('home');
        console.log('Left Instagram on the home screen');
    } catch (error) {
        console.log(`Could not press Home at the end: ${error instanceof Error ? error.message : String(error)}`);
    }

    const summary: WarmupSummary = {
        postsViewed, swipes, likes, saves, follows, searches, surfaceSwitches,
        elapsedMs: now() - runStartedAt,
        reason: stopped || signal?.aborted ? 'stopped' : 'completed',
    };
    if (session) {
        finishSession(session, { minutes: summary.elapsedMs / 60_000, ending: summary.reason });
        console.log(`Finished Instagram warm-up as ${persona!.handle}: ${describeSession(session)} · ${summary.reason}`);
        await options.saveMemory?.(session.memory);
    } else {
        console.log(
            `Finished Instagram warm-up: postsViewed=${summary.postsViewed} swipes=${summary.swipes} likes=${summary.likes} `
            + `saves=${summary.saves} elapsedMs=${summary.elapsedMs} reason=${summary.reason}`,
        );
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

/** Reads the environment contract the plugin's `warmup` task writes. */
export async function runFromEnvironment(): Promise<void> {
    const personality = process.env.WARMUP_PERSONALITY ?? 'casual';
    if (!isPersonality(personality)) {
        throw new Error(`WARMUP_PERSONALITY must be one of skimmer, casual, engaged; received ${personality}`);
    }
    const surface = process.env.WARMUP_SURFACE ?? 'both';
    if (!isWarmupSurface(surface)) {
        throw new Error(`WARMUP_SURFACE must be one of feed, reels, both; received ${surface}`);
    }
    const account = process.env.INSTAGRAM_SWITCH_ACCOUNT?.trim() || undefined;
    // WARMUP_PERSONA is set by the plugin whenever the account has one; the personality profile
    // stays behind it as the fallback for a run that asked for the old model.
    const usePersona = booleanEnv('WARMUP_PERSONA', false) && Boolean(account);
    const persona = usePersona ? await personaFor(account!) : undefined;
    const memory = persona ? await readMemory(persona.handle) : undefined;
    // Stop is a SIGTERM from the executor; every wait races the abort so it lands immediately.
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
    // With a persona and no explicit duration, the session picks its own length.
    const explicitDuration = process.env.WARMUP_DURATION_MINUTES !== undefined || !persona;
    await warmupOnAndroid(driverFromEnv(), {
        ...(explicitDuration ? { durationMinutes: boundedInteger('WARMUP_DURATION_MINUTES', 5, 1, 180) } : {}),
        surface,
        personality,
        likeEnabled: booleanEnv('WARMUP_LIKE_ENABLED', true),
        saveEnabled: booleanEnv('WARMUP_SAVE_ENABLED', true),
        followEnabled: booleanEnv('WARMUP_FOLLOW_ENABLED', true),
        searchEnabled: booleanEnv('WARMUP_SEARCH_ENABLED', true),
        packageName: process.env.INSTAGRAM_PACKAGE?.trim() || INSTAGRAM_ANDROID_PACKAGE,
        ...(process.env.MOTION_SEED ? { seed: process.env.MOTION_SEED } : {}),
        ...(motionFromEnvironment() ? { motion: motionFromEnvironment()! } : {}),
        recognize: recognizeOnDevice,
        signal: controller.signal,
        ...(account ? { account } : {}),
        ...(persona ? { persona } : {}),
        ...(memory ? { memory, saveMemory: (updated) => writeMemory(updated) } : {}),
    });
}

/** Entrypoint: `node --import tsx src/instagram/android/warmup.ts`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runFromEnvironment();
}
