import path from 'node:path';
import { resolveTable } from '../../drivers/selector-overrides.js';
import { YOUTUBE_PLUGIN_ID } from '../../plugin-ids.js';
import { fileURLToPath } from 'node:url';

import type { DeviceDriver } from '../../drivers/types.js';
import type { Recognize } from '../../drivers/verify.js';
import type { MotionSettings } from '../../motion/profile.js';
import { createMotionSource, type MotionSource } from '../../motion/source.js';
// Pacing helpers and the pre-persona personality bands. Nothing in that file is TikTok-specific;
// it is where the first feed routine put them.
import {
    PROFILES, clampToDeadline, decideLike, decideLinger, hasTimeRemaining, isPersonality,
    pickWatchDurationMs, type Personality,
} from '../../tiktok/doomscroll-profile.js';
import { decideForVideo, type SessionState, type VideoDecision } from '../../persona/decide.js';
import { personaFor, type Persona } from '../../persona/model.js';
import { readMemory, writeMemory, type PersonaMemory } from '../../persona/memory.js';
import { readVideo } from '../../persona/observe.js';
import { beginSession, describeSession, finishSession, noteDecision } from '../../persona/session.js';
import { driverFromEnv } from '../../tiktok/android/driver-from-env.js';
import { recognizeOnDevice, tapIfPresent, waitForAny, type SelectorList, type TapOptions } from './ui.js';
import { YOUTUBE_ANDROID_PACKAGE, switchAccount } from './post.js';

/**
 * The Android YouTube warm-up: open YouTube, get onto the Shorts feed, and browse it as the
 * account's persona — watching for as long as the video is worth to it, liking, subscribing and
 * occasionally commenting, with every pause and flick coming out of `src/motion`. It ends by
 * pressing Home, so a phone is never left mid-feed between runs.
 *
 * The persona model (`src/persona/**`) is the decision layer; this file only knows how to find
 * controls and how to wait. Like maps onto the persona's `like`, subscribe onto its `follow` —
 * subscribing to a channel is the same judgement as following a creator — and commenting is a
 * rarer step gated by `decideComment` below.
 */
