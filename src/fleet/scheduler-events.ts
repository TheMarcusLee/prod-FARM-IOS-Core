import type { TaskDefinition } from '../plugin.js';
import type { TaskEnvelope } from '../types.js';
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

/** A same-site path and nothing else: a fix link is rendered as an anchor on the Alerts page. */
export function safeFixUrl(value: string | undefined): string | undefined {
    return value && /^\/[\w\-./?=&#%]{0,200}$/.test(value) ? value : undefined;
}

/**
 * Turns a scheduler lifecycle signal into the row the fleet timeline stores. `fixUrl` is the
 * plugin's own answer to "where do I go to repair this?", carried on failures only.
 */
export function lifecycleEventInput(event: SchedulerLifecycleEvent, fixUrl?: string): EventInput {
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
                ...(kind === 'execution.failed' && safeFixUrl(fixUrl) ? { fixUrl: safeFixUrl(fixUrl)! } : {}),
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

/** A plugin that has been uninstalled, or a task that offers no repair, simply has no link. */
function fixUrlFor(
    plugins: { task(envelope: TaskEnvelope): TaskDefinition } | null | undefined,
    event: SchedulerLifecycleEvent,
): string | undefined {
    if (!plugins || event.kind !== 'execution.failed') return undefined;
    const { execution } = event as Extract<SchedulerLifecycleEvent, { execution: unknown }>;
    try {
        return plugins.task({
            pluginId: execution.pluginId, taskType: execution.taskType,
            taskVersion: execution.taskVersion, payload: execution.payload,
        }).fixUrl?.(execution.payload);
    } catch {
        return undefined;
    }
}

/**
 * The hook handed to SchedulerRepository. It is called from inside repository
 * transactions, so it must return immediately and must never throw: a malformed
 * lifecycle signal has to lose the timeline row, not the scheduled task.
 */
export function schedulerEventHook(
    recorder: EventRecorder, log: (message: string) => void = (message) => console.error(message),
    plugins?: { task(envelope: TaskEnvelope): TaskDefinition } | null,
): SchedulerEventHook {
    return (event) => {
        try {
            void recorder.record(lifecycleEventInput(event, fixUrlFor(plugins, event)));
        } catch (error) {
            log(`Unable to map a ${event.kind} lifecycle signal onto an event: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
}
