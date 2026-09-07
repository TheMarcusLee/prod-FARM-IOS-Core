import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createFarmMcpServer } from '../src/mcp/server.js';
import type { DeviceControlLike, McpDependencies } from '../src/mcp/types.js';
import { loadSelectorOverrides, refreshSelectorOverrides } from '../src/drivers/selector-overrides.js';
import type { Key, Point, Swipe, UiNode } from '../src/drivers/types.js';
import { TIKTOK_PLUGIN_ID } from '../src/plugin-ids.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function node(partial: Partial<UiNode>): UiNode {
    return {
        id: '', type: 'android.view.View', text: '', description: '',
        bounds: { left: 0, top: 0, right: 100, bottom: 50 }, clickable: false, enabled: true, children: [],
        ...partial,
    };
}

/** A publish screen: a caption box inside a clickable row, a Post button, and empty scaffolding. */
const SCREEN: UiNode = node({
    bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
    children: [
        node({ bounds: { left: 0, top: 0, right: 1080, bottom: 200 } }),
        node({
            clickable: true, bounds: { left: 40, top: 300, right: 1040, bottom: 500 },
            children: [node({ id: 'com.zhiliaoapp.musically:id/et_caption', text: 'Add a caption', type: 'android.widget.EditText', bounds: { left: 60, top: 340, right: 1000, bottom: 460 } })],
        }),
        node({ id: 'com.zhiliaoapp.musically:id/btn_post', text: 'Post', clickable: true, bounds: { left: 700, top: 2000, right: 1000, bottom: 2100 } }),
    ],
});

interface Recorded { taps: Point[]; swipes: Swipe[]; keys: Key[]; typed: string[]; launched: string[] }

function fakeControl(recorded: Recorded): DeviceControlLike {
    return {
        udid: 'phone-1',
        async uiTree() { return SCREEN; },
        async screenshot() { return PNG; },
        async tap(point) { recorded.taps.push(point); },
        async swipe(swipe) { recorded.swipes.push(swipe); },
        async pressKey(key) { recorded.keys.push(key); },
        async type(text) { recorded.typed.push(text); },
        async launchApp(appId) { recorded.launched.push(appId); },
    };
}

function dependencies(overridesPath: string, recorded: Recorded, control = true): McpDependencies {
    return {
        scheduler: {
            async listSchedules() { return []; },
            async createTask() { throw new Error('not used'); },
            async setScheduleStatus() { return null; },
            async listExecutions() { return []; },
            async execution() { return null; },
            async requestStop() { return 'not-found'; },
            async retryExecution() { return null; },
            async registerAssets() { return []; },
        },
        async loadDevices() { return [{ udid: 'phone-1', name: 'Bench phone', platform: 'android', pluginData: {} }]; },
        async discoverDevices() { return []; },
        async screenshot() { return PNG; },
        async listAssets() { return []; },
        listPlugins() { return []; },
        selectorOverridesPath: overridesPath,
        ...(control ? { control: async () => fakeControl(recorded) } : {}),
    };
}

async function connected(dependency: McpDependencies): Promise<{ client: Client; close(): Promise<void> }> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFarmMcpServer(dependency);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, close: async () => { await client.close(); await server.close(); } };
}

