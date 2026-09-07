import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { center, findById, findByText, tappableBounds, walk } from '../drivers/verify.js';
import type { Key, Point, Rect, UiNode } from '../drivers/types.js';
import {
    ANY_DEVICE, loadSelectorOverrides, recordSelectorOverride, removeSelectorOverride, selectorOverridesPath,
    type SelectorEntry,
} from '../drivers/selector-overrides.js';
import { createActionLimiter, type ActionLimiter } from './action-limit.js';
import type { DeviceControlLike, McpDependencies } from './types.js';

/**
 * The tools a cheap agent uses to drive one phone and write down what it learned.
 *
 * Everything here is deliberately small and literal: read the screen, find a thing on it, tap it,
 * tell us which selector turned out to be right. The agent never gets a shell, never gets the
 * device's credentials, and cannot schedule anything from these tools — the whole surface is
 * "look at this phone, then record a selector".
 */

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

async function attempt(run: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
        return await run();
    } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
    }
}

/** One accessibility node, flattened. `bounds` is the tuple a tap can be aimed at directly. */
export interface FlatNode {
    id: string;
    text: string;
    description: string;
    class: string;
    bounds: Rect;
    clickable: boolean;
}

function flatten(node: UiNode): FlatNode {
    return {
        id: node.id, text: node.text, description: node.description, class: node.type,
        bounds: node.bounds, clickable: node.clickable,
    };
}

/**
 * A tree from a busy screen is thousands of nodes, most of them empty layout containers a model
 * can do nothing with. Keep the ones that say something or can be tapped.
 */
export function flattenTree(root: UiNode, limit = 300): FlatNode[] {
    const rows: FlatNode[] = [];
    for (const node of walk(root)) {
        const useful = Boolean(node.id || node.text || node.description || node.clickable);
        const visible = node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top;
        if (useful && visible) rows.push(flatten(node));
        if (rows.length >= limit) break;
    }
    return rows;
}

const selectorEntrySchema = z.strictObject({
    id: z.string().min(1).optional().describe('Android resource-id, with or without the <package>:id/ prefix'),
    text: z.string().min(1).optional().describe('Visible text or content-desc'),
    exact: z.boolean().optional().describe('Match the whole string rather than a substring'),
}).refine((entry) => Boolean(entry.id ?? entry.text), { message: 'A selector needs an id or a text' });

function matchesEntry(node: UiNode, entry: SelectorEntry): boolean {
    if (entry.id) return node.id === entry.id || node.id.endsWith(`:id/${entry.id}`);
    const wanted = (entry.text ?? '').trim().toLowerCase();
    return [node.text, node.description].some((candidate) => {
        const value = candidate.trim().toLowerCase();
        return entry.exact ? value === wanted : Boolean(wanted) && value.includes(wanted);
    });
}

/** Where a selector lands: the centre of the nearest clickable ancestor, which is what a finger hits. */
export function pointForEntry(root: UiNode, entry: SelectorEntry): Point | undefined {
    const node = entry.id
        ? findById(root, entry.id)
        : findByText(root, { text: entry.text ?? '', ...(entry.exact === undefined ? {} : { exact: entry.exact }) });
    return node ? center(tappableBounds(root, node)) : undefined;
}

