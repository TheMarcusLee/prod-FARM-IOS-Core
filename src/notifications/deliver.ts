import { severityRank, type FarmEvent } from '../fleet/events.js';
import type { JsonObject } from '../types.js';
import type { ChannelName, NotificationChannel, NotificationConfig } from './config.js';
import { ntfyRequest, payloadFor } from './payloads.js';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface DeliveryResult {
    channel: ChannelName;
    ok: boolean;
    status?: number;
    attempts: number;
    error?: string;
}

export interface DeliveryOptions {
    fetchImpl?: FetchLike;
    /** Retries after the first attempt; 3 means up to four requests. */
    retries?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
}

export const DEFAULT_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 500;

/** Exponential: 500 ms, 1 s, 2 s — capped so a long retry chain cannot stall for minutes. */
export const MAX_BACKOFF_MS = 30_000;

export function backoffDelay(attempt: number, baseDelayMs = DEFAULT_BASE_DELAY_MS): number {
    return Math.min(baseDelayMs * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * A 429 or a 5xx is worth another try. Every other 4xx is the channel telling us
 * the request itself is wrong — a revoked Slack webhook, a payload over a limit,
 * a deleted Discord hook — and repeating it four times only adds three more
 * requests to somebody's rate limit before the same failure is reported.
 */
export function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

/** NOTIFY_KINDS, when set, replaces the severity floor entirely. */
export function shouldNotify(event: Pick<FarmEvent, 'kind' | 'severity'>, config: NotificationConfig): boolean {
    if (config.kinds?.length) return config.kinds.includes(event.kind);
    return severityRank(event.severity) >= severityRank(config.minSeverity);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Posts a body with fixed headers, retrying transport errors and non-2xx responses. Never throws. */
export async function postWithRetry(
    url: string, request: { headers: Record<string, string>; body: string }, options: DeliveryOptions = {},
): Promise<Omit<DeliveryResult, 'channel'>> {
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const retries = options.retries ?? DEFAULT_RETRIES;
    const sleep = options.sleep ?? delay;
    let attempts = 0;
    let lastStatus: number | undefined;
    let lastError: string | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
        attempts++;
        try {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: request.headers,
                body: request.body,
                signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
            });
            if (response.ok) return { ok: true, status: response.status, attempts };
            lastStatus = response.status;
            lastError = `Channel responded ${response.status}`;
            if (!isRetryableStatus(response.status)) break;
        } catch (error) {
            lastError = message(error);
        }
        if (attempt < retries) await sleep(backoffDelay(attempt, options.baseDelayMs));
    }
    return { ok: false, attempts, ...(lastStatus === undefined ? {} : { status: lastStatus }), ...(lastError ? { error: lastError } : {}) };
}

/** Posts JSON, retrying transport errors and non-2xx responses with backoff. Never throws. */
export async function postJson(url: string, body: JsonObject, options: DeliveryOptions = {}): Promise<Omit<DeliveryResult, 'channel'>> {
    return postWithRetry(url, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, options);
}

/** One channel's request: ntfy is a plain-text publish, everything else is a JSON webhook. */
function deliverToChannel(
    channel: NotificationChannel, event: FarmEvent, config: NotificationConfig, options: DeliveryOptions,
): Promise<Omit<DeliveryResult, 'channel'>> {
    if (channel.name === 'ntfy') {
        return postWithRetry(channel.url, ntfyRequest(event, channel, config.publicBaseUrl), options);
    }
    return postJson(channel.url, payloadFor(channel.name, event, config), options);
}

/** Delivers one event to every configured channel. Failures are reported, never thrown. */
export async function deliverEvent(
    event: FarmEvent, config: NotificationConfig, options: DeliveryOptions = {},
): Promise<DeliveryResult[]> {
    return Promise.all(config.channels.map(async (channel) => ({
        channel: channel.name,
        ...await deliverToChannel(channel, event, config, options),
    })));
}
