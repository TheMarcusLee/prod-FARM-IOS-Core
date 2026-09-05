import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { RegistryWdaRemoteControl } from '../devices/registry-remote.js';
import { driverForDevice, platformOf } from '../drivers/select.js';
import { loadRegisteredDevices } from '../devices/registry.js';
import { PluginRegistry } from '../registry.js';
import { createSchedulerRuntime } from '../scheduler/runtime.js';
import { defaultPlugins } from '../api/server.js';
import { createFarmDependencies } from './dependencies.js';
import { createFarmMcpServer } from './server.js';

/** Android has no WDA to ask; its driver takes the screenshot. Same split as the dashboard route. */
async function screenshotFor(remote: RegistryWdaRemoteControl, udid: string): Promise<Buffer> {
    const device = (await loadRegisteredDevices()).find((entry) => entry.udid === udid);
    if (!device) throw new Error(`Device ${udid} is not registered`);
    return platformOf(device) === 'android' ? driverForDevice(device).screenshot() : remote.getScreenshot(udid);
}

export async function main(): Promise<void> {
    const plugins = new PluginRegistry(await defaultPlugins());
    const scheduler = await createSchedulerRuntime(plugins);
    const remote = new RegistryWdaRemoteControl();
    const server = createFarmMcpServer(createFarmDependencies({
        scheduler: scheduler.repository, plugins, screenshot: (udid) => screenshotFor(remote, udid),
    }));
    // stdout is the JSON-RPC channel; anything else written there corrupts the stream.
    await server.connect(new StdioServerTransport());
    const shutdown = async () => {
        await server.close();
        await scheduler.close();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) await main();
