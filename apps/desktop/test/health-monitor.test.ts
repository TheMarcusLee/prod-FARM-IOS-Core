import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_REPROBE_INTERVAL_MS, Supervisor, backoffMs } from '../src/main/supervisor.ts';
import { ManualClock, fakeService, settle } from './helpers.ts';

function build(services: ReturnType<typeof fakeService>[], reprobeIntervalMs = 15_000) {
    const clock = new ManualClock();
    const supervisor = new Supervisor(services.map((service) => service.definition), {
        clock, maxRestarts: 3, reprobeIntervalMs,
    });
    return { supervisor, clock };
}

test('the default re-probe interval is 15 seconds and is configurable', () => {
    assert.equal(DEFAULT_REPROBE_INTERVAL_MS, 15_000);
    const { supervisor } = build([fakeService({ id: 'db', healthy: () => true })], 3_000);
    assert.equal(supervisor.reprobeIntervalMs, 3_000);
});

test('a healthy service that keeps answering is left alone', async () => {
    const db = fakeService({ id: 'db', healthy: () => true });
    const { supervisor, clock } = build([db]);

    await supervisor.start('db');
    assert.equal(supervisor.stateOf('db'), 'healthy');

    await clock.advance(DEFAULT_REPROBE_INTERVAL_MS * 4);

    assert.equal(supervisor.stateOf('db'), 'healthy');
    assert.equal(db.launches, 1, 'nothing was restarted');
});

test('a postmaster that dies without exiting is noticed by the sweep and restarted', async () => {
    // Postgres is the case this exists for: embedded-postgres never resolves
    // `exited`, so only a probe can tell that the server is gone.
    let alive = true;
    const postgres = fakeService({ id: 'postgres', healthy: () => alive });
    const { supervisor, clock } = build([postgres]);

    await supervisor.start('postgres');
    assert.equal(supervisor.stateOf('postgres'), 'healthy');
    assert.equal(postgres.processes[0]?.stopped, false);

    alive = false;
    await clock.advance(DEFAULT_REPROBE_INTERVAL_MS);

    assert.equal(postgres.processes[0]?.stopped, true, 'the dead handle is stopped first');
    assert.equal(supervisor.stateOf('postgres'), 'starting');
    assert.match(supervisor.snapshotOf('postgres').detail, /stopped answering its health probe; restarting in 1s/);

    // The existing backoff schedule is what runs the restart.
    alive = true;
    await clock.advance(backoffMs(0));
    assert.equal(supervisor.stateOf('postgres'), 'healthy');
    assert.equal(postgres.launches, 2);
    assert.deepEqual(
        supervisor.recentLogs('postgres').map((line) => line.text).filter((text) => text.includes('health probe')),
        ['health probe stopped answering; restarting'],
    );
});

test('a service that never answers again is restarted once and then parked in failed', async () => {
    let alive = true;
    const postgres = fakeService({ id: 'postgres', healthy: () => alive });
    const { supervisor, clock } = build([postgres]);

    await supervisor.start('postgres');
    alive = false;

    await clock.advance(DEFAULT_REPROBE_INTERVAL_MS);
    assert.equal(supervisor.stateOf('postgres'), 'starting');

    // The restart runs, but the probe still says nothing is there, so the normal
    // health-timeout path parks it rather than looping for ever.
    await clock.advance(backoffMs(0) + 5_000);

    assert.equal(postgres.launches, 2);
    assert.equal(supervisor.stateOf('postgres'), 'failed');
    assert.match(supervisor.snapshotOf('postgres').detail, /did not become healthy/);
});

test('the sweep skips one-shots, stopped services and probeless services', async () => {
    const migrations = fakeService({ id: 'migrations', oneshot: true, healthy: () => false });
    const worker = fakeService({ id: 'worker' });
    const stopped = fakeService({ id: 'stopped', healthy: () => false });
    const { supervisor, clock } = build([migrations, worker, stopped]);

    const launch = migrations.definition.launch;
    migrations.definition.launch = async (context) => {
        const handle = await launch(context);
        migrations.current()?.finish(0);
        return handle;
    };
    await supervisor.start('migrations');
    await supervisor.start('worker');
    await settle();

    await clock.advance(DEFAULT_REPROBE_INTERVAL_MS * 2);

    assert.equal(supervisor.stateOf('migrations'), 'healthy');
    assert.equal(supervisor.stateOf('worker'), 'healthy');
    assert.equal(supervisor.stateOf('stopped'), 'stopped');
    assert.equal(stopped.launches, 0);
});

test('stopAll disarms the sweep so a stopped fleet is never restarted', async () => {
    let alive = true;
    const db = fakeService({ id: 'db', healthy: () => alive });
    const { supervisor, clock } = build([db]);

    await supervisor.startAll();
    await supervisor.stopAll();
    assert.equal(clock.pending, 0, 'no timer is left armed');

    alive = false;
    await clock.advance(DEFAULT_REPROBE_INTERVAL_MS * 3);

    assert.equal(supervisor.stateOf('db'), 'stopped');
    assert.equal(db.launches, 1);
});

test('reprobeIntervalMs 0 switches the sweep off entirely', async () => {
    let alive = true;
    const db = fakeService({ id: 'db', healthy: () => alive });
    const { supervisor, clock } = build([db], 0);

    await supervisor.start('db');
    alive = false;
    await clock.advance(60_000);

    assert.equal(supervisor.stateOf('db'), 'healthy');
});

test('restartAll stops everything and brings it back', async () => {
    const db = fakeService({ id: 'db', healthy: () => true });
    const web = fakeService({ id: 'web', dependsOn: ['db'], healthy: () => true });
    const { supervisor } = build([db, web]);

    await supervisor.startAll();
    await supervisor.restartAll();

    assert.equal(db.launches, 2);
    assert.equal(web.launches, 2);
    assert.equal(supervisor.stateOf('web'), 'healthy');
});
