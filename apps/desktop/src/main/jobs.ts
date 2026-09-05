import { EventEmitter } from 'node:events';

import { spawnService, type SpawnSpec } from './process.ts';
import type { JobCheck, JobSnapshot, JobState, LogLine, RunHandle } from './types.ts';

const MAX_JOB_LINES = 2_000;

export interface JobDefinition {
    id: string;
    label: string;
    /** Shown above the log: what the operator still has to do by hand. */
    note: string;
    /** Human-readable form of the command, for the job window header. */
    command: string;
    /** Everything that must be true before the job is worth starting. */
    checks(): Promise<JobCheck[]>;
    spawn(): SpawnSpec;
}

interface JobRecord {
    definition: JobDefinition;
    /** Widened so `cancel()` can move a running job aside while `run()` is awaiting it. */
    state: JobState;
    detail: string;
    startedAt: number | null;
    endedAt: number | null;
    exitCode: number | null;
    checks: JobCheck[];
    lines: LogLine[];
    handle: RunHandle | null;
}

export interface JobRunnerOptions {
    now?(): number;
    onLog?(jobId: string, line: LogLine): void;
}

/**
 * One-shot supervised jobs — right now only the WebDriverAgent build.
 *
 * A job is not a service: it is expected to exit, it is never restarted, and its
 * result stays visible in the Services panel until the operator dismisses it.
 * That is why it lives beside the supervisor rather than inside it.
 */
export class JobRunner extends EventEmitter {
    private readonly jobs = new Map<string, JobRecord>();
    private readonly now: () => number;
    private readonly options: JobRunnerOptions;

    constructor(options: JobRunnerOptions = {}) {
        super();
        this.options = options;
        this.now = options.now ?? (() => Date.now());
    }

    list(): JobSnapshot[] {
        return [...this.jobs.keys()].map((id) => this.snapshotOf(id)).filter((job): job is JobSnapshot => job !== null);
    }

    snapshotOf(id: string): JobSnapshot | null {
        const job = this.jobs.get(id);
        if (!job) return null;
        return {
            id,
            label: job.definition.label,
            note: job.definition.note,
            command: job.definition.command,
            state: job.state,
            detail: job.detail,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            exitCode: job.exitCode,
            checks: job.checks,
            lines: job.lines.slice(-400),
            running: job.state === 'running' || job.state === 'checking',
        };
    }

    isRunning(id: string): boolean {
        const state = this.jobs.get(id)?.state;
        return state === 'running' || state === 'checking';
    }

    dismiss(id: string): void {
        if (this.isRunning(id)) return;
        this.jobs.delete(id);
        this.emit('change');
    }

    async cancel(id: string): Promise<void> {
        const job = this.jobs.get(id);
        if (!job?.handle) return;
        job.detail = 'Cancelled.';
        job.state = 'cancelled';
        const handle = job.handle;
        job.handle = null;
        this.emit('change');
        await handle.stop().catch(() => undefined);
    }

    /**
     * Runs `definition` unless it is already running. Re-running replaces the
     * previous result, so the action stays available after a success or a failure.
     */
    async run(definition: JobDefinition): Promise<JobSnapshot | null> {
        if (this.isRunning(definition.id)) return this.snapshotOf(definition.id);
        const job: JobRecord = {
            definition,
            state: 'checking',
            detail: 'Checking the prerequisites…',
            startedAt: this.now(),
            endedAt: null,
            exitCode: null,
            checks: [],
            lines: [],
            handle: null,
        };
        this.jobs.set(definition.id, job);
        this.emit('change');

        job.checks = await definition.checks();
        const blocker = job.checks.find((check) => !check.ok);
        if (blocker) {
            this.settle(job, 'blocked', blocker.detail, null);
            return this.snapshotOf(definition.id);
        }
        if ((job.state as JobState) === 'cancelled') return this.snapshotOf(definition.id);

        job.state = 'running';
        job.detail = 'Running…';
        this.emit('change');

        let handle: RunHandle;
        try {
            handle = spawnService(definition.spawn(), {
                log: (stream, text) => this.append(definition.id, stream, text),
            }, definition.id);
        } catch (error) {
            this.settle(job, 'failed', error instanceof Error ? error.message : String(error), null);
            return this.snapshotOf(definition.id);
        }
        job.handle = handle;
        this.emit('change');

        const code = await handle.exited;
        if ((job.state as JobState) === 'cancelled') {
            job.handle = null;
            job.endedAt = this.now();
            this.emit('change');
            return this.snapshotOf(definition.id);
        }
        job.handle = null;
        if (code === 0) this.settle(job, 'succeeded', 'Finished. Now trust the app on the phone — see the note above.', 0);
        else this.settle(job, 'failed', `Exited with code ${code ?? 'signal'}. The log above says why.`, code);
        return this.snapshotOf(definition.id);
    }

    private settle(job: JobRecord, state: JobState, detail: string, exitCode: number | null): void {
        job.state = state;
        job.detail = detail;
        job.exitCode = exitCode;
        job.endedAt = this.now();
        job.handle = null;
        this.emit('change');
    }

    private append(id: string, stream: LogLine['stream'], text: string): void {
        const job = this.jobs.get(id);
        if (!job) return;
        for (const raw of text.split('\n')) {
            const trimmed = raw.replace(/\s+$/, '');
            if (!trimmed) continue;
            const line: LogLine = { at: this.now(), stream, text: trimmed };
            job.lines.push(line);
            if (job.lines.length > MAX_JOB_LINES) job.lines.shift();
            this.options.onLog?.(id, line);
        }
        this.emit('change');
    }
}
