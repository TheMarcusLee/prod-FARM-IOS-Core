import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceTone, serviceWord } from '../src/main/state-words.ts';
import { mergeTail } from '../src/renderer/live-log.ts';
import { attachedAndroidPhones, headerState, rigRows } from '../src/renderer/rig-model.ts';
import type { FleetSnapshot, LogLine, ServiceSnapshot, ServiceState } from '../src/main/types.ts';
import type { Settings } from '../src/main/settings.ts';
import { normalizeSettings } from '../src/main/settings.ts';

function service(id: string, state: ServiceState, extra: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
    return {
        id, label: id, state, detail: '', help: null, optional: false,
        restarts: 0, pid: null, since: null, logPath: null, recentLogs: [], ...extra,
    };
}

function fleet(services: ServiceSnapshot[], overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
    return { services, jobs: [], dashboardUrl: null, shuttingDown: false, ...overrides };
}

function line(text: string): LogLine {
    return { at: 0, stream: 'out', text };
}

const settings: Settings = normalizeSettings({ webPort: 3000, appiumPort: 4725 });

function row(snapshot: FleetSnapshot, name: string, using: Settings | null = settings) {
    const found = rigRows(snapshot, using).find((candidate) => candidate.name === name);
    assert.ok(found, `${name} is one of the rig's rows`);
    return found;
}

test('the supervisor\'s states are shown as the words the design asks for', () => {
    assert.equal(serviceWord('healthy'), 'Running');
    assert.equal(serviceWord('starting'), 'Starting');
    assert.equal(serviceWord('stopped'), 'Idle');
    assert.equal(serviceWord('not-configured'), 'Not configured');
    assert.equal(serviceWord('failed'), 'Failed');
    assert.equal(serviceTone('healthy'), 'ok');
    assert.equal(serviceTone('failed'), 'bad');
});

test('the rows say what each service is for, not what it is called', () => {
    const snapshot = fleet([
        service('postgres', 'healthy'),
        service('migrations', 'healthy'),
        service('web', 'healthy'),
        service('worker', 'healthy'),
    ]);

    assert.equal(row(snapshot, 'Database').detail, 'Embedded Postgres 17 · migrations applied');
    assert.equal(row(snapshot, 'Worker').detail, 'Runs scheduled tasks');
    assert.equal(row(snapshot, 'Dashboard').detail, 'Web and API on port 3000');
    assert.equal(row(snapshot, 'Database').word, 'Running');
    // The migrations are part of the database, not a row an operator has to read.
    assert.equal(rigRows(snapshot, settings).some((candidate) => candidate.name.includes('igration')), false);
    assert.deepEqual(row(snapshot, 'Database').logIds, ['postgres', 'migrations']);
});

test('an operator who brought their own Postgres is not told about the bundled one', () => {
    const snapshot = fleet([service('postgres', 'healthy'), service('migrations', 'failed')]);
    const detail = row(snapshot, 'Database', normalizeSettings({ databaseUrl: 'postgresql://a@b:5432/c' })).detail;
    assert.equal(detail, 'Your own Postgres server · migrations failed');
});

test('a service that failed says why, instead of what it is for', () => {
    const snapshot = fleet([
        service('adb', 'not-configured', { detail: 'Android discovery is off in Settings; adb is not started.' }),
        service('wda', 'failed', { detail: 'Xcode is unavailable.', restarts: 2 }),
    ]);

    assert.equal(row(snapshot, 'Android bridge').detail, 'Android discovery is off in Settings; adb is not started.');
    assert.equal(row(snapshot, 'Android bridge').word, 'Not configured');
    assert.equal(row(snapshot, 'iPhone bridge').detail, 'Xcode is unavailable. · restarted 2 times');
});

test('the Android bridge counts the phones adb last listed', () => {
    const logs = [
        line('List of devices attached'),
        line('emulator-5554\tdevice'),
        line('R58M12345\tdevice'),
        line('R58Mbroken\tunauthorized'),
    ];
    assert.equal(attachedAndroidPhones(service('adb', 'healthy', { recentLogs: logs })), 2);
    assert.equal(attachedAndroidPhones(service('adb', 'healthy')), null);

    const snapshot = fleet([service('adb', 'healthy', { recentLogs: logs })]);
    assert.equal(row(snapshot, 'Android bridge').detail, 'adb · 2 phones attached');
});

test('the push relay is named but never claimed: this app does not run it', () => {
    const relay = row(fleet([]), 'Push relay');
    assert.equal(relay.id, null, 'nothing to start or stop');
    assert.deepEqual(relay.logIds, []);
    assert.match(relay.detail, /npm run push:relay/);
});

test('the header carries the one fact the window is for: is the farm working', () => {
    const running = headerState(fleet(
        [service('worker', 'healthy')],
        { dashboardUrl: 'http://127.0.0.1:3000' },
    ));
    assert.equal(running.text, 'Backline is running · dashboard at 127.0.0.1:3000');
    assert.equal(running.tone, 'ok');

    // The paused banner is now the header, so a stopped worker still shouts.
    const paused = headerState(fleet([service('worker', 'failed')], { dashboardUrl: 'http://127.0.0.1:3000' }));
    assert.match(paused.text, /no schedule will run until it is back/);
    assert.equal(paused.tone, 'bad');

    assert.match(headerState(fleet([service('worker', 'healthy')])).text, /dashboard is not up yet/);
});

test('the live log keeps 200 lines across overlapping snapshots, without repeating any', () => {
    const first = [line('one'), line('two'), line('three')];
    const second = [line('two'), line('three'), line('four')];

    const merged = mergeTail(mergeTail([], first), second);
    assert.deepEqual(merged.map((entry) => entry.text), ['one', 'two', 'three', 'four']);

    const long = Array.from({ length: 260 }, (_, index) => line(`line ${index}`));
    const capped = mergeTail([], long);
    assert.equal(capped.length, 200);
    assert.equal(capped.at(-1)?.text, 'line 259');
    // An unchanged snapshot must not grow the panel by a single line.
    assert.equal(mergeTail(capped, long.slice(-40)).length, 200);
});