function overridesPathOf(dependencies: McpDependencies): string {
    if (dependencies.selectorOverridesPath) return path.resolve(dependencies.selectorOverridesPath);
    return selectorOverridesPath(dependencies.dataDirectory ?? process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
}

const NO_CONTROL = 'This Backline deployment does not expose device control over MCP.';

export interface DeviceToolOptions {
    /** Injected in tests; defaults to the same 10-per-second-per-device ceiling as /remote/action. */
    limiter?: ActionLimiter;
}

/**
 * Registers `read_screen`, `find_on_screen`, the input verbs, and the three selector tools.
 * Authentication is the transport's (a Backline API token on /mcp, the operator's own shell over
 * stdio); the per-device action ceiling is this module's.
 */
export function registerDeviceControlTools(
    server: McpServer, dependencies: McpDependencies, options: DeviceToolOptions = {},
): void {
    const limiter = options.limiter ?? createActionLimiter();

    /** Every verb that moves a finger goes through here: one place for the ceiling and the lookup. */
    const acting = async (udid: string): Promise<DeviceControlLike> => {
        if (!dependencies.control) throw new Error(NO_CONTROL);
        limiter.check(udid);
        return dependencies.control(udid);
    };

    server.registerTool('read_screen', {
        title: 'Read a phone screen',
        description: 'The accessibility tree of what is on screen right now, flattened to a list of '
            + '{id, text, description, class, bounds, clickable}, plus a screenshot. bounds is '
            + '{left, top, right, bottom} in the coordinates tap takes.',
        inputSchema: {
            udid: z.string().min(1),
            limit: z.number().int().min(1).max(1000).optional().describe('Maximum nodes returned. Default 300.'),
            screenshot: z.boolean().optional().describe('Include the screen image. Default true.'),
        },
    }, async ({ udid, limit, screenshot }) => attempt(async () => {
        if (!dependencies.control) return failure(NO_CONTROL);
        const driver = await dependencies.control(udid);
        const nodes = flattenTree(await driver.uiTree(), limit ?? 300);
        const result: ToolResult = { content: [{ type: 'text', text: JSON.stringify({ udid, nodes }, null, 2) }] };
        if (screenshot === false) return result;
        // The same shrink the `screenshot` tool applies: a raw phone PNG is most of a context window.
        const { shrinkScreenshot } = await import('./server.js');
        result.content.push({
            type: 'image', mimeType: 'image/png',
            data: (await shrinkScreenshot(await driver.screenshot())).toString('base64'),
        });
        return result;
    }));

    server.registerTool('find_on_screen', {
        title: 'Find something on screen',
        description: 'Nodes whose id, text or content-desc contain the query, case-insensitively, '
            + 'with the point a tap on each would land on.',
        inputSchema: {
            udid: z.string().min(1),
            query: z.string().min(1).describe('Text, content-desc, or a resource-id fragment'),
            limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
        },
    }, async ({ udid, query, limit }) => attempt(async () => {
        if (!dependencies.control) return failure(NO_CONTROL);
        const root = await (await dependencies.control(udid)).uiTree();
        const needle = query.trim().toLowerCase();
        const matches: Array<FlatNode & { tapAt: Point }> = [];
        for (const node of walk(root)) {
            const haystack = `${node.id}\n${node.text}\n${node.description}`.toLowerCase();
            if (!haystack.includes(needle)) continue;
            matches.push({ ...flatten(node), tapAt: center(tappableBounds(root, node)) });
            if (matches.length >= (limit ?? 20)) break;
        }
        return json({ udid, query, matches });
    }));

    server.registerTool('tap', {
        title: 'Tap a phone',
        description: 'Tap either an exact point or the first node matching a selector. Give one or the other.',
        inputSchema: {
            udid: z.string().min(1),
            x: z.number().optional(),
            y: z.number().optional(),
            selector: selectorEntrySchema.optional(),
        },
    }, async ({ udid, x, y, selector }) => attempt(async () => {
        const byPoint = x !== undefined && y !== undefined;
        if (byPoint === Boolean(selector)) return failure('Give either x and y, or a selector — not both');
        const driver = await acting(udid);
        if (byPoint) {
            await driver.tap({ x, y });
            return json({ tapped: { x, y } });
        }
        const point = pointForEntry(await driver.uiTree(), selector as SelectorEntry);
        if (!point) return failure(`Nothing on ${udid} matches ${JSON.stringify(selector)}`);
        await driver.tap(point);
        return json({ tapped: point, selector });
    }));

    server.registerTool('swipe', {
        title: 'Swipe a phone',
        description: 'Drag from one point to another. A feed scroll is a swipe up the middle of the screen.',
        inputSchema: {
            udid: z.string().min(1),
            fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(),
            durationMs: z.number().int().min(50).max(5_000).optional().describe('Default 300'),
        },
    }, async ({ udid, fromX, fromY, toX, toY, durationMs }) => attempt(async () => {
        const driver = await acting(udid);
        await driver.swipe({ from: { x: fromX, y: fromY }, to: { x: toX, y: toY }, durationMs: durationMs ?? 300 });
        return json({ swiped: { from: { x: fromX, y: fromY }, to: { x: toX, y: toY } } });
    }));

    server.registerTool('press_key', {
        title: 'Press a hardware key',
        description: 'back, home, recents, enter, delete, power or wake.',
        inputSchema: {
            udid: z.string().min(1),
            key: z.enum(['home', 'back', 'enter', 'delete', 'recents', 'power', 'wake']),
        },
    }, async ({ udid, key }) => attempt(async () => {
        const driver = await acting(udid);
        await driver.pressKey(key as Key);
        return json({ pressed: key });
    }));

    server.registerTool('type_text', {
        title: 'Type into the focused field',
        description: 'Types into whatever has focus. Tap the field first. On adb-driven phones only printable ASCII goes through.',
        inputSchema: { udid: z.string().min(1), text: z.string().min(1).max(4_000) },
    }, async ({ udid, text }) => attempt(async () => {
        const driver = await acting(udid);
        await driver.type(text);
        return json({ typed: text.length });
    }));

    server.registerTool('launch_app', {
        title: 'Launch an app',
        description: 'Android package name or iOS bundle id, e.g. com.zhiliaoapp.musically.',
        inputSchema: {
            udid: z.string().min(1),
            appId: z.string().min(1).regex(/^[A-Za-z0-9._-]{3,255}$/).describe('Package name or bundle id'),
        },
    }, async ({ udid, appId }) => attempt(async () => {
        const driver = await acting(udid);
        await driver.launchApp(appId);
        return json({ launched: appId });
    }));

    server.registerTool('list_selectors', {
        title: 'List a plugin selectors',
        description: 'Every on-screen control one of the Android routines looks for, with the alternates it '
            + 'tries in order, whether it is still an unconfirmed guess, and any recorded override.',
        inputSchema: {
            plugin: z.string().min(1).describe('Plugin id, e.g. com.git-agni.tiktok'),
            udid: z.string().optional().describe("Show overrides for this phone. Default '*', the fleet-wide ones."),
        },
    }, async ({ plugin, udid }) => attempt(async () => {
        // Imported here rather than at the top: the catalog pulls in all eight Android routines,
        // and a client that never asks about selectors should not pay for them.
        const { selectorStatuses, calibratablePlugins } = await import('../agent/catalog.js');
        const rows = await selectorStatuses(plugin, udid ?? ANY_DEVICE, overridesPathOf(dependencies));
        if (!rows.length) return failure(`No Android selector tables for ${plugin}. Try one of: ${calibratablePlugins().join(', ')}`);
        return json({ plugin, udid: udid ?? ANY_DEVICE, selectors: rows });
    }));

    server.registerTool('list_unverified_selectors', {
        title: 'List unverified selectors',
        description: 'The selectors still marked as guesses in the routine with no confirmed override — '
            + 'exactly the list a calibration pass should work through.',
        inputSchema: {
            plugin: z.string().min(1),
            udid: z.string().optional().describe("Default '*'"),
        },
    }, async ({ plugin, udid }) => attempt(async () => {
        const { unverifiedStatuses } = await import('../agent/catalog.js');
        const rows = await unverifiedStatuses(plugin, udid ?? ANY_DEVICE, overridesPathOf(dependencies));
        return json({ plugin, udid: udid ?? ANY_DEVICE, unverified: rows });
    }));

    server.registerTool('record_selector', {
        title: 'Record a confirmed selector',
        description: 'Write down the selector that actually matched on this phone. The routines try it before '
            + 'their built-in alternates from the next run onwards. Only record what you have seen match — '
            + "use udid '*' when you are confident it holds for every phone in the farm.",
        inputSchema: {
            plugin: z.string().min(1),
            udid: z.string().min(1).describe("The phone it was confirmed on, or '*' for the whole fleet"),
            name: z.string().min(1).describe('The selector name from list_selectors, e.g. captionField'),
            entry: selectorEntrySchema,
            note: z.string().max(500).optional().describe('What you saw — the app build, the screen, anything odd'),
            confirmedBy: z.string().min(1).max(120).optional().describe("Who confirmed it. Default 'agent'."),
        },
    }, async ({ plugin, udid, name, entry, note, confirmedBy }) => attempt(async () => {
        const { selectorStatuses } = await import('../agent/catalog.js');
        const known = await selectorStatuses(plugin, udid, overridesPathOf(dependencies));
        if (!known.some((row) => row.name === name)) {
            return failure(`${plugin} has no selector called ${name}. Call list_selectors first.`);
        }
        const override = await recordSelectorOverride({
            plugin, udid, name, entry: entry as SelectorEntry,
            ...(note ? { note } : {}),
            confirmedBy: confirmedBy ?? 'agent',
        }, overridesPathOf(dependencies));
        return json({ recorded: override });
    }));

    server.registerTool('forget_selector', {
        title: 'Forget a recorded selector',
        description: 'Remove an override, putting the routine back on its built-in alternates.',
        inputSchema: { plugin: z.string().min(1), udid: z.string().min(1), name: z.string().min(1) },
    }, async ({ plugin, udid, name }) => attempt(async () => {
        const removed = await removeSelectorOverride({ plugin, udid, name }, overridesPathOf(dependencies));
        return removed ? json({ forgotten: { plugin, udid, name } }) : failure(`No override recorded for ${plugin}/${udid}/${name}`);
    }));

    server.registerTool('list_selector_overrides', {
        title: 'List recorded selectors',
        description: 'Every confirmed selector in the farm, with who recorded it and when.',
        inputSchema: { plugin: z.string().optional(), udid: z.string().optional() },
    }, async ({ plugin, udid }) => attempt(async () => {
        const all = await loadSelectorOverrides(overridesPathOf(dependencies));
        return json({
            overrides: all.filter((row) => (!plugin || row.plugin === plugin) && (!udid || row.udid === udid)),
        });
    }));
}
