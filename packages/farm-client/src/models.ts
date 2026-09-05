/**
 * Wire models, mirrored from `docs/mobile-api.md`.
 *
 * Every field here is what the farm sends. Nothing in this file is derived or
 * invented by the client; derived values live in `derive.ts`. When the farm
 * renames a field, this is the only place that changes.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Platform = 'ios' | 'android';
export type DriverKind = 'wda' | 'adb' | 'a11y-bridge' | 'appium';

/* ------------------------------------------------------------------ devices */

export interface DeviceIdentity {
    udid: string;
    name: string;
    /** Absent means iOS (`src/types.ts`). */
    platform?: Platform;
    osVersion?: string;
    productType?: string;
}

export interface AndroidDeviceConfig {
    serial: string;
    bridgeUrl?: string;
    /** Present in the record. Never render it. */
    bridgeToken?: string;
}

/** `GET /api/devices` element — passcode redacted to `hasPasscode`. */
export interface RegisteredDevice extends DeviceIdentity {
    driver?: DriverKind;
    android?: AndroidDeviceConfig;
    wdaLocalPort?: number;
    mjpegLocalPort?: number;
    coordinateProfile?: string;
    hasPasscode?: boolean;
    disabled?: boolean;
    /** planned — also returned by the fleet summary. */
    tags?: string[];
    pluginData: Record<string, JsonObject>;
    connected: DeviceIdentity | null;
}

export type PhysicalStatus = 'connected' | 'disconnected';
export type ControlChannelPhase =
    | 'ready'
    | 'connecting'
    | 'unlock-required'
    | 'disconnected'
    | 'error'
    | 'unavailable';

/** `GET /api/devices/:udid/connection` */
export interface DeviceConnectionStatus {
    udid: string;
    physical: PhysicalStatus;
    /** Control-channel phase. On Android this reports adb or the bridge. */
    wda: ControlChannelPhase;
    appium?: ControlChannelPhase;
    managed?: boolean;
    /** Operator-facing. Render verbatim. */
    message: string;
    retryCount?: number;
    updatedAt: string;
}

/** `GET /api/devices/:udid/remote/info` */
export interface RemoteInfo {
    device: DeviceIdentity;
    screen: { screenSize: { width: number; height: number }; scale: number };
}

export type RemoteAction =
    | { type: 'tap'; x: number; y: number }
    | { type: 'swipe'; startX: number; startY: number; endX: number; endY: number; durationMs: number }
    | { type: 'home' }
    | { type: 'back' }
    | { type: 'text'; text: string };

export interface ReconnectResult {
    ok: boolean;
    message: string;
}

/* -------------------------------------------------------------------- fleet */

export type DeviceState = 'online' | 'busy' | 'offline' | 'disabled' | 'error';

export interface FleetCounts {
    total: number;
    online: number;
    busy: number;
    offline: number;
    disabled: number;
    error: number;
}

export interface FleetCurrentExecution {
    id: string;
    taskType: string;
    status: ExecutionStatus;
    startedAt: string | null;
    summary: string;
}

export interface FleetDevice {
    udid: string;
    name: string;
    platform?: Platform;
    tags?: string[];
    /** The single derived badge the app renders (`derivedDeviceState`). */
    state: DeviceState;
    /** Bootstrap sends only this; the full record is `/api/devices/:udid/connection`. */
    connection: { connected: boolean };
    currentExecution: FleetCurrentExecution | null;
    nextRunAt: string | null;
    lastError: string | null;
}

/**
 * `GET /api/fleet/summary` — `summarizeFleet()` in `src/fleet/summary.ts`.
 * Counters only: it carries no device list, and its `devices` field is a
 * four-way registration/USB count, *not* the derived per-device badge. The
 * screen-shaped view comes from `GET /api/mobile/bootstrap` (`FleetView`).
 */
