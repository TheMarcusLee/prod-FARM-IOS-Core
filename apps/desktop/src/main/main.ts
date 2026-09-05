import { app, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';

import { createFleet, type Fleet } from './fleet.ts';
import { buildDiagnostics, secretScrubber, secretsOf, writeDiagnosticsZip } from './diagnostics.ts';
import { resetEmbeddedPostgres } from './embedded-postgres.ts';
import { JobRunner } from './jobs.ts';
import { MCP_TOKEN_PLACEHOLDER, mcpConfig } from './mcp-config.ts';
import { MIGRATION_STAMP_FILE } from './services/migrations.ts';
import { clearStamp } from './migration-stamp.ts';
import { ChildRegistry } from './orphans.ts';
import { setChildRegistry } from './process.ts';
import { appPaths, resolveRepoRoot, type AppPaths } from './paths.ts';
import { WDA_PREPARE_JOB_ID, wdaPrepareJob, type WdaPrepareTarget } from './services/wda-prepare.ts';
import { SettingsStore, type Settings } from './settings.ts';
import { runSmoke } from './smoke.ts';
import { FleetTray } from './tray.ts';
import type { FleetSnapshot } from './types.ts';
import { WindowManager } from './windows.ts';

const smokeMode = process.argv.includes('--smoke');

// Set before any getPath('userData') call: it decides the data directory, and a
// scoped npm package name would otherwise produce "Application Support/@scope/…".
app.setName('Phone Farm');

/**
 * A second launch should raise the existing app, not start a second fleet.
 *
 * `app.exit` and not `app.quit`: quit is asynchronous, so `whenReady` still fired
 * and `bootstrap` still ran — the second instance spawned a whole second set of
 * services, which then fought the first for the web and Appium ports and, worse,
 * wrote to the same Postgres data directory. `app.exit` stops here and now.
 */
if (!smokeMode && !app.requestSingleInstanceLock()) {
    app.exit(0);
}

let paths: AppPaths;
let settingsStore: SettingsStore;
let fleet: Fleet;
let jobs: JobRunner;
let children: ChildRegistry;
let windows: WindowManager | null = null;
let tray: FleetTray | null = null;
let quitting = false;
let dashboardUrl: string | null = null;

function currentSnapshot(): FleetSnapshot {
    return fleet.supervisor.snapshot(dashboardUrl, jobs.list());
}

function onFleetChanged(): void {
    const snapshot = currentSnapshot();
    const web = snapshot.services.find((service) => service.id === 'web');
    if (web?.state === 'healthy') {
        dashboardUrl = `http://127.0.0.1:${settingsStore.get().webPort}`;
        snapshot.dashboardUrl = dashboardUrl;
        windows?.loadDashboard(dashboardUrl);
    } else if (web && web.state !== 'stopping') {
        dashboardUrl = null;
        snapshot.dashboardUrl = null;
        // The dashboard origin stops being loadable the moment `web` is not there.
        windows?.forgetDashboard();
    }
    tray?.render(snapshot);
    windows?.broadcast('fleet:changed', snapshot);
}

/** Rebuilds the fleet from the current settings; used after a settings change. */
function rebuildFleet(settings: Settings): void {
    fleet.logs.close();
    fleet = createFleet(paths, settings, app.getVersion());
    fleet.supervisor.on('change', onFleetChanged);
    fleet.supervisor.on('log', () => windows?.broadcast('fleet:changed', currentSnapshot()));
    dashboardUrl = null;
    windows?.forgetDashboard();
    onFleetChanged();
}

function registerIpc(): void {
    ipcMain.handle('fleet:get', () => currentSnapshot());
    ipcMain.handle('fleet:start', (_event, id: string) => fleet.supervisor.start(String(id)).catch(noop));
    ipcMain.handle('fleet:stop', (_event, id: string) => fleet.supervisor.stop(String(id)).catch(noop));
    ipcMain.handle('fleet:restart', (_event, id: string) => fleet.supervisor.restart(String(id)).catch(noop));
    ipcMain.handle('fleet:start-all', () => fleet.supervisor.startAll().catch(noop));
    ipcMain.handle('fleet:stop-all', () => fleet.supervisor.stopAll().catch(noop));
    ipcMain.handle('fleet:restart-all', () => fleet.supervisor.restartAll().catch(noop));
    ipcMain.handle('fleet:open-logs', async (_event, id: unknown) => {
        // `pathFor` is a plain join, so an id straight from the renderer would be a
        // path the renderer chose. Only ids the supervisor actually declares are
        // ever turned into a path, and shell.openPath then only sees our own dir.
        const serviceId = knownServiceId(id);
        if (!serviceId) return;
        await shell.openPath(fleet.logs.pathFor(serviceId));
    });
    ipcMain.handle('app:open-help', async (_event, anchor: unknown) => {
        // Anchors are `<repo-relative path>[#fragment]`; openPath cannot use the
        // fragment, so only the file is opened. The renderer never picks the path:
        // only the anchors the service definitions themselves declare are honoured.
        const file = String(anchor ?? '').split('#')[0] ?? '';
        if (!helpAnchors().has(file)) return;
        await shell.openPath(path.join(fleet.context.paths.repoRoot, file));
    });
    ipcMain.handle('app:open-dashboard', () => {
        if (dashboardUrl) windows?.loadDashboard(dashboardUrl);
        else windows?.showMain();
    });
    ipcMain.handle('app:open-services', () => { windows?.showServices(); });
    ipcMain.handle('app:open-settings', () => { windows?.showSettings(); });
    ipcMain.handle('app:open-data-folder', () => shell.openPath(paths.userData));
    ipcMain.handle('app:export-diagnostics', () => exportDiagnostics());
    ipcMain.handle('app:copy-mcp-config', () => copyMcpConfig());
    ipcMain.handle('app:copy-dashboard-url', () => {
        if (!dashboardUrl) return { ok: false, message: 'The dashboard is not running yet.' };
        clipboard.writeText(dashboardUrl);
        return { ok: true, message: `Copied ${dashboardUrl}` };
    });

    ipcMain.handle('job:run-wda-prepare', (_event, udid: unknown) => runWdaPrepare(udid));
    ipcMain.handle('job:cancel', (_event, id: unknown) => jobs.cancel(knownJobId(id) ?? ''));
    ipcMain.handle('job:dismiss', (_event, id: unknown) => { jobs.dismiss(knownJobId(id) ?? ''); });
    ipcMain.handle('job:open', (_event, id: unknown) => {
        const jobId = knownJobId(id);
        if (jobId) windows?.showJob(jobId);
    });

    ipcMain.handle('settings:get', () => settingsStore.get());
    ipcMain.handle('settings:save', async (_event, patch: Partial<Settings>) => {
        const before = settingsStore.get();
        const settings = settingsStore.update(sanitisePatch(patch));
        applyLoginItem(settings.launchAtLogin);
        const restartRequired = requiresRestart(before, settings);
        if (restartRequired) {
            await fleet.supervisor.stopAll();
            rebuildFleet(settings);
        }
        return { settings, restartRequired };
    });
    ipcMain.handle('settings:reset-database', async () => {
        if (settingsStore.get().databaseUrl.trim()) {
            return { ok: false, message: 'An external DATABASE_URL is configured; the app will not touch that server.' };
        }
        const choice = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Cancel', 'Reset the database'],
            defaultId: 0,
            cancelId: 0,
            checkboxLabel: 'I understand every device, schedule and execution will be gone',
            title: 'Reset the embedded database',
            message: 'Start again with an empty database?',
            detail: `The fleet will be stopped and ${paths.postgresDataDir} moved aside to a `
                + 'dated backup folder next to it, so nothing is deleted and you can put it '
                + 'back. The farm itself starts again empty.',
        });
        // Two deliberate acts: the destructive button, and the acknowledgement. This
        // is the one action in the app that throws the operator's whole farm away.
        if (choice.response !== 1 || !choice.checkboxChecked) return { ok: false, message: 'Cancelled.' };
        await fleet.supervisor.stopAll();
        let backupDir: string | null;
        try {
            ({ backupDir } = await resetEmbeddedPostgres(paths.postgresDataDir, paths.userData));
            // The new, empty cluster has none of the migrations the stamp claims.
            clearStamp(path.join(paths.userData, MIGRATION_STAMP_FILE));
        } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
        rebuildFleet(settingsStore.get());
        return {
            ok: true,
            message: backupDir
                ? `The old database was moved to ${backupDir}. Start the fleet to create an empty one.`
                : 'There was no database to reset. Start the fleet to create one.',
        };
    });
}

