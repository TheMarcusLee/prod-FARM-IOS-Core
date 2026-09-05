import { EventEmitter } from 'node:events';

import type {
    FleetSnapshot, JobSnapshot, LaunchContext, LogLine, RunHandle,
    ServiceDefinition, ServiceSnapshot, ServiceState,
} from './types.ts';

const MAX_RECENT_LINES = 200;
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_HEALTH_INTERVAL_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
/** A crash after this long counts as a fresh failure, not part of a restart storm. */
const BACKOFF_RESET_MS = 60_000;
/** How often a `healthy` service is asked again whether it is still there. */
export const DEFAULT_REPROBE_INTERVAL_MS = 15_000;
/**
 * Consecutive failed sweeps before a healthy service is torn down and restarted.
 *
 * One failed probe is not evidence of death. A busy farm runs an Appium session
 * per phone and an xcodebuild or two; under that load a 2s HTTP probe times out
 * against a server that is merely slow, and restarting on the strength of it kills
 * the running jobs of every device the service was serving. Three sweeps in a row
 * — 45s of silence at the default interval — is a dead service, not a busy one.
 */
export const DEFAULT_HEALTH_FAILURES = 3;
/**
 * How many automatic restarts a service gets over the whole life of the app.
 *
 * `maxRestarts` is reset by BACKOFF_RESET_MS whenever a service manages to run for
 * a minute, which is right for a flaky child and wrong for a misconfiguration that
 * kills it just after startup every time: that combination would restart for ever.
 */
export const DEFAULT_TOTAL_RESTARTS = 20;

export interface SupervisorClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const realClock: SupervisorClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface SupervisorOptions {
    clock?: SupervisorClock;
    /** Called for every log line, e.g. to append to a file. */
    onLog?(serviceId: string, line: LogLine): void;
    logPathFor?(serviceId: string): string | null;
    /** Cap on automatic restarts before a service is parked in `failed`. */
    maxRestarts?: number;
    /** Lifetime cap on automatic restarts, which no quiet period resets. */
    totalRestarts?: number;
    /** Consecutive failed re-probes before a healthy service is restarted. */
    healthFailuresBeforeRestart?: number;
    /**
     * How often `healthy` services are re-probed. 0 disables the sweep entirely.
     * Defaults to 15s.
     */
    reprobeIntervalMs?: number;
}

interface Runtime {
    definition: ServiceDefinition;
    state: ServiceState;
    detail: string;
    restarts: number;
    since: number | null;
    handle: RunHandle | null;
    recent: LogLine[];
    /** Set while an automatic restart is pending, so stop() can cancel it. */
    backoffTimer: unknown;
    /** Bumped on every start/stop so stale async work can tell it is stale. */
    generation: number;
    /** True while the operator wants this service running. */
    desired: boolean;
    lastExitAt: number;
    /** Automatic restarts since the app started; never reset by a quiet period. */
    totalRestarts: number;
    /** Consecutive failed sweeps while in `healthy`; reset by any success. */
    healthFailures: number;
}

/**
 * Owns the lifecycle of every farm service.
 *
 * Everything the supervisor touches goes through `ServiceDefinition`, so the tests
 * drive it with fake handles and a fake clock and never spawn a real process.
 */
export class Supervisor extends EventEmitter {
    private readonly runtimes = new Map<string, Runtime>();
    private readonly clock: SupervisorClock;
    private readonly options: SupervisorOptions;
    private shuttingDown = false;
    private monitorTimer: unknown = null;
    private sweeping = false;

    constructor(definitions: readonly ServiceDefinition[], options: SupervisorOptions = {}) {
        super();
        this.options = options;
        this.clock = options.clock ?? realClock;
        for (const definition of definitions) {
            this.runtimes.set(definition.id, {
                definition,
                state: 'stopped',
                detail: '',
                restarts: 0,
                since: null,
                handle: null,
                recent: [],
                backoffTimer: null,
                generation: 0,
                desired: false,
                lastExitAt: 0,
                totalRestarts: 0,
                healthFailures: 0,
            });
        }
        assertAcyclic(definitions);
    }

    ids(): string[] {
        return [...this.runtimes.keys()];
    }

    stateOf(id: string): ServiceState {
        return this.runtimeOf(id).state;
    }

    snapshot(dashboardUrl: string | null = null, jobs: JobSnapshot[] = []): FleetSnapshot {
        return {
            services: this.ids().map((id) => this.snapshotOf(id)),
            jobs,
            dashboardUrl,
            shuttingDown: this.shuttingDown,
        };
    }

