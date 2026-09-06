/**
 * The one source of randomness the motion model uses. Everything else in `src/motion` takes an
 * `Rng` and never touches `Math.random`, so a run replays exactly from its seed (see docs/motion.md).
 */

/** Uniform in [0, 1), same shape as `Math.random`. */
export type Rng = () => number;

/** A seed, a seed string (execution id, udid) or an already-running generator. */
export type Seed = number | string | Rng;

/** FNV-1a, so a udid or an execution id becomes a stable 32-bit seed on every machine. */
export function hashSeed(value: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * mulberry32: 32 bits of state, one multiply-xorshift round per draw. Small enough to read, and
 * its period (2^32) is many orders of magnitude more swipes than a phone will ever make.
 */
export function createRng(seed: number | string): Rng {
    let state = (typeof seed === 'number' ? seed >>> 0 : hashSeed(seed)) || 0x9e3779b9;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

/** A `Seed` in whichever of its three forms, as a generator. */
export function rngFrom(seed: Seed): Rng {
    return typeof seed === 'function' ? seed : createRng(seed);
}

/** Uniform draw in [min, max). */
export function uniform(random: Rng, min: number, max: number): number {
    return min + random() * (max - min);
}

/** Box–Muller, one normal per call (the second is discarded: cheap, and keeps the draw count honest). */
export function normal(random: Rng): number {
    // Math.log(0) is -Infinity, and a mulberry32 draw can legitimately be exactly 0.
    const first = Math.max(random(), Number.EPSILON);
    const second = random();
    return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

/**
 * Log-normal: multiplicative noise around a median. Human gaps are never symmetric — a pause is
 * bounded below by reaction time and unbounded above by attention — which is what this shape says.
 */
export function logNormal(random: Rng, medianMs: number, sigma: number): number {
    return medianMs * Math.exp(sigma * normal(random));
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * The seed for one execution. Reproducible from the execution id alone, so a run can be replayed
 * for debugging, and different from every other execution because the id is.
 */
export function seedForExecution(executionId: string): number {
    return hashSeed(`backline:motion:${executionId}`);
}
