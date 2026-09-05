import { contextBridge, ipcRenderer } from 'electron';

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
    openLogs: (id: string) => ipcRenderer.invoke('fleet:open-logs', id),
    openHelp: (anchor: string) => ipcRenderer.invoke('app:open-help', anchor),
    openDashboard: () => ipcRenderer.invoke('app:open-dashboard'),
    openServices: () => ipcRenderer.invoke('app:open-services'),
    openSettings: () => ipcRenderer.invoke('app:open-settings'),

    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: (patch: unknown) => ipcRenderer.invoke('settings:save', patch),
    resetDatabase: () => ipcRenderer.invoke('settings:reset-database'),

    onFleet: (listener: (snapshot: unknown) => void) => {
        const handler = (_event: unknown, snapshot: unknown) => listener(snapshot);
        ipcRenderer.on('fleet:changed', handler);
        return () => ipcRenderer.off('fleet:changed', handler);
    },
};

export type FarmDesktopApi = typeof api;

contextBridge.exposeInMainWorld('farm', api);
