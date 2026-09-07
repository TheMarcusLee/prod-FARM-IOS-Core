/**
 * The browser half of live video: one WebSocket per watched phone, WebCodecs to decode the
 * H.264 the farm forwards from scrcpy, and a canvas to paint it on. Anything that does not work
 * — no WebCodecs, no scrcpy on the farm, a socket that will not stay up — falls back to the
 * screenshot polling the wall has always had. See docs/live-video.md.
 */
import {
    MAX_SOCKET_FAILURES, decodeFrame, hasWebCodecs, type Size, annexBToAvcc, avcCDescription } from './live-modes.js';

export * from './live-modes.js';

interface LiveConfigMessage {
    type: 'config';
    codec: string;
    decoderCodec?: string;
    width: number;
    height: number;
    sps?: string;
    pps?: string;
}

type ServerMessage = LiveConfigMessage | { type: 'unavailable' | 'ended'; message: string };

let availability: Promise<boolean> | undefined;

/** Asked once per page: does this farm have scrcpy at all? */
export function liveVideoAvailable(): Promise<boolean> {
    return (availability ??= fetch('/api/live/status')
        .then((response) => response.json() as Promise<{ available?: boolean }>)
        .then((status) => Boolean(status.available))
        .catch(() => false));
}

export interface LivePlayerOptions {
    canvas: HTMLCanvasElement;
    udid: string;
    /** "wall" for a tile, "viewer" for the inspector and the device page. */
    profile: 'wall' | 'viewer';
    /** Called when live video has given up for good and the caller should show stills again. */
    onFallback(): void;
    /** Called with the encoded size the moment the farm reports it. */
    onSize?(size: Size): void;
    /** Called once, when the first picture has actually been painted. */
    onPainted?(): void;
}

function socketUrl(udid: string, profile: string): string {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${window.location.host}/api/devices/${encodeURIComponent(udid)}/live?profile=${profile}`;
}

function fromBase64(value: string): Uint8Array {
    const binary = window.atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
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
    private socket: WebSocket | undefined;
    private decoder: VideoDecoder | undefined;
    private failures = 0;
    private stopped = true;
    private streamSize: Size | undefined;
    private codec: string | undefined;
    /** SPS/PPS arrive on their own; H.264 wants them in front of the next keyframe. */
    private parameters: Uint8Array | undefined;
    private painted = false;
    /** True once a keyframe has gone into the decoder; delta frames before that are noise. */
    private decodedKey = false;

    constructor(private readonly options: LivePlayerOptions) {}

    size(): Size | undefined {
        return this.streamSize;
    }

    /** True once a picture has actually been painted, so a caller can hide the stills image. */
    live(): boolean {
        return this.painted;
    }

    start(): void {
        if (!this.stopped) return;
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

    stop(): void {
        this.stopped = true;
        this.socket?.close();
        this.socket = undefined;
        this.closeDecoder();
    }

    private closeDecoder(): void {
        try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch { /* already gone */ }
        this.decoder = undefined;
        this.parameters = undefined;
    }

    private onClose(): void {
        this.closeDecoder();
        if (this.stopped) return;
        this.stopped = true;
        this.failures += 1;
        if (this.failures >= MAX_SOCKET_FAILURES) {
            this.options.onFallback();
            return;
        }
        window.setTimeout(() => { if (!this.painted) this.start(); }, 1_000);
    }

    private onMessage(event: MessageEvent<string | ArrayBuffer>): void {
        if (typeof event.data === 'string') {
            let message: ServerMessage;
            try { message = JSON.parse(event.data) as ServerMessage; } catch { return; }
            if (message.type === 'config') this.configure(message);
            // "unavailable" and "ended" both mean this phone has no video for now.
            else this.giveUp();
            return;
        }
        this.decodeChunk(new Uint8Array(event.data));
    }

    private giveUp(): void {
        this.stopped = true;
        this.failures = MAX_SOCKET_FAILURES;
        this.closeDecoder();
        this.options.onFallback();
    }

    private configure(message: LiveConfigMessage): void {
        if (message.width && message.height) {
            this.streamSize = { width: message.width, height: message.height };
            this.options.canvas.width = message.width;
            this.options.canvas.height = message.height;
            this.options.onSize?.(this.streamSize);
        }
        const codec = message.decoderCodec ?? 'avc1.42e01e';
        // The parameter sets are part of the decoder's configuration, not of the frames.
        const description = message.sps && message.pps
            ? avcCDescription(fromBase64(message.sps), fromBase64(message.pps)) : undefined;
        const signature = `${codec}:${message.sps ?? ''}:${message.pps ?? ''}`;
        if (this.decoder && this.codec === signature) return;
        this.codec = signature;
        this.closeDecoder();
        const decoder = new VideoDecoder({
            output: (frame) => this.paint(frame),
            error: () => this.recover(),
        });
        try {
            decoder.configure({
                codec,
                ...(description ? { description } : {}),
                ...(this.streamSize ? { codedWidth: this.streamSize.width, codedHeight: this.streamSize.height } : {}),
                optimizeForLatency: true,
            });
        } catch {
            this.giveUp();
            return;
        }
        this.decoder = decoder;
    }

    private paint(frame: VideoFrame): void {
        try {
            const context = this.options.canvas.getContext('2d');
            if (context) {
                context.drawImage(frame as unknown as CanvasImageSource, 0, 0,
                    this.options.canvas.width, this.options.canvas.height);
                if (!this.painted) {
                    this.painted = true;
                    this.options.onPainted?.();
                }
            }
        } finally {
            frame.close();
        }
    }

    /** A decode error means the stream is not decodable from here; ask for a fresh keyframe. */
    private recover(): void {
        this.closeDecoder();
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'keyframe' }));
        }
    }

    private decodeChunk(bytes: Uint8Array): void {
        const frame = decodeFrame(bytes);
        if (!frame) return;
        // Parameter sets arrive in the config message; the in-band copy is not needed.
        if (frame.config) return;
        const decoder = this.decoder;
        if (!decoder || decoder.state !== 'configured') return;
        // Nothing decodes before the first keyframe, so delta frames are simply dropped until one.
        if (!frame.keyframe && !this.painted && !this.decodedKey) return;
        const data = annexBToAvcc(frame.data);
        try {
            decoder.decode(new EncodedVideoChunk({
                type: frame.keyframe ? 'key' : 'delta',
                timestamp: frame.timestampMs * 1000,
                data,
            }));
            if (frame.keyframe) this.decodedKey = true;
        } catch {
            this.recover();
        }
    }
}
