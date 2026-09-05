import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    LOG_TAIL_BYTES, REDACTED, buildDiagnostics, redactSettings, redactUrlPassword, secretScrubber,
    secretsOf, serviceTable, tailFile,
} from '../src/main/diagnostics.ts';
import { postgresReady } from '../src/main/health.ts';
import { LogFiles, MAX_LOG_BYTES, MAX_LOG_GENERATIONS, rotateLogFile } from '../src/main/logs.ts';
import { farmEntryExtension } from '../src/main/paths.ts';
import { embeddedDatabaseUrl, normalizeSettings } from '../src/main/settings.ts';
import type { FleetSnapshot } from '../src/main/types.ts';

function temporaryDirectory(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), prefix));
}

const snapshot: FleetSnapshot = {
    services: [
        {
            id: 'postgres', label: 'PostgreSQL (bundled)', state: 'healthy', detail: '', help: null,
            optional: false, restarts: 0, pid: null, since: 1, logPath: null, recentLogs: [],
        },
        {
            id: 'wda', label: 'WDA service', state: 'not-configured', detail: 'Set XCODE_ORG_ID', help: 'docs/getting-started.md',
            optional: true, restarts: 2, pid: 91, since: null, logPath: null, recentLogs: [],
        },
    ],
    jobs: [],
    dashboardUrl: 'http://127.0.0.1:3000',
    shuttingDown: false,
};

test('the log rotates at 10 MB and keeps five generations', async () => {
    assert.equal(MAX_LOG_BYTES, 10 * 1024 * 1024);
    assert.equal(MAX_LOG_GENERATIONS, 5);

    const directory = temporaryDirectory('farm-logs-');
    // 200 bytes is plenty to force several rotations without writing 10 MB.
    const logs = new LogFiles(directory, { maxBytes: 200, generations: 3 });
    for (let index = 0; index < 40; index += 1) {
        logs.append('web', { at: 0, stream: 'out', text: `line ${index} ${'x'.repeat(40)}` });
    }
    logs.close();
    // The write streams flush asynchronously; give the last one a tick to land.
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    const base = path.join(directory, 'web.log');
    assert.ok(existsSync(base));
    assert.ok(existsSync(`${base}.1`));
    assert.ok(existsSync(`${base}.3`));
    assert.ok(!existsSync(`${base}.4`), 'generations past the cap are dropped');
    assert.ok(readFileSync(base, 'utf8').includes('line 39'), 'the live file holds the newest lines');
    assert.deepEqual(
        logs.filesFor('web').map((file) => path.basename(file)),
        ['web.log', 'web.log.1', 'web.log.2', 'web.log.3'],
    );
});

test('rotation shifts generations and drops the oldest', () => {
    const directory = temporaryDirectory('farm-rotate-');
    const base = path.join(directory, 'a.log');
    for (const suffix of ['', '.1', '.2']) writeFileSync(`${base}${suffix}`, `content${suffix}`);

    rotateLogFile(base, 2);

    assert.ok(!existsSync(base), 'the live file was moved aside');
    assert.equal(readFileSync(`${base}.1`, 'utf8'), 'content');
    assert.equal(readFileSync(`${base}.2`, 'utf8'), 'content.1');
    assert.ok(!existsSync(`${base}.3`));
});

test('diagnostics redact every secret but keep the shape of the connection string', () => {
    const settings = normalizeSettings({
        embeddedPostgresPassword: 'super-secret',
        databaseUrl: 'postgresql://farm:hunter2@db.example.com:5432/phone_farm',
    });

    const redacted = redactSettings(settings);

    assert.equal(redacted.embeddedPostgresPassword, REDACTED);
    assert.ok(!JSON.stringify(redacted).includes('super-secret'));
    assert.ok(!JSON.stringify(redacted).includes('hunter2'));
    assert.match(String(redacted.databaseUrl), /db\.example\.com:5432\/phone_farm/);
    assert.equal(redactUrlPassword(''), '');
    assert.equal(redactUrlPassword('not a url'), REDACTED);
});

test('the diagnostics bundle carries the service table and no secrets', () => {
    const settings = normalizeSettings({ embeddedPostgresPassword: 'super-secret' });
    const files = buildDiagnostics({
        settings, databaseUrl: '', snapshot, appVersion: '0.1.0',
        repoRoot: '/farm', userData: '/data', compiled: true,
    });

    assert.ok(!JSON.stringify(files).includes('super-secret'));
    assert.match(files['services.txt'] ?? '', /postgres\s+healthy\s+required/);
    assert.match(files['services.txt'] ?? '', /wda\s+not-configured\s+optional\s+2\s+91\s+Set XCODE_ORG_ID/);
    assert.match(files['README.txt'] ?? '', /compiled/);
    assert.deepEqual(Object.keys(files).sort(), ['README.txt', 'jobs.json', 'services.json', 'services.txt', 'settings.json']);
    assert.equal(serviceTable({ ...snapshot, services: [] }).split('\n').length, 2, 'header only when empty');
});

