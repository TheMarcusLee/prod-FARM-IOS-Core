import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';

import { discoverConnectedDevices, devicePlatform, type Device } from '../devices/discovery.js';
import { DEVICE_ID_MESSAGE, validDeviceId } from '../devices/identifiers.js';
import { loadRegisteredDevices, mutateRegisteredDevices, saveRegisteredDevices, redactDevice, PASSCODE_PATTERN, type RegisteredDevice } from '../devices/registry.js';
import { driverForDevice, driverKindOf, platformOf } from '../drivers/select.js';
import type { AndroidDeviceConfig, DeviceDriver } from '../drivers/types.js';
import {
    CALIBRATABLE_POINTS, POINT_LABELS, coordinatesForProfile, resolveDeviceCoordinates, validateCoordinateOverrides,
} from '../devices/coordinates.js';
import { motionSettingsProblem, validateMotionSettings } from '../motion/profile.js';
import { RegistryWdaRemoteControl } from '../devices/registry-remote.js';
import type {
    DeviceRegistrationManager, RegistrationAction, RegistrationUpdate,
} from '../devices/registration.js';
import { type RemoteAction } from '../devices/wda-remote.js';
import { requestWdaService } from '../devices/wda-service-client.js';
import type { DeviceConnectionStatus } from '../devices/connection-manager.js';
import { SESSION_COOKIE } from '../auth/local.js';
import type { AuthProvider } from '../plugin.js';
import type { PluginRegistry } from '../registry.js';
import type { CreateTaskInput, JsonObject, ScheduleTiming } from '../types.js';
import { ScheduleTransitionError, type SchedulerRepository } from '../scheduler/repository.js';
import { createEventStore, type EventStore, type FarmEvent } from '../fleet/events.js';
import { safeFixUrl } from '../fleet/scheduler-events.js';
import { acknowledgedMark } from '../push/acks.js';
import { wdaServiceStatuses } from '../fleet/connectivity.js';
import {
    renderControlCenter, renderInspector, renderInspectorRun, wallToolbar, wallToolbarRight,
    hardwareColumn, viewer, timeOfDay, type WallDevice,
} from '../fleet/page.js';
import { collectWall, inspectorLog, parseLogLine, readFleet, toWallDevices, type FleetRead } from '../ui/wall-data.js';
import { renderShell, stateBadge, slotNumber, PRODUCT_NAME, type NavKey } from '../ui/shell.js';
import { THEME_COOKIE, createShellContext } from '../ui/context.js';
import { icon } from '../ui/icons.js';
import { rigServices, rigStatus, type RigFacts } from '../ui/rig.js';
import {
    accountRows, renderAccountsPage, renderAlertsPage, renderDevicesPage, renderRigPage, renderSettingsPage,
} from '../ui/pages.js';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { assets } from '../database/schema.js';
import { runCommand } from '../drivers/common.js';
import { registerContentRoutes } from './routes/content.js';
import { registerFleetRoutes } from './routes/fleet.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { personaHead, registerPersonaRoutes, renderPersonaSection } from './routes/personas.js';
import { registerPushRoutes } from './routes/push.js';
import { registerScheduleRoutes } from './routes/schedule.js';
import { clampScreenshotWidth, keysetPage, registerMobileRoutes, resizeScreenshot, type KeysetQuery } from './routes/mobile.js';

export interface CreateAppOptions {
    plugins: PluginRegistry;
    scheduler: SchedulerRepository;
    authProvider?: AuthProvider | null;
    dashboardTheme?: DashboardTheme;
    registrations?: DeviceRegistrationManager;
    /** How an Android device record becomes a live driver; tests inject a fake. iOS never uses it. */
    createDriver?: (device: RegisteredDevice) => DeviceDriver;
    /**
     * Which registered phones the pages should treat as connected. Production reads USB, adb and
     * the connection manager; a test or the preview script hands over a list.
     */
    connectedUdids?: () => Promise<string[]>;
    /** The event log behind Alerts and the sidebar's unread count; production builds it from the database. */
    events?: EventStore;
    logger?: boolean;
}

export interface DashboardTheme {
    rootDirectory: string;
    renderDevice?(template: string, device: RegisteredDevice): string;
}

interface DashboardAsset {
    contentType: string;
    body: string;
}

interface LoadedDashboardTheme {
    /** Page bodies; the shell wraps them. */
    deviceHtml: string;
    registerDeviceHtml: string;
    /** Everything /assets/<file> can serve: the token stylesheet, htmx and every page script. */
    assets: Map<string, DashboardAsset>;
    /** Content hash per asset name, so a template can ask for an immutable URL. */
    versions: Record<string, string>;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Thrown inside route bodies / registry mutations; mapped to its status by setErrorHandler. */
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
    return Object.assign(new Error(message), { statusCode });
}

/**
 * A route that throws deliberately — `httpError`, a validator, Fastify's own
 * schema check — is answering the caller and keeps its status and its message.
 * Anything else is a fault in the farm, and its message is an internal detail:
 * `ENOENT … /Users/…/devices.json` and `connect ECONNREFUSED 127.0.0.1:5432`
 * both name things the caller has no business learning. Those become a plain
 * 500; the real error is already in the log line above.
 */
function isDeliberate(error: unknown): boolean {
    const failure = error as { statusCode?: unknown; code?: unknown };
    if (typeof failure.statusCode === 'number') return failure.statusCode >= 400 && failure.statusCode < 500;
    // Fastify's own client-facing errors (validation, bad JSON, body too large)
    // carry an FST_ERR_* code; a Node system error carries ENOENT/ECONNREFUSED/…
    if (typeof failure.code === 'string') return failure.code.startsWith('FST_ERR_');
    // A TypeError or RangeError with no status is a bug, not an answer.
    if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) return false;
    return error instanceof Error;
}

function clientStatus(error: unknown): number {
    if (!isDeliberate(error)) return 500;
    const status = (error as { statusCode?: number }).statusCode;
    return typeof status === 'number' && status >= 400 && status < 500 ? status : 400;
}

function clientErrorMessage(error: unknown): string {
    return isDeliberate(error) ? errorMessage(error) : 'Internal server error';
}

/** Defined in `devices/identifiers.ts`, so devices.json is held to the same shape. */
export { DEVICE_ID_PATTERN } from '../devices/identifiers.js';

export const MAX_DEVICE_NAME_LENGTH = 200;

/** Remembers the operator's appearance choice; 'auto' follows the OS, anything else is light. */

/** Asset ids are database uuids; anything else never reaches a query. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The repo documents the Rig page may link to. An explicit list — never a path from a request. */
const DOC_PAGES: readonly string[] = [
    'getting-started', 'operations', 'android-dashboard', 'fleet-and-alerts', 'auth', 'mcp', 'runbooks',
    'personas',
];

function validPort(value: unknown): boolean {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/** The bridge is fetched by the a11y-bridge driver, so an unchecked value here is an SSRF hole. */
function validBridgeUrl(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch { return false; }
}

/** Returns the first problem with a device body, or null. Shared by POST and PATCH. */
function deviceBodyProblem(body: {
    name?: unknown; wdaLocalPort?: unknown; mjpegLocalPort?: unknown; motion?: unknown;
    android?: { serial?: unknown; bridgeUrl?: unknown; bridgeToken?: unknown; bridgeOnly?: unknown } | null;
}): string | null {
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > MAX_DEVICE_NAME_LENGTH)) {
        return `name must be a string of at most ${MAX_DEVICE_NAME_LENGTH} characters`;
    }
    for (const port of ['wdaLocalPort', 'mjpegLocalPort'] as const) {
        if (body[port] !== undefined && !validPort(body[port])) return `${port} must be a port between 1 and 65535`;
    }
    const android = body.android;
    if (android !== undefined && android !== null) {
        if (typeof android !== 'object') return 'android must be an object with a serial';
        if (!validDeviceId(android.serial)) return `android.serial ${DEVICE_ID_MESSAGE}`;
        if (android.bridgeUrl !== undefined && !validBridgeUrl(android.bridgeUrl)) {
            return 'android.bridgeUrl must be an http(s) URL';
        }
        if (android.bridgeToken !== undefined && typeof android.bridgeToken !== 'string') {
            return 'android.bridgeToken must be a string';
        }
        if (android.bridgeOnly !== undefined && typeof android.bridgeOnly !== 'boolean') {
            return 'android.bridgeOnly must be a boolean';
        }
    }
    return motionSettingsProblem(body.motion);
}

