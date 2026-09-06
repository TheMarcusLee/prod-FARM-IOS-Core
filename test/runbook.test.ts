import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { inject } from './support.js';
import type { DeviceDriver, Point, ScreenGeometry, Swipe, UiNode } from '../src/drivers/types.js';
import type { RegisteredDevice } from '../src/devices/registry.js';
import type { TaskExecutionContext } from '../src/plugin.js';
import type { JsonValue } from '../src/types.js';
import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import { visibleTexts } from '../src/drivers/verify.js';
import { safeFixUrl } from '../src/fleet/scheduler-events.js';
import {
    applyVariables, validateRunbook, validateStep, variableNames, type Runbook, type Step,
} from '../src/runbook/model.js';
import {
    autoWaitStep, confidenceWords, describeStep, newTexts, stepConfidence,
} from '../src/runbook/narrate.js';
import { createRecorder, stepFromAction, targetAtPoint, validateRemoteAction } from '../src/runbook/recorder.js';
import { RunbookStepError, replayRunbook, resolveTapPoint } from '../src/runbook/replay.js';
import { devicePanelFragment, orderRunbooks, runbookListFragment, scriptLiteral } from '../src/runbook/html.js';
import { describeInstall, installStarterRunbooks, loadStarterRunbooks } from '../src/runbook/starters.js';
import { blankFields } from '../src/runbook/story.js';
import { stepsFromForm } from '../src/runbook/routes.js';
import { listRunbooks, readRunbook, writeRunbook } from '../src/runbook/store.js';
import { createRunbookPlugin } from '../src/runbook-plugin.js';

process.env.ANDROID_DISCOVERY = 'off';

const workspace = await mkdtemp(path.join(os.tmpdir(), 'pf-runbook-'));
const configPath = path.join(workspace, 'devices.json');
process.env.DEVICES_CONFIG_PATH = configPath;

const { createApp } = await import('../src/api/app.js');

const SERIAL = 'R58N12ABCDE';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const SCREEN: ScreenGeometry = { width: 1080, height: 2400, scale: 1 };

function node(partial: Partial<UiNode>): UiNode {
    return {
        id: '', type: 'android.view.View', text: '', description: '',
        bounds: { left: 0, top: 0, right: 0, bottom: 0 },
        clickable: false, enabled: true, children: [], ...partial,
    };
}

/** A row with a resource-id, a label inside it, and an unlabelled icon beside the label. */
const tree: UiNode = node({
    bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
    children: [
        node({
            id: 'com.app:id/follow_row', clickable: true, bounds: { left: 0, top: 0, right: 1080, bottom: 200 },
            children: [
                node({ text: 'Follow', bounds: { left: 100, top: 50, right: 300, bottom: 150 } }),
                node({ bounds: { left: 800, top: 50, right: 900, bottom: 150 } }),
            ],
        }),
        node({ id: 'com.app:id/submit', clickable: true, bounds: { left: 0, top: 1000, right: 1080, bottom: 1200 } }),
        node({ text: 'Submit', bounds: { left: 0, top: 2000, right: 400, bottom: 2100 } }),
    ],
});

interface DriverCalls { taps: Point[]; swipes: Swipe[]; typed: string[]; keys: string[]; launched: string[] }

function calls(): DriverCalls {
    return { taps: [], swipes: [], typed: [], keys: [], launched: [] };
}

function fakeDriver(recorded: DriverCalls, root: UiNode | undefined = tree, overrides: Partial<DeviceDriver> = {}): DeviceDriver {
    return {
        kind: 'adb', platform: 'android', udid: SERIAL,
        async launchApp(appId) { recorded.launched.push(appId); },
        async terminateApp() {},
        async tap(point) { recorded.taps.push(point); },
        async swipe(swipe) { recorded.swipes.push(swipe); },
        async gesture() {},
        async type(text) { recorded.typed.push(text); },
        async pressKey(key) { recorded.keys.push(key); },
        async screenshot() { return PNG; },
        async uiTree() { if (!root) throw new Error('no tree'); return root; },
        async screen() { return SCREEN; },
        async pushMedia() {},
        async pause() {},
        ...overrides,
    };
}

