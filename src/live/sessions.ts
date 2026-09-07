/**
 * Who is watching which phone, and therefore which streams are running. One stream per device,
 * started on the first subscriber and stopped a few seconds after the last one leaves, so a
 * wall that is scrolled past does not leave a dozen encoders running on a dozen phones.
 *
 * Nothing in here knows about scrcpy or about sockets: the caller hands over a `start` function
 * and the tests hand over a fake one. See docs/live-video.md.
 */

export interface LiveQuality {
    /** Longest edge of the encoded video, in pixels. */
    maxSize: number;
    maxFps: number;
}

/** A tile on the wall is small and does not need to be smooth; a viewer is the opposite. */
export const WALL_QUALITY: LiveQuality = { maxSize: 400, maxFps: 10 };
export const VIEWER_QUALITY: LiveQuality = { maxSize: 720, maxFps: 24 };

export const QUALITY_PROFILES = { wall: WALL_QUALITY, viewer: VIEWER_QUALITY } as const;
export type QualityProfile = keyof typeof QUALITY_PROFILES;

export function qualityProfile(name: string | undefined): LiveQuality {
    return name === 'viewer' ? VIEWER_QUALITY : WALL_QUALITY;
}

/** One stream serves every subscriber, so it is encoded for the most demanding of them. */
export function qualityFor(qualities: readonly LiveQuality[]): LiveQuality {
    return {
        maxSize: Math.max(...qualities.map(({ maxSize }) => maxSize)),
        maxFps: Math.max(...qualities.map(({ maxFps }) => maxFps)),
    };
}

export function sameQuality(a: LiveQuality, b: LiveQuality): boolean {
    return a.maxSize === b.maxSize && a.maxFps === b.maxFps;
}

export interface LiveConfig {
    codec: string;
    /** The WebCodecs codec string, e.g. "avc1.640028", once the parameter sets have arrived. */
    decoderCodec?: string;
    width: number;
    height: number;
    sps?: string;
    pps?: string;
}

export interface LiveFrame {
    data: Uint8Array;
    keyframe: boolean;
    config: boolean;
    /** Milliseconds since the stream started; the browser's decoder wants a monotonic clock. */
    timestampMs: number;
}

export interface LiveSubscriber {
    /** Unique per socket. */
    id: string;
    quality: LiveQuality;
    config(config: LiveConfig): void;
    frame(frame: LiveFrame): void;
    /** The stream ended or could not start; the browser falls back to stills. */
    ended(reason: string): void;
}

export interface LiveStreamHandlers {
    codec(info: { codec: string; width: number; height: number }): void;
    frame(frame: { data: Uint8Array; keyframe: boolean; config: boolean; ptsUs: number | null }): void;
    end(reason?: string): void;
}

export interface LiveStream {
    stop(): Promise<void> | void;
}

export type StartLiveStream = (
    udid: string, quality: LiveQuality, handlers: LiveStreamHandlers,
) => Promise<LiveStream>;

export interface SessionManagerOptions {
    start: StartLiveStream;
    /** How many phones may stream at once; `LIVE_MAX_STREAMS`, 12 by default. */
    maxStreams?: number;
    /** How long a stream stays up after its last watcher leaves. */
    lingerMs?: number;
    /** Injected by the tests so they need no real clock. */
    setTimer?: (run: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    now?: () => number;
    /** A watcher joining a stream whose last keyframe is older than this gets the stream restarted. */
    freshKeyframeMs?: number;
    /** Where the parameter sets become a WebCodecs codec string. */
    decoderCodec?: (sps: Uint8Array | undefined) => string | undefined;
    parameterSets?: (data: Uint8Array) => { sps?: Uint8Array; pps?: Uint8Array };
}

/** Thrown when the farm is already streaming as many phones as it will. */
export class LiveUnavailableError extends Error {}

export function maxStreamsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const parsed = Number(env.LIVE_MAX_STREAMS);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 12;
}

interface Session {
    udid: string;
    quality: LiveQuality;
    stream?: LiveStream;
    /** Set while a start (or a restart) is in flight, so two subscribers never start two streams. */
    starting?: Promise<void>;
    subscribers: Map<string, LiveSubscriber>;
    config?: LiveConfig;
    stopTimer?: unknown;
    startedAt: number;
    /** When the encoder last sent an IDR; 0 until it has. */
    lastKeyframeAt: number;
    /** The last config packet, replayed to a subscriber that joins mid-stream. */
    parameterFrame?: LiveFrame;
}

export interface LiveSessionManager {
    subscribe(udid: string, subscriber: LiveSubscriber): Promise<void>;
    unsubscribe(udid: string, id: string): void;
    /** The browser could not decode; restarting the stream is how scrcpy is asked for an IDR. */
    requestKeyframe(udid: string): Promise<void>;
    /** Streams running right now, including the ones lingering after their last watcher. */
    active(): number;
    close(): Promise<void>;
}

