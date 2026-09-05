import { httpClient, pause, type HttpClient } from './common.js';
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
    /**
     * The bridge has no launch/terminate/push verbs (an AccessibilityService cannot start apps).
     * Hand it an adb driver for those, or leave undefined to have them throw. Launching by
     * tapping the home-screen icon is the attachment-free alternative and lives in the routine.
     */
    fallback?: Pick<DeviceDriver, 'launchApp' | 'terminateApp' | 'pushMedia'>;
}

const ANDROID_KEYCODES: Record<Key, number> = { home: 3, back: 4, enter: 66, delete: 67 };

/** `GET /ping` is the bridge's one unauthenticated route; a 200 means the service is up. */
export function bridgePingUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, '')}/ping`;
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
    const baseUrl = options.baseUrl.replace(/\/$/, '');
    const http = httpClient(options.fetchImpl);
    const call = <T>(method: 'GET' | 'POST', route: string, params?: Record<string, string>) => bridgeCall<T>(http, baseUrl, token, method, route, params);
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
        screenshot: async () => {
            const b64 = await call<string>('GET', '/screenshot');
            return Buffer.from(b64, 'base64');
        },
        uiTree: async () => normaliseBridgeNode(await call<BridgeNode>('GET', '/a11y_tree_full', { filter: 'true' })),
        screen: async () => {
            // The bridge reports no display metrics; the root node's bounds are the screen.
            cachedScreen ??= screenFromRoot(normaliseBridgeNode(await call<BridgeNode>('GET', '/a11y_tree_full', { filter: 'false' })));
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
    const envelope = await response.json() as BridgeEnvelope<T>;
    if (envelope.status !== 'success') throw new DriverError(`bridge ${route} failed: ${envelope.error ?? 'unknown error'}`);
    return envelope.result as T;
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

function screenFromRoot(root: UiNode): ScreenGeometry {
    const { right, bottom } = root.bounds;
    if (!right || !bottom) throw new DriverError('bridge root node has no bounds; cannot infer screen size');
    return { width: right, height: bottom, scale: 1 };
}
