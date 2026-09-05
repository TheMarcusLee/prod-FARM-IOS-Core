import type { SchedulerEventHook, SchedulerLifecycleEvent } from '../scheduler/repository.js';
import type { EventInput, EventKind, EventSeverity } from './events.js';
import type { EventRecorder } from './recorder.js';

const EXECUTION_SEVERITY: Record<string, EventSeverity> = {
    'execution.started': 'info', 'execution.retried': 'info', 'execution.succeeded': 'info',
    'execution.failed': 'error', 'execution.stopped': 'warning', 'execution.cancelled': 'info',
};

const EXECUTION_VERB: Record<string, string> = {
    'execution.started': 'started', 'execution.retried': 'was retried', 'execution.succeeded': 'succeeded',
    'execution.failed': 'failed', 'execution.stopped': 'was stopped', 'execution.cancelled': 'was cancelled',
};

/** Turns a scheduler lifecycle signal into the row the fleet timeline stores. */
export function lifecycleEventInput(event: SchedulerLifecycleEvent): EventInput {
    if (event.kind.startsWith('execution.')) {
        const { execution, attempt } = event as Extract<SchedulerLifecycleEvent, { execution: unknown }>;
        const task = `${execution.pluginId}/${execution.taskType}@${execution.taskVersion}`;
        // pg-boss retries a job by running it again, so the worker starts an
        // attempt per try. Only the first is a launch; the rest are retries, and
        // saying so is both quieter and more honest than one "started" per try.
        const kind: EventKind = event.kind === 'execution.started' && (attempt ?? 1) > 1
            ? 'execution.retried'
            : event.kind;
        return {
            kind, severity: EXECUTION_SEVERITY[kind] ?? 'info',
            deviceUdid: execution.deviceUdid, executionId: execution.id, scheduleId: execution.scheduleId,
            title: `${task} ${EXECUTION_VERB[kind] ?? kind} on ${execution.deviceUdid}`,
            detail: {
                task, status: execution.status, scheduledFor: execution.scheduledFor.toISOString(),
                deadlineAt: execution.deadlineAt.toISOString(), exitCode: execution.exitCode,
                ...(attempt === undefined ? {} : { attempt }),
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
 * The hook handed to SchedulerRepository. It is called from inside repository
 * transactions, so it must return immediately and must never throw: a malformed
 * lifecycle signal has to lose the timeline row, not the scheduled task.
 */
export function schedulerEventHook(
    recorder: EventRecorder, log: (message: string) => void = (message) => console.error(message),
): SchedulerEventHook {
    return (event) => {
        try {
            void recorder.record(lifecycleEventInput(event));
        } catch (error) {
            log(`Unable to map a ${event.kind} lifecycle signal onto an event: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
}
