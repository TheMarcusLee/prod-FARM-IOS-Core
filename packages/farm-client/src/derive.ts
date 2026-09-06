/**
 * Derivations the app needs when the farm has not given them to it.
 *
 * `/api/fleet/summary` already returns a derived `state` (gap 11). This module
 * exists for the fallback path — an older farm without the fleet endpoint,
 * where the app has only `/api/devices` and per-device connection rows — and
 * for the coordinate mapping, which is client-side by definition.
 */

import { ACCOUNT_COLORS } from './models';
import type {
    AccountColor,
    DeviceConnectionStatus,
    DeviceState,
    ExecutionRow,
    FleetCounts,
    FleetDevice,
    Platform,
    RegisteredDevice,
    RemoteAction,
    ScheduleRow,
    ScheduleTimeline,
    TimelineClip,
    TimelineTrack,
} from './models';

/**
 * `disabled` wins over everything: a disabled device also reports
 * `connected: null`, and rendering it as "unplugged" is a lie the operator will
 * chase with a cable.
 */
export function deriveDeviceState(
    device: Pick<RegisteredDevice, 'disabled' | 'connected'>,
    connection?: Pick<DeviceConnectionStatus, 'physical' | 'wda'> | null,
    hasActiveExecution = false,
): DeviceState {
    if (device.disabled) return 'disabled';
    if (connection?.wda === 'error') return 'error';
    if (connection ? connection.physical === 'disconnected' : device.connected === null) return 'offline';
    if (hasActiveExecution) return 'busy';
    return 'online';
}

export function countStates(devices: Pick<FleetDevice, 'state'>[]): FleetCounts {
    const counts: FleetCounts = { total: devices.length, online: 0, busy: 0, offline: 0, disabled: 0, error: 0 };
    for (const device of devices) counts[device.state] += 1;
    return counts;
}

export function platformOf(device: { platform?: Platform }): Platform {
    // Absent means iOS (`src/types.ts`).
    return device.platform ?? 'ios';
}

export function deviceTags(devices: { tags?: string[] }[]): string[] {
    const seen = new Set<string>();
    for (const device of devices) for (const tag of device.tags ?? []) seen.add(tag);
    return [...seen].sort((a, b) => a.localeCompare(b));
}

/* -------------------------------------------------- coordinate mapping */

export interface Rect {
    width: number;
    height: number;
}

/**
 * Map a touch inside an `resizeMode: 'contain'` image view back to device
 * coordinates. `screenSize` is points from `remote/info`, which is what
 * `/remote/action` expects — the `scale` factor is not applied.
 *
 * Returns `null` when the touch landed in the letterbox rather than on the
 * screen, so the caller can ignore it rather than tap the edge.
 */
export function mapTouchToDevice(
    touch: { x: number; y: number },
    view: Rect,
    screenSize: Rect,
): { x: number; y: number } | null {
    if (view.width <= 0 || view.height <= 0 || screenSize.width <= 0 || screenSize.height <= 0) return null;

    const scale = Math.min(view.width / screenSize.width, view.height / screenSize.height);
    const renderedWidth = screenSize.width * scale;
    const renderedHeight = screenSize.height * scale;
    const offsetX = (view.width - renderedWidth) / 2;
    const offsetY = (view.height - renderedHeight) / 2;

    const x = (touch.x - offsetX) / scale;
    const y = (touch.y - offsetY) / scale;
    if (x < 0 || y < 0 || x > screenSize.width || y > screenSize.height) return null;

    return { x: Math.round(x), y: Math.round(y) };
}

/** A drag becomes a swipe; below the threshold it is a tap the finger wobbled on. */
export function gestureToAction(
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
    tapThresholdPx = 12,
): RemoteAction {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance < tapThresholdPx) return { type: 'tap', x: from.x, y: from.y };
    return {
        type: 'swipe',
        startX: from.x,
        startY: from.y,
        endX: to.x,
        endY: to.y,
        // Clamp: a 4 ms swipe is a flick the driver cannot reproduce, and a
        // 10 s one holds the WDA session open for no reason.
        durationMs: Math.min(3_000, Math.max(50, Math.round(durationMs))),
    };
}

/** `back` and `text` are Android-only; the farm answers 400 otherwise. */
export function isActionSupported(action: RemoteAction['type'], platform: Platform): boolean {
    // `power` works on both: keyevent 26 on Android, the WDA lock on iOS.
    if (action === 'back' || action === 'recents' || action === 'text') return platform === 'android';
    return true;
}

/* ---------------------------------------------------- wall identity + state */

/**
 * The operator's handle for a slot: 01–99, from the device's position in the
 * fleet list. The farm has no such field — the order it sends devices in *is*
 * the wall order, and the number is the operator's way of saying "that one".
 */
export function deviceNumber(index: number): string {
    return String(index + 1).padStart(2, '0');
}

/**
 * The wall footer already carries the number chip, so a name that repeats it
 * ("iPhone 8 · slot 1") would say the same thing twice. Strip only that exact
 * suffix; a name the operator typed is otherwise rendered verbatim.
 */
export function deviceDisplayName(name: string): string {
    return name.replace(/\s*·\s*slot\s*\d+\s*$/i, '').trim() || name;
}

/**
 * The word under a tile. `docs/design/backline.md` fixes this vocabulary:
 * online, posting, busy, offline, disabled, error. `posting` is `busy` with a
 * post task on it — the distinction the operator actually cares about.
 */
export type WallState = 'online' | 'posting' | 'busy' | 'offline' | 'disabled' | 'error';

