import { createWriteStream, mkdirSync, openSync, renameSync, rmSync, statSync, type WriteStream } from 'node:fs';
import path from 'node:path';

import type { LogLine } from './types.ts';

/** Rotate at 10 MB, keeping five older generations (`web.log.1` … `web.log.5`). */
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const MAX_LOG_GENERATIONS = 5;

export interface LogFilesOptions {
    maxBytes?: number;
    generations?: number;
}

/**
 * Shifts `file.4` → `file.5`, … `file` → `file.1` and drops what falls off the end.
 * Exported so the rotation can be tested without writing 10 MB.
 */
export function rotateLogFile(file: string, generations = MAX_LOG_GENERATIONS): void {
    try {
        rmSync(`${file}.${generations}`, { force: true });
    } catch { /* nothing to drop */ }
    for (let index = generations - 1; index >= 1; index -= 1) {
        try {
            renameSync(`${file}.${index}`, `${file}.${index + 1}`);
        } catch { /* that generation does not exist yet */ }
    }
    try {
        renameSync(file, `${file}.1`);
    } catch { /* nothing written yet */ }
}

function sizeOf(file: string): number {
    try {
        return statSync(file).size;
    } catch {
        return 0;
    }
}

/** One rotating log file per service, under userData/logs, all `0600`. */
export class LogFiles {
    private readonly streams = new Map<string, WriteStream>();
    private readonly sizes = new Map<string, number>();
    private readonly directory: string;
    private readonly maxBytes: number;
    private readonly generations: number;

    constructor(directory: string, options: LogFilesOptions = {}) {
        this.directory = directory;
        this.maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
        this.generations = options.generations ?? MAX_LOG_GENERATIONS;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
    }

    pathFor(serviceId: string): string {
        return path.join(this.directory, `${serviceId}.log`);
    }

    /** The live file plus every rotated generation that exists, newest first. */
    filesFor(serviceId: string): string[] {
        const base = this.pathFor(serviceId);
        const files = [base];
        for (let index = 1; index <= this.generations; index += 1) {
            const rotated = `${base}.${index}`;
            if (sizeOf(rotated) > 0) files.push(rotated);
        }
        return files.filter((file) => sizeOf(file) > 0);
    }

    append(serviceId: string, line: LogLine): void {
        const text = `${new Date(line.at).toISOString()} [${line.stream}] ${line.text}\n`;
        const bytes = Buffer.byteLength(text);
        const file = this.pathFor(serviceId);
        let size = this.sizes.get(serviceId) ?? sizeOf(file);
        if (size + bytes > this.maxBytes) {
            this.closeOne(serviceId);
            rotateLogFile(file, this.generations);
            size = 0;
        }
        let stream = this.streams.get(serviceId);
        if (!stream) {
            // The file is opened synchronously: `createWriteStream(path)` opens on a
            // later tick, and rotation renames the file from this same call stack.
            const fd = openSync(file, 'a', 0o600);
            stream = createWriteStream('', { fd, autoClose: true });
            stream.on('error', () => undefined);
            this.streams.set(serviceId, stream);
        }
        stream.write(text);
        this.sizes.set(serviceId, size + bytes);
    }

    private closeOne(serviceId: string): void {
        this.streams.get(serviceId)?.end();
        this.streams.delete(serviceId);
        this.sizes.delete(serviceId);
    }

    close(): void {
        for (const stream of this.streams.values()) stream.end();
        this.streams.clear();
        this.sizes.clear();
    }
}
