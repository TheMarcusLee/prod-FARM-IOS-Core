import { errorMessage, httpClient, pause, type HttpClient } from './common.js';
import {
    DriverError, UnsupportedOperationError,
    type DeviceDriver, type Key, type Point, type ScreenGeometry, type Swipe, type UiNode,
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
    /**
     * The bridge has no launch/terminate/push verbs (an AccessibilityService cannot start apps).
     * Hand it an adb driver for those, or leave undefined to have them throw. Launching by
     * tapping the home-screen icon is the attachment-free alternative and lives in the routine.
     */
    fallback?: Pick<DeviceDriver, 'launchApp' | 'terminateApp' | 'pushMedia'>;
}

const ANDROID_KEYCODES: Record<Key, number> = { home: 3, back: 4, enter: 66, delete: 67 };

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
    const http = httpClient(options.fetchImpl, timeoutMs);
    // A full-screen PNG and a deep accessibility tree both take the phone noticeably longer to
    // produce than a gesture does, and a timeout here reads as "the device is gone".
    const slowHttp = httpClient(options.fetchImpl, timeoutMs * 4);
    const call = <T>(method: 'GET' | 'POST', route: string, params?: Record<string, string>) => bridgeCall<T>(http, baseUrl, token, method, route, params);
    const slowCall = <T>(method: 'GET' | 'POST', route: string, params?: Record<string, string>) => bridgeCall<T>(slowHttp, baseUrl, token, method, route, params);
    type FallbackOperation = 'launchApp' | 'terminateApp' | 'pushMedia';
    const fallback = <K extends FallbackOperation>(operation: K): Pick<DeviceDriver, FallbackOperation>[K] => {
        const target = options.fallback?.[operation];
        if (!target) throw new UnsupportedOperationError('a11y-bridge', `${operation} without a fallback driver`);
        return target;
    };
    let cachedScreen: ScreenGeometry | undefined;

    return {
        kind: 'a11y-bridge',
        platform: 'android',
        udid: serial,
        launchApp: async (appId) => fallback('launchApp')(appId),
        terminateApp: async (appId) => fallback('terminateApp')(appId),
        tap: async ({ x, y }: Point) => { await call('POST', '/tap', { x: String(x), y: String(y) }); },
        swipe: async ({ from, to, durationMs }: Swipe) => {
            await call('POST', '/swipe', {
                startX: String(from.x), startY: String(from.y), endX: String(to.x), endY: String(to.y), duration: String(durationMs),
            });
        },
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

async function bridgeCall<T>(
    http: HttpClient, baseUrl: string, token: string,
    method: 'GET' | 'POST', route: string, params: Record<string, string> = {},
): Promise<T> {
    const query = method === 'GET' && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
    const response = await http(`${baseUrl}${route}${query}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(method === 'POST' ? { body: new URLSearchParams(params).toString() } : {}),
    });
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
