/**
 * The HTTP transport: base URL + bearer header + `{ error }` unwrap + timeouts.
 * No React, no DOM globals beyond `fetch`/`AbortController`, which React Native
 * and Node 18+ both provide.
 */

import { FarmError, errorFromResponse } from './errors';

export interface HttpConfig {
    /** e.g. `http://farm-mac.tailnet-1234.ts.net:3000` — trailing slash optional. */
    baseUrl: string;
    /** Bearer token. Read lazily so a token replace does not need a new client. */
    token: string | (() => string | null | undefined) | null;
    /** Per-request budget in ms. Default 15000. Screenshots get their own. */
    timeoutMs?: number;
    fetch?: typeof fetch;
    /** Extra headers on every request (e.g. a build id for the server log). */
    headers?: Record<string, string>;
}

export interface RequestOptions {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
    query?: Record<string, string | number | boolean | undefined | null | (string | number)[]>;
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Skip the JSON parse and hand back the raw Response. */
    raw?: boolean;
    accept?: string;
}

export function joinUrl(baseUrl: string, path: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
}

export function buildQuery(query: RequestOptions['query']): string {
    if (!query) return '';
    const parts: string[] = [];
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
        }
    }
    return parts.length ? `?${parts.join('&')}` : '';
}

export class HttpTransport {
    private config: HttpConfig;

    constructor(config: HttpConfig) {
        this.config = config;
    }

    /** Server URL or token changed in Settings — no need to rebuild the client. */
    update(patch: Partial<HttpConfig>): void {
        this.config = { ...this.config, ...patch };
    }

    get baseUrl(): string {
        return this.config.baseUrl;
    }

    private currentToken(): string | null {
        const token = this.config.token;
        if (typeof token === 'function') return token() ?? null;
        return token ?? null;
    }

    /** Absolute URL for an <Image source>, which cannot go through `fetch`. */
    url(path: string, query?: RequestOptions['query']): string {
        return joinUrl(this.config.baseUrl, path) + buildQuery(query);
    }

    /** `Authorization` for an <Image source> — RN images can carry headers. */
    imageHeaders(): Record<string, string> {
        const token = this.currentToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    async fetchRaw(path: string, options: RequestOptions = {}): Promise<Response> {
        const doFetch = this.config.fetch ?? globalThis.fetch;
        if (!doFetch) throw new FarmError('network', 'No fetch implementation available.');

        const url = this.url(path, options.query);
        const controller = new AbortController();
        const budget = options.timeoutMs ?? this.config.timeoutMs ?? 15_000;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, budget);

        const onOuterAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onOuterAbort);

        const headers: Record<string, string> = {
            Accept: options.accept ?? 'application/json',
            ...this.config.headers,
        };
        const token = this.currentToken();
        // The Bearer header is also what satisfies the CSRF guard on writes.
        if (token) headers.Authorization = `Bearer ${token}`;
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';

        try {
            return await doFetch(url, {
                method: options.method ?? 'GET',
                headers,
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: controller.signal,
            });
        } catch (cause) {
            if (timedOut) {
                throw new FarmError('timeout', `The Mac did not answer within ${budget}ms.`, { url, cause });
            }
            if (options.signal?.aborted) {
                throw new FarmError('aborted', 'Request cancelled.', { url, cause });
            }
            throw new FarmError('network', "Can't reach the Mac.", { url, cause });
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onOuterAbort);
        }
    }

    async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
        const response = await this.fetchRaw(path, options);
        const url = this.url(path, options.query);

        if (!response.ok) {
            let body = '';
            try {
                body = await response.text();
            } catch {
                // A 503 screenshot has an empty body by design; nothing to read.
            }
            throw errorFromResponse(response.status, body, url);
        }

        if (response.status === 204) return undefined as T;

        const text = await response.text();
        if (!text) return undefined as T;
        try {
            return JSON.parse(text) as T;
        } catch (cause) {
            throw new FarmError('parse', 'The farm answered with a body that is not JSON.', {
                status: response.status,
                url,
                cause,
            });
        }
    }
}
