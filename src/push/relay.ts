import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EventKind, EventSeverity, FarmEvent } from '../fleet/events.js';
import { isEventKind, isEventSeverity } from '../fleet/events.js';
import type { JsonObject } from '../types.js';
import {
    fetchExpoReceipts, isDeviceNotRegistered, sendExpoMessages,
    type ExpoMessage, type ExpoOptions, type PushFetch,
} from './expo.js';
import { matchesRegistration } from './registrations.js';
import { createHttpSseSource, sseBackoffDelay, type SseMessage, type SseSource } from './sse.js';

/** The registration shape the relay sees over the API — never the push token's owner row. */
export interface RelayRegistration {
    id: string;
    expoPushToken: string;
    name: string;
    minSeverity: EventSeverity;
    kinds: EventKind[] | null;
}

/** The relay is an API client: it never touches Postgres, only these four calls. */
export interface RelayClient {
    listRegistrations(): Promise<RelayRegistration[]>;
    deleteRegistration(id: string): Promise<void>;
    reportError(id: string, error: string): Promise<void>;
}

export interface QuietHours {
    /** Minutes past local midnight. `start > end` means the window wraps past midnight. */
    startMinutes: number;
    endMinutes: number;
}

export interface RelayConfig {
    baseUrl: string;
    token?: string;
    statePath: string;
    publicBaseUrl: string;
    quietHours: QuietHours | null;
    timezone: string;
    coalesceWindowMs: number;
    receiptDelayMs: number;
    registrationRefreshMs: number;
    expoAccessToken?: string;
}

export const DEFAULT_COALESCE_MS = 30_000;
export const DEFAULT_RECEIPT_DELAY_MS = 15 * 60_000;
export const DEFAULT_REGISTRATION_REFRESH_MS = 30_000;

function trimmed(value: string | undefined): string | undefined {
    const candidate = value?.trim();
    return candidate ? candidate : undefined;
}

/** `"22:00-07:00"`. Anything else disables quiet hours rather than failing at boot. */
export function parseQuietHours(value: string | undefined): QuietHours | null {
    const match = /^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/.exec(value?.trim() ?? '');
    if (!match) return null;
    const startMinutes = Number(match[1]) * 60 + Number(match[2]);
    const endMinutes = Number(match[3]) * 60 + Number(match[4]);
    return startMinutes === endMinutes ? null : { startMinutes, endMinutes };
}

/** Minutes past midnight in the configured zone — `Intl` does the DST arithmetic. */
export function localMinutes(now: Date, timezone: string): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
    return (hour % 24) * 60 + minute;
}

export function inQuietHours(quietHours: QuietHours | null, now: Date, timezone: string): boolean {
    if (!quietHours) return false;
    const minutes = localMinutes(now, timezone);
    const { startMinutes, endMinutes } = quietHours;
    return startMinutes < endMinutes
        ? minutes >= startMinutes && minutes < endMinutes
        : minutes >= startMinutes || minutes < endMinutes;
}

/** Errors always break through; everything else waits for the morning. */
export function passesQuietHours(event: Pick<FarmEvent, 'severity'>, quiet: boolean): boolean {
    return !quiet || event.severity === 'error';
}

