import type { FleetSnapshot, JobSnapshot, LogLine, ServiceSnapshot } from '../main/types.ts';
import type { Settings } from '../main/settings.ts';

export interface FarmBridge {
    getFleet(): Promise<FleetSnapshot>;
    startService(id: string): Promise<void>;
    stopService(id: string): Promise<void>;
    restartService(id: string): Promise<void>;
    startAll(): Promise<void>;
    stopAll(): Promise<void>;
    restartAll(): Promise<void>;
    openLogs(id: string): Promise<void>;
    openHelp(anchor: string): Promise<void>;
    openDashboard(): Promise<void>;
    openServices(): Promise<void>;
    openSettings(): Promise<void>;
    openDataFolder(): Promise<void>;
    exportDiagnostics(): Promise<{ ok: boolean; message: string }>;
    copyMcpConfig(): Promise<{ ok: boolean; message: string }>;
    copyDashboardUrl(): Promise<{ ok: boolean; message: string }>;
    prepareWda(udid: string | null): Promise<{ ok: boolean; message: string }>;
    cancelJob(id: string): Promise<void>;
    dismissJob(id: string): Promise<void>;
    openJob(id: string): Promise<void>;
    getSettings(): Promise<Settings>;
    saveSettings(patch: Partial<Settings>): Promise<{ settings: Settings; restartRequired: boolean }>;
    resetDatabase(): Promise<{ ok: boolean; message: string }>;
    onFleet(listener: (snapshot: FleetSnapshot) => void): () => void;
}

declare global {
    interface Window { farm: FarmBridge }
}

export type { FleetSnapshot, JobSnapshot, LogLine, ServiceSnapshot, Settings };
