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
import { applyVariables, validateRunbook, validateStep, type Runbook, type Step } from '../src/runbook/model.js';
import { stepFromAction, targetAtPoint, validateRemoteAction } from '../src/runbook/recorder.js';
import { RunbookStepError, replayRunbook, resolveTapPoint } from '../src/runbook/replay.js';
import { devicePanelFragment, runbookListFragment, scriptLiteral } from '../src/runbook/html.js';
import { stepsFromForm } from '../src/runbook/routes.js';
import { readRunbook, writeRunbook } from '../src/runbook/store.js';
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
    assert.deepEqual(recorded.swipes, [{ from: { x: 540, y: 1920 }, to: { x: 540, y: 480 }, durationMs: 300 }]);
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
        plugins: new PluginRegistry([createRunbookPlugin({ directory, createDriver: () => fakeDriver(calls()) })]),
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
    assert.deepEqual((step.json() as { step: Step }).step, { type: 'tap', target: { text: 'Follow', fraction: { x: 0.18519, y: 0.04167 } } });

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
    assert.match(editor.body, /Save steps/);
    assert.match(editor.body, /class="bl-steps"/);
    assert.match(editor.body, /Start recording/, 'the record toggle lives on the editor too');
    assert.match(editor.body, /\/assets\/pages\.css/);

    const script = await inject(app, { method: 'GET', url: '/assets/runbooks.js' });
    assert.equal(script.statusCode, 200);
    assert.match(String(script.headers['content-type']), /javascript/);

    const panel = await inject(app, { method: 'GET', url: `/plugins/com.farm.runbook/devices/${SERIAL}/panel` });
    assert.match(panel.body, /Start recording/);
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
        method: 'POST', url: `/plugins/com.farm.runbook/runbooks/${id}/record/stop-form`, payload: {},
    });
    assert.match(editorAfterStop.body, /Start recording/);
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
        { runbookId: hostile, udid: 'udid-1', screen: { width: 1, height: 1, scale: 1 }, startedAt: '', steps: 0 },
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
