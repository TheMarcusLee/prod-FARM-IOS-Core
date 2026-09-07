import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    loadSelectorOverrides, selectorOverridesPath, type SelectorOverride,
} from '../drivers/selector-overrides.js';
import { farmEntryArgs } from '../runtime/farm-entry.js';
import { findFlow, selectorStatuses, unverifiedNames, type FlowName, type SelectorFlow } from './catalog.js';
import { AGY_FAST_MODEL, type AgentRunner, type AgentRunResult, type McpServerConfig } from './runner.js';

/**
 * Point a cheap agent at one phone and have it confirm the selectors nobody has verified.
 *
 * The shape of the job is deliberately narrow. The agent is given: what the routine does, the doc
 * page for that flow, the exact list of selectors still marked as guesses, and the Backline MCP
 * tools — nothing else. It can read screens, tap, type, and call `record_selector`; it cannot
 * schedule work, publish anything, or reach the host. What it accomplished is measured, not
 * reported: the override store is read before and after, and the difference is the result.
 */

export interface CalibratePayload {
    plugin: string;
    flow: FlowName;
    udid: string;
    /** Antigravity model slug. Flash by default — this is a cheap, repetitive job. */
    model?: string;
    /** Wall-clock ceiling for the agent run. */
    maxMinutes?: number;
}

export const DEFAULT_MAX_MINUTES = 20;

export interface CalibrateResult {
    /** Overrides that exist now and did not before, or whose entry changed. */
    recorded: SelectorOverride[];
    /** Names the agent was asked about that are still guesses with nothing recorded. */
    stillUnverified: string[];
    /** What the agent was asked about in the first place. */
    targeted: string[];
    agent: AgentRunResult;
}

export interface CalibrateOptions {
    runner: AgentRunner;
    /** Every line the agent produces goes here, which in an execution is the durable log. */
    log(line: string): Promise<void> | void;
    /** A directory the agent may read; the MCP config and the prompt are written into it. */
    workspaceDirectory: string;
    overridesPath?: string;
    signal?: AbortSignal;
    /**
     * Mints and revokes the API token the MCP entry carries. Injected so the job is testable
     * without an auth state file; the plugin wires it to `src/auth/state.ts`.
     */
    token?: {
        create(name: string): Promise<{ token: string; id: string }>;
        revoke(id: string): Promise<void>;
    };
    /** Where docs/*.md lives. Defaults to the repository's own docs directory. */
    docsDirectory?: string;
}

/** The stdio entry point an MCP client spawns to reach this farm — the same one `npm run mcp` runs. */
export function backlineMcpServer(token?: string): McpServerConfig {
    const entry = fileURLToPath(new URL('../mcp/stdio.ts', import.meta.url));
    const [command, ...args] = [process.execPath, ...farmEntryArgs(entry, { envFiles: ['.env', '.env.devices'] })];
    return {
        name: 'backline',
        command: command!,
        args,
        // The stdio transport is a child of this process and is trusted by being local, so the
        // token is not what admits the agent. It is carried so the run is attributable in the
        // token list, and so the same config works verbatim against the HTTP transport.
        ...(token ? { env: { BACKLINE_API_TOKEN: token, FARM_API_TOKEN: token } } : {}),
    };
}

/**
 * The part of a doc page that talks about selectors, which is the part worth a model's attention.
 * Everything from the first heading matching /selector/i up to the next heading of the same level.
 */
