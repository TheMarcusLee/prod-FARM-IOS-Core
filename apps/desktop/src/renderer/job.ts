import type { FleetSnapshot } from './global.d.ts';
import { icon } from './icons.ts';
import { createJobCard } from './job-card.ts';
import { createLiveLog } from './live-log.ts';

/** The window is opened as `job.html#<job id>`. */
const jobId = decodeURIComponent(location.hash.replace(/^#/, '')) || 'wda-prepare';

const host = document.querySelector<HTMLElement>('#host');
const heading = document.querySelector<HTMLElement>('#heading');
document.querySelector('#mark')?.append(icon('signal'));

const card = createJobCard(jobId, { showOpen: false });
const live = createLiveLog('Build output', 'Nothing has been built yet.');
host?.append(card.root, live.root);

const empty = document.createElement('p');
empty.className = 'bl-hint';
empty.textContent = 'This job has been dismissed. Start it again from the Rig window.';
empty.hidden = true;
host?.append(empty);

function render(snapshot: FleetSnapshot): void {
    const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
    card.root.hidden = job === undefined;
    live.root.hidden = job === undefined;
    empty.hidden = job !== undefined;
    if (!job) return;
    if (heading) heading.textContent = job.label;
    document.title = job.label;
    card.update(job);
    live.show(job.lines);
}

document.querySelector('#services')?.addEventListener('click', () => { void window.farm.openServices(); });

window.farm.onFleet(render);
void window.farm.getFleet().then(render);
