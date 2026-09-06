import type { MotionSettings } from '../motion/profile.js';
import type { Seed } from '../motion/rng.js';
import { driverMotion, straightPath, type MotionSource } from '../motion/source.js';
import { errorMessage, pause } from './common.js';
import {
    DriverError, UnsupportedOperationError,
    type DeviceDriver, type Key, type Point, type ScreenGeometry, type Swipe, type TimedPoint, type UiNode,
} from './types.js';

export interface A11yBridgeDriverOptions {
    /** adb serial, kept as the farm UDID so the same device can switch drivers without re-registering. */
    serial: string;
    /** `http://127.0.0.1:<forwarded port>` today; `http://<phone-ip>:<port>` once the APK fork listens on Wi-Fi. */
    baseUrl: string;
    /** Bearer token read from the bridge ContentProvider at bootstrap. */
    token: string;
    fetchImpl?: typeof fetch;
    /** Deadline for a tap/swipe/key call. Screenshots and tree reads get four times this. */
    timeoutMs?: number;
    /** Test seam for the retry backoff; production sleeps for real. */
    sleep?: (milliseconds: number) => Promise<void>;
    /**
     * The bridge has no launch/terminate/push verbs (an AccessibilityService cannot start apps).
     * Hand it an adb driver for those, or leave undefined to have them throw. Launching by
     * tapping the home-screen icon is the attachment-free alternative and lives in the routine.
     */
    fallback?: Pick<DeviceDriver, 'launchApp' | 'terminateApp' | 'pushMedia'>;
    /** Handedness and pace for the generated swipe arcs; defaults to the serial's stable profile. */
    motion?: MotionSettings;
    /** One seed per run, so a replay draws the same paths. Defaults to `MOTION_SEED` or the clock. */
    motionSeed?: Seed;
}

/**
 * The body of a `/gesture` request carrying a sampled path. The bridge dispatches it as a single
 * `StrokeDescription` along an Android `Path`, so the arc reaches the phone as an arc.
 */
export function gestureParams(path: readonly TimedPoint[]): Record<string, string> {
    if (path.length < 2) throw new DriverError('A gesture needs at least two points');
    return {
        points: JSON.stringify(path.map(({ x, y, t }) => ({ x, y, t }))),
    };
}

const ANDROID_KEYCODES: Record<Key, number> = { home: 3, back: 4, enter: 66, delete: 67, recents: 187, power: 26 };

/**
 * The bridge answers `503 {"status":"error","code":"server_busy"}` when its on-device handler
 * queue is full — a transient "ask again", not a failed step. Its tiny HTTP server also drops
 * connections under load, which arrives here as a transport-level reset. Three retries over just
 * over a second cover a queue draining behind one slow screenshot without turning a genuinely
 * wedged bridge into a long stall.
 */
export const BRIDGE_RETRY_BACKOFF_MS = [200, 400, 800] as const;

/** Node's fetch reports a dropped socket through a cause; the message is what varies by version. */
function connectionReset(error: unknown): boolean {
    const text = `${errorMessage(error)} ${errorMessage((error as { cause?: unknown } | undefined)?.cause)}`;
    if (/timed out|timeout|abort/i.test(text)) return false;
    return /ECONNRESET|EPIPE|socket hang up|other side closed|closed prematurely|terminated|fetch failed/i.test(text);
}

/** Trailing slashes are what a copy-pasted base URL usually arrives with. */
export function normaliseBridgeUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '');
}

/** `GET /ping` is the bridge's one unauthenticated route; a 200 means the service is up. */
export function bridgePingUrl(baseUrl: string): string {
    return `${normaliseBridgeUrl(baseUrl)}/ping`;
}

interface BridgeEnvelope<T> {
    status: 'success' | 'error';
    result?: T;
    error?: string;
}

/**
 * Android via the sim-use device bridge: a Kotlin AccessibilityService + HTTP server running on
 * the phone. Taps and swipes are dispatched on-device (`dispatchGesture`), the tree comes from
 * the live accessibility hierarchy, and nothing is attached while it runs once the port is reachable.
 */
