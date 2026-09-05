/**
 * The Schedule page and the one endpoint behind it. Everything the timeline draws — executions,
 * schedules, drip plans, recent events — is gathered here and turned into the pure model in
 * `src/schedule/timeline.ts`, so the server's first frame and the page script's 30-second refresh
 * are the same data rendered twice rather than two different truths.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExecutionRow, ScheduleRow } from '../../database/schema.js';
import { connectedFleetUdids } from '../../fleet/connectivity.js';
import { createEventStore, type EventStore } from '../../fleet/events.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../../devices/registry.js';
import { createContentStore, type ContentStore } from '../../content/store.js';
import type { PluginRegistry } from '../../registry.js';
import type { SchedulerRepository } from '../../scheduler/repository.js';
import { renderSchedulePage } from '../../schedule/page.js';
import {
    buildTimeline, hhmm, windowForRange,
    type PlanView, type PlannerStatus, type TimelineEvent, type TimelinePayload, type TimelineRange,
} from '../../schedule/timeline.js';
import type { RigStatus } from '../../ui/shell.js';

/** Structurally satisfied by CreateAppOptions, so app.ts passes its own options straight through. */
export interface ScheduleRouteOptions {
    scheduler: SchedulerRepository;
    plugins?: PluginRegistry;
    /** Test seams. Production leaves every one of these unset. */
    loadDevices?: () => Promise<RegisteredDevice[]>;
    connectedUdids?: () => Promise<string[]>;
    contentStore?: ContentStore | null;
    events?: EventStore | null;
    now?: () => Date;
    pluginNavHtml?: string;
    authNavHtml?: string;
}

const STATIC_ROOT = fileURLToPath(new URL('../../../static/dashboard/', import.meta.url));

/** How many executions and schedules one timeline read is allowed to pull. */
const READ_LIMIT = 400;
const RECENT_LIMIT = 8;

function parseRange(value: unknown): TimelineRange {
    return value === 'tomorrow' || value === 'week' || value === 'today' ? value : 'today';
}

function parseDate(value: unknown): Date | null {
    if (typeof value !== 'string' || !value) return null;
    const at = new Date(value);
    return Number.isFinite(at.getTime()) ? at : null;
}

/**
 * The drip planner ticks on a fixed interval from process start, which nobody can see. The honest
 * thing to show is the next boundary of that interval, which is what the operator's clock will say.
 */
function nextPlannerRun(now: Date): string | null {
    const minutes = Number(process.env.DRIP_PLANNER_INTERVAL_MINUTES ?? 60);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    const step = minutes * 60_000;
    return new Date(Math.ceil((now.getTime() + 1) / step) * step).toISOString();
}

