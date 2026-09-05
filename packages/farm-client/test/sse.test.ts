import {
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
        connections[0]!.handlers.onError(
            Object.assign(new Error('401'), { kind: 'unauthorized' }) as never,
        );
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
