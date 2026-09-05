/** Shared vocabulary between the supervisor, the IPC layer and the renderer. */

export type ServiceState =
    | 'stopped'
    | 'starting'
    | 'healthy'
    | 'stopping'
    | 'failed'
    | 'not-configured';

/**
 * One line of a service's log.
 *
 * `command` is the spawn command line this app echoes before it starts a child.
 * It is its own stream rather than an `app` line so the renderer can drop it
 * without reading the text: the live panel has no room for a 200-character
 * Electron path the operator did not type, while the on-disk log — which is what
 * a diagnostics zip carries — keeps it, because "what was actually run" is the
 * first thing a bug report needs.
 */
export interface LogLine {
    at: number;
    stream: 'out' | 'err' | 'app' | 'command';
    text: string;
}

/** What the renderer sees for one service. */
export interface ServiceSnapshot {
    id: string;
    label: string;
    state: ServiceState;
    /** One line of guidance: why it is not configured, or why it failed. */
    detail: string;
    /** Documentation anchor for the "Help" link. */
    help: string | null;
    optional: boolean;
    restarts: number;
    pid: number | null;
    since: number | null;
    logPath: string | null;
    recentLogs: LogLine[];
}

/** `checking` and `running` are the two live states; the rest are results. */
export type JobState = 'checking' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';

/** One precondition of a job, shown whether it passed or not. */
export interface JobCheck {
    label: string;
    ok: boolean;
    detail: string;
}

/** A one-shot supervised job (the WebDriverAgent build), as the renderer sees it. */
export interface JobSnapshot {
    id: string;
    label: string;
    /** The part of the job no software can do for the operator. */
    note: string;
    command: string;
    state: JobState;
    detail: string;
    startedAt: number | null;
    endedAt: number | null;
    exitCode: number | null;
    checks: JobCheck[];
    lines: LogLine[];
    running: boolean;
}

export interface FleetSnapshot {
    services: ServiceSnapshot[];
    /** One-shot jobs, kept until the operator dismisses them. */
    jobs: JobSnapshot[];
    /** http://127.0.0.1:<port> once `web` is healthy, else null. */
    dashboardUrl: string | null;
    shuttingDown: boolean;
}

export type PreflightResult =
    | { ok: true }
    | { ok: false; reason: string; help?: string };

/** A running service, whatever it actually is (child process, embedded server, no-op). */
export interface RunHandle {
    readonly pid: number | null;
    /** Resolves with the exit code (or null when killed by signal) once the run ends. */
    readonly exited: Promise<number | null>;
    stop(): Promise<void>;
}

export interface LaunchContext {
    log(stream: LogLine['stream'], text: string): void;
}

export interface ServiceDefinition {
    id: string;
    label: string;
    /** Docs anchor shown as "Help". */
    help?: string;
    /** Optional services never block dependents and never fail the fleet. */
    optional?: boolean;
    /** A one-shot step (migrations): healthy means "exited 0", not "still running". */
    oneshot?: boolean;
    dependsOn?: readonly string[];
    /** Decides `not-configured` before anything is spawned. */
    preflight?(): Promise<PreflightResult>;
    launch(context: LaunchContext): Promise<RunHandle>;
    /** Resolves true once the service answers. Absent means "running is healthy". */
    health?(): Promise<boolean>;
    /** How long to wait for `health()` before declaring failure. */
    healthTimeoutMs?: number;
    healthIntervalMs?: number;
}
