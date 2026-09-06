/**
 * The human motion model: what a thumb actually does to a screen, as numbers.
 *
 * Every function here is pure — same seed, same path — and every random draw goes through the
 * injected generator, never `Math.random`. The prose version lives in docs/motion.md.
 */

import type { Point, TimedPoint } from '../drivers/types.js';
import { clamp, logNormal, rngFrom, uniform, type Rng, type Seed } from './rng.js';

export type Direction = 'up' | 'down' | 'left' | 'right';
export type Hand = 'right' | 'left';
export type Speed = 'slow' | 'normal' | 'fast';

export interface Screen {
    width: number;
    height: number;
}

/** How much longer or shorter than "normal" this person's gestures run. */
export const SPEED_FACTORS: Record<Speed, number> = { slow: 1.28, normal: 1, fast: 0.78 };

/**
 * The band a feed swipe's duration is drawn from, before the speed factor. Measured against
 * real thumb flicks: below ~180 ms the phone reads a fling, above ~420 ms it reads a drag.
 */
export const SWIPE_DURATION_MS = { min: 180, max: 420 } as const;

/** Samples per path. Fewer than a dozen looks like a polyline; more than two dozen is wasted work. */
export const SAMPLE_COUNT = { min: 12, max: 24 } as const;

/** Bow, as a fraction of the swipe's length. A thumb is hinged, not a ruler, but it is not a bracket either. */
export const CURVATURE = { min: 0.02, max: 0.07 } as const;

/**
 * Where a thumb can comfortably start: the lower third of the screen, on its own side. The
 * numbers are fractions of width and height.
 */
export const THUMB_ZONE = {
    top: 0.62,
    bottom: 0.90,
    right: { left: 0.46, right: 0.86 },
    left: { left: 0.14, right: 0.54 },
} as const;

/** How often a flick ends with the finger already off the glass, short of the full travel. */
export const EARLY_LIFT_CHANCE = 0.12;

/** Keep a path off the very edge, where a swipe becomes a system back or notification gesture. */
const EDGE_MARGIN = 0.03;

export interface ThumbSwipeOptions {
    screen: Screen;
    direction: Direction;
    /** Which thumb is on the glass. Defaults to right, the way most of the world holds a phone. */
    hand?: Hand;
    /** Travel as a fraction of the screen's height (up/down) or width (left/right). Drawn when absent. */
    length?: number;
    /** Stretches or compresses the duration; the shape is unchanged. */
    speed?: Speed;
    seed: Seed;
}

function round(value: number): number {
    return Math.round(value * 10) / 10;
}

function unitVector(from: Point, to: Point): Point {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
}

/**
 * Which way the arc bulges. A right thumb pivots at the bottom right, so its path bows *left* of
 * the straight line (and a left thumb's bows right) — the classic tell that a swipe was drawn by
 * a hand rather than by a line-drawing routine. For a sideways swipe the left/right test says
 * nothing, so the bow goes downwards instead, towards the pivot at the base of the thumb.
 */
export function bowDirection(from: Point, to: Point, hand: Hand): Point {
    const { x: dx, y: dy } = unitVector(from, to);
    const perpendicular = { x: -dy, y: dx };
    const wanted = hand === 'right' ? -1 : 1;
    if (Math.abs(perpendicular.x) > 1e-6) {
        return Math.sign(perpendicular.x) === wanted
            ? perpendicular
            : { x: -perpendicular.x, y: -perpendicular.y };
    }
    return perpendicular.y >= 0 ? perpendicular : { x: -perpendicular.x, y: -perpendicular.y };
}

/**
 * Distance covered by time `u` (both normalised to 0..1) as a cubic Bézier ease: slow off the
 * mark, quick through the middle, easing out at the end. `c1` and `c2` are drawn per swipe, which
 * is what stops every flick from having the same acceleration fingerprint. Monotonic for any
 * c1, c2 in [0, 1], so time and distance never run backwards.
 */
export function easeProgress(u: number, c1: number, c2: number): number {
    const inverse = 1 - u;
    return 3 * inverse * inverse * u * c1 + 3 * inverse * u * u * c2 + u * u * u;
}

function quadraticBezier(from: Point, control: Point, to: Point, p: number): Point {
    const inverse = 1 - p;
    return {
        x: inverse * inverse * from.x + 2 * inverse * p * control.x + p * p * to.x,
        y: inverse * inverse * from.y + 2 * inverse * p * control.y + p * p * to.y,
    };
}