export function wallState(device: Pick<FleetDevice, 'state' | 'currentExecution'>): WallState {
    if (device.state !== 'busy') return device.state;
    return isPostTask(device.currentExecution?.taskType) ? 'posting' : 'busy';
}

/** `post`, `post-clip`, `tiktok.post` — anything whose task type is a post. */
export function isPostTask(taskType: string | undefined | null): boolean {
    return typeof taskType === 'string' && /(^|[.\-_])post/i.test(taskType);
}

export interface WallSummary {
    total: number;
    /** Plugged in and not deactivated — what "11 of 12 live" counts. */
    live: number;
    posting: number;
    needsYou: number;
}

export function wallSummary(devices: Pick<FleetDevice, 'state' | 'currentExecution'>[]): WallSummary {
    let live = 0;
    let posting = 0;
    let needsYou = 0;
    for (const device of devices) {
        const state = wallState(device);
        if (state !== 'offline' && state !== 'disabled') live += 1;
        if (state === 'posting') posting += 1;
        if (state === 'error') needsYou += 1;
    }
    return { total: devices.length, live, posting, needsYou };
}

/* --------------------------------------------------------------- timeline */

/** Stable account colour for a slot in the registration order. */
export function accountColorForIndex(index: number): AccountColor {
    return ACCOUNT_COLORS[index % ACCOUNT_COLORS.length]!;
}

/**
 * Every account the fleet knows, in registration order: device by device in the order the farm
 * lists them, then each device's accounts in the order its plugins list them. The dashboard does
 * exactly this in `src/schedule/accounts.ts` (`collectAccounts` + `assignAccountColours`), so an
 * account is the same colour on the wall, on the desktop timeline and on the phone.
 */
export function assignAccountColors(devices: Pick<FleetDevice, 'accounts'>[]): Map<string, AccountColor> {
    const colors = new Map<string, AccountColor>();
    for (const device of devices) {
        for (const account of device.accounts ?? []) {
            const name = account.trim();
            if (!name || colors.has(name)) continue;
            colors.set(name, accountColorForIndex(colors.size));
        }
    }
    return colors;
}

/** A run with no deadline still occupies a block; this is how wide it is. */
const DEFAULT_CLIP_MS = 30 * 60_000;

/** Local wall clock, HH:MM — the farm's `hhmm`, on the phone's own clock. */
function hhmm(at: number): string {
    const stamp = new Date(at);
    return `${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
}

/**
 * The fallback for a farm without `GET /api/schedule/timeline`: the same shape,
 * composed from the schedules and executions the app already has. It is not a
 * second source of truth — when the endpoint answers, this is not called.
 *
 * Clips are coloured by *account*, in registration order, not by the phone's position in the
 * fleet: a phone is not an identity, and two phones posting the same handle must read as one
 * colour here just as they do on the dashboard.
 */
export function composeTimeline(input: {
    devices: Pick<FleetDevice, 'udid' | 'name' | 'accounts'>[];
    schedules: ScheduleRow[];
    executions: ExecutionRow[];
    from: string;
    to: string;
    now?: string;
}): ScheduleTimeline {
    const fromMs = Date.parse(input.from);
    const toMs = Date.parse(input.to);
    const overlaps = (start: number, end: number) => end > fromMs && start < toMs;
    const colors = assignAccountColors(input.devices);
    /** Work with no account of its own belongs to the phone's first handle, if it has one. */
    const neutral: AccountColor = 'slate';

    const tracks: TimelineTrack[] = input.devices.map((device, index) => {
        const account = (device.accounts ?? [])[0]?.trim() || null;
        const color = account ? colors.get(account) ?? neutral : neutral;
        const clips: TimelineClip[] = [];

        for (const row of input.executions) {
            if (row.deviceUdid !== device.udid) continue;
            const start = Date.parse(row.startedAt ?? row.scheduledFor ?? row.createdAt);
            if (Number.isNaN(start)) continue;
            const end = row.finishedAt
                ? Date.parse(row.finishedAt)
                : Math.max(start + DEFAULT_CLIP_MS, row.deadlineAt ? Date.parse(row.deadlineAt) : 0);
            if (!overlaps(start, end)) continue;
            clips.push({
                id: row.id,
                deviceUdid: device.udid,
                kind: 'execution',
                startsAt: new Date(start).toISOString(),
                endsAt: new Date(end).toISOString(),
                status: row.status,
                account,
                time: hhmm(start),
                title: clipLabel(row.taskType),
                accountColor: color,
            });
        }

        for (const row of input.schedules) {
            if (row.deviceUdid !== device.udid || !row.nextRunAt) continue;
            if (row.status !== 'active' && row.status !== 'paused') continue;
            const start = Date.parse(row.nextRunAt);
            if (Number.isNaN(start)) continue;
            const end = start + (row.runWindowMinutes ?? 30) * 60_000;
            if (!overlaps(start, end)) continue;
            clips.push({
                id: `plan:${row.id}`,
                deviceUdid: device.udid,
                kind: 'plan',
                startsAt: new Date(start).toISOString(),
                endsAt: new Date(end).toISOString(),
                status: row.status,
                account,
                time: hhmm(start),
                title: clipLabel(row.taskType),
                accountColor: color,
            });
        }

        clips.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
        return { deviceUdid: device.udid, slot: deviceNumber(index), name: deviceDisplayName(device.name), clips };
    });

    return { tracks, now: input.now ?? new Date().toISOString() };
}

/** "doomscroll" → "Doomscroll". Task types are the farm's ids, not prose. */
export function clipLabel(taskType: string): string {
    const words = taskType.replace(/[._-]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}
