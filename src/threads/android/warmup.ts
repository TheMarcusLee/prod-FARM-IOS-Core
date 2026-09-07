import path from 'node:path';
import { resolveTable } from '../../drivers/selector-overrides.js';
import { THREADS_PLUGIN_ID } from '../../plugin-ids.js';
import { fileURLToPath } from 'node:url';

import type { DeviceDriver } from '../../drivers/types.js';
import type { Recognize } from '../../drivers/verify.js';
import type { MotionSettings } from '../../motion/profile.js';
import { createMotionSource, type MotionSource } from '../../motion/source.js';
import { clampToDeadline, hasTimeRemaining } from '../../tiktok/doomscroll-profile.js';
import { decideForVideo, decideSearch } from '../../persona/decide.js';
import { defaultPersona, personaFor, type Persona } from '../../persona/model.js';
import { emptyMemory, readMemory, writeMemory, type PersonaMemory } from '../../persona/memory.js';
import { readVideo } from '../../persona/observe.js';
import { beginSession, describeSession, finishSession, noteDecision, noteSearch } from '../../persona/session.js';
import { driverFromEnv } from '../../tiktok/android/driver-from-env.js';
import { recognizeOnDevice, tapIfPresent, waitForAny, type SelectorList, type TapOptions } from './ui.js';
import { THREADS_ANDROID_PACKAGE, switchAccount } from './post.js';

/**
 * The Threads warm-up: browse the For You feed as the account's persona.
 *
 * The decision layer is `src/persona/**` unchanged — it reads whatever text is on screen and
 * answers "would this account watch, like, keep, follow?". Threads has no bookmark in the post
 * row, so the persona's *save* signal is spent on a **repost**, which is the equivalent gesture:
 * the thing an account does when a post is worth passing on rather than merely worth a heart.
 *
 * Pacing is `src/motion` — every flick is a fresh arc out of the run's seed, every gap between
 * gestures is drawn from the same stream. The run ends by pressing Home, always, including when
 * it was stopped.
 */