/**
 * Runs the one-off WebDriverAgent build as a supervised job and opens its window
 * so the operator watches the xcodebuild output rather than a spinner.
 */
async function runWdaPrepare(udid: unknown): Promise<{ ok: boolean; message: string }> {
    const trimmed = typeof udid === 'string' ? udid.trim() : '';
    // The udid becomes an argv entry of a spawned build. Anything that is not a
    // real device identifier — a leading dash above all — is refused rather than
    // handed to the child as a flag it might act on.
    if (trimmed && !UDID_PATTERN.test(trimmed)) {
        return { ok: false, message: `"${trimmed}" is not a device UDID.` };
    }
    const target: WdaPrepareTarget = trimmed ? { kind: 'udid', udid: trimmed } : { kind: 'all' };
    if (jobs.isRunning(WDA_PREPARE_JOB_ID)) {
        windows?.showJob(WDA_PREPARE_JOB_ID);
        return { ok: false, message: 'The WebDriverAgent build is already running.' };
    }
    windows?.showJob(WDA_PREPARE_JOB_ID);
    const result = await jobs.run(wdaPrepareJob(fleet.context, target));
    return { ok: result?.state === 'succeeded', message: result?.detail ?? 'The job did not start.' };
}

/** Puts a ready-to-paste MCP client entry on the clipboard. */
function copyMcpConfig(): { ok: boolean; message: string } {
    const url = dashboardUrl ?? `http://127.0.0.1:${settingsStore.get().webPort}`;
    clipboard.writeText(mcpConfig(url));
    return {
        ok: true,
        message: `Copied the MCP entry for ${url}/mcp — replace ${MCP_TOKEN_PLACEHOLDER} with an API token.`,
    };
}

