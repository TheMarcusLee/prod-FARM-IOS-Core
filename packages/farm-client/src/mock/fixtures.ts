/**
 * The fake farm's contents: 12 devices (2 iOS, 10 Android — one disabled, one
 * offline, three busy, one erroring), schedules covering all four timing
 * shapes, executions covering every status, and a content queue.
 *
 * Deterministic: a seeded PRNG, and every timestamp is relative to a `now`
 * passed in, so a test can assert on the result and a screenshot looks the same
 * every launch.
 */

import type {
    ContentQueueItem,
    DeviceConnectionStatus,
    ExecutionRow,
    ExecutionStatus,
    FleetDevice,
    PluginDescriptor,
    RegisteredDevice,
    ScheduleRow,
    ScheduleTiming,
} from '../models';

/** mulberry32 — small, fast, and stable across engines. */
export function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d_2b_79_f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

export const MOCK_PLUGINS: PluginDescriptor[] = [
    {
        id: 'com.git-agni.tiktok',
        version: '0.4.1',
        displayName: 'TikTok',
        tasks: [
            { type: 'doomscroll', version: 1, displayName: 'Doomscroll' },
            { type: 'post', version: 2, displayName: 'Post a clip' },
        ],
    },
    {
        id: 'com.git-agni.warmup',
        version: '0.2.0',
        displayName: 'Warm-up',
        tasks: [{ type: 'warmup', version: 1, displayName: 'Warm up the account' }],
    },
];

interface DeviceSeed {
    udid: string;
    name: string;
    platform: 'ios' | 'android';
    tags: string[];
    state: FleetDevice['state'];
    osVersion: string;
    productType: string;
}

const DEVICE_SEEDS: DeviceSeed[] = [
    { udid: '00008030-001A2B3C0E88802E', name: 'iPhone 8 · slot 1', platform: 'ios', tags: ['warm-up', 'slot-row-1'], state: 'busy', osVersion: '16.7.2', productType: 'iPhone10,4' },
    { udid: '00008101-000E2D3A1A08001E', name: 'iPhone 11 · slot 2', platform: 'ios', tags: ['posting', 'slot-row-1'], state: 'online', osVersion: '17.5.1', productType: 'iPhone12,1' },
    { udid: 'R58N12ABCDE', name: 'Pixel 6a · slot 3', platform: 'android', tags: ['warm-up', 'slot-row-1'], state: 'busy', osVersion: '14', productType: 'Pixel 6a' },
    { udid: 'R58N12ABCDF', name: 'Pixel 6a · slot 4', platform: 'android', tags: ['warm-up', 'slot-row-1'], state: 'online', osVersion: '14', productType: 'Pixel 6a' },
    { udid: 'RF8M90XYZ01', name: 'Galaxy A14 · slot 5', platform: 'android', tags: ['posting', 'slot-row-2'], state: 'online', osVersion: '13', productType: 'SM-A145F' },
    { udid: 'RF8M90XYZ02', name: 'Galaxy A14 · slot 6', platform: 'android', tags: ['posting', 'slot-row-2'], state: 'busy', osVersion: '13', productType: 'SM-A145F' },
    { udid: 'RF8M90XYZ03', name: 'Galaxy A14 · slot 7', platform: 'android', tags: ['warm-up', 'slot-row-2'], state: 'offline', osVersion: '13', productType: 'SM-A145F' },
    { udid: '9A271FFAZ00K4L', name: 'Moto G54 · slot 8', platform: 'android', tags: ['us-east', 'slot-row-2'], state: 'online', osVersion: '14', productType: 'motorola g54' },
    { udid: '9A271FFAZ00K4M', name: 'Moto G54 · slot 9', platform: 'android', tags: ['us-east', 'slot-row-3'], state: 'error', osVersion: '14', productType: 'motorola g54' },
    { udid: 'ZY22K7PLMN', name: 'Redmi Note 12 · slot 10', platform: 'android', tags: ['us-east', 'slot-row-3'], state: 'online', osVersion: '13', productType: '23021RAAEG' },
    { udid: 'ZY22K7PLMO', name: 'Redmi Note 12 · slot 11', platform: 'android', tags: ['posting', 'slot-row-3'], state: 'online', osVersion: '13', productType: '23021RAAEG' },
    { udid: 'ZY22K7PLMP', name: 'Redmi Note 12 · slot 12', platform: 'android', tags: ['spare', 'slot-row-3'], state: 'disabled', osVersion: '13', productType: '23021RAAEG' },
];

