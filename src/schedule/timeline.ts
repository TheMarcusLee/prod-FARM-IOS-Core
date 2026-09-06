/**
 * The Schedule timeline model. One phone is one track, one piece of work is one clip, and the
 * playhead is now. Everything here is pure: the route builds the input from the scheduler, the
 * device registry and the drip planner, and both the server's first frame and the JSON the page
 * script polls come out of `buildTimeline`. See docs/design/backline.md.
 */

import type { ExecutionRow, ScheduleRow } from '../database/schema.js';
import type { RegisteredDevice } from '../devices/registry.js';
import type { JsonObject } from '../types.js';
import {
    assignAccountColours, collectAccounts, colourFor, deviceAccounts, type AccountColour,
} from './accounts.js';

/** How the page names a span of time. `custom` is an explicit from/to pair. */
export type TimelineRange = 'today' | 'tomorrow' | 'week' | 'custom';

export const RANGE_LABELS: Record<Exclude<TimelineRange, 'custom'>, string> = {
    today: 'Today', tomorrow: 'Tomorrow', week: '7 days',
};

export type ClipStatus = 'planned' | 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'cancelled';

export interface TimelineClip {
    /** Execution id, or `plan:<id>` for a drip post that has not been materialised yet. */
    id: string;
    deviceUdid: string;
    /** 'execution' can be stopped or retried; 'plan' can only be skipped. */
    kind: 'execution' | 'plan';
    status: ClipStatus;
    account: string | null;
    /** Palette entry, so the client never re-derives identity colours. */
    colour: AccountColour;
    /**
     * The palette entry's name — 'sage', 'lilac', … — for a client that keeps its own copy of the
     * palette rather than painting with hex from the wire. The phone app reads this one.
     */
    accountColor: string;
    startsAt: string;
    endsAt: string;
    /** Local wall clock of `startsAt`, HH:MM — the first half of a clip's label. */
    time: string;
    /** The second half: the caption, the title, or the task's own summary. */
    title: string;
    /** One sentence for the popover: what this is and where it stands. */
    summary: string;
    scheduleId: string | null;
    /** Whether that schedule is paused, so the popover offers Resume rather than Pause. */
    schedulePaused: boolean;
    /** 0…1 while running, absent otherwise. */
    progress?: number;
    /** Set on the clip that retries a failed one; the failed clip carries `retriedBy`. */
    retryOf?: string;
    retriedBy?: string;
    error?: string;
    taskLabel: string;
}

export interface TimelineTrack {
    deviceUdid: string;
    name: string;
    /** The operator's handle for the slot: 01 … 99. */
    slot: string;
    state: 'online' | 'offline' | 'disabled';
    accounts: string[];
    clips: TimelineClip[];
}

export interface TimelineAccount { account: string; colour: AccountColour }

export interface TimelineEvent {
    at: string;
    time: string;
    title: string;
    severity: 'info' | 'warning' | 'error';
    deviceName?: string;
}

export interface PlannerStatus {
    /** Absent when the drip planner has no rules at all. */
    rules: number;
    enabled: number;
    nextRunAt: string | null;
    /** Rules that will under-post, said in words. */
    warnings: string[];
}

export interface TimelinePayload {
    from: string;
    to: string;
    now: string;
    range: TimelineRange;
    /** "Tonight", "Tomorrow", "The next 7 days" — the page's own heading. */
    heading: string;
    /** Hour boundaries the ruler prints, oldest first. */
    ticks: Array<{ at: string; label: string }>;
    accounts: TimelineAccount[];
    tracks: TimelineTrack[];
    counts: { posts: number; accounts: number; needsYou: number };
    recent: TimelineEvent[];
    planner: PlannerStatus | null;
}

/** A drip plan joined to the rule that made it — everything the timeline needs from the planner. */
export interface PlanView {
    id: string;
    ruleId: string;
    scheduleId: string | null;
    deviceUdid: string;
    account: string;
    plannedFor: Date;
    /** The rule's own destination, so a clip can say "draft" rather than nothing. */
    destination: string;
    caption?: string | null;
    /** The plan's schedule status when it has one; a skipped plan is not drawn. */
    scheduleStatus?: string | null;
}

