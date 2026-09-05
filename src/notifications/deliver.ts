import { severityRank, type FarmEvent } from '../fleet/events.js';
import type { JsonObject } from '../types.js';
import type { ChannelName, NotificationConfig } from './config.js';
import { payloadFor } from './payloads.js';

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

/** Exponential: 500 ms, 1 s, 2 s. */
export function backoffDelay(attempt: number, baseDelayMs = DEFAULT_BASE_DELAY_MS): number {
    return baseDelayMs * 2 ** attempt;
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

/** Posts JSON, retrying transport errors and non-2xx responses with backoff. Never throws. */
export async function postJson(url: string, body: JsonObject, options: DeliveryOptions = {}): Promise<Omit<DeliveryResult, 'channel'>> {
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
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
            });
            if (response.ok) return { ok: true, status: response.status, attempts };
            lastStatus = response.status;
            lastError = `Channel responded ${response.status}`;
        } catch (error) {
            lastError = message(error);
        }
        if (attempt < retries) await sleep(backoffDelay(attempt, options.baseDelayMs));
    }
    return { ok: false, attempts, ...(lastStatus === undefined ? {} : { status: lastStatus }), ...(lastError ? { error: lastError } : {}) };
}

/** Delivers one event to every configured channel. Failures are reported, never thrown. */
export async function deliverEvent(
    event: FarmEvent, config: NotificationConfig, options: DeliveryOptions = {},
): Promise<DeliveryResult[]> {
    return Promise.all(config.channels.map(async (channel) => ({
        channel: channel.name,
        ...await postJson(channel.url, payloadFor(channel.name, event, config), options),
    })));
}
