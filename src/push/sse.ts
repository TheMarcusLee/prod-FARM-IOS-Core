export interface SseMessage {
    id?: string;
    event?: string;
    data: string;
}

/**
 * Incremental `text/event-stream` parser. Feed it decoded chunks; it returns the
 * messages that completed, holding any partial one until the rest arrives.
 * Comment lines (`: heartbeat`) produce no message but do prove the link is alive.
 */
export function createSseParser(): { push(chunk: string): SseMessage[] } {
    let buffer = '';
    return {
        push(chunk) {
            buffer += chunk.replace(/\r\n?/g, '\n');
            const messages: SseMessage[] = [];
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const message = parseSseBlock(block);
                if (message) messages.push(message);
                boundary = buffer.indexOf('\n\n');
            }
            return messages;
        },
    };
}

function parseSseBlock(block: string): SseMessage | null {
    const data: string[] = [];
    let id: string | undefined;
    let event: string | undefined;
    for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        else if (field === 'id') id = value;
        else if (field === 'event') event = value;
    }
    if (!data.length) return null;
    return { ...(id === undefined ? {} : { id }), ...(event === undefined ? {} : { event }), data: data.join('\n') };
}

/** 1 s → 30 s, jittered, so a farm restart does not bring every client back at once. */
export function sseBackoffDelay(attempt: number, random = Math.random): number {
    const ceiling = Math.min(1_000 * 2 ** attempt, 30_000);
    return Math.round(ceiling * (0.5 + random() * 0.5));
}

export interface SseSource {
    /** Yields every message on one connection, then returns when the stream ends. */
    connect(lastEventId: number, signal: AbortSignal): AsyncIterable<SseMessage>;
}

export interface HttpSseOptions {
    baseUrl: string;
    token?: string;
    fetchImpl?: typeof fetch;
    /** Treat this many ms without any byte — heartbeat included — as a dead link. */
    idleTimeoutMs?: number;
}

export const DEFAULT_SSE_IDLE_MS = 40_000;

/** The real thing: `GET /api/events/stream` over plain fetch, no SDK. */
export function createHttpSseSource(options: HttpSseOptions): SseSource {
    const fetchImpl = options.fetchImpl ?? fetch;
    return {
        async *connect(lastEventId, signal) {
            const headers: Record<string, string> = { accept: 'text/event-stream' };
            if (lastEventId > 0) headers['last-event-id'] = String(lastEventId);
            if (options.token) headers.authorization = `Bearer ${options.token}`;
            const response = await fetchImpl(`${options.baseUrl}/api/events/stream`, { headers, signal });
            if (!response.ok || !response.body) throw new Error(`Event stream responded ${response.status}`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const parser = createSseParser();
            const idleMs = options.idleTimeoutMs ?? DEFAULT_SSE_IDLE_MS;
            try {
                for (;;) {
                    const { value, done } = await withIdleTimeout(reader.read(), idleMs);
                    if (done) return;
                    yield* parser.push(decoder.decode(value, { stream: true }));
                }
            } finally {
                await reader.cancel().catch(() => {});
            }
        },
    };
}

function withIdleTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`No event-stream traffic for ${ms} ms`)), ms);
            timer.unref?.();
        }),
    ]);
}