export interface TimelineInput {
    from: Date;
    to: Date;
    now: Date;
    range: TimelineRange;
    devices: readonly RegisteredDevice[];
    connected?: ReadonlySet<string>;
    executions: readonly ExecutionRow[];
    schedules: readonly ScheduleRow[];
    plans?: readonly PlanView[];
    recent?: readonly TimelineEvent[];
    planner?: PlannerStatus | null;
    /** Turns a task payload into a human line; the plugin registry supplies it in production. */
    summarize?: (execution: ExecutionRow) => string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Local wall clock, HH:MM. The farm's clock is the operator's clock. */
export function hhmm(at: Date): string {
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** Midnight at the start of the local day `at` falls in. */
export function startOfDay(at: Date): Date {
    const start = new Date(at.getTime());
    start.setHours(0, 0, 0, 0);
    return start;
}

/**
 * The window a named range covers. Every range is whole days, midnight to midnight, so the ruler
 * reads the same whatever the time is and the playhead shows where in the day the farm is.
 */
export function windowForRange(range: Exclude<TimelineRange, 'custom'>, now: Date): { from: Date; to: Date } {
    const midnight = startOfDay(now);
    if (range === 'tomorrow') {
        const from = new Date(midnight.getTime() + DAY_MS);
        return { from, to: new Date(from.getTime() + DAY_MS) };
    }
    if (range === 'week') return { from: midnight, to: new Date(midnight.getTime() + 7 * DAY_MS) };
    return { from: midnight, to: new Date(midnight.getTime() + DAY_MS) };
}

/** "Tonight" is the truthful word for a range that starts in the evening; otherwise say the day. */
export function headingFor(range: TimelineRange, from: Date, now: Date): string {
    if (range === 'week') return 'The next 7 days';
    if (range === 'tomorrow') return `Tomorrow, ${from.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}`;
    const evening = from.getHours() >= 17 || now.getHours() >= 17;
    const day = from.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    return `${evening ? 'Tonight' : 'Today'}, ${day}`;
}

/**
 * Ruler marks across the window. A day (or anything up to 36 hours) is marked every two hours as
 * HH:MM; anything longer is marked at each local midnight with the day ("Mon 7"), because hour
 * labels every fourteen hours read as noise. Ticks are what the lane grid lines follow too.
 */
export function rulerTicks(from: Date, to: Date): Array<{ at: string; label: string }> {
    const span = Math.max(HOUR_MS, to.getTime() - from.getTime());
    const ticks: Array<{ at: string; label: string }> = [];
    if (span <= 36 * HOUR_MS) {
        const hours = Math.round(span / HOUR_MS);
        const step = Math.max(1, Math.ceil(hours / 12));
        for (let hour = 0; hour <= hours; hour += step) {
            const at = new Date(from.getTime() + hour * HOUR_MS);
            ticks.push({ at: at.toISOString(), label: hhmm(at) });
        }
        return ticks;
    }
    // Walk local midnights so DST changes never drift the marks off the day boundary.
    for (let day = startOfDay(from); day.getTime() <= to.getTime() + 1; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
        ticks.push({ at: day.toISOString(), label: day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) });
    }
    return ticks;
}

function payloadString(payload: JsonObject | undefined, key: string): string | null {
    const value = payload?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function overlaps(start: Date, end: Date, from: Date, to: Date): boolean {
    return end.getTime() > from.getTime() && start.getTime() < to.getTime();
}

/** The words the design's state vocabulary allows for an execution's status. */
function statusWord(status: ClipStatus): string {
    if (status === 'failed') return 'needs you';
    if (status === 'planned') return 'planned';
    return status;
}

function clipSummary(clip: Pick<TimelineClip, 'status' | 'taskLabel' | 'account' | 'time' | 'error'>): string {
    const where = clip.account ? ` to ${clip.account}` : '';
    if (clip.status === 'running') return `${clip.taskLabel}${where}, running since ${clip.time}.`;
    if (clip.status === 'failed') return clip.error ? `${clip.taskLabel} failed. ${clip.error}` : `${clip.taskLabel} failed at ${clip.time}.`;
    if (clip.status === 'succeeded') return `${clip.taskLabel}${where} finished at ${clip.time}.`;
    if (clip.status === 'cancelled' || clip.status === 'stopped') return `${clip.taskLabel} was ${clip.status} at ${clip.time}.`;
    if (clip.status === 'planned') return `${clip.taskLabel}${where}, planned for ${clip.time}.`;
    return `${clip.taskLabel}${where}, queued for ${clip.time}.`;
}

/**
 * A retry is a *new* execution on the same schedule, scheduled after the one that failed. Pair each
 * failed clip with the earliest later attempt so the timeline can draw the dashed "retry 19:30" clip
 * the operator is really asking about when they see red.
 */
export function pairRetries(clips: TimelineClip[]): void {
    const byDevice = new Map<string, TimelineClip[]>();
    for (const clip of clips) {
        if (clip.kind !== 'execution') continue;
        const key = `${clip.deviceUdid} ${clip.scheduleId ?? clip.id}`;
        const list = byDevice.get(key) ?? [];
        list.push(clip);
        byDevice.set(key, list);
    }
    for (const list of byDevice.values()) {
        if (list.length < 2) continue;
        const ordered = [...list].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        for (const [index, clip] of ordered.entries()) {
            if (clip.status !== 'failed' && clip.status !== 'stopped') continue;
            const next = ordered.slice(index + 1).find(({ status }) => status === 'queued' || status === 'running');
            if (!next || next.retryOf) continue;
            next.retryOf = clip.id;
            clip.retriedBy = next.id;
        }
    }
}

export function buildTimeline(input: TimelineInput): TimelinePayload {
    const { from, to, now } = input;
    const plans = input.plans ?? [];
    const planByScheduleId = new Map<string, PlanView>();
    for (const plan of plans) if (plan.scheduleId) planByScheduleId.set(plan.scheduleId, plan);

    const accounts = collectAccounts(input.devices, plans.map((plan) => plan.account));
    const colours = assignAccountColours(accounts);
    const scheduleById = new Map(input.schedules.map((schedule) => [schedule.id, schedule]));

    const active = input.devices.filter((device) => !device.disabled);
    const tracks: TimelineTrack[] = active.map((device, index) => ({
        deviceUdid: device.udid,
        name: device.name,
        slot: String(index + 1).padStart(2, '0'),
        state: device.disabled ? 'disabled' : input.connected?.has(device.udid) === false ? 'offline' : 'online',
        accounts: deviceAccounts(device),
        clips: [],
    }));
    const trackByUdid = new Map(tracks.map((track) => [track.deviceUdid, track]));

    const seenSchedules = new Set<string>();
    for (const execution of input.executions) {
        const track = trackByUdid.get(execution.deviceUdid);
        if (!track) continue;
        const start = execution.startedAt ?? execution.scheduledFor;
        const end = execution.finishedAt ?? execution.deadlineAt;
        if (!overlaps(start, end, from, to)) continue;
        if (execution.scheduleId) seenSchedules.add(execution.scheduleId);
        const plan = execution.scheduleId ? planByScheduleId.get(execution.scheduleId) : undefined;
        const account = payloadString(execution.payload, 'account') ?? plan?.account ?? null;
        const taskLabel = input.summarize?.(execution) ?? `${execution.taskType} · ${execution.pluginId}`;
        const title = payloadString(execution.payload, 'caption') ?? plan?.caption?.trim() ?? taskLabel;
        const status = execution.status as ClipStatus;
        const schedule = execution.scheduleId ? scheduleById.get(execution.scheduleId) : undefined;
        const clip: TimelineClip = {
            id: execution.id,
            deviceUdid: execution.deviceUdid,
            kind: 'execution',
            status,
            account,
            colour: colourFor(colours, account),
            accountColor: colourFor(colours, account).name,
            startsAt: start.toISOString(),
            endsAt: end.toISOString(),
            time: hhmm(start),
            title: status === 'running' ? 'posting' : status === 'failed' ? 'failed' : `${hhmm(start)} ${title}`,
            summary: '',
            scheduleId: execution.scheduleId,
            schedulePaused: schedule?.status === 'paused',
            taskLabel,
            ...(execution.error ? { error: execution.error } : {}),
        };
        if (status === 'running') {
            const total = Math.max(MINUTE_MS, end.getTime() - start.getTime());
            clip.progress = Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / total));
        }
        clip.summary = clipSummary(clip);
        track.clips.push(clip);
    }

