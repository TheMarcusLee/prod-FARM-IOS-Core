import type { FleetSnapshot } from './global.d.ts';
import { createJobCard } from './job-card.ts';

/** The window is opened as `job.html#<job id>`. */
const jobId = decodeURIComponent(location.hash.replace(/^#/, '')) || 'wda-prepare';

const host = document.querySelector<HTMLElement>('#host');
const heading = document.querySelector<HTMLElement>('#heading');
const card = createJobCard(jobId, { showLogs: true });
host?.append(card.root);

const empty = document.createElement('p');
empty.className = 'hint';
empty.textContent = 'This job has been dismissed. Start it again from the Services panel.';
empty.hidden = true;
host?.append(empty);

function render(snapshot: FleetSnapshot): void {
    const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
    card.root.hidden = job === undefined;
    empty.hidden = job !== undefined;
    if (!job) return;
    if (heading) heading.textContent = job.label;
    document.title = `${job.label} — ${job.state}`;
    card.update(job);
}

document.querySelector('#services')?.addEventListener('click', () => { void window.farm.openServices(); });

window.farm.onFleet(render);
void window.farm.getFleet().then(render);
