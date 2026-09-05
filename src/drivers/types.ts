/**
 * One interface, one implementation per control channel.
 * Routines talk to this; nothing above it knows which phone or channel is underneath.
 * See docs/adr/0001-multi-platform-device-drivers.md.
 */

export type Platform = 'ios' | 'android';

export type DriverKind = 'wda' | 'adb' | 'a11y-bridge';

export interface Point {
    x: number;
    y: number;
}

export interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface ScreenGeometry {
    /** Width and height in the driver's touch coordinate space (points on iOS, pixels on Android). */
    width: number;
    height: number;
    /** Pixels per coordinate unit. 1 on Android; 2 or 3 on iOS. */
    scale: number;
}

export interface Swipe {
    from: Point;
    to: Point;
    durationMs: number;
}

/** A node from the accessibility tree, normalised across platforms. */
export interface UiNode {
    /** Android `resource-id`, iOS accessibility identifier; empty string when absent. */
    id: string;
    /** Android `class`, iOS element type (XCUIElementTypeButton, ...). */
    type: string;
    /** Visible text or label. */
    text: string;
    /** Android `content-desc`, iOS `label` when it differs from `text`. */
    description: string;
    bounds: Rect;
    clickable: boolean;
    enabled: boolean;
    children: UiNode[];
}

export type Key = 'home' | 'back' | 'enter' | 'delete';

/** A file to place where the platform's gallery / TikTok picker will find it. */
export interface MediaFile {
    localPath: string;
    /** File name on the device; defaults to the local basename. */
    fileName?: string;
    /** Needed by the iOS import; inferred from the extension when absent. */
    mimeType?: string;
}

export interface DeviceDriver {
    readonly kind: DriverKind;
    readonly platform: Platform;
    readonly udid: string;

    /** Bundle id on iOS, package name on Android. */
    launchApp(appId: string): Promise<void>;
    terminateApp(appId: string): Promise<void>;

    tap(point: Point): Promise<void>;
    swipe(swipe: Swipe): Promise<void>;
    /** Types into whatever currently has focus. */
    type(text: string): Promise<void>;
    pressKey(key: Key): Promise<void>;

    /** PNG bytes. */
    screenshot(): Promise<Buffer>;
    /** Root of the accessibility tree; may be expensive, call once per verification step. */
    uiTree(): Promise<UiNode>;
    screen(): Promise<ScreenGeometry>;

    pushMedia(file: MediaFile): Promise<void>;

    /** Sleep that rejects promptly when the execution is stopped. */
    pause(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

/** Android-specific connection details stored on the device record. */
export interface AndroidDeviceConfig {
    /** `adb` serial, e.g. `R58N12ABCDE` or `192.168.1.40:5555` for wireless debugging. */
    serial: string;
    /** sim-use bridge base URL, e.g. `http://127.0.0.1:18300` (adb forward to the phone's 8080) or `http://192.168.1.40:8080` (Wi-Fi). */
    bridgeUrl?: string;
    /** Bearer token minted by the bridge's ContentProvider during bootstrap. */
    bridgeToken?: string;
}

export class DriverError extends Error {}

export class UnsupportedOperationError extends DriverError {
    constructor(kind: DriverKind, operation: string) {
        super(`${kind} driver does not support ${operation}`);
    }
}
