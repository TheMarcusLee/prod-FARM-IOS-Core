import { app, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';

import { createFleet, type Fleet } from './fleet.ts';
import { buildDiagnostics, writeDiagnosticsZip } from './diagnostics.ts';
import { resetEmbeddedPostgres } from './embedded-postgres.ts';
import { JobRunner } from './jobs.ts';
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

/** A second launch should raise the existing app, not start a second fleet. */
if (!smokeMode && !app.requestSingleInstanceLock()) {
    app.quit();
}

let paths: AppPaths;
let settingsStore: SettingsStore;
let fleet: Fleet;
let jobs: JobRunner;
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
    }
    tray?.render(snapshot);
    windows?.broadcast('fleet:changed', snapshot);
}

/** Rebuilds the fleet from the current settings; used after a settings change. */
function rebuildFleet(settings: Settings): void {
    fleet.logs.close();
    fleet = createFleet(paths, settings);
    fleet.supervisor.on('change', onFleetChanged);
    fleet.supervisor.on('log', () => windows?.broadcast('fleet:changed', currentSnapshot()));
    dashboardUrl = null;
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
    ipcMain.handle('fleet:open-logs', async (_event, id: string) => {
        const logPath = fleet.logs.pathFor(String(id));
        await shell.openPath(logPath);
    });
    ipcMain.handle('app:open-help', async (_event, anchor: string) => {
        // Anchors are `<repo-relative path>[#fragment]`; openPath cannot use the
        // fragment, so only the file is opened. Never leaves the checkout.
        const file = String(anchor).split('#')[0] ?? '';
        const target = path.resolve(fleet.context.paths.repoRoot, file);
        if (!target.startsWith(fleet.context.paths.repoRoot)) return;
        await shell.openPath(target);
    });
    ipcMain.handle('app:open-dashboard', () => {
        if (dashboardUrl) windows?.loadDashboard(dashboardUrl);
        else windows?.showMain();
    });
    ipcMain.handle('app:open-services', () => { windows?.showServices(); });
    ipcMain.handle('app:open-settings', () => { windows?.showSettings(); });
    ipcMain.handle('app:open-data-folder', () => shell.openPath(paths.userData));
    ipcMain.handle('app:export-diagnostics', () => exportDiagnostics());

    ipcMain.handle('job:run-wda-prepare', (_event, udid: unknown) => runWdaPrepare(udid));
    ipcMain.handle('job:cancel', (_event, id: string) => jobs.cancel(String(id)));
    ipcMain.handle('job:dismiss', (_event, id: string) => { jobs.dismiss(String(id)); });
    ipcMain.handle('job:open', (_event, id: string) => { windows?.showJob(String(id)); });

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
            buttons: ['Cancel', 'Delete the database'],
            defaultId: 0,
            cancelId: 0,
            title: 'Reset the embedded database',
            message: 'Delete every device, schedule and execution stored in the bundled Postgres?',
            detail: `This permanently removes ${paths.postgresDataDir}. It cannot be undone.`,
        });
        if (choice.response !== 1) return { ok: false, message: 'Cancelled.' };
        await fleet.supervisor.stopAll();
        await resetEmbeddedPostgres(paths.postgresDataDir);
        rebuildFleet(settingsStore.get());
        return { ok: true, message: 'The embedded database was deleted. Start the fleet to recreate it.' };
    });
}

/**
 * Runs the one-off WebDriverAgent build as a supervised job and opens its window
 * so the operator watches the xcodebuild output rather than a spinner.
 */
async function runWdaPrepare(udid: unknown): Promise<{ ok: boolean; message: string }> {
    const trimmed = typeof udid === 'string' ? udid.trim() : '';
    const target: WdaPrepareTarget = trimmed ? { kind: 'udid', udid: trimmed } : { kind: 'all' };
    if (jobs.isRunning(WDA_PREPARE_JOB_ID)) {
        windows?.showJob(WDA_PREPARE_JOB_ID);
        return { ok: false, message: 'The WebDriverAgent build is already running.' };
    }
    windows?.showJob(WDA_PREPARE_JOB_ID);
    const result = await jobs.run(wdaPrepareJob(fleet.context, target));
    return { ok: result?.state === 'succeeded', message: result?.detail ?? 'The job did not start.' };
}

async function exportDiagnostics(): Promise<{ ok: boolean; message: string }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const chosen = await dialog.showSaveDialog({
        title: 'Export diagnostics',
        defaultPath: path.join(app.getPath('desktop'), `phone-farm-diagnostics-${stamp}.zip`),
        filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    });
    if (chosen.canceled || !chosen.filePath) return { ok: false, message: 'Cancelled.' };
    try {
        await writeDiagnosticsZip(
            chosen.filePath,
            buildDiagnostics({
                settings: settingsStore.get(),
                snapshot: currentSnapshot(),
                appVersion: app.getVersion(),
                repoRoot: paths.repoRoot,
                userData: paths.userData,
                compiled: paths.compiled,
            }),
            fleet.logs,
            fleet.supervisor.ids(),
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
    await fleet.supervisor.stopAll();
    fleet.logs.close();
}

function noop(): void { /* errors are already reflected in the service state */ }

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
    // Jobs outlive a fleet rebuild on purpose: a running WebDriverAgent build must
    // not be forgotten because the operator saved Settings.
    jobs = new JobRunner();
    fleet = createFleet(paths, settingsStore.get());

    if (smokeMode) {
        const code = await runSmoke(fleet.supervisor, `http://127.0.0.1:${settingsStore.get().webPort}`);
        await fleet.supervisor.stopAll();
        fleet.logs.close();
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