async function exportDiagnostics(): Promise<{ ok: boolean; message: string }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const chosen = await dialog.showSaveDialog({
        title: 'Export diagnostics',
        defaultPath: path.join(app.getPath('desktop'), `phone-farm-diagnostics-${stamp}.zip`),
        filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    });
    if (chosen.canceled || !chosen.filePath) return { ok: false, message: 'Cancelled.' };
    const settings = settingsStore.get();
    try {
        await writeDiagnosticsZip(
            chosen.filePath,
            buildDiagnostics({
                settings,
                databaseUrl: fleet.context.databaseUrl,
                snapshot: currentSnapshot(),
                appVersion: app.getVersion(),
                repoRoot: paths.repoRoot,
                userData: paths.userData,
                compiled: paths.compiled,
            }),
            fleet.logs,
            fleet.supervisor.ids(),
            secretScrubber(secretsOf(settings, fleet.context.databaseUrl)),
        );
        return { ok: true, message: `Wrote ${chosen.filePath}` };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}

/** Only settings that change how children are spawned need a fleet restart. */
function requiresRestart(before: Settings, after: Settings): boolean {
    const keys: (keyof Settings)[] = [
        'webPort', 'appiumPort', 'databaseUrl', 'embeddedPostgresPort', 'plugins', 'authPlugin',
        'tiktokBundleId', 'iosPlatformVersion', 'xcodeOrgId', 'xcodeSigningId', 'wdaBundleId', 'androidDiscovery',
    ];
    return keys.some((key) => before[key] !== after[key]);
}

function sanitisePatch(patch: unknown): Partial<Settings> {
    if (!patch || typeof patch !== 'object') return {};
    const input = patch as Record<string, unknown>;
    const allowed: (keyof Settings)[] = [
        'webPort', 'appiumPort', 'databaseUrl', 'embeddedPostgresPort', 'plugins', 'authPlugin',
        'tiktokBundleId', 'iosPlatformVersion', 'xcodeOrgId', 'xcodeSigningId', 'wdaBundleId',
        'androidDiscovery', 'launchAtLogin',
    ];
    const out: Record<string, unknown> = {};
    for (const key of allowed) if (key in input) out[key] = input[key];
    return out as Partial<Settings>;
}

function buildMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { label: 'Settings…', accelerator: 'Cmd+,', click: () => windows?.showSettings() },
                { type: 'separator' },
                { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        {
            label: 'Farm',
            submenu: [
                { label: 'Services', accelerator: 'Cmd+Shift+S', click: () => windows?.showServices() },
                { label: 'Dashboard', accelerator: 'Cmd+D', click: () => { if (dashboardUrl) windows?.loadDashboard(dashboardUrl); } },
                { type: 'separator' },
                { label: 'Start all', click: () => void fleet.supervisor.startAll().catch(noop) },
                { label: 'Stop all', click: () => void fleet.supervisor.stopAll().catch(noop) },
                { label: 'Restart all', click: () => void fleet.supervisor.restartAll().catch(noop) },
                { type: 'separator' },
                { label: 'Prepare WebDriverAgent…', click: () => void runWdaPrepare(null) },
                { type: 'separator' },
                { label: 'Copy MCP config', click: () => { copyMcpConfig(); } },
                { type: 'separator' },
                { label: 'Open data folder', click: () => void shell.openPath(paths.userData) },
                { label: 'Export diagnostics…', click: () => void exportDiagnostics() },
            ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        {
            role: 'help',
            submenu: [
                {
                    label: 'Desktop documentation',
                    click: () => void shell.openPath(path.join(fleet.context.paths.repoRoot, 'docs', 'desktop.md')),
                },
            ],
        },
    ]));
}