export function createSessionManager(options: SessionManagerOptions): LiveSessionManager {
    const maxStreams = options.maxStreams ?? maxStreamsFromEnv();
    const lingerMs = options.lingerMs ?? 4_000;
    const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    const now = options.now ?? (() => Date.now());
    const freshKeyframeMs = options.freshKeyframeMs ?? 1_500;
    const sessions = new Map<string, Session>();

    const cancelStop = (session: Session) => {
        if (session.stopTimer === undefined) return;
        clearTimer(session.stopTimer);
        session.stopTimer = undefined;
    };

    const handlersFor = (session: Session): LiveStreamHandlers => ({
        codec(info) {
            // Only the picture's facts: the parser's event also carries a `type` field, which must
            // never leak into the browser's config message.
            const { codec, width, height } = info;
            session.config = { ...(session.config ?? {}), codec, width, height };
            for (const subscriber of session.subscribers.values()) subscriber.config(session.config!);
        },
        frame(frame) {
            const timestampMs = frame.ptsUs === null ? 0 : Math.round(frame.ptsUs / 1000);
            const live: LiveFrame = {
                data: frame.data, keyframe: frame.keyframe, config: frame.config, timestampMs,
            };
            if (frame.config) {
                session.parameterFrame = live;
                const sets = options.parameterSets?.(frame.data) ?? {};
                const decoderCodec = options.decoderCodec?.(sets.sps);
                session.config = {
                    codec: session.config?.codec ?? 'h264',
                    width: session.config?.width ?? 0,
                    height: session.config?.height ?? 0,
                    ...(decoderCodec ? { decoderCodec } : {}),
                    ...(sets.sps ? { sps: Buffer.from(sets.sps).toString('base64') } : {}),
                    ...(sets.pps ? { pps: Buffer.from(sets.pps).toString('base64') } : {}),
                };
                for (const subscriber of session.subscribers.values()) subscriber.config(session.config);
            }
            if (frame.keyframe) session.lastKeyframeAt = now();
            for (const subscriber of session.subscribers.values()) subscriber.frame(live);
        },
        end(reason) {
            session.stream = undefined;
            for (const subscriber of session.subscribers.values()) {
                subscriber.ended(reason ?? 'The live video stream ended');
            }
            session.subscribers.clear();
            cancelStop(session);
            sessions.delete(session.udid);
        },
    });

    /** Starts (or restarts) the stream at the quality its subscribers now want. */
    const ensureStream = async (session: Session, quality: LiveQuality): Promise<void> => {
        if (session.starting) await session.starting.catch(() => undefined);
        if (session.stream && sameQuality(session.quality, quality)) return;
        const previous = session.stream;
        session.quality = quality;
        session.stream = undefined;
        session.starting = (async () => {
            if (previous) await previous.stop();
            session.stream = await options.start(session.udid, quality, handlersFor(session));
            session.startedAt = now();
            session.lastKeyframeAt = 0;
        })();
        try {
            await session.starting;
        } finally {
            session.starting = undefined;
        }
    };

    return {
        async subscribe(udid, subscriber) {
            let session = sessions.get(udid);
            if (!session) {
                if (sessions.size >= maxStreams) {
                    throw new LiveUnavailableError(
                        `${maxStreams} phones are already streaming live video — close one first`);
                }
                session = {
                    udid, quality: subscriber.quality, subscribers: new Map(), startedAt: 0, lastKeyframeAt: 0,
                };
                sessions.set(udid, session);
            }
            cancelStop(session);
            session.subscribers.set(subscriber.id, subscriber);
            const wanted = qualityFor([...session.subscribers.values()].map(({ quality }) => quality));
            // A stream that has been running a while sends nothing until the screen changes, and
            // a newcomer cannot decode before the next keyframe anyway; restarting it hands them a
            // picture right now instead of a stale still that lasts until someone touches the phone.
            const stale = session.stream !== undefined && sameQuality(session.quality, wanted)
                && now() - Math.max(session.startedAt, session.lastKeyframeAt) > freshKeyframeMs;
            if (stale) session.quality = { maxSize: 0, maxFps: 0 };
            try {
                await ensureStream(session, wanted);
            } catch (error) {
                session.subscribers.delete(subscriber.id);
                if (!session.subscribers.size) sessions.delete(udid);
                throw error;
            }
            // A viewer that joins a running stream has missed the codec header and the parameter
            // sets; both are replayed so it can build a decoder without waiting for the next IDR.
            if (session.config) subscriber.config(session.config);
            if (session.parameterFrame) subscriber.frame(session.parameterFrame);
        },

        unsubscribe(udid, id) {
            const session = sessions.get(udid);
            if (!session) return;
            session.subscribers.delete(id);
            if (session.subscribers.size) {
                const wanted = qualityFor([...session.subscribers.values()].map(({ quality }) => quality));
                if (!sameQuality(wanted, session.quality)) void ensureStream(session, wanted).catch(() => undefined);
                return;
            }
            cancelStop(session);
            session.stopTimer = setTimer(() => {
                session.stopTimer = undefined;
                if (session.subscribers.size) return;
                sessions.delete(udid);
                void session.stream?.stop();
            }, lingerMs);
        },

        async requestKeyframe(udid) {
            const session = sessions.get(udid);
            if (!session || !session.subscribers.size) return;
            // scrcpy has no "send me an IDR" message; a fresh stream begins with one.
            const quality = session.quality;
            session.quality = { maxSize: 0, maxFps: 0 };
            await ensureStream(session, quality);
        },

        active: () => sessions.size,

        async close() {
            for (const session of sessions.values()) {
                cancelStop(session);
                await session.stream?.stop();
            }
            sessions.clear();
        },
    };
}
