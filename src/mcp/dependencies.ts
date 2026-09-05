import { desc } from 'drizzle-orm';

import { assets } from '../database/schema.js';
import { discoverConnectedDevices } from '../devices/discovery.js';
import { loadRegisteredDevices } from '../devices/registry.js';
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

/** Wires the MCP tool set to the live farm: same repository, registry, and discovery the dashboard uses. */
export function createFarmDependencies(options: FarmDependencyOptions): McpDependencies {
    return {
        scheduler: options.scheduler,
        loadDevices: () => loadRegisteredDevices(),
        discoverDevices: () => discoverConnectedDevices(),
        screenshot: (udid) => options.screenshot(udid),
        listAssets: (limit) => listAssets(options.scheduler, limit),
        listPlugins: () => options.plugins.list().map((plugin) => ({
            id: plugin.id, version: plugin.version, displayName: plugin.displayName,
            tasks: plugin.tasks.map(({ type, version, displayName }) => ({ type, version, displayName })),
        })),
    };
}
