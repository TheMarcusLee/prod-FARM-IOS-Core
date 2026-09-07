/**
 * The browser half of live video: one WebSocket per watched phone, WebCodecs to decode the
 * H.264 the farm forwards from scrcpy, and a canvas to paint it on. Anything that does not work
 * — no WebCodecs, no scrcpy on the farm, a socket that will not stay up — falls back to the
 * screenshot polling the wall has always had. See docs/live-video.md.
 */
import { MAX_SOCKET_FAILURES, decodeFrame, hasWebCodecs, } from './live-modes.js';
export * from './live-modes.js';
let availability;
/** Asked once per page: does this farm have scrcpy at all? */
export function liveVideoAvailable() {
    return (availability ??= fetch('/api/live/status')
        .then((response) => response.json())
        .then((status) => Boolean(status.available))
        .catch(() => false));
}
function socketUrl(udid, profile) {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${window.location.host}/api/devices/${encodeURIComponent(udid)}/live?profile=${profile}`;
}
function fromBase64(value) {
    const binary = window.atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function concat(first, second) {
    const joined = new Uint8Array(first.length + second.length);
    joined.set(first, 0);
    joined.set(second, first.length);
    return joined;
}
/**
 * One phone on one canvas. Start it when the tile is on screen, stop it when it is not: the farm
 * shuts the phone's encoder down a few seconds after the last watcher leaves.
 */
export class LivePlayer {
    options;
    socket;
    decoder;
    failures = 0;
    stopped = true;
    streamSize;
    codec;
    /** SPS/PPS arrive on their own; H.264 wants them in front of the next keyframe. */
    parameters;
    painted = false;
    /** True once a keyframe has gone into the decoder; delta frames before that are noise. */
    decodedKey = false;
    constructor(options) {
        this.options = options;
    }
    size() {
        return this.streamSize;
    }
    /** True once a picture has actually been painted, so a caller can hide the stills image. */
    live() {
        return this.painted;
    }
    start() {
        if (!this.stopped)
            return;
        if (!hasWebCodecs()) {
            this.options.onFallback();
            return;
        }
        this.stopped = false;
        this.painted = false;
        const socket = new WebSocket(socketUrl(this.options.udid, this.options.profile));
        socket.binaryType = 'arraybuffer';
        this.socket = socket;
        socket.addEventListener('message', (event) => this.onMessage(event));
        socket.addEventListener('error', () => socket.close());
        socket.addEventListener('close', () => this.onClose());
    }
    stop() {
        this.stopped = true;
        this.socket?.close();
        this.socket = undefined;
        this.closeDecoder();
    }
    closeDecoder() {
        try {
            if (this.decoder && this.decoder.state !== 'closed')
                this.decoder.close();
        }
        catch { /* already gone */ }
        this.decoder = undefined;
        this.parameters = undefined;
    }
    onClose() {
        this.closeDecoder();
        if (this.stopped)
            return;
        this.stopped = true;
        this.failures += 1;
        if (this.failures >= MAX_SOCKET_FAILURES) {
            this.options.onFallback();
            return;
        }
        window.setTimeout(() => { if (!this.painted)
            this.start(); }, 1_000);
    }
    onMessage(event) {
        if (typeof event.data === 'string') {
            let message;
            try {
                message = JSON.parse(event.data);
            }
            catch {
                return;
            }
            if (message.type === 'config')
                this.configure(message);
            // "unavailable" and "ended" both mean this phone has no video for now.
            else
                this.giveUp();
            return;
        }
        this.decodeChunk(new Uint8Array(event.data));
    }
    giveUp() {
        this.stopped = true;
        this.failures = MAX_SOCKET_FAILURES;
        this.closeDecoder();
        this.options.onFallback();
    }
    configure(message) {
        if (message.width && message.height) {
            this.streamSize = { width: message.width, height: message.height };
            this.options.canvas.width = message.width;
            this.options.canvas.height = message.height;
            this.options.onSize?.(this.streamSize);
        }
        const codec = message.decoderCodec ?? 'avc1.42e01e';
        if (this.decoder && this.codec === codec)
            return;
        this.codec = codec;
        this.closeDecoder();
        const decoder = new VideoDecoder({
            output: (frame) => this.paint(frame),
            error: () => this.recover(),
        });
        try {
            decoder.configure({
                codec,
                ...(this.streamSize ? { codedWidth: this.streamSize.width, codedHeight: this.streamSize.height } : {}),
                optimizeForLatency: true,
            });
        }
        catch {
            this.giveUp();
            return;
        }
        this.decoder = decoder;
        if (message.sps && message.pps) {
            this.parameters = concat(fromBase64(message.sps), fromBase64(message.pps));
        }
    }
    paint(frame) {
        try {
            const context = this.options.canvas.getContext('2d');
            if (context) {
                context.drawImage(frame, 0, 0, this.options.canvas.width, this.options.canvas.height);
                if (!this.painted) {
                    this.painted = true;
                    this.options.onPainted?.();
                }
            }
        }
        finally {
            frame.close();
        }
    }
    /** A decode error means the stream is not decodable from here; ask for a fresh keyframe. */
    recover() {
        this.closeDecoder();
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'keyframe' }));
        }
    }
    decodeChunk(bytes) {
        const frame = decodeFrame(bytes);
        if (!frame)
            return;
        if (frame.config) {
            this.parameters = frame.data.slice();
            return;
        }
        const decoder = this.decoder;
        if (!decoder || decoder.state !== 'configured')
            return;
        // Nothing decodes before the first keyframe, so delta frames are simply dropped until one.
        if (!frame.keyframe && !this.painted && !this.decodedKey)
            return;
        let data = frame.data;
        if (frame.keyframe && this.parameters) {
            data = concat(this.parameters, data);
        }
        try {
            decoder.decode(new EncodedVideoChunk({
                type: frame.keyframe ? 'key' : 'delta',
                timestamp: frame.timestampMs * 1000,
                data,
            }));
            if (frame.keyframe)
                this.decodedKey = true;
        }
        catch {
            this.recover();
        }
    }
}
