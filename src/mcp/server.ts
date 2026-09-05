import crypto from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CreateTaskInput, JsonObject, ScheduleTiming } from '../types.js';
import type { McpDependencies, DeviceLike } from './types.js';

export const TIKTOK_PLUGIN_ID = 'com.git-agni.tiktok';
export const SERVER_NAME = 'phone-farm';
export const SERVER_VERSION = '0.1.0';

const timingSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('now') }),
    z.object({ kind: z.literal('once'), runAt: z.string().describe('ISO-8601 instant') }),
    z.object({
        kind: z.literal('daily'),
        localTime: z.string().describe('HH:MM in the given timezone'),
        timezone: z.string().describe('IANA timezone, e.g. Europe/London'),
    }),
    z.object({
        kind: z.literal('weekly'),
        localTime: z.string(),
        timezone: z.string(),
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).describe('0 = Sunday'),
    }),
]).describe('When the task runs');

const destinationSchema = z.enum(['draft', 'publish'])
    .describe("'publish' posts to the live account immediately — there is no second confirmation");

type ToolResult = {
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
    isError?: boolean;
};

function json(value: unknown): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): ToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Every tool body runs through here so a repository error becomes a tool error, not a transport fault. */
async function attempt(run: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
        return await run();
    } catch (error) {
        return failure(errorMessage(error));
    }
}

