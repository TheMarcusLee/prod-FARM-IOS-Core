import type { SchedulerEventHook, SchedulerLifecycleEvent } from '../scheduler/repository.js';
import type { EventInput, EventSeverity } from './events.js';
import type { EventRecorder } from './recorder.js';

const EXECUTION_SEVERITY: Record<string, EventSeverity> = {
    'execution.started': 'info', 'execution.succeeded': 'info', 'execution.failed': 'error', 'execution.stopped': 'warning',
    'execution.cancelled': 'info',
};

const EXECUTION_VERB: Record<string, string> = {
    'execution.started': 'started', 'execution.succeeded': 'succeeded', 'execution.failed': 'failed', 'execution.stopped': 'was stopped',
    'execution.cancelled': 'was cancelled',
};

/** Turns a scheduler lifecycle signal into the row the fleet timeline stores. */
export function lifecycleEventInput(event: SchedulerLifecycleEvent): EventInput {
    if (event.kind.startsWith('execution.')) {
        const { execution } = event as Extract<SchedulerLifecycleEvent, { execution: unknown }>;
        const task = `${execution.pluginId}/${execution.taskType}@${execution.taskVersion}`;
        return {
            kind: event.kind, severity: EXECUTION_SEVERITY[event.kind] ?? 'info',
            deviceUdid: execution.deviceUdid, executionId: execution.id, scheduleId: execution.scheduleId,
            title: `${task} ${EXECUTION_VERB[event.kind] ?? event.kind} on ${execution.deviceUdid}`,
            detail: {
                task, status: execution.status, scheduledFor: execution.scheduledFor.toISOString(),
                deadlineAt: execution.deadlineAt.toISOString(), exitCode: execution.exitCode,
                ...(execution.error ? { error: execution.error } : {}),
            },
        };
    }
    const { schedule } = event as Extract<SchedulerLifecycleEvent, { schedule: unknown }>;
    const task = `${schedule.pluginId}/${schedule.taskType}@${schedule.taskVersion}`;
    return {
        kind: event.kind, severity: 'info',
        deviceUdid: schedule.deviceUdid, scheduleId: schedule.id,
        title: `${task} schedule ${event.kind.slice('schedule.'.length)} on ${schedule.deviceUdid}`,
        detail: {
            task, status: schedule.status, timing: schedule.timing.kind,
            nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
        },
    };
}

/**
 * pg-boss retries an execution by running the same job again, and the worker
 * calls `startAttempt` on every attempt. Without this the timeline would carry
 * one `execution.started` per attempt — four rows and four push notifications
 * for a task that was only ever launched once. The set is bounded and an id is
 * released as soon as the execution reaches a terminal state.
 */
const STARTED_MEMORY = 2_000;

export function createStartedDeduplicator(limit = STARTED_MEMORY): (event: SchedulerLifecycleEvent) => boolean {
    const started = new Set<string>();
    return (event) => {
        if (!('execution' in event)) return true;
        const { id } = event.execution;
        if (event.kind !== 'execution.started') {
            started.delete(id);
            return true;
        }
        if (started.has(id)) return false;
        // Oldest-first eviction: a Set iterates in insertion order.
        if (started.size >= limit) {
            const oldest = started.values().next().value;
            if (oldest !== undefined) started.delete(oldest);
        }
        started.add(id);
        return true;
    };
}

/**
 * The hook handed to SchedulerRepository. It is called from inside repository
 * transactions, so it must return immediately and must never throw: a malformed
 * lifecycle signal has to lose the timeline row, not the scheduled task.
 */
export function schedulerEventHook(
    recorder: EventRecorder, log: (message: string) => void = (message) => console.error(message),
): SchedulerEventHook {
    const isFirstStart = createStartedDeduplicator();
    return (event) => {
        try {
            if (!isFirstStart(event)) return;
            void recorder.record(lifecycleEventInput(event));
        } catch (error) {
            log(`Unable to map a ${event.kind} lifecycle signal onto an event: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
}
