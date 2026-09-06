import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerMcpRoutes } from '../src/api/routes/mcp.js';
import { createApiToken } from '../src/auth/state.js';
import { createFarmMcpServer } from '../src/mcp/server.js';
import type { McpDependencies, ScheduleLike } from '../src/mcp/types.js';
import { createTikTokPlugin } from '../src/tiktok-plugin.js';
import type { CreateTaskInput, JsonObject } from '../src/types.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

interface Recorded { input: CreateTaskInput; devicePluginData: JsonObject; assetIds: string[] }

function scheduleRow(input: CreateTaskInput): ScheduleLike {
    return {
        id: 'schedule-1', deviceUdid: input.deviceUdid, pluginId: input.task.pluginId,
        taskType: input.task.taskType, taskVersion: input.task.taskVersion, payload: input.task.payload,
        timing: input.timing, status: 'active', runWindowMinutes: input.runWindowMinutes ?? 30,
        nextRunAt: new Date(0), createdAt: new Date(0),
    };
}

function fakeDependencies(recorded: Recorded[] = []): McpDependencies {
    return {
        scheduler: {
            async listSchedules() { return []; },
            async createTask(input, devicePluginData = {}, _now, assetIds = []) {
                recorded.push({ input, devicePluginData, assetIds });
                return scheduleRow(input);
            },
            async setScheduleStatus(id, status) { return { ...scheduleRow({
                deviceUdid: 'test-device',
                task: { pluginId: 'p', taskType: 't', taskVersion: 1, payload: {} },
                timing: { kind: 'now' },
            }), id, status }; },
            async listExecutions() { return []; },
            async execution(id) {
                return {
                    id, scheduleId: null, deviceUdid: 'test-device', pluginId: 'p', taskType: 't', taskVersion: 1,
                    payload: {}, status: 'succeeded', scheduledFor: new Date(0), startedAt: new Date(0),
                    finishedAt: new Date(0), exitCode: 0, error: null, logs: ['opened TikTok', 'posted'],
                };
            },
            async requestStop() { return 'queued'; },
            async retryExecution() { return null; },
            async registerAssets(files) {
                return files.map((file, index) => ({ id: `new-${index}`, name: file.originalName, mimeType: file.mimeType }));
            },
        },
        async loadDevices() {
            return [
                { udid: 'test-device', name: 'Test iPhone', platform: 'ios', pluginData: {} },
                { udid: 'shelf-device', name: 'Shelf iPhone', platform: 'ios', disabled: true, pluginData: {} },
            ];
        },
        async discoverDevices() {
            return [{ udid: 'test-device', name: 'Test iPhone', platform: 'ios', osVersion: '16.7' }];
        },
        async screenshot() { return PNG; },
        async listAssets() {
            return [{ id: 'asset-1', name: 'clip.mp4', mimeType: 'video/mp4', size: 12 }];
        },
        listPlugins() {
            return [{ id: 'com.git-agni.tiktok', version: '0.1.0', displayName: 'TikTok automation', tasks: [] }];
        },
    };
}

async function connectedClient(dependencies: McpDependencies): Promise<{ client: Client; close(): Promise<void> }> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFarmMcpServer(dependencies);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, close: async () => { await client.close(); await server.close(); } };
}

