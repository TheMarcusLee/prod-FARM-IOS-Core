import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';

// `getAppPath()` is the checkout in dev and app.asar once packaged; both contain dist/.
const distDir = path.join(app.getAppPath(), 'dist');
const preloadPath = path.join(distDir, 'preload', 'preload.cjs');
const rendererDir = path.join(distDir, 'renderer');

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
    private main: BrowserWindow | null = null;
    private services: BrowserWindow | null = null;
    private settings: BrowserWindow | null = null;

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
            title: 'Phone Farm',
            backgroundColor: '#101014',
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
        const window = this.showMain();
        if (window.webContents.getURL().startsWith(url)) return;
        void window.loadURL(url);
    }

    showServices(): BrowserWindow {
        this.services = this.showPanel(this.services, 'services.html', 'Services', 620, 760);
        return this.services;
    }

    showSettings(): BrowserWindow {
        this.settings = this.showPanel(this.settings, 'settings.html', 'Settings', 640, 760);
        return this.settings;
    }

    private showPanel(
        existing: BrowserWindow | null, file: string, title: string, width: number, height: number,
    ): BrowserWindow {
        if (existing && !existing.isDestroyed()) {
            existing.show();
            existing.focus();
            return existing;
        }
        const window = new BrowserWindow({
            width, height, title, backgroundColor: '#101014', webPreferences: webPreferences(),
        });
        this.openExternalLinksInBrowser(window);
        void window.loadFile(path.join(rendererDir, file));
        window.on('closed', () => {
            if (this.services === window) this.services = null;
            if (this.settings === window) this.settings = null;
        });
        return window;
    }

    broadcast(channel: string, payload: unknown): void {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send(channel, payload);
        }
    }

    /** Never let a click inside the dashboard navigate an app window off-origin. */
    private openExternalLinksInBrowser(window: BrowserWindow): void {
        window.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:/.test(url)) void shell.openExternal(url);
            return { action: 'deny' };
        });
    }
}
