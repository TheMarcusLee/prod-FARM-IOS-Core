import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * How Backline runs a cheap coding agent.
 *
 * The one implementation drives Google's Antigravity CLI (`agy`) headlessly, which is the
 * supported way to reach Gemini on a Google AI subscription. Backline never sees the credential:
 * `agy` keeps the Google login in the OS keyring and Backline only ever spawns the binary. It
 * also never falls back to an API key — `GEMINI_API_KEY` and friends are stripped from the child
 * environment so a stray variable cannot quietly move the work onto metered billing.
 *
 * It is an interface because the calibrate job has to be testable without a CLI, a network, or a
 * phone: `createFakeAgentRunner` is what the tests drive.
 */

export const AGY_INSTALL_COMMAND = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';

/** Slugs as `agy models` lists them. Flash is the cheap one, which is the point of this feature. */
export const AGY_FAST_MODEL = 'gemini-3.8-flash-medium';

/** An MCP server the agent should be able to call during the run. */
export interface McpServerConfig {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
}

export interface AgentRunRequest {
    prompt: string;
    model: string;
    /** Working directory the agent is allowed to read. */
    cwd: string;
    timeoutMs: number;
    mcpServers: readonly McpServerConfig[];
    /** Extra environment for the child, e.g. the scoped token the MCP server reads. */
    env?: Record<string, string>;
    signal?: AbortSignal;
}

export interface AgentRunResult {
    ok: boolean;
    /** The CLI's own final status: SUCCESS, INTERRUPTED, … or a word this runner made up. */
    status: string;
    exitCode: number | null;
    /** The agent's closing message, when it produced one. */
    lastMessage?: string;
    error?: string;
}

export interface AgentRunner {
    readonly id: string;
    /**
     * Undefined when the runner can start. A sentence — including how to install it — when it
     * cannot, so the job can fail fast and say something an operator can act on.
     */
    unavailable(): Promise<string | undefined>;
    run(request: AgentRunRequest, onLine: (line: string) => void): Promise<AgentRunResult>;
}

