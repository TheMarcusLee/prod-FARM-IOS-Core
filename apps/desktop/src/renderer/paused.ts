import type { FleetSnapshot } from './global.d.ts';

/**
 * Why the farm is not running work right now, in the operator's words.
 *
 * `worker` is the service that actually executes schedules, and it has no health
 * endpoint of its own, so nothing on this page used to distinguish "everything is
 * fine" from "nothing will ever run". A stopped or failed worker is the single
 * most consequential state in the app and it now says so at the top.
 */
export function pausedReason(snapshot: FleetSnapshot): string | null {
    if (snapshot.shuttingDown) return 'The fleet is stopping.';
    const worker = snapshot.services.find((service) => service.id === 'worker');
    if (!worker) return null;
    if (worker.state === 'healthy') return null;
    const because = worker.detail ? ` ${worker.detail}` : '';
    if (worker.state === 'starting') return `The scheduler worker is still starting, so nothing is running yet.${because}`;
    return `The scheduler worker is ${worker.state}, so no schedule will run until it is back.${because}`;
}