export function mockDeviceSeeds(): DeviceSeed[] {
    return DEVICE_SEEDS.map((seed) => ({ ...seed, tags: [...seed.tags] }));
}

export function mockRegisteredDevices(): RegisteredDevice[] {
    return DEVICE_SEEDS.map((seed) => {
        const attached = seed.state !== 'offline' && seed.state !== 'disabled';
        const base: RegisteredDevice = {
            udid: seed.udid,
            name: seed.name,
            platform: seed.platform,
            osVersion: seed.osVersion,
            productType: seed.productType,
            tags: [...seed.tags],
            hasPasscode: seed.platform === 'ios',
            pluginData: { 'com.git-agni.tiktok': { handle: `@acct_${seed.udid.slice(-4).toLowerCase()}` } },
            connected: attached
                ? { udid: seed.udid, name: seed.name, platform: seed.platform, osVersion: seed.osVersion, productType: seed.productType }
                : null,
        };
        if (seed.platform === 'ios') {
            base.driver = 'wda';
            base.wdaLocalPort = 8100 + DEVICE_SEEDS.indexOf(seed);
            base.coordinateProfile = seed.productType === 'iPhone10,4' ? 'iphone8' : 'iphone11';
        } else {
            base.driver = 'a11y-bridge';
            base.android = { serial: seed.udid, bridgeUrl: `http://127.0.0.1:${18_300 + DEVICE_SEEDS.indexOf(seed)}`, bridgeToken: 'never-render-me' };
        }
        if (seed.state === 'disabled') base.disabled = true;
        return base;
    });
}

const CONNECTION_BY_STATE: Record<FleetDevice['state'], Pick<DeviceConnectionStatus, 'physical' | 'wda' | 'message'>> = {
    online: { physical: 'connected', wda: 'ready', message: 'WDA is ready' },
    busy: { physical: 'connected', wda: 'ready', message: 'WDA is ready' },
    offline: { physical: 'disconnected', wda: 'disconnected', message: 'Not attached — check the cable' },
    disabled: { physical: 'disconnected', wda: 'disconnected', message: 'Device is deactivated' },
    error: { physical: 'connected', wda: 'error', message: 'The bridge stopped responding after 3 retries' },
};

export function mockConnection(seed: DeviceSeed, now: number): DeviceConnectionStatus {
    const base = CONNECTION_BY_STATE[seed.state];
    return {
        udid: seed.udid,
        physical: base.physical,
        wda: base.wda,
        appium: seed.platform === 'ios' ? 'unavailable' : 'unavailable',
        managed: true,
        message: base.message,
        retryCount: seed.state === 'error' ? 3 : 0,
        updatedAt: new Date(now - 4_000).toISOString(),
    };
}

export function mockConnectionForState(state: FleetDevice['state']): Pick<DeviceConnectionStatus, 'physical' | 'wda' | 'message'> {
    return { ...CONNECTION_BY_STATE[state] };
}

/* ------------------------------------------------------------- schedules */

const TIMINGS: ScheduleTiming[] = [
    { kind: 'daily', localTime: '09:30', timezone: 'America/New_York' },
    { kind: 'daily', localTime: '14:00', timezone: 'America/New_York' },
    { kind: 'weekly', localTime: '18:00', timezone: 'Europe/London', weekdays: [1, 3, 5] },
    { kind: 'once', runAt: '' }, // filled in with a real time below
    { kind: 'now' },
];