export const FEED_SELECTORS = {
    /** The Shorts entry in the bottom navigation. GUESS. */
    shortsTab: [
        { id: 'shorts_tab' }, { id: 'pivot_shorts' },
        { text: 'Shorts', exact: true }, { text: 'Shorts' },
    ] as SelectorList,
    /** Bottom-navigation Home, used to back out of whatever YouTube opened on. GUESS. */
    homeTab: [{ id: 'home_tab' }, { id: 'pivot_home' }, { text: 'Home', exact: true }] as SelectorList,
    /** The thumb. Content-desc changes once the Short is liked, so both states are listed. GUESS. */
    like: [
        { id: 'reel_like_button' }, { id: 'like_button' },
        { text: 'Like this video along with' }, { text: 'Like', exact: true }, { text: 'Unlike', exact: true },
    ] as SelectorList,
    /** The Subscribe pill under the channel name; absent once the account subscribes. GUESS. */
    subscribe: [
        { id: 'reel_subscribe_button' }, { id: 'subscribe_button' },
        { text: 'Subscribe', exact: true },
    ] as SelectorList,
    /** The comment bubble on the right rail. GUESS. */
    comment: [
        { id: 'reel_comment_button' }, { id: 'comments_entry_point' },
        { text: 'Comments', exact: true }, { text: 'Comment', exact: true },
    ] as SelectorList,
    /** The "Add a comment…" box inside the comment sheet. GUESS. */
    commentField: [
        { id: 'comment_edit_text' }, { id: 'create_comment' },
        { text: 'Add a comment' }, { text: 'Add a public comment' },
    ] as SelectorList,
    /** The send arrow beside the comment box. GUESS. */
    commentSend: [
        { id: 'send_button' }, { id: 'comment_send' }, { text: 'Comment', exact: true }, { text: 'Send', exact: true },
    ] as SelectorList,
    /** The channel handle under the Short; read, never tapped. GUESS. */
    creatorName: [{ id: 'reel_channel_bar' }, { id: 'channel_name' }, { id: 'author' }] as SelectorList,
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

/** Short, ASCII, unremarkable. A comment that reads like a bot is worse than no comment at all. */
export const COMMENT_PHRASES: readonly string[] = [
    'this is great', 'needed this today', 'love this', 'so good', 'nice one',
    'okay this is actually helpful', 'saving this for later', 'well done',
];

export interface CommentDecision {
    comment: boolean;
    text: string;
    reason: string;
}

/**
 * Whether the account says anything, and what. One draw, always — the same rule the persona
 * layer keeps, so a seeded run stays reproducible whatever the outcome.
 *
 * An account comments far less often than it likes: only on something that matched its interests,
 * only inside its own small budget, and then only about a fifth of the time.
 */
export function decideComment(
    persona: Persona, decision: VideoDecision, used: number, budget: number, draw: number, pick: number,
): CommentDecision {
    if (used >= budget || !decision.matched) {
        return { comment: false, text: '', reason: 'Said nothing · nothing worth commenting on' };
    }
    const chance = Math.min(0.35, persona.warmth * 0.2 + (decision.like ? 0.08 : 0));
    if (draw >= chance) return { comment: false, text: '', reason: 'Said nothing · read the comments and moved on' };
    const index = Math.min(COMMENT_PHRASES.length - 1, Math.floor(Math.max(0, Math.min(0.999999, pick)) * COMMENT_PHRASES.length));
    const text = COMMENT_PHRASES[index]!;
    return { comment: true, text, reason: `Commented · "${text}", ${used + 1} of ${budget} comments used` };
}

/** How many comments a session is allowed, derived from what the persona is willing to spend. */
export function commentBudget(state: SessionState): number {
    return Math.max(0, Math.round(state.budgets.saves / 2));
}

export interface WarmupOnAndroidOptions {
    /** Absent with a persona means "ask the persona how long it feels like watching". */
    durationMinutes?: number;
    /** The fallback model, for a run that deliberately asks for the old coin flips. */
    personality: Personality;
    likeEnabled: boolean;
    subscribeEnabled: boolean;
    commentEnabled: boolean;
    /** The persona to browse as. Absent falls back to the personality coin flips. */
    persona?: Persona;
    /** What the account remembers; the run reads the follow rule and "already subscribed" from it. */
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
    videosViewed: number;
    swipes: number;
    likes: number;
    subscribes: number;
    comments: number;
    elapsedMs: number;
    /** 'asleep' is a persona refusing to browse outside its active hours — not a failure. */
    reason: 'completed' | 'stopped' | 'asleep';
}

/**
 * A warm-up must start on the Shorts feed. YouTube may open on Home, a watch page, a notification
 * or a half-finished upload, so: tap Shorts if the tab bar is up, otherwise press back and try
 * again. Never fatal — the run logs what it saw and carries on, because a wrong guess in the
 * selector table should not cost the whole session.
 */
async function ensureShortsFeed(
    driver: DeviceDriver, tapping: TapOptions, sleep: (ms: number) => Promise<void>,
): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await tapIfPresent(driver, 'Shorts tab', selectors.shortsTab, tapping)) {
            await sleep(1_500);
            console.log('On the Shorts feed');
            return;
        }
        console.log(`No Shorts tab on screen (attempt ${attempt + 1}); pressing back`);
        await driver.pressKey('back');
        await sleep(900);
    }
    try {
        await waitForAny(driver, 'the Shorts feed', selectors.shortsTab, { timeoutMs: 8_000 });
        console.log('On the Shorts feed');
    } catch (error) {
        console.log(`Could not confirm the Shorts feed; browsing anyway. ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function swipeToNextShort(driver: DeviceDriver, motion: MotionSource): Promise<void> {
    await driver.gesture(motion.swipe(await driver.screen(), { direction: 'up' }));
}

/** ±15%: nobody puts the phone down after exactly the number of minutes they meant to. */
export function sessionMinutes(requested: number, random: () => number): number {
    return requested * (0.85 + random() * 0.3);
}

/** Only ASCII survives `adb shell input text`; a comment that cannot be typed is skipped, not fatal. */
function typeable(driver: DeviceDriver, text: string): boolean {
    if (driver.kind !== 'adb') return true;
    return [...text].every((character) => {
        const code = character.codePointAt(0)!;
        return code >= 0x20 && code <= 0x7e;
    });
}

export async function warmupOnAndroid(driver: DeviceDriver, options: WarmupOnAndroidOptions): Promise<WarmupSummary> {
    // One read of the override store per run, before the first tap: the flow below then uses
    // the corrected table exactly as it used the built-in one.
    selectors = await resolveTable(YOUTUBE_PLUGIN_ID, driver.udid, FEED_SELECTORS);
    const { personality, likeEnabled, subscribeEnabled, commentEnabled, signal, persona } = options;
    const random = options.random ?? Math.random;
    const now = options.now ?? Date.now;
    const profile = PROFILES[personality];
    const packageName = options.packageName ?? YOUTUBE_ANDROID_PACKAGE;
    const seed = options.seed ?? process.env.MOTION_SEED ?? `${Date.now()}:${driver.udid}`;
    const motion = createMotionSource({
        udid: driver.udid, seed, ...(options.motion ? { settings: options.motion } : {}),
    });
    // Every tap in the run comes out of the run's own seeded hand, the same one the swipes do.
    const tapping: TapOptions = { ...(options.recognize ? { recognize: options.recognize } : {}), motion };

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
        return { videosViewed: 0, swipes: 0, likes: 0, subscribes: 0, comments: 0, elapsedMs: 0, reason: 'asleep' };
    }
    const durationMinutes = options.durationMinutes ?? session?.plan.minutes ?? 5;

    let videosViewed = 0;
    let swipes = 0;
    let likes = 0;
    let subscribes = 0;
    let comments = 0;
    const runStartedAt = now();
    const sessionLength = sessionMinutes(durationMinutes, motion.random);
    console.log(
        `Starting YouTube warm-up${session ? ` as ${persona!.handle}` : ''}: seed=${seed} hand=${motion.profile.hand} `
        + `speed=${motion.profile.speed} ` + (session ? `plan=${session.plan.reason} ` : `profile=${personality} `)
        + `requestedDurationMinutes=${durationMinutes} sessionMinutes=${sessionLength.toFixed(1)} `
        + `likeEnabled=${likeEnabled} subscribeEnabled=${subscribeEnabled} commentEnabled=${commentEnabled}`,
    );

    // A phone that dozed off shows nothing and launches nothing; wake it first.
    await driver.pressKey('wake');
    console.log(`Launching ${packageName} on ${driver.udid}`);
    await driver.launchApp(packageName);
    await sleep(motion.pause('afterOpenApp'));

    if (options.account) {
        await switchAccount(driver, options.account, {
            ...(options.recognize ? { recognize: options.recognize } : {}), ...(signal ? { signal } : {}), motion,
        });
    }
    await ensureShortsFeed(driver, tapping, sleep);

    const deadline = now() + sessionLength * 60_000;
    const running = () => !stopped && !signal?.aborted && hasTimeRemaining(now(), deadline);
    const commentsAllowed = session ? commentBudget(session.state) : 0;

    /** The comment sheet: open it, say the line, send, come back to the Short. */
    const leaveComment = async (text: string): Promise<boolean> => {
        if (!await tapIfPresent(driver, 'Comments', selectors.comment, tapping)) return false;
        await sleep(motion.pause('reaction'));
        if (!await tapIfPresent(driver, 'comment box', selectors.commentField, tapping)) {
            await driver.pressKey('back');
            await sleep(800);
            return false;
        }
        await sleep(motion.pause('reaction'));
        await driver.type(text);
        await sleep(motion.pause('beforeLike'));
        const sent = await tapIfPresent(driver, 'Send comment', selectors.commentSend, tapping);
        await sleep(1_200);
        // Back out of the comment sheet whether or not the send landed, so the loop is on a Short.
        await driver.pressKey('back');
        await sleep(900);
        return sent;
    };

    while (running()) {
        if (session && persona) {
            // ---- The persona loop: read the Short, then decide from who this account is. ----
            const video = await readVideo(driver, options.recognize);
            const decision = decideForVideo(persona, video, session.state, random);
            console.log(decision.reason);

            await sleep(clampToDeadline(now(), deadline, decision.watchMs));
            videosViewed += 1;
            if (!running()) break;

            if (likeEnabled && decision.like) {
                await sleep(clampToDeadline(now(), deadline, motion.pause('beforeLike')));
                if (await tapIfPresent(driver, 'Like', selectors.like, tapping)) likes += 1;
            }
            // Subscribing is the persona's follow: the same "it keeps enjoying this channel" rule.
            if (subscribeEnabled && decision.follow && running()) {
                await sleep(clampToDeadline(now(), deadline, motion.pause('afterLike')));
                if (await tapIfPresent(driver, 'Subscribe', selectors.subscribe, tapping)) subscribes += 1;
            }
            noteDecision(session, video, decision);
            if (!running()) break;

            const said = decideComment(persona, decision, comments, commentsAllowed, random(), random());
            if (commentEnabled && said.comment) {
                console.log(said.reason);
                if (!typeable(driver, said.text)) {
                    console.log('Skipped the comment: this driver cannot type it');
                } else if (await leaveComment(said.text)) {
                    comments += 1;
                }
            }
            if (!running()) break;

            await sleep(clampToDeadline(now(), deadline, motion.pause('beforeSwipe')));
            if (!running()) break;

            await swipeToNextShort(driver, motion);
            swipes += 1;
            continue;
        }

        // ---- The fallback loop: the original personality coin flips, no comments. ----
        await sleep(clampToDeadline(now(), deadline, pickWatchDurationMs(profile, random)));
        videosViewed += 1;
        if (!running()) break;

        if (likeEnabled && decideLike(profile, random)) {
            await sleep(clampToDeadline(now(), deadline, motion.pause('beforeLike')));
            if (!running()) break;
            if (await tapIfPresent(driver, 'Like', selectors.like, tapping)) likes += 1;
        }
        if (!running()) break;

        const { linger, extraMs } = decideLinger(profile, random);
        if (linger) await sleep(clampToDeadline(now(), deadline, extraMs));
        if (!running()) break;

        await sleep(clampToDeadline(now(), deadline, motion.pause('beforeSwipe')));
        if (!running()) break;

        await swipeToNextShort(driver, motion);
        swipes += 1;
    }

    // Leave the phone on its home screen rather than looping the last Short until the next run.
    try {
        await driver.pressKey('home');
        console.log('Left YouTube on the home screen');
    } catch (error) {
        console.log(`Could not press Home at the end: ${error instanceof Error ? error.message : String(error)}`);
    }

    const summary: WarmupSummary = {
        videosViewed, swipes, likes, subscribes, comments,
        elapsedMs: now() - runStartedAt,
        reason: stopped || signal?.aborted ? 'stopped' : 'completed',
    };
    if (session) {
        finishSession(session, { minutes: summary.elapsedMs / 60_000, ending: summary.reason });
        console.log(`Finished YouTube warm-up as ${persona!.handle}: ${describeSession(session)} · ${summary.comments} comments · ${summary.reason}`);
        await options.saveMemory?.(session.memory);
    } else {
        console.log(
            `Finished YouTube warm-up: videosViewed=${summary.videosViewed} swipes=${summary.swipes} likes=${summary.likes} `
            + `subscribes=${summary.subscribes} comments=${summary.comments} elapsedMs=${summary.elapsedMs} reason=${summary.reason}`,
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

export async function runFromEnvironment(): Promise<void> {
    const personality = process.env.YOUTUBE_PERSONALITY ?? 'casual';
    if (!isPersonality(personality)) {
        throw new Error(`YOUTUBE_PERSONALITY must be one of skimmer, casual, engaged; received ${personality}`);
    }
    const account = process.env.YOUTUBE_SWITCH_ACCOUNT?.trim() || undefined;
    const usePersona = booleanEnv('YOUTUBE_PERSONA', false) && Boolean(account);
    const persona = usePersona ? await personaFor(account!) : undefined;
    const memory = persona ? await readMemory(persona.handle) : undefined;
    // Stop is a SIGTERM from the executor; every wait races the abort so it lands immediately.
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
    // With a persona and no explicit duration, the session picks its own length.
    const explicitDuration = process.env.YOUTUBE_DURATION_MINUTES !== undefined || !persona;
    await warmupOnAndroid(driverFromEnv(), {
        ...(explicitDuration ? { durationMinutes: boundedInteger('YOUTUBE_DURATION_MINUTES', 5, 1, 180) } : {}),
        personality,
        likeEnabled: booleanEnv('YOUTUBE_LIKE_ENABLED', true),
        subscribeEnabled: booleanEnv('YOUTUBE_SUBSCRIBE_ENABLED', true),
        commentEnabled: booleanEnv('YOUTUBE_COMMENT_ENABLED', false),
        packageName: process.env.YOUTUBE_PACKAGE?.trim() || YOUTUBE_ANDROID_PACKAGE,
        ...(process.env.MOTION_SEED ? { seed: process.env.MOTION_SEED } : {}),
        ...(motionFromEnvironment() ? { motion: motionFromEnvironment()! } : {}),
        recognize: recognizeOnDevice,
        signal: controller.signal,
        ...(account ? { account } : {}),
        ...(persona ? { persona } : {}),
        ...(memory ? { memory, saveMemory: (updated) => writeMemory(updated) } : {}),
    });
}

/** Entrypoint: `node --import tsx src/youtube/android/warmup.ts`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runFromEnvironment();
}
