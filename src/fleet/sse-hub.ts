import { serializeEvent, type EventStore, type FarmEvent } from './events.js';

/**
 * The slice of `http.ServerResponse` an event stream needs. Narrow on purpose,
 * so a test can drive the hub with a plain object and assert on backpressure.
 */
export interface StreamSocket {
    /** False means the kernel buffer is full — nothing more until `drain`. */
    write(chunk: string): boolean;
    end(): void;
    readonly destroyed: boolean;
    once(event: 'drain', listener: () => void): void;
}

export interface HubOptions {
    intervalMs?: number;
    heartbeatMs?: number;
    /** Rows fetched per poll, shared by every subscriber. */
    batchSize?: number;
    /** A subscriber this far behind the newest id is dropped rather than buffered forever. */
    maxLagEvents?: number;
    log?: (message: string) => void;
}

export const DEFAULT_POLL_MS = 1_000;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_BATCH = 200;
export const DEFAULT_MAX_LAG = 5_000;

interface Subscriber {
    socket: StreamSocket;
    cursor: number;
    /** True while the socket has told us to stop writing. */
    blocked: boolean;
    closed: boolean;
}

export interface EventStreamHub {
    /** Registers a socket at `cursor` (the Last-Event-ID). Returns its detach handle. */
    add(socket: StreamSocket, cursor: number): { close(): void };
    /** One poll round. Exported so a test can step it without timers. */
    poll(): Promise<void>;
    /** A heartbeat comment to every live subscriber. */
    heartbeat(): void;
    /** Ends every stream and clears the timers — the server's onClose path. */
    closeAll(): void;
    readonly size: number;
}

function frame(event: FarmEvent): string {
    return `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(serializeEvent(event))}\n\n`;
}

/**
 * One poll timer and one query for the whole process, however many browsers,
 * tray apps and push relays are watching. Twelve subscribers used to mean twelve
 * `select … where id > ?` every second; now the hub fetches once from the lowest
 * cursor any subscriber holds and fans the rows out in memory.
 *
 * The poll is also guarded against overlap: two rounds racing on the same cursor
 * would send every event twice, which is exactly what Last-Event-ID exists to
 * prevent.
 */
export function createEventStreamHub(store: EventStore, options: HubOptions = {}): EventStreamHub {
    const intervalMs = options.intervalMs ?? DEFAULT_POLL_MS;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const batchSize = options.batchSize ?? DEFAULT_BATCH;
    const maxLag = options.maxLagEvents ?? DEFAULT_MAX_LAG;
    const log = options.log ?? (() => {});
    const subscribers = new Set<Subscriber>();
    let timers: { poll: NodeJS.Timeout; heartbeat: NodeJS.Timeout } | null = null;
    let polling = false;

    const drop = (subscriber: Subscriber): void => {
        if (subscriber.closed) return;
        subscriber.closed = true;
        subscribers.delete(subscriber);
        try { subscriber.socket.end(); } catch { /* the peer is already gone */ }
        if (!subscribers.size) stopTimers();
    };

    const send = (subscriber: Subscriber, chunk: string): void => {
        if (subscriber.closed) return;
        if (subscriber.socket.destroyed) { drop(subscriber); return; }
        try {
            if (subscriber.socket.write(chunk)) return;
        } catch (error) {
            log(`Event stream write failed: ${error instanceof Error ? error.message : String(error)}`);
            drop(subscriber);
            return;
        }
        // Backpressure: hold off until the socket drains rather than queueing
        // megabytes of JSON for a browser tab that has been suspended.
        subscriber.blocked = true;
        subscriber.socket.once('drain', () => { subscriber.blocked = false; });
    };

    const hub: EventStreamHub = {
        add(socket, cursor) {
            const subscriber: Subscriber = { socket, cursor: Math.max(0, Math.floor(cursor)), blocked: false, closed: false };
            subscribers.add(subscriber);
            startTimers();
            return { close: () => drop(subscriber) };
        },
        async poll() {
            if (polling || !subscribers.size) return;
            polling = true;
            try {
                const live = [...subscribers].filter((subscriber) => !subscriber.closed && !subscriber.blocked);
                if (!live.length) return;
                const lowest = live.reduce((low, subscriber) => Math.min(low, subscriber.cursor), Number.POSITIVE_INFINITY);
                const events = await store.after(lowest, batchSize);
                if (!events.length) return;
                const newest = events[events.length - 1]!.id;
                for (const subscriber of live) {
                    if (subscriber.closed) continue;
                    if (newest - subscriber.cursor > maxLag) {
                        log('Dropping an event-stream subscriber that fell too far behind');
                        drop(subscriber);
                        continue;
                    }
                    for (const event of events) {
                        if (event.id <= subscriber.cursor) continue;
                        subscriber.cursor = event.id;
                        send(subscriber, frame(event));
                        if (subscriber.closed || subscriber.blocked) break;
                    }
                }
            } catch (error) {
                log(`Event stream poll failed: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                polling = false;
            }
        },
        heartbeat() {
            for (const subscriber of [...subscribers]) send(subscriber, ': heartbeat\n\n');
        },
        closeAll() {
            for (const subscriber of [...subscribers]) drop(subscriber);
            stopTimers();
        },
        get size() { return subscribers.size; },
    };

    function startTimers(): void {
        if (timers) return;
        const poll = setInterval(() => void hub.poll(), intervalMs);
        const heartbeat = setInterval(() => hub.heartbeat(), heartbeatMs);
        poll.unref?.();
        heartbeat.unref?.();
        timers = { poll, heartbeat };
    }

    function stopTimers(): void {
        if (!timers) return;
        clearInterval(timers.poll);
        clearInterval(timers.heartbeat);
        timers = null;
    }

    return hub;
}
