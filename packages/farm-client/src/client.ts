/**
 * The one interface every screen talks to. The HTTP implementation and the
 * in-memory mock both satisfy it, so "use demo data" is a swap of one object in
 * a React context and nothing above this line knows the difference.
 *
 * Keep this file free of React and of anything touching `window`: the Electron
 * app reuses it.
 */

import { FarmError } from './errors';
import { HttpTransport, type HttpConfig, type RequestOptions } from './http';
import type {
    AckResult,
    Bootstrap,
    BulkScheduleInput,
    BulkScheduleResult,
    ContentQueueItem,
    CreateScheduleInput,
    DeviceConnectionStatus,
    EventPage,
    EventQuery,
    ExecutionDetail,
    ExecutionRow,
    ExecutionStatus,
    FleetSummary,
    HealthResponse,
    JsonObject,
    PluginDescriptor,
    PushRegistration,
    PushRegistrationInput,
    RegisteredDevice,
    ReconnectResult,
    RemoteAction,
    RemoteInfo,
    ScheduleRow,
    ScheduleStatus,
    StopExecutionResult,
} from './models';
import { SseClient, type SseStatus } from './sse';

/** What React Native's `<Image>` needs. Headers because auth is a bearer token. */
export interface ImageRef {
    uri: string;
    headers?: Record<string, string>;
}

export interface ScreenshotOptions {
    /** `?width=` thumbnail (gap 3). Clamped 120–1080 server-side. */
    width?: number;
    /** Cache-buster for a manual refresh. */
    nonce?: string | number;
}

export interface ListQuery {
    deviceUdid?: string;
    /** Keyset pagination on schedules/executions (gap 9). Ignored by an older farm. */
    limit?: number;
    before?: string;
}

export interface ScheduleListPage {
    schedules: ScheduleRow[];
    nextBefore?: string;
}

export interface ExecutionListPage {
    executions: ExecutionRow[];
    nextBefore?: string;
}

export interface EventSubscription {
    onEvent: (event: import('./models').FarmEvent) => void;
    onStatus?: (status: SseStatus, error?: FarmError) => void;
    /** Resume point — the last id the app actually rendered. */
    lastEventId?: string;
}

export interface FarmClient {
    readonly baseUrl: string;
    readonly isMock: boolean;

    health(): Promise<HealthResponse>;
    bootstrap(): Promise<Bootstrap>;
    listPlugins(): Promise<PluginDescriptor[]>;

    listDevices(): Promise<RegisteredDevice[]>;
    getDeviceConnection(udid: string): Promise<DeviceConnectionStatus>;
    patchDevice(udid: string, patch: Partial<Pick<RegisteredDevice, 'name' | 'disabled' | 'tags'>>): Promise<RegisteredDevice>;
    reconnectDevice(udid: string): Promise<ReconnectResult>;
    /** Synchronous by design: `<Image>` does the fetch, and a 503 is an onError. */
    screenshotRef(udid: string, options?: ScreenshotOptions): ImageRef;
    getRemoteInfo(udid: string): Promise<RemoteInfo>;
    remoteAction(udid: string, action: RemoteAction): Promise<{ ok: true }>;

    getFleetSummary(): Promise<FleetSummary>;

    listSchedules(query?: ListQuery): Promise<ScheduleListPage>;
    createSchedule(input: CreateScheduleInput): Promise<ScheduleRow>;
    createSchedulesBulk(input: BulkScheduleInput): Promise<BulkScheduleResult>;
    /** `pause | resume | cancel` — the no-body routes, one fewer thing to get wrong. */
    setScheduleStatus(id: string, transition: 'pause' | 'resume' | 'cancel'): Promise<ScheduleRow>;

    listExecutions(query?: ListQuery): Promise<ExecutionListPage>;
    getExecution(id: string): Promise<ExecutionDetail>;
    stopExecution(id: string): Promise<StopExecutionResult>;
    retryExecution(id: string): Promise<ExecutionRow>;

    listEvents(query?: EventQuery): Promise<EventPage>;
    ackEvents(upToId: number): Promise<AckResult>;
    subscribeEvents(subscription: EventSubscription): () => void;

    registerPush(input: PushRegistrationInput): Promise<PushRegistration>;
    listPushRegistrations(): Promise<PushRegistration[]>;
    deletePushRegistration(id: string): Promise<void>;