function textOf(result: unknown): string {
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

test('the tool set exposes every farm tool plus the status resource and planning prompt', async () => {
    const { client, close } = await connectedClient(fakeDependencies());
    try {
        const names = (await client.listTools()).tools.map(({ name }) => name).sort();
        assert.deepEqual(names, [
            'create_doomscroll', 'create_schedule', 'create_tiktok_post', 'discover_devices', 'get_device',
            'get_execution', 'list_assets', 'list_devices', 'list_executions', 'list_plugins', 'list_schedules',
            'list_upload_dirs', 'retry_execution', 'screenshot', 'set_schedule_status', 'stop_execution',
            'upload_asset',
        ]);

        const resources = (await client.listResources()).resources.map(({ uri }) => uri);
        assert.ok(resources.includes('farm://status'));
        const status = await client.readResource({ uri: 'farm://status' });
        const [entry] = status.contents;
        assert.ok(entry && 'text' in entry);
        assert.equal(JSON.parse(String(entry.text)).devices.registered, 2);

        const prompts = (await client.listPrompts()).prompts.map(({ name }) => name);
        assert.deepEqual(prompts, ['plan_posting_day']);
        const prompt = await client.getPrompt({ name: 'plan_posting_day' });
        assert.match(String((prompt.messages[0]?.content as { text: string }).text), /list_devices/);

        // The product has one name everywhere a person reads one; the client's own
        // config key stays `phone-farm` for compatibility, which is not this.
        assert.equal(client.getServerVersion()?.name, 'backline');
        assert.doesNotMatch(String(prompt.description ?? ''), /phone-farm|Phone Farm|Handler|Agniverse/);
    } finally { await close(); }
});

test('list_devices merges the registry with what is connected', async () => {
    const { client, close } = await connectedClient(fakeDependencies());
    try {
        const result = await client.callTool({ name: 'list_devices', arguments: {} });
        const { devices } = JSON.parse(textOf(result)) as {
            devices: Array<{ udid: string; status: string; connected: unknown }>;
        };
        assert.deepEqual(devices.map(({ udid, status }) => ({ udid, status })), [
            { udid: 'test-device', status: 'connected' },
            { udid: 'shelf-device', status: 'disabled' },
        ]);
        assert.ok(devices[0]?.connected);
        assert.equal(devices[1]?.connected, null);

        const one = await client.callTool({ name: 'get_device', arguments: { udid: 'shelf-device' } });
        assert.equal(JSON.parse(textOf(one)).name, 'Shelf iPhone');
        const missing = await client.callTool({ name: 'get_device', arguments: { udid: 'nope' } });
        assert.equal(missing.isError, true);
    } finally { await close(); }
});

test('create_tiktok_post builds exactly the payload the TikTok plugin validates', async () => {
    const recorded: Recorded[] = [];
    const { client, close } = await connectedClient(fakeDependencies(recorded));
    try {
        await client.callTool({
            name: 'create_tiktok_post',
            arguments: {
                deviceUdid: 'test-device', account: '@studio.daily', assetIds: ['asset-1'],
                caption: 'morning drop', destination: 'publish', timing: { kind: 'now' },
            },
        });
        const call = recorded[0];
        assert.ok(call);
        assert.deepEqual(call.input.task, {
            pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1,
            payload: {
                media: [{ assetId: 'asset-1', name: 'clip.mp4', mimeType: 'video/mp4' }],
                destination: 'publish', account: '@studio.daily', caption: 'morning drop',
            },
        });
        assert.deepEqual(call.assetIds, ['asset-1']);

        // The plugin is the real authority — validate() must accept the payload untouched.
        const post = createTikTokPlugin().tasks.find(({ type }) => type === 'post');
        assert.ok(post);
        const validated = post.validate(call.input.task.payload, { timingKind: 'now', devicePluginData: {} });
        assert.deepEqual(validated, call.input.task.payload);
    } finally { await close(); }
});

test('a recurring publish is confirmed for the agent rather than blocked', async () => {
    const recorded: Recorded[] = [];
    const { client, close } = await connectedClient(fakeDependencies(recorded));
    try {
        await client.callTool({
            name: 'create_tiktok_post',
            arguments: {
                deviceUdid: 'test-device', account: '@studio.daily', assetIds: ['asset-1'],
                destination: 'publish', timing: { kind: 'daily', localTime: '09:00', timezone: 'Europe/London' },
            },
        });
        const payload = recorded[0]?.input.task.payload;
        assert.ok(payload);
        assert.equal(payload.recurringPublishConfirmed, true);
        const post = createTikTokPlugin().tasks.find(({ type }) => type === 'post');
        assert.ok(post);
        assert.doesNotThrow(() => post.validate(payload, { timingKind: 'daily', devicePluginData: {} }));
    } finally { await close(); }
});

test('create_doomscroll and create_schedule refuse a disabled or unknown device', async () => {
    const recorded: Recorded[] = [];
    const { client, close } = await connectedClient(fakeDependencies(recorded));
    try {
        await client.callTool({
            name: 'create_doomscroll',
            arguments: {
                deviceUdid: 'test-device', durationMinutes: 12, personality: 'casual',
                likeEnabled: true, saveEnabled: false, timing: { kind: 'now' },
            },
        });
        assert.deepEqual(recorded[0]?.input.task.payload, {
            durationMinutes: 12, personality: 'casual', likeEnabled: true, saveEnabled: false,
        });

        const disabled = await client.callTool({
            name: 'create_schedule',
            arguments: {
                deviceUdid: 'shelf-device',
                task: { pluginId: 'p', taskType: 't', taskVersion: 1, payload: {} },
                timing: { kind: 'now' },
            },
        });
        assert.equal(disabled.isError, true);
        assert.match(textOf(disabled), /disabled/);
    } finally { await close(); }
});

test('screenshot returns image content and get_execution returns logs', async () => {
    const { client, close } = await connectedClient(fakeDependencies());
    try {
        const shot = await client.callTool({ name: 'screenshot', arguments: { udid: 'test-device' } });
        const [image] = (shot as { content: Array<{ type: string; data?: string; mimeType?: string }> }).content;
        assert.equal(image?.type, 'image');
        assert.equal(image?.mimeType, 'image/png');
        assert.deepEqual(Buffer.from(String(image?.data), 'base64'), PNG);

        const execution = await client.callTool({ name: 'get_execution', arguments: { id: 'execution-1' } });
        assert.deepEqual(JSON.parse(textOf(execution)).logs, ['opened TikTok', 'posted']);
    } finally { await close(); }
});

test('upload_asset stores base64 media and registers it with the scheduler', async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'farm-mcp-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const { client, close } = await connectedClient({ ...fakeDependencies(), dataDirectory: directory });
    try {
        const result = await client.callTool({
            name: 'upload_asset',
            arguments: { name: 'clip.mp4', mimeType: 'video/mp4', base64: PNG.toString('base64') },
        });
        assert.deepEqual(JSON.parse(textOf(result)), { id: 'new-0', name: 'clip.mp4', mimeType: 'video/mp4' });

        const both = await client.callTool({
            name: 'upload_asset',
            arguments: { name: 'clip.mp4', mimeType: 'video/mp4', base64: 'AA==', path: '/tmp/x' },
        });
        assert.equal(both.isError, true);
    } finally { await close(); }
});

test('HTTP /mcp rejects a missing or invalid bearer token and accepts a valid one', async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'farm-auth-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const statePath = path.join(directory, '.auth.json');
    const { token } = await createApiToken(statePath, 'agent-1');

    const app = Fastify();
    await registerMcpRoutes(app, { dependencies: fakeDependencies(), statePath });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);

    const initialize = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

    const anonymous = await fetch(url, { method: 'POST', headers, body: JSON.stringify(initialize) });
    await anonymous.text();
    assert.equal(anonymous.status, 401);

    const wrong = await fetch(url, {
        method: 'POST', headers: { ...headers, authorization: 'Bearer pf_not-a-real-token' },
        body: JSON.stringify(initialize),
    });
    await wrong.text();
    assert.equal(wrong.status, 401);

    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'list_devices', arguments: {} });
        assert.match(textOf(result), /test-device/);
    } finally {
        // The client's open SSE stream would hold the server socket, so it closes first.
        await client.close();
        await app.close();
    }
});
