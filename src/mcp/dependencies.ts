import { desc } from 'drizzle-orm';

import { assets } from '../database/schema.js';
import { discoverConnectedDevices } from '../devices/discovery.js';
import { loadRegisteredDevices } from '../devices/registry.js';
import { driverForDevice } from '../drivers/select.js';
import type { DeviceDriver } from '../drivers/types.js';
import type { PluginRegistry } from '../registry.js';
import type { SchedulerRepository } from '../scheduler/repository.js';
import type { AssetLike, McpDependencies } from './types.js';

export interface FarmDependencyOptions {
    scheduler: SchedulerRepository;
    plugins: PluginRegistry;
    /** Usually `RegistryWdaRemoteControl.getScreenshot`; Android devices go through their driver. */
    screenshot(udid: string): Promise<Buffer>;
}

/** Assets have no repository accessor, so read the table directly — read-only, no schema change. */
async function listAssets(scheduler: SchedulerRepository, limit: number): Promise<AssetLike[]> {
    const rows = await scheduler.connection.db.select().from(assets)
        .orderBy(desc(assets.createdAt)).limit(limit);
    return rows.map((asset) => ({
        id: asset.id, name: asset.originalName, mimeType: asset.mimeType,
        size: asset.size, createdAt: asset.createdAt,
    }));
}

/**
 * The control channel behind the agent-facing tools. It is the very same driver the scheduler
 * hands a routine — an agent taps a phone through exactly what a task taps it through, and a
 * device that has been shelved is refused here rather than at the driver.
 */
async function control(udid: string): Promise<DeviceDriver> {
    const device = (await loadRegisteredDevices()).find((entry) => entry.udid === udid);
    if (!device) throw new Error(`Device ${udid} is not registered`);
    if (device.disabled) throw new Error(`Device ${udid} is disabled — activate it before driving it`);
    return driverForDevice(device);
}

/** Wires the MCP tool set to the live farm: same repository, registry, and discovery the dashboard uses. */
export function createFarmDependencies(options: FarmDependencyOptions): McpDependencies {
    return {
        scheduler: options.scheduler,
        loadDevices: () => loadRegisteredDevices(),
        discoverDevices: () => discoverConnectedDevices(),
        screenshot: (udid) => options.screenshot(udid),
        control,
        listAssets: (limit) => listAssets(options.scheduler, limit),
        listPlugins: () => options.plugins.list().map((plugin) => ({
            id: plugin.id, version: plugin.version, displayName: plugin.displayName,
            tasks: plugin.tasks.map(({ type, version, displayName }) => ({ type, version, displayName })),
        })),
    };
}