export function mockSchedules(now: number): ScheduleRow[] {
    const random = seededRandom(7);
    const rows: ScheduleRow[] = [];
    const statuses: ScheduleRow['status'][] = ['active', 'active', 'active', 'paused', 'completed', 'cancelled'];

    DEVICE_SEEDS.forEach((seed, index) => {
        const count = seed.state === 'disabled' ? 1 : 2;
        for (let n = 0; n < count; n += 1) {
            const timingTemplate = TIMINGS[(index + n) % TIMINGS.length]!;
            const timing: ScheduleTiming =
                timingTemplate.kind === 'once'
                    ? { kind: 'once', runAt: new Date(now + 3_600_000 * (1 + n)).toISOString() }
                    : timingTemplate;
            const status = statuses[(index + n) % statuses.length]!;
            const plugin = index % 3 === 0 ? MOCK_PLUGINS[1]! : MOCK_PLUGINS[0]!;
            const task = plugin.tasks[n % plugin.tasks.length]!;
            rows.push({
                id: `sch_${String(index).padStart(2, '0')}${n}`,
                deviceUdid: seed.udid,
                pluginId: plugin.id,
                taskType: task.type,
                taskVersion: task.version,
                payload: { minutes: 8 + Math.floor(random() * 12) },
                timing,
                status,
                runWindowMinutes: 30,
                nextRunAt:
                    status === 'active'
                        ? new Date(now + 900_000 + index * 600_000 + n * 3_600_000).toISOString()
                        : null,
                createdAt: new Date(now - 86_400_000 * (2 + index)).toISOString(),
                updatedAt: new Date(now - 3_600_000 * (1 + n)).toISOString(),
            });
        }
    });
    return rows;
}

/* ------------------------------------------------------------ executions */

/**
 * The history. `running` and `queued` are deliberately absent: an active
 * execution is what makes a device busy, so those only exist on the busy
 * devices below. Otherwise an "online" device would carry a queued run and the
 * `409` guard would fire on a card that says it is idle.
 */
const EXECUTION_STATUSES: ExecutionStatus[] = [
    'succeeded',
    'failed',
    'succeeded',
    'stopped',
    'succeeded',
    'skipped',
    'cancelled',
    'failed',
];

const FAILURES = [
    'TikTok did not reach the feed after 3 attempts',
    'The bridge stopped responding mid-run',
    'Upload timed out waiting for the post confirmation',
];

export function mockExecutions(now: number, schedules: ScheduleRow[]): ExecutionRow[] {
    const random = seededRandom(19);
    const rows: ExecutionRow[] = [];
    const busyUdids = DEVICE_SEEDS.filter((seed) => seed.state === 'busy').map((seed) => seed.udid);

    // One live run per busy device, so the Fleet cards have something to show,
    // plus one queued behind it — the queue screen needs that status to exist.
    busyUdids.forEach((udid, index) => {
        const schedule = schedules.find((row) => row.deviceUdid === udid)!;
        const startedAt = now - (120_000 + index * 90_000);
        rows.push(
            makeExecution({
                id: `exe_live_${index}`,
                schedule,
                status: 'running',
                now,
                scheduledFor: startedAt - 4_000,
                startedAt,
                finishedAt: null,
                error: null,
            }),
        );
        rows.push(
            makeExecution({
                id: `exe_queued_${index}`,
                schedule,
                status: 'queued',
                now,
                scheduledFor: now + 1_800_000,
                startedAt: null,
                finishedAt: null,
                error: null,
            }),
        );
    });

    // Then a history that covers every status.
    for (let index = 0; index < 46; index += 1) {
        const schedule = schedules[(index * 3) % schedules.length]!;
        const status = EXECUTION_STATUSES[index % EXECUTION_STATUSES.length]!;
        const scheduledFor = now - 1_800_000 * (index + 1);
        const startedAt = scheduledFor + 4_000;
        const finishedAt = startedAt + 60_000 + Math.floor(random() * 900_000);
        rows.push(
            makeExecution({
                id: `exe_${String(index).padStart(3, '0')}`,
                schedule,
                status,
                now,
                scheduledFor,
                startedAt,
                finishedAt,
                error: status === 'failed' ? FAILURES[index % FAILURES.length]! : null,
            }),
        );
    }

    // Newest first, then renumber so the id order matches the sort order —
    // that is what makes `?before=` a stable keyset cursor (gap 9).
    rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const total = rows.length;
    rows.forEach((row, index) => {
        row.id = executionId(total - index);
    });
    return rows;
}