function dataRoot(dependencies: McpDependencies): string {
    return path.resolve(dependencies.dataDirectory ?? process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
}

function devicePluginData(device: DeviceLike | undefined, pluginId: string): JsonObject {
    return device?.pluginData?.[pluginId] ?? {};
}

async function fleet(dependencies: McpDependencies) {
    const [registered, connected] = await Promise.all([
        dependencies.loadDevices(),
        dependencies.discoverDevices().catch(() => []),
    ]);
    const online = new Map(connected.map((device) => [device.udid, device]));
    return registered.map((device) => ({
        udid: device.udid,
        name: device.name,
        platform: device.platform ?? 'ios',
        coordinateProfile: device.coordinateProfile ?? null,
        disabled: Boolean(device.disabled),
        connected: device.disabled ? null : online.get(device.udid) ?? null,
        status: device.disabled ? 'disabled' : online.has(device.udid) ? 'connected' : 'offline',
    }));
}

/** Mirrors POST /api/schedules: find the device, refuse a disabled one, hand the payload to the plugin. */
async function scheduleTask(
    dependencies: McpDependencies, input: CreateTaskInput, assetIds: string[] = [],
): Promise<ToolResult> {
    const device = (await dependencies.loadDevices()).find(({ udid }) => udid === input.deviceUdid);
    if (!device) return failure(`Device ${input.deviceUdid} is not registered`);
    if (device.disabled) return failure('This device is disabled — activate it before scheduling automation');
    const schedule = await dependencies.scheduler.createTask(
        input, devicePluginData(device, input.task.pluginId), new Date(), assetIds,
    );
    return json(schedule);
}

function registerDeviceTools(server: McpServer, dependencies: McpDependencies): void {
    server.registerTool('list_devices', {
        title: 'List devices',
        description: 'Every registered phone with its live connection status.',
        inputSchema: {},
    }, async () => attempt(async () => json({ devices: await fleet(dependencies) })));

    server.registerTool('get_device', {
        title: 'Get device',
        description: 'One registered phone by UDID (iOS) or adb serial (Android).',
        inputSchema: { udid: z.string().min(1).describe('Device UDID or adb serial') },
    }, async ({ udid }) => attempt(async () => {
        const device = (await fleet(dependencies)).find((entry) => entry.udid === udid);
        return device ? json(device) : failure(`Device ${udid} is not registered`);
    }));

    server.registerTool('discover_devices', {
        title: 'Discover devices',
        description: 'Phones the host can currently see over USB, registered or not.',
        inputSchema: {},
    }, async () => attempt(async () => json({ devices: await dependencies.discoverDevices() })));

    server.registerTool('screenshot', {
        title: 'Screenshot a device',
        description: "The device's current screen as a PNG image.",
        inputSchema: { udid: z.string().min(1) },
    }, async ({ udid }) => attempt(async () => ({
        content: [{ type: 'image' as const, data: (await dependencies.screenshot(udid)).toString('base64'), mimeType: 'image/png' }],
    })));
}

function registerScheduleTools(server: McpServer, dependencies: McpDependencies): void {
    server.registerTool('list_schedules', {
        title: 'List schedules',
        description: 'Scheduled tasks, newest first, optionally for one device.',
        inputSchema: {
            deviceUdid: z.string().optional(),
            limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
        },
    }, async ({ deviceUdid, limit }) => attempt(async () => json({
        schedules: await dependencies.scheduler.listSchedules(limit ?? 50, deviceUdid),
    })));

    server.registerTool('create_schedule', {
        title: 'Create a schedule',
        description: 'Schedule any plugin task. Prefer create_tiktok_post / create_doomscroll for TikTok work.',
        inputSchema: {
            deviceUdid: z.string().min(1),
            task: z.object({
                pluginId: z.string().min(1),
                taskType: z.string().min(1),
                taskVersion: z.number().int().min(1),
                payload: z.record(z.string(), z.unknown()).describe('Validated by the plugin task definition'),
            }),
            timing: timingSchema,
            runWindowMinutes: z.number().int().min(1).max(1440).optional(),
            assetIds: z.array(z.string()).optional().describe('Uploaded asset ids to attach'),
        },
    }, async ({ deviceUdid, task, timing, runWindowMinutes, assetIds }) => attempt(async () => scheduleTask(dependencies, {
        deviceUdid,
        task: { ...task, payload: task.payload as JsonObject },
        timing: timing as ScheduleTiming,
        ...(runWindowMinutes === undefined ? {} : { runWindowMinutes }),
    }, assetIds ?? [])));

    server.registerTool('set_schedule_status', {
        title: 'Pause, resume, or cancel a schedule',
        description: 'Mirrors POST /api/schedules/:id/status. A completed or cancelled schedule can only be cancelled.',
        inputSchema: {
            id: z.string().min(1),
            status: z.enum(['active', 'paused', 'cancelled']),
        },
    }, async ({ id, status }) => attempt(async () => {
        const schedule = await dependencies.scheduler.setScheduleStatus(id, status);
        return schedule ? json(schedule) : failure(`Schedule ${id} was not found`);
    }));
}

function registerTikTokTools(server: McpServer, dependencies: McpDependencies): void {
    server.registerTool('create_tiktok_post', {
        title: 'Post to TikTok',
        description: "Schedule a TikTok post from already-uploaded assets. destination 'publish' posts to the live "
            + 'account with no further confirmation; use \'draft\' to stage it instead.',
        inputSchema: {
            deviceUdid: z.string().min(1),
            account: z.string().min(1).describe('TikTok handle on the device, e.g. @studio.daily'),
            assetIds: z.array(z.string().min(1)).min(1).max(3).describe('One video, or up to three slideshow images'),
            caption: z.string().max(2200).optional(),
            musicUrl: z.string().optional().describe('HTTPS tiktok.com sound URL'),
            destination: destinationSchema,
            timing: timingSchema,
            runWindowMinutes: z.number().int().min(1).max(1440).optional(),
        },
    }, async (input) => attempt(async () => {
        const known = new Map((await dependencies.listAssets(500)).map((asset) => [asset.id, asset]));
        const media = input.assetIds.map((assetId) => {
            const asset = known.get(assetId);
            if (!asset) throw new Error(`Asset ${assetId} does not exist — upload it first with upload_asset`);
            return { assetId, name: asset.name, mimeType: asset.mimeType };
        });
        const timing = input.timing as ScheduleTiming;
        const recurring = timing.kind === 'daily' || timing.kind === 'weekly';
        return scheduleTask(dependencies, {
            deviceUdid: input.deviceUdid,
            task: {
                pluginId: TIKTOK_PLUGIN_ID, taskType: 'post', taskVersion: 1,
                payload: {
                    media, destination: input.destination, account: input.account,
                    ...(input.caption ? { caption: input.caption } : {}),
                    ...(input.musicUrl ? { musicUrl: input.musicUrl } : {}),
                    // The owner's call: an agent that asks to publish, publishes.
                    ...(recurring && input.destination === 'publish' ? { recurringPublishConfirmed: true } : {}),
                },
            },
            timing,
            ...(input.runWindowMinutes === undefined ? {} : { runWindowMinutes: input.runWindowMinutes }),
        }, input.assetIds);
    }));

    server.registerTool('create_doomscroll', {
        title: 'Schedule a TikTok doomscroll',
        description: 'Schedule a warm-up / engagement scrolling session on one device.',
        inputSchema: {
            deviceUdid: z.string().min(1),
            durationMinutes: z.number().int().min(1).max(180),
            personality: z.enum(['skimmer', 'casual', 'engaged']),
            likeEnabled: z.boolean().describe('Like videos while scrolling'),
            saveEnabled: z.boolean().describe('Save videos while scrolling'),
            account: z.string().optional().describe('Switch to this handle first'),
            timing: timingSchema,
            runWindowMinutes: z.number().int().min(1).max(1440).optional(),
        },
    }, async (input) => attempt(async () => scheduleTask(dependencies, {
        deviceUdid: input.deviceUdid,
        task: {
            pluginId: TIKTOK_PLUGIN_ID, taskType: 'doomscroll', taskVersion: 1,
            payload: {
                durationMinutes: input.durationMinutes, personality: input.personality,
                likeEnabled: input.likeEnabled, saveEnabled: input.saveEnabled,
                ...(input.account ? { account: input.account } : {}),
            },
        },
        timing: input.timing as ScheduleTiming,
        ...(input.runWindowMinutes === undefined ? {} : { runWindowMinutes: input.runWindowMinutes }),
    })));
}

function registerExecutionTools(server: McpServer, dependencies: McpDependencies): void {
    server.registerTool('list_executions', {
        title: 'List executions',
        description: 'Task runs, newest first, optionally for one device.',
        inputSchema: {
            deviceUdid: z.string().optional(),
            limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
        },
    }, async ({ deviceUdid, limit }) => attempt(async () => json({
        executions: await dependencies.scheduler.listExecutions(limit ?? 50, deviceUdid),
    })));

    server.registerTool('get_execution', {
        title: 'Get an execution',
        description: 'One run with its durable log lines.',
        inputSchema: { id: z.string().min(1) },
    }, async ({ id }) => attempt(async () => {
        const execution = await dependencies.scheduler.execution(id);
        return execution ? json(execution) : failure(`Execution ${id} was not found`);
    }));

    server.registerTool('stop_execution', {
        title: 'Stop an execution',
        description: 'Cancel a queued run, or ask a running one to stop if its task supports stopping.',
        inputSchema: { id: z.string().min(1) },
    }, async ({ id }) => attempt(async () => {
        const result = await dependencies.scheduler.requestStop(id);
        return result === 'not-found' ? failure(`Execution ${id} was not found`) : json({ result });
    }));

    server.registerTool('retry_execution', {
        title: 'Retry an execution',
        description: 'Re-queue a failed or stopped run with the same payload.',
        inputSchema: { id: z.string().min(1) },
    }, async ({ id }) => attempt(async () => {
        const execution = await dependencies.scheduler.retryExecution(id);
        return execution ? json(execution) : failure(`Execution ${id} is not retryable`);
    }));
}

function registerAssetTools(server: McpServer, dependencies: McpDependencies): void {
    server.registerTool('list_assets', {
        title: 'List assets',
        description: 'Uploaded media available to attach to a post.',
        inputSchema: { limit: z.number().int().min(1).max(500).optional().describe('Default 100') },
    }, async ({ limit }) => attempt(async () => json({ assets: await dependencies.listAssets(limit ?? 100) })));

    server.registerTool('upload_asset', {
        title: 'Upload an asset',
        description: 'Store one media file from a host path or inline base64 and return its asset id.',
        inputSchema: {
            name: z.string().min(1).describe('Filename shown in the dashboard'),
            mimeType: z.string().min(1).describe('e.g. video/mp4 or image/jpeg'),
            path: z.string().optional().describe('Absolute path on the farm host'),
            base64: z.string().optional().describe('File contents, base64 — use for small files only'),
        },
    }, async ({ name, mimeType, path: sourcePath, base64 }) => attempt(async () => {
        if ((sourcePath === undefined) === (base64 === undefined)) {
            return failure('Provide exactly one of path or base64');
        }
        const body = sourcePath === undefined ? Buffer.from(base64 ?? '', 'base64') : await readFile(sourcePath);
        const root = dataRoot(dependencies);
        await mkdir(path.join(root, 'uploads'), { recursive: true });
        const relativePath = path.join('uploads', crypto.randomUUID());
        const handle = await open(path.join(root, relativePath), 'wx', 0o600);
        try { await handle.write(body); } finally { await handle.close(); }
        const [asset] = await dependencies.scheduler.registerAssets([{
            relativePath, originalName: name, mimeType, size: body.length,
            sha256: crypto.createHash('sha256').update(body).digest('hex'),
        }]);
        return asset ? json(asset) : failure('The scheduler did not register the asset');
    }));

    server.registerTool('list_plugins', {
        title: 'List plugins',
        description: 'Loaded task plugins and the task types each one offers.',
        inputSchema: {},
    }, async () => attempt(async () => json({ plugins: dependencies.listPlugins() })));
}

const PLANNING_GUIDANCE = `You are planning a day of TikTok activity on a self-hosted phone farm.

Work in this order:
1. list_devices — take only devices whose status is "connected"; "offline" and "disabled" cannot run anything.
2. list_plugins — confirm the TikTok plugin is loaded and note its task versions.
3. list_schedules for each device — the scheduler refuses two tasks whose estimated windows sit
   within SCHEDULER_MIN_TASK_GAP_MINUTES of each other, so read what is already booked before adding.
4. list_assets, or upload_asset first, then create_tiktok_post with those asset ids.
   One video, or up to three images for a slideshow.
5. Warm an account up with create_doomscroll before its first post of the day.

Rules that matter:
- destination 'publish' posts to the live account. There is no confirmation step, so only pass it
  when the human asked for a live post in this conversation; otherwise use 'draft'.
- timing 'now' runs at the next worker tick; 'once' takes an ISO instant; 'daily' and 'weekly'
  take a local time plus an IANA timezone.
- One device runs one task at a time. Spread posts across devices rather than stacking one.
- After scheduling, follow the run with list_executions and get_execution (which returns logs);
  stop_execution cancels, retry_execution re-queues a failed or stopped run.`;

/** Builds the whole tool set once. Every transport (stdio, HTTP) connects to a server from here. */
export function createFarmMcpServer(dependencies: McpDependencies): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

    registerDeviceTools(server, dependencies);
    registerScheduleTools(server, dependencies);
    registerTikTokTools(server, dependencies);
    registerExecutionTools(server, dependencies);
    registerAssetTools(server, dependencies);

    server.registerResource('farm-status', 'farm://status', {
        title: 'Fleet status',
        description: 'A JSON summary of devices, active schedules, and running executions.',
        mimeType: 'application/json',
    }, async (uri) => {
        const [devices, schedules, executions] = await Promise.all([
            fleet(dependencies),
            dependencies.scheduler.listSchedules(200),
            dependencies.scheduler.listExecutions(200),
        ]);
        const summary = {
            generatedAt: new Date().toISOString(),
            devices: {
                registered: devices.length,
                connected: devices.filter(({ status }) => status === 'connected').length,
                offline: devices.filter(({ status }) => status === 'offline').length,
                disabled: devices.filter(({ status }) => status === 'disabled').length,
            },
            schedules: {
                active: schedules.filter(({ status }) => status === 'active').length,
                paused: schedules.filter(({ status }) => status === 'paused').length,
            },
            executions: {
                queued: executions.filter(({ status }) => status === 'queued').length,
                running: executions.filter(({ status }) => status === 'running').length,
                failed: executions.filter(({ status }) => status === 'failed').length,
            },
            plugins: dependencies.listPlugins().map(({ id, version }) => ({ id, version })),
        };
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(summary, null, 2) }] };
    });

    server.registerPrompt('plan_posting_day', {
        title: 'Plan a posting day',
        description: 'How to use the phone-farm tools to plan and book a day of TikTok activity.',
        // No argsSchema: an empty shape makes the SDK require an `arguments` object on every get.
    }, () => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: PLANNING_GUIDANCE } }],
    }));

    return server;
}
