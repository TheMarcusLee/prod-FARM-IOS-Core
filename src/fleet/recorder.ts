import type { NotificationConfig } from '../notifications/config.js';
import { deliverEvent, shouldNotify, type DeliveryOptions } from '../notifications/deliver.js';
import type { EventInput, EventStore, FarmEvent } from './events.js';

export interface EventRecorder {
    /** Never throws: a failed insert or delivery must not take the scheduler with it. */
    record(input: EventInput): Promise<FarmEvent | null>;
}

export interface RecorderOptions {
    notifications?: NotificationConfig;
    delivery?: DeliveryOptions;
    log?: (message: string) => void;
}

export function createEventRecorder(store: EventStore, options: RecorderOptions = {}): EventRecorder {
    const log = options.log ?? ((message: string) => console.error(message));
    return {
        async record(input) {
            let event: FarmEvent;
            try {
                event = await store.record(input);
            } catch (error) {
                log(`Unable to record ${input.kind} event: ${error instanceof Error ? error.message : String(error)}`);
                return null;
            }
            const config = options.notifications;
            if (config?.channels.length && shouldNotify(event, config)) {
                // Fire and forget — deliveries are retried inside deliverEvent and
                // must never block whatever produced the event.
                void deliverEvent(event, config, options.delivery ?? {}).then((results) => {
                    for (const result of results.filter(({ ok }) => !ok)) {
                        log(`Notification to ${result.channel} failed after ${result.attempts} attempts: ${result.error ?? 'unknown error'}`);
                    }
                }).catch((error: unknown) => log(`Notification delivery crashed: ${String(error)}`));
            }
            return event;
        },
    };
}