function textOf(result: unknown): string {
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

async function harness(): Promise<{
    client: Client; recorded: Recorded; overrides: string; close(): Promise<void>;
}> {
    const directory = await mkdtemp(path.join(tmpdir(), 'backline-agent-mcp-'));
    const overrides = path.join(directory, 'selector-overrides.json');
    const recorded: Recorded = { taps: [], swipes: [], keys: [], typed: [], launched: [] };
    const { client, close } = await connected(dependencies(overrides, recorded));
    return {
        client, recorded, overrides,
        close: async () => { await close(); refreshSelectorOverrides(); await rm(directory, { recursive: true, force: true }); },
    };
}

test('read_screen returns a flat, useful tree plus the screen image', async () => {
    const { client, close } = await harness();
    try {
        const result = await client.callTool({ name: 'read_screen', arguments: { udid: 'phone-1' } });
        const content = (result as { content: Array<{ type: string; text?: string; mimeType?: string }> }).content;
        assert.equal(content.filter(({ type }) => type === 'image')[0]?.mimeType, 'image/png');
        const { nodes } = JSON.parse(content.find(({ type }) => type === 'text')!.text!) as {
            nodes: Array<{ id: string; text: string; class: string; clickable: boolean; bounds: unknown }>;
        };
        // The empty layout scaffolding is dropped; the caption box, its clickable row and Post stay.
        assert.deepEqual(nodes.map(({ text }) => text).sort(), ['', 'Add a caption', 'Post']);
        const caption = nodes.find(({ text }) => text === 'Add a caption');
        assert.equal(caption?.class, 'android.widget.EditText');
        assert.deepEqual(caption?.bounds, { left: 60, top: 340, right: 1000, bottom: 460 });

        const textOnly = await client.callTool({ name: 'read_screen', arguments: { udid: 'phone-1', screenshot: false } });
        assert.equal((textOnly as { content: unknown[] }).content.length, 1);
    } finally { await close(); }
});

test('find_on_screen matches id, text and content-desc, and says where a tap would land', async () => {
    const { client, close } = await harness();
    try {
        const result = await client.callTool({ name: 'find_on_screen', arguments: { udid: 'phone-1', query: 'caption' } });
        const { matches } = JSON.parse(textOf(result)) as { matches: Array<{ id: string; tapAt: Point }> };
        assert.equal(matches.length, 1);
        assert.match(matches[0]!.id, /et_caption$/);
        // The tap goes to the clickable row around the label, not the label itself.
        assert.deepEqual(matches[0]!.tapAt, { x: 540, y: 400 });
        const nothing = await client.callTool({ name: 'find_on_screen', arguments: { udid: 'phone-1', query: 'nowhere' } });
        assert.deepEqual((JSON.parse(textOf(nothing)) as { matches: unknown[] }).matches, []);
    } finally { await close(); }
});

test('tap takes a point or a selector, and refuses both or neither', async () => {
    const { client, recorded, close } = await harness();
    try {
        await client.callTool({ name: 'tap', arguments: { udid: 'phone-1', x: 10, y: 20 } });
        assert.deepEqual(recorded.taps.at(-1), { x: 10, y: 20 });

        await client.callTool({ name: 'tap', arguments: { udid: 'phone-1', selector: { id: 'btn_post' } } });
        assert.deepEqual(recorded.taps.at(-1), { x: 850, y: 2050 });

        const both = await client.callTool({ name: 'tap', arguments: { udid: 'phone-1', x: 1, y: 2, selector: { id: 'btn_post' } } });
        assert.equal((both as { isError?: boolean }).isError, true);
        const missing = await client.callTool({ name: 'tap', arguments: { udid: 'phone-1', selector: { text: 'Not here' } } });
        assert.equal((missing as { isError?: boolean }).isError, true);
        assert.match(textOf(missing), /Nothing on phone-1 matches/);
        assert.equal(recorded.taps.length, 2, 'a selector that matched nothing taps nothing');
    } finally { await close(); }
});

test('swipe, press_key, type_text and launch_app reach the driver', async () => {
    const { client, recorded, close } = await harness();
    try {
        await client.callTool({ name: 'swipe', arguments: { udid: 'phone-1', fromX: 540, fromY: 1800, toX: 540, toY: 600 } });
        assert.deepEqual(recorded.swipes.at(-1), { from: { x: 540, y: 1800 }, to: { x: 540, y: 600 }, durationMs: 300 });
        await client.callTool({ name: 'press_key', arguments: { udid: 'phone-1', key: 'back' } });
        assert.deepEqual(recorded.keys, ['back']);
        await client.callTool({ name: 'type_text', arguments: { udid: 'phone-1', text: 'hello' } });
        assert.deepEqual(recorded.typed, ['hello']);
        await client.callTool({ name: 'launch_app', arguments: { udid: 'phone-1', appId: 'com.zhiliaoapp.musically' } });
        assert.deepEqual(recorded.launched, ['com.zhiliaoapp.musically']);
        const rubbish = await client.callTool({ name: 'launch_app', arguments: { udid: 'phone-1', appId: 'rm -rf /' } });
        assert.equal((rubbish as { isError?: boolean }).isError, true);
    } finally { await close(); }
});

test('a deployment without device control says so instead of half-working', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'backline-agent-mcp-'));
    const recorded: Recorded = { taps: [], swipes: [], keys: [], typed: [], launched: [] };
    const { client, close } = await connected(dependencies(path.join(directory, 'o.json'), recorded, false));
    try {
        for (const name of ['read_screen', 'find_on_screen', 'tap', 'press_key']) {
            const result = await client.callTool({
                name, arguments: { udid: 'phone-1', query: 'x', x: 1, y: 2, key: 'back' },
            });
            assert.equal((result as { isError?: boolean }).isError, true, name);
            assert.match(textOf(result), /does not expose device control/, name);
        }
    } finally { await close(); await rm(directory, { recursive: true, force: true }); }
});

