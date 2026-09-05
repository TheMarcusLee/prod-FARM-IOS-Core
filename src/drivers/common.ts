import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DriverError } from './types.js';

const execFileAsync = promisify(execFile);

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Sleep that rejects with the abort reason as soon as the execution is stopped. */
export function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export interface CommandResult {
    /** A string for `encoding: 'utf8'` (the default), a Buffer for `encoding: 'buffer'`. */
    stdout: string | Buffer;
    stderr: string | Buffer;
}

export interface CommandOptions {
    timeoutMs?: number;
    maxBuffer?: number;
    encoding?: 'utf8' | 'buffer';
}

export interface CommandRunner {
    (file: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

/** Thin execFile wrapper so drivers can be tested with a fake runner. */
export const runCommand: CommandRunner = async (file, args, { timeoutMs = 30_000, maxBuffer = 64 * 1024 * 1024, encoding = 'utf8' } = {}) => {
    try {
        return await execFileAsync(file, args, { timeout: timeoutMs, maxBuffer, encoding });
    } catch (error) {
        throw new DriverError(`${file} ${args.join(' ')} failed: ${errorMessage(error)}`);
    }
};

export interface HttpClient {
    (url: string, init?: RequestInit): Promise<Response>;
}

/** fetch with a deadline and a DriverError instead of a bare TypeError on connection failure. */
export function httpClient(fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): HttpClient {
    return async (url, init = {}) => {
        let response: Response;
        try {
            response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
            throw new DriverError(`${url} is unavailable: ${errorMessage(error)}`);
        }
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new DriverError(`${url} returned ${response.status}${detail ? `: ${detail}` : ''}`);
        }
        return response;
    };
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