    snapshotOf(id: string): ServiceSnapshot {
        const runtime = this.runtimeOf(id);
        return {
            id,
            label: runtime.definition.label,
            state: runtime.state,
            detail: runtime.detail,
            help: runtime.definition.help ?? null,
            optional: runtime.definition.optional ?? false,
            restarts: runtime.restarts,
            pid: runtime.handle?.pid ?? null,
            since: runtime.since,
            logPath: this.options.logPathFor?.(id) ?? null,
            recentLogs: runtime.recent.slice(-40),
        };
    }

    recentLogs(id: string): LogLine[] {
        return [...this.runtimeOf(id).recent];
    }

    /** How often the re-probe sweep runs; 0 when it is switched off. */
    get reprobeIntervalMs(): number {
        return this.options.reprobeIntervalMs ?? DEFAULT_REPROBE_INTERVAL_MS;
    }

    /**
     * Re-probes services the supervisor believes are healthy.
     *
     * Long-lived children announce their own death through `handle.exited`, but
     * the bundled Postgres never does: `embedded-postgres` gives no exit signal,
     * so a postmaster that dies on its own would sit in `healthy` for ever. One
     * failed probe is treated exactly like a crash — the handle is stopped and
     * the service goes back through the existing backoff.
     */
    async probeHealthy(): Promise<void> {
        if (this.shuttingDown) return;
        for (const runtime of this.runtimes.values()) {
            if (this.shuttingDown) return;
            const probe = runtime.definition.health;
            if (!probe || runtime.definition.oneshot) continue;
            if (runtime.state !== 'healthy' || !runtime.desired || !runtime.handle) continue;
            const generation = runtime.generation;
            let ok = false;
            try {
                ok = await probe();
            } catch {
                ok = false;
            }
            if (generation !== runtime.generation || runtime.state !== 'healthy') continue;
            if (ok) {
                runtime.healthFailures = 0;
                continue;
            }
            runtime.healthFailures += 1;
            const allowed = this.options.healthFailuresBeforeRestart ?? DEFAULT_HEALTH_FAILURES;
            if (runtime.healthFailures < allowed) {
                this.appendLog(
                    runtime.definition.id, 'app',
                    `health probe did not answer (${runtime.healthFailures}/${allowed}); still treating it as healthy`,
                );
                continue;
            }
            await this.onHealthLost(runtime);
        }
    }

    /** Begin the periodic sweep. Safe to call repeatedly. */
    startHealthMonitor(): void {
        if (this.monitorTimer !== null || this.reprobeIntervalMs <= 0) return;
        this.scheduleSweep();
    }

    stopHealthMonitor(): void {
        if (this.monitorTimer === null) return;
        this.clock.clearTimeout(this.monitorTimer);
        this.monitorTimer = null;
    }

    private scheduleSweep(): void {
        this.monitorTimer = this.clock.setTimeout(() => {
            this.monitorTimer = null;
            if (this.sweeping) { this.scheduleSweep(); return; }
            this.sweeping = true;
            void this.probeHealthy()
                .catch(() => undefined)
                .finally(() => {
                    this.sweeping = false;
                    // Re-armed only after the sweep finishes, so a slow probe can
                    // never stack sweeps on top of each other.
                    if (!this.shuttingDown && this.reprobeIntervalMs > 0) this.scheduleSweep();
                });
        }, this.reprobeIntervalMs);
    }

    private async onHealthLost(runtime: Runtime): Promise<void> {
        runtime.healthFailures = 0;
        const handle = runtime.handle;
        runtime.handle = null;
        // Retire the handle's own exit listener: this path already owns the restart.
        runtime.generation += 1;
        this.appendLog(runtime.definition.id, 'app', 'health probe stopped answering; restarting');
        if (handle) await handle.stop().catch(() => undefined);
        this.onUnexpectedExit(runtime, null, 'stopped answering its health probe');
    }

    /** Stop everything, then bring it all back up. */
    async restartAll(): Promise<void> {
        await this.stopAll();
        await this.startAll();
    }

    /** Start every service in dependency order. Optional failures never abort the run. */
    async startAll(): Promise<void> {
        this.shuttingDown = false;
        for (const id of this.startOrder()) {
            const runtime = this.runtimeOf(id);
            const blocked = this.blockedBy(id);
            if (blocked.length > 0) {
                this.transition(runtime, 'failed', `waiting on ${blocked.join(', ')}`);
                continue;
            }
            try {
                await this.start(id);
            } catch (error) {
                if (!runtime.definition.optional) {
                    this.startHealthMonitor();
                    throw error;
                }
            }
        }
        this.startHealthMonitor();
    }

