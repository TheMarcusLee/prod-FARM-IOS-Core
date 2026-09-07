import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMotionSource } from '../motion/source.js';
import type { MotionSettings } from '../motion/profile.js';
import { clampToDeadline, hasTimeRemaining } from '../tiktok/doomscroll-profile.js';
import { tapCoordinate } from '../tiktok/actions.js';
import { recognizeWords } from '../tiktok/ocr.js';
import { decideForVideo, decideSearch } from '../persona/decide.js';
import { defaultPersona, personaFor } from '../persona/model.js';
import { emptyMemory, readMemory, writeMemory } from '../persona/memory.js';
import { videoFromWords } from '../persona/observe.js';
import { beginSession, describeSession, finishSession, noteDecision, noteSearch } from '../persona/session.js';
import { booleanEnv, boundedInteger, openSession, prepareDevice, switchThreadsAccount } from './ios-session.js';

/**
 * The Threads warm-up on an iPhone.
 *
 * Same run as the Android one — persona decides, motion paces, Home at the end — with two forced
 * differences: XCUITest cannot see into the feed, so every read is OCR over a screenshot, and
 * every tap is a coordinate out of the device's `threads` profile rather than a tree lookup.
 *
 * As on Android, the persona's *save* signal is spent on a **repost**: Threads has no bookmark in
 * the post row, and a repost is the gesture that means the same thing.
 *
 * **Every coordinate is unverified.** See docs/coordinates.md.
 */

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
    const udid = process.env.IOS_UDID?.trim();
    if (!udid) throw new Error('IOS_UDID is required. Copy .env.example to .env and set the connected device UDID.');

    const account = process.env.THREADS_SWITCH_ACCOUNT?.trim() || undefined;
    const likeEnabled = booleanEnv('WARMUP_LIKE_ENABLED', true);
    const repostEnabled = booleanEnv('WARMUP_REPOST_ENABLED', false);
    const followEnabled = booleanEnv('WARMUP_FOLLOW_ENABLED', true);
    const searchEnabled = booleanEnv('WARMUP_SEARCH_ENABLED', true);
    const explicitDuration = process.env.WARMUP_DURATION_MINUTES === undefined
        ? undefined : boundedInteger('WARMUP_DURATION_MINUTES', 10, 1, 180);

    const usePersona = booleanEnv('WARMUP_PERSONA', false) && Boolean(account);
    const persona = usePersona ? await personaFor(account!) : defaultPersona(account ?? '@backline');
    const memory = usePersona ? await readMemory(persona.handle) : emptyMemory(persona.handle);
    const session = beginSession(persona, memory, Math.random, new Date());
    if (!session.plan.active && explicitDuration === undefined) {
        console.log(`Not browsing Threads as ${persona.handle}: ${session.plan.reason}`);
        return;
    }
    const durationMinutes = explicitDuration ?? session.plan.minutes;

    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());

    const seed = process.env.MOTION_SEED ?? `${Date.now()}:${udid}`;
    const settings = motionFromEnvironment();
    const motion = createMotionSource({ udid, seed, ...(settings ? { settings } : {}) });

    const device = await prepareDevice(udid);
    /** OCR words in the shape `src/persona/observe.ts` reads: a rect rather than x/y/w/h. */
    const readScreen = async () => (await recognizeWords(await device.remote.getScreenshot(udid)))
        .map((word) => ({
            text: word.text,
            bounds: { left: word.x, top: word.y, right: word.x + word.width, bottom: word.y + word.height },
        }));
    const coordinates = device.threads;
    const driver = await openSession(udid);

    let postsViewed = 0;
    let swipes = 0;
    let likes = 0;
    let reposts = 0;
    let follows = 0;
    let searches = 0;
    const startedAt = Date.now();
    // ±15%: nobody puts the phone down after exactly the number of minutes they meant to.
    const sessionLength = durationMinutes * (0.85 + (motion.random() * 0.3));
    const deadline = startedAt + (sessionLength * 60_000);
    const running = () => !controller.signal.aborted && hasTimeRemaining(Date.now(), deadline);
    console.log(
        `Starting a Threads warm-up as ${persona.handle}: seed=${seed} hand=${motion.profile.hand} `
        + `speed=${motion.profile.speed} plan=${session.plan.reason} sessionMinutes=${sessionLength.toFixed(1)} `
        + `likeEnabled=${likeEnabled} repostEnabled=${repostEnabled}`,
    );

    try {
        if (account) {
            await driver.pause(2_000);
            await switchThreadsAccount(driver, device.remote, udid, account, coordinates, motion);
        }
        await tapCoordinate(driver, coordinates.homeTab.x, coordinates.homeTab.y, 'Home tab', motion);
        await driver.pause(motion.pause('afterOpenApp'));

        while (running()) {
            // XCUITest cannot read the feed; OCR over a screenshot is the only read there is.
            const post = videoFromWords(await readScreen());
            const decision = decideForVideo(persona, post, session.state, Math.random);
            console.log(decision.reason);
            await driver.pause(clampToDeadline(Date.now(), deadline, decision.watchMs));
            postsViewed += 1;
            if (!running()) break;

            if (likeEnabled && decision.like) {
                await driver.pause(clampToDeadline(Date.now(), deadline, motion.pause('beforeLike')));
                await tapCoordinate(driver, coordinates.like.x, coordinates.like.y, 'Like', motion);
                likes += 1;
            }
            if (repostEnabled && decision.save && running()) {
                await driver.pause(clampToDeadline(Date.now(), deadline, motion.pause('afterLike')));
                await tapCoordinate(driver, coordinates.repost.x, coordinates.repost.y, 'Repost', motion);
                await driver.pause(1_200);
                // The icon raises a sheet whose first row is the repost itself.
                await tapCoordinate(driver, coordinates.repost.x, coordinates.repost.y + 60, 'the repost sheet', motion);
                reposts += 1;
            }
            if (followEnabled && decision.follow && running()) {
                await driver.pause(clampToDeadline(Date.now(), deadline, motion.pause('beforeLike')));
                await tapCoordinate(driver, coordinates.follow.x, coordinates.follow.y, 'Follow', motion);
                follows += 1;
            }
            noteDecision(session, post, decision);
            if (!running()) break;

            const search = decideSearch(persona, session.state, Math.random);
            if (search && searchEnabled) {
                console.log(`${search.reason} (iOS warm-up does not drive the search screen yet; noted only)`);
                noteSearch(session, search);
                searches += 1;
            }

            await driver.pause(clampToDeadline(Date.now(), deadline, motion.pause('beforeSwipe')));
            if (!running()) break;
            await device.remote.performAction(udid, {
                type: 'gesture',
                path: motion.swipe({ width: device.screenSize.width, height: device.screenSize.height }, { direction: 'up' }),
            });
            swipes += 1;
        }
    } finally {
        await driver.deleteSession();
        // Leave the phone on its home screen rather than parked inside the feed until the next run.
        try {
            await device.remote.performAction(udid, { type: 'home' });
            console.log('Left Threads on the home screen');
        } catch (error) {
            console.log(`Could not press Home at the end: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const elapsedMs = Date.now() - startedAt;
    const ending = controller.signal.aborted ? 'stopped' : 'completed';
    finishSession(session, { minutes: elapsedMs / 60_000, ending });
    if (usePersona) await writeMemory(session.memory);
    console.log(
        `Finished the Threads warm-up as ${persona.handle}: ${describeSession(session)} · ${ending} · `
        + `postsViewed=${postsViewed} swipes=${swipes} likes=${likes} reposts=${reposts} follows=${follows} searches=${searches}`,
    );
}

/** Entrypoint: `node --import tsx src/threads/warmup.ts`. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runFromEnvironment();
}