test('list_selectors, record_selector and list_unverified_selectors are one loop', async () => {
    const { client, overrides, close } = await harness();
    try {
        const listed = await client.callTool({ name: 'list_selectors', arguments: { plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1' } });
        const { selectors } = JSON.parse(textOf(listed)) as {
            selectors: Array<{ name: string; flow: string; guess: boolean; override: unknown; builtIn: unknown[] }>;
        };
        const caption = selectors.find(({ name }) => name === 'captionField');
        assert.ok(caption, 'the TikTok post table is listed');
        assert.equal(caption.override, null);
        assert.ok(caption.builtIn.length > 1, 'the alternates come with it');
        assert.ok(selectors.some(({ flow }) => flow === 'warmup'), 'both flows of the plugin are listed');

        const unknown = await client.callTool({ name: 'list_selectors', arguments: { plugin: 'org.nope' } });
        assert.equal((unknown as { isError?: boolean }).isError, true);

        const before = JSON.parse(textOf(await client.callTool({
            name: 'list_unverified_selectors', arguments: { plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1' },
        }))) as { unverified: Array<{ name: string }> };
        const target = before.unverified[0]!.name;

        const wrongName = await client.callTool({
            name: 'record_selector',
            arguments: { plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1', name: 'notAControl', entry: { id: 'x' } },
        });
        assert.equal((wrongName as { isError?: boolean }).isError, true);
        assert.match(textOf(wrongName), /no selector called notAControl/);

        await client.callTool({
            name: 'record_selector',
            arguments: {
                plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1', name: target,
                entry: { id: 'seen_on_screen' }, note: 'TikTok 39.4.4', confirmedBy: 'agent:flash',
            },
        });
        const stored = await loadSelectorOverrides(overrides);
        assert.equal(stored.length, 1);
        assert.deepEqual(stored[0]?.entry, { id: 'seen_on_screen' });
        assert.equal(stored[0]?.confirmedBy, 'agent:flash');

        const after = JSON.parse(textOf(await client.callTool({
            name: 'list_unverified_selectors', arguments: { plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1' },
        }))) as { unverified: Array<{ name: string }> };
        assert.equal(after.unverified.length, before.unverified.length - 1);
        assert.ok(!after.unverified.some(({ name }) => name === target));

        const overridesList = JSON.parse(textOf(await client.callTool({
            name: 'list_selector_overrides', arguments: {},
        }))) as { overrides: unknown[] };
        assert.equal(overridesList.overrides.length, 1);

        await client.callTool({ name: 'forget_selector', arguments: { plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1', name: target } });
        assert.deepEqual(await loadSelectorOverrides(overrides), []);
    } finally { await close(); }
});

test('a selector that could match anything is refused at the tool boundary', async () => {
    const { client, close } = await harness();
    try {
        const empty = await client.callTool({
            name: 'record_selector', arguments: { plugin: TIKTOK_PLUGIN_ID, udid: '*', name: 'post', entry: {} },
        });
        assert.equal((empty as { isError?: boolean }).isError, true);
    } finally { await close(); }
});