test('log tails keep the end of a file and never split a line', async () => {
    const directory = temporaryDirectory('farm-tail-');
    const file = path.join(directory, 'big.log');
    writeFileSync(file, Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n'));

    const whole = await tailFile(file);
    assert.match(whole, /^line 0\n/);

    const tail = await tailFile(file, 30);
    assert.ok(tail.endsWith('line 99'));
    assert.ok(!tail.includes('line 0\n'));
    assert.ok(tail.split('\n').every((line) => line.startsWith('line ')), 'no partial first line');
    assert.equal(await tailFile(path.join(directory, 'missing.log')), '');
    assert.equal(LOG_TAIL_BYTES, 2 * 1024 * 1024);
});

test('the postgres probe rejects a socket that is not a postmaster', async () => {
    const server = net.createServer((socket) => socket.end('nope'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
        assert.equal(await postgresReady('127.0.0.1', port, 1_000), false);
    } finally {
        server.close();
    }
    // Nothing is listening any more: a closed port is not ready either.
    assert.equal(await postgresReady('127.0.0.1', port, 500), false);
});

test('the postgres probe accepts the SSLRequest answer a real postmaster gives', async () => {
    const server = net.createServer((socket) => {
        socket.once('data', (chunk: Buffer) => {
            assert.equal(chunk.readInt32BE(0), 8);
            assert.equal(chunk.readInt32BE(4), 80_877_103);
            socket.write('N');
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
        assert.equal(await postgresReady('127.0.0.1', port, 1_000), true);
    } finally {
        server.close();
    }
});

test('a compiled farm tree is recognised so children run without tsx', () => {
    const directory = temporaryDirectory('farm-root-');
    assert.equal(farmEntryExtension(directory), null);

    const apiDirectory = path.join(directory, 'src', 'api');
    mkdirSync(apiDirectory, { recursive: true });

    writeFileSync(path.join(apiDirectory, 'server.ts'), '');
    assert.equal(farmEntryExtension(directory), 'ts');
    writeFileSync(path.join(apiDirectory, 'server.js'), '');
    assert.equal(farmEntryExtension(directory), 'js', 'compiled output wins');
});

test('a secret that reached a log line is scrubbed out of the whole bundle', () => {
    // The leak this closes: redacting settings.json is not enough, because the
    // farm's own children print the connection string when a query fails, and
    // that lands in the service logs and in services.json's recentLogs.
    const settings = normalizeSettings({ embeddedPostgresPassword: 'sup3r-s3cret-passphrase' });
    const databaseUrl = embeddedDatabaseUrl(55_432, settings.embeddedPostgresPassword);
    const leaky: FleetSnapshot = {
        ...snapshot,
        services: [{
            ...snapshot.services[0]!,
            detail: `could not connect to ${databaseUrl}`,
            recentLogs: [{ at: 0, stream: 'err', text: `FATAL: password authentication failed for ${databaseUrl}` }],
        }],
    };

    const files = buildDiagnostics({
        settings, databaseUrl, snapshot: leaky, appVersion: '0.1.0',
        repoRoot: '/farm', userData: '/data', compiled: true,
    });
    const whole = JSON.stringify(files);

    assert.ok(!whole.includes('sup3r-s3cret-passphrase'), 'the password is gone from every file');
    assert.ok(!whole.includes(databaseUrl), 'and so is the connection string built from it');
    assert.match(files['services.json'] ?? '', /password authentication failed/, 'the failure itself survives');
});

test('the scrubber also catches the percent-encoded spelling a URL puts on the wire', () => {
    const scrub = secretScrubber(secretsOf(
        normalizeSettings({ embeddedPostgresPassword: 'a+b/c=secret' }), '',
    ));

    assert.equal(scrub('url=a%2Bb%2Fc%3Dsecret end'), `url=${REDACTED} end`);
    assert.equal(scrub('raw a+b/c=secret end'), `raw ${REDACTED} end`);
    assert.equal(scrub('nothing to hide'), 'nothing to hide');
});

test('the scrubber ignores empty and implausibly short secrets', () => {
    // An eight-character floor: a two-character "secret" would blank out half the
    // log and leave the operator with a diagnostics bundle nobody can read.
    const scrub = secretScrubber(['', '  ', 'abc', 'long-enough-secret']);
    assert.equal(scrub('abc is fine, long-enough-secret is not'), `abc is fine, ${REDACTED} is not`);
});

test('redaction is driven by the key name, so a secret added later is covered', () => {
    const redacted = redactSettings({
        ...normalizeSettings({}),
        // A field the app does not have yet, standing in for the next one added.
        apiToken: 'tok_live_123456',
        xcodeOrgId: 'ABCDE12345',
    } as never);

    assert.equal(redacted.apiToken, REDACTED);
    assert.equal(redacted.xcodeOrgId, 'ABCDE12345', 'an Xcode org id is not a credential');
    assert.equal(redacted.xcodeSigningId, 'Apple Development');
});
