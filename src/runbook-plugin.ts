import { fileURLToPath } from 'node:url';

import type { RegisteredDevice } from './devices/registry.js';
import type { DeviceDriver } from './drivers/types.js';
import type { Recognize } from './drivers/verify.js';
import type { PhoneFarmPlugin, TaskDefinition } from './plugin.js';
import type { JsonObject, JsonValue } from './types.js';
import { platformCompatible, validateRunbookId, variableNames, type RunbookRunStatus } from './runbook/model.js';
import { recognizeOnDevice } from './runbook/ocr.js';
import { replayRunbook } from './runbook/replay.js';
import { registerRunbookRoutes } from './runbook/routes.js';
import { mutateRunbook, readRunbook, runbookExists } from './runbook/store.js';

export const RUNBOOK_PLUGIN_ID = 'com.farm.runbook';

export interface RunbookPluginConfiguration {
    /** Overrides SCHEDULER_DATA_DIR/runbooks. */
    directory?: string;
    /** How a device record becomes a live driver for recording; tests inject a fake. */
    createDriver?: (device: RegisteredDevice) => DeviceDriver;
    /** OCR fallback for text targets; defaults to the on-device recognizer, loaded lazily. */
    recognize?: Recognize;
}

type RunPayload = JsonObject & {
    runbookId: string;
    vars?: Record<string, string>;
};

const MAX_VARS = 32;

function validateVars(value: JsonValue | undefined): Record<string, string> | undefined {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value) || typeof value !== 'object') throw new Error('vars must be an object of name → value');
    const entries = Object.entries(value);
    if (entries.length > MAX_VARS) throw new Error(`vars holds at most ${MAX_VARS} entries`);
    const vars: Record<string, string> = {};
    for (const [name, entry] of entries) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`"${name}" is not a valid variable name`);
        if (typeof entry !== 'string' || entry.length > 500) throw new Error(`vars.${name} must be a string of 500 characters or fewer`);
        vars[name] = entry;
    }
    return vars;
}

function createRunTask(configuration: RunbookPluginConfiguration): TaskDefinition<RunPayload> {
    return {
        type: 'run',
        version: 1,
        displayName: 'Replay a runbook',
        // The validation context carries no device, so platform compatibility is checked at
        // execute time; what can be checked here is that the runbook exists and the vars are sane.
        validate(value) {
            if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Payload must be an object');
            const runbookId = validateRunbookId(value.runbookId);
            if (!runbookExists(runbookId, configuration.directory)) throw new Error(`Runbook ${runbookId} does not exist`);
            const vars = validateVars(value.vars);
            return { runbookId, ...(vars && Object.keys(vars).length ? { vars } : {}) };
        },
        summarize: (payload) => `Runbook ${payload.runbookId}`,
        // A recorded sequence is short by construction; the window only has to be generous enough
        // that two runbooks are not scheduled on top of each other.
        estimateDurationMs: () => 120_000,
        retryPolicy: () => ({ retryLimit: 1, retryDelaySeconds: 60, retryBackoff: false }),
        supportsStop: () => true,
        async execute(context, payload) {
            /**
             * The list page's last column answers "does this still work, and when did it last?",
             * which only the run itself knows. Recorded through `mutateRunbook` so a run that
             * lands while the operator is editing steps does not clobber the edit.
             */
            const record = async (status: RunbookRunStatus): Promise<void> => {
                try {
                    await mutateRunbook(payload.runbookId, (stored) => {
                        stored.lastRunAt = new Date().toISOString();
                        stored.lastRunStatus = status;
                    }, configuration.directory);
                } catch {
                    // A runbook deleted mid-run has nothing to stamp; the run's own
                    // result is what the operator is told about.
                }
            };
            try {
                const runbook = await readRunbook(payload.runbookId, configuration.directory);
                if (!runbook) return { exitCode: null, stopped: false, error: `Runbook ${payload.runbookId} no longer exists` };
                const platform = context.device.platform ?? 'ios';
                if (!platformCompatible(runbook, platform)) {
                    await record('failed');
                    return {
                        exitCode: null, stopped: false,
                        error: `"${runbook.name}" was recorded for ${runbook.platform}; ${context.device.name} is ${platform}`,
                    };
                }
                const missing = variableNames(runbook).filter((name) => payload.vars?.[name] === undefined);
                if (missing.length) {
                    await record('failed');
                    return { exitCode: null, stopped: false, error: `Missing values for ${missing.map((name) => `{{${name}}}`).join(', ')}` };
                }
                const result = await replayRunbook(context.driver, runbook, {
                    ...(payload.vars ? { vars: payload.vars } : {}),
                    recognize: configuration.recognize ?? recognizeOnDevice,
                    signal: context.signal,
                    log: (line) => context.log(line),
                });
                await record(result.stopped ? 'stopped' : 'succeeded');
                return { exitCode: result.stopped ? null : 0, stopped: result.stopped };
            } catch (error) {
                if (context.signal.aborted) {
                    await record('stopped');
                    return { exitCode: null, stopped: true };
                }
                await record('failed');
                return { exitCode: null, stopped: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}

export function createRunbookPlugin(configuration: RunbookPluginConfiguration = {}): PhoneFarmPlugin {
    return {
        id: RUNBOOK_PLUGIN_ID,
        version: '0.1.0',
        displayName: 'Runbook recorder',
        tasks: [createRunTask(configuration)],
        navLinks: [{ label: 'Runbooks', href: '/runbooks', order: 30 }],
        devicePanels: [{
            id: 'runbook-recorder', title: 'Runbooks',
            fragmentPath: fileURLToPath(new URL('../static/runbook/device-panel.html', import.meta.url)), order: 200,
        }],
        registerRoutes: (context) => registerRunbookRoutes(context, {
            ...(configuration.directory ? { directory: configuration.directory } : {}),
            ...(configuration.createDriver ? { createDriver: configuration.createDriver } : {}),
            pluginId: RUNBOOK_PLUGIN_ID, taskType: 'run', taskVersion: 1,
        }),
    };
}

export default createRunbookPlugin;