    for (const plan of plans) {
        const track = trackByUdid.get(plan.deviceUdid);
        if (!track) continue;
        if (plan.scheduleId && seenSchedules.has(plan.scheduleId)) continue;
        if (plan.scheduleStatus === 'cancelled') continue;
        const start = plan.plannedFor;
        const end = new Date(start.getTime() + 15 * MINUTE_MS);
        if (!overlaps(start, end, from, to)) continue;
        const taskLabel = `Drip post (${plan.destination})`;
        const clip: TimelineClip = {
            id: `plan:${plan.id}`,
            deviceUdid: plan.deviceUdid,
            kind: 'plan',
            status: 'planned',
            account: plan.account,
            colour: colourFor(colours, plan.account),
            accountColor: colourFor(colours, plan.account).name,
            startsAt: start.toISOString(),
            endsAt: end.toISOString(),
            time: hhmm(start),
            title: `${hhmm(start)} ${plan.caption?.trim() || plan.account}`,
            summary: '',
            scheduleId: plan.scheduleId,
            schedulePaused: plan.scheduleStatus === 'paused',
            taskLabel,
        };
        clip.summary = clipSummary(clip);
        track.clips.push(clip);
    }

    for (const track of tracks) {
        track.clips.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        pairRetries(track.clips);
    }