/** Polls until something is there, so a test never races an in-process replay. */
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error('Timed out waiting for the run to finish');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/** A multipart body with one file field, built by hand so no test dependency is needed. */
function multipart(field: string, filename: string, content: string): {
    payload: Buffer; headers: Record<string, string>;
} {
    const boundary = '----BacklineRunbookTest';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`
        + `Content-Type: application/json\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    return { payload: Buffer.from(body), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function runbook(steps: Step[], overrides: Partial<Runbook> = {}): Runbook {
    return {
        id: 'rb-test0001abcd', name: 'Test runbook', description: '', platform: 'any',
        createdFor: { udid: SERIAL, screen: SCREEN },
        steps, version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

test('the model validates a runbook and names what is wrong with a bad step', () => {
    const valid = validateRunbook(runbook([
        { type: 'launchApp', appId: 'com.app' },
        { type: 'tap', target: { id: 'com.app:id/submit', fraction: { x: 0.5, y: 0.5 } }, retries: 2, optional: true },
        { type: 'assert', text: 'Done', expect: 'present' },
    ]) as unknown as JsonValue);
    assert.equal(valid.steps.length, 3);
    assert.equal(valid.steps[1]!.retries, 2);
    assert.equal(valid.steps[1]!.optional, true);

    assert.throws(() => validateStep({ type: 'teleport' }, 0), /unknown type "teleport"/);
    assert.throws(() => validateStep({ type: 'tap', target: { fraction: { x: 4, y: 0 } } }, 0), /fraction between 0 and 1/);
    assert.throws(() => validateStep({ type: 'waitForText', timeoutMs: 1_000 }, 2), /needs a text or an id/);
    assert.throws(() => validateRunbook({ ...runbook([]), version: 2 } as unknown as JsonValue), /version 1/);
});

test('variables are substituted, and a missing one is an error rather than an empty string', () => {
    assert.equal(applyVariables('hello {{name}}', { name: 'farm' }), 'hello farm');
    assert.throws(() => applyVariables('hello {{name}}', {}), /Missing value for variable \{\{name\}\}/);
});

test('a tap resolves by id, then by text, and finally by the recorded fraction', async () => {
    const driver = fakeDriver(calls());
    const byId = await resolveTapPoint(driver, { id: 'com.app:id/submit', text: 'Submit', fraction: { x: 0.9, y: 0.9 } });
    assert.equal(byId.via, 'id');
    assert.deepEqual(byId.point, { x: 540, y: 1100 });

    const byText = await resolveTapPoint(driver, { text: 'Submit', fraction: { x: 0.9, y: 0.9 } });
    assert.equal(byText.via, 'text');
    assert.deepEqual(byText.point, { x: 200, y: 2050 });

    const byFraction = await resolveTapPoint(driver, { id: 'com.app:id/gone', text: 'Nowhere', fraction: { x: 0.5, y: 0.25 } });
    assert.equal(byFraction.via, 'fraction');
    assert.deepEqual(byFraction.point, { x: 540, y: 600 });
});

test('the OCR fallback is used only when the tree cannot see the text', async () => {
    const driver = fakeDriver(calls(), undefined);
    const resolved = await resolveTapPoint(driver, { text: 'Continue', fraction: { x: 0, y: 0 } }, async () => [
        { text: 'Continue', bounds: { left: 100, top: 200, right: 300, bottom: 260 } },
    ]);
    assert.equal(resolved.via, 'ocr');
    assert.deepEqual(resolved.point, { x: 200, y: 230 });
});

test('replay drives every step type through the driver', async () => {
    const recorded = calls();
    const logs: string[] = [];
    const result = await replayRunbook(fakeDriver(recorded), runbook([
        { type: 'launchApp', appId: 'com.app' },
        { type: 'tap', target: { id: 'com.app:id/submit', fraction: { x: 0.1, y: 0.1 } } },
        { type: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, durationMs: 300 },
        { type: 'type', text: 'hello {{who}}' },
        { type: 'key', key: 'back' },
        { type: 'assert', text: 'Submit', expect: 'present' },
        { type: 'screenshot', label: 'after' },
    ]), { vars: { who: 'farm' }, log: (line) => { logs.push(line); } });

    assert.deepEqual(result, { stepsRun: 7, stepsSkipped: 0, stopped: false });
    assert.deepEqual(recorded.launched, ['com.app']);
    assert.deepEqual(recorded.taps, [{ x: 540, y: 1100 }]);
    // A replayed swipe keeps the straight line it was recorded as; see src/motion/gesture.ts.
    assert.deepEqual(recorded.swipes, [{ from: { x: 540, y: 1920 }, to: { x: 540, y: 480 }, durationMs: 300, straight: true }]);
    assert.deepEqual(recorded.typed, ['hello farm']);
    assert.deepEqual(recorded.keys, ['back']);
    assert.ok(logs.some((line) => line.includes('resolved by id')));
    assert.ok(logs.some((line) => line.includes('captured "after"')));
});

test('a step retries, an optional step is skipped, and a failure names the step and the screen', async () => {
    const recorded = calls();
    let attempts = 0;
    const flaky = fakeDriver(recorded, tree, {
        async tap(point) {
            attempts += 1;
            if (attempts < 3) throw new Error('touch rejected');
            recorded.taps.push(point);
        },
    });
    const retried = await replayRunbook(flaky, runbook([
        { type: 'tap', target: { id: 'com.app:id/submit', fraction: { x: 0, y: 0 } }, retries: 2, retryDelayMs: 0 },
    ]));
    assert.equal(attempts, 3);
    assert.equal(retried.stepsRun, 1);

    const skipped = await replayRunbook(fakeDriver(calls()), runbook([
        { type: 'assert', text: 'Nowhere', expect: 'present', optional: true },
        { type: 'key', key: 'home' },
    ]));
    assert.deepEqual(skipped, { stepsRun: 1, stepsSkipped: 1, stopped: false });

    const failure = await replayRunbook(fakeDriver(calls()), runbook([
        { type: 'key', key: 'home' },
        { type: 'assert', id: 'com.app:id/missing', expect: 'present' },
    ])).then(() => undefined, (error: unknown) => error);
    assert.ok(failure instanceof RunbookStepError);
    assert.equal(failure.stepIndex, 1);
    assert.match(failure.message, /Step 2 \(assert #com\.app:id\/missing is present\) failed/);
    assert.match(failure.message, /Screen showed: Follow, Submit/);
});

test('replay stops promptly when the execution is aborted', async () => {
    const controller = new AbortController();
    const recorded = calls();
    controller.abort();
    const result = await replayRunbook(fakeDriver(recorded), runbook([{ type: 'key', key: 'home' }]), { signal: controller.signal });
    assert.deepEqual(result, { stepsRun: 0, stepsSkipped: 0, stopped: true });
    assert.deepEqual(recorded.keys, []);
});

test('the recorder enriches a tap from the tree it captured before the tap', () => {
    const labelled = targetAtPoint(tree, { x: 200, y: 100 }, SCREEN);
    assert.deepEqual(labelled, { text: 'Follow', fraction: { x: 0.18519, y: 0.04167 } });

    // An unlabelled icon inside a labelled row records the row's id — that is what replays.
    const icon = targetAtPoint(tree, { x: 850, y: 100 }, SCREEN);
    assert.equal(icon.id, 'com.app:id/follow_row');

    // With no tree at all the fraction is still recorded.
    assert.deepEqual(targetAtPoint(undefined, { x: 540, y: 1200 }, SCREEN), { fraction: { x: 0.5, y: 0.5 } });

    assert.deepEqual(stepFromAction({ type: 'home' }, SCREEN), { type: 'key', key: 'home' });
    assert.deepEqual(
        stepFromAction({ type: 'swipe', startX: 540, startY: 1920, endX: 540, endY: 480, durationMs: 350 }, SCREEN),
        { type: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, durationMs: 350 },
    );
    assert.throws(() => validateRemoteAction({ type: 'lock' }), /device-state action/);
    assert.throws(() => validateRemoteAction({ type: 'tap', x: 'left' }), /screen coordinate/);
});

test('the plugin validates its payload against the stored runbooks', async () => {
    const directory = path.join(workspace, 'validate');
    await writeRunbook(runbook([{ type: 'key', key: 'home' }]), directory);
    const registry = new PluginRegistry([createRunbookPlugin({ directory })]);
    const validated = registry.validate({
        deviceUdid: SERIAL,
        task: { pluginId: 'com.farm.runbook', taskType: 'run', taskVersion: 1, payload: { runbookId: 'rb-test0001abcd', vars: { who: 'farm' } } },
        timing: { kind: 'now' },
    });
    assert.deepEqual(validated.task.payload, { runbookId: 'rb-test0001abcd', vars: { who: 'farm' } });

    assert.throws(() => registry.validate({
        deviceUdid: SERIAL,
        task: { pluginId: 'com.farm.runbook', taskType: 'run', taskVersion: 1, payload: { runbookId: 'rb-missing0001' } },
        timing: { kind: 'now' },
    }), /does not exist/);
    assert.throws(() => registry.validate({
        deviceUdid: SERIAL,
        task: { pluginId: 'com.farm.runbook', taskType: 'run', taskVersion: 1, payload: { runbookId: 'rb-test0001abcd', vars: { 'not a name': 'x' } } },
        timing: { kind: 'now' },
    }), /not a valid variable name/);
});

function executionContext(driver: DeviceDriver, logs: string[], platform: 'ios' | 'android' = 'android'): TaskExecutionContext {
    return {
        executionId: 'exec-1', attempt: 1, workspaceDirectory: workspace,
        device: { udid: SERIAL, name: 'Pixel 7', platform },
        devicePluginData: {},
        automation: {
            activateApp: async () => {}, terminateApp: async () => {}, pause: async () => {},
            screenshot: async () => PNG, tap: async () => {}, swipe: async () => {},
        },
        driver, assets: [], signal: new AbortController().signal,
        async log(line) { logs.push(line); },
        async runProcess() { throw new Error('a runbook replays in process'); },
    };
}

test('the plugin replays in process and reports a platform mismatch as a clear failure', async () => {
    const directory = path.join(workspace, 'execute');
    await writeRunbook(runbook([
        { type: 'launchApp', appId: 'com.app' },
        { type: 'tap', target: { text: 'Submit', fraction: { x: 0, y: 0 } } },
    ]), directory);
    const plugin = createRunbookPlugin({ directory });
    const task = plugin.tasks[0]!;
    const recorded = calls();
    const logs: string[] = [];
    const result = await task.execute(executionContext(fakeDriver(recorded), logs), { runbookId: 'rb-test0001abcd' });
    assert.deepEqual(result, { exitCode: 0, stopped: false });
    assert.deepEqual(recorded.launched, ['com.app']);
    assert.deepEqual(recorded.taps, [{ x: 200, y: 2050 }]);
    assert.ok(logs.some((line) => line.includes('Replaying "Test runbook"')));

    await writeRunbook(runbook([{ type: 'key', key: 'home' }], { id: 'rb-ios00001abc', platform: 'ios' }), directory);
    const mismatch = await task.execute(executionContext(fakeDriver(calls()), []), { runbookId: 'rb-ios00001abc' });
    assert.match(mismatch.error ?? '', /recorded for ios; Pixel 7 is android/);

    const missingVar = await writeRunbook(runbook([{ type: 'type', text: 'hi {{who}}' }], { id: 'rb-vars0001abc' }), directory);
    const failed = await task.execute(executionContext(fakeDriver(calls()), []), { runbookId: missingVar.id });
    assert.match(failed.error ?? '', /Missing values for \{\{who\}\}/);

    // Every run stamps the runbook with when it ran and how it went; that is what the
    // list page's last column shows instead of "Updated".
    const ran = await readRunbook('rb-test0001abcd', directory);
    assert.equal(ran?.lastRunStatus, 'succeeded');
    assert.match(ran?.lastRunAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((await readRunbook('rb-ios00001abc', directory))?.lastRunStatus, 'failed');
    assert.equal((await readRunbook(missingVar.id, directory))?.lastRunStatus, 'failed');

    // A runbook nobody has run yet has neither, and the list page says so in words.
    const never = await writeRunbook(runbook([{ type: 'key', key: 'home' }], { id: 'rb-never001abc' }), directory);
    assert.equal(never.lastRunAt, undefined);
    const rows = runbookListFragment(
        [(await readRunbook('rb-test0001abcd', directory))!, never], [],
    );
    assert.match(rows, /Last run/);
    assert.doesNotMatch(rows, />Updated</);
    assert.match(rows, /Never run/);
    assert.match(rows, new RegExp(`bl-dot ok"></span>${ran!.lastRunAt!.slice(0, 10)}`));
});

async function appWithRunbooks(directory: string, created: unknown[] = []): Promise<Awaited<ReturnType<typeof createApp>>> {
    await writeFile(configPath, JSON.stringify([
        { name: 'Pixel 7', udid: SERIAL, platform: 'android', driver: 'adb', android: { serial: SERIAL }, pluginData: {} },
    ]));
    return createApp({
        // The starter library is seeded on boot in production; these tests want an empty farm.
        plugins: new PluginRegistry([createRunbookPlugin({ directory, createDriver: () => fakeDriver(calls()), installStarters: false })]),
        scheduler: {
            async activeExecution() { return null; },
            async createTask(input: unknown) { created.push(input); return {}; },
        } as unknown as SchedulerRepository,
    });
}

test('the routes create a runbook, record enriched steps into it, and serve the pages', async (context) => {
    const directory = path.join(workspace, 'routes');
    const created: unknown[] = [];
    const app = await appWithRunbooks(directory, created);
    context.after(() => app.close());

    const create = await inject(app, {
        method: 'POST', url: '/api/runbooks',
        payload: { name: 'Follow flow', description: 'Taps follow', platform: 'any', udid: SERIAL },
    });
    assert.equal(create.statusCode, 201);
    const id = (create.json() as Runbook).id;
    assert.deepEqual((create.json() as Runbook).createdFor.screen, SCREEN);

    const started = await inject(app, { method: 'POST', url: `/api/runbooks/${id}/record/start`, payload: { udid: SERIAL } });
    assert.equal(started.statusCode, 200);
    // Recording an empty runbook adopts the phone it was recorded on.
    assert.equal((await readRunbook(id, directory))!.platform, 'android');

    const step = await inject(app, {
        method: 'POST', url: `/api/runbooks/${id}/steps`, payload: { action: { type: 'tap', x: 200, y: 100 } },
    });
    assert.equal(step.statusCode, 201);
    assert.deepEqual((step.json() as { step: Step }).step, {
        type: 'tap', target: { text: 'Follow', fraction: { x: 0.18519, y: 0.04167 } },
        // What was on screen, kept so "pick the label" can offer it later without the phone.
        seen: ['Follow', 'Submit'],
    });

    const refused = await inject(app, {
        method: 'POST', url: `/api/runbooks/${id}/steps`, payload: { action: { type: 'unlock' } },
    });
    assert.equal(refused.statusCode, 400);

    const stopped = await inject(app, { method: 'POST', url: `/api/runbooks/${id}/record/stop`, payload: {} });
    assert.equal(stopped.statusCode, 200);
    const notRecording = await inject(app, {
        method: 'POST', url: `/api/runbooks/${id}/steps`, payload: { action: { type: 'home' } },
    });
    assert.equal(notRecording.statusCode, 409);

    const page = await inject(app, { method: 'GET', url: '/runbooks' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Follow flow/);
    // Both pages render through the Backline shell, and "Run on device" is a real dialog.
    assert.match(page.body, /<title>Runbooks · Backline<\/title>/);
    assert.match(page.body, /class="bl-nav"/);
    assert.match(page.body, new RegExp(`<dialog class="bl-dialog" id="run-${id}"`));
    assert.match(page.body, /data-dialog="new-runbook"/);
    assert.doesNotMatch(page.body, /iOS Farm|Phone Farm|Handler|Agniverse|gethandler/);

    const editor = await inject(app, { method: 'GET', url: `/runbooks/${id}` });
    assert.match(editor.body, /Save steps/, 'the raw steps are still there, folded away');
    assert.match(editor.body, /class="bl-steps"/);
    assert.match(editor.body, /Record what I do next/, 'recording starts from the editor too');
    assert.match(editor.body, /Run it on this phone now/);
    assert.match(editor.body, /Tapped Follow/, 'the step reads as a sentence');
    assert.match(editor.body, /Recorded on Pixel 7 · works on Android; iPhone untested/);
    assert.match(editor.body, /\/assets\/pages\.css/);

    // The story is sentences and nothing else: no step types, no tables, no braces.
    const story = await inject(app, { method: 'GET', url: `/plugins/com.farm.runbook/runbooks/${id}/story` });
    assert.match(story.body, /Tapped Follow/);
    assert.doesNotMatch(story.body, /<table|<select|timeoutMs=|name="step\./);

    const script = await inject(app, { method: 'GET', url: '/assets/runbooks.js' });
    assert.equal(script.statusCode, 200);
    assert.match(String(script.headers['content-type']), /javascript/);

    const panel = await inject(app, { method: 'GET', url: `/plugins/com.farm.runbook/devices/${SERIAL}/panel` });
    assert.match(panel.body, /Record what I do next/);
    assert.match(panel.body, /id="runbook-panel"/);
    assert.match(panel.body, /class="bl-inline-form"/, 'the panel fragment is on the tokens');

    // Recording started from the editor comes back as the editor, with its banner.
    const recording = await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${id}/record/start-form`,
        payload: `udid=${SERIAL}`, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(recording.statusCode, 200);
    assert.match(recording.body, /id="runbook-editor"/);
    assert.match(recording.body, /bl-rb-banner/);
    assert.match(recording.body, /Recording on Pixel 7/);
    const editorAfterStop = await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${id}/done`, payload: {},
    });
    assert.match(editorAfterStop.body, /Record what I do next/);
    assert.doesNotMatch(editorAfterStop.body, /bl-rb-banner/);

    const run = await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${id}/run`,
        payload: `udid=${SERIAL}&view=list`, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(run.statusCode, 200);
    assert.equal(created.length, 1);
    assert.deepEqual((created[0] as { task: { payload: unknown } }).task.payload, { runbookId: id });
});

test('replacing a runbook validates every step, and duplicate and delete behave', async (context) => {
    const directory = path.join(workspace, 'edit');
    const app = await appWithRunbooks(directory);
    context.after(() => app.close());

    const stored = await writeRunbook(runbook([{ type: 'key', key: 'home' }]), directory);
    const bad = await inject(app, {
        method: 'PUT', url: `/api/runbooks/${stored.id}`,
        payload: { ...stored, steps: [{ type: 'tap', target: { fraction: { x: 2, y: 0 } } }] },
    });
    assert.equal(bad.statusCode, 400);
    assert.match((bad.json() as { error: string }).error, /fraction between 0 and 1/);

    const good = await inject(app, {
        method: 'PUT', url: `/api/runbooks/${stored.id}`,
        payload: { ...stored, name: 'Renamed', steps: [{ type: 'wait', ms: 500 }] },
    });
    assert.equal(good.statusCode, 200);
    assert.equal((good.json() as Runbook).name, 'Renamed');

    const copy = await inject(app, { method: 'POST', url: `/api/runbooks/${stored.id}/duplicate`, payload: {} });
    assert.equal(copy.statusCode, 201);
    assert.equal((copy.json() as Runbook).name, 'Renamed copy');
    assert.equal((await inject(app, { method: 'GET', url: '/api/runbooks' })).json<{ runbooks: Runbook[] }>().runbooks.length, 2);

    const removed = await inject(app, { method: 'DELETE', url: `/api/runbooks/${stored.id}` });
    assert.equal(removed.statusCode, 204);
    assert.equal(await readRunbook(stored.id, directory), undefined);
    assert.equal((await inject(app, { method: 'GET', url: `/api/runbooks/${stored.id}` })).statusCode, 404);
});

test('a runbook file is written atomically and never escapes its directory', async () => {
    const directory = path.join(workspace, 'store');
    const stored = await writeRunbook(runbook([{ type: 'wait', ms: 10 }]), directory);
    const raw = JSON.parse(await readFile(path.join(directory, `${stored.id}.json`), 'utf8')) as Runbook;
    assert.equal(raw.steps.length, 1);
    await assert.rejects(async () => readRunbook('../../etc/passwd', directory), /id must be/);
});

test('the step editor form maps rows to steps, dropping blank and deleted ones', () => {
    const steps = stepsFromForm({
        'step.0.type': 'launchApp', 'step.0.value': 'com.app',
        'step.1.type': 'tap', 'step.1.id': 'com.app:id/submit', 'step.1.x': '0.5', 'step.1.y': '0.25',
        'step.1.retries': '2', 'step.1.retryDelayMs': '250', 'step.1.optional': 'on',
        'step.2.type': 'waitForText', 'step.2.text': 'Done', 'step.2.ms': '5000',
        'step.3.type': 'wait', 'step.3.ms': '1000', 'step.3.delete': 'on',
        'step.4.type': '',
    });
    assert.deepEqual(steps, [
        { type: 'launchApp', appId: 'com.app' },
        { type: 'tap', retries: 2, retryDelayMs: 250, optional: true, target: { id: 'com.app:id/submit', fraction: { x: 0.5, y: 0.25 } } },
        { type: 'waitForText', text: 'Done', timeoutMs: 5_000 },
    ]);
    assert.throws(() => stepsFromForm({ 'step.0.type': 'assert', 'step.0.text': 'Done' }), /expect must be/);
});

test('the recording flag is escaped for the script it lands in, not for HTML', () => {
    // The id is pattern-checked on the way in, so this is defence in depth —
    // but HTML escaping inside a <script> is simply the wrong escape: `&#39;`
    // is not a quote to the JS parser and `</script>` still ends the element.
    const hostile = "x'; document.body.remove(); //</script><img src=x onerror=alert(1)>";
    const panel = devicePanelFragment(
        'udid-1', [],
        { runbookId: hostile, udid: 'udid-1', screen: { width: 1, height: 1, scale: 1 }, texts: [], startedAt: '', steps: 0 },
        undefined,
    );
    assert.ok(!panel.includes('</script><img'), 'the element must not be closed early');
    assert.ok(panel.includes('\\u003c/script\\u003e'));
    // The value is still delivered, as one JS string literal — and nothing the
    // browser's HTML parser could read as markup survives inside it.
    const flag = /dataset\.runbookRecording = (.*);<\/script>/.exec(panel)?.[1] as string;
    assert.ok(!/[<>&]/.test(flag), flag);
    assert.equal(JSON.parse(flag), hostile);

    assert.equal(scriptLiteral(''), '""');
    assert.equal(scriptLiteral('rb-abc12345'), '"rb-abc12345"');
    assert.equal(scriptLiteral('a&b'), '"a\\u0026b"');
});

test('saving the step editor cannot drop a step an open recording just appended', async (context) => {
    const directory = path.join(workspace, 'concurrent-edit');
    const app = await appWithRunbooks(directory);
    context.after(() => app.close());

    const create = await inject(app, {
        method: 'POST', url: '/api/runbooks', payload: { name: 'Race', platform: 'any', udid: SERIAL },
    });
    const id = (create.json() as Runbook).id;
    await inject(app, { method: 'POST', url: `/api/runbooks/${id}/record/start`, payload: { udid: SERIAL } });

    // The editor form save and a recorded step overlap. Both read-modify-write
    // the same file; the editor used to bypass the mutation queue and clobber.
    const [, recorded] = await Promise.all([
        inject(app, {
            method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${id}/steps-form`,
            payload: 'baseCount=0&step.0.type=wait&step.0.ms=500',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
        inject(app, {
            method: 'POST', url: `/api/runbooks/${id}/steps`, payload: { action: { type: 'home' } },
        }),
    ]);
    assert.equal(recorded.statusCode, 201);

    const saved = await readRunbook(id, directory);
    const types = saved!.steps.map((step) => step.type);
    // Whichever order the two landed in, the edited list comes first and the recorded step survives.
    assert.deepEqual(types, ['wait', 'key']);
});

test('a rejected runbook body is a 400 that names the field', async (context) => {
    const directory = path.join(workspace, 'bad-body');
    const app = await appWithRunbooks(directory);
    context.after(() => app.close());

    const noName = await inject(app, { method: 'POST', url: '/api/runbooks', payload: { platform: 'any' } });
    assert.equal(noName.statusCode, 400);
    assert.match((noName.json() as { error: string }).error, /name/);

    const badPlatform = await inject(app, {
        method: 'POST', url: '/api/runbooks', payload: { name: 'x', platform: 'symbian' },
    });
    assert.equal(badPlatform.statusCode, 400);
    assert.match((badPlatform.json() as { error: string }).error, /platform/);
});

/* ---- the simple flow: sentences, auto-waits, blanks, try it now -------- */

test('every step type reads back as a plain sentence', () => {
    const sentences = ([
        { type: 'launchApp', appId: 'com.zhiliaoapp.musically' },
        { type: 'tap', target: { text: 'Create', fraction: { x: 0.5, y: 0.9 } } },
        { type: 'tap', target: { id: 'com.app:id/follow_row', fraction: { x: 0.5, y: 0.1 } } },
        { type: 'tap', target: { fraction: { x: 0.5, y: 0.82 } } },
        { type: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, durationMs: 300 },
        { type: 'swipe', from: { x: 0.2, y: 0.5 }, to: { x: 0.8, y: 0.5 }, durationMs: 300 },
        { type: 'type', text: 'hello farm' },
        { type: 'type', text: '{{caption}}' },
        { type: 'key', key: 'back' },
        { type: 'key', key: 'home' },
        { type: 'wait', ms: 2_000 },
        { type: 'waitForText', text: 'Upload', timeoutMs: 15_000 },
        { type: 'assert', text: 'Done', expect: 'present' },
        { type: 'assert', id: 'com.app:id/spinner', expect: 'absent' },
        { type: 'screenshot', label: 'after' },
    ] as Step[]).map((step) => describeStep(step));

    assert.deepEqual(sentences, [
        'Opened TikTok',
        'Tapped Create',
        'Tapped Follow row',
        'Tapped the screen 50% across, 82% down',
        'Swiped up',
        'Swiped right',
        'Typed “hello farm”',
        'Typed the caption',
        'Pressed back',
        'Went to the home screen',
        'Waited 2 seconds',
        'Waited for “Upload” to appear',
        'Checked that “Done” is on screen',
        'Checked that Spinner is gone',
        'Took a picture of the screen (after)',
    ]);
    // Nothing an operator reads mentions the engine.
    for (const sentence of sentences) assert.doesNotMatch(sentence, /\{\{|timeout|retr|step type/i);
});

test('a tap keeps its confidence: green by name, amber by position alone', () => {
    assert.equal(stepConfidence({ type: 'tap', target: { id: 'com.app:id/submit', fraction: { x: 0, y: 0 } } }), 'sure');
    assert.equal(stepConfidence({ type: 'tap', target: { text: 'Follow', fraction: { x: 0, y: 0 } } }), 'sure');
    assert.equal(stepConfidence({ type: 'tap', target: { fraction: { x: 0.5, y: 0.5 } } }), 'position');
    assert.equal(stepConfidence({ type: 'key', key: 'home' }), 'sure');
    assert.match(confidenceWords({ type: 'tap', target: { fraction: { x: 0, y: 0 } } }), /pick the label/);
});

test('a screen that changed between two actions earns a wait, a screen that barely moved does not', () => {
    const before = node({
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        children: [node({ text: 'For You' }), node({ text: 'Following' }), node({ text: 'Likes 41' })],
    });
    const after = node({
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        children: [node({ text: 'For You' }), node({ text: 'Upload a video' }), node({ text: 'Choose from gallery' })],
    });
    const wait = autoWaitStep(visibleTexts(before), visibleTexts(after));
    assert.deepEqual(wait, {
        type: 'waitForText', text: 'Upload a video', timeoutMs: 15_000,
        seen: ['Upload a video', 'Choose from gallery'],
    });
    assert.equal(describeStep(wait!), 'Waited for “Upload a video” to appear');

    // One counter ticking over is not a new screen.
    const twitch = node({
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        children: [node({ text: 'For You' }), node({ text: 'Following' }), node({ text: 'Likes 42' })],
    });
    assert.equal(autoWaitStep(visibleTexts(before), visibleTexts(twitch)), undefined);
    assert.deepEqual(newTexts(['A', 'B'], ['b', 'C']), ['C']);
});

test('recording inserts the wait it earned in front of the next action', async () => {
    const first = node({ bounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, children: [node({ text: 'Feed' })] });
    const second = node({
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        children: [node({ text: 'Upload a video' }), node({ text: 'Choose from gallery' })],
    });
    let root = first;
    const recorder = createRecorder();
    const driver = fakeDriver(calls(), first, { async uiTree() { return root; } });
    const session = await recorder.start(SERIAL, 'rb-test0001abcd', driver);

    const one = await recorder.record(session, { type: 'tap', x: 100, y: 100 }, driver);
    assert.deepEqual(one.map((step) => step.type), ['tap'], 'the first action has nothing in front of it');
    root = second;
    // The tree the recorder re-reads after that tap is the new screen, so the next action waits.
    await recorder.record(session, { type: 'home' }, driver);
    root = second;
    const three = await recorder.record(session, { type: 'tap', x: 200, y: 200 }, driver);
    assert.deepEqual(three.map((step) => step.type), ['waitForText', 'tap']);
    assert.equal(describeStep(three[0]!), 'Waited for “Upload a video” to appear');
    // The action carries what was on screen, which is what "pick the label" offers.
    assert.deepEqual(three[1]!.seen, ['Upload a video', 'Choose from gallery']);
});

test('a typed line becomes a named blank, and the run form asks for it with last time’s answer', async (context) => {
    const directory = path.join(workspace, 'blanks');
    const app = await appWithRunbooks(directory);
    context.after(() => app.close());
    const stored = await writeRunbook(runbook([
        { type: 'type', text: 'gym pov day 14' },
        { type: 'type', text: 'always this' },
    ], { id: 'rb-blank0001a' }), directory);

    // The question is asked inline, in words, on the runbook's own page.
    const page = await inject(app, { method: 'GET', url: `/runbooks/${stored.id}` });
    assert.match(page.body, /Is this always the same, or does it change each run\?/);

    const changed = await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${stored.id}/steps/0/blank`,
        payload: 'answer=changes&name=caption', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.match(changed.body, /Typed the caption/);
    const same = await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${stored.id}/steps/1/blank`,
        payload: 'answer=same', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.doesNotMatch(same.body, /Is this always the same/, 'both lines have been answered');

    const saved = (await readRunbook(stored.id, directory))!;
    assert.equal((saved.steps[0] as { text: string }).text, '{{caption}}');
    assert.deepEqual(variableNames(saved), ['caption']);
    // The value it had when it became a blank is what the form offers next time.
    assert.equal(saved.lastValues?.caption, 'gym pov day 14');
    assert.match(blankFields(saved), /name="vars\.caption"/);
    assert.match(blankFields(saved), /value="gym pov day 14"/);
    assert.doesNotMatch(blankFields(saved), /\{\{/, 'nobody types braces');

    const badName = await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${stored.id}/steps/0/blank`,
        payload: 'answer=changes&name=not a name', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.match(badName.body, /A blank is named with letters/);
});

test('an amber step is repaired by picking a label the screen actually showed', async (context) => {
    const directory = path.join(workspace, 'pick');
    const app = await appWithRunbooks(directory);
    context.after(() => app.close());
    const stored = await writeRunbook(runbook([
        { type: 'tap', target: { fraction: { x: 0.5, y: 0.8 } }, seen: ['Follow', 'Submit'] },
    ], { id: 'rb-pick0001ab' }), directory);

    const offered = await inject(app, { method: 'GET', url: `/plugins/com.farm.runbook/runbooks/${stored.id}/story` });
    assert.match(offered.body, /Pick the label/);
    assert.match(offered.body, /value="Follow"/);

    const picked = await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${stored.id}/steps/0/target`,
        payload: 'text=Follow', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.match(picked.body, /Tapped Follow/);
    assert.deepEqual((await readRunbook(stored.id, directory))!.steps[0], {
        type: 'tap', seen: ['Follow', 'Submit'], target: { text: 'Follow', fraction: { x: 0.5, y: 0.8 } },
    });

    // Only what was on that screen can be picked; anything else is refused.
    const invented = await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${stored.id}/steps/0/target`,
        payload: 'text=Delete%20everything', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.match(invented.body, /That text was not on the screen/);
    const gone = await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${stored.id}/steps/9/target`,
        payload: 'text=Follow', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.match(gone.body, /That step is gone/);
});

test('one press records: the runbook is created, named later, and the phone is never asked twice', async (context) => {
    const directory = path.join(workspace, 'quick');
    const app = await appWithRunbooks(directory);
    context.after(() => app.close());

    const started = await inject(app, {
        method: 'POST', url: '/api/runbooks/record/here', payload: { udid: SERIAL },
    });
    assert.equal(started.statusCode, 201);
    const { runbookId } = started.json() as { runbookId: string };
    const fresh = (await readRunbook(runbookId, directory))!;
    assert.match(fresh.name, /^Untitled recording on Pixel 7$/);
    assert.equal(fresh.platform, 'android', 'the platform is a fact about the phone, not a question');

    const twice = await inject(app, { method: 'POST', url: '/api/runbooks/record/here', payload: { udid: SERIAL } });
    assert.equal(twice.statusCode, 409);

    await inject(app, {
        method: 'POST', url: `/api/runbooks/${runbookId}/steps`, payload: { action: { type: 'tap', x: 200, y: 100 } },
    });
    const done = await inject(app, { method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${runbookId}/done`, payload: {} });
    // Done asks for a name and one optional line, and nothing else at all.
    assert.match(done.body, /What is it called\?/);
    assert.match(done.body, /What is it for\? \(optional\)/);
    // Two questions, no third: the naming panel has no other control in it.
    const naming = /class="bl-panel bl-rb-name">([\s\S]*?)<\/section>/.exec(done.body)?.[1] ?? '';
    assert.doesNotMatch(naming, /<select|platform|app id/i, 'platform is a fact, not a field');
    assert.equal(naming.match(/<input/g)?.length, 2);

    const named = await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${runbookId}/name`,
        payload: 'name=Follow%20back&description=Follows%20whoever%20followed',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.match(named.body, /Follow back/);
    const saved = (await readRunbook(runbookId, directory))!;
    assert.equal(saved.name, 'Follow back');
    assert.equal(saved.description, 'Follows whoever followed');
});

test('"run it on this phone now" replays here, lights up each sentence, and points at the failure', async (context) => {
    const directory = path.join(workspace, 'try');
    const app = await appWithRunbooks(directory);
    context.after(() => app.close());
    const stored = await writeRunbook(runbook([
        { type: 'key', key: 'home' },
        { type: 'tap', target: { text: 'Follow', fraction: { x: 0.1, y: 0.1 } } },
    ], { id: 'rb-try00001ab' }), directory);

    const started = await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${stored.id}/try`,
        payload: `udid=${SERIAL}`, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(started.statusCode, 200);
    // The phone's live screen sits beside the sentences — the wall inspector's own viewer.
    assert.match(started.body, /data-viewer/);
    assert.match(started.body, /Went to the home screen/);
    assert.match(started.body, /Trying it on Pixel 7/);

    const finished = await until(async () => {
        const progress = await inject(app, { method: 'GET', url: `/plugins/com.farm.runbook/runbooks/${stored.id}/progress` });
        return /It worked/.test(progress.body) ? progress.body : undefined;
    });
    assert.match(finished, /It worked/);
    assert.equal((await readRunbook(stored.id, directory))!.lastRunStatus, 'succeeded');

    // A step that cannot be found stops the run at that sentence, with the screen it saw.
    const broken = await writeRunbook(runbook([
        { type: 'assert', text: 'Nowhere at all', expect: 'present' },
    ], { id: 'rb-try00002ab' }), directory);
    await inject(app, {
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${broken.id}/try`,
        payload: `udid=${SERIAL}`, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const failure = await until(async () => {
        const runbook = await readRunbook(broken.id, directory);
        return runbook?.lastFailure ? runbook : undefined;
    });
    assert.equal(failure.lastFailure!.stepIndex, 0);
    assert.deepEqual(failure.lastFailure!.visibleTexts, ['Follow', 'Submit']);
    assert.equal(failure.lastFailure!.screenshot, `${broken.id}-failure.png`);

    // The runbook page opens at that sentence, with the picture beside it.
    const page = await inject(app, { method: 'GET', url: `/runbooks/${broken.id}` });
    assert.match(page.body, /It stopped at “Checked that “Nowhere at all” is on screen”/);
    assert.match(page.body, /Try again/);
    assert.match(page.body, new RegExp(`/runbooks/${broken.id}/failure.png`));
    const picture = await inject(app, { method: 'GET', url: `/plugins/com.farm.runbook/runbooks/${broken.id}/failure.png` });
    assert.equal(picture.statusCode, 200);
    assert.equal(String(picture.headers['content-type']), 'image/png');

    // And the list says so in a word, rather than a timestamp.
    const list = await inject(app, { method: 'GET', url: '/runbooks' });
    assert.match(list.body, /Needs fixing/);
});

test('a runbook exports as a file and imports back, validated', async (context) => {
    const directory = path.join(workspace, 'transfer');
    const app = await appWithRunbooks(directory);
    context.after(() => app.close());
    const stored = await writeRunbook(runbook([{ type: 'key', key: 'home' }], { id: 'rb-export001a', name: 'Portable' }), directory);

    const exported = await inject(app, { method: 'GET', url: `/plugins/com.farm.runbook/runbooks/${stored.id}/export` });
    assert.equal(exported.statusCode, 200);
    assert.match(String(exported.headers['content-disposition']), /attachment; filename="rb-export001a\.json"/);
    const file = exported.body;
    assert.equal((JSON.parse(file) as Runbook).name, 'Portable');

    const imported = await inject(app, {
        method: 'POST', url: '/plugins/com.farm.runbook/runbooks/import',
        ...multipart('runbook', 'portable.json', file),
    });
    assert.equal(imported.statusCode, 200);
    assert.match(imported.body, /Imported “Portable”/);
    const all = await listRunbooks(directory);
    assert.equal(all.length, 2, 'the import is a copy under its own id, never an overwrite');
    assert.notEqual(all[0]!.id, all[1]!.id);

    // A file that is not a runbook is refused by name, not by stack trace.
    const junk = await inject(app, {
        method: 'POST', url: '/plugins/com.farm.runbook/runbooks/import',
        ...multipart('runbook', 'junk.json', JSON.stringify({ ...stored, steps: [{ type: 'teleport' }] })),
    });
    assert.match(junk.body, /That file is not a runbook: .*teleport/);
    const notJson = await inject(app, {
        method: 'POST', url: '/plugins/com.farm.runbook/runbooks/import',
        ...multipart('runbook', 'junk.json', 'not json at all'),
    });
    assert.match(notJson.body, /That file is not a runbook/);
    assert.equal((await listRunbooks(directory)).length, 2);
});

test('a failed runbook execution offers the operator somewhere to fix it', async () => {
    const directory = path.join(workspace, 'fix-url');
    const stored = await writeRunbook(runbook([{ type: 'key', key: 'home' }], { id: 'rb-fixurl001a' }), directory);
    const plugin = createRunbookPlugin({ directory });
    assert.equal(plugin.tasks[0]!.fixUrl?.({ runbookId: stored.id }), `/runbooks/${stored.id}#runbook-story`);
    assert.equal(safeFixUrl('/runbooks/rb-1#runbook-story'), '/runbooks/rb-1#runbook-story');
    assert.equal(safeFixUrl('https://elsewhere.example/steal'), undefined);
    assert.equal(safeFixUrl('javascript:alert(1)'), undefined);

    // A replay that gives up leaves the failure on the runbook, picture and all.
    const logs: string[] = [];
    const broken = await writeRunbook(runbook([{ type: 'assert', text: 'Nowhere', expect: 'present' }], { id: 'rb-fixurl002a' }), directory);
    await plugin.tasks[0]!.execute(executionContext(fakeDriver(calls()), logs), { runbookId: broken.id });
    const failed = (await readRunbook(broken.id, directory))!;
    assert.equal(failed.lastFailure?.stepIndex, 0);
    assert.equal(failed.lastFailure?.executionId, 'exec-1');
    assert.deepEqual(failed.lastFailure?.visibleTexts, ['Follow', 'Submit']);
});

/* ---- the starter library ----------------------------------------------- */

/** The ten shipped flows. Each one exists twice: `<slug>` for Android, `<slug>-ios` for iPhone. */
const STARTER_SLUGS = [
    'warm-up-scroll', 'post-from-recents', 'save-to-drafts', 'follow-back-sweep', 'search-a-niche',
    'clear-notifications', 'switch-account', 'like-a-hashtag-feed', 'login-check', 'repost-from-feed',
] as const;

test('every starter runbook validates and reads back as sentences', async () => {
    const starters = await loadStarterRunbooks();
    assert.equal(starters.length, STARTER_SLUGS.length * 2, `expected ten per platform, got ${starters.length}`);

    // One template name per file: exactly the ten flows, on Android and on the iPhone.
    const names = starters.map((starter) => starter.template!);
    assert.equal(new Set(names).size, names.length, 'template names are unique');
    const templatesFor = (platform: string): string[] =>
        starters.filter((starter) => starter.platform === platform).map((starter) => starter.template!).sort();
    assert.deepEqual(templatesFor('android'), [...STARTER_SLUGS].sort());
    assert.deepEqual(templatesFor('ios'), STARTER_SLUGS.map((slug) => `${slug}-ios`).sort());

    // Every Android flow has its iPhone twin, and the twin asks the operator the same questions —
    // a blank that exists on one platform only is a runbook somebody forgot to finish.
    const byTemplate = new Map(starters.map((starter) => [starter.template!, starter]));
    for (const slug of STARTER_SLUGS) {
        const android = byTemplate.get(slug);
        const iphone = byTemplate.get(`${slug}-ios`);
        assert.ok(android, `${slug} is missing from the starter library`);
        assert.ok(iphone, `${slug} has no iPhone twin`);
        assert.deepEqual(
            variableNames(iphone), variableNames(android),
            `${slug} and its iPhone twin do not ask for the same blanks`,
        );
    }

    for (const starter of starters) {
        assert.ok(starter.steps.length > 0, `${starter.template} has no steps`);
        for (const [index, step] of starter.steps.entries()) {
            const sentence = describeStep(step);
            assert.ok(sentence.trim().length > 0, `${starter.template} step ${index + 1} narrates to nothing`);
            assert.doesNotMatch(sentence, /\(nothing\)|undefined|\{\{/, `${starter.template} step ${index + 1}: ${sentence}`);
            // A tap that only knows where it landed must offer something to pick from.
            if (step.type === 'tap' && stepConfidence(step) === 'position') {
                assert.ok(step.seen?.length, `${starter.template} step ${index + 1} has no labels to pick from`);
            }
        }
        // The blanks are named, and each has an answer already in the box for the first run.
        for (const name of variableNames(starter)) {
            assert.ok(starter.lastValues?.[name], `${starter.template} does not suggest a ${name}`);
        }
    }
});

test('the starter library marks every label nobody has held a phone up to', async () => {
    const guessed = new Set<string>();
    for (const starter of await loadStarterRunbooks()) {
        for (const step of starter.steps) if (step.guess) guessed.add(`${starter.template}: ${describeStep(step)}`);
    }
    assert.ok(guessed.size > 0);
    for (const sentence of guessed) assert.match(sentence, /\(unverified\)$/);
});

test('seeding installs the starters once and never touches an edited copy', async () => {
    const directory = path.join(workspace, 'starters');
    const first = await installStarterRunbooks(directory);
    assert.equal(first.kept.length, 0);
    assert.equal(first.installed.length, (await loadStarterRunbooks()).length);
    const installed = await listRunbooks(directory);
    // A seeded copy is an ordinary runbook under its own fresh id.
    assert.ok(installed.every((entry) => /^rb-[a-z0-9]+$/.test(entry.id)));
    assert.ok(installed.every((entry) => entry.template));

    const warmUp = installed.find((entry) => entry.template === 'warm-up-scroll')!;
    await writeRunbook({ ...warmUp, name: 'My warm-up', steps: warmUp.steps.slice(0, 2) }, directory);

    const second = await installStarterRunbooks(directory);
    assert.deepEqual(second.installed, []);
    assert.equal(second.kept.length, first.installed.length);
    assert.equal((await listRunbooks(directory)).length, installed.length, 'seeding twice installs nothing twice');
    const edited = (await readRunbook(warmUp.id, directory))!;
    assert.equal(edited.name, 'My warm-up');
    assert.equal(edited.steps.length, 2, 'an edited copy is left exactly as the operator left it');
    assert.match(describeInstall(second), /already here/);
});

test('a repeated step runs its count, and a blank says how many times', async () => {
    let recorded = calls();
    const swipe: Step = {
        type: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, durationMs: 300,
        repeat: '{{scrolls}}', repeatDelayMs: 0,
    };
    assert.equal(describeStep(swipe), 'Swiped up, as many times as the scrolls says');
    await replayRunbook(fakeDriver(recorded), runbook([swipe]), { vars: { scrolls: '4' } });
    assert.equal(recorded.swipes.length, 4);

    const fixed = await replayRunbook(fakeDriver(recorded = calls()), runbook([{ ...swipe, repeat: 3 }]), {});
    assert.equal(fixed.stepsRun, 1);
    assert.equal(recorded.swipes.length, 3);
    assert.equal(describeStep({ ...swipe, repeat: 3 }), 'Swiped up, 3 times');

    // A blank that is not a number of times is the operator's mistake, and is named as one.
    await assert.rejects(
        replayRunbook(fakeDriver(calls()), runbook([swipe]), { vars: { scrolls: 'lots' } }),
        /"lots" is not a number of times between 1 and 50/,
    );
    assert.throws(() => validateStep({ type: 'wait', ms: 1, repeat: '{{a}} {{b}}' }, 0), /repeat must be a whole number/);
});

test('the Runbooks page badges the starters, groups them first, and restores them on demand', async (context) => {
    const directory = path.join(workspace, 'starter-routes');
    const app = await appWithRunbooks(directory);
    context.after(() => app.close());

    const restored = await inject(app, { method: 'POST', url: '/api/runbooks/templates/install' });
    assert.equal(restored.statusCode, 200);
    const count = (restored.json() as { installed: string[] }).installed.length;
    assert.equal(count, (await loadStarterRunbooks()).length, 'all twenty starters are seeded');
    const again = (await inject(app, { method: 'POST', url: '/api/runbooks/templates/install' }))
        .json() as { installed: string[]; kept: string[]; message: string };
    assert.deepEqual(again.installed, [], 'restoring twice installs nothing twice');
    assert.equal(again.kept.length, count);
    assert.match(again.message, /already here/);

    const mine = await writeRunbook(runbook([{ type: 'key', key: 'home' }], { id: 'rb-mine0001abc', name: 'Aardvark' }), directory);
    const list = runbookListFragment(await listRunbooks(directory), []);
    assert.match(list, />Starter</);
    // "Aardvark" sorts first by name and last by kind: the shipped ones lead.
    assert.ok(list.indexOf('Warm-up scroll') < list.indexOf(mine.name), 'the starters are grouped first');
    assert.equal(orderRunbooks(await listRunbooks(directory)).at(-1)!.id, mine.id);

    const page = await inject(app, { method: 'GET', url: '/runbooks' });
    assert.match(page.body, /Restore starter runbooks/);
});