    listContentQueue(): Promise<{ items: ContentQueueItem[] }>;
    approveContentItem(id: string, options?: { plannedFor?: string }): Promise<ContentQueueItem>;
    skipContentItem(id: string, options?: { reason?: string }): Promise<ContentQueueItem>;
    assetThumbnailRef(assetId: string): ImageRef;
}

export interface FarmHttpClientConfig extends HttpConfig {
    /** Screenshots are big and the device may be flapping; give them longer. */
    screenshotTimeoutMs?: number;
}

export class FarmHttpClient implements FarmClient {
    readonly isMock = false;
    private readonly http: HttpTransport;

    constructor(config: FarmHttpClientConfig) {
        this.http = new HttpTransport(config);
    }

    get baseUrl(): string {
        return this.http.baseUrl;
    }

    /** Settings changed the server URL or replaced the token. */
    update(patch: Partial<FarmHttpClientConfig>): void {
        this.http.update(patch);
    }

    private get<T>(path: string, options?: RequestOptions): Promise<T> {
        return this.http.request<T>(path, options);
    }

    private send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
        return this.http.request<T>(path, { method, body });
    }

    /* ------------------------------------------------------------- meta */

    health(): Promise<HealthResponse> {
        // Cheap, and unlike /api/devices it does not touch USB.
        return this.get<HealthResponse>('/health', { timeoutMs: 5_000 });
    }

    bootstrap(): Promise<Bootstrap> {
        return this.get<Bootstrap>('/api/mobile/bootstrap');
    }

    listPlugins(): Promise<PluginDescriptor[]> {
        return this.get<PluginDescriptor[]>('/api/plugins');
    }

    /* ---------------------------------------------------------- devices */

    listDevices(): Promise<RegisteredDevice[]> {
        return this.get<RegisteredDevice[]>('/api/devices');
    }

    getDeviceConnection(udid: string): Promise<DeviceConnectionStatus> {
        return this.get<DeviceConnectionStatus>(`/api/devices/${encodeURIComponent(udid)}/connection`);
    }

    patchDevice(udid: string, patch: Partial<Pick<RegisteredDevice, 'name' | 'disabled' | 'tags'>>): Promise<RegisteredDevice> {
        // Never send `passcode` from the app, whatever the caller passed.
        const { name, disabled, tags } = patch;
        const body: JsonObject = {};
        if (name !== undefined) body.name = name;
        if (disabled !== undefined) body.disabled = disabled;
        if (tags !== undefined) body.tags = tags;
        return this.send<RegisteredDevice>('PATCH', `/api/devices/${encodeURIComponent(udid)}`, body);
    }

    reconnectDevice(udid: string): Promise<ReconnectResult> {
        return this.send<ReconnectResult>('POST', `/api/devices/${encodeURIComponent(udid)}/reconnect`);
    }

    screenshotRef(udid: string, options: ScreenshotOptions = {}): ImageRef {
        const query: Record<string, string | number> = {};
        if (options.width) query.width = Math.round(options.width);
        if (options.nonce !== undefined) query.t = options.nonce;
        return {
            uri: this.http.url(`/api/devices/${encodeURIComponent(udid)}/remote/screenshot`, query),
            headers: this.http.imageHeaders(),
        };
    }

    getRemoteInfo(udid: string): Promise<RemoteInfo> {
        return this.get<RemoteInfo>(`/api/devices/${encodeURIComponent(udid)}/remote/info`);
    }

    remoteAction(udid: string, action: RemoteAction): Promise<{ ok: true }> {
        return this.send<{ ok: true }>('POST', `/api/devices/${encodeURIComponent(udid)}/remote/action`, action);
    }

    /* ------------------------------------------------------------ fleet */

    getFleetSummary(): Promise<FleetSummary> {
        return this.get<FleetSummary>('/api/fleet/summary');
    }

    /* -------------------------------------------------------- schedules */

    listSchedules(query: ListQuery = {}): Promise<ScheduleListPage> {
        return this.get<ScheduleListPage>('/api/schedules', { query: { ...query } });
    }

    createSchedule(input: CreateScheduleInput): Promise<ScheduleRow> {
        return this.send<ScheduleRow>('POST', '/api/schedules', input);
    }

    createSchedulesBulk(input: BulkScheduleInput): Promise<BulkScheduleResult> {
        return this.send<BulkScheduleResult>('POST', '/api/schedules/bulk', input);
    }

    setScheduleStatus(id: string, transition: 'pause' | 'resume' | 'cancel'): Promise<ScheduleRow> {
        return this.send<ScheduleRow>('POST', `/api/schedules/${encodeURIComponent(id)}/${transition}`);
    }

    /* ------------------------------------------------------- executions */

    listExecutions(query: ListQuery = {}): Promise<ExecutionListPage> {
        return this.get<ExecutionListPage>('/api/executions', { query: { ...query } });
    }

    getExecution(id: string): Promise<ExecutionDetail> {
        return this.get<ExecutionDetail>(`/api/executions/${encodeURIComponent(id)}`);
    }

    stopExecution(id: string): Promise<StopExecutionResult> {
        // Never send HX-Request here — that path answers with HTML.
        return this.send<StopExecutionResult>('POST', `/api/executions/${encodeURIComponent(id)}/stop`);
    }

    retryExecution(id: string): Promise<ExecutionRow> {
        return this.send<ExecutionRow>('POST', `/api/executions/${encodeURIComponent(id)}/retry`);
    }

    /* ----------------------------------------------------------- events */

    listEvents(query: EventQuery = {}): Promise<EventPage> {
        return this.get<EventPage>('/api/events', { query: { ...query } });
    }

    ackEvents(upToId: number): Promise<AckResult> {
        return this.send<AckResult>('POST', '/api/events/ack', { upToId });
    }

    subscribeEvents(subscription: EventSubscription): () => void {
        const client = new SseClient({
            url: this.http.url('/api/events/stream'),
            headers: () => this.http.imageHeaders(),
            lastEventId: subscription.lastEventId,
            onStatus: subscription.onStatus,
            onMessage: (message) => {
                try {
                    subscription.onEvent(JSON.parse(message.data));
                } catch {
                    // A malformed frame is not worth tearing the stream down for.
                }
            },
        });
        client.start();
        return () => client.stop();
    }

    /* ------------------------------------------------------------- push */

    registerPush(input: PushRegistrationInput): Promise<PushRegistration> {
        return this.send<PushRegistration>('POST', '/api/push/register', input);
    }

    listPushRegistrations(): Promise<PushRegistration[]> {
        return this.get<PushRegistration[]>('/api/push/registrations');
    }

    async deletePushRegistration(id: string): Promise<void> {
        await this.send<void>('DELETE', `/api/push/registrations/${encodeURIComponent(id)}`);
    }

    /* ---------------------------------------------------------- content */

    listContentQueue(): Promise<{ items: ContentQueueItem[] }> {
        return this.get<{ items: ContentQueueItem[] }>('/api/content/queue');
    }

    approveContentItem(id: string, options: { plannedFor?: string } = {}): Promise<ContentQueueItem> {
        return this.send<ContentQueueItem>('POST', `/api/content/queue/${encodeURIComponent(id)}/approve`, options);
    }

    skipContentItem(id: string, options: { reason?: string } = {}): Promise<ContentQueueItem> {
        return this.send<ContentQueueItem>('POST', `/api/content/queue/${encodeURIComponent(id)}/skip`, options);
    }

    assetThumbnailRef(assetId: string): ImageRef {
        return {
            uri: this.http.url(`/api/assets/${encodeURIComponent(assetId)}/thumbnail`),
            headers: this.http.imageHeaders(),
        };
    }
}

/* ------------------------------------------------------------- utilities */

export const TERMINAL_EXECUTION_STATUSES: ExecutionStatus[] = ['succeeded', 'failed', 'cancelled', 'skipped', 'stopped'];

export function isExecutionStoppable(status: ExecutionStatus): boolean {
    return status === 'queued' || status === 'running';
}

export function isExecutionRetryable(status: ExecutionStatus): boolean {
    return status === 'failed' || status === 'stopped';
}

export function isScheduleEditable(status: ScheduleStatus): boolean {
    return status === 'active' || status === 'paused';
}

export function createFarmClient(config: FarmHttpClientConfig): FarmHttpClient {
    return new FarmHttpClient(config);
}
