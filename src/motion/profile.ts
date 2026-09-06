/**
 * Which "person" holds a given phone. Handedness and pace are per-device and stable: the same
 * udid always gets the same hand, whether or not anyone configured it, so a phone does not change
 * grip between runs.
 */

import { hashSeed } from './rng.js';
import type { Hand, Speed } from './gesture.js';

/** The optional `motion` block on a registered device. */
export interface MotionSettings {
    hand?: Hand;
    speed?: Speed;
}

export interface MotionProfile {
    hand: Hand;
    speed: Speed;
}

export const HANDS: readonly Hand[] = ['right', 'left'];
export const SPEEDS: readonly Speed[] = ['slow', 'normal', 'fast'];

/**
 * Roughly one phone in ten is held left-handed, and pace splits 25/50/25 — the point is not the
 * exact figures but that a fleet is not uniform and does not need configuring to stop being so.
 */
export function defaultMotionProfile(udid: string): MotionProfile {
    const hash = hashSeed(`backline:motion:profile:${udid}`);
    const hand: Hand = hash % 10 === 0 ? 'left' : 'right';
    const pace = Math.floor(hash / 10) % 4;
    const speed: Speed = pace === 0 ? 'slow' : pace === 3 ? 'fast' : 'normal';
    return { hand, speed };
}

/** The device's own settings where it has them, the udid's stable default everywhere else. */
export function motionProfileFor(udid: string, settings?: MotionSettings): MotionProfile {
    const fallback = defaultMotionProfile(udid);
    return { hand: settings?.hand ?? fallback.hand, speed: settings?.speed ?? fallback.speed };
}

/** The first problem with a `motion` block from the API, or null. */
export function motionSettingsProblem(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) return 'motion must be an object';
    const { hand, speed, ...rest } = value as Record<string, unknown>;
    const unknownKeys = Object.keys(rest);
    if (unknownKeys.length) return `motion has no ${unknownKeys[0]} setting`;
    if (hand !== undefined && !HANDS.includes(hand as Hand)) return 'motion.hand must be "right" or "left"';
    if (speed !== undefined && !SPEEDS.includes(speed as Speed)) return 'motion.speed must be "slow", "normal" or "fast"';
    return null;
}

/** The whitelisted `motion` block, or undefined when nothing was set. Throws on anything else. */
export function validateMotionSettings(value: unknown): MotionSettings | undefined {
    const problem = motionSettingsProblem(value);
    if (problem) throw new Error(problem);
    if (value === undefined || value === null) return undefined;
    const { hand, speed } = value as MotionSettings;
    const settings: MotionSettings = { ...(hand ? { hand } : {}), ...(speed ? { speed } : {}) };
    return Object.keys(settings).length ? settings : undefined;
}
