/**
 * `createMockFarm()` — an in-memory farm behind the same `FarmClient`
 * interface, so "use demo data" swaps one object and no screen knows.
 *
 * msw is heavy on React Native and would only let us assert on the same fake
 * data one layer lower down, so this implements the interface directly. It
 * enforces the conflicts that matter: remote input during a run is a `409`,
 * disabling a busy device is a `409`, a non-retryable execution is a `409`, an
 * unknown id is a `404`. Those branches are most of what the UI has to render.
 */

import type {
    EventSubscription,
    FarmClient,
    ImageRef,
    ListQuery,
    ExecutionListPage,
    ScheduleListPage,
    ScreenshotOptions,
} from '../client';
import { FarmError } from '../errors';
import type {
    AckResult,
    Bootstrap,
    BulkScheduleInput,
    BulkScheduleResult,
    ContentQueueItem,
    CreateScheduleInput,
    DeviceConnectionStatus,
    DeviceState,
    EventKind,
    EventPage,
    EventQuery,
    EventSeverity,
    ExecutionDetail,
    ExecutionRow,
    FarmEvent,
    FleetDevice,
    FleetSummary,
    HealthResponse,
    PluginDescriptor,
    PushRegistration,
    PushRegistrationInput,
    RegisteredDevice,
    ReconnectResult,
    RemoteAction,
    RemoteInfo,
    ScheduleRow,
    StopExecutionResult,
} from '../models';
import { countStates } from '../derive';
import { DEFAULT_SEVERITY } from '../event-text';
import { encodePngDataUri } from './png';
import {
    MOCK_PLUGINS,
    mockConnectionForState,
    mockContentQueue,
    mockExecutions,
    mockLogs,
    executionId,
    mockRegisteredDevices,
    mockDeviceSeeds,
    mockSchedules,
    seededRandom,
} from './fixtures';

export interface MockFarmOptions {
    /** Freeze time for a deterministic test. Defaults to `Date.now()`. */
    now?: number;
    /** How often a new event appears. `0` disables the ticker. Default 4000. */
    tickMs?: number;
    /** Fake round-trip time, so loading states are visible in demo mode. */
    latencyMs?: number;
    seed?: number;
}

export interface MockFarm extends FarmClient {
    /** Emit one event immediately — used by tests and the demo "poke" action. */
    emit(partial?: Partial<FarmEvent>): FarmEvent;
    /** Stop the ticker. Demo mode calls this when the client is swapped out. */
    dispose(): void;
}

const EVENT_ID_PREFIX = '01J9Z3M8QF';

