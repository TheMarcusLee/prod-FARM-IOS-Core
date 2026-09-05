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

/** Everything secret in the settings file, replaced in place. */
export function redactSettings(settings: Settings): Record<string, unknown> {
    return {
        ...settings,
        embeddedPostgresPassword: settings.embeddedPostgresPassword ? REDACTED : '',
        databaseUrl: redactUrlPassword(settings.databaseUrl),
    };
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
    snapshot: FleetSnapshot;
    appVersion: string;
    repoRoot: string;
    userData: string;
    compiled: boolean;
}

/** The text files in the bundle, keyed by their name inside the archive. */
export function buildDiagnostics(input: DiagnosticsInput): Record<string, string> {
    return {
        'README.txt': [
            'Phone Farm diagnostics',
            `Collected: ${new Date().toISOString()}`,
            `App version: ${input.appVersion}`,
            `Platform: ${process.platform} ${process.arch} (${os.release()})`,
            `Electron/Node: ${process.versions.electron ?? '-'} / ${process.versions.node}`,
            `Farm root: ${input.repoRoot} (${input.compiled ? 'compiled' : 'TypeScript sources'})`,
            `Data directory: ${input.userData}`,
            '',
            'settings.json has had its passwords replaced with ' + REDACTED + '.',
            `logs/ holds the last ${Math.round(LOG_TAIL_BYTES / 1024 / 1024)} MB of each service log, rotated generations included.`,
        ].join('\n') + '\n',
        'settings.json': `${JSON.stringify(redactSettings(input.settings), null, 2)}\n`,
        'services.txt': `${serviceTable(input.snapshot)}\n`,
        'services.json': `${JSON.stringify(input.snapshot.services, null, 2)}\n`,
        'jobs.json': `${JSON.stringify(input.snapshot.jobs, null, 2)}\n`,
    };
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
): Promise<void> {
    const staging = await mkdtemp(path.join(os.tmpdir(), 'phone-farm-diagnostics-'));
    try {
        for (const [name, content] of Object.entries(files)) {
            await writeFile(path.join(staging, name), content, { mode: 0o600 });
        }
        await mkdir(path.join(staging, 'logs'), { recursive: true });
        for (const id of serviceIds) {
            for (const file of logs.filesFor(id)) {
                const tail = await tailFile(file);
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