export function relayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RelayConfig {
    const dataDirectory = path.resolve(env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
    const token = trimmed(env.FARM_API_TOKEN);
    const expoAccessToken = trimmed(env.EXPO_ACCESS_TOKEN);
    return {
        baseUrl: (trimmed(env.FARM_BASE_URL) ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
        ...(token ? { token } : {}),
        statePath: trimmed(env.PUSH_RELAY_STATE_PATH) ?? path.join(dataDirectory, 'push-relay.json'),
        publicBaseUrl: (trimmed(env.PUBLIC_BASE_URL) ?? '').replace(/\/+$/, ''),
        quietHours: parseQuietHours(env.PUSH_QUIET_HOURS),
        timezone: trimmed(env.PUSH_TIMEZONE) ?? trimmed(env.DIGEST_TIMEZONE) ?? 'UTC',
        coalesceWindowMs: Number(env.PUSH_COALESCE_WINDOW_MS) > 0 ? Number(env.PUSH_COALESCE_WINDOW_MS) : DEFAULT_COALESCE_MS,
        receiptDelayMs: Number(env.PUSH_RECEIPT_DELAY_MS) > 0 ? Number(env.PUSH_RECEIPT_DELAY_MS) : DEFAULT_RECEIPT_DELAY_MS,
        registrationRefreshMs: DEFAULT_REGISTRATION_REFRESH_MS,
        ...(expoAccessToken ? { expoAccessToken } : {}),
    };
}

/* ------------------------------------------------------------------ state file */

export interface RelayState {
    lastEventId: number;
}

export async function readRelayState(statePath: string): Promise<RelayState> {
    try {
        const parsed = JSON.parse(await readFile(statePath, 'utf8')) as { lastEventId?: unknown };
        const lastEventId = Number(parsed.lastEventId);
        return { lastEventId: Number.isFinite(lastEventId) && lastEventId > 0 ? Math.floor(lastEventId) : 0 };
    } catch {
        return { lastEventId: 0 };
    }
}

/** Written only after a successful send, so a crash replays rather than drops. */
export async function writeRelayState(statePath: string, state: RelayState): Promise<void> {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/* ------------------------------------------------------------------ coalescing */

export interface CoalescedBatch {
    key: string;
    events: FarmEvent[];
}

/**
 * At most one push per registration per window. The first event for a quiet
 * registration goes out immediately; anything arriving inside the window is held
 * and folded into the next message with a count.
 */
export function createCoalescer(windowMs = DEFAULT_COALESCE_MS) {
    const pending = new Map<string, FarmEvent[]>();
    const lastSentAt = new Map<string, number>();
    return {
        add(key: string, event: FarmEvent): void {
            const held = pending.get(key);
            if (held) held.push(event);
            else pending.set(key, [event]);
        },
        /** Batches whose window has elapsed. Marks them sent, so the next window starts now. */
        drain(now: number): CoalescedBatch[] {
            const due: CoalescedBatch[] = [];
            for (const [key, events] of [...pending]) {
                const since = lastSentAt.get(key);
                if (since !== undefined && now - since < windowMs) continue;
                pending.delete(key);
                lastSentAt.set(key, now);
                due.push({ key, events });
            }
            return due;
        },
        get size(): number { return pending.size; },
    };
}

/* ------------------------------------------------------------------ messages */

function shortDetail(event: FarmEvent): string {
    const error = event.detail?.error;
    if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 160);
    return event.deviceUdid ? `${event.kind} · ${event.deviceUdid}` : event.kind;
}

/** One push per registration per window: N events collapse into a counted message. */
export function pushMessage(
    registration: Pick<RelayRegistration, 'expoPushToken'>, events: readonly FarmEvent[], publicBaseUrl = '',
): ExpoMessage {
    const latest = events[events.length - 1]!;
    const worst = events.some((event) => event.severity === 'error') ? 'high' : 'default';
    const data: JsonObject = {
        eventId: latest.id, kind: latest.kind, severity: latest.severity,
        deviceUdid: latest.deviceUdid, executionId: latest.executionId, count: events.length,
        ...(publicBaseUrl ? { url: `${publicBaseUrl}/fleet` } : {}),
    };
    return {
        to: registration.expoPushToken,
        title: events.length === 1 ? latest.title.slice(0, 100) : `${events.length} farm alerts`,
        body: events.length === 1
            ? shortDetail(latest)
            : `${latest.title} · and ${events.length - 1} more`.slice(0, 200),
        sound: 'default',
        priority: worst,
        data,
    };
}

/* ------------------------------------------------------------------ HTTP client */

export function createRelayClient(config: Pick<RelayConfig, 'baseUrl' | 'token'>, fetchImpl = fetch): RelayClient {
    const headers = (): Record<string, string> => ({
        accept: 'application/json',
        'content-type': 'application/json',
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
    });
    return {
        async listRegistrations() {
            const response = await fetchImpl(`${config.baseUrl}/api/push/registrations`, { headers: headers() });
            if (!response.ok) throw new Error(`Registrations responded ${response.status}`);
            const parsed = await response.json() as { registrations?: unknown };
            return Array.isArray(parsed.registrations) ? parsed.registrations as RelayRegistration[] : [];
        },
        async deleteRegistration(id) {
            await fetchImpl(`${config.baseUrl}/api/push/registrations/${id}`, { method: 'DELETE', headers: headers() });
        },
        async reportError(id, error) {
            await fetchImpl(`${config.baseUrl}/api/push/registrations/${id}/error`, {
                method: 'POST', headers: headers(), body: JSON.stringify({ error }),
            });
        },
    };
}

/* ------------------------------------------------------------------ the loop */

export interface PendingReceipt {
    ticketId: string;
    registrationId: string;
    dueAt: number;
}

export interface RelayOptions {
    config: RelayConfig;
    client: RelayClient;
    source: SseSource;
    fetchImpl: PushFetch;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
    signal?: AbortSignal;
}

/** The SSE `data:` line back into a FarmEvent. Anything unparseable is skipped. */
export function parseStreamEvent(message: SseMessage): FarmEvent | null {
    try {
        const parsed = JSON.parse(message.data) as Record<string, unknown>;
        if (!isEventKind(parsed.kind) || !isEventSeverity(parsed.severity)) return null;
        const id = Number(parsed.id);
        if (!Number.isFinite(id)) return null;
        return {
            id, kind: parsed.kind, severity: parsed.severity,
            deviceUdid: typeof parsed.deviceUdid === 'string' ? parsed.deviceUdid : null,
            executionId: typeof parsed.executionId === 'string' ? parsed.executionId : null,
            scheduleId: typeof parsed.scheduleId === 'string' ? parsed.scheduleId : null,
            title: typeof parsed.title === 'string' ? parsed.title : parsed.kind,
            detail: (parsed.detail ?? null) as JsonObject | null,
            createdAt: new Date(typeof parsed.createdAt === 'string' ? parsed.createdAt : Date.now()),
        };
    } catch {
        return null;
    }
}

/**
 * Sends one round of coalesced batches and lines the returned tickets up with the
 * registrations they were built for. Exported so a test can drive it without a stream.
 */
export async function sendBatches(
    batches: ReadonlyArray<{ registration: RelayRegistration; events: FarmEvent[] }>,
    options: Pick<RelayOptions, 'config' | 'client' | 'fetchImpl' | 'sleep' | 'log'>,
    now: number,
): Promise<PendingReceipt[]> {
    if (!batches.length) return [];
    const expo: ExpoOptions = {
        fetchImpl: options.fetchImpl,
        ...(options.config.expoAccessToken ? { accessToken: options.config.expoAccessToken } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.log ? { log: options.log } : {}),
    };
    const messages = batches.map(({ registration, events }) =>
        pushMessage(registration, events, options.config.publicBaseUrl));
    const tickets = await sendExpoMessages(messages, expo);
    const receipts: PendingReceipt[] = [];
    for (let index = 0; index < batches.length; index++) {
        const ticket = tickets[index];
        const registration = batches[index]!.registration;
        if (!ticket) continue;
        if (ticket.status === 'ok' && ticket.id) {
            receipts.push({ ticketId: ticket.id, registrationId: registration.id, dueAt: now + options.config.receiptDelayMs });
            continue;
        }
        if (isDeviceNotRegistered(ticket)) {
            await options.client.deleteRegistration(registration.id);
            options.log?.(`Dropped push registration ${registration.name} — Expo says the device is gone`);
            continue;
        }
        await options.client.reportError(registration.id, ticket.message ?? 'Expo rejected the message');
    }
    return receipts;
}

/**
 * Looks up every receipt that has come of age. `DeviceNotRegistered` revokes the
 * registration; any other error is recorded against it for the operator to see.
 */
export async function settleReceipts(
    pending: readonly PendingReceipt[],
    options: Pick<RelayOptions, 'config' | 'client' | 'fetchImpl' | 'sleep' | 'log'>,
    now: number,
): Promise<PendingReceipt[]> {
    const due = pending.filter((receipt) => receipt.dueAt <= now);
    if (!due.length) return [...pending];
    const expo: ExpoOptions = {
        fetchImpl: options.fetchImpl,
        ...(options.config.expoAccessToken ? { accessToken: options.config.expoAccessToken } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.log ? { log: options.log } : {}),
    };
    const receipts = await fetchExpoReceipts(due.map(({ ticketId }) => ticketId), expo);
    for (const { ticketId, registrationId } of due) {
        const receipt = receipts[ticketId];
        if (!receipt || receipt.status === 'ok') continue;
        if (isDeviceNotRegistered(receipt)) await options.client.deleteRegistration(registrationId);
        else await options.client.reportError(registrationId, receipt.message ?? receipt.details?.error ?? 'Expo receipt error');
    }
    return pending.filter((receipt) => receipt.dueAt > now);
}

/**
 * Subscribes to the farm's own event stream and pushes what each registered phone
 * asked for. Reconnects with backoff; returns only when the signal is aborted.
 */
export async function runRelay(options: RelayOptions): Promise<void> {
    const { config, client, source } = options;
    const clock = options.now ?? (() => new Date());
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    const log = options.log ?? ((message: string) => console.error(message));
    const controller = new AbortController();
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    const coalescer = createCoalescer(config.coalesceWindowMs);
    let registrations: RelayRegistration[] = [];
    let registrationsAt = 0;
    let pendingReceipts: PendingReceipt[] = [];
    let state = await readRelayState(config.statePath);
    let attempt = 0;

    const refreshRegistrations = async (now: number): Promise<void> => {
        if (now - registrationsAt < config.registrationRefreshMs) return;
        try {
            registrations = await client.listRegistrations();
            registrationsAt = now;
        } catch (error) {
            log(`Unable to refresh push registrations: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    let flushing = false;
    const flush = async (): Promise<void> => {
        if (flushing) return;
        flushing = true;
        try { await flushOnce(); } finally { flushing = false; }
    };

    const flushOnce = async (): Promise<void> => {
        const now = clock().getTime();
        const byId = new Map(registrations.map((registration) => [registration.id, registration]));
        const batches = coalescer.drain(now)
            .map(({ key, events }) => ({ registration: byId.get(key), events }))
            .filter((batch): batch is { registration: RelayRegistration; events: FarmEvent[] } => Boolean(batch.registration));
        const receipts = await sendBatches(batches, options, now);
        pendingReceipts = [...pendingReceipts, ...receipts];
        pendingReceipts = await settleReceipts(pendingReceipts, options, now);
        // Only after a send round does the cursor move — a crash replays instead of dropping.
        const highest = batches.flatMap(({ events }) => events).reduce((top, event) => Math.max(top, event.id), 0);
        if (highest > state.lastEventId) {
            state = { lastEventId: highest };
            await writeRelayState(config.statePath, state).catch((error: unknown) => log(`Unable to persist the relay cursor: ${String(error)}`));
        }
    };

    // A burst held inside the coalescing window still has to go out when the
    // stream falls quiet, so the flush runs on a timer as well as per event.
    const ticker = setInterval(() => void flush().catch((error: unknown) => log(`Push flush failed: ${String(error)}`)),
        Math.min(config.coalesceWindowMs, 1_000));
    ticker.unref?.();
    controller.signal.addEventListener('abort', () => clearInterval(ticker), { once: true });

    while (!controller.signal.aborted) {
        try {
            await refreshRegistrations(clock().getTime());
            for await (const message of source.connect(state.lastEventId, controller.signal)) {
                attempt = 0;
                const event = parseStreamEvent(message);
                if (!event) continue;
                const now = clock();
                await refreshRegistrations(now.getTime());
                const quiet = inQuietHours(config.quietHours, now, config.timezone);
                if (!passesQuietHours(event, quiet)) continue;
                for (const registration of registrations) {
                    if (matchesRegistration(registration, event)) coalescer.add(registration.id, event);
                }
                await flush();
            }
        } catch (error) {
            if (controller.signal.aborted) break;
            log(`Event stream dropped: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (controller.signal.aborted) break;
        await sleep(sseBackoffDelay(attempt++));
    }
    clearInterval(ticker);
}

async function main(): Promise<void> {
    const config = relayConfigFromEnv();
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    console.log(`Push relay following ${config.baseUrl}/api/events/stream`);
    await runRelay({
        config,
        client: createRelayClient(config),
        source: createHttpSseSource({ baseUrl: config.baseUrl, ...(config.token ? { token: config.token } : {}) }),
        fetchImpl: fetch as unknown as PushFetch,
        signal: controller.signal,
    });
}

// `void` rather than a top-level await: the loop only returns on SIGTERM, and an
// awaited never-settling promise makes Node warn on shutdown.
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
    void main().catch((error: unknown) => {
        console.error(`Push relay stopped: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
