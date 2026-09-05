import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createEventStore, type EventStore } from '../../fleet/events.js';
import { attachAckStore, createAckStore, createMemoryAckStore, type EventAckStore } from '../../push/acks.js';
import { tokenIdentity } from '../../push/identity.js';
import {
    createRegistrationStore, isUuid, parseRegistration, serializeRegistration, tokenSuffix,
    type PushRegistrationStore,
} from '../../push/registrations.js';
import type { SchedulerRepository } from '../../scheduler/repository.js';

/** Structurally satisfied by CreateAppOptions, so app.ts passes its own options through. */
export interface PushRouteOptions {
    scheduler: SchedulerRepository;
    /** Test seams. Production leaves every one of these unset. */
    pushRegistrations?: PushRegistrationStore;
    acks?: EventAckStore;
    events?: EventStore;
    now?: () => Date;
}

function unavailable(reply: FastifyReply, what: string): FastifyReply {
    return reply.code(503).send({ error: `${what} is unavailable — the scheduler database is not connected` });
}

function statusOf(error: unknown): number {
    const candidate = (error as { statusCode?: unknown }).statusCode;
    return typeof candidate === 'number' ? candidate : 400;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Push registrations for the companion app, plus per-token event acknowledgement.
 * Both need a database; without one every route answers 503 rather than throwing,
 * matching how the fleet routes behave in a unit-test process.
 */
export async function registerPushRoutes(app: FastifyInstance, options: PushRouteOptions): Promise<void> {
    const clock = options.now ?? (() => new Date());

    let registrations: PushRegistrationStore | null = options.pushRegistrations ?? null;
    const registrationStore = (): PushRegistrationStore | null => {
        if (!registrations && options.scheduler?.connection) registrations = createRegistrationStore(options.scheduler.connection);
        return registrations;
    };

    let acks: EventAckStore | null = options.acks ?? null;
    const ackStore = (): EventAckStore => {
        if (!acks) acks = options.scheduler?.connection ? createAckStore(options.scheduler.connection) : createMemoryAckStore();
        return acks;
    };
    // The fleet routes own GET /api/events; this is how `?acknowledged=false`
    // reaches the caller's mark without widening their options object.
    attachAckStore(app, ackStore());

    let events: EventStore | null = options.events ?? null;
    const eventStore = (): EventStore | null => {
        if (!events && options.scheduler?.connection) events = createEventStore(options.scheduler.connection);
        return events;
    };

    app.post('/api/push/register', async (request: FastifyRequest, reply: FastifyReply) => {
        const store = registrationStore();
        if (!store) return unavailable(reply, 'Push registration');
        let input;
        try {
            input = parseRegistration(request.body, tokenIdentity(request).id);
        } catch (error) {
            return reply.code(statusOf(error)).send({ error: errorMessage(error) });
        }
        const { registration, created } = await store.upsert(input, clock());
        // Never the whole token, in a log or anywhere else.
        request.log.info({ push: registration.name, tokenSuffix: tokenSuffix(registration.expoPushToken) },
            created ? 'push registration created' : 'push registration refreshed');
        return reply.code(created ? 201 : 200).send(serializeRegistration(registration));
    });

    app.get('/api/push/registrations', async (_request, reply) => {
        const store = registrationStore();
        if (!store) return unavailable(reply, 'Push registration');
        const rows = await store.list();
        return { registrations: rows.map(serializeRegistration) };
    });

    app.delete<{ Params: { id: string } }>('/api/push/registrations/:id', async (request, reply) => {
        const store = registrationStore();
        if (!store) return unavailable(reply, 'Push registration');
        if (!isUuid(request.params.id) || !await store.remove(request.params.id)) {
            return reply.code(404).send({ error: 'No such push registration' });
        }
        return reply.code(204).send();
    });

    // The relay's only write-back: an Expo receipt error, kept where the operator
    // can see which phone stopped accepting pushes and why.
    app.post<{ Params: { id: string }; Body: { error?: unknown } }>('/api/push/registrations/:id/error', async (request, reply) => {
        const store = registrationStore();
        if (!store) return unavailable(reply, 'Push registration');
        const detail = typeof request.body?.error === 'string' ? request.body.error.trim().slice(0, 500) : '';
        if (!detail) return reply.code(400).send({ error: 'error must be a non-empty string' });
        if (!isUuid(request.params.id) || !await store.recordError(request.params.id, detail)) {
            return reply.code(404).send({ error: 'No such push registration' });
        }
        return reply.code(204).send();
    });

    app.post<{ Body: { upToId?: unknown } }>('/api/events/ack', async (request, reply) => {
        const store = eventStore();
        if (!store) return unavailable(reply, 'The event log');
        const upToId = Number(request.body?.upToId);
        if (!Number.isFinite(upToId) || upToId < 0) {
            return reply.code(400).send({ error: 'upToId must be an event id' });
        }
        const identity = tokenIdentity(request);
        const before = await ackStore().mark(identity.id);
        const mark = await ackStore().acknowledge(identity.id, Math.floor(upToId), clock());
        const [remaining, previouslyRemaining] = await Promise.all([store.countAfter(mark), store.countAfter(before)]);
        return { acknowledged: Math.max(previouslyRemaining - remaining, 0), unacknowledgedCount: remaining };
    });

    app.get('/api/events/unacknowledged-count', async (request, reply) => {
        const store = eventStore();
        if (!store) return unavailable(reply, 'The event log');
        const mark = await ackStore().mark(tokenIdentity(request).id);
        return { unacknowledgedCount: await store.countAfter(mark), upToId: mark };
    });
}