const CLI_DIRECTORIES = [path.join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

async function executable(candidate: string): Promise<boolean> {
    try {
        await access(candidate, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export async function findAgy(binary?: string): Promise<string | undefined> {
    if (binary) return await executable(binary) ? binary : undefined;
    for (const directory of CLI_DIRECTORIES) {
        const candidate = path.join(directory, 'agy');
        if (await executable(candidate)) return candidate;
    }
    return undefined;
}

/**
 * Translate one `--output-format stream-json` frame into a log line, or undefined for the frames
 * that say nothing worth a line in an execution log. Exported because it is the part worth testing.
 *
 * Frames: {event:'init', init:{model}} · {event:'step_update', step_update:{step_type, state,
 * tool_name, text_delta}} · {event:'result', result:{status, response, error}}.
 */
export function describeFrame(value: unknown): { line?: string; status?: string; response?: string; error?: string } {
    if (!value || typeof value !== 'object') return {};
    const frame = value as Record<string, unknown>;
    const event = String(frame.event ?? '');
    if (event === 'init') {
        const init = (frame.init ?? {}) as Record<string, unknown>;
        return { line: `agent started${init.model ? ` on ${String(init.model)}` : ''}` };
    }
    if (event === 'step_update') {
        const step = (frame.step_update ?? {}) as Record<string, unknown>;
        const type = String(step.step_type ?? '');
        const state = String(step.state ?? '');
        if (type === 'tool') return { line: `agent ${state === 'DONE' ? 'finished' : 'called'} ${String(step.tool_name ?? 'a tool')}` };
        if (type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta.trim()) {
            return { line: `agent: ${step.text_delta.trim()}` };
        }
        if (type === 'error' || state === 'ERROR') {
            const message = String(step.error ?? step.message ?? 'agent step failed');
            return { line: `agent error: ${message}`, error: message };
        }
        return {};
    }
    if (event === 'result') {
        const result = (frame.result ?? {}) as Record<string, unknown>;
        const status = String(result.status ?? 'SUCCESS');
        const response = typeof result.response === 'string' ? result.response : undefined;
        const error = result.error === undefined || result.error === null
            ? undefined
            : String(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
        return { line: `agent finished with ${status}`, status, ...(response ? { response } : {}), ...(error ? { error } : {}) };
    }
    return {};
}

export interface AgyRunnerOptions {
    /** Explicit path to the CLI; otherwise it is looked for in ~/.local/bin and the Homebrew prefixes. */
    binary?: string;
}

/**
 * Never let an API key steer the CLI onto metered billing; the keyring login is the intended path.
 * The Google variables are removed rather than blanked, because an empty value reads as "set".
 */
function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env, ...extra };
    delete environment.GEMINI_API_KEY;
    delete environment.GOOGLE_API_KEY;
    delete environment.GOOGLE_GENAI_USE_VERTEXAI;
    environment.PATH = [...CLI_DIRECTORIES, environment.PATH ?? ''].filter(Boolean).join(':');
    return environment;
}

function runProcess(
    binary: string, args: string[], environment: NodeJS.ProcessEnv, cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(binary, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once('error', (error) => resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }));
        child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
}

/**
 * The Antigravity CLI reads MCP servers from its own config rather than per run, so a server has
 * to be registered before the run and is registered idempotently: `agy mcp list` first, `agy mcp
 * add` only when the entry is missing or points somewhere else.
 */
async function ensureMcpRegistered(
    binary: string, servers: readonly McpServerConfig[], onLine: (line: string) => void,
): Promise<void> {
    for (const server of servers) {
        const listed = await runProcess(binary, ['mcp', 'list'], childEnvironment(), process.cwd());
        const wanted = [server.command, ...server.args].join(' ');
        const line = listed.stdout.split('\n').find((row) => row.trim().startsWith(`${server.name} `) || row.trim().startsWith(`${server.name}\t`));
        if (line?.includes(wanted)) continue;
        const added = await runProcess(binary, ['mcp', 'add', server.name, server.command, ...server.args], childEnvironment(), process.cwd());
        onLine(added.code === 0
            ? `Registered the ${server.name} MCP server with the Antigravity CLI`
            : `Could not register the ${server.name} MCP server: ${(added.stderr || added.stdout).trim().slice(0, 200)}`);
    }
}

export function createAgyRunner(options: AgyRunnerOptions = {}): AgentRunner {
    return {
        id: 'antigravity',
        async unavailable() {
            const binary = await findAgy(options.binary);
            return binary ? undefined
                : `The Antigravity CLI (agy) is not installed. Install it with: ${AGY_INSTALL_COMMAND}`;
        },
        async run(request, onLine) {
            const binary = await findAgy(options.binary);
            if (!binary) {
                return { ok: false, status: 'MISSING_CLI', exitCode: null, error: `agy not found — ${AGY_INSTALL_COMMAND}` };
            }
            const serverEnv: Record<string, string> = {};
            for (const server of request.mcpServers) Object.assign(serverEnv, server.env ?? {});
            try {
                await ensureMcpRegistered(binary, request.mcpServers, onLine);
            } catch (error) {
                onLine(`MCP registration skipped: ${error instanceof Error ? error.message : String(error)}`);
            }
            const minutes = Math.max(2, Math.ceil(request.timeoutMs / 60_000));
            const args = [
                '-p', request.prompt,
                '--output-format', 'stream-json',
                '--dangerously-skip-permissions',
                '--disable-slash-commands',
                '--model', request.model,
                '--print-timeout', `${minutes}m`,
                '--add-dir', request.cwd,
            ];
            const environment = childEnvironment({ ...serverEnv, ...(request.env ?? {}) });
            return await streamAgy(binary, args, environment, request, onLine);
        },
    };
}

function streamAgy(
    binary: string, args: string[], environment: NodeJS.ProcessEnv,
    request: AgentRunRequest, onLine: (line: string) => void,
): Promise<AgentRunResult> {
    return new Promise((resolve) => {
        const child = spawn(binary, args, { cwd: request.cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
        let buffer = '';
        let status: string | undefined;
        let response: string | undefined;
        let hardError: string | undefined;
        const consume = (chunk: string): void => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    // A CLI that decides to print prose on stdout is still worth logging.
                    onLine(line.trim());
                    continue;
                }
                const described = describeFrame(parsed);
                if (described.line) onLine(described.line);
                if (described.status) status = described.status;
                if (described.response) response = described.response;
                if (described.error) hardError ??= described.error;
            }
        };
        child.stdout.on('data', (chunk: Buffer) => consume(chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => {
            for (const line of chunk.toString().split('\n')) {
                const clean = line.trim();
                // agy logs housekeeping to stderr with a misleading ERROR: prefix; only real failures matter.
                if (!clean || /logging before google\.Init/.test(clean)) continue;
                onLine(`agy: ${clean}`);
                if (/authentication|not signed in|sign in|unauthenticated/i.test(clean)) hardError ??= clean.slice(0, 300);
            }
        });
        const stop = (): void => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); };
        request.signal?.addEventListener('abort', stop, { once: true });
        if (request.signal?.aborted) stop();
        // The CLI has its own --print-timeout, but a wedged child would otherwise hold the
        // execution open past its window.
        const timer = setTimeout(() => { hardError ??= 'the agent run exceeded its time limit'; stop(); }, request.timeoutMs + 30_000);
        child.once('error', (error) => {
            clearTimeout(timer);
            resolve({ ok: false, status: 'SPAWN_FAILED', exitCode: null, error: error.message });
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', stop);
            if (buffer.trim()) consume('\n');
            const failed = Boolean(hardError) || code !== 0 || (status !== undefined && status !== 'SUCCESS');
            resolve({
                ok: !failed,
                status: status ?? (failed ? 'FAILED' : 'SUCCESS'),
                exitCode: code,
                ...(response ? { lastMessage: response } : {}),
                ...(failed ? { error: hardError ?? `agy exited with ${code ?? 'no code'}` } : {}),
            });
        });
    });
}

export interface FakeAgentRunnerOptions {
    /** What `unavailable()` reports. Undefined means the fake is installed and ready. */
    unavailable?: string;
    result?: AgentRunResult;
    /** Lines the fake emits, as a real run would stream them. */
    lines?: readonly string[];
    /** Runs before the result is returned — where a test records selectors as the agent would. */
    onRun?(request: AgentRunRequest): Promise<void> | void;
}

/** The runner the calibrate tests drive: no CLI, no network, no phone. */
export function createFakeAgentRunner(options: FakeAgentRunnerOptions = {}): AgentRunner & { requests: AgentRunRequest[] } {
    const requests: AgentRunRequest[] = [];
    return {
        id: 'fake',
        requests,
        async unavailable() { return options.unavailable; },
        async run(request, onLine) {
            requests.push(request);
            for (const line of options.lines ?? []) onLine(line);
            await options.onRun?.(request);
            return options.result ?? { ok: true, status: 'SUCCESS', exitCode: 0 };
        },
    };
}
