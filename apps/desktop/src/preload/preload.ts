import { contextBridge, ipcRenderer } from 'electron';

import type { FarmBridge, FleetSnapshot } from '../renderer/global.d.ts';

/**
 * The entire surface the renderer gets. Everything is a typed, named channel —
 * no `ipcRenderer` passthrough, no module loading, no filesystem.
 */
const api = {
    getFleet: () => ipcRenderer.invoke('fleet:get'),
    startService: (id: string) => ipcRenderer.invoke('fleet:start', id),
    stopService: (id: string) => ipcRenderer.invoke('fleet:stop', id),
    restartService: (id: string) => ipcRenderer.invoke('fleet:restart', id),
    startAll: () => ipcRenderer.invoke('fleet:start-all'),
    stopAll: () => ipcRenderer.invoke('fleet:stop-all'),
    restartAll: () => ipcRenderer.invoke('fleet:restart-all'),
    openLogs: (id: string) => ipcRenderer.invoke('fleet:open-logs', id),
    openHelp: (anchor: string) => ipcRenderer.invoke('app:open-help', anchor),
    openDashboard: () => ipcRenderer.invoke('app:open-dashboard'),
    openServices: () => ipcRenderer.invoke('app:open-services'),
    openSettings: () => ipcRenderer.invoke('app:open-settings'),
    openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
    getStartupNotice: () => ipcRenderer.invoke('app:startup-notice'),
    exportDiagnostics: () => ipcRenderer.invoke('app:export-diagnostics'),
    copyMcpConfig: () => ipcRenderer.invoke('app:copy-mcp-config'),
    copyDashboardUrl: () => ipcRenderer.invoke('app:copy-dashboard-url'),

    prepareWda: (udid: string | null) => ipcRenderer.invoke('job:run-wda-prepare', udid),
    cancelJob: (id: string) => ipcRenderer.invoke('job:cancel', id),
    dismissJob: (id: string) => ipcRenderer.invoke('job:dismiss', id),
    openJob: (id: string) => ipcRenderer.invoke('job:open', id),

    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: (patch: unknown) => ipcRenderer.invoke('settings:save', patch),
    resetDatabase: () => ipcRenderer.invoke('settings:reset-database'),

    onFleet: (listener: (snapshot: FleetSnapshot) => void): () => void => {
        const handler = (_event: unknown, snapshot: FleetSnapshot) => listener(snapshot);
        ipcRenderer.on('fleet:changed', handler);
        return () => { ipcRenderer.off('fleet:changed', handler); };
    },
// `satisfies` rather than a plain object: the renderer is typed against
// FarmBridge, and nothing else checks that this bridge still matches it.
} satisfies FarmBridge;

export type FarmDesktopApi = typeof api;

contextBridge.exposeInMainWorld('farm', api);
