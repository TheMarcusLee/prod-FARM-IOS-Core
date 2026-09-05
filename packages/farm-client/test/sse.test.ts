import {
    FarmError,
    SseClient,
    SseParser,
    backoffDelay,
    type SseStreamHandlers,
    type SseStreamRequest,
    type SseTransport,
} from '../src';

describe('SseParser', () => {
    it('parses the framing from docs/mobile-api.md', () => {
        const parser = new SseParser();
        const messages = parser.feed(
            'id: 01J9Z3M8QF7B0C2S4T6V8XYZAB\n' +
                'event: execution.failed\n' +
                'data: {"id":"01J9Z3M8QF7B0C2S4T6V8XYZAB","kind":"execution.failed"}\n' +
                '\n',
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            id: '01J9Z3M8QF7B0C2S4T6V8XYZAB',
            event: 'execution.failed',
        });
        expect(JSON.parse(messages[0]!.data).kind).toBe('execution.failed');
    });

    it('emits nothing until the blank line arrives', () => {
        const parser = new SseParser();
        expect(parser.feed('event: device.error\ndata: {"a":1}\n')).toHaveLength(0);
        expect(parser.feed('\n')).toHaveLength(1);
    });

    it('reassembles a message split mid-line across chunks', () => {
        const parser = new SseParser();
        expect(parser.feed('id: 42\neve')).toHaveLength(0);
        expect(parser.feed('nt: device.connected\ndata: {"x":')).toHaveLength(0);
        const messages = parser.feed('1}\n\n');
        expect(messages).toHaveLength(1);
        expect(messages[0]!.event).toBe('device.connected');
        expect(messages[0]!.data).toBe('{"x":1}');
    });

    it('joins multiple data lines with a newline, per the spec', () => {
        const parser = new SseParser();
        const [message] = parser.feed('data: one\ndata: two\n\n');
        expect(message!.data).toBe('one\ntwo');
    });

    it('treats `: heartbeat` as liveness, not a message', () => {
        const parser = new SseParser();
        expect(parser.feed(': heartbeat\n\n')).toHaveLength(0);
        expect(parser.sawComment).toBe(true);
    });

    it('defaults the event type to `message` when the server omits it', () => {
        const parser = new SseParser();
        const [message] = parser.feed('data: {}\n\n');
        expect(message!.event).toBe('message');
    });

    it('handles CRLF line endings', () => {
        const parser = new SseParser();
        const messages = parser.feed('id: 7\r\nevent: device.error\r\ndata: {}\r\n\r\n');
        expect(messages).toHaveLength(1);
        expect(messages[0]!.id).toBe('7');
    });

    it('strips exactly one leading space after the colon', () => {
        const parser = new SseParser();
        const [message] = parser.feed('data:  two-spaces\n\n');
        expect(message!.data).toBe(' two-spaces');
    });

    it('carries the last id forward to messages that omit one', () => {
        const parser = new SseParser();
        parser.feed('id: 10\ndata: a\n\n');
        const [second] = parser.feed('data: b\n\n');
        expect(second!.id).toBe('10');
        expect(parser.lastEventId).toBe('10');
    });

    it('resumes from an id handed in by the caller', () => {
        const parser = new SseParser('01J9Z000');
        expect(parser.lastEventId).toBe('01J9Z000');
    });

    it('reads a retry hint', () => {
        const parser = new SseParser();
        const [message] = parser.feed('retry: 2500\ndata: x\n\n');
        expect(message!.retry).toBe(2500);
    });
});

describe('backoffDelay', () => {
    it('climbs from 1 s toward the 30 s ceiling', () => {
        const noJitter = { jitter: 0, random: () => 0.5 };
        expect(backoffDelay(0, noJitter)).toBe(1_000);
        expect(backoffDelay(1, noJitter)).toBe(2_000);
        expect(backoffDelay(4, noJitter)).toBe(16_000);
        expect(backoffDelay(10, noJitter)).toBe(30_000);
        expect(backoffDelay(99, noJitter)).toBe(30_000);
    });

    it('jitters within the requested band', () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const low = backoffDelay(attempt, { random: () => 0 });
            const high = backoffDelay(attempt, { random: () => 1 });
            expect(low).toBeLessThan(high);
            expect(low).toBeGreaterThan(0);
            expect(high).toBeLessThanOrEqual(30_000 * 1.2);
        }
    });
});