    /** Stop everything in reverse dependency order; never rejects. */
    async stopAll(): Promise<void> {
        this.stopHealthMonitor();
        this.shuttingDown = true;
        this.emitChange();
        for (const id of this.startOrder().reverse()) {
            try {
                await this.stop(id);
            } catch {
                /* a service that will not die cleanly must not block the rest of shutdown */
            }
        }
        this.shuttingDown = false;
        this.emitChange();
    }

    async start(id: string): Promise<void> {
        const runtime = this.runtimeOf(id);
        runtime.desired = true;
        runtime.restarts = 0;
        // An explicit operator start is a fresh verdict on a service the supervisor
        // had given up on, so the lifetime cap starts again with it.
        runtime.totalRestarts = 0;
        runtime.healthFailures = 0;
        try {
            await this.launch(runtime);
        } finally {
            this.startHealthMonitor();
        }
    }

    async restart(id: string): Promise<void> {
        await this.stop(id);
        await this.start(id);
    }

    async stop(id: string): Promise<void> {
        const runtime = this.runtimeOf(id);
        runtime.desired = false;
        runtime.generation += 1;
        if (runtime.backoffTimer !== null) {
            this.clock.clearTimeout(runtime.backoffTimer);
            runtime.backoffTimer = null;
        }
        const handle = runtime.handle;
        if (!handle) {
            if (runtime.state !== 'not-configured') this.transition(runtime, 'stopped', '');
            return;
        }
        this.transition(runtime, 'stopping', '');
        runtime.handle = null;
        await handle.stop();
        this.transition(runtime, 'stopped', '');
    }

    private async launch(runtime: Runtime): Promise<void> {
        const id = runtime.definition.id;
        if (runtime.handle) return;
        const generation = ++runtime.generation;

        if (runtime.definition.preflight) {
            const verdict = await runtime.definition.preflight();
            if (generation !== runtime.generation) return;
            if (!verdict.ok) {
                runtime.desired = false;
                this.transition(runtime, 'not-configured', verdict.reason);
                return;
            }
        }

        this.transition(runtime, 'starting', '');
        runtime.healthFailures = 0;
        let handle: RunHandle;
        try {
            handle = await runtime.definition.launch(this.launchContext(id));
        } catch (error) {
            this.transition(runtime, 'failed', messageOf(error));
            if (!runtime.definition.optional) throw error;
            return;
        }
        if (generation !== runtime.generation) {
            await handle.stop().catch(() => undefined);
            return;
        }
        runtime.handle = handle;
        runtime.since = this.clock.now();

        // A one-shot step is healthy when it exits 0; a long-lived one when its health
        // probe answers. Both settle before this method resolves, so callers can rely
        // on dependency ordering.
        if (runtime.definition.oneshot) {
            const code = await handle.exited;
            if (generation !== runtime.generation) return;
            runtime.handle = null;
            if (code === 0) {
                this.transition(runtime, 'healthy', '');
            } else {
                this.transition(runtime, 'failed', `exited with code ${code ?? 'signal'}`);
                if (!runtime.definition.optional) throw new Error(`${id} exited with code ${code}`);
            }
            return;
        }

        void handle.exited.then((code) => {
            if (generation !== runtime.generation) return;
            runtime.handle = null;
            this.onUnexpectedExit(runtime, code);
        });

        const ready = await this.awaitHealthy(runtime, generation);
        if (generation !== runtime.generation) return;
        if (!ready) {
            const reason = `did not become healthy within ${this.healthTimeout(runtime)}ms`;
            this.transition(runtime, 'failed', reason);
            if (!runtime.definition.optional) throw new Error(`${id} ${reason}`);
        }
    }

    private async awaitHealthy(runtime: Runtime, generation: number): Promise<boolean> {
        const probe = runtime.definition.health;
        if (!probe) {
            this.transition(runtime, 'healthy', '');
            return true;
        }
        const timeout = this.healthTimeout(runtime);
        const interval = runtime.definition.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
        const deadline = this.clock.now() + timeout;
        for (;;) {
            if (generation !== runtime.generation) return false;
            // A process that already died will never answer the probe.
            if (!runtime.handle) return false;
            let ok = false;
            try {
                ok = await probe();
            } catch {
                ok = false;
            }
            if (generation !== runtime.generation) return false;
            if (ok) {
                this.transition(runtime, 'healthy', '');
                return true;
            }
            if (this.clock.now() >= deadline) return false;
            await this.sleep(interval);
        }
    }

