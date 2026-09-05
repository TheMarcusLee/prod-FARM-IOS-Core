import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JobRunner, type JobDefinition } from '../src/main/jobs.ts';
import type { AppPaths } from '../src/main/paths.ts';
import { normalizeSettings } from '../src/main/settings.ts';
import type { ServiceContext } from '../src/main/services/context.ts';
import {
    WDA_PREPARE_JOB_ID, WDA_TRUST_NOTE, wdaPrepareArgs, wdaPrepareChecks, wdaPrepareJob, wdaPrepareSpawn,
} from '../src/main/services/wda-prepare.ts';

/** A job whose child is a real, tiny `node -e`, so nothing has to be mocked. */
function nodeJob(id: string, script: string, checks: JobDefinition['checks'] = async () => []): JobDefinition {
    return {
        id,
        label: id,
        note: 'note',
        command: `node -e ${script}`,
        checks,
        spawn: () => ({ file: process.execPath, args: ['-e', script], cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? '' } }),
    };
}

function context(overrides: Partial<ServiceContext['settings']> = {}, devicesConfigPath = '/nonexistent/devices.json'): ServiceContext {
    const paths = {
        repoRoot: '/farm', compiled: false, userData: '/data', logsDir: '/data/logs',
        postgresDataDir: '/data/postgres', schedulerDataDir: '/data/scheduler',
        devicesConfigPath, wdaServiceSocket: '/data/wda.sock',
    } satisfies AppPaths;
    return {
        paths,
        settings: normalizeSettings({ xcodeOrgId: 'ABCDE12345', ...overrides }),
        databaseUrl: 'postgresql://x@127.0.0.1:5432/x',
        env: { PATH: process.env.PATH ?? '' },
        nodeExecPath: process.execPath,
        appVersion: '0.1.0',
    };
}

test('a job streams output, succeeds and stays until it is dismissed', async () => {
    const runner = new JobRunner();
    const changes: number[] = [];
    runner.on('change', () => changes.push(1));

    const snapshot = await runner.run(nodeJob('demo', 'console.log("hello from the build")'));

    assert.equal(snapshot?.state, 'succeeded');
    assert.equal(snapshot?.exitCode, 0);
    assert.ok(snapshot?.lines.some((line) => line.text.includes('hello from the build')));
    assert.ok(changes.length > 2, 'the renderer is told about every step');

    assert.equal(runner.list().length, 1, 'the result persists');
    runner.dismiss('demo');
    assert.equal(runner.list().length, 0);
});

test('a failing job reports its exit code and can be run again', async () => {
    const runner = new JobRunner();
    const failing = nodeJob('demo', 'console.error("boom"); process.exit(3)');

    const first = await runner.run(failing);
    assert.equal(first?.state, 'failed');
    assert.equal(first?.exitCode, 3);
    assert.match(first?.detail ?? '', /Exited with code 3/);
    assert.ok(first?.lines.some((line) => line.stream === 'err' && line.text.includes('boom')));

    const second = await runner.run(nodeJob('demo', 'process.exit(0)'));
    assert.equal(second?.state, 'succeeded', 'the job is re-runnable');
});

test('a blocked precondition stops the job before anything is spawned', async () => {
    const runner = new JobRunner();
    const job = nodeJob('demo', 'process.exit(0)', async () => [
        { label: 'Xcode', ok: true, detail: '/Applications/Xcode.app/Contents/Developer' },
        { label: 'XCODE_ORG_ID', ok: false, detail: 'Empty.' },
    ]);

    const snapshot = await runner.run(job);

    assert.equal(snapshot?.state, 'blocked');
    assert.equal(snapshot?.detail, 'Empty.');
    assert.equal(snapshot?.lines.length, 0, 'nothing ran');
    assert.equal(snapshot?.checks.length, 2, 'passing checks are reported too');
});

test('a job is never started twice at once', async () => {
    const runner = new JobRunner();
    const slow = nodeJob('demo', 'setTimeout(() => {}, 300)');
    const first = runner.run(slow);
    const second = await runner.run(slow);
    assert.equal(second?.running, true);
    await runner.cancel('demo');
    await first;
    assert.equal(runner.snapshotOf('demo')?.state, 'cancelled');
});

test('wdaPrepareArgs mirrors the npm script flags', () => {
    assert.deepEqual(wdaPrepareArgs({ kind: 'all' }), ['--all']);
    assert.deepEqual(wdaPrepareArgs({ kind: 'udid', udid: '0000803' }), ['--udid', '0000803']);
});

test('the WDA prepare job spawns the repository entry point with the app environment', () => {
    const spec = wdaPrepareSpawn(context(), { kind: 'all' });
    assert.deepEqual(spec.args, ['--import', 'tsx', 'src/devices/wda/prepare.ts', '--all']);
    assert.equal(spec.cwd, '/farm');
    assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');

    const compiled = context();
    compiled.paths.compiled = true;
    assert.deepEqual(
        wdaPrepareSpawn(compiled, { kind: 'udid', udid: 'abc' }).args,
        ['src/devices/wda/prepare.js', '--udid', 'abc'],
    );
});

test('the job explains the step it cannot automate', () => {
    const job = wdaPrepareJob(context(), { kind: 'all' });
    assert.equal(job.id, WDA_PREPARE_JOB_ID);
    assert.equal(job.command, 'npm run wda:prepare -- --all');
    assert.match(WDA_TRUST_NOTE, /VPN & Device Management/);
    assert.match(WDA_TRUST_NOTE, /Developer Mode/);
});

test('the preconditions flag missing signing fields and an empty device registry', async () => {
    const checks = await wdaPrepareChecks(context({ xcodeOrgId: '' }), { kind: 'all' });
    const byLabel = new Map(checks.map((check) => [check.label, check]));

    assert.equal(byLabel.get('XCODE_ORG_ID')?.ok, false);
    assert.match(byLabel.get('XCODE_ORG_ID')?.detail ?? '', /Settings → Devices/);
    assert.equal(byLabel.get('XCODE_SIGNING_ID')?.ok, true, 'the default signing id counts as set');
    assert.equal(byLabel.get('Registered devices')?.ok, false);
    assert.ok(byLabel.has('Xcode'), 'xcode-select is always reported');
});

test('a devices.json with devices satisfies the --all precondition', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'farm-devices-'));
    const file = path.join(directory, 'devices.json');
    writeFileSync(file, JSON.stringify([{ udid: 'a', name: 'one' }, { udid: 'b', name: 'two' }]));

    const checks = await wdaPrepareChecks(context({}, file), { kind: 'all' });
    const registered = checks.find((check) => check.label === 'Registered devices');

    assert.equal(registered?.ok, true);
    assert.match(registered?.detail ?? '', /2 device\(s\)/);
});
