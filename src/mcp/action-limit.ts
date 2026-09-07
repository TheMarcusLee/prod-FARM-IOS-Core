/**
 * A ceiling on how fast an agent may touch a phone.
 *
 * The HTTP transport already counts MCP calls per token (`bucketFor` in routes/mobile.ts, the
 * `mcp` bucket), but that protects the server; this protects the *device*, the way the mobile
 * API's `action` bucket does for `/remote/action`. A retry loop hammering tap or swipe is a real
 * way to wedge a driver session, and over stdio there is no HTTP hook to count it at all — so the
 * limit lives in the tool set, keyed per device, where every transport goes through it.
 */

export interface ActionLimiter {
    /** Throws when this device has had its allowance in the current window. */
    check(udid: string): void;
}

export class ActionRateLimitError extends Error {}

function envNumber(name: string, fallback: number, environment: NodeJS.ProcessEnv): number {
    const parsed = Number(environment[name]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Same default and same environment variable as the mobile API's action bucket: 10 per second. */
export function createActionLimiter(
    now: () => number = Date.now, environment: NodeJS.ProcessEnv = process.env,
): ActionLimiter {
    const max = envNumber('RATE_LIMIT_ACTION', 10, environment);
    const windowMs = envNumber('RATE_LIMIT_ACTION_WINDOW_MS', 1_000, environment);
    const hits = new Map<string, number[]>();
    return {
        check(udid) {
            const at = now();
            const recent = (hits.get(udid) ?? []).filter((stamp) => at - stamp < windowMs);
            if (recent.length >= max) {
                throw new ActionRateLimitError(
                    `Too many device actions on ${udid}: at most ${max} every ${windowMs} ms. Slow down and read the screen between taps.`,
                );
            }
            recent.push(at);
            hits.set(udid, recent);
        },
    };
}
