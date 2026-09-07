/**
 * The decisions live video needs, with no DOM in sight: which mode a tile should be in, how a
 * frame header is read, and how a tap on a video lands in the phone's own coordinates. Kept
 * apart from `live.ts` so it can be tested outside a browser.
 */

export type ViewMode = 'off' | 'stills' | 'live';

/** The three notches of the wall's quality slider, in order. */
export const VIEW_MODES: readonly ViewMode[] = ['off', 'stills', 'live'];
export const VIEW_MODE_LABELS: Record<ViewMode, string> = { off: 'Off', stills: 'Stills', live: 'Live' };

/** Two failed sockets in a row is enough; the third attempt would just be a slower screenshot. */
export const MAX_SOCKET_FAILURES = 2;

/** Frames per second the stills pump uses on the wall when live video is not in play. */
export const STILLS_FPS = 1;

export function viewMode(notch: number): ViewMode {
    return VIEW_MODES[Math.max(0, Math.min(VIEW_MODES.length - 1, Math.round(notch)))] ?? 'live';
}

export function viewModeNotch(mode: ViewMode): number {
    return Math.max(0, VIEW_MODES.indexOf(mode));
}

export interface ModeInput {
    /** What the operator asked for. */
    preference: ViewMode;
    /** Whether this browser has WebCodecs at all. */
    webCodecs: boolean;
    /** Whether the farm reported a usable scrcpy. */
    serverAvailable: boolean;
    /** How many times this tile's socket has failed. */
    socketFailures: number;
    platform: string;
}

/**
 * Live is a request, not a promise: an iPhone, a browser without WebCodecs, a farm without
 * scrcpy or a socket that keeps failing all quietly come back as the old screenshot polling.
 */
export function chooseMode(input: ModeInput): ViewMode {
    if (input.preference === 'off') return 'off';
    if (input.preference === 'stills') return 'stills';
    if (input.platform !== 'android') return 'stills';
    if (!input.webCodecs || !input.serverAvailable) return 'stills';
    if (input.socketFailures >= MAX_SOCKET_FAILURES) return 'stills';
    return 'live';
}

export interface Size {
    width: number;
    height: number;
}

export const FRAME_HEADER_BYTES = 8;
export const FLAG_KEYFRAME = 1;
export const FLAG_CONFIG = 2;

export interface DecodedFrame {
    keyframe: boolean;
    config: boolean;
    timestampMs: number;
    data: Uint8Array;
}

/** flags (1) · reserved (3) · timestamp in milliseconds (4, big-endian), then the access unit. */
export function decodeFrame(bytes: Uint8Array): DecodedFrame | undefined {
    if (bytes.length < FRAME_HEADER_BYTES) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = bytes[0] ?? 0;
    return {
        keyframe: (flags & FLAG_KEYFRAME) !== 0,
        config: (flags & FLAG_CONFIG) !== 0,
        timestampMs: view.getUint32(4),
        data: bytes.subarray(FRAME_HEADER_BYTES),
    };
}

/**
 * The phone's coordinate space, turned to match the video. The stream reports the size it is
 * actually encoding, so when the phone is on its side the stream is landscape while the cached
 * screen size is still portrait — mapping a tap through the unswapped one puts it in the wrong
 * corner.
 */
export function orientedScreen(screen: Size, stream: Size | undefined): Size {
    if (!stream || !stream.width || !stream.height) return screen;
    const streamLandscape = stream.width > stream.height;
    const screenLandscape = screen.width > screen.height;
    return streamLandscape === screenLandscape ? screen : { width: screen.height, height: screen.width };
}

/** True when this browser can decode H.264 in a worker-free `VideoDecoder`. */
export function hasWebCodecs(scope: { VideoDecoder?: unknown } = globalThis): boolean {
    return typeof scope.VideoDecoder === 'function';
}
