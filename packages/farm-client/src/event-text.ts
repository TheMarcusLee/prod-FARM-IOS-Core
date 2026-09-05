/**
 * Event → human text, written once and shared by the Alerts list, the desktop
 * toast, and the push relay's notification body.
 *
 * The farm sends an operator-facing `title` and a structured `detail` object
 * (`serializeEvent`); there is no prose `message` on the wire. The title is used
 * as-is and the body is composed here from `detail`, together with the grouping
 * and push-worthiness rules the UI needs.
 *
 * Push bodies traverse Expo/APNs/FCM. `pushText()` therefore carries a device
 * *name* and a task name and nothing else — no UDIDs, no handles, no log lines.
 */

import type { EventKind, EventSeverity, FarmEvent } from './models';

export type EventGroup = 'execution' | 'device' | 'schedule' | 'digest' | 'other';

export function eventGroup(kind: string): EventGroup {
    const prefix = kind.split('.')[0];
    if (prefix === 'execution' || prefix === 'device' || prefix === 'schedule' || prefix === 'digest') return prefix;
    return 'other';
}

/** The default severity the farm assigns each kind (`docs/mobile-api.md`). */
export const DEFAULT_SEVERITY: Record<EventKind, EventSeverity> = {
    'execution.started': 'info',
    'execution.retried': 'info',
    'execution.succeeded': 'info',
    'execution.failed': 'error',
    'execution.stopped': 'warning',
    'execution.cancelled': 'info',
    'execution.stuck': 'warning',
    'device.connected': 'info',
    'device.disconnected': 'warning',
    'device.error': 'error',
    'schedule.created': 'info',
    'schedule.paused': 'info',
    'schedule.cancelled': 'info',
    'digest.daily': 'info',
};

/** The four kinds worth waking someone for. */
export const PUSH_WORTHY_KINDS: EventKind[] = [
    'execution.failed',
    'device.disconnected',
    'device.error',
    'execution.stuck',
];

export function isPushWorthy(kind: string): boolean {
    return (PUSH_WORTHY_KINDS as string[]).includes(kind);
}

const SEVERITY_RANK: Record<EventSeverity, number> = { info: 0, warning: 1, error: 2 };

export function severityAtLeast(severity: EventSeverity, minimum: EventSeverity): boolean {
    return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}

const KIND_LABELS: Record<EventKind, string> = {
    'execution.started': 'Run started',
    'execution.retried': 'Run retried',
    'execution.succeeded': 'Run finished',
    'execution.failed': 'Run failed',
    'execution.stopped': 'Run stopped',
    'execution.cancelled': 'Run cancelled',
    'execution.stuck': 'Run stuck',
    'device.connected': 'Device connected',
    'device.disconnected': 'Device disconnected',
    'device.error': 'Device error',
    'schedule.created': 'Schedule created',
    'schedule.paused': 'Schedule paused',
    'schedule.cancelled': 'Schedule cancelled',
    'digest.daily': 'Daily digest',
};

export function kindLabel(kind: string): string {
    return KIND_LABELS[kind as EventKind] ?? kind;
}

export interface EventText {
    title: string;
    body: string;
}

/**
 * `deviceName` is looked up by the caller from the fleet, so the mapping stays
 * pure and the Electron app can reuse it with its own device list.
 */
export function eventText(event: FarmEvent, deviceName?: string): EventText {
    const title = event.title?.trim() || fallbackTitle(event, deviceName);
    return { title, body: bodyFor(event) };
}

function fallbackTitle(event: FarmEvent, deviceName?: string): string {
    const label = kindLabel(event.kind);
    const where = deviceName ?? (event.deviceUdid ? shortUdid(event.deviceUdid) : undefined);
    return where ? `${label} on ${where}` : label;
}

/**
 * `detail` keys are whatever the farm's recorders put there
 * (`src/fleet/scheduler-events.ts`, `src/fleet/device-monitor.ts`,
 * `src/api/routes/fleet.ts`). Everything is read defensively: an older farm, or
 * a kind added later, simply produces no body rather than `undefined` on screen.
 */
function bodyFor(event: FarmEvent): string {
    const detail = event.detail ?? {};
    const error = stringOr(detail.error);
    switch (event.kind) {
        case 'execution.failed': {
            const exitCode = numberOr(detail.exitCode);
            if (error) return exitCode === undefined ? error : `${error} (exit ${exitCode})`;
            return exitCode === undefined ? 'The run failed.' : `The run failed with exit ${exitCode}.`;
        }
        case 'execution.stuck': {
            // The farm only records this once the run is past its deadline, so
            // the interesting number is how long *over* it is. A deadline that
            // reads as being in the future means the clocks disagree; say the
            // plain thing rather than "no progress since its deadline in 59m".
            const overBy = Date.now() - Date.parse(stringOr(detail.deadlineAt));
            return Number.isFinite(overBy) && overBy > 0
                ? `Still running ${formatDuration(overBy)} past its deadline.`
                : 'Still running past its deadline.';
        }
        case 'execution.retried': {
            const attempt = numberOr(detail.attempt);
            return attempt === undefined ? 'The run is being retried.' : `Attempt ${attempt} started.`;
        }
        case 'execution.stopped':
            return error || 'The run was stopped.';
        case 'execution.cancelled':
            return error || 'The run was cancelled before it started.';
        case 'device.error':
            return error || stringOr(detail.message) || 'The device reported an error.';
        case 'device.disconnected':
            return stringOr(detail.message) || 'The device dropped off the bus — check the cable.';
        case 'device.connected':
            return stringOr(detail.message) || 'The device is back.';
        case 'digest.daily':
            return summariseCounters(detail);
        default:
            // The badge already says the kind; repeating it under the title is
            // noise on a list the operator scans.
            return '';
    }
}

/**
 * The notification payload. Deliberately narrower than `eventText` — a push
 * body leaves the tailnet, so it names a device and a task and stops there.
 */
export function pushText(event: FarmEvent, deviceName?: string): EventText {
    const where = deviceName ?? 'a device';
    switch (event.kind) {
        case 'execution.failed':
            return { title: `Run failed on ${where}`, body: 'Open the app to see why.' };
        case 'execution.stuck':
            return { title: `Run stuck on ${where}`, body: 'It has stopped making progress.' };
        case 'device.disconnected':
            return { title: `${where} disconnected`, body: 'Check the cable.' };
        case 'device.error':
            return { title: `${where} reported an error`, body: 'Open the app to see why.' };
        default:
            return { title: kindLabel(event.kind), body: where };
    }
}

/* ------------------------------------------------------------ formatting */

/** `00008030-001A2B3C0E88802E` → `00008030…802E`, for when there is no name. */
export function shortUdid(udid: string): string {
    return udid.length <= 14 ? udid : `${udid.slice(0, 8)}…${udid.slice(-4)}`;
}

export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** "4s ago", "12m ago". Relative time is the only time the operator reads fast. */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
    if (!iso) return '—';
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '—';
    const delta = now - then;
    if (delta < 0) return `in ${formatDuration(-delta)}`;
    if (delta < 5_000) return 'just now';
    return `${formatDuration(delta)} ago`;
}

function numberOr(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOr(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function summariseCounters(data: Record<string, unknown>): string {
    const parts = Object.entries(data)
        .filter(([, value]) => typeof value === 'number')
        .map(([key, value]) => `${String(value)} ${key}`);
    return parts.length ? parts.join(' · ') : 'Nothing notable.';
}