function positiveBytes(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Non-multipart bodies. 8 MB covers the largest thing the JSON API legitimately
 * carries (an MCP `upload_asset` with inline base64), where 50 MB meant any
 * caller could make the process buffer 50 MB per in-flight request.
 */
function jsonBodyLimit(): number {
    return positiveBytes('PHONE_FARM_BODY_LIMIT', 8 * 1024 * 1024);
}

/** Media uploads stream to disk, so this bounds one file rather than memory. */
function uploadFileSizeLimit(): number {
    return positiveBytes('PHONE_FARM_UPLOAD_LIMIT', 2 * 1024 * 1024 * 1024);
}

/**
 * The CSRF guard steps aside for `Authorization: Bearer …` because a browser
 * form cannot set that header. A request that also carries a session cookie is
 * a browser, though, whatever header it managed to attach — so the exemption is
 * for bearer-only requests, never for anything the cookie could authenticate.
 */
function bearerOnlyRequest(request: FastifyRequest): boolean {
    if (!request.headers.authorization?.startsWith('Bearer ')) return false;
    return !(request.headers.cookie ?? '').split(';').some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
}

function csrfBlocked(reply: FastifyReply): FastifyReply {
    return reply.code(403).send({
        error: 'Cross-origin write blocked. Send an Authorization: Bearer token for API clients, '
            + 'or add the origin to PHONE_FARM_TRUSTED_ORIGINS.',
    });
}

function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
}

/**
 * Both the unlock passcode and `android.bridgeToken` are stripped by `redactDevice` itself, so
 * this is the registry's own redaction under the name the routes already use.
 */
export const publicDevice = redactDevice;

async function registeredWithStatus() {
    const [registered, connected] = await Promise.all([loadRegisteredDevices(), discoverConnectedDevices()]);
    const online = new Map(connected.map((device) => [device.udid, device]));
    return registered.map((device) => ({
        ...publicDevice(device),
        connected: device.disabled ? null : online.get(device.udid) ?? null,
    }));
}

/** "iOS 16.7" / "Android 14" — every status line that used to hard-code iOS goes through here. */
function osLabel(device: Pick<Device, 'platform' | 'osVersion'>): string {
    return `${devicePlatform(device) === 'android' ? 'Android' : 'iOS'} ${device.osVersion}`;
}


/** The Android remote verbs the dashboard can send; the rest are iOS/WDA-only. */
type AndroidRemoteAction = RemoteAction | { type: 'back' } | { type: 'recents' } | { type: 'text'; text: string };

const REMOTE_VERBS = [
    'tap', 'home', 'lock', 'power', 'wake', 'unlock', 'volumeUp', 'volumeDown', 'swipe',
    'back', 'recents', 'text',
];

/** Verbs only an Android phone has. iOS gets a 400 rather than a WDA error it cannot read. */
const ANDROID_ONLY_VERBS = ['back', 'recents', 'text'];

/** Coordinates and durations reach `adb input` and WDA as numbers; NaN there taps nothing, slowly. */
function finiteNumber(value: unknown): boolean {
    return typeof value === 'number' && Number.isFinite(value);
}

export const MAX_REMOTE_TEXT_LENGTH = 4_096;

/**
 * The body of `/remote/action` was cast straight to a `RemoteAction`, so a tap
 * with `x: "1e999"` or a 5 MB `text` reached the device driver as-is. Validate
 * the union here instead: it is the only door these actions come through.
 */
function remoteActionProblem(body: unknown): string | null {
    if (typeof body !== 'object' || body === null) return 'A remote action object is required';
    const action = body as Record<string, unknown>;
    if (typeof action.type !== 'string' || !REMOTE_VERBS.includes(action.type)) {
        return `type must be one of ${REMOTE_VERBS.join(', ')}`;
    }
    if (action.type === 'tap' && !(finiteNumber(action.x) && finiteNumber(action.y))) {
        return 'tap needs finite x and y';
    }
    if (action.type === 'swipe'
        && !['startX', 'startY', 'endX', 'endY', 'durationMs'].every((key) => finiteNumber(action[key]))) {
        return 'swipe needs finite startX, startY, endX, endY and durationMs';
    }
    if (action.type === 'text'
        && !(typeof action.text === 'string' && action.text.length <= MAX_REMOTE_TEXT_LENGTH)) {
        return `text must be a string of at most ${MAX_REMOTE_TEXT_LENGTH} characters`;
    }
    return null;
}

