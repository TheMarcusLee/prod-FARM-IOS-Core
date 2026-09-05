import type { SchedulerEventHook, SchedulerLifecycleEvent } from '../scheduler/repository.js';
import type { EventInput, EventSeverity } from './events.js';
import type { EventRecorder } from './recorder.js';

const EXECUTION_SEVERITY: Record<string, EventSeverity> = {
    'execution.started': 'info', 'execution.succeeded': 'info', 'execution.failed': 'error', 'execution.stopped': 'warning',
};

const EXECUTION_VERB: Record<string, string> = {
    'execution.started': 'started', 'execution.succeeded': 'succeeded', 'execution.failed': 'failed', 'execution.stopped': 'was stopped',
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

/** The hook handed to SchedulerRepository; synchronous and non-blocking by design. */
export function schedulerEventHook(recorder: EventRecorder): SchedulerEventHook {
    return (event) => { void recorder.record(lifecycleEventInput(event)); };
}
