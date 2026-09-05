import { open, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from './health.ts';
import type { LogFiles } from './logs.ts';
import type { Settings } from './settings.ts';
import type { FleetSnapshot } from './types.ts';

export const REDACTED = '«redacted»';
/** Per service log file. Rotation allows 60 MB each; a diagnostics zip must stay mailable. */
export const LOG_TAIL_BYTES = 2 * 1024 * 1024;

/** The last `maxBytes` of a file, or '' when it cannot be read. */
export async function tailFile(file: string, maxBytes = LOG_TAIL_BYTES): Promise<string> {
    let handle;
    try {
        const size = (await stat(file)).size;
        const start = Math.max(0, size - maxBytes);
        handle = await open(file, 'r');
        const buffer = Buffer.alloc(size - start);
        await handle.read(buffer, 0, buffer.length, start);
        const text = buffer.toString('utf8');
        // A byte offset can land mid-line; drop the partial one.
        return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } catch {
        return '';
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/**
 * Settings keys whose value is a secret, whatever it happens to be called.
 *
 * A key added to `Settings` later is redacted by this the day it is added, rather
 * than the day somebody remembers to update this file. The Xcode identifiers are
 * deliberately *not* here: an org id and a signing identity are the two things a
 * support conversation always needs, and neither is a credential.
 */
export const SECRET_KEY_PATTERN = /pass(word|phrase)?$|secret|token|credential|apikey|api_key/i;

/** Everything secret in the settings file, replaced in place. */
export function redactSettings(settings: Settings): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings)) {
        if (SECRET_KEY_PATTERN.test(key)) out[key] = value ? REDACTED : '';
        else if (/url$/i.test(key) && typeof value === 'string') out[key] = redactUrlPassword(value);
        else out[key] = value;
    }
    return out;
}

/**
 * A function that removes every literal secret from arbitrary text.
 *
 * The redaction above only covers the settings file. Secrets also reach the
 * bundle the long way round: the farm's own children print a connection string
 * when a query fails, drizzle names the database it could not reach, and all of
 * that lands in the service logs and in the `recentLogs` of services.json. The
 * generated Postgres password would then travel out of the machine inside a zip
 * the operator emails to whoever is helping them.
 *
 * Longest first, so a secret that contains another is replaced whole.
 */
export function secretScrubber(secrets: readonly string[]): (text: string) => string {
    // A very short "secret" would match half the log; nothing real is that short.
    const literals = [...new Set(secrets.filter((secret) => secret.trim().length >= 8))]
        .sort((left, right) => right.length - left.length);
    if (literals.length === 0) return (text) => text;
    return (text) => literals.reduce(
        (carry, secret) => carry.split(secret).join(REDACTED),
        text,
    );
}

/**
 * Every form a secret takes on its way into a log line: the password itself, the
 * connection string built from it, and the percent-encoded spelling of both that
 * a URL puts on the wire.
 */
export function secretsOf(settings: Settings, resolvedDatabaseUrl: string): string[] {
    const raw = [settings.embeddedPostgresPassword, settings.databaseUrl, resolvedDatabaseUrl];
    for (const url of [settings.databaseUrl, resolvedDatabaseUrl]) {
        try {
            const password = new URL(url).password;
            if (password) raw.push(password, decodeURIComponent(password));
        } catch { /* not a URL; the literal itself is still scrubbed */ }
    }
    return raw
        .filter((secret): secret is string => Boolean(secret?.trim()))
        .flatMap((secret) => [secret, encodeURIComponent(secret)]);
}

/** Keeps the shape of a connection string (host, port, database) but not its password. */
export function redactUrlPassword(url: string): string {
    if (!url.trim()) return '';
    try {
        const parsed = new URL(url);
        if (parsed.password) parsed.password = REDACTED;
        return decodeURIComponent(parsed.toString());
    } catch {
        // Unparseable: nothing can be salvaged safely, so keep nothing.
        return REDACTED;
    }
}

