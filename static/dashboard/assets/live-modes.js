/**
 * The decisions live video needs, with no DOM in sight: which mode a tile should be in, how a
 * frame header is read, and how a tap on a video lands in the phone's own coordinates. Kept
 * apart from `live.ts` so it can be tested outside a browser.
 */
/** The three notches of the wall's quality slider, in order. */
export const VIEW_MODES = ['off', 'stills', 'live'];
export const VIEW_MODE_LABELS = { off: 'Off', stills: 'Stills', live: 'Live' };
/** Two failed sockets in a row is enough; the third attempt would just be a slower screenshot. */
export const MAX_SOCKET_FAILURES = 2;
/** Frames per second the stills pump uses on the wall when live video is not in play. */
export const STILLS_FPS = 2;
export function viewMode(notch) {
    return VIEW_MODES[Math.max(0, Math.min(VIEW_MODES.length - 1, Math.round(notch)))] ?? 'live';
}
export function viewModeNotch(mode) {
    return Math.max(0, VIEW_MODES.indexOf(mode));
}
/**
 * Live is a request, not a promise: an iPhone, a browser without WebCodecs, a farm without
 * scrcpy or a socket that keeps failing all quietly come back as the old screenshot polling.
 */
export function chooseMode(input) {
    if (input.preference === 'off')
        return 'off';
    if (input.preference === 'stills')
        return 'stills';
    if (input.platform !== 'android')
        return 'stills';
    if (!input.webCodecs || !input.serverAvailable)
        return 'stills';
    if (input.socketFailures >= MAX_SOCKET_FAILURES)
        return 'stills';
    return 'live';
}
export const FRAME_HEADER_BYTES = 8;
export const FLAG_KEYFRAME = 1;
export const FLAG_CONFIG = 2;
/** flags (1) · reserved (3) · timestamp in milliseconds (4, big-endian), then the access unit. */
export function decodeFrame(bytes) {
    if (bytes.length < FRAME_HEADER_BYTES)
        return undefined;
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
export function orientedScreen(screen, stream) {
    if (!stream || !stream.width || !stream.height)
        return screen;
    const streamLandscape = stream.width > stream.height;
    const screenLandscape = screen.width > screen.height;
    return streamLandscape === screenLandscape ? screen : { width: screen.height, height: screen.width };
}
/** True when this browser can decode H.264 in a worker-free `VideoDecoder`. */
export function hasWebCodecs(scope = globalThis) {
    return typeof scope.VideoDecoder === 'function';
}
/**
 * Chrome's H.264 decoder takes AVCC framing (4-byte length before each NAL unit) together with an
 * avcC description built from the SPS and PPS; Annex B start codes with in-band parameter sets are
 * silently not decoded. scrcpy sends Annex B, so every frame is re-framed on the way in.
 */
export function annexBToAvcc(annexB) {
    const starts = [];
    for (let i = 0; i + 3 < annexB.length; i += 1) {
        if (annexB[i] !== 0 || annexB[i + 1] !== 0)
            continue;
        if (annexB[i + 2] === 1) {
            starts.push([i, i + 3]);
            i += 2;
            continue;
        }
        if (annexB[i + 2] === 0 && annexB[i + 3] === 1) {
            starts.push([i, i + 4]);
            i += 3;
        }
    }
    if (!starts.length)
        return annexB;
    const units = starts.map(([, from], index) => annexB.subarray(from, index + 1 < starts.length ? starts[index + 1][0] : annexB.length));
    const out = new Uint8Array(units.reduce((sum, unit) => sum + 4 + unit.length, 0));
    let offset = 0;
    for (const unit of units) {
        out[offset] = unit.length >>> 24;
        out[offset + 1] = (unit.length >>> 16) & 255;
        out[offset + 2] = (unit.length >>> 8) & 255;
        out[offset + 3] = unit.length & 255;
        out.set(unit, offset + 4);
        offset += 4 + unit.length;
    }
    return out;
}
/** The avcC record (ISO 14496-15) for one SPS and one PPS, as `VideoDecoderConfig.description`. */
export function avcCDescription(sps, pps) {
    return new Uint8Array([
        1, sps[1] ?? 0, sps[2] ?? 0, sps[3] ?? 0, 0xff, 0xe1,
        sps.length >>> 8, sps.length & 255, ...sps,
        1, pps.length >>> 8, pps.length & 255, ...pps,
    ]);
}
