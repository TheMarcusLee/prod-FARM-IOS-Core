import assert from 'node:assert/strict';
import test from 'node:test';

import { Supervisor, backoffMs } from '../src/main/supervisor.ts';
import { FakeClock, fakeService, settle } from './helpers.ts';

function build(services: ReturnType<typeof fakeService>[], clock = new FakeClock()) {
    const supervisor = new Supervisor(services.map((service) => service.definition), {
        clock,
        maxRestarts: 3,
        // The periodic sweep has its own test file; FakeClock would spin on it.
        reprobeIntervalMs: 0,
    });
    return { supervisor, clock };
}

test('startAll brings services up in dependency order', async () => {
    const order: string[] = [];
    const db = fakeService({ id: 'db', healthy: () => true });
    const migrations = fakeService({ id: 'migrations', dependsOn: ['db'], oneshot: true });
    const web = fakeService({ id: 'web', dependsOn: ['migrations'], healthy: () => true });
    for (const service of [db, migrations, web]) {
        const launch = service.definition.launch;
        service.definition.launch = async (context) => {
            order.push(service.definition.id);
            const handle = await launch(context);
            // A one-shot must exit before the supervisor calls it healthy.
            if (service.definition.oneshot) service.current()?.finish(0);
            return handle;
        };
    }
    const { supervisor } = build([web, migrations, db]);

    assert.deepEqual(supervisor.startOrder(), ['db', 'migrations', 'web']);
    await supervisor.startAll();

    assert.deepEqual(order, ['db', 'migrations', 'web']);
    assert.equal(supervisor.stateOf('db'), 'healthy');
    assert.equal(supervisor.stateOf('migrations'), 'healthy');
    assert.equal(supervisor.stateOf('web'), 'healthy');
});

test('a failing preflight parks the service as not-configured without launching it', async () => {
    const appium = fakeService({
        id: 'appium',
        optional: true,
        preflight: async () => ({ ok: false, reason: 'Appium is not installed' }),
    });
    const { supervisor } = build([appium]);

    await supervisor.startAll();

    assert.equal(supervisor.stateOf('appium'), 'not-configured');
    assert.equal(appium.launches, 0);
    assert.equal(supervisor.snapshotOf('appium').detail, 'Appium is not installed');
});

test('an optional not-configured dependency does not block a dependent', async () => {
    const wda = fakeService({ id: 'wda', optional: true, preflight: async () => ({ ok: false, reason: 'no Xcode' }) });
    const worker = fakeService({ id: 'worker', dependsOn: ['wda'], healthy: () => true });
    const { supervisor } = build([wda, worker]);

    await supervisor.startAll();

    assert.equal(supervisor.stateOf('wda'), 'not-configured');
    assert.equal(supervisor.stateOf('worker'), 'healthy');
    assert.deepEqual(supervisor.blockedBy('worker'), []);
});

test('a required dependency that is not healthy blocks its dependent', async () => {
    const db = fakeService({ id: 'db', failLaunch: 'boom', optional: true });
    const web = fakeService({ id: 'web', dependsOn: ['db'], healthy: () => true });
    const { supervisor } = build([db, web]);

    await supervisor.startAll();

    assert.equal(supervisor.stateOf('db'), 'failed');
    assert.equal(supervisor.stateOf('web'), 'failed');
    assert.equal(supervisor.snapshotOf('web').detail, 'waiting on db');
    assert.equal(web.launches, 0);
});

test('a crash is restarted with exponential backoff and then given up on', async () => {
    const clock = new FakeClock();
    const worker = fakeService({ id: 'worker' });
    const { supervisor } = build([worker], clock);

    await supervisor.start('worker');
    assert.equal(supervisor.stateOf('worker'), 'healthy');

    for (let attempt = 0; attempt < 4; attempt += 1) {
        worker.current()?.crash(1);
        await settle();
    }

    assert.deepEqual(clock.delays.slice(0, 3), [backoffMs(0), backoffMs(1), backoffMs(2)]);
    assert.equal(worker.launches, 4, 'three restarts after the first launch');
    assert.equal(supervisor.stateOf('worker'), 'failed');
    assert.match(supervisor.snapshotOf('worker').detail, /gave up after 3 restarts/);
});

test('an operator stop is not treated as a crash', async () => {
    const worker = fakeService({ id: 'worker' });
    const { supervisor } = build([worker]);

    await supervisor.start('worker');
    await supervisor.stop('worker');
    await settle();

    assert.equal(supervisor.stateOf('worker'), 'stopped');
    assert.equal(worker.launches, 1);
    assert.equal(worker.processes[0]?.stopped, true);
});

test('stopAll stops services in reverse dependency order', async () => {
    const stopped: string[] = [];
    const db = fakeService({ id: 'db', healthy: () => true });
    const web = fakeService({ id: 'web', dependsOn: ['db'], healthy: () => true });
    for (const service of [db, web]) {
        const launch = service.definition.launch;
        service.definition.launch = async (context) => {
            const handle = await launch(context);
            const stop = handle.stop.bind(handle);
            return { ...handle, exited: handle.exited, async stop() { stopped.push(service.definition.id); await stop(); } };
        };
    }
    const { supervisor } = build([db, web]);

    await supervisor.startAll();
    await supervisor.stopAll();

    assert.deepEqual(stopped, ['web', 'db']);
    assert.equal(supervisor.stateOf('web'), 'stopped');
    assert.equal(supervisor.stateOf('db'), 'stopped');
});

test('a one-shot that exits non-zero fails and blocks its dependents', async () => {
    const migrations = fakeService({ id: 'migrations', oneshot: true });
    const web = fakeService({ id: 'web', dependsOn: ['migrations'], healthy: () => true });
    const launch = migrations.definition.launch;
    migrations.definition.launch = async (context) => {
        const handle = await launch(context);
        migrations.current()?.finish(3);
        return handle;
    };
    const { supervisor } = build([migrations, web]);

    await assert.rejects(() => supervisor.startAll(), /migrations exited with code 3/);
    assert.equal(supervisor.stateOf('migrations'), 'failed');
    assert.equal(supervisor.snapshotOf('migrations').detail, 'exited with code 3');
});

test('logs are kept per service and surfaced in the snapshot', async () => {
    const seen: string[] = [];
    const worker = fakeService({ id: 'worker' });
    const supervisor = new Supervisor([worker.definition], {
        clock: new FakeClock(),
        reprobeIntervalMs: 0,
        onLog: (id, line) => seen.push(`${id}:${line.text}`),
        logPathFor: (id) => `/tmp/${id}.log`,
    });

    await supervisor.start('worker');

    assert.deepEqual(seen, ['worker:worker launched']);
    assert.equal(supervisor.snapshotOf('worker').logPath, '/tmp/worker.log');
    assert.deepEqual(supervisor.recentLogs('worker').map((line) => line.text), ['worker launched']);
});

test('a dependency cycle is rejected at construction', () => {
    const a = fakeService({ id: 'a', dependsOn: ['b'] });
    const b = fakeService({ id: 'b', dependsOn: ['a'] });
    assert.throws(() => new Supervisor([a.definition, b.definition]), /cycle/);
});

test('backoff is exponential and capped', () => {
    assert.deepEqual([0, 1, 2, 3].map(backoffMs), [1_000, 2_000, 4_000, 8_000]);
    assert.equal(backoffMs(20), 30_000);
});