    const drawn = tracks.flatMap((track) => track.clips);
    const usedAccounts = accounts.filter((account) => drawn.some((clip) => clip.account === account));
    return {
        from: from.toISOString(),
        to: to.toISOString(),
        now: now.toISOString(),
        range: input.range,
        heading: headingFor(input.range, from, now),
        ticks: rulerTicks(from, to),
        accounts: usedAccounts.map((account) => ({ account, colour: colourFor(colours, account) })),
        tracks,
        counts: {
            posts: drawn.filter(({ status }) => status !== 'cancelled').length,
            accounts: usedAccounts.length,
            needsYou: drawn.filter(({ status }) => status === 'failed').length,
        },
        recent: [...(input.recent ?? [])],
        planner: input.planner ?? null,
    };
}

/** Where a clip sits in its lane, as percentages of the window. Shared by the server and the client. */
export function clipGeometry(clip: Pick<TimelineClip, 'startsAt' | 'endsAt'>, from: string, to: string): { left: number; width: number } {
    const start = Date.parse(from);
    const span = Math.max(1, Date.parse(to) - start);
    const left = ((Date.parse(clip.startsAt) - start) / span) * 100;
    // A one-minute task still has to be clickable, and a clip that runs past the
    // window's end is clamped rather than overflowing the lane.
    const width = Math.max(3.2, ((Date.parse(clip.endsAt) - Date.parse(clip.startsAt)) / span) * 100);
    const clampedLeft = Math.max(0, Math.min(left, 100));
    return { left: clampedLeft, width: Math.min(width, 100 - clampedLeft) };
}

/** The playhead's position, or null when now is outside the window. */
export function playheadPercent(now: string, from: string, to: string): number | null {
    const start = Date.parse(from);
    const span = Math.max(1, Date.parse(to) - start);
    const at = ((Date.parse(now) - start) / span) * 100;
    return at < 0 || at > 100 ? null : at;
}

export { statusWord };
