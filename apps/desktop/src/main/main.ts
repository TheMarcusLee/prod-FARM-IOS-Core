import { app, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';

import { createFleet, type Fleet } from './fleet.ts';
import { resetEmbeddedPostgres } from './embedded-postgres.ts';
import { appPaths, resolveRepoRoot, type AppPaths } from './paths.ts';
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
let windows: WindowManager | null = null;
let tray: FleetTray | null = null;
let quitting = false;
let dashboardUrl: string | null = null;

function currentSnapshot(): FleetSnapshot {
    return fleet.supervisor.snapshot(dashboardUrl);
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
    fleet = createFleet(paths, settingsStore.get());

    if (smokeMode) {
        const code = await runSmoke(fleet.supervisor, `http://127.0.0.1:${settingsStore.get().webPort}`);
        await fleet.supervisor.stopAll();
        fleet.logs.close();
        app.exit(code);
        return;
    }

    windows = new WindowManager();
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
