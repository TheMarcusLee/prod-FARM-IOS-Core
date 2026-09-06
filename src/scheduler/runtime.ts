import { assertDatabaseReady, createDatabaseConnection } from '../database/client.js';
import { createEventStore } from '../fleet/events.js';
import { createEventRecorder } from '../fleet/recorder.js';
import { schedulerEventHook } from '../fleet/scheduler-events.js';
import { notificationConfigFromEnv } from '../notifications/config.js';
import { createQueue } from './queue.js';
import { SchedulerRepository } from './repository.js';
import type { PluginRegistry } from '../registry.js';

export async function createSchedulerRuntime(plugins: PluginRegistry) {
    const connection = createDatabaseConnection();
    try {
        await assertDatabaseReady(connection);
        const boss = createQueue();
        await boss.start();
        return {
            repository: new SchedulerRepository(connection, boss, plugins, schedulerEventHook(
                createEventRecorder(createEventStore(connection), { notifications: notificationConfigFromEnv() }),
                undefined, plugins,
            )),
            async close() {
                await boss.stop({ graceful: true, timeout: 10_000 });
                await connection.close();
            },
        };
    } catch (error) {
        await connection.close();
        throw error;
    }
}
