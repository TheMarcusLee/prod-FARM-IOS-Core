import type { JsonObject } from '../types.js';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo's documented ceiling for one request. */
export const EXPO_BATCH_SIZE = 100;
/** Expo rejects a single message over 4 KiB with `MessageTooBig`. */
export const EXPO_MESSAGE_LIMIT_BYTES = 4_096;

export interface ExpoMessage {
    to: string;
    title: string;
    body: string;
    sound: 'default';
    priority: 'default' | 'high';
    data: JsonObject;
}

export interface ExpoTicket {
    status: 'ok' | 'error';
    id?: string;
    message?: string;
    details?: { error?: string };
}

export interface ExpoReceipt {
    status: 'ok' | 'error';
    message?: string;
    details?: { error?: string };
}

/** Minimal fetch surface, so tests hand in a fake without a DOM lib. */
export type PushFetch = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ExpoOptions {
    fetchImpl: PushFetch;
    /** Expo access token, when the project has push security enabled. */
    accessToken?: string;
    retries?: number;
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
}

export function chunk<T>(items: readonly T[], size = EXPO_BATCH_SIZE): T[][] {
    const batches: T[][] = [];
    for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
    return batches;
}

/** 1 s, 2 s, 4 s — capped so a wedged Expo never stalls the relay for minutes. */
export function pushBackoffDelay(attempt: number): number {
    return Math.min(1_000 * 2 ** attempt, 30_000);
}

/** 429 and 5xx are worth another try; a 4xx is a bad request that will not improve. */
export function isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
}

/**
 * Per-message error codes Expo documents. `DeviceNotRegistered` is terminal for
 * the token; `MessageTooBig` is our bug and is prevented by capExpoMessage;
 * `MessageRateExceeded` and `ProviderError` are transient, so the relay holds
 * its cursor and the event is pushed again rather than lost.
 */
export const RETRYABLE_TICKET_ERRORS = ['MessageRateExceeded', 'ProviderError'] as const;

export function isRetryableTicketError(ticket: ExpoTicket | ExpoReceipt): boolean {
    const code = ticket.details?.error ?? '';
    return ticket.status === 'error' && (RETRYABLE_TICKET_ERRORS as readonly string[]).includes(code);
}

/**
 * Trims a message to Expo's 4 KiB ceiling — body first, then title. Sending an
 * oversized message costs a whole round trip and comes back as MessageTooBig
 * for every recipient in the batch's slot, so it is cheaper to cut here.
 */
export function capExpoMessage(message: ExpoMessage, limit = EXPO_MESSAGE_LIMIT_BYTES): ExpoMessage {
    const size = (candidate: ExpoMessage): number => Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    let capped = message;
    while (size(capped) > limit && capped.body.length > 0) {
        capped = { ...capped, body: capped.body.slice(0, Math.max(0, Math.floor(capped.body.length / 2))) };
    }
    while (size(capped) > limit && capped.title.length > 1) {
        capped = { ...capped, title: capped.title.slice(0, Math.max(1, Math.floor(capped.title.length / 2))) };
    }
    return capped;
}

function headersFor(options: ExpoOptions): Record<string, string> {
    return {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
    };
}

async function postExpo(url: string, body: unknown, options: ExpoOptions): Promise<unknown> {
    const retries = options.retries ?? 3;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    let lastError = 'Expo push request failed';
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await options.fetchImpl(url, {
                method: 'POST', headers: headersFor(options), body: JSON.stringify(body),
            });
            if (response.ok) return await response.json();
            lastError = `Expo responded ${response.status}`;
            if (!isRetryableStatus(response.status)) break;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        if (attempt < retries) await sleep(pushBackoffDelay(attempt));
    }
    throw new Error(lastError);
}

/**
 * Sends every message in batches of 100. Tickets come back positionally, so the
 * caller can line ticket *i* up with message *i* across the whole run.
 */
export async function sendExpoMessages(
    messages: readonly ExpoMessage[], options: ExpoOptions,
): Promise<ExpoTicket[]> {
    const tickets: ExpoTicket[] = [];
    for (const batch of chunk(messages.map((message) => capExpoMessage(message)))) {
        try {
            const parsed = await postExpo(EXPO_PUSH_URL, batch, options);
            const data = (parsed as { data?: ExpoTicket[] } | null)?.data;
            const received = Array.isArray(data) ? data : [];
            for (let index = 0; index < batch.length; index++) {
                tickets.push(received[index] ?? { status: 'error', message: 'Expo returned no ticket' });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            options.log?.(`Expo push batch of ${batch.length} failed: ${message}`);
            for (let index = 0; index < batch.length; index++) tickets.push({ status: 'error', message });
        }
    }
    return tickets;
}

/** Receipts are only available a few minutes after the ticket; ids are looked up in batches. */
export async function fetchExpoReceipts(
    ticketIds: readonly string[], options: ExpoOptions,
): Promise<Record<string, ExpoReceipt>> {
    const receipts: Record<string, ExpoReceipt> = {};
    for (const batch of chunk(ticketIds)) {
        try {
            const parsed = await postExpo(EXPO_RECEIPT_URL, { ids: batch }, options);
            const data = (parsed as { data?: Record<string, ExpoReceipt> } | null)?.data;
            if (data) Object.assign(receipts, data);
        } catch (error) {
            options.log?.(`Expo receipt lookup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return receipts;
}

/** The one receipt error that means "stop pushing to this token, ever". */
export function isDeviceNotRegistered(receipt: ExpoReceipt | ExpoTicket): boolean {
    return receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered';
}