async function performAndroidAction(driver: DeviceDriver, action: AndroidRemoteAction): Promise<void> {
    switch (action.type) {
        case 'tap': return driver.tap({ x: action.x, y: action.y });
        case 'swipe': return driver.swipe({
            from: { x: action.startX, y: action.startY }, to: { x: action.endX, y: action.endY },
            durationMs: action.durationMs,
        });
        case 'home': return driver.pressKey('home');
        case 'back': return driver.pressKey('back');
        case 'recents': return driver.pressKey('recents');
        case 'power': return driver.pressKey('power');
        case 'text': return driver.type(action.text);
        default: throw httpError(400, `"${action.type}" is an iOS-only remote action`);
    }
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
    const app = Fastify({ logger: options.logger ?? false, bodyLimit: jsonBodyLimit() });
    await app.register(formbody);
    await app.register(cookie);
    // fileSize is the one limit a 4K screen recording needs room under; the
    // rest are there so a malformed (or hostile) multipart body cannot make the
    // parser hold an unbounded number of parts or an unbounded field in memory.
    await app.register(multipart, {
        limits: {
            fileSize: uploadFileSizeLimit(), files: 20, parts: 60, fields: 40,
            fieldSize: 1024 * 1024, fieldNameSize: 200, headerPairs: 200,
        },
    });

    // Server-rendered HTML must never be cached — a stale page + fresh assets
    // (or vice versa) breaks the dashboard after a deploy.
    app.addHook('onSend', async (_request, reply) => {
        const type = reply.getHeader('content-type');
        if (typeof type === 'string' && type.includes('text/html') && !reply.hasHeader('cache-control')) {
            reply.header('cache-control', 'no-cache');
        }
    });

    // CSRF guard — runs for every deployment, auth or not. The default loopback
    // dashboard is otherwise open to form-encoded POSTs from any page the
    // operator has open in the same browser (tap the phone, stop executions,
    // launch tasks). A Bearer token means a real API client, not a browser form.
    app.addHook('onRequest', async (request, reply) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
        if (bearerOnlyRequest(request)) return;
        const origin = request.headers.origin;
        if (!origin) return csrfBlocked(reply);
        const configured = [process.env.PUBLIC_ORIGIN, ...(process.env.PHONE_FARM_TRUSTED_ORIGINS ?? '').split(',')]
            .map((value) => value?.trim().replace(/\/+$/, '')).filter((value): value is string => Boolean(value));
        if (configured.length) {
            if (!configured.includes(origin.replace(/\/+$/, ''))) return csrfBlocked(reply);
            return;
        }
        // Nothing configured: same-origin only, compared by host (ignoring
        // scheme) so a TLS-terminating proxy that doesn't forward
        // x-forwarded-proto still passes. URL normalises default ports, so
        // compare the Origin's host against the request Host under both schemes.
        // Set PHONE_FARM_TRUSTED_ORIGINS if the proxy also rewrites Host.
        let originHost: string;
        try { originHost = new URL(origin).host; } catch { return csrfBlocked(reply); }
        const hostMatches = ['http', 'https'].some((scheme) => {
            try { return new URL(`${scheme}://${request.headers.host}`).host === originHost; } catch { return false; }
        });
        if (!hostMatches) return csrfBlocked(reply);
    });

    if (options.authProvider) {
        await options.authProvider.registerRoutes(app);
        app.addHook('onRequest', async (request, reply) => {
            if (options.authProvider?.isPublicPath(request.url.split('?')[0] ?? request.url)) return;
            const user = await options.authProvider?.authenticate(request, reply);
            if (!user && !reply.sent) await reply.code(401).send({ error: 'Authentication required' });
        });
    }

    const remote = new RegistryWdaRemoteControl();
    const createDriver = options.createDriver ?? ((device: RegisteredDevice) => driverForDevice(device));
    // Every Android-aware route starts here: iOS (and unknown udids) get undefined and
    // keep the WDA path they have always had.
    const androidDevice = async (udid: string): Promise<RegisteredDevice | undefined> => {
        const device = (await loadRegisteredDevices()).find((entry) => entry.udid === udid);
        return device && platformOf(device) === 'android' ? device : undefined;
    };
    const assetHash = (body: string) => crypto.createHash('sha1').update(body).digest('base64url').slice(0, 10);
    /** A page script, at its content-hashed URL when the theme is loaded. */
    const scriptTag = (name: string): string => {
        const version = themed?.versions[name];
        return `<script type="module" src="/assets/${name}${version ? `?v=${version}` : ''}"></script>`;
    };

    // Every page's sidebar, unread count, plugin nav and theme come from one
    // place; see src/ui/context.ts.
    const shellContext = createShellContext({
        app, scheduler: options.scheduler,
        plugins: options.plugins,
        ...(options.authProvider ? { authProvider: options.authProvider } : {}),
        ...(options.events ? { events: options.events } : {}),
        ...(options.connectedUdids ? { connectedUdids: options.connectedUdids } : {}),
        head: () => scriptTag('shell.js'),
    });
    const { chrome, shell, events, wallSources } = shellContext;
    const unreadAlerts = shellContext.unreadAlerts;
    const themeOf = shellContext.theme;

    /** The old plain-HTML fallback, now the shell with a one-panel body. */
    const renderPage = (title: string, body: string, active: NavKey = 'devices') =>
        renderShell({
            title, active, body: `<div class="bl-page">${body}</div>`,
            pluginNav: shellContext.pluginNav, authNav: shellContext.authNav, theme: 'light',
        });

    let themed: LoadedDashboardTheme | null = null;
    if (options.dashboardTheme) {
        const root = options.dashboardTheme.rootDirectory;
        const require = createRequire(import.meta.url);
        const assetRoot = path.join(root, 'assets');
        // Every compiled page script is served by one route, so a new page needs
        // a new .ts file and nothing else.
        const scripts = (await readdir(assetRoot)).filter((name) => name.endsWith('.js')).sort();
        const [deviceHtml, registerDeviceHtml, htmx, backlineStyles, ...scriptBodies] = await Promise.all([
            readFile(path.join(root, 'templates/device.html'), 'utf8'),
            readFile(path.join(root, 'templates/register-device.html'), 'utf8'),
            readFile(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8'),
            readFile(path.join(root, 'backline.css'), 'utf8'),
            ...scripts.map((name) => readFile(path.join(assetRoot, name), 'utf8')),
        ]);
        const assets = new Map<string, DashboardAsset>([
            ['backline.css', { contentType: 'text/css', body: backlineStyles }],
            ['htmx.min.js', { contentType: 'text/javascript', body: htmx }],
            ...scripts.map((name, index): [string, DashboardAsset] =>
                [name, { contentType: 'text/javascript', body: scriptBodies[index] ?? '' }]),
        ]);
        // Content-hash every asset URL so a changed file gets a fresh URL that no
        // browser or CDN can serve stale.
        const versions: Record<string, string> = {};
        for (const [name, value] of assets) versions[name] = assetHash(value.body);
        const finalize = (html: string) => {
            // The device and registration templates are page bodies; the placeholders are
            // what is left of the pre-Backline layout they were lifted out of.
            let out = html.replaceAll('__AUTH_NAV__', shellContext.authNav)
                .replaceAll('__PLUGIN_NAV__', shellContext.pluginNav).replaceAll('__FOOTER__', '');
            for (const [name, v] of Object.entries(versions)) out = out.replaceAll(`/assets/${name}`, `/assets/${name}?v=${v}`);
            return out;
        };
        themed = {
            deviceHtml: finalize(deviceHtml),
            registerDeviceHtml: finalize(registerDeviceHtml), assets, versions,
        };
    }

    const renderActivity = async (deviceUdid: string, message?: string): Promise<string> => {
        const partial = options.scheduler as Partial<SchedulerRepository>;
        const executions = await partial.listExecutions?.(25, deviceUdid) ?? [];
        const problem = message ? `<div class="bl-error">${escapeHtml(message)}</div>` : '';
        const execution = executions.find(({ status }) => status === 'running') ?? executions[0];
        if (!execution) {
            return `<section id="device-activity">${problem}<div class="bl-log">`
                + '<div><span>Nothing has run on this phone yet.</span></div></div></section>';
        }
        const detail = await partial.execution?.(execution.id) ?? null;
        // A plugin (or task version) can be uninstalled while old executions
        // still reference it — degrade instead of throwing out of the fragment.
        let definition: {
            summarize(payload: JsonObject): string;
            supportsStop(payload: JsonObject): boolean;
            fixUrl?(payload: JsonObject): string | undefined;
        } | undefined;
        try {
            definition = options.plugins.task({
                pluginId: execution.pluginId, taskType: execution.taskType,
                taskVersion: execution.taskVersion, payload: execution.payload,
            });
        } catch { /* plugin unavailable */ }
        const summary = definition
            ? definition.summarize(execution.payload)
            : `${execution.pluginId}/${execution.taskType} · this plugin is not installed`;
        const canStop = execution.status === 'queued'
            || (execution.status === 'running' && (definition?.supportsStop(execution.payload) ?? true));
        const stop = canStop
            ? `<form hx-post="/api/executions/${execution.id}/stop" hx-target="#device-activity" hx-swap="outerHTML"><button class="bl-btn bl-btn-sm" type="submit">Stop</button></form>` : '';
        // A failed task that knows where it can be repaired says so, right beside the log that
        // shows it failing. The path is the plugin's; it is checked before it becomes an anchor.
        const fix = execution.status === 'failed'
            ? safeFixUrl(definition?.fixUrl?.(execution.payload)) : undefined;
        const fixButton = fix ? `<a class="bl-btn bl-btn-sm" href="${escapeHtml(fix)}">Fix it</a>` : '';
        const lines = (detail?.logs.length ? detail.logs.slice(-12) : [execution.error ?? 'Waiting for the worker'])
            .map((line) => parseLogLine(line));
        const log = lines.map((line, index) => `<div${index === lines.length - 1 ? ' class="is-current"' : ''}>`
            + `${line.time ? `<time>${escapeHtml(line.time)}</time>` : ''}<span>${escapeHtml(line.text)}</span></div>`).join('');
        return `<section id="device-activity" hx-get="/api/devices/${encodeURIComponent(deviceUdid)}/fragments/activity" hx-trigger="every 2s" hx-swap="outerHTML">`
            + `<div class="bl-activity-head"><span class="bl-state ${execution.status === 'running' ? 'busy' : execution.status === 'failed' ? 'error' : ''}">`
            + `<span class="bl-dot ${execution.status === 'running' ? 'busy' : execution.status === 'failed' ? 'error' : ''}"></span>${escapeHtml(execution.status)}</span>`
            + `<span class="bl-muted">${escapeHtml(summary)}</span><span class="bl-spacer"></span>${fixButton}${stop}</div>`
            + `${problem}<div class="bl-log">${log}</div></section>`;
    };

    app.get('/health', async () => {
        const body: Record<string, unknown> = {
            ok: true,
            plugins: options.plugins.list().map(({ id, version }) => ({ id, version })),
        };
        // Deploy tooling writes a RELEASED file (sha, subject, deployedAt) into the
        // working directory; surface it so "what's live" is answerable over HTTP.
        try {
            body.release = JSON.parse(await readFile(path.resolve(process.env.PHONE_FARM_RELEASE_FILE ?? 'RELEASED'), 'utf8'));
        } catch { /* no release marker — fine */ }
        return body;
    });
    app.get('/api/plugins', async () => options.plugins.list().map((plugin) => ({
        id: plugin.id, version: plugin.version, displayName: plugin.displayName,
        tasks: plugin.tasks.map(({ type, version, displayName }) => ({ type, version, displayName })),
    })));
    app.get('/api/devices', async () => registeredWithStatus());
    app.get('/api/devices/discovered', async () => discoverConnectedDevices());
    app.get('/api/device-registrations/candidates', async (_request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return { devices: await options.registrations.candidates() };
    });
    app.post<{ Body: { udid?: string } }>('/api/device-registrations', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        if (!request.body.udid?.trim()) return reply.code(400).send({ error: 'Device UDID is required' });
        return reply.code(201).send(await options.registrations.create(request.body.udid.trim()));
    });
    app.get<{ Params: { id: string } }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return await options.registrations.get(request.params.id)
            ?? reply.code(404).send({ error: 'Registration draft not found' });
    });
    app.patch<{ Params: { id: string }; Body: RegistrationUpdate }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return options.registrations.update(request.params.id, request.body);
    });
    app.post<{ Params: { id: string; action: RegistrationAction }; Body: { authorizeTeamRegistration?: boolean } }>(
        '/api/device-registrations/:id/actions/:action', async (request, reply) => {
            if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
            if (!['refresh', 'prepare', 'verify', 'finalize'].includes(request.params.action)) {
                return reply.code(404).send({ error: 'Unknown registration action' });
            }
            return options.registrations.run(request.params.id, request.params.action, {
                authorizeTeamRegistration: request.body?.authorizeTeamRegistration === true,
            });
        },
    );
    app.delete<{ Params: { id: string } }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        await options.registrations.cancel(request.params.id);
        return reply.code(204).send();
    });
    app.post<{ Body: { name?: string; udid?: string; wdaLocalPort?: number; mjpegLocalPort?: number; passcode?: string; coordinateProfile?: string; pluginData?: Record<string, JsonObject>; platform?: string; driver?: string; motion?: unknown; android?: { serial?: unknown; bridgeUrl?: unknown; bridgeToken?: unknown; bridgeOnly?: unknown } | null } }>(
        '/api/devices', async (request, reply) => {
            const { name, udid, wdaLocalPort, mjpegLocalPort, passcode, coordinateProfile, pluginData, platform, driver, android, motion } = request.body;
            if (!udid) return reply.code(400).send({ error: 'A device UDID is required' });
            if (!validDeviceId(udid)) return reply.code(400).send({ error: `udid ${DEVICE_ID_MESSAGE}` });
            const problem = deviceBodyProblem(request.body);
            if (problem) return reply.code(400).send({ error: problem });
            if (passcode !== undefined && !PASSCODE_PATTERN.test(passcode)) {
                return reply.code(400).send({ error: 'Device passcode must contain at least four digits' });
            }
            if (platform !== undefined && platform !== 'ios' && platform !== 'android') {
                return reply.code(400).send({ error: 'platform must be "ios" or "android"' });
            }
            if (driver !== undefined && driver !== 'wda' && driver !== 'adb' && driver !== 'a11y-bridge') {
                return reply.code(400).send({ error: 'driver must be "wda", "adb" or "a11y-bridge"' });
            }
            if (android !== undefined && (typeof android !== 'object' || android === null)) {
                return reply.code(400).send({ error: 'android must be an object with a serial' });
            }
            // Narrowed here, outside the closure below, so the whitelist keeps its types.
            const androidConfig: AndroidDeviceConfig | undefined = android && typeof android.serial === 'string' ? {
                serial: android.serial,
                ...(typeof android.bridgeUrl === 'string' ? { bridgeUrl: android.bridgeUrl } : {}),
                ...(typeof android.bridgeToken === 'string' ? { bridgeToken: android.bridgeToken } : {}),
                ...(android.bridgeOnly === true ? { bridgeOnly: true } : {}),
            } : undefined;
            const motionSettings = validateMotionSettings(motion);
            const created = await mutateRegisteredDevices((devices) => {
                if (devices.some((device) => device.udid === udid)) throw httpError(409, 'A device with this UDID is already registered');
                // Explicit whitelist — never mass-assign arbitrary body keys into devices.json.
                const device: RegisteredDevice = {
                    name: name ?? udid, udid, pluginData: pluginData ?? {},
                    ...(platform !== undefined ? { platform } : {}),
                    ...(driver !== undefined ? { driver } : {}),
                    ...(androidConfig ? { android: androidConfig } : {}),
                    ...(motionSettings ? { motion: motionSettings } : {}),
                    ...(wdaLocalPort !== undefined ? { wdaLocalPort } : {}),
                    ...(mjpegLocalPort !== undefined ? { mjpegLocalPort } : {}),
                    ...(coordinateProfile !== undefined ? { coordinateProfile: coordinateProfile as RegisteredDevice['coordinateProfile'] } : {}),
                    ...(passcode !== undefined ? { passcode } : {}),
                };
                devices.push(device);
                return device;
            });
            return reply.code(201).send(publicDevice(created));
        },
    );
    app.patch<{ Params: { udid: string }; Body: { name?: string; wdaLocalPort?: number; mjpegLocalPort?: number; passcode?: string; coordinates?: unknown; disabled?: boolean; coordinateProfile?: string; pluginData?: Record<string, JsonObject>; tags?: unknown; motion?: unknown } }>(
        '/api/devices/:udid', async (request, reply) => {
            const { passcode, coordinates, name, wdaLocalPort, mjpegLocalPort, disabled, coordinateProfile, pluginData, tags, motion } = request.body;
            const problem = deviceBodyProblem(request.body);
            if (problem) return reply.code(400).send({ error: problem });
            if (passcode !== undefined && passcode !== '' && !PASSCODE_PATTERN.test(passcode)) {
                return reply.code(400).send({ error: 'Device passcode must contain at least four digits' });
            }
            if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))) {
                return reply.code(400).send({ error: 'tags must be an array of strings' });
            }
            if (disabled === true && await options.scheduler.activeExecution(request.params.udid)) {
                return reply.code(409).send({ error: 'Stop the running automation before disconnecting this device' });
            }
            const updated = await mutateRegisteredDevices((devices) => {
                const device = devices.find((entry) => entry.udid === request.params.udid);
                if (!device) throw httpError(404, 'Device not found');
                if (name !== undefined) device.name = name;
                if (wdaLocalPort !== undefined) device.wdaLocalPort = wdaLocalPort;
                if (mjpegLocalPort !== undefined) device.mjpegLocalPort = mjpegLocalPort;
                if (coordinateProfile !== undefined) device.coordinateProfile = coordinateProfile as RegisteredDevice['coordinateProfile'];
                if (pluginData !== undefined) device.pluginData = pluginData;
                if (Array.isArray(tags)) device.tags = [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 20);
                if (disabled === true) device.disabled = true;
                else if (disabled === false) delete device.disabled;
                // passcode: a value sets it, '' clears it, omitting it leaves it
                if (passcode === '') delete device.passcode;
                else if (passcode !== undefined) device.passcode = passcode;
                // motion: the object replaces the whole block; {} goes back to the udid's defaults
                if (motion !== undefined) {
                    const settings = validateMotionSettings(motion);
                    if (settings) device.motion = settings;
                    else delete device.motion;
                }
                // coordinates: the object replaces the whole override map; {} clears it
                if (coordinates !== undefined) {
                    const overrides = validateCoordinateOverrides(coordinates, device.coordinateProfile);
                    if (Object.keys(overrides).length === 0) delete device.coordinates;
                    else device.coordinates = overrides;
                }
                return device;
            });
            remote.forget(request.params.udid);
            return publicDevice(updated);
        },
    );
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/coordinates', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).send({ error: 'Device not found' });
        const base = coordinatesForProfile(device.coordinateProfile).tiktok;
        const effective = resolveDeviceCoordinates(device.coordinateProfile, device.coordinates).tiktok;
        return {
            profile: device.coordinateProfile ?? 'iphone8',
            screenSize: coordinatesForProfile(device.coordinateProfile).screenSize,
            points: CALIBRATABLE_POINTS.map((name) => ({
                name, label: POINT_LABELS[name],
                default: base[name], current: effective[name],
                overridden: Boolean(device.coordinates?.[name]),
            })),
        };
    });
    app.delete<{ Params: { udid: string } }>('/api/devices/:udid', async (request, reply) => {
        const exists = (await loadRegisteredDevices()).some(({ udid }) => udid === request.params.udid);
        if (!exists) return reply.code(404).send({ error: 'Device not found' });
        if (await options.scheduler.activeExecution(request.params.udid)) {
            return reply.code(409).send({ error: 'Stop the running automation before removing this device' });
        }
        for (const schedule of await options.scheduler.listSchedules(500, request.params.udid)) {
            if (!['cancelled', 'completed'].includes(schedule.status)) {
                await options.scheduler.setScheduleStatus(schedule.id, 'cancelled');
            }
        }
        await mutateRegisteredDevices((devices) => {
            const index = devices.findIndex(({ udid }) => udid === request.params.udid);
            if (index >= 0) devices.splice(index, 1);
        });
        remote.forget(request.params.udid);
        return reply.code(204).send();
    });
    app.post<{ Params: { udid: string } }>('/api/devices/:udid/checks', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).send({ error: 'Device not found' });
        const identity = (await discoverConnectedDevices()).find(({ udid }) => udid === device.udid) ?? device;
        const results = [];
        for (const plugin of options.plugins.list()) {
            for (const check of plugin.registrationChecks ?? []) {
                results.push({ pluginId: plugin.id, checkId: check.id, ...(await check.run(identity, device.pluginData[plugin.id] ?? {})) });
            }
        }
        return results;
    });

    // NB: /remote/screenshot and /remote/action below are the canonical
    // endpoints — they carry the activeExecution guard and the cached
    // per-device client. The old unprefixed /screenshot and /actions twins
    // that bypassed both were removed.
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/info', async (request, reply) => {
        const device = (await discoverConnectedDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).send({ error: 'Device is not connected' });
        const android = await androidDevice(device.udid);
        if (android) {
            const { width, height, scale } = await createDriver(android).screen();
            return { device, screen: { screenSize: { width, height }, scale } };
        }
        return { device, screen: await remote.getScreenInfo(device.udid) };
    });
    app.get<{ Params: { udid: string }; Querystring: { width?: string } }>('/api/devices/:udid/remote/screenshot', async (request, reply) => {
        try {
            const android = await androidDevice(request.params.udid);
            const image = android ? await createDriver(android).screenshot() : await remote.getScreenshot(request.params.udid);
            // ?width= keeps a 12-card grid on a phone connection from pulling
            // ~30 MB of full-resolution PNG per refresh.
            const width = clampScreenshotWidth(request.query.width);
            return reply.header('cache-control', 'no-store').type('image/png')
                .send(width === null ? image : await resizeScreenshot(image, width));
        } catch {
            // A flapping device shouldn't spew 500s into the log every 5s from the grid poll.
            return reply.code(503).header('cache-control', 'no-store').send();
        }
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/stream', async (request, reply) => {
        // Close the upstream device stream the moment the browser goes away —
        // otherwise every HTMX fragment swap leaks a live MJPEG connection.
        const abort = new AbortController();
        request.raw.once('close', () => abort.abort());
        const upstream = await remote.getMjpegStream(request.params.udid, abort.signal);
        if (!upstream.body) return reply.code(503).send({ error: 'Device stream is unavailable' });
        return reply.header('cache-control', 'no-store, no-cache, must-revalidate')
            .type(upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace; boundary=--BoundaryString')
            .send(Readable.from(upstream.body as AsyncIterable<Uint8Array>));
    });
    app.post<{ Params: { udid: string }; Body: AndroidRemoteAction }>('/api/devices/:udid/remote/action', async (request, reply) => {
        const problem = remoteActionProblem(request.body);
        if (problem) return reply.code(400).send({ error: problem });
        if (await options.scheduler.activeExecution(request.params.udid)) {
            return reply.code(409).send({ error: 'Remote input is disabled while automation is running' });
        }
        const android = await androidDevice(request.params.udid);
        if (!android && ANDROID_ONLY_VERBS.includes(request.body.type)) {
            return reply.code(400).send({ error: `"${request.body.type}" is an Android-only remote action` });
        }
        if (android) await performAndroidAction(createDriver(android), request.body);
        else await remote.performAction(request.params.udid, request.body as RemoteAction);
        return { ok: true };
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/connection', async (request, reply) => {
        const registered = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!registered) return reply.code(404).send({ error: 'Device is not registered' });
        // Prefer the real per-device state the wda-service supervisor tracks
        // (physical, wda, appium, retryCount, message).
        try {
            const response = await requestWdaService('/devices', { timeoutMs: 2_000 });
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const status = (JSON.parse(response.body).devices as DeviceConnectionStatus[])
                    .find((entry) => entry.udid === registered.udid);
                if (status) return status;
            }
        } catch { /* supervisor socket unavailable — fall back to a probe */ }
        const connected = (await discoverConnectedDevices()).some(({ udid }) => udid === registered.udid);
        if (platformOf(registered) === 'android') {
            // There is no WDA to probe: adb visibility (or the bridge, which the
            // supervisor above tracks) is the whole connection story.
            const status: DeviceConnectionStatus = {
                udid: registered.udid, physical: connected ? 'connected' : 'disconnected',
                wda: connected ? 'ready' : 'disconnected', appium: 'unavailable', managed: false,
                message: connected
                    ? `${driverKindOf(registered)} is connected`
                    : 'Not visible to adb — check the USB cable or wireless debugging',
                retryCount: 0, updatedAt: new Date().toISOString(),
            };
            return status;
        }
        let wda = false;
        try {
            wda = (await fetch(`http://127.0.0.1:${registered.wdaLocalPort ?? 8100}/status`, { signal: AbortSignal.timeout(2_000) })).ok;
        } catch { /* WDA not up */ }
        const fallback: DeviceConnectionStatus = {
            udid: registered.udid, physical: connected ? 'connected' : 'disconnected',
            wda: wda ? 'ready' : connected ? 'connecting' : 'disconnected', appium: 'unavailable',
            managed: false, message: wda ? 'WDA is ready' : connected ? 'Waiting for WDA' : 'Reconnect the USB cable',
            retryCount: 0, updatedAt: new Date().toISOString(),
        };
        return fallback;
    });
    app.post<{ Params: { udid: string } }>('/api/devices/:udid/reconnect', async (request, reply) => {
        if (await options.scheduler.activeExecution(request.params.udid)) {
            return reply.code(409).send({ error: 'Cannot reconnect while automation is running' });
        }
        remote.forget(request.params.udid);
        return reply.code(202).send({ ok: true, message: 'The shared WDA supervisor will reconnect automatically' });
    });

    /**
     * Everything the wall's toolbar can do to a selection that is not already a bulk
     * schedule: pushing a clip onto phones, and installing an APK on the Android ones.
     * Both take the same explicit body — a list of registered udids and one payload —
     * and both refuse anything they cannot name.
     */
    const MAX_ACTION_DEVICES = 100;
    const selectionProblem = (udids: unknown): string | null => {
        if (!Array.isArray(udids) || udids.length === 0) return 'udids must be a non-empty array of device ids';
        if (udids.length > MAX_ACTION_DEVICES) return `udids must name at most ${MAX_ACTION_DEVICES} devices`;
        if (!udids.every((udid) => typeof udid === 'string' && validDeviceId(udid))) return `every udid ${DEVICE_ID_MESSAGE}`;
        return null;
    };
    /** Resolve a selection to registered, enabled device records, or throw a 4xx. */
    const selectedDevices = async (udids: string[]): Promise<RegisteredDevice[]> => {
        const registered = await loadRegisteredDevices();
        return udids.map((udid) => {
            const device = registered.find((entry) => entry.udid === udid);
            if (!device) throw httpError(404, `${udid} is not registered`);
            if (device.disabled) throw httpError(409, `${device.name} is disabled — activate it first`);
            return device;
        });
    };
    interface ActionOutcome { udid: string; ok: boolean; message: string }

    app.post<{ Body: { udids?: unknown; assetId?: unknown } }>('/api/devices/actions/push-media', async (request, reply) => {
        const problem = selectionProblem(request.body?.udids);
        if (problem) return reply.code(400).send({ error: problem });
        const assetId = request.body?.assetId;
        if (typeof assetId !== 'string' || !UUID_PATTERN.test(assetId)) {
            return reply.code(400).send({ error: 'assetId must be an uploaded asset id' });
        }
        let file: { path: string; name: string; mimeType: string };
        try {
            const [row] = await options.scheduler.connection.db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
            if (!row) return reply.code(404).send({ error: 'No such asset' });
            const root = path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
            file = { path: path.resolve(root, row.relativePath), name: row.originalName, mimeType: row.mimeType };
        } catch {
            return reply.code(503).send({ error: 'Media is unavailable — the scheduler database is not connected' });
        }
        const devices = await selectedDevices(request.body!.udids as string[]);
        const results: ActionOutcome[] = [];
        for (const device of devices) {
            try {
                await createDriver(device).pushMedia({ localPath: file.path, fileName: file.name, mimeType: file.mimeType });
                results.push({ udid: device.udid, ok: true, message: `${file.name} is on the phone` });
            } catch (error) {
                results.push({ udid: device.udid, ok: false, message: errorMessage(error) });
            }
        }
        const pushed = results.filter(({ ok }) => ok).length;
        return reply.code(pushed ? 200 : 502).send({ pushed, failed: results.length - pushed, results });
    });

    app.post<{ Body: { udids?: unknown; path?: unknown } }>('/api/devices/actions/install-apk', async (request, reply) => {
        const problem = selectionProblem(request.body?.udids);
        if (problem) return reply.code(400).send({ error: problem });
        const apk = request.body?.path;
        if (typeof apk !== 'string' || apk.includes('\0') || !apk.toLowerCase().endsWith('.apk')) {
            return reply.code(400).send({ error: 'path must be the path of an .apk file' });
        }
        // The path comes from a browser, so it is only ever allowed to name a file
        // inside the farm's own APK directory — never an arbitrary place on disk.
        const root = path.resolve(process.env.PHONE_FARM_APK_DIR
            ?? path.join(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data', 'apk'));
        const resolved = path.resolve(root, apk);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
            return reply.code(400).send({ error: `path must name a file inside ${root}` });
        }
        try {
            await readFile(resolved, { flag: 'r' });
        } catch {
            return reply.code(404).send({ error: 'No such APK' });
        }
        const devices = await selectedDevices(request.body!.udids as string[]);
        const notAndroid = devices.filter((device) => platformOf(device) !== 'android');
        if (notAndroid.length) {
            return reply.code(400).send({
                error: `An APK only installs on Android: ${notAndroid.map(({ name }) => name).join(', ')}`,
            });
        }
        const results: ActionOutcome[] = [];
        for (const device of devices) {
            try {
                await runCommand('adb', ['-s', device.android?.serial ?? device.udid, 'install', '-r', resolved],
                    { timeoutMs: 180_000 });
                results.push({ udid: device.udid, ok: true, message: 'Installed' });
            } catch (error) {
                results.push({ udid: device.udid, ok: false, message: errorMessage(error) });
            }
        }
        const installed = results.filter(({ ok }) => ok).length;
        return reply.code(installed ? 200 : 502).send({ installed, failed: results.length - installed, results });
    });

    app.get<{ Querystring: KeysetQuery }>('/api/schedules', async (request, reply) => {
        const page = await keysetPage(request.query, (id) => options.scheduler.schedule(id),
            (limit, deviceUdid, before) => options.scheduler.listSchedules(limit, deviceUdid, before));
        if (page.nextBefore) reply.header('x-next-before', page.nextBefore);
        return { schedules: page.rows };
    });
    app.get<{ Querystring: KeysetQuery }>('/api/executions', async (request, reply) => {
        const page = await keysetPage(request.query, (id) => options.scheduler.execution(id),
            (limit, deviceUdid, before) => options.scheduler.listExecutions(limit, deviceUdid, before));
        if (page.nextBefore) reply.header('x-next-before', page.nextBefore);
        return { executions: page.rows };
    });
    app.get<{ Params: { id: string } }>('/api/executions/:id', async (request, reply) => {
        const execution = await options.scheduler.execution(request.params.id);
        return execution ?? reply.code(404).send({ error: 'Execution not found' });
    });
    app.post<{ Body: CreateTaskInput & { assetIds?: string[] } }>('/api/schedules', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.body.deviceUdid);
        if (!device) return reply.code(404).send({ error: 'Device not found' });
        if (device.disabled) return reply.code(409).send({ error: 'This device is disabled — activate it before scheduling automation' });
        const schedule = await options.scheduler.createTask(
            request.body, device.pluginData[request.body.task.pluginId] ?? {}, new Date(), request.body.assetIds ?? [],
        );
        return reply.code(201).send(schedule);
    });
    app.patch<{
        Params: { id: string };
        Body: { timing?: ScheduleTiming; runWindowMinutes?: number; recurringPublishConfirmed?: boolean };
    }>('/api/schedules/:id', async (request, reply) => {
        const current = await options.scheduler.schedule(request.params.id);
        if (!current) return reply.code(404).send({ error: 'Schedule not found' });
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === current.deviceUdid);
        if (!device) return reply.code(404).send({ error: 'Scheduled device is not registered' });
        const payload = request.body.recurringPublishConfirmed === undefined
            ? current.payload
            : { ...current.payload, recurringPublishConfirmed: request.body.recurringPublishConfirmed };
        const schedule = await options.scheduler.updateSchedule(request.params.id, {
            ...(request.body.timing ? { timing: request.body.timing } : {}),
            ...(request.body.runWindowMinutes !== undefined ? { runWindowMinutes: request.body.runWindowMinutes } : {}),
            task: {
                pluginId: current.pluginId, taskType: current.taskType,
                taskVersion: current.taskVersion, payload,
            },
        }, device.pluginData[current.pluginId] ?? {});
        return schedule ?? reply.code(409).send({ error: 'Completed or cancelled schedules cannot be edited' });
    });
    const changeStatus = async (id: string, status: 'active' | 'paused' | 'cancelled', reply: FastifyReply) => {
        try {
            const schedule = await options.scheduler.setScheduleStatus(id, status);
            return schedule ?? reply.code(404).send({ error: 'Schedule not found' });
        } catch (error) {
            if (error instanceof ScheduleTransitionError) return reply.code(409).send({ error: errorMessage(error) });
            throw error;
        }
    };
    app.post<{ Params: { id: string }; Body: { status: 'active' | 'paused' | 'cancelled' } }>('/api/schedules/:id/status',
        (request, reply) => changeStatus(request.params.id, request.body.status, reply));
    for (const action of ['pause', 'resume', 'cancel'] as const) {
        const status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
        app.post<{ Params: { id: string } }>(`/api/schedules/:id/${action}`,
            (request, reply) => changeStatus(request.params.id, status, reply));
    }
    app.post<{ Params: { id: string } }>('/api/executions/:id/stop', async (request, reply) => {
        const result = await options.scheduler.requestStop(request.params.id);
        if (result === 'not-found') return reply.code(404).send({ error: 'Execution not found' });
        if (request.headers['hx-request']) {
            const execution = await options.scheduler.execution(request.params.id);
            return reply.type('text/html').send(await renderActivity(execution?.deviceUdid ?? ''));
        }
        return { result };
    });
    app.post<{ Params: { id: string } }>('/api/executions/:id/retry', async (request, reply) => {
        const execution = await options.scheduler.retryExecution(request.params.id);
        return execution ?? reply.code(409).send({ error: 'Execution is not retryable' });
    });

    app.post('/api/assets', async (request, reply) => {
        const dataRoot = path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
        const uploadDirectory = path.join(dataRoot, 'uploads');
        await mkdir(uploadDirectory, { recursive: true });
        const created: Array<{ relativePath: string; originalName: string; mimeType: string; size: number; sha256: string }> = [];
        for await (const part of request.files()) {
            const id = crypto.randomUUID();
            const relativePath = path.join('uploads', id);
            const handle = await open(path.join(dataRoot, relativePath), 'wx', 0o600);
            const hash = crypto.createHash('sha256');
            let size = 0;
            try {
                for await (const chunk of part.file) {
                    const buffer = Buffer.from(chunk);
                    size += buffer.length;
                    hash.update(buffer);
                    await handle.write(buffer);
                }
            } finally {
                await handle.close();
            }
            created.push({ relativePath, originalName: part.filename, mimeType: part.mimetype, size, sha256: hash.digest('hex') });
        }
        return reply.code(201).send(await options.scheduler.registerAssets(created));
    });
    app.delete<{ Body: { assetIds: string[] } }>('/api/assets', async (request, reply) => {
        const assetIds = request.body?.assetIds ?? [];
        if (!Array.isArray(assetIds) || assetIds.some((id) => typeof id !== 'string')) {
            return reply.code(400).send({ error: 'assetIds must be an array of asset ids' });
        }
        await options.scheduler.deleteAssets(assetIds);
        return reply.code(204).send();
    });

    await registerContentRoutes(app, { scheduler: options.scheduler, shell });
    await registerFleetRoutes(app, options);
    registerPersonaRoutes(app);
    await registerScheduleRoutes(app, { ...options, shell });
    await registerPushRoutes(app, options);
    await registerMcpRoutes(app, {
        scheduler: options.scheduler, plugins: options.plugins, screenshot: (udid) => remote.getScreenshot(udid),
    });
    await registerMobileRoutes(app, options);

    for (const plugin of options.plugins.list()) {
        if (plugin.registerRoutes) await plugin.registerRoutes({
            app, routePrefix: `/plugins/${plugin.id}`, scheduler: options.scheduler, remote,
            loadDevices: loadRegisteredDevices, saveDevices: saveRegisteredDevices, mutateDevices: mutateRegisteredDevices,
            renderActivity, shell,
        });
    }

    const AVATAR = `<span class="bl-avatar" aria-hidden="true">${PRODUCT_NAME.slice(0, 1)}</span>`;

    if (themed) {
        const theme = themed;
        // A versioned request is safe to cache forever; a bare one (a bookmark)
        // must revalidate via ETag.
        const etags = new Map<string, string>();
        for (const [name, value] of theme.assets) {
            etags.set(name, `"${crypto.createHash('sha1').update(value.body).digest('base64url')}"`);
        }
        app.get<{ Params: { file: string }; Querystring: { v?: string } }>('/assets/:file', async (request, reply) => {
            const found = theme.assets.get(request.params.file);
            if (!found) return reply.code(404).send({ error: 'Unknown asset' });
            const etag = etags.get(request.params.file)!;
            reply.header('cache-control', request.query.v ? 'public, max-age=31536000, immutable' : 'no-cache')
                .header('etag', etag);
            if (request.headers['if-none-match'] === etag) return reply.code(304).send();
            return reply.type(found.contentType).send(found.body);
        });

        app.get<{ Params: { udid: string } }>('/api/devices/:udid/fragments/summary', async (request, reply) => {
            const device = (await discoverConnectedDevices()).find(({ udid }) => udid === request.params.udid);
            if (!device) {
                return reply.type('text/html').send('<section id="device-summary" class="bl-device-summary is-error">'
                    + '<span class="bl-state error"><span class="bl-dot error"></span>offline</span>'
                    + '<span class="bl-muted">This phone is not reachable right now.</span></section>');
            }
            const android = await androidDevice(device.udid);
            // Android has no WebDriverAgent to ask; its screen comes from the device's own driver.
            const screen = android
                ? await createDriver(android).screen()
                : await remote.getScreenInfo(device.udid).then(({ screenSize, scale }) => ({ ...screenSize, scale }));
            const registered = (await loadRegisteredDevices()).find(({ udid }) => udid === device.udid);
            const units = devicePlatform(device) === 'android' ? 'pixels' : 'points';
            return reply.type('text/html').send(`<section id="device-summary" class="bl-device-summary" data-screen-width="${screen.width}" data-screen-height="${screen.height}" data-platform="${escapeHtml(devicePlatform(device))}" data-driver="${escapeHtml(registered ? driverKindOf(registered) : 'wda')}"><div class="bl-rows"><div><span>Platform</span><span>${escapeHtml(osLabel(device))}</span></div><div><span>Driver</span><span>${escapeHtml(registered ? driverKindOf(registered) : 'wda')}</span></div><div><span>Screen</span><span>${screen.width} × ${screen.height} ${units} · ${screen.scale}×</span></div><div><span>Identifier</span><span class="bl-faint">${escapeHtml(device.udid)}</span></div></div></section>`);
        });
        app.get<{ Params: { udid: string } }>('/api/devices/:udid/fragments/activity', async (request, reply) => {
            return reply.type('text/html').send(await renderActivity(request.params.udid));
        });
        // The wall's right-hand column, so selecting a tile is one small fetch.
        app.get<{ Params: { udid: string } }>('/api/fragments/inspector/:udid', async (request, reply) => {
            const device = await wallDevice(request.params.udid);
            if (!device) return reply.code(404).type('text/html').send(renderInspector(undefined));
            return reply.type('text/html')
                .send(renderInspector(device, await inspectorLog(options.scheduler, device.udid)));
        });
        app.get<{ Params: { udid: string } }>('/api/fragments/inspector/:udid/run', async (request, reply) => {
            const device = await wallDevice(request.params.udid);
            if (!device) return reply.code(404).send({ error: 'Device not found' });
            return reply.type('text/html')
                .send(renderInspectorRun(device, await inspectorLog(options.scheduler, device.udid)));
        });
    }

    /** One phone in the wall's shape, for the inspector fragments. */
    async function wallDevice(udid: string): Promise<WallDevice | undefined> {
        const read = await readFleet(wallSources());
        return toWallDevices(read).find((device) => device.udid === udid);
    }

    app.get<{ Querystring: { device?: string } }>('/', async (request, reply) => {
        const data = await collectWall({
            ...wallSources(),
            ...(request.query.device ? { selectedUdid: request.query.device } : {}),
        });
        return reply.type('text/html').send(await shell(request, {
            title: 'Control Center', active: 'control',
            body: renderControlCenter(data),
            toolbar: wallToolbar(),
            toolbarRight: `${wallToolbarRight()}${AVATAR}`,
            head: `${scriptTag('wall.js')}<link rel="stylesheet" href="/assets/pages.css">`,
        }, data.read));
    });

    app.get('/devices', async (request, reply) => {
        const read = await readFleet(wallSources());
        return reply.type('text/html').send(await shell(request, {
            title: 'Devices', active: 'devices',
            body: renderDevicesPage(toWallDevices(read)),
            toolbar: `<a class="bl-btn bl-btn-primary" href="/devices/register">${icon('plus')}Register a device</a>`,
        }, read));
    });

    app.get('/devices/register', async (request, reply) => {
        const body = themed?.registerDeviceHtml
            ?? '<div class="bl-page"><p>Use <code>POST /api/device-registrations</code> to start device setup.</p></div>';
        return reply.type('text/html').send(await shell(request, {
            title: 'Register a device', active: 'devices', body,
            toolbar: `<a class="bl-btn" href="/devices">${icon('chevronLeft')}All devices</a>`,
            head: themed ? scriptTag('register-device.js') : '',
        }));
    });

    app.get<{ Params: { udid: string } }>('/devices/:udid', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) {
            return reply.code(404).type('text/html')
                .send(renderPage('Device not found', '<div class="bl-empty"><span>No phone is registered under that identifier.</span><a class="bl-btn" href="/devices">All devices</a></div>'));
        }
        const read = await readFleet(wallSources());
        const wall = toWallDevices(read).find(({ udid }) => udid === device.udid);
        const number = wall ? slotNumber(wall.slot) : '';
        if (themed) {
            const rendered = options.dashboardTheme?.renderDevice
                ? options.dashboardTheme.renderDevice(themed.deviceHtml, device) : themed.deviceHtml;
            const panels: string[] = [];
            for (const plugin of options.plugins.list()) {
                for (const panel of [...(plugin.devicePanels ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
                    try {
                        panels.push(`<section class="bl-panel" data-plugin="${escapeHtml(plugin.id)}"><div class="bl-panel-head">${escapeHtml(panel.title)}</div><div class="bl-panel-body">${await readFile(panel.fragmentPath, 'utf8')}</div></section>`);
                    } catch (error) {
                        panels.push(`<section class="bl-panel"><div class="bl-panel-head">${escapeHtml(panel.title)}</div><div class="bl-panel-body bl-muted">This panel is unavailable: ${escapeHtml(errorMessage(error))}</div></section>`);
                    }
                }
            }
            const body = rendered
                .replaceAll('__DEVICE_UDID__', encodeURIComponent(device.udid))
                .replaceAll('__DEVICE_NUMBER__', escapeHtml(number))
                .replaceAll('__DEVICE_NAME__', escapeHtml(device.name))
                .replaceAll('__DEVICE_PLATFORM__', platformOf(device) === 'android' ? 'Android' : 'iOS')
                .replaceAll('__HARDWARE_COLUMN__', hardwareColumn(platformOf(device) === 'android' ? 'android' : 'ios'))
                .replaceAll('__VIEWER__', wall ? viewer(wall, 'live') : '')
                .replaceAll('__PLUGIN_PANELS__', panels.join(''));
            return reply.type('text/html').send(await shell(request, {
                title: `${number} ${device.name}`.trim(), active: 'devices', body,
                toolbar: `<a class="bl-btn" href="/">${icon('chevronLeft')}Control Center</a>`,
                toolbarRight: wall ? stateBadge(wall.state) : '',
                head: `${scriptTag('device.js')}<link rel="stylesheet" href="/assets/pages.css">`,
            }, read));
        }
        return reply.type('text/html').send(renderPage(device.name,
            `<p class="bl-muted">${escapeHtml(device.udid)}</p><p>The dashboard theme is not configured, so this page has no controls.</p>`));
    });

    app.get('/rig', async (request, reply) => {
        const context = await chrome(request);
        return reply.type('text/html').send(shellContext.renderWith({
            title: 'Rig', active: 'rig',
            body: renderRigPage(rigServices(context.facts)),
            toolbarRight: `<span>${escapeHtml(context.rig.headline)}</span>`,
        }, context));
    });

    app.get('/alerts', async (request, reply) => {
        const store = events();
        const list = store ? await store.list({ limit: 100 }).catch(() => [] as FarmEvent[]) : [];
        const unread = await unreadAlerts(request);
        return reply.type('text/html').send(await shell(request, {
            title: 'Alerts', active: 'alerts',
            body: renderAlertsPage(list, unread),
            toolbar: '<button type="button" class="bl-btn" data-ack-all>Acknowledge all</button>',
        }));
    });

    app.get('/accounts', async (request, reply) => {
        const read = await readFleet(wallSources());
        const devices = toWallDevices(read);
        const rows = accountRows(devices);
        return reply.type('text/html').send(await shell(request, {
            title: 'Accounts', active: 'accounts',
            head: personaHead(),
            body: renderAccountsPage(rows, devices) + renderPersonaSection(rows.map(({ handle }) => handle)),
        }, read));
    });

    app.get<{ Querystring: { theme?: string } }>('/settings', async (request, reply) => {
        if (request.query.theme === 'auto' || request.query.theme === 'light') {
            reply.setCookie(THEME_COOKIE, request.query.theme, { path: '/', httpOnly: false, sameSite: 'lax' });
            return reply.redirect('/settings');
        }
        const origin = process.env.PUBLIC_ORIGIN ?? `http://${request.headers.host ?? '127.0.0.1:3000'}`;
        const mcpConfig = JSON.stringify({
            mcpServers: { backline: { command: 'npm', args: ['run', 'mcp'], env: { FARM_BASE_URL: origin } } },
        }, null, 2);
        return reply.type('text/html').send(await shell(request, {
            title: 'Settings', active: 'settings',
            body: renderSettingsPage({ theme: themeOf(request), mcpConfig, origin }),
        }));
    });

    app.get('/docs', async (request, reply) => reply.type('text/html').send(await shell(request, {
        title: 'API', active: 'settings',
        body: '<div class="bl-page bl-page-narrow"><section class="bl-panel"><div class="bl-panel-body">'
            + '<p>Use <code>/api/devices</code>, <code>/api/schedules</code>, <code>/api/executions</code> and '
            + '<code>/api/events</code>. Every route follows the configured authentication policy.</p>'
            + '</div></section></div>',
    })));
    // The Rig page links here when a service is not running; the docs live in the repo.
    app.get<{ Params: { page: string } }>('/docs/:page', async (request, reply) => {
        if (!DOC_PAGES.includes(request.params.page)) return reply.code(404).send({ error: 'No such document' });
        let markdown: string;
        try {
            markdown = await readFile(fileURLToPath(new URL(`../../docs/${request.params.page}.md`, import.meta.url)), 'utf8');
        } catch {
            return reply.code(404).send({ error: 'No such document' });
        }
        return reply.type('text/html').send(await shell(request, {
            title: request.params.page.replaceAll('-', ' '), active: 'rig',
            body: `<div class="bl-page bl-page-narrow"><pre class="bl-code">${escapeHtml(markdown)}</pre></div>`,
            toolbar: `<a class="bl-btn" href="/rig">${icon('chevronLeft')}Rig</a>`,
        }));
    });

    app.setErrorHandler((error, request, reply) => {
        request.log.error(error);
        void reply.code(clientStatus(error)).send({ error: clientErrorMessage(error) });
    });
    return app;
}