export function createMockFarm(options: MockFarmOptions = {}): MockFarm {
    const t0 = options.now ?? Date.now();
    const tickMs = options.tickMs ?? 4_000;
    const latencyMs = options.latencyMs ?? 0;
    const random = seededRandom(options.seed ?? 42);

    const seeds = mockDeviceSeeds();
    const devices = mockRegisteredDevices();
    const states = new Map<string, DeviceState>(seeds.map((seed) => [seed.udid, seed.state]));
    const schedules = mockSchedules(t0);
    const executions = mockExecutions(t0, schedules);
    const content = mockContentQueue(t0);
    const pushRegistrations: PushRegistration[] = [];
    const events: FarmEvent[] = [];
    let eventCounter = 0;
    // Above every seeded id, so a new run sorts newest and the cursor holds.
    let executionSeq = executions.length;
    let acknowledgedUpTo: string | null = null;

    const listeners = new Set<(event: FarmEvent) => void>();
    let ticker: ReturnType<typeof setInterval> | null = null;

    /* --------------------------------------------------------- helpers */

    const nextEventId = (): string => {
        eventCounter += 1;
        return `${EVENT_ID_PREFIX}${String(eventCounter).padStart(6, '0')}`;
    };

    const delay = <T>(value: T): Promise<T> =>
        latencyMs > 0 ? new Promise((resolve) => setTimeout(() => resolve(value), latencyMs)) : Promise.resolve(value);

    const fail = (kind: ConstructorParameters<typeof FarmError>[0], message: string, status: number): never => {
        throw new FarmError(kind, message, { status });
    };

    const deviceOr404 = (udid: string): RegisteredDevice => {
        const device = devices.find((row) => row.udid === udid);
        return device ?? fail('not-found', 'Unknown device', 404);
    };

    /** Running wins over queued — the running one is what "busy" means. */
    const activeExecutionFor = (udid: string): ExecutionRow | undefined => {
        const mine = executions.filter(
            (row) => row.deviceUdid === udid && (row.status === 'running' || row.status === 'queued'),
        );
        return mine.find((row) => row.status === 'running') ?? mine[0];
    };

    const deviceName = (udid: string | null | undefined): string | undefined =>
        udid ? devices.find((row) => row.udid === udid)?.name : undefined;

    function record(partial: Partial<FarmEvent> & { kind: EventKind | string }): FarmEvent {
        const kind = partial.kind;
        const severity: EventSeverity = partial.severity ?? DEFAULT_SEVERITY[kind as EventKind] ?? 'info';
        const event: FarmEvent = {
            id: nextEventId(),
            kind,
            severity,
            deviceUdid: partial.deviceUdid ?? null,
            executionId: partial.executionId ?? null,
            scheduleId: partial.scheduleId ?? null,
            title: partial.title ?? `${kind} on ${deviceName(partial.deviceUdid) ?? 'the farm'}`,
            message: partial.message ?? '',
            data: partial.data,
            createdAt: new Date(Date.now()).toISOString(),
        };
        events.unshift(event);
        if (events.length > 400) events.length = 400;
        for (const listener of listeners) listener(event);
        return event;
    }

    /* -------------------------------------------------- seeded history */

    seedHistory();

    function seedHistory(): void {
        const seededKinds: { kind: EventKind; severity?: EventSeverity }[] = [
            { kind: 'execution.started' },
            { kind: 'execution.succeeded' },
            { kind: 'device.connected' },
            { kind: 'execution.failed' },
            { kind: 'device.disconnected' },
            { kind: 'schedule.created' },
            { kind: 'execution.stuck' },
            { kind: 'device.error' },
            { kind: 'schedule.paused' },
            { kind: 'execution.stopped' },
        ];
        // Oldest first so ids stay monotonic with time.
        for (let index = 0; index < 34; index += 1) {
            const { kind } = seededKinds[index % seededKinds.length]!;
            const execution = executions[index % executions.length]!;
            const at = new Date(t0 - (34 - index) * 420_000).toISOString();
            const name = deviceName(execution.deviceUdid) ?? 'a device';
            const event: FarmEvent = {
                id: nextEventId(),
                kind,
                severity: DEFAULT_SEVERITY[kind],
                deviceUdid: execution.deviceUdid,
                executionId: kind.startsWith('execution') ? execution.id : null,
                scheduleId: kind.startsWith('schedule') ? execution.scheduleId : null,
                title: titleFor(kind, name, execution.taskType),
                message: messageFor(kind, execution.error),
                data: kind === 'execution.failed' ? { attempt: 3, exitCode: 1 } : kind === 'execution.stuck' ? { stuckForSeconds: 900 } : undefined,
                createdAt: at,
            };
            events.unshift(event);
        }
        // Two unacknowledged errors at the top is what the badge should show.
        acknowledgedUpTo = events[2]?.id ?? null;
    }

    function titleFor(kind: EventKind, name: string, taskType: string): string {
        switch (kind) {
            case 'execution.failed':
                return `${cap(taskType)} failed on ${name}`;
            case 'execution.started':
                return `${cap(taskType)} started on ${name}`;
            case 'execution.succeeded':
                return `${cap(taskType)} finished on ${name}`;
            case 'execution.stopped':
                return `${cap(taskType)} stopped on ${name}`;
            case 'execution.stuck':
                return `${cap(taskType)} is stuck on ${name}`;
            case 'device.connected':
                return `${name} connected`;
            case 'device.disconnected':
                return `${name} disconnected`;
            case 'device.error':
                return `${name} reported an error`;
            case 'schedule.created':
                return `New schedule for ${name}`;
            case 'schedule.paused':
                return `Schedule paused for ${name}`;
            case 'schedule.cancelled':
                return `Schedule cancelled for ${name}`;
            default:
                return `${kind} · ${name}`;
        }
    }

    function messageFor(kind: EventKind, error: string | null): string {
        switch (kind) {
            case 'execution.failed':
                return error ?? 'TikTok did not reach the feed after 3 attempts';
            case 'device.disconnected':
                return 'The device dropped off the bus — check the cable';
            case 'device.error':
                return 'The bridge stopped responding after 3 retries';
            case 'execution.stuck':
                return 'No progress for 15m';
            case 'execution.succeeded':
                return 'Exit 0';
            default:
                return '';
        }
    }

    function cap(value: string): string {
        return value.charAt(0).toUpperCase() + value.slice(1);
    }

    /* ----------------------------------------------------------- ticker */

    const TICK_KINDS: EventKind[] = [
        'execution.started',
        'execution.succeeded',
        'device.connected',
        'execution.failed',
        'device.disconnected',
        'execution.stuck',
    ];

    function tick(): void {
        const kind = TICK_KINDS[Math.floor(random() * TICK_KINDS.length)]!;
        const candidates = devices.filter((device) => !device.disabled);
        const device = candidates[Math.floor(random() * candidates.length)]!;
        const execution = executions.find((row) => row.deviceUdid === device.udid) ?? executions[0]!;
        record({
            kind,
            deviceUdid: device.udid,
            executionId: kind.startsWith('execution') ? execution.id : null,
            title: titleFor(kind, device.name, execution.taskType),
            message: messageFor(kind, execution.error),
            data: kind === 'execution.failed' ? { attempt: 3, exitCode: 1 } : undefined,
        });
    }

    function ensureTicker(): void {
        if (ticker || tickMs <= 0 || listeners.size === 0) return;
        ticker = setInterval(tick, tickMs);
        // Do not hold a Node test process open.
        (ticker as unknown as { unref?: () => void }).unref?.();
    }

    function maybeStopTicker(): void {
        if (ticker && listeners.size === 0) {
            clearInterval(ticker);
            ticker = null;
        }
    }

    /* ------------------------------------------------------ screenshots */

    const frameCache = new Map<string, string>();

    function frameFor(udid: string, nonce: string): string {
        const state = states.get(udid) ?? 'online';
        const key = `${udid}:${state}:${nonce}`;
        const cached = frameCache.get(key);
        if (cached) return cached;

        const device = devices.find((row) => row.udid === udid);
        const android = device?.platform === 'android';
        const hue = (hash(udid) % 360) / 360;
        const accent = hsvToRgb(hue, 0.55, 0.9);
        const offset = hash(nonce) % 7;

        const width = 90;
        const height = 160;
        const uri = encodePngDataUri(width, height, (x, y) => {
            if (state === 'offline' || state === 'disabled') return [16, 17, 20];
            if (y < 8) return android ? [24, 24, 28] : [10, 10, 12]; // status bar
            if (y > height - 10) return [24, 24, 28]; // nav bar
            if (state === 'error') return y % 12 < 6 ? [48, 18, 20] : [30, 12, 14];
            // A stack of "cards" that shifts with the nonce, so a refresh reads
            // as a new frame rather than a frozen one.
            const band = Math.floor((y + offset * 4) / 26);
            if ((y + offset * 4) % 26 < 20 && x > 4 && x < width - 4) {
                const shade = band % 2 === 0 ? 1 : 0.72;
                return [
                    Math.round(accent[0] * shade),
                    Math.round(accent[1] * shade),
                    Math.round(accent[2] * shade),
                ];
            }
            return [12, 12, 14];
        });
        frameCache.set(key, uri);
        if (frameCache.size > 60) frameCache.delete(frameCache.keys().next().value as string);
        return uri;
    }

    /* ---------------------------------------------------------- reading */

    function fleetDevices(): FleetDevice[] {
        return devices.map((device) => {
            const state = states.get(device.udid) ?? 'online';
            const active = state === 'busy' ? activeExecutionFor(device.udid) : undefined;
            const next = schedules
                .filter((row) => row.deviceUdid === device.udid && row.status === 'active' && row.nextRunAt)
                .map((row) => row.nextRunAt!)
                .sort()[0];
            return {
                udid: device.udid,
                name: device.name,
                platform: device.platform,
                tags: device.tags ?? [],
                state,
                connection: mockConnectionForState(state),
                currentExecution: active
                    ? {
                          id: active.id,
                          taskType: active.taskType,
                          status: active.status,
                          startedAt: active.startedAt,
                          summary: `${cap(active.taskType)} for ${String(active.payload.minutes ?? 12)} minutes`,
                      }
                    : null,
                nextRunAt: next ?? null,
                lastError: state === 'error' ? 'The bridge stopped responding after 3 retries' : null,
            };
        });
    }

    function unacknowledgedCount(): number {
        if (!acknowledgedUpTo) return events.length;
        return events.filter((event) => event.id > acknowledgedUpTo!).length;
    }

    /* -------------------------------------------------------- the client */

    const client: MockFarm = {
        baseUrl: 'mock://demo-farm',
        isMock: true,

        health: () =>
            delay<HealthResponse>({
                ok: true,
                plugins: MOCK_PLUGINS.map((plugin) => ({ id: plugin.id, version: plugin.version })),
                release: { sha: 'demo000', subject: 'demo data — no Mac in the loop', deployedAt: new Date(t0 - 86_400_000).toISOString() },
            }),

        bootstrap: () =>
            delay<Bootstrap>({
                serverTime: new Date().toISOString(),
                release: { sha: 'demo000', subject: 'demo data — no Mac in the loop', deployedAt: new Date(t0 - 86_400_000).toISOString() },
                plugins: MOCK_PLUGINS,
                fleet: { counts: countStates(fleetDevices()), devices: fleetDevices() },
                recentEvents: events.slice(0, 50),
                unacknowledgedCount: unacknowledgedCount(),
                capabilities: { events: true, sse: true, push: true, drip: true, screenshotThumbnails: true, eventAck: true },
            }),

        listPlugins: () => delay<PluginDescriptor[]>(MOCK_PLUGINS),

        listDevices: () => delay(devices.map((device) => ({ ...device }))),

        getDeviceConnection: async (udid) => {
            const device = deviceOr404(udid);
            const state = states.get(device.udid) ?? 'online';
            const base = mockConnectionForState(state);
            return delay<DeviceConnectionStatus>({
                udid,
                physical: base.physical,
                wda: base.wda,
                appium: 'unavailable',
                managed: true,
                message: base.message,
                retryCount: state === 'error' ? 3 : 0,
                updatedAt: new Date().toISOString(),
            });
        },

        patchDevice: async (udid, patch) => {
            const device = deviceOr404(udid);
            if (patch.disabled === true && activeExecutionFor(udid)) {
                fail('conflict', 'This device has a queued or running execution', 409);
            }
            if (patch.name !== undefined) device.name = patch.name;
            if (patch.tags !== undefined) device.tags = [...patch.tags];
            if (patch.disabled !== undefined) {
                device.disabled = patch.disabled;
                device.connected = patch.disabled ? null : { udid: device.udid, name: device.name, platform: device.platform };
                states.set(udid, patch.disabled ? 'disabled' : 'online');
                record({
                    kind: patch.disabled ? 'device.disconnected' : 'device.connected',
                    deviceUdid: udid,
                    title: `${device.name} ${patch.disabled ? 'deactivated' : 'activated'}`,
                    message: patch.disabled ? 'Deactivated from the phone' : 'Activated from the phone',
                });
            }
            return delay({ ...device });
        },

        reconnectDevice: async (udid) => {
            const device = deviceOr404(udid);
            if (activeExecutionFor(udid)) fail('conflict', 'Automation is running on this device', 409);
            states.set(udid, 'online');
            device.connected = { udid: device.udid, name: device.name, platform: device.platform };
            record({ kind: 'device.connected', deviceUdid: udid, title: `${device.name} reconnected`, message: 'Reconnect requested from the phone' });
            return delay<ReconnectResult>({ ok: true, message: 'The shared WDA supervisor will reconnect automatically' });
        },

        screenshotRef: (udid, screenshotOptions: ScreenshotOptions = {}): ImageRef => ({
            uri: frameFor(udid, String(screenshotOptions.nonce ?? 0)),
        }),

        getRemoteInfo: async (udid) => {
            const device = deviceOr404(udid);
            if (states.get(udid) === 'offline' || device.disabled) fail('not-found', 'Device is not connected', 404);
            const ios = (device.platform ?? 'ios') === 'ios';
            return delay<RemoteInfo>({
                device: { udid: device.udid, name: device.name, platform: device.platform, osVersion: device.osVersion, productType: device.productType },
                screen: ios
                    ? { screenSize: { width: 375, height: 667 }, scale: 2 }
                    : { screenSize: { width: 412, height: 915 }, scale: 2.625 },
            });
        },

        remoteAction: async (udid, action: RemoteAction) => {
            const device = deviceOr404(udid);
            if (activeExecutionFor(udid)) {
                fail('conflict', 'Remote input is disabled while automation is running', 409);
            }
            if ((action.type === 'back' || action.type === 'text') && (device.platform ?? 'ios') === 'ios') {
                fail('validation', `"${action.type}" is an Android-only remote action`, 400);
            }
            // A new frame, so the operator sees the tap did something.
            frameCache.clear();
            return delay<{ ok: true }>({ ok: true });
        },

        getFleetSummary: () => {
            const list = fleetDevices();
            return delay<FleetSummary>({ generatedAt: new Date().toISOString(), counts: countStates(list), devices: list });
        },

        listSchedules: async (query: ListQuery = {}) => {
            let rows = schedules.slice();
            if (query.deviceUdid) rows = rows.filter((row) => row.deviceUdid === query.deviceUdid);
            rows.sort((a, b) => (a.id < b.id ? 1 : -1));
            return delay<ScheduleListPage>(page(rows, query, (row) => row.id, 'schedules'));
        },

        createSchedule: async (input: CreateScheduleInput) => {
            const device = deviceOr404(input.deviceUdid);
            if (device.disabled) fail('conflict', 'This device is disabled — activate it before scheduling automation', 409);
            const plugin = MOCK_PLUGINS.find((row) => row.id === input.task.pluginId);
            const task = plugin?.tasks.find((row) => row.type === input.task.taskType && row.version === input.task.taskVersion);
            if (!task) fail('validation', `Unknown task envelope ${input.task.taskType} v${input.task.taskVersion}`, 400);
            const row: ScheduleRow = {
                id: `sch_new_${schedules.length}`,
                deviceUdid: input.deviceUdid,
                pluginId: input.task.pluginId,
                taskType: input.task.taskType,
                taskVersion: input.task.taskVersion,
                payload: input.task.payload,
                timing: input.timing,
                status: 'active',
                runWindowMinutes: input.runWindowMinutes ?? 30,
                nextRunAt: input.timing.kind === 'now' ? new Date().toISOString() : new Date(Date.now() + 900_000).toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            schedules.unshift(row);
            record({ kind: 'schedule.created', deviceUdid: row.deviceUdid, scheduleId: row.id, title: `New schedule for ${device.name}`, message: `${cap(row.taskType)} · ${row.timing.kind}` });
            if (input.timing.kind === 'now') {
                const execution: ExecutionRow = {
                    id: executionId((executionSeq += 1)),
                    scheduleId: row.id,
                    deviceUdid: row.deviceUdid,
                    pluginId: row.pluginId,
                    taskType: row.taskType,
                    taskVersion: row.taskVersion,
                    payload: row.payload,
                    scheduledFor: new Date().toISOString(),
                    deadlineAt: new Date(Date.now() + 1_800_000).toISOString(),
                    status: 'running',
                    startedAt: new Date().toISOString(),
                    finishedAt: null,
                    exitCode: null,
                    error: null,
                    stopRequestedAt: null,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                executions.unshift(execution);
                states.set(row.deviceUdid, 'busy');
                record({ kind: 'execution.started', deviceUdid: row.deviceUdid, executionId: execution.id, title: `${cap(row.taskType)} started on ${device.name}`, message: '' });
            }
            return delay(row);
        },

        createSchedulesBulk: async (input: BulkScheduleInput) => {
            const targets = new Set<string>(input.deviceUdids ?? []);
            for (const device of devices) {
                if ((input.tags ?? []).some((tag) => (device.tags ?? []).includes(tag))) targets.add(device.udid);
            }
            const result: BulkScheduleResult = { created: [], failed: [] };
            for (const udid of targets) {
                const device = devices.find((row) => row.udid === udid);
                if (!device) {
                    result.failed.push({ deviceUdid: udid, error: 'Unknown device' });
                } else if (device.disabled) {
                    result.failed.push({ deviceUdid: udid, error: 'This device is disabled — activate it before scheduling automation' });
                } else {
                    result.created.push({ deviceUdid: udid, scheduleId: `sch_bulk_${result.created.length}` });
                }
            }
            return delay(result);
        },

        setScheduleStatus: async (id, transition) => {
            const row = schedules.find((schedule) => schedule.id === id) ?? fail('not-found', 'Unknown schedule', 404);
            if ((row.status === 'completed' || row.status === 'cancelled') && transition !== 'cancel') {
                fail('conflict', 'Completed or cancelled schedules cannot be edited', 409);
            }
            if (transition === 'resume' && row.status !== 'paused') {
                fail('conflict', `A ${row.status} schedule cannot be resumed`, 409);
            }
            row.status = transition === 'pause' ? 'paused' : transition === 'resume' ? 'active' : 'cancelled';
            row.nextRunAt = row.status === 'active' ? new Date(Date.now() + 900_000).toISOString() : null;
            row.updatedAt = new Date().toISOString();
            record({
                kind: transition === 'pause' ? 'schedule.paused' : transition === 'cancel' ? 'schedule.cancelled' : 'schedule.created',
                deviceUdid: row.deviceUdid,
                scheduleId: row.id,
                title: `Schedule ${row.status} for ${deviceName(row.deviceUdid) ?? 'a device'}`,
                message: '',
            });
            return delay({ ...row });
        },

        listExecutions: async (query: ListQuery = {}) => {
            let rows = executions.slice();
            if (query.deviceUdid) rows = rows.filter((row) => row.deviceUdid === query.deviceUdid);
            return delay<ExecutionListPage>(page(rows, query, (row) => row.id, 'executions'));
        },

        getExecution: async (id) => {
            const row = executions.find((execution) => execution.id === id) ?? fail('not-found', 'Unknown execution', 404);
            return delay<ExecutionDetail>({ ...row, logs: mockLogs(row) });
        },

        stopExecution: async (id) => {
            const row = executions.find((execution) => execution.id === id);
            if (!row) fail('not-found', 'Unknown execution', 404);
            if (row!.status !== 'running' && row!.status !== 'queued') {
                return delay<StopExecutionResult>({ result: 'unsupported' });
            }
            const previous = row!.status;
            row!.status = 'stopped';
            row!.stopRequestedAt = new Date().toISOString();
            row!.finishedAt = new Date().toISOString();
            row!.updatedAt = row!.finishedAt;
            if (!activeExecutionFor(row!.deviceUdid)) states.set(row!.deviceUdid, 'online');
            record({ kind: 'execution.stopped', deviceUdid: row!.deviceUdid, executionId: row!.id, title: `${cap(row!.taskType)} stopped on ${deviceName(row!.deviceUdid) ?? 'a device'}`, message: 'Stopped from the phone' });
            return delay<StopExecutionResult>({ result: previous });
        },

        retryExecution: async (id) => {
            const row = executions.find((execution) => execution.id === id) ?? fail('not-found', 'Unknown execution', 404);
            if (row.status !== 'failed' && row.status !== 'stopped') fail('conflict', 'Execution is not retryable', 409);
            const retry: ExecutionRow = {
                ...row,
                id: executionId((executionSeq += 1)),
                status: 'queued',
                startedAt: null,
                finishedAt: null,
                exitCode: null,
                error: null,
                stopRequestedAt: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            executions.unshift(retry);
            record({ kind: 'execution.started', deviceUdid: retry.deviceUdid, executionId: retry.id, title: `${cap(retry.taskType)} requeued on ${deviceName(retry.deviceUdid) ?? 'a device'}`, message: 'Retried from the phone' });
            return delay(retry);
        },

        listEvents: async (query: EventQuery = {}) => {
            let rows = events.slice();
            if (query.severity) rows = rows.filter((event) => event.severity === query.severity);
            if (query.kind?.length) rows = rows.filter((event) => query.kind!.includes(event.kind));
            if (query.deviceUdid) rows = rows.filter((event) => event.deviceUdid === query.deviceUdid);
            if (query.since) rows = rows.filter((event) => event.createdAt >= query.since!);
            if (query.until) rows = rows.filter((event) => event.createdAt < query.until!);
            if (query.acknowledged === false && acknowledgedUpTo) rows = rows.filter((event) => event.id > acknowledgedUpTo!);
            if (query.before) rows = rows.filter((event) => event.id < query.before!);
            const limit = Math.min(200, query.limit ?? 50);
            const slice = rows.slice(0, limit);
            const result: EventPage = { events: slice };
            if (rows.length > limit && slice.length > 0) result.nextBefore = slice[slice.length - 1]!.id;
            return delay(result);
        },

        ackEvents: async (upToId) => {
            const before = unacknowledgedCount();
            acknowledgedUpTo = !acknowledgedUpTo || upToId > acknowledgedUpTo ? upToId : acknowledgedUpTo;
            const after = unacknowledgedCount();
            return delay<AckResult>({ acknowledged: Math.max(0, before - after), unacknowledgedCount: after });
        },

        subscribeEvents: (subscription: EventSubscription) => {
            // Replay whatever happened after the id the app last rendered.
            if (subscription.lastEventId) {
                const missed = events.filter((event) => event.id > subscription.lastEventId!).reverse();
                for (const event of missed) subscription.onEvent(event);
            }
            const listener = (event: FarmEvent) => subscription.onEvent(event);
            listeners.add(listener);
            ensureTicker();
            subscription.onStatus?.('open');
            return () => {
                listeners.delete(listener);
                maybeStopTicker();
                subscription.onStatus?.('idle');
            };
        },

        registerPush: (input: PushRegistrationInput) => {
            const existing = pushRegistrations.find((row) => row.name === input.name);
            const registration: PushRegistration = {
                id: existing?.id ?? `push_${pushRegistrations.length}`,
                name: input.name,
                minSeverity: input.minSeverity,
                kinds: input.kinds ?? null,
                tokenSuffix: input.expoPushToken.slice(-6, -1),
                createdAt: existing?.createdAt ?? new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
            };
            if (existing) Object.assign(existing, registration);
            else pushRegistrations.push(registration);
            return delay(registration);
        },

        listPushRegistrations: () => delay(pushRegistrations.map((row) => ({ ...row }))),

        deletePushRegistration: async (id) => {
            const index = pushRegistrations.findIndex((row) => row.id === id);
            if (index === -1) fail('not-found', 'Unknown registration', 404);
            pushRegistrations.splice(index, 1);
            return delay(undefined);
        },

        listContentQueue: () => delay({ items: content.map((item) => ({ ...item })) }),

        approveContentItem: async (id, approveOptions = {}) => {
            const item = content.find((row) => row.id === id) ?? fail('not-found', 'Unknown content item', 404);
            if (item.status !== 'planned') fail('conflict', `A ${item.status} item cannot be approved`, 409);
            item.status = 'approved';
            if (approveOptions.plannedFor) item.plannedFor = approveOptions.plannedFor;
            item.scheduleId = `sch_content_${id}`;
            return delay<ContentQueueItem>({ ...item });
        },

        skipContentItem: async (id) => {
            const item = content.find((row) => row.id === id) ?? fail('not-found', 'Unknown content item', 404);
            if (item.status !== 'planned') fail('conflict', `A ${item.status} item cannot be skipped`, 409);
            item.status = 'skipped';
            return delay<ContentQueueItem>({ ...item });
        },

        assetThumbnailRef: (assetId) => ({ uri: frameFor(assetId, 'asset') }),

        emit: (partial = {}) => record({ kind: 'execution.failed', ...partial }),

        dispose: () => {
            listeners.clear();
            if (ticker) clearInterval(ticker);
            ticker = null;
        },
    };

    return client;
}

/** Shared keyset paging for schedules/executions (gap 9). */
function page<T, K extends 'schedules' | 'executions'>(
    rows: T[],
    query: ListQuery,
    idOf: (row: T) => string,
    key: K,
): { [P in K]: T[] } & { nextBefore?: string } {
    let filtered = rows;
    if (query.before) filtered = filtered.filter((row) => idOf(row) < query.before!);
    const limit = Math.min(200, query.limit ?? 200);
    const slice = filtered.slice(0, limit);
    const result = { [key]: slice } as { [P in K]: T[] } & { nextBefore?: string };
    if (filtered.length > limit && slice.length > 0) result.nextBefore = idOf(slice[slice.length - 1]!);
    return result;
}

function hash(value: string): number {
    let h = 2_166_136_261;
    for (let i = 0; i < value.length; i += 1) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, 16_777_619);
    }
    return Math.abs(h);
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    const [r, g, b] = [
        [v, t, p],
        [q, v, p],
        [p, v, t],
        [p, q, v],
        [t, p, v],
        [v, p, q],
    ][i % 6]!;
    return [Math.round(r! * 255), Math.round(g! * 255), Math.round(b! * 255)];
}