export function createA11yBridgeDriver(options: A11yBridgeDriverOptions): DeviceDriver {
    const { serial, token } = options;
    const baseUrl = normaliseBridgeUrl(options.baseUrl);
    const timeoutMs = options.timeoutMs ?? 10_000;
    const sleep = options.sleep ?? ((milliseconds: number) => pause(milliseconds));
    const fetchImpl = options.fetchImpl ?? fetch;
    const context = (deadlineMs: number): BridgeContext => ({ fetchImpl, sleep, baseUrl, token, timeoutMs: deadlineMs });
    const fast = context(timeoutMs);
    // A full-screen PNG and a deep accessibility tree both take the phone noticeably longer to
    // produce than a gesture does, and a timeout here reads as "the device is gone".
    const slow = context(timeoutMs * 4);
    const call = <T>(method: 'GET' | 'POST', route: string, params?: Record<string, string>) => bridgeCall<T>(fast, method, route, params);
    const slowCall = <T>(method: 'GET' | 'POST', route: string, params?: Record<string, string>) => bridgeCall<T>(slow, method, route, params);
    type FallbackOperation = 'launchApp' | 'terminateApp' | 'pushMedia';
    const fallback = <K extends FallbackOperation>(operation: K): Pick<DeviceDriver, FallbackOperation>[K] => {
        const target = options.fallback?.[operation];
        if (!target) throw new UnsupportedOperationError('a11y-bridge', `${operation} without a fallback driver`);
        return target;
    };
    let cachedScreen: ScreenGeometry | undefined;
    let hand: MotionSource | undefined;
    const motion = () => (hand ??= driverMotion(serial, options.motion, options.motionSeed));
    const gesture = async (path: readonly TimedPoint[]): Promise<void> => {
        await call('POST', '/gesture', gestureParams(path));
    };

    return {
        kind: 'a11y-bridge',
        platform: 'android',
        udid: serial,
        launchApp: async (appId) => fallback('launchApp')(appId),
        terminateApp: async (appId) => fallback('terminateApp')(appId),
        tap: async ({ x, y }: Point) => { await call('POST', '/tap', { x: String(x), y: String(y) }); },
        swipe: ({ from, to, durationMs, straight }: Swipe) => gesture(
            straight ? straightPath(from, to, durationMs) : motion().path(from, to, durationMs),
        ),
        gesture,
        type: async (text) => {
            await call('POST', '/keyboard/input', { base64_text: Buffer.from(text, 'utf8').toString('base64'), clear: 'false' });
        },
        pressKey: async (key) => { await call('POST', '/keyboard/key', { key_code: String(ANDROID_KEYCODES[key]) }); },
        screenshot: async () => decodeScreenshot(await slowCall<unknown>('GET', '/screenshot')),
        uiTree: async () => normaliseBridgeNode(await slowCall<BridgeNode>('GET', '/a11y_tree_full', { filter: 'true' })),
        screen: async () => {
            // The bridge reports no display metrics; the outermost node bounds are the screen.
            cachedScreen ??= screenFromTree(normaliseBridgeNode(await slowCall<BridgeNode>('GET', '/a11y_tree_full', { filter: 'false' })));
            return cachedScreen;
        },
        pushMedia: async (file) => fallback('pushMedia')(file),
        pause,
    };
}

interface BridgeContext {
    fetchImpl: typeof fetch;
    sleep: (milliseconds: number) => Promise<void>;
    baseUrl: string;
    token: string;
    timeoutMs: number;
}

/** A short, quoted excerpt of whatever the bridge said, for the message. */
async function detailOf(response: Response): Promise<string> {
    const body = (await response.text().catch(() => '')).trim().replace(/\s+/g, ' ');
    return body ? `: ${body.slice(0, 200)}` : '';
}

/**
 * The statuses the on-device server actually produces, each turned into something an operator can
 * act on rather than a bare "returned 408".
 */
async function statusError(route: string, url: string, response: Response, attempts: number): Promise<DriverError> {
    const detail = await detailOf(response);
    switch (response.status) {
        case 503:
            return new DriverError(`bridge ${route} is still busy after ${attempts} attempts — its handler queue is full `
                + `(503 server_busy). Something else is driving this phone, or a screenshot is still being encoded${detail}`);
        case 408:
            return new DriverError(`bridge ${route} timed out reading the request (408) — the phone's HTTP server gave up `
                + `waiting for the body. Usually a Wi-Fi link dropping mid-request${detail}`);
        case 411:
            return new DriverError(`bridge ${route} rejected a chunked request (411) — it needs a Content-Length, so the `
                + `body must be a complete string and never a stream${detail}`);
        default:
            return new DriverError(`${url} returned ${response.status}${detail}`);
    }
}

