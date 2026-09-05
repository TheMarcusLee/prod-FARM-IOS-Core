import { execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

/** Can we open a TCP connection? Used for the Postgres probe. */
export function tcpReachable(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

/**
 * A `pg_isready`-equivalent probe: open a socket, send the 8-byte SSLRequest a
 * client sends first, and require the single-byte `S`/`N` answer only a live
 * postmaster gives.
 *
 * A plain TCP connect is not enough for the bundled cluster. `embedded-postgres`
 * never reports an exit, so a postmaster that dies has to be noticed by asking
 * it something; and on macOS a half-dead listener can still accept a connection.
 * This stops short of authenticating, so it needs no credentials and leaves no
 * session behind in the server log.
 */
export function postgresReady(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        let settled = false;
        const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => {
            const request = Buffer.alloc(8);
            request.writeInt32BE(8, 0);
            // 1234 << 16 | 5679 — the magic "do you speak TLS?" protocol version.
            request.writeInt32BE(80_877_103, 4);
            socket.write(request);
        });
        socket.once('data', (chunk: Buffer) => {
            const reply = chunk.toString('latin1', 0, 1);
            done(reply === 'S' || reply === 'N');
        });
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.once('close', () => done(false));
    });
}

export interface HttpProbeOptions {
    socketPath?: string;
    host?: string;
    port?: number;
    timeoutMs?: number;
}

/** GET `path` and resolve the body when the status is 2xx. Never throws. */
export function httpProbe(path: string, options: HttpProbeOptions): Promise<string | null> {
    return new Promise((resolve) => {
        const request = http.request({
            socketPath: options.socketPath,
            host: options.socketPath ? undefined : (options.host ?? '127.0.0.1'),
            port: options.socketPath ? undefined : options.port,
            path,
            method: 'GET',
            timeout: options.timeoutMs ?? 2_000,
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
                const status = response.statusCode ?? 0;
                resolve(status >= 200 && status < 300 ? Buffer.concat(chunks).toString('utf8') : null);
            });
        });
        request.once('error', () => resolve(null));
        request.once('timeout', () => { request.destroy(); resolve(null); });
        request.end();
    });
}

export async function httpOk(path: string, options: HttpProbeOptions): Promise<boolean> {
    return (await httpProbe(path, options)) !== null;
}

export interface CommandResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

/** Runs a command and never rejects; `ok` is "exited 0". */
export function runCommand(
    file: string,
    args: readonly string[],
    options: { env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {},
): Promise<CommandResult> {
    return new Promise((resolve) => {
        execFile(file, [...args], {
            env: options.env ?? process.env as Record<string, string>,
            timeout: options.timeoutMs ?? 10_000,
            cwd: options.cwd,
            maxBuffer: 4 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

/** Extra places a GUI app has to look, because it does not inherit a login shell PATH. */
export const EXTRA_PATH_ENTRIES = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${process.env.HOME ?? ''}/Library/Android/sdk/platform-tools`,
    `${process.env.ANDROID_HOME ?? ''}/platform-tools`,
    `${process.env.ANDROID_SDK_ROOT ?? ''}/platform-tools`,
].filter((entry) => entry && !entry.startsWith('/platform-tools'));

/** PATH for children, widened so Homebrew and the Android SDK are visible from a .app. */
export function widenedPath(): string {
    const seen = new Set<string>();
    const parts = [...(process.env.PATH ?? '').split(':'), ...EXTRA_PATH_ENTRIES, '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    return parts.filter((part) => part && !seen.has(part) && seen.add(part)).join(':');
}
