import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    ANY_DEVICE, loadSelectorOverrides, overrideFor, recordSelectorOverride, refreshSelectorOverrides,
    removeSelectorOverride, resolveSelectors, resolveTable, selectorNameOf,
} from '../src/drivers/selector-overrides.js';
import { calibrationHint, flowForTaskType } from '../src/agent/failure.js';
import { buildCalibrationPrompt, calibrate, CalibrateError, selectorSection } from '../src/agent/calibrate.js';
import { createFakeAgentRunner, describeFrame } from '../src/agent/runner.js';
import {
    findFlow, selectorNames, selectorStatuses, unverifiedNamesIn, unverifiedStatuses,
} from '../src/agent/catalog.js';
import { validateCalibratePayload } from '../src/agent-plugin.js';
import { createActionLimiter } from '../src/mcp/action-limit.js';
import { TIKTOK_PLUGIN_ID } from '../src/plugin-ids.js';

async function workspace(): Promise<{ dir: string; overrides: string; cleanup(): Promise<void> }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'backline-agent-'));
    const overrides = path.join(dir, 'selector-overrides.json');
    return { dir, overrides, cleanup: async () => { refreshSelectorOverrides(); await rm(dir, { recursive: true, force: true }); } };
}

/* ---- the override store ---------------------------------------------- */