export async function registerScheduleRoutes(app: FastifyInstance, options: ScheduleRouteOptions): Promise<void> {
    const loadDevices = options.loadDevices ?? loadRegisteredDevices;
    const connectedUdids = options.connectedUdids ?? (() => connectedFleetUdids());
    const clock = options.now ?? (() => new Date());

    let contentStore: ContentStore | null | undefined = options.contentStore;
    const store = (): ContentStore | null => {
        if (contentStore !== undefined) return contentStore;
        try {
            contentStore = createContentStore(options.scheduler.connection.db);
        } catch {
            contentStore = null;
        }
        return contentStore;
    };

    let eventStore: EventStore | null | undefined = options.events;
    const events = (): EventStore | null => {
        if (eventStore !== undefined) return eventStore;
        try {
            eventStore = createEventStore(options.scheduler.connection);
        } catch {
            eventStore = null;
        }
        return eventStore;
    };

    const [pageStyles, pageScript] = await Promise.all([
        readFile(path.join(STATIC_ROOT, 'pages.css'), 'utf8'),
        readFile(path.join(STATIC_ROOT, 'assets/schedule.js'), 'utf8').catch(() => '/* run npm run build:web */'),
    ]);
    const version = `?v=${crypto.createHash('sha1').update(pageStyles + pageScript).digest('base64url').slice(0, 10)}`;

    const asset = (contentType: string, body: string) => {
        const etag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
        return async (request: FastifyRequest, reply: FastifyReply) => {
            const versioned = Boolean((request.query as { v?: string }).v);
            reply.header('cache-control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache').header('etag', etag);
            if (request.headers['if-none-match'] === etag) return reply.code(304).send();
            return reply.type(contentType).send(body);
        };
    };
    app.get('/assets/pages.css', asset('text/css', pageStyles));
    app.get('/assets/schedule.js', asset('text/javascript', pageScript));

    /** A missing or unconfigured database must not blank the page; it shows an empty night instead. */
    const safely = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
        try {
            return await read();
        } catch (error) {
            app.log.debug({ error: String(error) }, 'schedule timeline read failed');
            return fallback;
        }
    };

    const summarize = (execution: ExecutionRow): string => {
        try {
            const definition = options.plugins?.task({
                pluginId: execution.pluginId, taskType: execution.taskType,
                taskVersion: execution.taskVersion, payload: execution.payload,
            });
            if (definition) return definition.summarize(execution.payload);
        } catch { /* plugin uninstalled, or no registry at all */ }
        // The bare task type opens a sentence in the popover, so it is written like one.
        return execution.taskType.charAt(0).toUpperCase() + execution.taskType.slice(1);
    };

    const planViews = async (from: Date, to: Date): Promise<{ plans: PlanView[]; planner: PlannerStatus | null }> => {
        const active = store();
        if (!active) return { plans: [], planner: null };
        const rules = await safely(() => active.listRules(), []);
        if (!rules.length) return { plans: [], planner: null };
        const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
        const rows = await safely(() => active.upcomingPlans(undefined, 500), []);
        const plans = rows.flatMap((row): PlanView[] => {
            const rule = ruleById.get(row.ruleId);
            if (!rule) return [];
            return [{
                id: row.id, ruleId: row.ruleId, scheduleId: row.scheduleId, deviceUdid: rule.deviceUdid,
                account: rule.account, plannedFor: row.plannedFor, destination: rule.destination,
                scheduleStatus: row.status,
            }];
        });
        // Only the handful of plans the operator is actually looking at get their
        // caption read; the label is "19:20 gym pov #3", not "19:20 @farm.two".
        for (const plan of plans) {
            if (plan.plannedFor < from || plan.plannedFor >= to) continue;
            const row = rows.find((entry) => entry.id === plan.id);
            if (!row) continue;
            const item = await safely(() => active.item(row.itemId), null);
            if (item?.caption) plan.caption = item.caption;
        }
        const enabled = rules.filter((rule) => rule.enabled);
        const today = new Date(from.getTime()).toISOString().slice(0, 10);
        const warnings = enabled
            .filter((rule) => !plans.some((plan) => plan.ruleId === rule.id && plan.plannedFor >= from && plan.plannedFor < to))
            .map((rule) => `${rule.account} on ${rule.deviceUdid} has nothing planned in this window`
                + `${rule.lastPlannedDate && rule.lastPlannedDate < today ? `, last planned ${rule.lastPlannedDate}` : ''}.`);
        return {
            plans,
            planner: {
                rules: rules.length, enabled: enabled.length,
                nextRunAt: nextPlannerRun(clock()), warnings,
            },
        };
    };

    const recentEvents = async (devices: readonly RegisteredDevice[]): Promise<TimelineEvent[]> => {
        const names = new Map(devices.map((device) => [device.udid, device.name]));
        const store = events();
        if (store) {
            const rows = await safely(() => store.list({ limit: RECENT_LIMIT }), []);
            if (rows.length) {
                return rows.map((event) => ({
                    at: event.createdAt.toISOString(), time: hhmm(event.createdAt), title: event.title,
                    severity: event.severity,
                    ...(event.deviceUdid && names.has(event.deviceUdid) ? { deviceName: names.get(event.deviceUdid) as string } : {}),
                }));
            }
        }
        const executions = await safely(() => options.scheduler.listExecutions(RECENT_LIMIT), [] as ExecutionRow[]);
        return executions.map((execution) => {
            const at = execution.finishedAt ?? execution.startedAt ?? execution.scheduledFor;
            const severity = execution.status === 'failed' ? 'error' as const
                : execution.status === 'stopped' || execution.status === 'cancelled' ? 'warning' as const : 'info' as const;
            return {
                at: at.toISOString(), time: hhmm(at), severity,
                title: `${summarize(execution)} ${execution.status}${execution.error ? `: ${execution.error}` : ''}`,
                ...(names.has(execution.deviceUdid) ? { deviceName: names.get(execution.deviceUdid) as string } : {}),
            };
        });
    };

    const timeline = async (query: { range?: string; from?: string; to?: string }): Promise<TimelinePayload> => {
        const now = clock();
        const explicitFrom = parseDate(query.from);
        const explicitTo = parseDate(query.to);
        const range: TimelineRange = explicitFrom && explicitTo ? 'custom' : parseRange(query.range);
        const window = range === 'custom'
            ? { from: explicitFrom as Date, to: explicitTo as Date }
            : windowForRange(range, now);

        const [devices, connected, executions, schedules] = await Promise.all([
            safely(() => loadDevices(), [] as RegisteredDevice[]),
            safely(() => connectedUdids(), [] as string[]),
            safely(() => options.scheduler.listExecutions(READ_LIMIT), [] as ExecutionRow[]),
            safely(() => options.scheduler.listSchedules(READ_LIMIT), [] as ScheduleRow[]),
        ]);
        const { plans, planner } = await planViews(window.from, window.to);
        const recent = await recentEvents(devices);
        return buildTimeline({
            ...window, now, range, devices, connected: new Set(connected),
            executions, schedules, plans, recent, planner, summarize,
        });
    };

    const rigStatus = (payload: TimelinePayload): RigStatus => {
        const online = payload.tracks.filter(({ state }) => state === 'online').length;
        return {
            headline: online ? 'Rig running' : 'No phones online',
            ok: online > 0,
            lines: [`${online} of ${payload.tracks.length} phones online`],
        };
    };

    app.get<{ Querystring: { range?: string; from?: string; to?: string } }>('/api/schedule/timeline',
        async (request) => timeline(request.query));

    app.get<{ Querystring: { range?: string } }>('/schedule', async (request, reply) => {
        const payload = await timeline(request.query);
        return reply.type('text/html').send(renderSchedulePage({
            payload, rig: rigStatus(payload), assetVersion: version,
            ...(options.pluginNavHtml ? { pluginNav: options.pluginNavHtml } : {}),
            ...(options.authNavHtml ? { authNav: options.authNavHtml } : {}),
        }));
    });

    // /tasks was the schedules-and-executions list Schedule replaces. Operators
    // have it bookmarked, so it moves rather than disappears.
    app.get('/tasks', async (_request, reply) => reply.redirect('/schedule', 302));
}
