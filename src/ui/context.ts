/**
 * The chrome every Backline page carries: the sidebar's rig block, the Alerts unread count, the
 * plugin nav entries, the sign-out link and the operator's theme.
 *
 * There is exactly one implementation of it. `createApp` builds a `ShellContext` once and hands it
 * to every route module that renders a page — the Control Center, Schedule, Content, Runbooks and
 * the device pages all call the same `shell(request, page)`. Before this existed each page module
 * wired its own subset, which is why Content and Runbooks said "Rig status unknown" and showed no
 * unread count. See docs/design/backline.md.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { wdaServiceStatuses } from '../fleet/connectivity.js';
import { createEventStore, type EventStore } from '../fleet/events.js';
import type { RegisteredDevice } from '../devices/registry.js';
import type { AuthProvider } from '../plugin.js';
import { acknowledgedMark } from '../push/acks.js';
import type { PluginRegistry } from '../registry.js';
import type { SchedulerRepository } from '../scheduler/repository.js';
import { icon } from './icons.js';
import { STILLS_ONLY_MESSAGE, liveVideoStatus } from '../live/scrcpy.js';
import { rigStatus, type RigFacts } from './rig.js';
import { NAV, escapeHtml, renderShell, type RigStatus, type ShellInput } from './shell.js';
import { readFleet, type FleetRead, type WallSources } from './wall-data.js';

/** Which appearance the operator picked on the Settings page. */
export const THEME_COOKIE = 'bl-theme';

/**
 * What a page renderer produces: everything about the page itself, and nothing about the chrome.
 * The chrome is `shell`'s business, which is the whole point of this module.
 */
export type ShellPage = Omit<ShellInput, 'rig' | 'unreadAlerts' | 'pluginNav' | 'authNav' | 'theme'>;

/** Renders one page through the shell, chrome already filled in. */
export type ShellRenderer = (request: FastifyRequest, page: ShellPage, read?: FleetRead) => Promise<string>;

export interface ShellChrome {
    facts: RigFacts;
    fleet: FleetRead;
    rig: RigStatus;
    unread: number;
    theme: 'auto' | 'light';
}

export interface ShellContextOptions {
    /** Needed to read the acknowledged-alerts mark for this request's token or session. */
    app: FastifyInstance;
    scheduler: SchedulerRepository;
    plugins?: PluginRegistry | null;
    authProvider?: AuthProvider | null;
    /** The event log behind Alerts; when absent it is derived from the scheduler's connection. */
    events?: EventStore | null;
    loadDevices?: () => Promise<RegisteredDevice[]>;
    connectedUdids?: () => Promise<string[]>;
    /** Markup appended to every page's `<head>` — the shell script tag, at its content-hashed URL. */
    head?: () => string;
}

export interface ShellContext {
    /** Plugin nav entries, already rendered as `<a>` elements. */
    readonly pluginNav: string;
    /** The sign-out link, when an auth provider offers one. */
    readonly authNav: string;
    /** The event log, or null on a farm with no database. Lazily resolved and then remembered. */
    events(): EventStore | null;
    unreadAlerts(request: FastifyRequest): Promise<number>;
    theme(request: FastifyRequest): 'auto' | 'light';
    /** Everything the sidebar needs, plus the fleet read it was derived from. */
    chrome(request: FastifyRequest, read?: FleetRead): Promise<ShellChrome>;
    /** The one way a page becomes a document. */
    shell: ShellRenderer;
    /** The same render for a caller that already has the chrome — the Rig page reads its own facts. */
    renderWith(page: ShellPage, chrome: ShellChrome): string;
    /** The sources a page renderer needs to read the fleet the same way the chrome does. */
    wallSources(): WallSources;
}

export function createShellContext(options: ShellContextOptions): ShellContext {
    const { app } = options;

    // A plugin that owns a built-in page (runbooks) already has its entry in NAV.
    const builtIn = new Set(NAV.map((item) => item.href));
    const pluginNav = (options.plugins?.list() ?? [])
        .flatMap((plugin) => plugin.navLinks ?? [])
        .filter((link) => !builtIn.has(link.href))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((link) => `<a href="${escapeHtml(link.href)}">${icon('layers')}${escapeHtml(link.label)}</a>`)
        .join('');

    const logoutPath = options.authProvider?.logoutPath;
    const authNav = logoutPath
        ? `<a class="bl-btn app-logout" href="${escapeHtml(logoutPath)}">${icon('external')}Log out</a>` : '';

    // A farm with no scheduler database simply has no alerts, which is not an error.
    let eventLog: EventStore | null = options.events ?? null;
    const events = (): EventStore | null => {
        if (!eventLog) {
            try {
                if (options.scheduler?.connection) eventLog = createEventStore(options.scheduler.connection);
            } catch { /* no database wired up */ }
        }
        return eventLog;
    };

    const unreadAlerts = async (request: FastifyRequest): Promise<number> => {
        const store = events();
        if (!store) return 0;
        try {
            return await store.countAfter(await acknowledgedMark(app, request) ?? 0);
        } catch { return 0; }
    };

    const theme = (request: FastifyRequest): 'auto' | 'light' =>
        (request.cookies?.[THEME_COOKIE] === 'auto' ? 'auto' : 'light');

    const wallSources = (): WallSources => ({
        scheduler: options.scheduler, events,
        ...(options.loadDevices ? { loadDevices: options.loadDevices } : {}),
        ...(options.connectedUdids ? { connectedUdids: options.connectedUdids } : {}),
    });

    const chrome = async (request: FastifyRequest, read?: FleetRead): Promise<ShellChrome> => {
        const fleet = read ?? await readFleet(wallSources());
        const [statuses, unread] = await Promise.all([
            wdaServiceStatuses().catch(() => [] as Awaited<ReturnType<typeof wdaServiceStatuses>>),
            unreadAlerts(request),
        ]);
        const facts: RigFacts = {
            devices: fleet.devices, connected: fleet.connected, statuses,
            database: Boolean(options.scheduler?.connection),
            running: fleet.executions.filter(({ status }) => status === 'running').length,
            queued: fleet.executions.filter(({ status }) => status === 'queued').length,
            eventLog: Boolean(events()), pushRegistrations: 0,
            liveVideo: (await liveVideoStatus().catch(() => undefined))?.message ?? STILLS_ONLY_MESSAGE,
        };
        return { facts, fleet, rig: rigStatus(facts), unread, theme: theme(request) };
    };

    const renderWith = (page: ShellPage, context: ShellChrome): string => renderShell({
        ...page,
        head: `${options.head?.() ?? ''}${page.head ?? ''}`,
        rig: context.rig, unreadAlerts: context.unread,
        pluginNav, authNav, theme: context.theme,
    });

    const shell: ShellRenderer = async (request, page, read) => renderWith(page, await chrome(request, read));

    return { pluginNav, authNav, events, unreadAlerts, theme, chrome, shell, renderWith, wallSources };
}