function makeExecution(input: {
    id: string;
    schedule: ScheduleRow;
    status: ExecutionStatus;
    now: number;
    scheduledFor: number;
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
}): ExecutionRow {
    const { id, schedule, status, scheduledFor, startedAt, finishedAt, error } = input;
    return {
        id,
        scheduleId: schedule.id,
        deviceUdid: schedule.deviceUdid,
        pluginId: schedule.pluginId,
        taskType: schedule.taskType,
        taskVersion: schedule.taskVersion,
        payload: schedule.payload,
        scheduledFor: new Date(scheduledFor).toISOString(),
        deadlineAt: new Date(scheduledFor + 1_800_000).toISOString(),
        status,
        queueJobId: `job_${id}`,
        startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
        finishedAt: finishedAt === null ? null : new Date(finishedAt).toISOString(),
        exitCode: status === 'succeeded' ? 0 : status === 'failed' ? 1 : null,
        error,
        stopRequestedAt: status === 'stopped' ? new Date((finishedAt ?? scheduledFor) - 5_000).toISOString() : null,
        createdAt: new Date(scheduledFor - 500).toISOString(),
        updatedAt: new Date(finishedAt ?? startedAt ?? scheduledFor).toISOString(),
    };
}

/** Ids sort in reverse-chronological order, so `before` walks backwards. */
export function executionId(sequence: number): string {
    return `exe_${String(sequence).padStart(5, '0')}`;
}

export function mockLogs(execution: ExecutionRow): string[] {
    const lines = [
        `[${execution.createdAt}] queued ${execution.pluginId}/${execution.taskType} v${execution.taskVersion}`,
        `[${execution.startedAt ?? execution.createdAt}] driver session opened`,
        '[wda] launching TikTok',
        '[wda] feed reached',
    ];
    for (let n = 0; n < 40; n += 1) lines.push(`[wda] scroll ${n + 1} · dwell ${1_400 + n * 37}ms`);
    if (execution.status === 'failed') lines.push(`[error] ${execution.error ?? 'failed'}`, '[error] attempt 3 of 3 exhausted');
    if (execution.status === 'succeeded') lines.push('[wda] session closed', '[done] exit 0');
    return lines;
}

/* --------------------------------------------------------------- content */

const CAPTIONS = [
    'day 14 of building the farm',
    'the cable management arc is real',
    'twelve phones, one mac, zero regrets',
    'what 12 hours of doomscroll data looks like',
    'setting up slot row 3',
    'the 2am alert that started all of this',
];

export function mockContentQueue(now: number): ContentQueueItem[] {
    return CAPTIONS.map((caption, index) => ({
        id: `cnt_${String(index).padStart(2, '0')}`,
        status: index < 4 ? 'planned' : index === 4 ? 'approved' : 'skipped',
        deviceUdid: DEVICE_SEEDS[(index * 2) % DEVICE_SEEDS.length]!.udid,
        caption,
        assetId: `ast_${String(index).padStart(2, '0')}`,
        thumbnailUrl: `/api/assets/ast_${String(index).padStart(2, '0')}/thumbnail`,
        plannedFor: new Date(now + 3_600_000 * (6 + index * 8)).toISOString(),
        scheduleId: index === 4 ? 'sch_040' : null,
    }));
}
