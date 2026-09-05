import type { FleetSnapshot } from './global.d.ts';

const summary = document.querySelector<HTMLParagraphElement>('#summary');

function render(snapshot: FleetSnapshot): void {
    if (!summary) return;
    const failed = snapshot.services.filter((service) => service.state === 'failed');
    if (failed.length > 0) {
        summary.textContent =
            `${failed.map((service) => service.label).join(', ')} failed — open the Services panel for the log.`;
        return;
    }
    const pending = snapshot.services.filter((service) => service.state === 'starting');
    summary.textContent = pending.length > 0
        ? `Starting ${pending.map((service) => service.label).join(', ')}…`
        : 'Waiting for the dashboard to answer /health.';
}

document.querySelector('#services')?.addEventListener('click', () => { void window.farm.openServices(); });

window.farm.onFleet(render);
void window.farm.getFleet().then(render);