    private onUnexpectedExit(runtime: Runtime, code: number | null, why?: string): void {
        const cause = why ?? `exited with code ${code ?? 'signal'}`;
        if (!runtime.desired || this.shuttingDown) {
            this.transition(runtime, 'stopped', '');
            return;
        }
        // A process that ran happily for a while is not part of a restart storm.
        const now = this.clock.now();
        if (runtime.since !== null && now - runtime.since > BACKOFF_RESET_MS) runtime.restarts = 0;
        runtime.lastExitAt = now;
        const max = this.options.maxRestarts ?? 5;
        const total = this.options.totalRestarts ?? DEFAULT_TOTAL_RESTARTS;
        if (runtime.restarts >= max) {
            this.transition(runtime, 'failed', `${cause}; gave up after ${max} restarts`);
            return;
        }
        if (runtime.totalRestarts >= total) {
            // Restarting on a schedule for ever hides a broken configuration behind a
            // service that looks like it is merely flapping. Stop, and say so.
            this.transition(
                runtime, 'failed',
                `${cause}; gave up after ${total} restarts — this looks like a configuration problem, not a crash`,
            );
            return;
        }
        const delay = backoffMs(runtime.restarts);
        runtime.restarts += 1;
        runtime.totalRestarts += 1;
        this.transition(runtime, 'starting', `${cause}; restarting in ${Math.round(delay / 1000)}s`);
        runtime.backoffTimer = this.clock.setTimeout(() => {
            runtime.backoffTimer = null;
            if (!runtime.desired || this.shuttingDown) return;
            void this.launch(runtime).catch((error: unknown) => {
                this.transition(runtime, 'failed', messageOf(error));
            });
        }, delay);
    }

    private launchContext(id: string): LaunchContext {
        return {
            log: (stream, text) => this.appendLog(id, stream, text),
        };
    }

    private appendLog(id: string, stream: LogLine['stream'], text: string): void {
        const runtime = this.runtimes.get(id);
        if (!runtime) return;
        for (const raw of text.split('\n')) {
            const trimmed = raw.replace(/\s+$/, '');
            if (!trimmed) continue;
            const line: LogLine = { at: this.clock.now(), stream, text: trimmed };
            runtime.recent.push(line);
            if (runtime.recent.length > MAX_RECENT_LINES) runtime.recent.shift();
            this.options.onLog?.(id, line);
        }
        this.emit('log', id);
    }

    private transition(runtime: Runtime, state: ServiceState, detail: string): void {
        if (runtime.state === state && runtime.detail === detail) return;
        runtime.state = state;
        runtime.detail = detail;
        if (state === 'stopped' || state === 'not-configured' || state === 'failed') runtime.since = null;
        this.emitChange();
    }

    private emitChange(): void {
        this.emit('change');
    }

    private healthTimeout(runtime: Runtime): number {
        return runtime.definition.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => { this.clock.setTimeout(resolve, ms); });
    }

    private runtimeOf(id: string): Runtime {
        const runtime = this.runtimes.get(id);
        if (!runtime) throw new Error(`Unknown service ${id}`);
        return runtime;
    }

    definitionOf(id: string): ServiceDefinition {
        return this.runtimeOf(id).definition;
    }

    /** Required dependencies of `id` that are not healthy. Optional ones never block. */
    blockedBy(id: string): string[] {
        const blocked: string[] = [];
        for (const dependency of this.definitionOf(id).dependsOn ?? []) {
            if (!this.runtimes.has(dependency)) continue;
            const state = this.stateOf(dependency);
            if (state === 'healthy') continue;
            if (state === 'not-configured' && (this.definitionOf(dependency).optional ?? false)) continue;
            blocked.push(dependency);
        }
        return blocked;
    }

    /** Topological order over `dependsOn`, stable with respect to declaration order. */
    startOrder(): string[] {
        const order: string[] = [];
        const seen = new Set<string>();
        const visit = (id: string): void => {
            if (seen.has(id)) return;
            seen.add(id);
            for (const dependency of this.runtimeOf(id).definition.dependsOn ?? []) {
                if (this.runtimes.has(dependency)) visit(dependency);
            }
            order.push(id);
        };
        for (const id of this.runtimes.keys()) visit(id);
        return order;
    }
}

export function backoffMs(attempt: number): number {
    return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
}

function assertAcyclic(definitions: readonly ServiceDefinition[]): void {
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    const state = new Map<string, 'open' | 'done'>();
    const visit = (id: string, trail: string[]): void => {
        const seen = state.get(id);
        if (seen === 'done') return;
        if (seen === 'open') throw new Error(`Service dependency cycle: ${[...trail, id].join(' -> ')}`);
        state.set(id, 'open');
        for (const dependency of byId.get(id)?.dependsOn ?? []) {
            if (byId.has(dependency)) visit(dependency, [...trail, id]);
        }
        state.set(id, 'done');
    };
    for (const definition of definitions) visit(definition.id, []);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