export const FEED_SELECTORS = {
    /** Bottom navigation "Home"; only used after an account switch leaves the app on Profile. */
    homeTab: [
        { id: 'feed_tab' }, { id: 'home_tab' }, { text: 'Home', exact: true }, { text: 'For you', exact: true },
    ] as SelectorList,
    /** The heart under a post. Content-desc changes once liked, so both states are listed. GUESS. */
    like: [
        { id: 'row_feed_button_like' }, { id: 'like_button' },
        { text: 'Like', exact: true }, { text: 'Unlike', exact: true }, { text: 'Liked', exact: true },
    ] as SelectorList,
    /** The two-arrow repost icon. GUESS. */
    repost: [
        { id: 'row_feed_button_repost' }, { id: 'repost_button' },
        { text: 'Repost', exact: true }, { text: 'Reposted', exact: true },
    ] as SelectorList,
    /** The sheet the repost icon raises, where the actual Repost row lives. GUESS. */
    repostConfirm: [
        { id: 'repost_row' }, { text: 'Repost', exact: true }, { text: 'Repost now' },
    ] as SelectorList,
    /** Follow, on the post header or the profile hovercard. GUESS. */
    follow: [
        { id: 'row_feed_button_follow' }, { id: 'follow_button' }, { text: 'Follow', exact: true },
    ] as SelectorList,
    /** The magnifier in the bottom bar. GUESS. */
    searchEntry: [{ id: 'search_tab' }, { id: 'tab_search' }, { text: 'Search', exact: true }] as SelectorList,
    /** The text field on the search screen. GUESS. */
    searchField: [{ id: 'action_bar_search_edit_text' }, { id: 'search_input' }, { text: 'Search', exact: false }] as SelectorList,
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

export interface WarmupOnAndroidOptions {
    /** Absent with a persona means "ask the persona how long it feels like browsing". */
    durationMinutes?: number;
    likeEnabled: boolean;
    repostEnabled: boolean;
    followEnabled?: boolean;
    searchEnabled?: boolean;
    /** The persona to browse as. Absent means a default persona derived from the handle. */
    persona?: Persona;
    /** What the account remembers; the run reads the follow rule and "already followed" from it. */
    memory?: PersonaMemory;
    /** Where to put the memory back. The env runner writes the file; tests keep it in hand. */
    saveMemory?: (memory: PersonaMemory) => Promise<void>;
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
    reposts: number;
    follows: number;
    searches: number;
    elapsedMs: number;
    /** 'asleep' is a persona refusing to browse outside its active hours — not a failure. */
    reason: 'completed' | 'stopped' | 'asleep';
}

/**
 * A warm-up must start on the feed. Threads may open on a profile, a notification or a
 * half-written thread, so: tap the Home tab if a tab bar is visible, otherwise back out and try
 * again. Never fatal — the run logs what it saw and carries on.
 */
async function ensureFeed(
    driver: DeviceDriver, tapping: TapOptions | undefined,
    sleep: (ms: number) => Promise<void>,
): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await tapIfPresent(driver, 'Home tab', selectors.homeTab, tapping)) {
            console.log('On the feed');
            return;
        }
        console.log(`No tab bar on screen (attempt ${attempt + 1}); pressing back`);
        await driver.pressKey('back');
        await sleep(900);
    }
    try {
        await waitForAny(driver, 'the Threads feed', selectors.homeTab, { timeoutMs: 8_000 });
        console.log('On the feed');
    } catch (error) {
        console.log(`Could not confirm the feed; browsing anyway. ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** ±15%: nobody puts the phone down after exactly the number of minutes they meant to. */
export function sessionMinutes(requested: number, random: () => number): number {
    return requested * (0.85 + random() * 0.3);
}

export async function warmupOnAndroid(driver: DeviceDriver, options: WarmupOnAndroidOptions): Promise<WarmupSummary> {
    // One read of the override store per run, before the first tap: the flow below then uses
    // the corrected table exactly as it used the built-in one.
    selectors = await resolveTable(THREADS_PLUGIN_ID, driver.udid, FEED_SELECTORS);
    const { likeEnabled, repostEnabled, signal } = options;
    const random = options.random ?? Math.random;
    const now = options.now ?? Date.now;
    const packageName = options.packageName ?? THREADS_ANDROID_PACKAGE;
    const seed = options.seed ?? process.env.MOTION_SEED ?? `${Date.now()}:${driver.udid}`;
    const motion = createMotionSource({
        udid: driver.udid, seed, ...(options.motion ? { settings: options.motion } : {}),
    });
    // Every tap in the run comes out of the run's own seeded hand, the same one the swipes do.
    const tapping: TapOptions = { ...(options.recognize ? { recognize: options.recognize } : {}), motion };
    const followEnabled = options.followEnabled ?? true;
    const searchEnabled = options.searchEnabled ?? true;
    // Every handle has a persona: a stored one, or the default derived from the handle itself.
    const persona = options.persona ?? defaultPersona(options.account ?? '@backline');

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
    const memory = options.memory ?? emptyMemory(persona.handle);
    const session = beginSession(persona, memory, random, new Date(now()));
    if (!session.plan.active && options.durationMinutes === undefined) {
        console.log(`Not browsing Threads as ${persona.handle}: ${session.plan.reason}`);
        return { postsViewed: 0, swipes: 0, likes: 0, reposts: 0, follows: 0, searches: 0, elapsedMs: 0, reason: 'asleep' };
    }
    const durationMinutes = options.durationMinutes ?? session.plan.minutes;

    let postsViewed = 0;
    let swipes = 0;
    let likes = 0;
    let reposts = 0;
    let follows = 0;
    let searches = 0;
    const runStartedAt = now();
    const sessionLength = sessionMinutes(durationMinutes, motion.random);
    console.log(
        `Starting a Threads warm-up as ${persona.handle}: seed=${seed} hand=${motion.profile.hand} speed=${motion.profile.speed} `
        + `plan=${session.plan.reason} requestedDurationMinutes=${durationMinutes} sessionMinutes=${sessionLength.toFixed(1)} `
        + `likeEnabled=${likeEnabled} repostEnabled=${repostEnabled}`,
    );

    // A phone that dozed off shows nothing and launches nothing; wake it first.
    await driver.pressKey('wake');
    console.log(`Launching ${packageName} on ${driver.udid}`);
    await driver.launchApp(packageName);
    await sleep(motion.pause('afterOpenApp'));
    await ensureFeed(driver, tapping, sleep);

    if (options.account) {
        const switchOptions = {
            ...(options.recognize ? { recognize: options.recognize } : {}), ...(signal ? { signal } : {}), motion,
        };
        await switchAccount(driver, options.account, switchOptions);
        // The switch leaves the app on the Profile tab; the loop below expects the feed.
        await ensureFeed(driver, tapping, sleep);
    }

    const deadline = now() + sessionLength * 60_000;
    const running = () => !stopped && !signal?.aborted && hasTimeRemaining(now(), deadline);

    /** Repost is a two-step gesture: the icon raises a sheet whose first row is the repost itself. */
    const repost = async (): Promise<boolean> => {
        if (!await tapIfPresent(driver, 'Repost', selectors.repost, tapping)) return false;
        await sleep(motion.pause('afterLike'));
        // Some builds repost straight from the icon; then there is no sheet to confirm.
        await tapIfPresent(driver, 'the repost sheet', selectors.repostConfirm, tapping);
        return true;
    };

    /** Search, then come back. Two Back presses land on the feed the run came from. */
    const runSearch = async (term: string): Promise<boolean> => {
        if (!await tapIfPresent(driver, 'Search', selectors.searchEntry, tapping)) return false;
        await sleep(1_200);
        await tapIfPresent(driver, 'the search field', selectors.searchField, tapping);
        await driver.type(term);
        await driver.pressKey('enter');
        await sleep(2_500);
        for (let index = 0; index < 3 && running(); index += 1) {
            await driver.gesture(motion.swipe(await driver.screen(), { direction: 'up' }));
            await sleep(clampToDeadline(now(), deadline, motion.pause('betweenVideos')));
        }
        await driver.pressKey('back');
        await sleep(1_200);
        await ensureFeed(driver, tapping, sleep);
        return true;
    };

    while (running()) {
        // `readVideo` is the persona's eye: on Android it reads the accessibility tree, which on
        // Threads carries the handle, the body and the hashtags — the same bag of strings a TikTok
        // video gives it.
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
        // The persona's "keep this" signal; on Threads that gesture is a repost.
        if (repostEnabled && decision.save && running()) {
            await sleep(clampToDeadline(now(), deadline, motion.pause('afterLike')));
            if (await repost()) reposts += 1;
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

        await driver.gesture(motion.swipe(await driver.screen(), { direction: 'up' }));
        swipes += 1;
    }

    // Leave the phone on its home screen rather than parked inside the feed until the next run.
    try {
        await driver.pressKey('home');
        console.log('Left Threads on the home screen');
    } catch (error) {
        console.log(`Could not press Home at the end: ${error instanceof Error ? error.message : String(error)}`);
    }

    const summary: WarmupSummary = {
        postsViewed, swipes, likes, reposts, follows, searches,
        elapsedMs: now() - runStartedAt,
        reason: stopped || signal?.aborted ? 'stopped' : 'completed',
    };
    finishSession(session, { minutes: summary.elapsedMs / 60_000, ending: summary.reason });
    console.log(`Finished the Threads warm-up as ${persona.handle}: ${describeSession(session)} · ${summary.reason}`);
    await options.saveMemory?.(session.memory);
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

export async function runFromEnvironment(): Promise<void> {
    const account = process.env.THREADS_SWITCH_ACCOUNT?.trim() || undefined;
    const usePersona = booleanEnv('WARMUP_PERSONA', false) && Boolean(account);
    const persona = usePersona ? await personaFor(account!) : undefined;
    const memory = persona ? await readMemory(persona.handle) : undefined;
    // Stop is a SIGTERM from the executor; every wait races the abort so it lands immediately.
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
    // With a persona and no explicit duration, the session picks its own length.
    const explicitDuration = process.env.WARMUP_DURATION_MINUTES !== undefined || !persona;
    await warmupOnAndroid(driverFromEnv(), {
        ...(explicitDuration ? { durationMinutes: boundedInteger('WARMUP_DURATION_MINUTES', 10, 1, 180) } : {}),
        likeEnabled: booleanEnv('WARMUP_LIKE_ENABLED', true),
        repostEnabled: booleanEnv('WARMUP_REPOST_ENABLED', false),
        followEnabled: booleanEnv('WARMUP_FOLLOW_ENABLED', true),
        searchEnabled: booleanEnv('WARMUP_SEARCH_ENABLED', true),
        packageName: process.env.THREADS_PACKAGE?.trim() || THREADS_ANDROID_PACKAGE,
        ...(process.env.MOTION_SEED ? { seed: process.env.MOTION_SEED } : {}),
        ...(motionFromEnvironment() ? { motion: motionFromEnvironment()! } : {}),
        recognize: recognizeOnDevice,
        signal: controller.signal,
        ...(account ? { account } : {}),
        ...(persona ? { persona } : {}),
        ...(memory ? { memory, saveMemory: (updated) => writeMemory(updated) } : {}),
    });
}

/** Entrypoint: `node --import tsx src/threads/android/warmup.ts`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runFromEnvironment();
}
