import { app, Menu, Tray, nativeImage, type NativeImage } from 'electron';
import path from 'node:path';

import { serviceWord } from './state-words.ts';
import type { FleetSnapshot, ServiceSnapshot } from './types.ts';

export interface TrayActions {
    openDashboard(): void;
    openServices(): void;
    openSettings(): void;
    startAll(): void;
    stopAll(): void;
    restartAll(): void;
    openDataFolder(): void;
    quit(): void;
}

/**
 * Menu-bar item with a one-line fleet summary and the two bulk actions.
 * The icon is drawn as a template image so macOS inverts it for dark menu bars.
 */
export class FleetTray {
    private tray: Tray | null = null;

    private readonly actions: TrayActions;

    constructor(actions: TrayActions) {
        this.actions = actions;
    }

    attach(): void {
        if (this.tray) return;
        this.tray = new Tray(trayIcon());
        this.tray.setToolTip('Backline');
        this.render({ services: [], jobs: [], dashboardUrl: null, shuttingDown: false });
    }

    render(snapshot: FleetSnapshot): void {
        if (!this.tray) return;
        const summary = summarize(snapshot.services);
        this.tray.setToolTip(`Backline — ${summary}`);
        this.tray.setTitle(snapshot.services.length ? indicator(snapshot.services) : '');
        this.tray.setContextMenu(Menu.buildFromTemplate([
            { label: summary, enabled: false },
            { type: 'separator' },
            ...snapshot.services.map((service) => ({
                label: `${stateGlyph(service)}  ${service.label} — ${serviceWord(service.state)}`,
                enabled: false,
            })),
            { type: 'separator' },
            { label: 'Open dashboard', click: () => this.actions.openDashboard(), enabled: snapshot.dashboardUrl !== null },
            { label: 'Rig', click: () => this.actions.openServices() },
            { label: 'Settings…', click: () => this.actions.openSettings() },
            { type: 'separator' },
            { label: 'Start all', click: () => this.actions.startAll(), enabled: !snapshot.shuttingDown },
            { label: 'Stop all', click: () => this.actions.stopAll(), enabled: !snapshot.shuttingDown },
            { label: 'Restart all', click: () => this.actions.restartAll(), enabled: !snapshot.shuttingDown },
            { type: 'separator' },
            { label: 'Open data folder', click: () => this.actions.openDataFolder() },
            { type: 'separator' },
            { label: 'Quit Backline', click: () => this.actions.quit() },
        ]));
    }

    destroy(): void {
        this.tray?.destroy();
        this.tray = null;
    }
}

export function summarize(services: readonly ServiceSnapshot[]): string {
    if (services.length === 0) return 'starting…';
    const healthy = services.filter((service) => service.state === 'healthy').length;
    const failed = services.filter((service) => service.state === 'failed').length;
    const unconfigured = services.filter((service) => service.state === 'not-configured').length;
    const parts = [`${healthy}/${services.length} healthy`];
    if (failed) parts.push(`${failed} failed`);
    if (unconfigured) parts.push(`${unconfigured} not configured`);
    return parts.join(', ');
}

function indicator(services: readonly ServiceSnapshot[]): string {
    if (services.some((service) => service.state === 'failed')) return '!';
    if (services.some((service) => service.state === 'starting')) return '…';
    return '';
}

function stateGlyph(service: ServiceSnapshot): string {
    switch (service.state) {
        case 'healthy': return '●';
        case 'starting': case 'stopping': return '◐';
        case 'failed': return '✕';
        case 'not-configured': return '○';
        default: return '·';
    }
}

/**
 * The Backline mark for the menu bar: the `signal` glyph as a template image, so
 * macOS recolours it for a light or dark menu bar. `scripts/make-icon.mjs` draws
 * it and `scripts/build.mjs` copies it into dist/; the inline copy below is the
 * same three bars, and only ever runs if that file went missing.
 */
function trayIcon(): NativeImage {
    const file = path.join(app.getAppPath(), 'dist', 'tray', 'trayTemplate.png');
    const fromDisk = nativeImage.createFromPath(file);
    const image = fromDisk.isEmpty() ? nativeImage.createFromDataURL(
        `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" `
            + `viewBox="0 0 16 16" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" `
            + `stroke-linejoin="round"><path d="M3 12V6M8 12V3M13 12V8"/></svg>`).toString('base64')}`,
    ) : fromDisk;
    image.setTemplateImage(true);
    return image;
}
