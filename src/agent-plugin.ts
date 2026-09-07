import { createApiToken, defaultAuthStatePath, revokeApiTokenById } from './auth/state.js';
import { calibrate, CalibrateError, DEFAULT_MAX_MINUTES, type CalibratePayload } from './agent/calibrate.js';
import { calibratablePlugins, findFlow, type FlowName } from './agent/catalog.js';
import { createAgyRunner, type AgentRunner } from './agent/runner.js';
import type { PhoneFarmPlugin, TaskDefinition } from './plugin.js';
import { AGENT_PLUGIN_ID } from './plugin-ids.js';
import type { JsonObject, JsonValue } from './types.js';

export { AGENT_PLUGIN_ID };

/**
 * The calibration agent as a scheduled task.
 *
 * It is a plugin because that is how anything gets to touch a phone in Backline: one device, one
 * task at a time, inside a run window, with a durable log and a stop button. An agent driving a
 * phone should be no more privileged than a posting routine, and this is what makes that true.
 */

export interface AgentPluginConfiguration {
    /** Injected in tests. Defaults to the Antigravity CLI. */
    runner?: AgentRunner;
    /** Where confirmed selectors are written. Defaults to the scheduler data directory. */
    overridesPath?: string;
    /** Where the scoped MCP token is minted. Defaults to AUTH_STATE_PATH / `.auth.json`. */
    authStatePath?: string;
}

type CalibrateTaskPayload = JsonObject & CalibratePayload;

function objectPayload(value: JsonValue): Record<string, JsonValue> {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Payload must be an object');
    return value;
}

export function validateCalibratePayload(value: JsonValue): CalibrateTaskPayload {
    const input = objectPayload(value);
    const plugin = input.plugin;
    const flow = input.flow;
    const udid = input.udid;
    if (typeof plugin !== 'string' || !plugin) throw new Error('plugin is required');
    if (flow !== 'post' && flow !== 'warmup') throw new Error("flow must be 'post' or 'warmup'");
    if (typeof udid !== 'string' || !udid) throw new Error('udid is required');
    if (!findFlow(plugin, flow)) {
        throw new Error(`${plugin} has no Android ${flow} routine. Calibratable plugins: ${calibratablePlugins().join(', ')}`);
    }
    const model = input.model;
    if (model !== undefined && (typeof model !== 'string' || !/^[a-z0-9.-]{3,64}$/.test(model))) {
        throw new Error('model must be an Antigravity model slug, e.g. gemini-3.8-flash-medium');
    }
    const maxMinutes = input.maxMinutes ?? DEFAULT_MAX_MINUTES;
    if (typeof maxMinutes !== 'number' || !Number.isInteger(maxMinutes) || maxMinutes < 2 || maxMinutes > 120) {
        throw new Error('maxMinutes must be an integer between 2 and 120');
    }
    return { plugin, flow: flow as FlowName, udid, maxMinutes, ...(model ? { model } : {}) };
}

function tokenMinter(statePath: string): { create(name: string): Promise<{ token: string; id: string }>; revoke(id: string): Promise<void> } {
    return {
        async create(name) {
            const { token, record } = await createApiToken(statePath, name);
            return { token, id: record.id };
        },
        async revoke(id) { await revokeApiTokenById(statePath, id); },
    };
}

function createCalibrateTask(configuration: AgentPluginConfiguration): TaskDefinition<CalibrateTaskPayload> {
    return {
        type: 'calibrate', version: 1, displayName: 'Calibrate selectors with an agent',
        validate: (value) => validateCalibratePayload(value),
        summarize: (payload) => `Calibrate ${payload.plugin} ${payload.flow} selectors on ${payload.udid}`,
        // The wall-clock ceiling the agent is given, plus a little for the CLI's own startup.
        estimateDurationMs: (payload) => ((payload.maxMinutes ?? DEFAULT_MAX_MINUTES) + 2) * 60_000,
        // Nothing about a calibration pass gets better by being run again immediately: whatever
        // stopped the agent (no CLI, a locked phone, a screen it could not read) is still true.
        retryPolicy: () => ({ retryLimit: 0, retryDelaySeconds: 0, retryBackoff: false }),
        supportsStop: () => true,
        fixUrl: (payload) => `/devices/${encodeURIComponent(payload.udid)}#selectors`,
        async execute(context, payload) {
            try {
                const result = await calibrate(payload, {
                    runner: configuration.runner ?? createAgyRunner(),
                    log: (line) => context.log(line),
                    workspaceDirectory: context.workspaceDirectory,
                    ...(configuration.overridesPath ? { overridesPath: configuration.overridesPath } : {}),
                    signal: context.signal,
                    token: tokenMinter(configuration.authStatePath ?? defaultAuthStatePath()),
                });
                if (context.signal.aborted) return { exitCode: null, stopped: true };
                if (!result.agent.ok) {
                    return { exitCode: result.agent.exitCode, stopped: false, error: result.agent.error ?? 'The agent run failed' };
                }
                // A pass that leaves guesses behind is not a failure of the farm, but it is
                // something an operator has to know about — and a failed execution is how
                // Backline raises an alert, with the log and the device already attached.
                if (result.stillUnverified.length) {
                    return {
                        exitCode: 1, stopped: false,
                        error: `${result.recorded.length} selector(s) confirmed; still unverified: ${result.stillUnverified.join(', ')}`,
                    };
                }
                return { exitCode: 0, stopped: false };
            } catch (error) {
                if (context.signal.aborted) return { exitCode: null, stopped: true };
                const message = error instanceof CalibrateError ? error.message
                    : error instanceof Error ? error.message : String(error);
                return { exitCode: null, stopped: false, error: message };
            }
        },
    };
}

export function createAgentPlugin(configuration: AgentPluginConfiguration = {}): PhoneFarmPlugin {
    return {
        id: AGENT_PLUGIN_ID,
        version: '0.1.0',
        displayName: 'Calibration agent',
        tasks: [createCalibrateTask(configuration)],
    };
}

export default createAgentPlugin();
