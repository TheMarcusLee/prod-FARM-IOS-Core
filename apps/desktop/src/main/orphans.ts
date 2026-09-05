import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** One supervised child, as recorded on disk while it runs. */
export interface ChildRecord {
    pid: number;
    /** The service or job the child belongs to, for the log line. */
    label: string;
    /** `ps -o command=` as it looked at spawn time; the guard against pid reuse. */
    command: string;
    startedAt: number;
}

export interface ReapTools {
    /** Is any process running under this pid right now? */
    alive(pid: number): boolean;
    /** The current `ps` command line for a pid, or null when it is gone. */
    commandOf(pid: number): string | null;
    /** SIGTERM, then SIGKILL, the whole process group. */
    kill(pid: number): void;
}

export interface ReapOutcome {
    killed: ChildRecord[];
    /** Records skipped because the pid is gone, or now belongs to something else. */
    skipped: ChildRecord[];
}

/**
 * Kills children left behind by a previous run of the app.
 *
 * The app spawns every service `detached`, in its own process group, so that a
 * clean stop can take down whatever the service itself spawned. The cost of that
 * is that a crash or a force-quit of Electron leaves those groups running: the
 * operator quits a frozen app and the worker keeps posting, the web server keeps
 * holding the port, and the next launch fails on a port clash it cannot explain.
 *
 * The pid file closes that hole. It is deliberately paranoid about pid reuse: a
 * recorded pid is only killed when a process is still running under it *and* its
 * command line is still the one that was recorded, so a pid the OS has since
 * handed to something of the operator's is left alone.
 */
export function reapOrphans(records: readonly ChildRecord[], tools: ReapTools): ReapOutcome {
    const killed: ChildRecord[] = [];
    const skipped: ChildRecord[] = [];
    for (const record of records) {
        if (!Number.isInteger(record.pid) || record.pid <= 1) { skipped.push(record); continue; }
        if (!tools.alive(record.pid) || tools.commandOf(record.pid) !== record.command) {
            skipped.push(record);
            continue;
        }
        tools.kill(record.pid);
        killed.push(record);
    }
    return { killed, skipped };
}

/** Drops anything that is not a well-formed record, so a corrupt file is inert. */
export function parseChildRecords(raw: unknown): ChildRecord[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is ChildRecord => {
        if (!entry || typeof entry !== 'object') return false;
        const record = entry as Record<string, unknown>;
        return typeof record.pid === 'number' && Number.isInteger(record.pid)
            && typeof record.label === 'string'
            && typeof record.command === 'string'
            && typeof record.startedAt === 'number';
    });
}

export const defaultReapTools: ReapTools = {
    alive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            // ESRCH: gone. EPERM: alive, but running as somebody else, so it cannot
            // be a child of ours — either way this app has no business killing it.
            return false;
        }
    },
    commandOf(pid) {
        try {
            return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {
                encoding: 'utf8', timeout: 5_000,
            }).trim() || null;
        } catch {
            return null;
        }
    },
    kill(pid) {
        for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
            try { process.kill(-pid, signal); } catch { /* the group is already gone */ }
        }
    },
};

/**
 * The on-disk list of children this app currently supervises.
 *
 * Every write is synchronous and complete: the file has to be right at the moment
 * the process is killed, which is exactly when no asynchronous flush would run.
 */
export class ChildRegistry {
    readonly file: string;
    private records: ChildRecord[] = [];

    constructor(userDataDir: string, fileName = 'supervised-children.json') {
        this.file = path.join(userDataDir, fileName);
        mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    }

    /** What a previous run left behind. Call before recording anything new. */
    previous(): ChildRecord[] {
        try {
            return parseChildRecords(JSON.parse(readFileSync(this.file, 'utf8')));
        } catch {
            return [];
        }
    }

    /** Kills what the last run left running and clears the file. Returns what died. */
    reapPrevious(tools: ReapTools = defaultReapTools): ChildRecord[] {
        const outcome = reapOrphans(this.previous(), tools);
        this.records = [];
        this.flush();
        return outcome.killed;
    }

    add(pid: number, label: string, tools: Pick<ReapTools, 'commandOf'> = defaultReapTools): void {
        this.records = this.records.filter((record) => record.pid !== pid);
        this.records.push({ pid, label, command: tools.commandOf(pid) ?? '', startedAt: Date.now() });
        this.flush();
    }

    remove(pid: number): void {
        const before = this.records.length;
        this.records = this.records.filter((record) => record.pid !== pid);
        if (this.records.length !== before) this.flush();
    }

    current(): ChildRecord[] {
        return [...this.records];
    }

    /** Called on a clean quit, once every child has been stopped. */
    clear(): void {
        this.records = [];
        this.flush();
    }

    private flush(): void {
        try {
            writeFileSync(this.file, `${JSON.stringify(this.records, null, 2)}\n`, { mode: 0o600 });
        } catch { /* a diagnostic file must never take the app down */ }
    }
}