async function shutdown(): Promise<void> {
    if (quitting) return;
    quitting = true;
    tray?.destroy();
    // Bootstrap may not have got this far; a shutdown must still be a clean exit.
    if (!fleet) return;
    await fleet.supervisor.stopAll();
    fleet.logs.close();
    // Only now: anything still in the file after this point is a genuine orphan.
    children?.clear();
}

function noop(): void { /* errors are already reflected in the service state */ }

/** iOS UDIDs are hex, or the 24-character `<8>-<16>` form; nothing else is accepted. */
export const UDID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$|^[0-9a-f]{25,40}$/;

/** The id, when the supervisor really declares it; null otherwise. */
function knownServiceId(id: unknown): string | null {
    const wanted = String(id ?? '');
    return fleet.supervisor.ids().includes(wanted) ? wanted : null;
}

/** Only jobs this app knows how to run are addressable from the renderer. */
function knownJobId(id: unknown): string | null {
    return String(id ?? '') === WDA_PREPARE_JOB_ID ? WDA_PREPARE_JOB_ID : null;
}

/** Every `help` anchor the service definitions declare, plus the app's own docs. */
function helpAnchors(): Set<string> {
    const anchors = new Set(['docs/desktop.md']);
    for (const id of fleet.supervisor.ids()) {
        const help = fleet.supervisor.definitionOf(id).help;
        if (help) anchors.add(help.split('#')[0] ?? '');
    }
    anchors.delete('');
    return anchors;
}

/**
 * An unsigned development build cannot register a login item, and macOS reports
 * that as a hard error. It must never take the app down with it.
 */
function applyLoginItem(openAtLogin: boolean): void {
    try {
        // Writing the login item needs a signed bundle; skip the no-op write so an
        // unsigned development build stays quiet.
        if (app.getLoginItemSettings().openAtLogin === openAtLogin) return;
        app.setLoginItemSettings({ openAtLogin });
    } catch (error) {
        console.warn(`Could not update the login item: ${String(error)}`);
    }
}

async function bootstrap(): Promise<void> {
    const repoRoot = resolveRepoRoot(app.getAppPath(), process.resourcesPath, app.isPackaged);
    paths = appPaths(repoRoot, app.getPath('userData'));
    settingsStore = new SettingsStore(paths.userData);

    // Before a single child is spawned: a crash or a force-quit of the previous run
    // left its services running (they are `detached`, in their own process groups),
    // and they would otherwise hold the web and Appium ports against this launch.
    children = new ChildRegistry(paths.userData);
    for (const orphan of children.reapPrevious()) {
        console.warn(`Killed a leftover ${orphan.label} (pid ${orphan.pid}) from a previous run.`);
    }
    setChildRegistry(children);

    // Jobs outlive a fleet rebuild on purpose: a running WebDriverAgent build must
    // not be forgotten because the operator saved Settings.
    jobs = new JobRunner();
    fleet = createFleet(paths, settingsStore.get(), app.getVersion());

    if (smokeMode) {
        const code = await runSmoke(fleet.supervisor, `http://127.0.0.1:${settingsStore.get().webPort}`);
        await fleet.supervisor.stopAll();
        fleet.logs.close();
        children.clear();
        app.exit(code);
        return;
    }

    windows = new WindowManager();
    jobs.on('change', onFleetChanged);
    fleet.supervisor.on('change', onFleetChanged);
    fleet.supervisor.on('log', () => windows?.broadcast('fleet:changed', currentSnapshot()));

    registerIpc();
    buildMenu();
    tray = new FleetTray({
        openDashboard: () => { if (dashboardUrl) windows?.loadDashboard(dashboardUrl); else windows?.showMain(); },
        openServices: () => windows?.showServices(),
        openSettings: () => windows?.showSettings(),
        startAll: () => void fleet.supervisor.startAll().catch(noop),
        stopAll: () => void fleet.supervisor.stopAll().catch(noop),
        restartAll: () => void fleet.supervisor.restartAll().catch(noop),
        openDataFolder: () => void shell.openPath(paths.userData),
        quit: () => app.quit(),
    });
    tray.attach();
    windows.showMain();
    applyLoginItem(settingsStore.get().launchAtLogin);
    onFleetChanged();
    await fleet.supervisor.startAll().catch(noop);
}

app.on('second-instance', () => { windows?.showMain(); });
app.on('window-all-closed', () => { /* the tray keeps the fleet running */ });
app.on('activate', () => { windows?.showMain(); });

// A signal (a `kill`, a launchd stop) must still tear the fleet down; without this
// the child processes would outlive the app.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void shutdown().finally(() => app.exit(0)); });
}

app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void shutdown().finally(() => app.exit(0));
});

void app.whenReady().then(bootstrap).catch((error: unknown) => {
    dialog.showErrorBox('Phone Farm could not start', error instanceof Error ? error.stack ?? error.message : String(error));
    app.exit(1);
});