/** A transport a test can drive by hand. */
function scriptedTransport() {
    const connections: {
        request: SseStreamRequest;
        handlers: SseStreamHandlers;
        aborted: boolean;
    }[] = [];
    const transport: SseTransport = (request, handlers) => {
        const connection = { request, handlers, aborted: false };
        connections.push(connection);
        handlers.onOpen?.();
        return () => {
            connection.aborted = true;
        };
    };
    return { transport, connections };
}

describe('SseClient', () => {
    it('sends Last-Event-ID on reconnect so the farm replays', () => {
        jest.useFakeTimers();
        const { transport, connections } = scriptedTransport();
        const seen: string[] = [];
        const client = new SseClient({
            url: 'http://farm:3000/api/events/stream',
            headers: () => ({ Authorization: 'Bearer t' }),
            onMessage: (message) => seen.push(message.data),
            transport,
            backoff: { jitter: 0, random: () => 0.5 },
        });

        client.start();
        expect(connections).toHaveLength(1);
        // A cold start carries no resume header.
        expect(connections[0]!.request.headers['Last-Event-ID']).toBeUndefined();
        expect(connections[0]!.request.headers.Authorization).toBe('Bearer t');

        connections[0]!.handlers.onChunk('id: 01J9Z001\ndata: {"n":1}\n\n');
        expect(seen).toEqual(['{"n":1}']);

        // The stream drops; the client backs off and reconnects with the id.
        connections[0]!.handlers.onClose();
        jest.advanceTimersByTime(1_000);
        expect(connections).toHaveLength(2);
        expect(connections[1]!.request.headers['Last-Event-ID']).toBe('01J9Z001');

        client.stop();
        jest.useRealTimers();
    });

    it('resumes from the id the app rendered, not the one it received', () => {
        jest.useFakeTimers();
        const { transport, connections } = scriptedTransport();
        const client = new SseClient({
            url: 'u',
            headers: () => ({}),
            onMessage: () => {},
            transport,
            backoff: { jitter: 0, random: () => 0.5 },
        });
        client.start();
        connections[0]!.handlers.onChunk('id: 01J9Z009\ndata: {}\n\n');
        // The screen only got as far as rendering 01J9Z005.
        client.setLastEventId('01J9Z005');
        connections[0]!.handlers.onClose();
        jest.advanceTimersByTime(1_000);
        expect(connections[1]!.request.headers['Last-Event-ID']).toBe('01J9Z005');
        client.stop();
        jest.useRealTimers();
    });

    it('treats 40 s of silence as a dead connection', () => {
        jest.useFakeTimers();
        const { transport, connections } = scriptedTransport();
        const statuses: string[] = [];
        const client = new SseClient({
            url: 'u',
            headers: () => ({}),
            onMessage: () => {},
            onStatus: (status) => statuses.push(status),
            transport,
            backoff: { jitter: 0, random: () => 0.5 },
        });
        client.start();
        expect(statuses).toContain('open');
        jest.advanceTimersByTime(40_001);
        expect(statuses).toContain('reconnecting');
        expect(connections[0]!.aborted).toBe(true);
        jest.advanceTimersByTime(1_000);
        expect(connections).toHaveLength(2);
        client.stop();
        jest.useRealTimers();
    });

    it('keeps the connection alive while heartbeats arrive', () => {
        jest.useFakeTimers();
        const { transport, connections } = scriptedTransport();
        const client = new SseClient({ url: 'u', headers: () => ({}), onMessage: () => {}, transport });
        client.start();
        for (let n = 0; n < 5; n += 1) {
            jest.advanceTimersByTime(15_000);
            connections[0]!.handlers.onChunk(': heartbeat\n\n');
        }
        expect(connections).toHaveLength(1);
        client.stop();
        jest.useRealTimers();
    });

    it('stops rather than hammering the Mac when the token is rejected', () => {
        jest.useFakeTimers();
        const { transport, connections } = scriptedTransport();
        const statuses: string[] = [];
        const client = new SseClient({
            url: 'u',
            headers: () => ({}),
            onMessage: () => {},
            onStatus: (status) => statuses.push(status),
            transport,
        });
        client.start();
        connections[0]!.handlers.onError(new FarmError('unauthorized', 'Event stream returned 401.', { status: 401 }));
        connections[0]!.handlers.onClose();
        jest.advanceTimersByTime(120_000);
        expect(connections).toHaveLength(1);
        expect(statuses[statuses.length - 1]).toBe('idle');
        jest.useRealTimers();
    });

    it('backgrounding stops the stream and start() is idempotent', () => {
        jest.useFakeTimers();
        const { transport, connections } = scriptedTransport();
        const client = new SseClient({ url: 'u', headers: () => ({}), onMessage: () => {}, transport });
        client.start();
        client.start();
        expect(connections).toHaveLength(1);
        client.stop();
        expect(connections[0]!.aborted).toBe(true);
        jest.advanceTimersByTime(60_000);
        expect(connections).toHaveLength(1);
        jest.useRealTimers();
    });
});

