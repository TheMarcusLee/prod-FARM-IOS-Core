import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import path from 'node:path';

// `getAppPath()` is the checkout in dev and app.asar once packaged; both contain dist/.
const distDir = path.join(app.getAppPath(), 'dist');
const preloadPath = path.join(distDir, 'preload', 'preload.cjs');
const rendererDir = path.join(distDir, 'renderer');

/**
 * Everything a window is allowed to load: the packaged renderer files, and — once
 * `web` is healthy — the loopback dashboard. Anything else (an `<a href>` inside
 * the dashboard, a redirect, a `window.open`) is refused and handed to the system
 * browser instead, so an app window can never end up showing remote content with
 * a preload bridge attached to it.
 */
export function isAllowedUrl(url: string, dashboardOrigin: string | null): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol === 'file:') return path.resolve(parsed.pathname).startsWith(`${rendererDir}${path.sep}`);
    if (!dashboardOrigin) return false;
    return parsed.origin === dashboardOrigin;
}

/** The window ground, so a cold window never flashes the wrong appearance. */
function backgroundColor(): string {
    return nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f4f5f7';
}

/** The title a job window opens with, before the renderer names it from the job. */
const JOB_TITLES: Record<string, string> = { 'wda-prepare': 'Prepare iPhones' };

/** Same hardening on every window: no node in the renderer, no remote code. */
function webPreferences() {
    return {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
    };
}

export class WindowManager {
    /** `http://127.0.0.1:<port>` while the dashboard is up; null otherwise. */
    private dashboardOrigin: string | null = null;

    private main: BrowserWindow | null = null;
    private services: BrowserWindow | null = null;
    private settings: BrowserWindow | null = null;
    private job: BrowserWindow | null = null;

    /** The dashboard window. Shows a local placeholder until `web` is healthy. */
    showMain(): BrowserWindow {
        if (this.main && !this.main.isDestroyed()) {
            this.main.show();
            this.main.focus();
            return this.main;
        }
        const window = new BrowserWindow({
            width: 1280,
            height: 860,
            title: 'Backline',
            backgroundColor: backgroundColor(),
            webPreferences: webPreferences(),
        });
        this.openExternalLinksInBrowser(window);
        void window.loadFile(path.join(rendererDir, 'starting.html'));
        window.on('closed', () => { this.main = null; });
        this.main = window;
        return window;
    }

    /** Point the main window at the dashboard once it answers /health. */
    loadDashboard(url: string): void {
        this.dashboardOrigin = new URL(url).origin;
        const window = this.showMain();
        if (window.webContents.getURL().startsWith(url)) return;
        void window.loadURL(url);
    }

    /** The Rig window: every service in plain words, and the worker's live log. */
    showServices(): BrowserWindow {
        this.services = this.showPanel(this.services, 'rig.html', 'Rig', 880, 620);
        return this.services;
    }

    showSettings(): BrowserWindow {
        this.settings = this.showPanel(this.settings, 'settings.html', 'Settings', 660, 760);
        return this.settings;
    }

    /** The log window for a one-shot job. The id travels in the URL fragment. */
    showJob(jobId: string): BrowserWindow {
        this.job = this.showPanel(this.job, 'job.html', JOB_TITLES[jobId] ?? 'Job', 880, 660, jobId);
        return this.job;
    }

    private showPanel(
        existing: BrowserWindow | null, file: string, title: string, width: number, height: number, hash?: string,
    ): BrowserWindow {
        if (existing && !existing.isDestroyed()) {
            existing.show();
            existing.focus();
            return existing;
        }
        const window = new BrowserWindow({
            width, height, title, backgroundColor: backgroundColor(), webPreferences: webPreferences(),
        });
        this.openExternalLinksInBrowser(window);
        void window.loadFile(path.join(rendererDir, file), hash ? { hash } : undefined);
        window.on('closed', () => {
            if (this.services === window) this.services = null;
            if (this.settings === window) this.settings = null;
            if (this.job === window) this.job = null;
        });
        return window;
    }

    broadcast(channel: string, payload: unknown): void {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send(channel, payload);
        }
    }

    /** The dashboard went away; stop treating its origin as loadable. */
    forgetDashboard(): void {
        this.dashboardOrigin = null;
    }

    /**
     * Never let a click inside the dashboard navigate an app window off-origin.
     *
     * `setWindowOpenHandler` alone only covers `window.open`/`target=_blank`: a
     * plain link, a `location =` or a redirect is a same-window navigation and
     * needs `will-navigate`. `will-frame-navigate` covers the same for iframes,
     * and `webContents-created` denies attaching anything else.
     */
    private openExternalLinksInBrowser(window: BrowserWindow): void {
        window.webContents.setWindowOpenHandler(({ url }) => {
            openExternally(url);
            return { action: 'deny' };
        });
        const guard = (event: { preventDefault(): void }, url: string): void => {
            if (isAllowedUrl(url, this.dashboardOrigin)) return;
            event.preventDefault();
            openExternally(url);
        };
        window.webContents.on('will-navigate', (event, url) => { guard(event, url); });
        window.webContents.on('will-frame-navigate', (event) => { guard(event, event.url); });
        window.webContents.on('will-attach-webview', (event) => { event.preventDefault(); });
    }
}

/** Only ever hand http(s) to the system browser: never file:, never a custom scheme. */
function openExternally(url: string): void {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}
