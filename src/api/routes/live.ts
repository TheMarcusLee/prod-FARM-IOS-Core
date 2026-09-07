/**
 * Live video over one WebSocket per watcher: `GET /api/devices/:udid/live`. The socket opens with
 * a JSON `config` message and then carries binary frames, each behind an eight-byte header. It is
 * authenticated by the same hooks as the rest of the API, because it is a route like any other.
 *
 * Android only. iPhones already have WebDriverAgent's MJPEG stream and keep it. See docs/live-video.md.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import {
    LiveUnavailableError, qualityProfile,
    type LiveConfig, type LiveFrame, type LiveSessionManager,
} from '../../live/sessions.js';
import { STILLS_ONLY_MESSAGE, type LiveVideoStatus } from '../../live/scrcpy.js';

/** flags (1) · reserved (3) · timestamp in milliseconds (4, big-endian). */
export const FRAME_HEADER_BYTES = 8;
export const FLAG_KEYFRAME = 1;
export const FLAG_CONFIG = 2;

/** How much may sit unsent in one socket before frames start being dropped. */
export const DEFAULT_BUFFER_LIMIT_BYTES = 512 * 1024;

export function encodeFrame(frame: LiveFrame): Buffer {
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header[0] = (frame.keyframe ? FLAG_KEYFRAME : 0) | (frame.config ? FLAG_CONFIG : 0);
    header.writeUInt32BE(Math.max(0, Math.min(0xffff_ffff, Math.round(frame.timestampMs))), 4);
    return Buffer.concat([header, Buffer.from(frame.data)]);
}

/**
 * A slow browser must not become an unbounded queue in the farm. A picture frame is dropped as
 * soon as the socket is behind; a keyframe (and the parameter sets) is worth far more, because
 * without one the decoder cannot start again, so it is given a wider allowance before it goes too.
 */
export function shouldSendFrame(
    bufferedBytes: number, keyframe: boolean, limitBytes = DEFAULT_BUFFER_LIMIT_BYTES,
): boolean {
    return bufferedBytes <= (keyframe ? limitBytes * 4 : limitBytes);
}

export interface LiveRouteOptions {
    /** Null when the farm has no way to stream; every socket then answers "not available". */
    sessions: LiveSessionManager | null;
    status(): Promise<LiveVideoStatus>;
    /** True for a phone the farm can stream — an Android device with an adb connection. */
    canStream(udid: string): Promise<boolean>;
    bufferLimitBytes?: number;
}

interface ClientMessage {
    type?: string;
}

/**
 * `@fastify/websocket` must already be registered on `app`, and registered before the
 * authentication hook: the plugin marks upgrade requests on the way in and closes their raw
 * socket on the way out, so a rejected upgrade that never reached the plugin's hook would leave
 * the connection open. See `createApp`.
 */
export async function registerLiveRoutes(app: FastifyInstance, options: LiveRouteOptions): Promise<void> {
    const limit = options.bufferLimitBytes ?? DEFAULT_BUFFER_LIMIT_BYTES;

    app.get('/api/live/status', async () => {
        const status = await options.status();
        return {
            available: status.available && Boolean(options.sessions),
            ...(status.version ? { version: status.version } : {}),
            message: status.message,
        };
    });

    app.get<{ Params: { udid: string }; Querystring: { profile?: string } }>(
        '/api/devices/:udid/live', { websocket: true }, async (socket: WebSocket, request) => {
            const { udid } = request.params;
            const stop = (message: string) => {
                send(socket, { type: 'unavailable', message });
                socket.close();
            };
            const status = await options.status();
            if (!options.sessions || !status.available) return stop(status.message || STILLS_ONLY_MESSAGE);
            if (!await options.canStream(udid)) {
                return stop('This phone does not stream live video');
            }
            const sessions = options.sessions;
            const id = crypto.randomUUID();
            let dropped = 0;
            // A delta frame that was dropped leaves everything after it undecodable until the next
            // keyframe, so once one is skipped the rest are too, and the farm is asked for an IDR.
            let awaitingKeyframe = false;
            const subscriber = {
                id,
                quality: qualityProfile(request.query.profile),
                config(config: LiveConfig) {
                    send(socket, { ...config, type: 'config' });
                },
                frame(frame: LiveFrame) {
                    if (socket.readyState !== socket.OPEN) return;
                    const anchor = frame.keyframe || frame.config;
                    if (anchor) awaitingKeyframe = false;
                    if (awaitingKeyframe || !shouldSendFrame(socket.bufferedAmount, anchor, limit)) {
                        dropped += 1;
                        if (!awaitingKeyframe) {
                            awaitingKeyframe = true;
                            void sessions.requestKeyframe(udid).catch(() => undefined);
                        }
                        return;
                    }
                    socket.send(encodeFrame(frame));
                },
                ended(reason: string) {
                    send(socket, { type: 'ended', message: reason });
                    socket.close();
                },
            };

            socket.on('message', (raw: Buffer) => {
                let message: ClientMessage;
                try { message = JSON.parse(raw.toString('utf8')) as ClientMessage; } catch { return; }
                // The browser could not decode what it was sent; a fresh stream begins with an IDR.
                if (message.type === 'keyframe') void sessions.requestKeyframe(udid).catch(() => undefined);
            });
            socket.on('close', () => sessions.unsubscribe(udid, id));

            try {
                await sessions.subscribe(udid, subscriber);
            } catch (error) {
                stop(error instanceof LiveUnavailableError ? error.message : 'Live video could not start');
                return;
            }
            request.log?.debug?.({ udid, dropped }, 'live video subscriber attached');
        });
}

function send(socket: WebSocket, message: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    try { socket.send(JSON.stringify(message)); } catch { /* the socket went away mid-write */ }
}
