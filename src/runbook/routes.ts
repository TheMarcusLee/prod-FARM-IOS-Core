/**
 * The runbook HTTP surface: a JSON API for runbooks and recording, plus the HTMX pages and the
 * device-page panel. Registered through the plugin's `registerRoutes`, so core routing is untouched.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RegisteredDevice } from '../devices/registry.js';
import { driverForDevice, platformOf } from '../drivers/select.js';
import type { DeviceDriver } from '../drivers/types.js';
import type { JsonObject, JsonValue } from '../types.js';
import type { PluginRouteContext } from '../plugin.js';
import {
    BLANK_NAME_PATTERN, MAX_STEPS, newRunbookId, platformCompatible, validatePlatform, validateRunbook,
    validateSteps, variableNames, type Runbook, type Step,
} from './model.js';
import { createRecorder, validateRemoteAction, type Recorder } from './recorder.js';
import {
    ROUTE_PREFIX, devicePanelFragment, runbookEditorFragment, runbookListFragment, runbookPage, runbooksPage,
} from './html.js';
import { PLACEHOLDER_PREFIX, runPanelFragment, runProgressFragment, storyFragment, type LiveRun } from './story.js';
import { replayRunbook, RunbookStepError } from './replay.js';
import { describeInstall, installStarterRunbooks } from './starters.js';
import {
    deleteRunbook, listRunbooks, mutateRunbook, readFailureScreenshot, readRunbook, writeFailureScreenshot,
    writeRunbook,
} from './store.js';

const STATIC_ROOT = fileURLToPath(new URL('../../static/dashboard/', import.meta.url));

export interface RunbookRoutesOptions {
    /** Overrides SCHEDULER_DATA_DIR/runbooks; tests point it at a temp directory. */
    directory?: string;
    createDriver?: (device: RegisteredDevice) => DeviceDriver;
    recorder?: Recorder;
    /** Seeds the starter library on boot. Off in the tests that assert on an empty farm. */
    installStarters?: boolean;
    pluginId?: string;
    taskType?: string;
    taskVersion?: number;
}

type FormValue = string | string[] | undefined;
type FormBody = Record<string, FormValue>;

function field(body: FormBody, name: string): string | undefined {
    const value = body[name];
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' ? first.trim() : undefined;
}

function numberField(body: FormBody, name: string): JsonValue | undefined {
    const value = field(body, name);
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
}

function rawStep(body: FormBody, index: number, type: string): JsonValue {
    const value = field(body, `step.${index}.value`) ?? '';
    const id = field(body, `step.${index}.id`);
    const text = field(body, `step.${index}.text`);
    const base: JsonObject = { type };
    const retries = numberField(body, `step.${index}.retries`);
    const retryDelayMs = numberField(body, `step.${index}.retryDelayMs`);
    if (retries !== undefined) base.retries = retries;
    if (retryDelayMs !== undefined) base.retryDelayMs = retryDelayMs;
    if (field(body, `step.${index}.optional`) === 'on') base.optional = true;
    const fraction = { x: numberField(body, `step.${index}.x`) ?? 0, y: numberField(body, `step.${index}.y`) ?? 0 };
    switch (type) {
        case 'launchApp': return { ...base, appId: value };
        case 'tap': return { ...base, target: { ...(id ? { id } : {}), ...(text ? { text } : {}), fraction } };
        case 'swipe': return {
            ...base, from: fraction,
            to: { x: numberField(body, `step.${index}.x2`) ?? 0, y: numberField(body, `step.${index}.y2`) ?? 0 },
            durationMs: numberField(body, `step.${index}.ms`) ?? 300,
        };
        case 'type': return { ...base, text: value };
        case 'key': return { ...base, key: value };
        case 'wait': return { ...base, ms: numberField(body, `step.${index}.ms`) ?? 0 };
        case 'waitForText': return {
            ...base, ...(id ? { id } : {}), ...(text ? { text } : {}),
            timeoutMs: numberField(body, `step.${index}.ms`) ?? 15_000,
        };
        case 'assert': return {
            ...base, ...(id ? { id } : {}), ...(text ? { text } : {}),
            expect: field(body, `step.${index}.expect`) ?? '',
        };
        case 'screenshot': return { ...base, label: value };
        default: return { ...base };
    }
}

/** The step table posts `step.<index>.<field>`; blank rows and rows marked Del. are dropped. */
export function stepsFromForm(body: FormBody): Step[] {
    const raw: JsonValue[] = [];
    for (let index = 0; index <= MAX_STEPS; index += 1) {
        const type = field(body, `step.${index}.type`);
        if (!type || field(body, `step.${index}.delete`) === 'on') continue;
        raw.push(rawStep(body, index, type));
    }
    return validateSteps(raw);
}