export interface PathOptions {
    durationMs: number;
    hand?: Hand;
    /** Bow as a fraction of the path length; drawn from CURVATURE when absent. */
    curvature?: number;
    samples?: number;
    /** Allow the finger to leave the glass short of `to`. On for feed swipes, off for a precise drag. */
    earlyLift?: boolean;
    seed: Seed;
    screen?: Screen;
}

/**
 * An arced, unevenly-timed path between two points. `thumbSwipe` decides *where* a swipe goes;
 * this decides what the finger does on the way.
 */
export function pathBetween(from: Point, to: Point, options: PathOptions): TimedPoint[] {
    const random = rngFrom(options.seed);
    const hand = options.hand ?? 'right';
    const duration = Math.max(1, Math.round(options.durationMs));
    const curvature = options.curvature ?? uniform(random, CURVATURE.min, CURVATURE.max);
    const samples = options.samples ?? Math.round(uniform(random, SAMPLE_COUNT.min, SAMPLE_COUNT.max));
    const c1 = uniform(random, 0.18, 0.32);
    const c2 = uniform(random, 0.72, 0.90);
    // The finger lifts a little before the stroke would have finished; the phone still reads the
    // flick because what it measures is velocity, not where the movement stopped.
    const lift = options.earlyLift !== false && random() < EARLY_LIFT_CHANCE
        ? uniform(random, 0.82, 0.94)
        : 1;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const bow = bowDirection(from, to, hand);
    const control = {
        x: (from.x + to.x) / 2 + bow.x * curvature * length,
        y: (from.y + to.y) / 2 + bow.y * curvature * length,
    };
    const count = Math.max(2, samples);
    const points: TimedPoint[] = [];
    for (let index = 0; index < count; index += 1) {
        const u = (index / (count - 1)) * lift;
        const at = quadraticBezier(from, control, to, easeProgress(u, c1, c2));
        const bounded = options.screen ? insideScreen(at, options.screen) : at;
        points.push({ x: round(bounded.x), y: round(bounded.y), t: Math.round(u * duration) });
    }
    return monotonicTimes(points);
}

/** Rounding can flatten two neighbouring samples onto the same millisecond; nudge them apart. */
function monotonicTimes(points: TimedPoint[]): TimedPoint[] {
    let previous = -1;
    return points.map((point) => {
        const t = point.t > previous ? point.t : previous + 1;
        previous = t;
        return { ...point, t };
    });
}

function insideScreen(point: Point, screen: Screen): Point {
    return {
        x: clamp(point.x, screen.width * EDGE_MARGIN, screen.width * (1 - EDGE_MARGIN)),
        y: clamp(point.y, screen.height * EDGE_MARGIN, screen.height * (1 - EDGE_MARGIN)),
    };
}

/** The start point, jittered inside the thumb's reachable zone for that hand. */
export function thumbZoneStart(screen: Screen, hand: Hand, random: Rng): Point {
    const band = hand === 'right' ? THUMB_ZONE.right : THUMB_ZONE.left;
    return {
        x: uniform(random, screen.width * band.left, screen.width * band.right),
        y: uniform(random, screen.height * THUMB_ZONE.top, screen.height * THUMB_ZONE.bottom),
    };
}

const AXIS: Record<Direction, { axis: 'x' | 'y'; sign: 1 | -1 }> = {
    up: { axis: 'y', sign: -1 },
    down: { axis: 'y', sign: 1 },
    left: { axis: 'x', sign: -1 },
    right: { axis: 'x', sign: 1 },
};

/**
 * One thumb swipe: where it starts, how far it goes, how it bends, and how its speed varies —
 * as a list of timed points a driver can play back.
 */
export function thumbSwipe(options: ThumbSwipeOptions): TimedPoint[] {
    const random = rngFrom(options.seed);
    const { screen, direction } = options;
    const hand = options.hand ?? 'right';
    const speed = options.speed ?? 'normal';
    const { axis, sign } = AXIS[direction];
    const span = axis === 'y' ? screen.height : screen.width;
    const travel = (options.length ?? uniform(random, 0.42, 0.60)) * span * sign;
    const start = thumbZoneStart(screen, hand, random);
    // The zone is where the thumb rests; a swipe that would leave the glass slides its whole path
    // back inside rather than being cut short, so the flick keeps the length it was drawn with.
    const shift = axisShift(start[axis] + travel, span);
    const from = { ...start, [axis]: start[axis] + shift } as Point;
    const to = { ...from, [axis]: from[axis] + travel } as Point;
    const duration = Math.round(uniform(random, SWIPE_DURATION_MS.min, SWIPE_DURATION_MS.max) * SPEED_FACTORS[speed]);
    return pathBetween(from, to, { durationMs: duration, hand, seed: random, screen });
}

