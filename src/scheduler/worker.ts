import type { JobWithMetadata } from 'pg-boss';

import { assertDatabaseReady, createDatabaseConnection } from '../database/client.js';
import { createContentStore } from '../content/store.js';
import { startDripPlannerTick } from '../content/runner.js';
import { createEventStore } from '../fleet/events.js';
import { createEventRecorder } from '../fleet/recorder.js';
import { schedulerEventHook } from '../fleet/scheduler-events.js';
import { notificationConfigFromEnv } from '../notifications/config.js';
import { activeDevices, loadRegisteredDevices } from '../devices/registry.js';
import { configuredPluginModules, loadPlugins } from '../loader.js';
import { PluginRegistry } from '../registry.js';
import { executeAutomation } from './executor.js';
import { createQueue, ensureDeviceQueue, type ExecutionJob } from './queue.js';
import { SchedulerRepository, STUCK_EXECUTION_ERROR } from './repository.js';
import { createRunbookPlugin } from '../runbook-plugin.js';
import { createTikTokPlugin } from '../tiktok-plugin.js';

export interface WorkerRuntime { close(): Promise<void> }

/** Stops the plugin process this worker is running for one execution. */
export type StopRunning = () => void;

export interface StuckSweepPorts {
    repository: Pick<SchedulerRepository, 'failStuckExecutions'>;
    /** Executions this process is running, by id. Ones owned by another worker are simply absent. */
    running: ReadonlyMap<string, StopRunning>;
}

/**
 * Gives up on executions that are past their window and — when this worker is
 * the one running it — kills the plugin process, so a wedged phone stops
 * holding a device queue after the row has already been failed.
 */
export async function sweepStuckExecutions(ports: StuckSweepPorts, now = new Date()): Promise<number> {
    const failed = await ports.repository.failStuckExecutions(now);
    for (const execution of failed) ports.running.get(execution.id)?.();
    return failed.length;
}

export async function startWorker(plugins: PluginRegistry): Promise<WorkerRuntime> {
    const connection = createDatabaseConnection();
    await assertDatabaseReady(connection);
    const boss = createQueue();
    await boss.start();
    const repository = new SchedulerRepository(connection, boss, plugins, schedulerEventHook(
        createEventRecorder(createEventStore(connection), { notifications: notificationConfigFromEnv() }),
    ));
    const workingQueues = new Set<string>();
    const running = new Map<string, StopRunning>();

    const registerDeviceWorkers = async (): Promise<void> => {
        for (const device of activeDevices(await loadRegisteredDevices())) {
            const queue = await ensureDeviceQueue(boss, device.udid);
            if (workingQueues.has(queue)) continue;
            await boss.work<ExecutionJob>(queue, { includeMetadata: true }, async ([job]) => {
                if (!job) return;
                const metadata = job as JobWithMetadata<ExecutionJob>;
                const attempt = metadata.retryCount + 1;
                const execution = await repository.startAttempt(job.data.executionId, attempt);
                if (!execution) return;
                // The stuck sweep needs a handle on the run to stop it, so the
                // queue's own signal is forwarded through a controller this
                // process can also abort.
                const controller = new AbortController();
                const forwardAbort = () => controller.abort(job.signal.reason);
                if (job.signal.aborted) forwardAbort();
                else job.signal.addEventListener('abort', forwardAbort, { once: true });
                let timedOut = false;
                running.set(execution.id, () => {
                    timedOut = true;
                    controller.abort(new Error(STUCK_EXECUTION_ERROR));
                });
                let result;
                try {
                    result = await executeAutomation(repository, plugins, execution, attempt, controller.signal);
                } finally {
                    running.delete(execution.id);
                    job.signal.removeEventListener('abort', forwardAbort);
                }
                await repository.finishAttempt(execution.id, attempt, result.exitCode, result.error);
                // The sweep already failed the row; finishing it again would
                // overwrite that with "stopped" and hide why the run ended.
                if (timedOut) return;
                if (result.stopped) {
                    await repository.finishExecution(execution.id, 'stopped', result.exitCode, result.error);
                    return;
                }
                if (!result.error && result.exitCode === 0) {
                    await repository.finishExecution(execution.id, 'succeeded', 0);
                    return;
                }
                const message = result.error ?? 'Automation failed';
                const task = plugins.task({
                    pluginId: execution.pluginId, taskType: execution.taskType,
                    taskVersion: execution.taskVersion, payload: execution.payload,
                });
                const policy = task.retryPolicy(execution.payload);
                if (metadata.retryCount < policy.retryLimit && Date.now() < execution.deadlineAt.getTime()) {
                    await repository.resetForRetry(execution.id, message);
                    throw new Error(message);
                }
                await repository.finishExecution(execution.id, 'failed', result.exitCode, message);
            });
            workingQueues.add(queue);
            console.log(`Worker listening on ${queue} for ${device.name}`);
        }
    };

    await registerDeviceWorkers();
    await repository.reconcileQueueStates();
    await repository.materializeDue();
    const materializeTimer = setInterval(() => void repository.materializeDue().catch(console.error), 5_000);
    const deviceTimer = setInterval(() => void registerDeviceWorkers().catch(console.error), 30_000);
    const cleanupTimer = setInterval(() => {
        void repository.cleanup().catch(console.error);
        void repository.sweepOrphanedAssets().catch(console.error);
    }, 60 * 60_000);
    const reconcileTimer = setInterval(() => void repository.reconcileQueueStates().catch(console.error), 60_000);
    const stuckTimer = setInterval(
        () => void sweepStuckExecutions({ repository, running }).catch(console.error), 60_000,
    );
    // A worker-only deployment has no dashboard replica to tick the drip
    // planner, so the worker ticks it as well. Both paths run the same
    // `runDripPlanner` under the same advisory lock.
    const planner = startDripPlannerTick({ store: createContentStore(connection.db), scheduler: repository });
    return {
        async close() {
            clearInterval(materializeTimer);
            clearInterval(deviceTimer);
            clearInterval(cleanupTimer);
            clearInterval(reconcileTimer);
            clearInterval(stuckTimer);
            planner?.stop();
            await boss.stop({ graceful: true, timeout: 30_000 });
            await connection.close();
        },
    };
}

async function main(): Promise<void> {
    const plugins = new PluginRegistry([
        createTikTokPlugin({ bundleId: process.env.TIKTOK_BUNDLE_ID }),
        createRunbookPlugin(),
        ...await loadPlugins(configuredPluginModules()),
    ]);
    const runtime = await startWorker(plugins);
    const shutdown = async (signal: string) => {
        console.log(`Scheduler worker stopping after ${signal}`);
        await runtime.close();
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) await main();