test('an override survives a round trip and is upserted rather than stacked', async () => {
    const { overrides, cleanup } = await workspace();
    try {
        assert.deepEqual(await loadSelectorOverrides(overrides), [], 'a missing file is an empty table, not an error');
        await recordSelectorOverride({
            plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1', name: 'captionField',
            entry: { id: 'caption_edit_view' }, confirmedBy: 'agent', note: 'TikTok 39.4.4',
        }, overrides);
        await recordSelectorOverride({
            plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1', name: 'captionField',
            entry: { id: 'et_caption' }, confirmedBy: 'marcus',
        }, overrides);
        const rows = await loadSelectorOverrides(overrides);
        assert.equal(rows.length, 1, 'the same control twice is a correction, not a second row');
        assert.deepEqual(rows[0]?.entry, { id: 'et_caption' });
        assert.equal(rows[0]?.confirmedBy, 'marcus');
        assert.ok(Date.parse(rows[0]!.confirmedAt) > 0);

        assert.equal(await removeSelectorOverride({ plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1', name: 'captionField' }, overrides), true);
        assert.equal(await removeSelectorOverride({ plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1', name: 'captionField' }, overrides), false);
    } finally { await cleanup(); }
});

test('an override that could match anything is refused', async () => {
    const { overrides, cleanup } = await workspace();
    try {
        await assert.rejects(() => recordSelectorOverride({
            plugin: TIKTOK_PLUGIN_ID, udid: '*', name: 'post', entry: {}, confirmedBy: 'agent',
        }, overrides), /non-empty text or id/);
        await assert.rejects(() => recordSelectorOverride({
            plugin: TIKTOK_PLUGIN_ID, udid: '*', name: 'not a key', entry: { id: 'x' }, confirmedBy: 'agent',
        }, overrides), /must be a table key/);
    } finally { await cleanup(); }
});

test('a malformed row is skipped rather than taking the whole table down', async () => {
    const { overrides, cleanup } = await workspace();
    try {
        await writeFile(overrides, JSON.stringify([
            { plugin: 'p', udid: '*', name: 'a', entry: { id: 'good' }, confirmedBy: 'x', confirmedAt: 'now' },
            { plugin: 'p', udid: '*', name: 'b' },
            null,
        ]));
        const rows = await loadSelectorOverrides(overrides);
        assert.deepEqual(rows.map(({ name }) => name), ['a']);
    } finally { await cleanup(); }
});

test('a device-specific override beats the fleet-wide one', async () => {
    const rows = [
        { plugin: 'p', udid: '*', name: 'post', entry: { text: 'Post' }, confirmedBy: 'x', confirmedAt: 'now' },
        { plugin: 'p', udid: 'phone-1', name: 'post', entry: { id: 'btn_post' }, confirmedBy: 'x', confirmedAt: 'now' },
    ];
    assert.deepEqual(overrideFor(rows, 'p', 'phone-1', 'post')?.entry, { id: 'btn_post' });
    assert.deepEqual(overrideFor(rows, 'p', 'phone-2', 'post')?.entry, { text: 'Post' });
    assert.equal(overrideFor(rows, 'other', 'phone-1', 'post'), undefined);
});

/* ---- the resolve helper ---------------------------------------------- */

test('a confirmed selector goes in front of the built-in alternates, which stay behind it', async () => {
    const { overrides, cleanup } = await workspace();
    try {
        const builtIn = [{ id: 'btn_post' }, { text: 'Post', exact: true }] as const;
        const untouched = await resolveSelectors('p', 'phone-1', 'post', builtIn, overrides);
        assert.deepEqual([...untouched], [...builtIn], 'with nothing recorded the table is what it always was');
        assert.equal(selectorNameOf(untouched), 'post');

        refreshSelectorOverrides(overrides);
        await recordSelectorOverride({
            plugin: 'p', udid: ANY_DEVICE, name: 'post', entry: { text: 'Post', exact: true }, confirmedBy: 'agent',
        }, overrides);
        refreshSelectorOverrides(overrides);
        const resolved = await resolveSelectors('p', 'phone-1', 'post', builtIn, overrides);
        assert.deepEqual([...resolved], [{ text: 'Post', exact: true }, { id: 'btn_post' }]);
        assert.equal(resolved.length, 2, 'the confirmed entry is not duplicated by the alternate it came from');
    } finally { await cleanup(); }
});

test('resolveTable leaves the bare id-fragment lists alone and names every list it touches', async () => {
    const { overrides, cleanup } = await workspace();
    try {
        const table = {
            post: [{ id: 'btn_post' }],
            galleryCellIds: ['iv_image', 'iv_cover'],
        } as const;
        const resolved = await resolveTable('p', 'phone-1', table, overrides);
        assert.deepEqual([...resolved.galleryCellIds], ['iv_image', 'iv_cover']);
        assert.equal(selectorNameOf(resolved.post), 'post');
    } finally { await cleanup(); }
});

/* ---- the catalog ------------------------------------------------------ */

test('the GUESS marker is read off the routine, from the comment above a key or the key line', () => {
    const source = [
        'export const POST_SELECTORS = {',
        '    /** Bottom navigation, confirmed on a real phone. */',
        "    profileTab: [{ id: 'profile_tab' }] as SelectorList,",
        '    /**',
        '     * The account chevron. GUESS.',
        '     */',
        "    accountSwitcher: [{ id: 'account_switch' }] as SelectorList,",
        "    drafts: [{ text: 'Drafts' }] as SelectorList, // GUESS",
        '} as const;',
    ].join('\n');
    assert.deepEqual(unverifiedNamesIn(source, 'POST_SELECTORS'), ['accountSwitcher', 'drafts']);
    assert.deepEqual(unverifiedNamesIn(source, 'NO_SUCH_TABLE'), []);
});

test('every TikTok post selector is listed, and the unverified ones are a subset with no override', async () => {
    const { overrides, cleanup } = await workspace();
    try {
        const flow = findFlow(TIKTOK_PLUGIN_ID, 'post');
        assert.ok(flow);
        const names = selectorNames(flow.table);
        assert.ok(names.includes('captionField'));
        assert.ok(!names.includes('galleryCellIds'), 'a list of bare id fragments is not a selector list');

        const rows = await selectorStatuses(TIKTOK_PLUGIN_ID, 'phone-1', overrides);
        const post = rows.filter((row) => row.flow === 'post');
        assert.deepEqual(post.map(({ name }) => name), names);
        assert.ok(post.some((row) => row.guess), 'the shipped table still has guesses in it');

        const before = await unverifiedStatuses(TIKTOK_PLUGIN_ID, 'phone-1', overrides);
        const target = before[0]!;
        await recordSelectorOverride({
            plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1', name: target.name, entry: { id: 'confirmed' }, confirmedBy: 'agent',
        }, overrides);
        const after = await unverifiedStatuses(TIKTOK_PLUGIN_ID, 'phone-1', overrides);
        assert.equal(after.length, before.length - 1);
        assert.ok(!after.some(({ name }) => name === target.name));
    } finally { await cleanup(); }
});

/* ---- the failure hint ------------------------------------------------- */

test('a missing control becomes a calibration hint; anything else does not', () => {
    assert.equal(flowForTaskType('post'), 'post');
    assert.equal(flowForTaskType('doomscroll'), 'warmup');
    assert.equal(flowForTaskType('open-app'), undefined);

    const hint = calibrationHint({
        pluginId: TIKTOK_PLUGIN_ID, taskType: 'post', deviceUdid: 'phone-1',
        error: 'TikTok control not found: caption field (tried #et_caption). Screen showed: For You, Following '
            + '[selector captionField] [screenshot /data/failure-shots/e1/123-tiktok.png]',
    });
    assert.deepEqual(hint, {
        plugin: TIKTOK_PLUGIN_ID, flow: 'post', udid: 'phone-1',
        selector: 'captionField', screenshot: '/data/failure-shots/e1/123-tiktok.png',
    });

    // A timeout on a control is the same class of failure, even without a screenshot.
    assert.equal(calibrationHint({
        pluginId: TIKTOK_PLUGIN_ID, taskType: 'doomscroll', deviceUdid: 'phone-1',
        error: 'Timed out waiting for the For You feed (tried #home). [selector homeTab]',
    })?.selector, 'homeTab');

    assert.equal(calibrationHint({ pluginId: TIKTOK_PLUGIN_ID, taskType: 'post', deviceUdid: 'p', error: 'device is offline' }), undefined);
    assert.equal(calibrationHint({ pluginId: 'org.other', taskType: 'post', deviceUdid: 'p', error: 'control not found: x' }), undefined);
    assert.equal(calibrationHint({ pluginId: TIKTOK_PLUGIN_ID, taskType: 'post', deviceUdid: 'p', error: null }), undefined);
});

/* ---- the runner ------------------------------------------------------- */

test('stream-json frames become log lines, a status and a final response', () => {
    assert.match(describeFrame({ event: 'init', init: { model: 'gemini-3.8-flash-medium' } }).line ?? '', /gemini-3\.8/);
    assert.match(describeFrame({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'read_screen' } }).line ?? '', /finished read_screen/);
    assert.match(describeFrame({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'found it' } }).line ?? '', /agent: found it/);
    assert.equal(describeFrame({ event: 'step_update', step_update: { step_type: 'error', error: 'boom' } }).error, 'boom');
    const result = describeFrame({ event: 'result', result: { status: 'SUCCESS', response: 'confirmed 3' } });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.response, 'confirmed 3');
    assert.deepEqual(describeFrame('not a frame'), {});
});

/* ---- the calibrate job ------------------------------------------------ */

test('the prompt names the flow, the phone, the unverified selectors and the safety rules', () => {
    const flow = findFlow(TIKTOK_PLUGIN_ID, 'post')!;
    const prompt = buildCalibrationPrompt({
        flow, udid: 'phone-1', docs: '## The selector table\nCorrect it here.',
        unverified: [{ name: 'accountSwitcher', builtIn: [{ id: 'account_switch' }, { text: 'Switch account' }] }],
    });
    assert.match(prompt, /phone-1/);
    assert.match(prompt, /com\.zhiliaoapp\.musically/);
    assert.match(prompt, /accountSwitcher — currently tried in this order: #account_switch, "Switch account"/);
    assert.match(prompt, /record_selector/);
    assert.match(prompt, /Never publish/);
    assert.match(prompt, /Correct it here\./);
});

test('only the selector part of a doc page reaches the prompt', () => {
    const markdown = '# Title\n\nintro\n\n## The selector table\n\nrows\n\n## Something else\n\nnot this\n';
    assert.equal(selectorSection(markdown), '## The selector table\n\nrows');
    assert.equal(selectorSection('# Title\n\nnothing here'), undefined);
});

test('a calibration pass reports what the store gained, not what the agent claimed', async () => {
    const { dir, overrides, cleanup } = await workspace();
    try {
        const logs: string[] = [];
        const targets = await unverifiedStatuses(TIKTOK_PLUGIN_ID, 'phone-1', overrides);
        const first = targets[0]!.name;
        const runner = createFakeAgentRunner({
            lines: ['agent started', 'agent: I confirmed everything'],
            result: { ok: true, status: 'SUCCESS', exitCode: 0, lastMessage: 'confirmed all of them' },
            // The agent's real effect is the tool call it makes, which is a write to the store.
            onRun: async () => {
                await recordSelectorOverride({
                    plugin: TIKTOK_PLUGIN_ID, udid: 'phone-1', name: first,
                    entry: { id: 'seen_on_screen' }, confirmedBy: 'agent',
                }, overrides);
            },
        });
        const result = await calibrate(
            { plugin: TIKTOK_PLUGIN_ID, flow: 'post', udid: 'phone-1', maxMinutes: 5 },
            { runner, log: (line) => { logs.push(line); }, workspaceDirectory: dir, overridesPath: overrides },
        );
        assert.deepEqual(result.recorded.map(({ name }) => name), [first]);
        assert.ok(result.targeted.includes(first));
        assert.ok(result.stillUnverified.length > 0, 'the rest of the list is still unverified whatever the agent said');
        assert.ok(!result.stillUnverified.includes(first));

        const [request] = runner.requests;
        assert.equal(request?.model, 'gemini-3.8-flash-medium');
        assert.equal(request?.timeoutMs, 5 * 60_000);
        assert.equal(request?.mcpServers[0]?.name, 'backline');
        assert.match(await readFile(path.join(dir, 'prompt.md'), 'utf8'), /calibrating Backline's TikTok post routine/i);
        const config = JSON.parse(await readFile(path.join(dir, 'mcp-servers.json'), 'utf8'));
        assert.ok(String(config.mcpServers.backline.args.join(' ')).includes('stdio'));
        assert.ok(logs.some((line) => line.includes('agent started')));
        assert.ok(logs.some((line) => /Recorded 1 selector/.test(line)));
    } finally { await cleanup(); }
});

test('the job fails fast, without touching a phone, when the CLI is not installed', async () => {
    const { dir, overrides, cleanup } = await workspace();
    try {
        const runner = createFakeAgentRunner({
            unavailable: 'The Antigravity CLI (agy) is not installed. Install it with: curl -fsSL https://antigravity.google/cli/install.sh | bash',
        });
        await assert.rejects(
            () => calibrate({ plugin: TIKTOK_PLUGIN_ID, flow: 'post', udid: 'phone-1' },
                { runner, log: () => {}, workspaceDirectory: dir, overridesPath: overrides }),
            (error: unknown) => error instanceof CalibrateError && /antigravity\.google\/cli\/install\.sh/.test(error.message),
        );
        assert.equal(runner.requests.length, 0);
    } finally { await cleanup(); }
});

test('a plugin with no Android routine cannot be calibrated', async () => {
    const { dir, cleanup } = await workspace();
    try {
        await assert.rejects(
            () => calibrate({ plugin: 'com.farm.runbook', flow: 'post', udid: 'phone-1' },
                { runner: createFakeAgentRunner(), log: () => {}, workspaceDirectory: dir }),
            /No Android post routine/,
        );
    } finally { await cleanup(); }
});

test('the calibrate payload is validated the way every other task payload is', () => {
    assert.deepEqual(
        validateCalibratePayload({ plugin: TIKTOK_PLUGIN_ID, flow: 'post', udid: 'phone-1' }),
        { plugin: TIKTOK_PLUGIN_ID, flow: 'post', udid: 'phone-1', maxMinutes: 20 },
    );
    assert.throws(() => validateCalibratePayload({ plugin: TIKTOK_PLUGIN_ID, flow: 'scroll', udid: 'p' }), /post.*warmup/);
    assert.throws(() => validateCalibratePayload({ plugin: 'com.farm.runbook', flow: 'post', udid: 'p' }), /no Android post routine/);
    assert.throws(() => validateCalibratePayload({ plugin: TIKTOK_PLUGIN_ID, flow: 'post', udid: 'p', maxMinutes: 500 }), /between 2 and 120/);
    assert.throws(() => validateCalibratePayload({ plugin: TIKTOK_PLUGIN_ID, flow: 'post', udid: 'p', model: 'not a slug!' }), /model slug/);
});

/* ---- the device action ceiling ---------------------------------------- */

test('device actions are counted per phone, per window', () => {
    let clock = 0;
    const limiter = createActionLimiter(() => clock, { RATE_LIMIT_ACTION: '2', RATE_LIMIT_ACTION_WINDOW_MS: '1000' });
    limiter.check('phone-1');
    limiter.check('phone-1');
    assert.throws(() => limiter.check('phone-1'), /Too many device actions on phone-1/);
    // A second phone has its own allowance; wedging one driver must not throttle the fleet.
    limiter.check('phone-2');
    clock = 1_001;
    limiter.check('phone-1');
});