/** The service table as a fixed-width text file — the first thing anyone reads. */
export function serviceTable(snapshot: FleetSnapshot): string {
    const rows = snapshot.services.map((service) => [
        service.id,
        service.state,
        service.optional ? 'optional' : 'required',
        String(service.restarts),
        service.pid === null ? '-' : String(service.pid),
        service.detail || '-',
    ]);
    const header = ['service', 'state', 'kind', 'restarts', 'pid', 'detail'];
    const widths = header.map((label, column) => Math.max(label.length, ...rows.map((row) => row[column]?.length ?? 0)));
    const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();
    return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

export interface DiagnosticsInput {
    settings: Settings;
    /** The connection string children are actually given, so it can be scrubbed. */
    databaseUrl: string;
    snapshot: FleetSnapshot;
    appVersion: string;
    repoRoot: string;
    userData: string;
    compiled: boolean;
}

/** The text files in the bundle, keyed by their name inside the archive. */
export function buildDiagnostics(input: DiagnosticsInput): Record<string, string> {
    const scrub = secretScrubber(secretsOf(input.settings, input.databaseUrl));
    const files: Record<string, string> = {
        'README.txt': [
            'Phone Farm diagnostics',
            `Collected: ${new Date().toISOString()}`,
            `App version: ${input.appVersion}`,
            `Platform: ${process.platform} ${process.arch} (${os.release()})`,
            `Electron/Node: ${process.versions.electron ?? '-'} / ${process.versions.node}`,
            `Farm root: ${input.repoRoot} (${input.compiled ? 'compiled' : 'TypeScript sources'})`,
            `Data directory: ${input.userData}`,
            '',
            'Passwords, tokens and connection strings have been replaced with ' + REDACTED
            + ' throughout, in the logs as well as in settings.json.',
            `logs/ holds the last ${Math.round(LOG_TAIL_BYTES / 1024 / 1024)} MB of each service log, rotated generations included.`,
        ].join('\n') + '\n',
        'settings.json': `${JSON.stringify(redactSettings(input.settings), null, 2)}\n`,
        'services.txt': `${serviceTable(input.snapshot)}\n`,
        'services.json': `${JSON.stringify(input.snapshot.services, null, 2)}\n`,
        'jobs.json': `${JSON.stringify(input.snapshot.jobs, null, 2)}\n`,
    };
    // Scrubbed as a last pass over everything, including the log lines that
    // services.json carries: no file leaves this function unfiltered.
    return Object.fromEntries(Object.entries(files).map(([name, text]) => [name, scrub(text)]));
}

/**
 * Writes the bundle to `destination` as a zip.
 *
 * macOS always ships `/usr/bin/zip`, and shelling out to it keeps the app free
 * of an archive dependency it would use exactly once.
 */
export async function writeDiagnosticsZip(
    destination: string,
    files: Record<string, string>,
    logs: LogFiles,
    serviceIds: readonly string[],
    scrub: (text: string) => string = (text) => text,
): Promise<void> {
    const staging = await mkdtemp(path.join(os.tmpdir(), 'phone-farm-diagnostics-'));
    try {
        for (const [name, content] of Object.entries(files)) {
            await writeFile(path.join(staging, name), content, { mode: 0o600 });
        }
        await mkdir(path.join(staging, 'logs'), { recursive: true });
        for (const id of serviceIds) {
            for (const file of logs.filesFor(id)) {
                const tail = scrub(await tailFile(file));
                if (!tail) continue;
                await writeFile(path.join(staging, 'logs', path.basename(file)), tail, { mode: 0o600 });
            }
        }
        await rm(destination, { force: true });
        const zipped = await runCommand('/usr/bin/zip', ['-q', '-r', destination, '.'], {
            cwd: staging,
            timeoutMs: 120_000,
        });
        if (!zipped.ok) throw new Error(`zip failed: ${zipped.stderr.trim() || 'unknown error'}`);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}
