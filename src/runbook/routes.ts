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
    MAX_STEPS, newRunbookId, platformCompatible, validatePlatform, validateRunbook, validateSteps,
    type Runbook, type Step,
} from './model.js';
import { createRecorder, validateRemoteAction, type Recorder } from './recorder.js';
import {
    ROUTE_PREFIX, devicePanelFragment, runbookEditorFragment, runbookListFragment, runbookPage, runbooksPage,
} from './html.js';
import { deleteRunbook, listRunbooks, mutateRunbook, readRunbook, writeRunbook } from './store.js';

const STATIC_ROOT = fileURLToPath(new URL('../../static/dashboard/', import.meta.url));

export interface RunbookRoutesOptions {
    /** Overrides SCHEDULER_DATA_DIR/runbooks; tests point it at a temp directory. */
    directory?: string;
    createDriver?: (device: RegisteredDevice) => DeviceDriver;
    recorder?: Recorder;
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

    const pageScript = await readFile(path.join(STATIC_ROOT, 'assets/runbooks.js'), 'utf8')
        .catch(() => '/* run npm run build:web */');
    const pageStyles = await readFile(path.join(STATIC_ROOT, 'pages.css'), 'utf8').catch(() => '');
    const chrome = { assetVersion: `?v=${crypto.createHash('sha1').update(pageScript + pageStyles).digest('base64url').slice(0, 10)}` };
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
    const editorFragment = async (runbook: Runbook, message?: string): Promise<string> => {
        const session = recorder.forRunbook(runbook.id);
        return runbookEditorFragment(runbook, await context.loadDevices(), message, session?.udid);
    };
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
        const step = await recorder.record(session, action, createDriver(found));
        let updated: Runbook | undefined;
        try {
            updated = await mutateRunbook(request.params.id, (stored) => {
                if (stored.steps.length >= MAX_STEPS) throw new Error(`A runbook holds at most ${MAX_STEPS} steps`);
                stored.steps.push(step);
            }, directory);
        } catch (error) {
            return reply.code(409).send({ error: errorMessage(error) });
        }
        if (!updated) return reply.code(404).send({ error: 'Runbook not found' });
        return reply.code(201).send({ step, steps: updated.steps.length });
    });

    // ---- Pages and fragments --------------------------------------------------------------

    app.get('/runbooks', async (_request, reply) =>
        html(reply, runbooksPage(await listRunbooks(directory), await context.loadDevices(), chrome)));

    app.get<{ Params: { id: string } }>('/runbooks/:id', async (request, reply) => {
        const runbook = await readRunbook(request.params.id, directory);
        if (!runbook) return reply.code(404).type('text/html').send(runbooksPage(await listRunbooks(directory), await context.loadDevices(), chrome));
        return html(reply, runbookPage(runbook, await context.loadDevices(), chrome, recorder.forRunbook(runbook.id)?.udid));
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

    // The device page asks who, if anyone, is recording so its remote actions know where to post.
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/runbook-recording', async (request) => {
        const session = recorder.forDevice(request.params.udid);
        return session ? { recording: true, runbookId: session.runbookId, steps: session.steps } : { recording: false };
    });
}
