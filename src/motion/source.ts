/**
 * One person's hand, for the length of one run.
 *
 * `gesture.ts` is pure: same seed, same path. That is what makes a run reproducible, but on its
 * own it would happily hand out the same swipe twice. A source holds the generator between calls,
 * so every gesture continues the run's stream — and refuses to emit a path identical to the one
 * before it.
 */

import type { Point, TimedPoint } from '../drivers/types.js';
import {
    humanTap, pathBetween, pathKey, pauseMs, straightPath, thumbSwipe,
    type Direction, type HumanTap, type PauseKind, type Screen,
} from './gesture.js';
import { motionProfileFor, type MotionProfile, type MotionSettings } from './profile.js';
import { rngFrom, type Rng, type Seed } from './rng.js';

export interface MotionSourceOptions {
    /** Gives the device its stable handedness and pace when `settings` leaves them out. */
    udid: string;
    /** One seed per execution; see `seedForExecution`. */
    seed: Seed;
    settings?: MotionSettings;
}

export interface SwipeOptions {
    direction?: Direction;
    length?: number;
}

export interface MotionSource {
    readonly profile: MotionProfile;
    /** The run's own generator, for the few decisions outside the gesture model (session length). */
    readonly random: Rng;
    /** A thumb swipe across this screen. Defaults to the feed's upward flick. */
    swipe(screen: Screen, options?: SwipeOptions): TimedPoint[];
    /** An arced path between two points a caller already chose. */
    path(from: Point, to: Point, durationMs: number): TimedPoint[];
    tap(point: Point): HumanTap;
    pause(kind: PauseKind): number;
}

/** How many redraws before a repeated path is accepted as the generator's own business. */
const REDRAW_LIMIT = 4;

export function createMotionSource(options: MotionSourceOptions): MotionSource {
    const profile = motionProfileFor(options.udid, options.settings);
    const random = rngFrom(options.seed);
    let lastKey = '';
    const unique = (draw: () => TimedPoint[]): TimedPoint[] => {
        for (let attempt = 0; attempt < REDRAW_LIMIT; attempt += 1) {
            const path = draw();
            const key = pathKey(path);
            if (key !== lastKey) {
                lastKey = key;
                return path;
            }
        }
        // Four identical draws in a row is not chance; hand back something deliberately different
        // rather than looping. One millisecond is invisible on the glass and unmistakable in a log.
        const path = draw().map((point, index) => (index === 0 ? point : { ...point, t: point.t + 1 }));
        lastKey = pathKey(path);
        return path;
    };

    return {
        profile,
        random,
        swipe: (screen, swipeOptions = {}) => unique(() => thumbSwipe({
            screen,
            direction: swipeOptions.direction ?? 'up',
            hand: profile.hand,
            speed: profile.speed,
            seed: random,
            ...(swipeOptions.length !== undefined ? { length: swipeOptions.length } : {}),
        })),
        path: (from, to, durationMs) => unique(() => pathBetween(from, to, {
            durationMs, hand: profile.hand, seed: random,
        })),
        tap: (point) => humanTap(point, random),
        pause: (kind) => pauseMs(kind, random),
    };
}

/**
 * The seed a driver uses when nothing upstream set one. `MOTION_SEED` is exported by the executor
 * for the plugin child process, so a scheduled run's every gesture replays from the run's own
 * seed; a driver used outside a run gets a fresh one per process.
 */
export function defaultMotionSeed(udid: string): string {
    return `${process.env.MOTION_SEED ?? `${Date.now()}:${process.pid}`}:${udid}`;
}

/** A driver's own hand: profile and seed resolved once, path generation on demand. */
export function driverMotion(udid: string, settings?: MotionSettings, seed?: Seed): MotionSource {
    return createMotionSource({ udid, seed: seed ?? defaultMotionSeed(udid), ...(settings ? { settings } : {}) });
}

export { straightPath };