describe('SseParser — the edges the farm actually produces', () => {
    it('keeps a message whole when a CRLF is split across two chunks', () => {
        const parser = new SseParser();
        // The farm writes `\n\n`, but a proxy that rewrites to CRLF can leave a
        // lone `\r` at a chunk boundary. Normalising it twice used to invent a
        // blank line and dispatch the half-built message.
        expect(parser.feed('id: 7\r\nevent: device.error\r\ndata: {"id":7,\r')).toEqual([]);
        expect(parser.feed('\ndata: "kind":"device.error"}\r\n\r\n')).toEqual([
            { id: '7', event: 'device.error', data: '{"id":7,\n"kind":"device.error"}' },
        ]);
    });

    it('joins multi-line data with a newline and drops one leading space only', () => {
        const parser = new SseParser();
        expect(parser.feed('data: first\ndata:  second\ndata:\n\n')).toEqual([
            { id: undefined, event: 'message', data: 'first\n second\n' },
        ]);
    });

    it('treats an id of 0 as a real resume point rather than a falsy one', () => {
        const parser = new SseParser();
        parser.feed('id: 0\ndata: {}\n\n');
        expect(parser.lastEventId).toBe('0');
    });

    it('never dispatches a comment, and carries the id across a heartbeat', () => {
        const parser = new SseParser();
        parser.feed('id: 5\ndata: {}\n\n');
        expect(parser.feed(': heartbeat\n\n')).toEqual([]);
        expect(parser.sawComment).toBe(true);
        expect(parser.lastEventId).toBe('5');
    });

    it('reassembles a message delivered one character at a time', () => {
        const parser = new SseParser();
        const frame = 'id: 9\nevent: execution.failed\ndata: {"id":9}\n\n';
        const out = [...frame].flatMap((character) => parser.feed(character));
        expect(out).toEqual([{ id: '9', event: 'execution.failed', data: '{"id":9}' }]);
    });

    it('does not leak a `retry` from one message into the next', () => {
        const parser = new SseParser();
        expect(parser.feed('retry: 2000\ndata: a\n\n')[0]!.retry).toBe(2_000);
        expect(parser.feed('data: b\n\n')[0]!.retry).toBeUndefined();
    });
});

describe('SseClient reconnect', () => {
    it('bounds the backoff at 30 s however long the Mac stays away', () => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
            expect(backoffDelay(attempt, { random: () => 1 })).toBeLessThanOrEqual(30_000);
        }
        expect(backoffDelay(0, { random: () => 0.5 })).toBe(1_000);
    });

    it('stops on a 403 CSRF refusal for the same reason it stops on a 401', () => {
        jest.useFakeTimers();
        const { transport, connections } = scriptedTransport();
        const statuses: string[] = [];
        const client = new SseClient({
            url: 'u',
            headers: () => ({}),
            onMessage: () => {},
            onStatus: (status) => statuses.push(status),
            transport,
        });
        client.start();
        connections[0]!.handlers.onError(new FarmError('forbidden', 'Cross-origin write blocked.', { status: 403 }));
        connections[0]!.handlers.onClose();
        jest.advanceTimersByTime(120_000);
        expect(connections).toHaveLength(1);
        expect(statuses[statuses.length - 1]).toBe('idle');
        jest.useRealTimers();
    });
});
