import { Menu, Tray, nativeImage, type NativeImage } from 'electron';

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
        this.tray.setToolTip('Phone Farm');
        this.render({ services: [], jobs: [], dashboardUrl: null, shuttingDown: false });
    }

    render(snapshot: FleetSnapshot): void {
        if (!this.tray) return;
        const summary = summarize(snapshot.services);
        this.tray.setToolTip(`Phone Farm — ${summary}`);
        this.tray.setTitle(snapshot.services.length ? indicator(snapshot.services) : '');
        this.tray.setContextMenu(Menu.buildFromTemplate([
            { label: summary, enabled: false },
            { type: 'separator' },
            ...snapshot.services.map((service) => ({
                label: `${stateGlyph(service)}  ${service.label} — ${service.state}`,
                enabled: false,
            })),
            { type: 'separator' },
            { label: 'Open dashboard', click: () => this.actions.openDashboard(), enabled: snapshot.dashboardUrl !== null },
            { label: 'Services…', click: () => this.actions.openServices() },
            { label: 'Settings…', click: () => this.actions.openSettings() },
            { type: 'separator' },
            { label: 'Start all', click: () => this.actions.startAll(), enabled: !snapshot.shuttingDown },
            { label: 'Stop all', click: () => this.actions.stopAll(), enabled: !snapshot.shuttingDown },
            { label: 'Restart all', click: () => this.actions.restartAll(), enabled: !snapshot.shuttingDown },
            { type: 'separator' },
            { label: 'Open data folder', click: () => this.actions.openDataFolder() },
            { type: 'separator' },
            { label: 'Quit Phone Farm', click: () => this.actions.quit() },
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

/** A 16pt template circle, so no binary asset is needed for the menu bar. */
function trayIcon(): NativeImage {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
        <rect x="3" y="1" width="10" height="14" rx="2.5" fill="none" stroke="black" stroke-width="1.5"/>
        <circle cx="8" cy="12" r="1" fill="black"/></svg>`;
    const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    image.setTemplateImage(true);
    return image;
}