async function bridgeCall<T>(
    context: BridgeContext,
    method: 'GET' | 'POST', route: string, params: Record<string, string> = {},
): Promise<T> {
    const query = method === 'GET' && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
    const url = `${context.baseUrl}${route}${query}`;
    const init: RequestInit = {
        method,
        headers: {
            authorization: `Bearer ${context.token}`,
            // The bridge's server is a handful of worker threads with no keep-alive bookkeeping;
            // a reused connection is what shows up here as a reset mid-request.
            connection: 'close',
            ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        // A complete string, never a stream: a chunked body is what the bridge answers 411 to.
        ...(method === 'POST' ? { body: new URLSearchParams(params).toString() } : {}),
    };
    const attempts = BRIDGE_RETRY_BACKOFF_MS.length + 1;
    for (let attempt = 0; ; attempt += 1) {
        const retriesLeft = attempt < BRIDGE_RETRY_BACKOFF_MS.length;
        let response: Response;
        try {
            response = await context.fetchImpl(url, { ...init, signal: AbortSignal.timeout(context.timeoutMs) });
        } catch (error) {
            if (retriesLeft && connectionReset(error)) {
                await context.sleep(BRIDGE_RETRY_BACKOFF_MS[attempt]!);
                continue;
            }
            throw new DriverError(`${url} is unavailable: ${errorMessage(error)}`);
        }
        if (response.status === 503 && retriesLeft) {
            await response.text().catch(() => '');
            await context.sleep(BRIDGE_RETRY_BACKOFF_MS[attempt]!);
            continue;
        }
        if (!response.ok) throw await statusError(route, url, response, attempts);
        let envelope: BridgeEnvelope<T>;
        try {
            envelope = await response.json() as BridgeEnvelope<T>;
        } catch (error) {
            // A captive portal, a stale `adb forward` pointing at something else, or a crashed
            // service all answer 200 with something that is not the bridge's envelope.
            throw new DriverError(`bridge ${route} did not return JSON: ${errorMessage(error)}`);
        }
        if (!envelope || typeof envelope !== 'object') throw new DriverError(`bridge ${route} returned ${JSON.stringify(envelope)}, not an envelope`);
        if (envelope.status !== 'success') throw new DriverError(`bridge ${route} failed: ${envelope.error ?? 'unknown error'}`);
        return envelope.result as T;
    }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The bridge answers with base64 PNG bytes, sometimes behind a `data:` prefix. */
export function decodeScreenshot(result: unknown): Buffer {
    if (typeof result !== 'string' || !result) throw new DriverError(`bridge /screenshot returned ${typeof result}, not base64 text`);
    const base64 = result.replace(/^data:image\/\w+;base64,/, '').trim();
    const image = Buffer.from(base64, 'base64');
    if (!image.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
        throw new DriverError(`bridge /screenshot decoded to ${image.length} bytes that are not a PNG`);
    }
    return image;
}

export interface BridgeNode {
    resourceId?: string;
    className?: string;
    text?: string;
    contentDescription?: string;
    boundsInScreen?: { left: number; top: number; right: number; bottom: number };
    clickable?: boolean;
    enabled?: boolean;
    children?: BridgeNode[];
}

export function normaliseBridgeNode(node: BridgeNode): UiNode {
    return {
        id: node.resourceId ?? '',
        type: node.className ?? '',
        text: node.text ?? '',
        description: node.contentDescription ?? '',
        bounds: node.boundsInScreen ?? { left: 0, top: 0, right: 0, bottom: 0 },
        clickable: node.clickable === true,
        enabled: node.enabled !== false,
        children: (node.children ?? []).map(normaliseBridgeNode),
    };
}

/**
 * The root of an accessibility tree is not always the window: on some builds it is a wrapper with
 * empty bounds, and on others the status bar sits in a sibling window. Take the widest and tallest
 * edge anywhere in the tree rather than trusting the root alone.
 */
export function screenFromTree(root: UiNode): ScreenGeometry {
    let width = 0;
    let height = 0;
    const visit = (node: UiNode): void => {
        width = Math.max(width, node.bounds.right);
        height = Math.max(height, node.bounds.bottom);
        for (const child of node.children) visit(child);
    };
    visit(root);
    if (width <= 0 || height <= 0) throw new DriverError('bridge accessibility tree has no bounds; cannot infer screen size');
    return { width, height, scale: 1 };
}