export function selectorSection(markdown: string): string | undefined {
    const lines = markdown.split('\n');
    const start = lines.findIndex((line) => /^#{1,6} .*selector/i.test(line));
    if (start < 0) return undefined;
    const level = (/^(#+)/.exec(lines[start]!) ?? ['', '#'])[1]!.length;
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
        const heading = /^(#+) /.exec(lines[index]!);
        if (heading && heading[1]!.length <= level) { end = index; break; }
    }
    return lines.slice(start, end).join('\n').trim();
}

async function docsExcerpt(flow: SelectorFlow, directory: string): Promise<string> {
    try {
        const markdown = await readFile(path.join(directory, `${flow.docs}.md`), 'utf8');
        return selectorSection(markdown) ?? '';
    } catch {
        return '';
    }
}

export interface PromptInput {
    flow: SelectorFlow;
    udid: string;
    unverified: ReadonlyArray<{ name: string; builtIn: ReadonlyArray<{ id?: string; text?: string; exact?: boolean }> }>;
    docs: string;
}

const TOOL_NOTES = `You are driving the phone through Backline's MCP server. The tools you have are:

- read_screen(udid) — the accessibility tree as {id, text, description, class, bounds, clickable}, plus a screenshot.
- find_on_screen(udid, query) — the nodes whose id, text or content-desc contain a string, and where a tap lands.
- tap(udid, {x, y}) or tap(udid, selector: {id} | {text, exact}) — one tap.
- swipe(udid, fromX, fromY, toX, toY) · press_key(udid, key) · type_text(udid, text) · launch_app(udid, appId).
- list_selectors(plugin) · list_unverified_selectors(plugin) — what the routine looks for and what is still a guess.
- record_selector(plugin, udid, name, entry, note) — write down a selector you have SEEN match.

These tools are the only thing you can touch. There is no shell, no filesystem, no network.`;

const SAFETY_NOTES = `Rules for this session:

- Never publish. If a flow reaches a Post / Share / Upload button, STOP there, or take the draft path.
  Confirming that the publish button exists means finding it in the tree, not pressing it.
- Never send, follow, comment, or otherwise interact with other people's content. You are identifying
  controls, not using the app.
- Record a selector only when you watched it match on screen. A guess written down as a confirmation is
  worse than leaving it unverified, because the routine will trust it.
- Prefer a resource-id over text: it survives a language change. Record the id fragment (the part after
  ':id/'), not the whole thing.
- If a screen is not what you expected, press back and say so in your final message rather than tapping
  around until something happens.`;

/** The whole prompt, built from data so it can be asserted on in a test. */
export function buildCalibrationPrompt(input: PromptInput): string {
    const { flow, udid, unverified, docs } = input;
    const list = unverified.map(({ name, builtIn }) => {
        const alternates = builtIn.map((entry) => entry.id ? `#${entry.id}` : `"${entry.text}"`).join(', ');
        return `- ${name} — currently tried in this order: ${alternates || '(nothing)'}`;
    }).join('\n');
    return [
        `You are calibrating Backline's ${flow.network} ${flow.flow} routine against one real phone.`,
        '',
        `## The phone`,
        `udid: ${udid}. The app is ${flow.appPackage}. Launch it with launch_app before you look at anything.`,
        '',
        `## What the routine does`,
        flow.description,
        '',
        `## What you are confirming`,
        `These selectors are guesses — nobody has checked them against a real device. Walk the flow, find each`,
        `control, and record what actually matches. Work down the list; it is fine to finish only part of it.`,
        '',
        list || '(nothing is unverified — say so and stop)',
        '',
        `Record each one with record_selector(plugin: "${flow.plugin}", udid: "${udid}", name: <the name above>, entry: {...}).`,
        '',
        `## Tools`,
        TOOL_NOTES,
        '',
        `## Safety`,
        SAFETY_NOTES,
        ...(docs ? ['', `## From docs/${flow.docs}.md`, docs] : []),
        '',
        `## Finish`,
        `End with a short list of which selectors you confirmed and which you could not reach, and why.`,
    ].join('\n');
}

function keyOf(override: { plugin: string; udid: string; name: string }): string {
    return `${override.plugin} ${override.udid} ${override.name}`;
}

function fingerprint(override: SelectorOverride): string {
    return `${keyOf(override)} ${JSON.stringify(override.entry)} ${override.confirmedAt}`;
}

export class CalibrateError extends Error {}

/**
 * Runs one calibration pass. Throws only when the job cannot start at all (no such flow, no CLI);
 * an agent that runs and achieves nothing is a result, not an exception.
 */
export async function calibrate(payload: CalibratePayload, options: CalibrateOptions): Promise<CalibrateResult> {
    const flow = findFlow(payload.plugin, payload.flow);
    if (!flow) throw new CalibrateError(`No Android ${payload.flow} routine for plugin ${payload.plugin}`);
    const missing = await options.runner.unavailable();
    if (missing) throw new CalibrateError(missing);

    const overridesPath = options.overridesPath ?? selectorOverridesPath();
    const log = async (line: string): Promise<void> => { await options.log(line); };

    const before = await loadSelectorOverrides(overridesPath);
    const seen = new Set(before.map(fingerprint));
    const guesses = new Set(await unverifiedNames(flow));
    const statuses = await selectorStatuses(payload.plugin, payload.udid, overridesPath);
    const targets = statuses.filter((row) => row.flow === flow.flow && guesses.has(row.name) && !row.override);
    await log(`Calibrating ${flow.network} ${flow.flow} on ${payload.udid}: ${targets.length} unverified selector(s)`);

    const docsDirectory = options.docsDirectory ?? fileURLToPath(new URL('../../docs/', import.meta.url));
    const prompt = buildCalibrationPrompt({
        flow, udid: payload.udid, docs: await docsExcerpt(flow, docsDirectory),
        unverified: targets.map(({ name, builtIn }) => ({ name, builtIn })),
    });

    const minted = await options.token?.create(`agent-calibrate ${payload.udid} ${new Date().toISOString()}`);
    const server = backlineMcpServer(minted?.token);
    try {
        // Written where the agent can read it, and where an operator debugging a run can see
        // exactly what the agent was pointed at. The token is not written to it.
        await writeFile(
            path.join(options.workspaceDirectory, 'mcp-servers.json'),
            `${JSON.stringify({ mcpServers: { [server.name]: { command: server.command, args: server.args } } }, null, 2)}\n`,
            { encoding: 'utf8', mode: 0o600 },
        );
        await writeFile(path.join(options.workspaceDirectory, 'prompt.md'), `${prompt}\n`, { encoding: 'utf8', mode: 0o600 });

        const maxMinutes = payload.maxMinutes ?? DEFAULT_MAX_MINUTES;
        const agent = await options.runner.run({
            prompt,
            model: payload.model ?? AGY_FAST_MODEL,
            cwd: options.workspaceDirectory,
            timeoutMs: maxMinutes * 60_000,
            mcpServers: [server],
            ...(options.signal ? { signal: options.signal } : {}),
        }, (line) => void Promise.resolve(options.log(line)).catch(() => undefined));

        // What was achieved is read off the store, not off what the agent said it did.
        const after = await loadSelectorOverrides(overridesPath);
        const recorded = after.filter((row) => row.plugin === payload.plugin && !seen.has(fingerprint(row)));
        const recordedNames = new Set(recorded.map(({ name }) => name));
        const stillUnverified = targets.map(({ name }) => name).filter((name) => !recordedNames.has(name));
        await log(recorded.length
            ? `Recorded ${recorded.length} selector(s): ${recorded.map(({ name }) => name).join(', ')}`
            : 'The agent recorded no selectors');
        if (stillUnverified.length) await log(`Still unverified: ${stillUnverified.join(', ')}`);
        return { recorded, stillUnverified, targeted: targets.map(({ name }) => name), agent };
    } finally {
        if (minted) await options.token?.revoke(minted.id).catch(() => undefined);
    }
}