/** How far the path has to move along its axis to keep both ends on the glass. */
function axisShift(end: number, span: number): number {
    const low = span * EDGE_MARGIN;
    const high = span * (1 - EDGE_MARGIN);
    if (end < low) return low - end;
    if (end > high) return high - end;
    return 0;
}

/** A dead-straight two-point drag: the escape hatch for replaying a recorded straight gesture. */
export function straightPath(from: Point, to: Point, durationMs: number): TimedPoint[] {
    const duration = Math.max(1, Math.round(durationMs));
    return [{ x: from.x, y: from.y, t: 0 }, { x: to.x, y: to.y, t: duration }];
}

export interface HumanTap {
    point: Point;
    /** How long the finger stays down. Below 40 ms some views never see the press at all. */
    pressMs: number;
}

/** Nobody hits the same pixel twice, and nobody holds for exactly 50 ms. */
export function humanTap(point: Point, seed: Seed, jitterPx = 6): HumanTap {
    const random = rngFrom(seed);
    return {
        point: {
            x: round(point.x + uniform(random, -jitterPx, jitterPx)),
            y: round(point.y + uniform(random, -jitterPx, jitterPx)),
        },
        pressMs: Math.round(uniform(random, 40, 120)),
    };
}

/** The gaps a routine waits out, each with its own shape. */
export type PauseKind =
    /** Deciding this one is over and reaching for the next. */
    | 'betweenVideos'
    /** The beat between "this is good" and the thumb arriving on the heart. */
    | 'beforeLike'
    /** Watching the heart animation before doing anything else. */
    | 'afterLike'
    /** Waiting out a cold start and the first frames. */
    | 'afterOpenApp'
    /** Winding up to the flick once the decision is made. */
    | 'beforeSwipe'
    /** A tap answering something that just appeared. */
    | 'reaction';

export interface PauseShape {
    medianMs: number;
    /** Spread of the log-normal, in natural logs. 0.35 is tight; 0.6 is scattered. */
    sigma: number;
    minMs: number;
    maxMs: number;
    /** How often attention leaves the phone entirely. */
    distractedChance: number;
    /** What a distracted pause multiplies the draw by, at both ends. */
    distractedFactor: readonly [number, number];
}

export const PAUSE_SHAPES: Record<PauseKind, PauseShape> = {
    betweenVideos: { medianMs: 900, sigma: 0.55, minMs: 220, maxMs: 6_000, distractedChance: 0.03, distractedFactor: [4, 14] },
    beforeLike: { medianMs: 620, sigma: 0.45, minMs: 180, maxMs: 3_500, distractedChance: 0.01, distractedFactor: [3, 8] },
    afterLike: { medianMs: 750, sigma: 0.45, minMs: 200, maxMs: 4_000, distractedChance: 0.01, distractedFactor: [3, 8] },
    afterOpenApp: { medianMs: 3_200, sigma: 0.35, minMs: 1_200, maxMs: 12_000, distractedChance: 0.02, distractedFactor: [2, 5] },
    beforeSwipe: { medianMs: 420, sigma: 0.5, minMs: 120, maxMs: 2_500, distractedChance: 0.02, distractedFactor: [4, 12] },
    reaction: { medianMs: 520, sigma: 0.4, minMs: 150, maxMs: 3_000, distractedChance: 0.01, distractedFactor: [3, 8] },
};

/** The ceiling a pause of this kind can actually reach, distraction included. */
export function pauseCeilingMs(kind: PauseKind): number {
    const shape = PAUSE_SHAPES[kind];
    return Math.round(shape.maxMs * shape.distractedFactor[1]);
}

/**
 * A pause of the given kind: log-normal around its median, occasionally multiplied by a
 * distraction. The two draws are taken unconditionally so the generator advances by the same
 * amount whether or not the person looked away — a run stays reproducible either way.
 */
export function pauseMs(kind: PauseKind, seed: Seed): number {
    const random = rngFrom(seed);
    const shape = PAUSE_SHAPES[kind];
    const base = clamp(logNormal(random, shape.medianMs, shape.sigma), shape.minMs, shape.maxMs);
    const distracted = random() < shape.distractedChance;
    const factor = uniform(random, shape.distractedFactor[0], shape.distractedFactor[1]);
    return Math.round(distracted ? base * factor : base);
}

/** Two paths are "the same" when every sample and every timestamp matches. */
export function pathKey(path: readonly TimedPoint[]): string {
    return path.map(({ x, y, t }) => `${x},${y},${t}`).join(';');
}
