import { discoverConnectedDeviceUdids } from '../devices/discovery.js';
import type { DeviceConnectionStatus } from '../devices/connection-manager.js';
import { requestWdaService } from '../devices/wda-service-client.js';

/** Ask wda-service (which hosts the connection manager) for the live per-device states. */
export async function wdaServiceStatuses(): Promise<DeviceConnectionStatus[]> {
    const response = await requestWdaService('/devices', { timeoutMs: 2_000 });
    if (response.statusCode < 200 || response.statusCode >= 300) return [];
    return (JSON.parse(response.body).devices ?? []) as DeviceConnectionStatus[];
}

export interface ConnectivitySources {
    /** USB / adb enumeration. */
    discover?: () => Promise<string[]>;
    /** Connection-manager statuses; `physical: 'connected'` covers a bridge phone on Wi-Fi. */
    statuses?: () => Promise<DeviceConnectionStatus[]>;
}

/**
 * Which registered phones count as connected for the fleet page and the mobile
 * bootstrap. USB/adb enumeration alone misses an a11y-bridge phone that is healthy
 * over Wi-Fi with nothing attached; the connection manager knows about those, so
 * the answer is the union. Either source failing degrades to the other.
 */
export async function connectedFleetUdids(sources: ConnectivitySources = {}): Promise<string[]> {
    const discover = sources.discover ?? discoverConnectedDeviceUdids;
    const statuses = sources.statuses ?? wdaServiceStatuses;
    const [enumerated, managed] = await Promise.all([
        discover().catch(() => [] as string[]),
        statuses().catch(() => [] as DeviceConnectionStatus[]),
    ]);
    const connected = new Set(enumerated);
    for (const status of managed) if (status.physical === 'connected') connected.add(status.udid);
    return [...connected];
}