export interface FleetSummary {
    generatedAt: string;
    devices: { total: number; online: number; offline: number; disabled: number };
    /** `{ ios: 9, android: 3 }`. */
    byPlatform: Record<string, number>;
    running: number;
    queued: number;
    stuck: number;
    failedLast24h: number;
    succeededLast24h: number;
    plannedNext24h: number;
}

/** The `fleet` half of `GET /api/mobile/bootstrap` — what the Fleet screen renders. */
export interface FleetView {
    counts: FleetCounts;
    devices: FleetDevice[];
}

/* ---------------------------------------------------------------- schedules */

export type ScheduleTiming =
    | { kind: 'now' }
    | { kind: 'once'; runAt: string }
    | { kind: 'daily'; localTime: string; timezone: string }
    | { kind: 'weekly'; localTime: string; timezone: string; weekdays: number[] };

export interface TaskEnvelope<TPayload extends JsonObject = JsonObject> {
    pluginId: string;
    taskType: string;
    taskVersion: number;
    payload: TPayload;
}

export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface ScheduleRow {
    id: string;
    deviceUdid: string;
    pluginId: string;
    taskType: string;
    taskVersion: number;
    payload: JsonObject;
    timing: ScheduleTiming;
    status: ScheduleStatus;
    runWindowMinutes?: number;
    nextRunAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CreateScheduleInput {
    deviceUdid: string;
    task: TaskEnvelope;
    timing: ScheduleTiming;
    runWindowMinutes?: number;
    assetIds?: string[];
}

export interface BulkScheduleInput {
    deviceUdids?: string[];
    tags?: string[];
    task: TaskEnvelope;
    timing: ScheduleTiming;
    runWindowMinutes?: number;
}

export interface BulkScheduleOutcome {
    deviceUdid: string;
    ok: boolean;
    scheduleId?: string;
    error?: string;
}

/** `POST /api/schedules/bulk` — counts plus one row per targeted device. */
export interface BulkScheduleResult {
    created: number;
    failed: number;
    results: BulkScheduleOutcome[];
}

/* --------------------------------------------------------------- executions */

export type ExecutionStatus =
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'skipped'
    | 'stopped';

export interface ExecutionRow {
    id: string;
    scheduleId: string | null;
    deviceUdid: string;
    pluginId: string;
    taskType: string;
    taskVersion: number;
    payload: JsonObject;
    scheduledFor: string | null;
    deadlineAt: string | null;
    status: ExecutionStatus;
    queueJobId?: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    error: string | null;
    stopRequestedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ExecutionDetail extends ExecutionRow {
    logs: string[];
}

export interface StopExecutionResult {
    result: 'queued' | 'running' | 'not-found' | 'unsupported';
}

/* ------------------------------------------------------------------- events */

export type EventSeverity = 'info' | 'warning' | 'error';

export type EventKind =
    | 'execution.started'
    | 'execution.retried'
    | 'execution.succeeded'
    | 'execution.failed'
    | 'execution.stopped'
    | 'execution.cancelled'
    | 'execution.stuck'
    | 'device.connected'
    | 'device.disconnected'
    | 'device.error'
    | 'schedule.created'
    | 'schedule.paused'
    | 'schedule.cancelled'
    | 'digest.daily';

export const EVENT_KINDS: EventKind[] = [
    'execution.started',
    'execution.retried',
    'execution.succeeded',
    'execution.failed',
    'execution.stopped',
    'execution.cancelled',
    'execution.stuck',
    'device.connected',
    'device.disconnected',
    'device.error',
    'schedule.created',
    'schedule.paused',
    'schedule.cancelled',
    'digest.daily',
];

/**
 * Event ids are the farm's `scheduler.events.id` bigint identity, serialised as
 * a JSON number. Cursors (`before`, `upToId`) and the last-rendered id compare
 * numerically; only the SSE `Last-Event-ID` header carries it as a string.
 */
export interface FarmEvent {
    id: number;
    kind: EventKind | (string & {});
    severity: EventSeverity;
    deviceUdid: string | null;
    executionId: string | null;
    scheduleId: string | null;
    title: string;
    /**
     * The farm's structured payload — `serializeEvent` in `src/fleet/events.ts`
     * sends exactly this key. There is no `message` and no `data` on the wire;
     * the operator-facing sentence is derived from `detail` by `eventText`.
     */
    detail: JsonObject | null;
    createdAt: string;
}

export interface EventQuery {
    since?: string;
    until?: string;
    /**
     * One kind, not a list: `parseEventQuery` reads a single string and answers
     * `400 Unknown event kind` for a repeated `?kind=` (which Fastify parses as
     * an array). Filter by more than one kind client-side.
     */
    kind?: EventKind | string;
    deviceUdid?: string;
    severity?: EventSeverity;
    limit?: number;
    before?: number;
    /** Only `false` is meaningful — it narrows to this token's unread mark. */
    acknowledged?: boolean;
}

export interface EventPage {
    events: FarmEvent[];
    /** Absent on the last page. */
    nextBefore?: number;
}

export interface AckResult {
    acknowledged: number;
    unacknowledgedCount: number;
}

/* --------------------------------------------------------------------- push */

export interface PushRegistrationInput {
    expoPushToken: string;
    name: string;
    minSeverity: EventSeverity;
    /** `null`/omitted means every kind at or above `minSeverity`. */
    kinds?: (EventKind | string)[] | null;
}

export interface PushRegistration {
    id: string;
    name: string;
    minSeverity: EventSeverity;
    kinds: (EventKind | string)[] | null;
    tokenSuffix?: string;
    createdAt: string;
    lastSeenAt: string;
}

/* ------------------------------------------------------------------ content */

/**
 * Derived server-side from the plan's schedule (`queueStatus` in
 * `src/api/routes/mobile.ts`). Only these four are emitted; treat anything else
 * as `planned`.
 */
export type ContentItemStatus = 'planned' | 'approved' | 'skipped' | 'posted';

export interface ContentQueueItem {
    id: string;
    status: ContentItemStatus;
    deviceUdid: string;
    caption: string;
    assetId: string;
    /** Server-relative, e.g. `/api/assets/9f2c…/thumbnail`. */
    thumbnailUrl: string | null;
    plannedFor: string | null;
    scheduleId: string | null;
}

/* ------------------------------------------------- plugins, health, bootstrap */

export interface PluginTaskDescriptor {
    type: string;
    version: number;
    displayName: string;
}

export interface PluginDescriptor {
    id: string;
    version: string;
    displayName: string;
    tasks: PluginTaskDescriptor[];
}

/** `/health`'s `release` — the deploy tooling's `RELEASED` marker. */
export interface ReleaseInfo {
    sha: string;
    subject: string;
    deployedAt: string;
}

/** Bootstrap's `release` — `package.json` version plus the short git sha. */
export interface BuildInfo {
    version: string;
    sha: string | null;
}

export interface HealthResponse {
    ok: boolean;
    plugins?: { id: string; version: string }[];
    /** Only present when a RELEASED marker exists. */
    release?: ReleaseInfo;
}

/**
 * The six keys `GET /api/mobile/bootstrap` actually sends. Missing means
 * `false`, so one app build can talk to an older farm.
 */
export interface Capabilities {
    push?: boolean;
    eventAck?: boolean;
    thumbnails?: boolean;
    contentQueue?: boolean;
    tokens?: boolean;
    rateLimits?: boolean;
}

/** `GET /api/mobile/bootstrap` */
export interface Bootstrap {
    serverTime: string;
    release: BuildInfo;
    plugins: PluginDescriptor[];
    fleet: FleetView;
    /** The newest 20, in `/api/events` shape. */
    recentEvents: FarmEvent[];
    unacknowledgedCount: number;
    capabilities: Capabilities;
}
