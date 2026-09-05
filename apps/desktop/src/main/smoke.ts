import type { Supervisor } from './supervisor.ts';

/**
 * Headless self-check: bring the fleet up, print the service table as JSON and exit.
 * Exit code 0 means every non-optional service is healthy.
 */
export async function runSmoke(supervisor: Supervisor, dashboardUrl: string | null): Promise<number> {
    let failure: string | null = null;
    try {
        await supervisor.startAll();
    } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
    }
    const webHealthy = supervisor.stateOf('web') === 'healthy';
    const snapshot = supervisor.snapshot(webHealthy ? dashboardUrl : null);
    const required = snapshot.services.filter((service) => !service.optional);
    const ok = failure === null && required.every((service) => service.state === 'healthy');
    process.stdout.write(`${JSON.stringify({
        ok,
        failure,
        dashboardUrl: snapshot.dashboardUrl,
        services: snapshot.services.map((service) => ({
            id: service.id,
            state: service.state,
            optional: service.optional,
            detail: service.detail,
            lastLog: service.recentLogs.at(-1)?.text ?? null,
        })),
    }, null, 2)}\n`);
    return ok ? 0 : 1;
}
