import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';

import type { LogLine } from './types.ts';

/** One append-only log file per service, under userData/logs. */
export class LogFiles {
    private readonly streams = new Map<string, WriteStream>();

    private readonly directory: string;

    constructor(directory: string) {
        this.directory = directory;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
    }

    pathFor(serviceId: string): string {
        return path.join(this.directory, `${serviceId}.log`);
    }

    append(serviceId: string, line: LogLine): void {
        let stream = this.streams.get(serviceId);
        if (!stream) {
            stream = createWriteStream(this.pathFor(serviceId), { flags: 'a', mode: 0o600 });
            stream.on('error', () => undefined);
            this.streams.set(serviceId, stream);
        }
        stream.write(`${new Date(line.at).toISOString()} [${line.stream}] ${line.text}\n`);
    }

    close(): void {
        for (const stream of this.streams.values()) stream.end();
        this.streams.clear();
    }
}
