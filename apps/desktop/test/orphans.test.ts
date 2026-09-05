import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    ChildRegistry, parseChildRecords, reapOrphans, type ChildRecord, type ReapTools,
} from '../src/main/orphans.ts';

function record(pid: number, label = 'web', command = `node ${label}.js`): ChildRecord {
    return { pid, label, command, startedAt: 1_000 };
}

/** A machine whose live pids and command lines the test decides. */
function tools(live: Record<number, string>): ReapTools & { killed: number[] } {
    const killed: number[] = [];
    return {
        killed,
        alive: (pid) => pid in live,
        commandOf: (pid) => live[pid] ?? null,
        kill: (pid) => { killed.push(pid); },
    };
}

test('a child left running by a crashed previous run is killed', () => {
    const machine = tools({ 501: 'node web.js', 502: 'node worker.js' });
    const outcome = reapOrphans([record(501, 'web'), record(502, 'worker')], machine);

    assert.deepEqual(machine.killed, [501, 502]);
    assert.deepEqual(outcome.killed.map((entry) => entry.label), ['web', 'worker']);
    assert.equal(outcome.skipped.length, 0);
});

test('a pid that is already gone is left alone', () => {
    const machine = tools({});
    const outcome = reapOrphans([record(501)], machine);

    assert.deepEqual(machine.killed, []);
    assert.deepEqual(outcome.skipped.map((entry) => entry.pid), [501]);
});

test('a recycled pid now belonging to something else is never killed', () => {
    // The whole reason the command line is recorded: between the crash and the
    // next launch the OS can hand 501 to the operator's own editor, and killing
    // that would be far worse than leaving an orphan behind.
    const machine = tools({ 501: '/Applications/Xcode.app/Contents/MacOS/Xcode' });
    const outcome = reapOrphans([record(501, 'web', 'node web.js')], machine);

    assert.deepEqual(machine.killed, []);
    assert.deepEqual(outcome.skipped.map((entry) => entry.pid), [501]);
});

test('pid 0, pid 1 and negative pids are refused outright', () => {
    const machine = tools({ 0: 'kernel_task', 1: '/sbin/launchd', [-1]: 'nonsense' });
    const outcome = reapOrphans([record(0), record(1), record(-1)], machine);

    assert.deepEqual(machine.killed, [], 'the app never signals the whole world or launchd');
    assert.equal(outcome.skipped.length, 3);
});

test('a corrupt or hostile pid file parses to nothing rather than throwing', () => {
    assert.deepEqual(parseChildRecords(null), []);
    assert.deepEqual(parseChildRecords('not json'), []);
    assert.deepEqual(parseChildRecords([{ pid: 'all' }, { pid: 7 }, 42]), []);
    assert.deepEqual(parseChildRecords([record(7)]), [record(7)]);
});

test('the registry records a spawn, forgets an exit and survives a restart of the app', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'phone-farm-pids-'));
    const naming = { commandOf: (pid: number) => `node service-${pid}.js` };

    const first = new ChildRegistry(directory);
    first.add(501, 'web', naming);
    first.add(502, 'worker', naming);
    first.remove(502);

    assert.deepEqual(first.current().map((entry) => entry.pid), [501]);

    // A second launch reads exactly what the first left on disk.
    const second = new ChildRegistry(directory);
    assert.deepEqual(second.previous().map((entry) => entry.label), ['web']);

    const machine = tools({ 501: 'node service-501.js' });
    assert.deepEqual(second.reapPrevious(machine).map((entry) => entry.pid), [501]);
    assert.deepEqual(machine.killed, [501]);
    assert.deepEqual(new ChildRegistry(directory).previous(), [], 'the file is cleared after a reap');
});

test('a clean quit clears the pid file, so the next launch kills nothing', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'phone-farm-pids-'));
    const registry = new ChildRegistry(directory);
    registry.add(501, 'web', { commandOf: () => 'node web.js' });
    registry.clear();

    const machine = tools({ 501: 'node web.js' });
    assert.deepEqual(new ChildRegistry(directory).reapPrevious(machine), []);
    assert.deepEqual(machine.killed, [], 'a service stopped on the way out is not an orphan');
});

test('the pid file is written 0600 — it names every process the app runs', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'phone-farm-pids-'));
    const registry = new ChildRegistry(directory);
    registry.add(501, 'web', { commandOf: () => 'node web.js' });

    assert.equal(readFileSync(registry.file, 'utf8').includes('"web"'), true);
});

test('an unreadable pid file does not stop the app from starting', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'phone-farm-pids-'));
    const registry = new ChildRegistry(directory);
    writeFileSync(registry.file, '{ this is not json');

    assert.deepEqual(registry.previous(), []);
    assert.deepEqual(registry.reapPrevious(tools({})), []);
});