function varsFromForm(body: FormBody): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
        if (!key.startsWith('vars.')) continue;
        const name = key.slice('vars.'.length);
        const first = Array.isArray(value) ? value[0] : value;
        if (name && typeof first === 'string') vars[name] = first;
    }
    return vars;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const DEFAULT_SCREEN = { width: 1080, height: 2400, scale: 1 };

export async function registerRunbookRoutes(context: PluginRouteContext, options: RunbookRoutesOptions = {}): Promise<void> {
    const { app } = context;
    const directory = options.directory;
    const createDriver = options.createDriver ?? ((device: RegisteredDevice) => driverForDevice(device));
    const recorder = options.recorder ?? createRecorder();
    const pluginId = options.pluginId ?? 'com.farm.runbook';
    const taskType = options.taskType ?? 'run';
    const taskVersion = options.taskVersion ?? 1;

    // First boot: a farm with nothing on its Runbooks page has nothing to press. Seeding never
    // overwrites, so this is safe on every boot and is simply a no-op from the second one on.
    if (options.installStarters !== false) {
        try {
            const seeded = await installStarterRunbooks(directory);
            if (seeded.installed.length) console.log(`Runbooks: ${describeInstall(seeded)}`);
        } catch (error) {
            // A farm whose data directory is not writable yet still gets its pages.
            console.warn(`Runbooks: could not install the starter library — ${errorMessage(error)}`);
        }
    }

    const pageScript = await readFile(path.join(STATIC_ROOT, 'assets/runbooks.js'), 'utf8')
        .catch(() => '/* run npm run build:web */');
    const pageStyles = await readFile(path.join(STATIC_ROOT, 'pages.css'), 'utf8').catch(() => '');
    const assetVersion = `?v=${crypto.createHash('sha1').update(pageScript + pageStyles).digest('base64url').slice(0, 10)}`;
    app.get('/assets/runbooks.js', async (request: FastifyRequest, reply: FastifyReply) => {
        const versioned = Boolean((request.query as { v?: string }).v);
        return reply.header('cache-control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache')
            .type('text/javascript').send(pageScript);
    });

    const device = async (udid: string): Promise<RegisteredDevice | undefined> =>
        (await context.loadDevices()).find((entry) => entry.udid === udid);
    const html = (reply: FastifyReply, body: string): FastifyReply => reply.type('text/html').send(body);
    const listFragment = async (message?: string): Promise<string> =>
        runbookListFragment(await listRunbooks(directory), await context.loadDevices(), message);
    // One live try-run per runbook, in process, like the recorder: a restart ends it, which is
    // the honest behaviour for something an operator is watching happen.
    const runs = new Map<string, LiveRun>();

    const editorOptions = (runbook: Runbook, message?: string) => ({
        ...(message ? { message } : {}),
        ...(recorder.forRunbook(runbook.id) ? { recordingOn: recorder.forRunbook(runbook.id)!.udid } : {}),
        ...(runs.get(runbook.id) ? { run: runs.get(runbook.id)! } : {}),
    });
    const editorFragment = async (runbook: Runbook, message?: string): Promise<string> =>
        runbookEditorFragment(runbook, await context.loadDevices(), editorOptions(runbook, message));
    const panelFragment = async (udid: string, message?: string): Promise<string> => {
        const session = recorder.forDevice(udid);
        const recording = session ? await readRunbook(session.runbookId, directory) : undefined;
        return devicePanelFragment(udid, await listRunbooks(directory), session, recording, message);
    };

    const screenFor = async (found: RegisteredDevice | undefined): Promise<{ width: number; height: number; scale: number }> => {
        if (!found) return DEFAULT_SCREEN;
        try {
            return await createDriver(found).screen();
        } catch {
            // Recording later re-reads the real screen; an offline phone must not block creating a runbook.
            return DEFAULT_SCREEN;
        }
    };

    const createRunbook = async (input: {
        name: JsonValue; description?: JsonValue; platform?: JsonValue; appId?: JsonValue; udid?: JsonValue;
    }): Promise<Runbook> => {
        const udid = typeof input.udid === 'string' && input.udid ? input.udid : 'unassigned';
        const found = udid === 'unassigned' ? undefined : await device(udid);
        return writeRunbook(validateRunbook({
            id: newRunbookId(),
            name: input.name ?? null,
            description: input.description ?? '',
            platform: input.platform === undefined || input.platform === '' ? 'any' : input.platform,
            ...(typeof input.appId === 'string' && input.appId ? { appId: input.appId } : {}),
            createdFor: { udid, screen: await screenFor(found) },
            steps: [], version: 1,
        }), directory);
    };

    // ---- JSON API -------------------------------------------------------------------------

    app.get('/api/runbooks', async () => ({ runbooks: await listRunbooks(directory) }));

    app.post<{ Body: JsonObject }>('/api/runbooks', async (request, reply) => {
        const body = request.body ?? {};
        try {
            return reply.code(201).send(await createRunbook({
                name: body.name!, description: body.description, platform: body.platform, appId: body.appId, udid: body.udid,
            }));
        } catch (error) {
            // Every field is validated by `validateRunbook`; a rejected body is
            // the caller's mistake, not a server fault.
            return reply.code(400).send({ error: errorMessage(error) });
        }
    });

    app.get<{ Params: { id: string } }>('/api/runbooks/:id', async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).send({ error: 'Runbook not found' });
        return runbook;
    });

    app.put<{ Params: { id: string }; Body: JsonObject }>('/api/runbooks/:id', async (request, reply) => {
        const existing = await readRunbook(request.params.id, directory);
        if (!existing) return reply.code(404).send({ error: 'Runbook not found' });
        const body = request.body ?? {};
        let replacement: Runbook;
        try {
            replacement = validateRunbook({
                ...body, id: existing.id, version: 1, createdAt: existing.createdAt,
                createdFor: body.createdFor ?? existing.createdFor,
            } as JsonValue);
        } catch (error) {
            return reply.code(400).send({ error: errorMessage(error) });
        }
        // Through `mutateRunbook`, so a step arriving from an open recording is
        // not silently dropped by a read-modify-write that started earlier.
        const saved = await mutateRunbook(existing.id, (stored) => {
            Object.assign(stored, replacement);
        }, directory);
        return saved ?? reply.code(404).send({ error: 'Runbook not found' });
    });

    app.delete<{ Params: { id: string } }>('/api/runbooks/:id', async (request, reply) => {
        if (recorder.forRunbook(request.params.id)) return reply.code(409).send({ error: 'Stop the recording first' });
        const removed = await deleteRunbook(request.params.id, directory);
        return removed ? reply.code(204).send() : reply.code(404).send({ error: 'Runbook not found' });
    });

    app.post<{ Params: { id: string } }>('/api/runbooks/:id/duplicate', async (request, reply) => {
        const source = await readRunbook(request.params.id, directory);
        if (!source) return reply.code(404).send({ error: 'Runbook not found' });
        const copy = await writeRunbook({
            ...source, id: newRunbookId(), name: `${source.name} copy`.slice(0, 80), createdAt: new Date().toISOString(),
        }, directory);
        return reply.code(201).send(copy);
    });

    app.post<{ Params: { id: string }; Body: { udid?: string } }>('/api/runbooks/:id/record/start', async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).send({ error: 'Runbook not found' });
        const udid = request.body?.udid;
        const found = udid ? await device(udid) : undefined;
        if (!found) return reply.code(404).send({ error: 'Device is not registered' });
        const existing = recorder.forDevice(found.udid);
        if (existing) return reply.code(409).send({ error: 'This device is already recording a runbook' });
        const driver = createDriver(found);
        const session = await recorder.start(found.udid, runbook.id, driver);
        // An empty runbook adopts the phone it is recorded on — that is what the fractions mean.
        if (runbook.steps.length === 0) {
            await mutateRunbook(runbook.id, (stored) => {
                stored.createdFor = { udid: found.udid, screen: session.screen };
                if (stored.platform === 'any') stored.platform = platformOf(found);
            }, directory);
        }
        return { recording: true, udid: found.udid, runbookId: runbook.id, screen: session.screen };
    });

    app.post<{ Params: { id: string } }>('/api/runbooks/:id/record/stop', async (request, reply) => {
        const session = recorder.forRunbook(request.params.id);
        if (!session) return reply.code(409).send({ error: 'This runbook is not recording' });
        recorder.stop(session.udid);
        return { recording: false, runbookId: request.params.id, steps: session.steps };
    });

    app.post<{ Params: { id: string }; Body: { action?: JsonValue } }>('/api/runbooks/:id/steps', async (request, reply) => {
        const session = recorder.forRunbook(request.params.id);
        if (!session) return reply.code(409).send({ error: 'This runbook is not recording' });
        const found = await device(session.udid);
        if (!found) return reply.code(404).send({ error: 'Device is not registered' });
        const action = validateRemoteAction(request.body?.action);
        // One action can be two steps: the wait the screen change earned, then the action itself.
        const added = await recorder.record(session, action, createDriver(found));
        let updated: Runbook | undefined;
        try {
            updated = await mutateRunbook(request.params.id, (stored) => {
                if (stored.steps.length + added.length > MAX_STEPS) throw new Error(`A runbook holds at most ${MAX_STEPS} steps`);
                stored.steps.push(...added);
            }, directory);
        } catch (error) {
            return reply.code(409).send({ error: errorMessage(error) });
        }
        if (!updated) return reply.code(404).send({ error: 'Runbook not found' });
        return reply.code(201).send({ step: added.at(-1), added, steps: updated.steps.length });
    });

    // ---- Pages and fragments --------------------------------------------------------------

    /** The list page, rendered through the farm's own shell so the sidebar is the real one. */
    const listPage = async (request: FastifyRequest): Promise<string> => context.shell(request,
        runbooksPage(await listRunbooks(directory), await context.loadDevices(), assetVersion));

    app.get('/runbooks', async (request, reply) => html(reply, await listPage(request)));

    app.get<{ Params: { id: string } }>('/runbooks/:id', async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).type('text/html').send(await listPage(request));
        return html(reply, await context.shell(request,
            runbookPage(runbook, await context.loadDevices(), assetVersion, editorOptions(runbook))));
    });

    app.post<{ Body: FormBody }>(`${ROUTE_PREFIX}/runbooks`, async (request, reply) => {
        const body = request.body ?? {};
        try {
            await createRunbook({
                name: field(body, 'name') ?? '', description: field(body, 'description') ?? '',
                platform: field(body, 'platform') ?? 'any', appId: field(body, 'appId') ?? '', udid: field(body, 'udid') ?? '',
            });
            return html(reply, await listFragment());
        } catch (error) {
            return html(reply, await listFragment(errorMessage(error)));
        }
    });

    app.post<{ Params: { id: string } }>(`${ROUTE_PREFIX}/runbooks/:id/delete`, async (request, reply) => {
        if (recorder.forRunbook(request.params.id)) return html(reply, await listFragment('Stop the recording first'));
        await deleteRunbook(request.params.id, directory);
        return html(reply, await listFragment());
    });

    app.post<{ Params: { id: string } }>(`${ROUTE_PREFIX}/runbooks/:id/duplicate`, async (request, reply) => {
        const source = await readRunbook(request.params.id, directory);
        if (!source) return html(reply, await listFragment('Runbook not found'));
        await writeRunbook({ ...source, id: newRunbookId(), name: `${source.name} copy`.slice(0, 80) }, directory);
        return html(reply, await listFragment());
    });

    app.post<{ Params: { id: string }; Body: FormBody }>(`${ROUTE_PREFIX}/runbooks/:id/meta`, async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).type('text/html').send(await listFragment('Runbook not found'));
        const body = request.body ?? {};
        try {
            const appId = field(body, 'appId');
            const updated = await mutateRunbook(runbook.id, (stored) => {
                stored.name = field(body, 'name') ?? stored.name;
                stored.description = field(body, 'description') ?? '';
                stored.platform = validatePlatform(field(body, 'platform') ?? stored.platform);
                if (appId) stored.appId = appId; else delete stored.appId;
                validateRunbook(stored as unknown as JsonValue);
            }, directory);
            return html(reply, await editorFragment(updated ?? runbook, 'Saved.'));
        } catch (error) {
            return html(reply, await editorFragment(runbook, errorMessage(error)));
        }
    });

    app.post<{ Params: { id: string }; Body: FormBody }>(`${ROUTE_PREFIX}/runbooks/:id/steps-form`, async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).type('text/html').send(await listFragment('Runbook not found'));
        try {
            const steps = stepsFromForm(request.body ?? {});
            // The form replaces the steps it was rendered from (baseCount of them);
            // anything a recording appended since then is kept behind the edited list.
            // Same serialisation as recording, so the two never read-modify-write past
            // each other either.
            const base = Number(field(request.body ?? {}, 'baseCount'));
            const updated = await mutateRunbook(runbook.id, (stored) => {
                const appendedSince = Number.isInteger(base) && base >= 0 ? stored.steps.slice(base) : [];
                stored.steps = validateSteps([...steps, ...appendedSince] as unknown as JsonValue[]);
            }, directory);
            return html(reply, await editorFragment(updated ?? runbook, `Saved ${steps.length} steps.`));
        } catch (error) {
            return html(reply, await editorFragment(runbook, errorMessage(error)));
        }
    });

    app.post<{ Params: { id: string }; Body: FormBody }>(`${ROUTE_PREFIX}/runbooks/:id/run`, async (request, reply) => {
        const body = request.body ?? {};
        const runbook = await readRunbook(request.params.id, directory);
        const fromList = field(body, 'view') === 'list';
        const respond = async (message: string): Promise<FastifyReply> =>
            html(reply, runbook && !fromList ? await editorFragment(runbook, message) : await listFragment(message));
        if (!runbook) return respond('Runbook not found');
        const udid = field(body, 'udid') ?? '';
        const found = await device(udid);
        if (!found) return respond('Device is not registered');
        if (!platformCompatible(runbook, platformOf(found))) {
            return respond(`"${runbook.name}" was recorded for ${runbook.platform}; ${found.name} is ${platformOf(found)}`);
        }
        const vars = varsFromForm(body);
        if (Object.keys(vars).length) {
            await mutateRunbook(runbook.id, (stored) => { stored.lastValues = vars; }, directory).catch(() => undefined);
        }
        try {
            await context.scheduler.createTask({
                deviceUdid: found.udid,
                task: {
                    pluginId, taskType, taskVersion,
                    payload: { runbookId: runbook.id, ...(Object.keys(vars).length ? { vars } : {}) },
                },
                timing: { kind: 'now' },
            }, found.pluginData[pluginId] ?? {});
            return respond(`Queued "${runbook.name}" on ${found.name}.`);
        } catch (error) {
            return respond(errorMessage(error));
        }
    });

    // The editor drives recording too, so the operator does not have to find the phone's page to
    // start one. Same recorder, same runbook lock — only the fragment that comes back differs.
    app.post<{ Params: { id: string }; Body: FormBody }>(`${ROUTE_PREFIX}/runbooks/:id/record/start-form`, async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).type('text/html').send(await listFragment('Runbook not found'));
        const found = await device(field(request.body ?? {}, 'udid') ?? '');
        try {
            if (!found) throw new Error('Choose a phone to record on');
            if (recorder.forDevice(found.udid)) throw new Error('This phone is already recording a runbook');
            const session = await recorder.start(found.udid, runbook.id, createDriver(found));
            if (runbook.steps.length === 0) {
                await mutateRunbook(runbook.id, (stored) => {
                    stored.createdFor = { udid: found.udid, screen: session.screen };
                    if (stored.platform === 'any') stored.platform = platformOf(found);
                }, directory);
            }
            return html(reply, await editorFragment(await readRunbook(runbook.id, directory) ?? runbook));
        } catch (error) {
            return html(reply, await editorFragment(runbook, errorMessage(error)));
        }
    });

    app.post<{ Params: { id: string } }>(`${ROUTE_PREFIX}/runbooks/:id/record/stop-form`, async (request, reply) => {
        const session = recorder.forRunbook(request.params.id);
        if (session) recorder.stop(session.udid);
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).type('text/html').send(await listFragment('Runbook not found'));
        return html(reply, await editorFragment(runbook));
    });

    app.get<{ Params: { udid: string } }>(`${ROUTE_PREFIX}/devices/:udid/panel`, async (request, reply) =>
        html(reply, await panelFragment(request.params.udid)));

    app.post<{ Params: { udid: string }; Body: FormBody }>(`${ROUTE_PREFIX}/devices/:udid/record/start`, async (request, reply) => {
        const udid = request.params.udid;
        const found = await device(udid);
        const runbookId = field(request.body ?? {}, 'runbookId') ?? '';
        if (!found) return html(reply, await panelFragment(udid, 'Device is not registered'));
        try {
            const runbook = await readRunbook(runbookId, directory);
            if (!runbook) throw new Error('Choose a runbook to record into');
            if (recorder.forDevice(udid)) throw new Error('This device is already recording');
            const session = await recorder.start(udid, runbook.id, createDriver(found));
            if (runbook.steps.length === 0) {
                await mutateRunbook(runbook.id, (stored) => {
                    stored.createdFor = { udid, screen: session.screen };
                    if (stored.platform === 'any') stored.platform = platformOf(found);
                }, directory);
            }
            return html(reply, await panelFragment(udid));
        } catch (error) {
            return html(reply, await panelFragment(udid, errorMessage(error)));
        }
    });

    app.post<{ Params: { udid: string } }>(`${ROUTE_PREFIX}/devices/:udid/record/stop`, async (request, reply) => {
        recorder.stop(request.params.udid);
        return html(reply, await panelFragment(request.params.udid));
    });

    // ---- record here, name it, and the sentences --------------------------------------------

    /**
     * One press starts a recording on this phone: the runbook is created for you, under a
     * placeholder name, and named after you press Done. Nothing is asked before the phone moves.
     */
    const startHere = async (found: RegisteredDevice): Promise<Runbook> => {
        if (recorder.forDevice(found.udid)) throw new Error('This phone is already recording');
        const runbook = await createRunbook({
            name: `${PLACEHOLDER_PREFIX} on ${found.name}`.slice(0, 80), udid: found.udid,
        });
        const session = await recorder.start(found.udid, runbook.id, createDriver(found));
        await mutateRunbook(runbook.id, (stored) => {
            stored.createdFor = { udid: found.udid, screen: session.screen };
            stored.platform = platformOf(found);
        }, directory);
        return runbook;
    };

    app.post<{ Params: { udid: string } }>(`${ROUTE_PREFIX}/devices/:udid/record/quick`, async (request, reply) => {
        const found = await device(request.params.udid);
        if (!found) return html(reply, await panelFragment(request.params.udid, 'Device is not registered'));
        try {
            await startHere(found);
            return html(reply, await panelFragment(found.udid));
        } catch (error) {
            return html(reply, await panelFragment(found.udid, errorMessage(error)));
        }
    });

    /** The same press, from the wall's inspector, which speaks JSON rather than fragments. */
    app.post<{ Body: { udid?: string } }>('/api/runbooks/record/here', async (request, reply) => {
        const found = await device(request.body?.udid ?? '');
        if (!found) return reply.code(404).send({ error: 'Device is not registered' });
        try {
            const runbook = await startHere(found);
            return reply.code(201).send({ recording: true, runbookId: runbook.id, udid: found.udid, device: found.name });
        } catch (error) {
            return reply.code(409).send({ error: errorMessage(error) });
        }
    });

    /** Done: stop the recording and come back to the page, which then asks for a name. */
    app.post<{ Params: { id: string } }>(`${ROUTE_PREFIX}/runbooks/:id/done`, async (request, reply) => {
        const session = recorder.forRunbook(request.params.id);
        if (session) recorder.stop(session.udid);
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).type('text/html').send(await listFragment('Runbook not found'));
        return html(reply, await editorFragment(runbook));
    });

    /** Done asks for a name and, if you like, one line about what it is for. Nothing else. */
    const rename = async (id: string, name: string, description: string): Promise<Runbook | undefined> =>
        mutateRunbook(id, (stored) => {
            stored.name = name;
            stored.description = description;
            validateRunbook(stored as unknown as JsonValue);
        }, directory);

    app.post<{ Params: { id: string }; Body: FormBody }>(`${ROUTE_PREFIX}/runbooks/:id/name`, async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).type('text/html').send(await listFragment('Runbook not found'));
        try {
            const updated = await rename(runbook.id, field(request.body ?? {}, 'name') ?? '',
                (field(request.body ?? {}, 'description') ?? '').slice(0, 200));
            return html(reply, await editorFragment(updated ?? runbook, 'Saved.'));
        } catch (error) {
            return html(reply, await editorFragment(runbook, errorMessage(error)));
        }
    });

    app.post<{ Params: { id: string }; Body: { name?: string; description?: string } }>('/api/runbooks/:id/name', async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).send({ error: 'Runbook not found' });
        try {
            return await rename(runbook.id, String(request.body?.name ?? ''), String(request.body?.description ?? '').slice(0, 200));
        } catch (error) {
            return reply.code(400).send({ error: errorMessage(error) });
        }
    });

    const storyOf = async (runbook: Runbook, message?: string): Promise<string> => storyFragment(runbook, {
        devices: await context.loadDevices(),
        ...(recorder.forRunbook(runbook.id) ? { recordingOn: recorder.forRunbook(runbook.id)!.udid } : {}),
        ...(runs.get(runbook.id) ? { run: runs.get(runbook.id)! } : {}),
        ...(message ? { message } : {}),
    });

    app.get<{ Params: { id: string } }>(`${ROUTE_PREFIX}/runbooks/:id/story`, async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).type('text/html').send(await listFragment('Runbook not found'));
        return html(reply, await storyOf(runbook));
    });

    /** A step index out of the URL is untrusted like anything else. */
    const stepIndex = (value: string, runbook: Runbook): number => {
        const index = Number(value);
        if (!Number.isInteger(index) || index < 0 || index >= runbook.steps.length) throw new Error('That step is gone');
        return index;
    };

    /**
     * "Pick the label": the operator chooses from the texts that were on screen when the step was
     * recorded (or when it failed). Only those are accepted — the list is the whitelist.
     */
    app.post<{ Params: { id: string; index: string }; Body: FormBody }>(
        `${ROUTE_PREFIX}/runbooks/:id/steps/:index/target`, async (request, reply) => {
            const runbook = await readRunbook(request.params.id, directory);
            if (!runbook) return reply.code(404).type('text/html').send(await listFragment('Runbook not found'));
            try {
                const index = stepIndex(request.params.index, runbook);
                const chosen = field(request.body ?? {}, 'text') ?? '';
                const step = runbook.steps[index]!;
                if (step.type !== 'tap') throw new Error('That step does not tap anything');
                const offered = [...(step.seen ?? []), ...(runbook.lastFailure?.stepIndex === index ? runbook.lastFailure.visibleTexts : [])];
                if (!offered.some((text) => text === chosen)) throw new Error('That text was not on the screen');
                const updated = await mutateRunbook(runbook.id, (stored) => {
                    const target = (stored.steps[index] as Extract<Step, { type: 'tap' }>).target;
                    target.text = chosen;
                    delete target.id;
                    delete target.description;
                    delete stored.lastFailure;
                    validateRunbook(stored as unknown as JsonValue);
                }, directory);
                return html(reply, await storyOf(updated ?? runbook, `That step now looks for “${chosen}”.`));
            } catch (error) {
                return html(reply, await storyOf(runbook, errorMessage(error)));
            }
        });

    /**
     * The blank question. "Always the same" marks the line answered; "It changes each run" turns it
     * into a named blank — `{{name}}` is only how it is stored, and nobody has to type it.
     */
    app.post<{ Params: { id: string; index: string }; Body: FormBody }>(
        `${ROUTE_PREFIX}/runbooks/:id/steps/:index/blank`, async (request, reply) => {
            const runbook = await readRunbook(request.params.id, directory);
            if (!runbook) return reply.code(404).type('text/html').send(await listFragment('Runbook not found'));
            try {
                const index = stepIndex(request.params.index, runbook);
                const step = runbook.steps[index]!;
                if (step.type !== 'type') throw new Error('That step does not type anything');
                const answer = field(request.body ?? {}, 'answer');
                if (answer !== 'same' && answer !== 'changes') throw new Error('Answer whether that line changes each run');
                const name = (field(request.body ?? {}, 'name') ?? '').trim();
                if (answer === 'changes' && !BLANK_NAME_PATTERN.test(name)) {
                    throw new Error('A blank is named with letters, digits and underscores, starting with a letter');
                }
                const updated = await mutateRunbook(runbook.id, (stored) => {
                    const typed = stored.steps[index] as Extract<Step, { type: 'type' }>;
                    if (answer === 'same') typed.fixed = true;
                    else {
                        stored.lastValues = { ...stored.lastValues, [name]: typed.text };
                        typed.text = `{{${name}}}`;
                        delete typed.fixed;
                    }
                    validateRunbook(stored as unknown as JsonValue);
                }, directory);
                return html(reply, await storyOf(updated ?? runbook,
                    answer === 'changes' ? `You will be asked for the ${name} each run.` : undefined));
            } catch (error) {
                return html(reply, await storyOf(runbook, errorMessage(error)));
            }
        });

    // ---- try it now -------------------------------------------------------------------------

    /**
     * Replays the runbook on one phone, here, now, in this process — no queue, no worker, nothing
     * to wait for. The page beside it watches `runs` and lights up the sentence being run.
     */
    const tryNow = async (runbook: Runbook, found: RegisteredDevice, vars: Record<string, string>): Promise<LiveRun> => {
        const run: LiveRun = {
            runbookId: runbook.id, udid: found.udid, deviceName: found.name,
            startedAt: new Date().toISOString(), states: runbook.steps.map(() => 'pending'),
        };
        runs.set(runbook.id, run);
        const driver = createDriver(found);
        void (async () => {
            try {
                const result = await replayRunbook(driver, runbook, {
                    ...(Object.keys(vars).length ? { vars } : {}),
                    onStep: (event) => { run.states[event.index] = event.status; },
                    onScreenshot: async (label, png) => {
                        if (label === 'failure') await writeFailureScreenshot(runbook.id, png, directory).catch(() => undefined);
                    },
                });
                // Stamped before the run is announced as over, so what the page says and what the
                // list page reads back can never disagree.
                const outcome = result.stopped ? 'stopped' : 'succeeded';
                await mutateRunbook(runbook.id, (stored) => {
                    stored.lastRunAt = new Date().toISOString();
                    stored.lastRunStatus = outcome;
                    if (outcome === 'succeeded') delete stored.lastFailure;
                }, directory).catch(() => undefined);
                run.outcome = outcome;
            } catch (error) {
                run.error = errorMessage(error);
                if (error instanceof RunbookStepError) {
                    run.failedIndex = error.stepIndex;
                    run.visibleTexts = error.visibleTexts;
                    run.error = error.reason;
                    await mutateRunbook(runbook.id, (stored) => {
                        stored.lastRunAt = new Date().toISOString();
                        stored.lastRunStatus = 'failed';
                        stored.lastFailure = {
                            stepIndex: error.stepIndex, reason: error.reason, visibleTexts: error.visibleTexts,
                            at: new Date().toISOString(), deviceUdid: found.udid,
                            ...(error.screenshot ? { screenshot: `${runbook.id}-failure.png` } : {}),
                        };
                    }, directory).catch(() => undefined);
                }
                run.outcome = 'failed';
            }
        })();
        return run;
    };

    app.post<{ Params: { id: string }; Body: FormBody }>(`${ROUTE_PREFIX}/runbooks/:id/try`, async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        const devices = await context.loadDevices();
        if (!runbook) return reply.code(404).type('text/html').send(await listFragment('Runbook not found'));
        const refuse = async (message: string): Promise<FastifyReply> =>
            html(reply, runPanelFragment(runbook, devices, runs.get(runbook.id), message));
        const found = await device(field(request.body ?? {}, 'udid') ?? runbook.createdFor.udid);
        if (!found) return refuse('Choose a phone that is registered');
        if (recorder.forDevice(found.udid)) return refuse('That phone is recording — press Done first');
        if (!platformCompatible(runbook, platformOf(found))) {
            return refuse(`This was recorded on ${runbook.platform}; ${found.name} is ${platformOf(found)}`);
        }
        const vars = varsFromForm(request.body ?? {});
        const missing = variableNames(runbook).filter((name) => vars[name] === undefined);
        if (missing.length) return refuse(`Fill in the ${missing.join(' and the ')} first, from Run on device.`);
        const run = await tryNow(runbook, found, vars);
        return html(reply, runPanelFragment(runbook, devices, run));
    });

    app.get<{ Params: { id: string } }>(`${ROUTE_PREFIX}/runbooks/:id/progress`, async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).type('text/html').send('<div id="runbook-progress"></div>');
        return html(reply, runProgressFragment(runbook, runs.get(runbook.id)));
    });

    app.get<{ Params: { id: string } }>(`${ROUTE_PREFIX}/runbooks/:id/failure.png`, async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook?.lastFailure?.screenshot) return reply.code(404).send({ error: 'No picture was taken' });
        const png = await readFailureScreenshot(runbook.id, directory);
        if (!png) return reply.code(404).send({ error: 'No picture was taken' });
        return reply.type('image/png').header('cache-control', 'private, max-age=60').send(png);
    });

    // ---- export and import ------------------------------------------------------------------

    app.get<{ Params: { id: string } }>(`${ROUTE_PREFIX}/runbooks/:id/export`, async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).send({ error: 'Runbook not found' });
        // The file name is built from the id, which is pattern-checked, never from the name.
        return reply.type('application/json')
            .header('content-disposition', `attachment; filename="${runbook.id}.json"`)
            .send(`${JSON.stringify(runbook, null, 2)}\n`);
    });

    /** Restore starter runbooks, as JSON and as the button on the Runbooks page. */
    app.post('/api/runbooks/templates/install', async (_request, reply) => {
        try {
            const result = await installStarterRunbooks(directory);
            return reply.send({ ...result, message: describeInstall(result) });
        } catch (error) {
            return reply.code(500).send({ error: errorMessage(error) });
        }
    });

    app.post(`${ROUTE_PREFIX}/runbooks/templates/install`, async (_request, reply) => {
        try {
            return html(reply, await listFragment(describeInstall(await installStarterRunbooks(directory))));
        } catch (error) {
            return html(reply, await listFragment(errorMessage(error)));
        }
    });

    app.post(`${ROUTE_PREFIX}/runbooks/import`, async (request, reply) => {
        if (typeof request.isMultipart !== 'function' || !request.isMultipart()) {
            return html(reply, await listFragment('Choose a runbook file to import'));
        }
        try {
            let raw: string | undefined;
            for await (const part of request.parts()) {
                if (part.type !== 'file' || part.fieldname !== 'runbook') continue;
                raw = (await part.toBuffer()).toString('utf8');
            }
            if (!raw) throw new Error('Choose a runbook file to import');
            // Imported files are as untrusted as any other body: every field is validated, and the
            // id and the timestamps are the farm's own, never the file's.
            const parsed = validateRunbook({
                ...(JSON.parse(raw) as JsonObject), id: newRunbookId(), createdAt: new Date().toISOString(),
            } as JsonValue);
            await writeRunbook(parsed, directory);
            return html(reply, await listFragment(`Imported “${parsed.name}”.`));
        } catch (error) {
            return html(reply, await listFragment(`That file is not a runbook: ${errorMessage(error)}`));
        }
    });

    // The device page asks who, if anyone, is recording so its remote actions know where to post.
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/runbook-recording', async (request) => {
        const session = recorder.forDevice(request.params.udid);
        return session ? { recording: true, runbookId: session.runbookId, steps: session.steps } : { recording: false };
    });
}
