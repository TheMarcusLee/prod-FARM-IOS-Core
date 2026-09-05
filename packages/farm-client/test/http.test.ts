import { FarmError, HttpTransport, buildQuery, createFarmClient, errorFromResponse, joinUrl } from '../src';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('url building', () => {
    it('joins without doubling or dropping slashes', () => {
        expect(joinUrl('http://farm:3000/', '/api/devices')).toBe('http://farm:3000/api/devices');
        expect(joinUrl('http://farm:3000', 'api/devices')).toBe('http://farm:3000/api/devices');
    });

    it('skips undefined and null query values and repeats arrays', () => {
        expect(buildQuery({ limit: 50, before: undefined, deviceUdid: null })).toBe('?limit=50');
        expect(buildQuery({ kind: ['device.error', 'execution.failed'] })).toBe('?kind=device.error&kind=execution.failed');
        expect(buildQuery(undefined)).toBe('');
    });

    it('percent-encodes values', () => {
        expect(buildQuery({ deviceUdid: 'a b/c' })).toBe('?deviceUdid=a%20b%2Fc');
    });
});

describe('error mapping', () => {
    it('maps each documented status to a kind', () => {
        const cases: [number, string][] = [
            [400, 'validation'],
            [401, 'unauthorized'],
            [403, 'forbidden'],
            [404, 'not-found'],
            [409, 'conflict'],
            [429, 'rate-limited'],
            [503, 'unavailable'],
            [500, 'server'],
        ];
        for (const [status, kind] of cases) {
            expect(errorFromResponse(status, '{}').kind).toBe(kind);
        }
    });

    it('unwraps the farm\'s single `error` string', () => {
        const error = errorFromResponse(409, JSON.stringify({ error: 'Remote input is disabled while automation is running' }));
        expect(error.message).toBe('Remote input is disabled while automation is running');
        expect(error.kind).toBe('conflict');
    });

    it('falls back to a default message for the deliberately empty 503 screenshot body', () => {
        const error = errorFromResponse(503, '');
        expect(error.kind).toBe('unavailable');
        expect(error.message).toMatch(/unavailable/i);
    });

    it('does not choke on an HTML error page', () => {
        const error = errorFromResponse(502, '<html>bad gateway</html>');
        expect(error.kind).toBe('server');
        expect(error.message).not.toContain('<html>');
    });

    it('classifies retryable and auth failures', () => {
        expect(new FarmError('network', 'x').retryable).toBe(true);
        expect(new FarmError('unavailable', 'x').retryable).toBe(true);
        expect(new FarmError('conflict', 'x').retryable).toBe(false);
        expect(new FarmError('unauthorized', 'x').authFailure).toBe(true);
        expect(new FarmError('forbidden', 'x').authFailure).toBe(true);
    });

    it('survives the class transform so `instanceof` still works', () => {
        expect(errorFromResponse(404, '{}')).toBeInstanceOf(FarmError);
        expect(errorFromResponse(404, '{}')).toBeInstanceOf(Error);
    });
});

describe('HttpTransport', () => {
    it('sends the bearer token on GET as well as writes', async () => {
        const calls: [string, RequestInit | undefined][] = [];
        const transport = new HttpTransport({
            baseUrl: 'http://farm:3000',
            token: 'pf_live_abc',
            fetch: async (url, init) => {
                calls.push([String(url), init]);
                return jsonResponse([{ udid: 'x' }]);
            },
        });

        await transport.request('/api/devices');
        const headers = calls[0]![1]!.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer pf_live_abc');
        expect(headers.Accept).toBe('application/json');
    });

    it('reads the token lazily so a Replace in Settings needs no new client', async () => {
        let token = 'first';
        const seen: string[] = [];
        const transport = new HttpTransport({
            baseUrl: 'http://farm:3000',
            token: () => token,
            fetch: async (_url, init) => {
                seen.push((init!.headers as Record<string, string>).Authorization!);
                return jsonResponse({});
            },
        });
        await transport.request('/health');
        token = 'second';
        await transport.request('/health');
        expect(seen).toEqual(['Bearer first', 'Bearer second']);
    });

    it('throws a mapped FarmError rather than returning a bad body', async () => {
        const transport = new HttpTransport({
            baseUrl: 'http://farm:3000',
            token: 't',
            fetch: async () => jsonResponse({ error: 'This device is disabled' }, 409),
        });
        await expect(transport.request('/api/schedules', { method: 'POST', body: {} })).rejects.toMatchObject({
            kind: 'conflict',
            status: 409,
            message: 'This device is disabled',
        });
    });

    it('returns undefined for 204 rather than failing to parse', async () => {
        const transport = new HttpTransport({
            baseUrl: 'http://farm:3000',
            token: 't',
            fetch: async () => new Response(null, { status: 204 }),
        });
        await expect(transport.request('/api/push/registrations/1', { method: 'DELETE' })).resolves.toBeUndefined();
    });

    it('reports a non-JSON 200 as a parse failure, not a crash', async () => {
        const transport = new HttpTransport({
            baseUrl: 'http://farm:3000',
            token: 't',
            fetch: async () => new Response('<!doctype html>', { status: 200 }),
        });
        await expect(transport.request('/api/devices')).rejects.toMatchObject({ kind: 'parse' });
    });

    it('turns an unreachable Mac into kind:network', async () => {
        const transport = new HttpTransport({
            baseUrl: 'http://farm:3000',
            token: 't',
            fetch: async () => {
                throw new TypeError('Network request failed');
            },
        });
        await expect(transport.request('/health')).rejects.toMatchObject({ kind: 'network' });
    });

    it('times out on its own budget', async () => {
        const transport = new HttpTransport({
            baseUrl: 'http://farm:3000',
            token: 't',
            timeoutMs: 20,
            fetch: (_url, init) =>
                new Promise((_resolve, reject) => {
                    init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
                }),
        });
        await expect(transport.request('/health')).rejects.toMatchObject({ kind: 'timeout' });
    });
});

describe('FarmHttpClient', () => {
    it('never sends a passcode, whatever the caller passes', async () => {
        let sent: unknown;
        const client = createFarmClient({
            baseUrl: 'http://farm:3000',
            token: 't',
            fetch: async (_url, init) => {
                sent = JSON.parse(String(init!.body));
                return jsonResponse({ udid: 'x', name: 'y', pluginData: {}, connected: null });
            },
        });
        await client.patchDevice('x', { disabled: true, passcode: '1234' } as never);
        expect(sent).toEqual({ disabled: true });
    });

    it('builds an authenticated thumbnail URL for <Image>', () => {
        const client = createFarmClient({ baseUrl: 'http://farm:3000', token: 'tok' });
        const ref = client.screenshotRef('00008030-abc', { width: 320, nonce: 7 });
        expect(ref.uri).toBe('http://farm:3000/api/devices/00008030-abc/remote/screenshot?width=320&t=7');
        expect(ref.headers).toEqual({ Authorization: 'Bearer tok' });
    });

    it('uses the no-body pause/resume/cancel routes', async () => {
        const urls: string[] = [];
        const client = createFarmClient({
            baseUrl: 'http://farm:3000',
            token: 't',
            fetch: async (url) => {
                urls.push(String(url));
                return jsonResponse({ id: 's1' });
            },
        });
        await client.setScheduleStatus('s1', 'pause');
        await client.setScheduleStatus('s1', 'resume');
        expect(urls).toEqual(['http://farm:3000/api/schedules/s1/pause', 'http://farm:3000/api/schedules/s1/resume']);
    });
});
