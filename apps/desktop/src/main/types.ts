/** Shared vocabulary between the supervisor, the IPC layer and the renderer. */

export type ServiceState =
    | 'stopped'
    | 'starting'
    | 'healthy'
    | 'stopping'
    | 'failed'
    | 'not-configured';

export interface LogLine {
    at: number;
    stream: 'out' | 'err' | 'app';
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

export interface FleetSnapshot {
    services: ServiceSnapshot[];
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
    log(stream: 'out' | 'err' | 'app', text: string): void;
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
