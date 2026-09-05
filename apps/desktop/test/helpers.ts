import type { LaunchContext, RunHandle, ServiceDefinition } from '../src/main/types.ts';
import type { SupervisorClock } from '../src/main/supervisor.ts';

/** A child process stand-in whose exit the test controls. */
export class FakeProcess implements RunHandle {
    pid: number | null = 4242;
    stopped = false;
    private resolveExit!: (code: number | null) => void;
    readonly exited: Promise<number | null>;

    constructor() {
        this.exited = new Promise((resolve) => { this.resolveExit = resolve; });
    }

    /** Simulates the process dying on its own. */
    crash(code = 1): void { this.resolveExit(code); }

    finish(code = 0): void { this.resolveExit(code); }

    async stop(): Promise<void> {
        this.stopped = true;
        this.resolveExit(null);
    }
}

export interface FakeServiceOptions {
    id: string;
    dependsOn?: readonly string[];
    optional?: boolean;
    oneshot?: boolean;
    preflight?: ServiceDefinition['preflight'];
    /** Absent means "no probe", i.e. running counts as healthy. */
    healthy?: () => boolean;
    failLaunch?: string;
}

export interface FakeService {
    definition: ServiceDefinition;
    launches: number;
    processes: FakeProcess[];
    lines: string[];
    current(): FakeProcess | undefined;
}

export function fakeService(options: FakeServiceOptions): FakeService {
    const processes: FakeProcess[] = [];
    const lines: string[] = [];
    const state: FakeService = {
        launches: 0,
        processes,
        lines,
        current: () => processes.at(-1),
        definition: {
            id: options.id,
            label: options.id,
            optional: options.optional,
            oneshot: options.oneshot,
            dependsOn: options.dependsOn,
            preflight: options.preflight,
            healthTimeoutMs: 5_000,
            healthIntervalMs: 10,
            async launch(context: LaunchContext) {
                state.launches += 1;
                if (options.failLaunch) throw new Error(options.failLaunch);
                context.log('out', `${options.id} launched`);
                lines.push('launched');
                const child = new FakeProcess();
                processes.push(child);
                return child;
            },
            ...(options.healthy ? { health: async () => options.healthy!() } : {}),
        },
    };
    return state;
}

/**
 * Virtual clock. Timers fire on the real microtask/macrotask queue so awaits
 * resolve immediately, but the requested delays are recorded so a test can assert
 * the backoff schedule, and `now()` is fully under the test's control.
 */
export class FakeClock implements SupervisorClock {
    time = 0;
    readonly delays: number[] = [];
    private readonly live = new Set<NodeJS.Immediate>();

    now(): number { return this.time; }

    setTimeout(fn: () => void, ms: number): unknown {
        this.delays.push(ms);
        const handle = setImmediate(() => {
            this.live.delete(handle);
            fn();
        });
        this.live.add(handle);
        return handle;
    }

    clearTimeout(handle: unknown): void {
        clearImmediate(handle as NodeJS.Immediate);
        this.live.delete(handle as NodeJS.Immediate);
    }

    /** Backoff delays only (the health-poll sleeps use a different interval). */
    backoffDelays(interval: number): number[] {
        return this.delays.filter((delay) => delay !== interval);
    }
}

/**
 * A clock whose timers only fire when the test says so.
 *
 * `FakeClock` runs every timer on the next tick, which is exactly wrong for the
 * periodic health sweep: it would re-arm itself for ever inside one test.
 */
export class ManualClock implements SupervisorClock {
    time = 0;
    private sequence = 0;
    private readonly timers = new Map<number, { at: number; fn: () => void }>();

    now(): number { return this.time; }

    setTimeout(fn: () => void, ms: number): unknown {
        const handle = (this.sequence += 1);
        this.timers.set(handle, { at: this.time + ms, fn });
        return handle;
    }

    clearTimeout(handle: unknown): void {
        this.timers.delete(handle as number);
    }

    get pending(): number { return this.timers.size; }

    /** Fires everything due within `ms`, letting each callback's promises settle. */
    async advance(ms: number): Promise<void> {
        const target = this.time + ms;
        for (;;) {
            const due = [...this.timers.entries()]
                .filter(([, timer]) => timer.at <= target)
                .sort((left, right) => left[1].at - right[1].at)[0];
            if (!due) break;
            this.timers.delete(due[0]);
            this.time = Math.max(this.time, due[1].at);
            due[1].fn();
            await settle(10);
        }
        this.time = target;
        await settle(10);
    }
}

export function settle(times = 20): Promise<void> {
    let chain = Promise.resolve();
    for (let index = 0; index < times; index += 1) {
        chain = chain.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    return chain;
}
