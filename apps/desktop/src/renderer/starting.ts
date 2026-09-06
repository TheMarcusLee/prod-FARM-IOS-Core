import type { FleetSnapshot } from './global.d.ts';
import { icon } from './icons.ts';
import { rigRows } from './rig-model.ts';

const summary = document.querySelector<HTMLElement>('#summary');
const checklist = document.querySelector<HTMLElement>('#checklist');

document.querySelector('#mark')?.append(icon('signal'));

/** The same rows, in the same words, as the Rig window — filling in as they come up. */
function render(snapshot: FleetSnapshot): void {
    if (checklist) {
        checklist.textContent = '';
        for (const row of rigRows(snapshot, null)) {
            // Nothing this app starts, so it says nothing about the rig coming up.
            if (row.id === null) continue;
            const item = document.createElement('li');
            const dot = document.createElement('span');
            dot.className = `bl-dot ${row.tone}`;
            const name = document.createElement('span');
            name.textContent = row.name;
            const state = document.createElement('span');
            state.className = `bl-state ${row.tone}`;
            state.textContent = row.word;
            item.append(dot, name, state);
            checklist.append(item);
        }
    }
    if (!summary) return;
    const failed = snapshot.services.filter((service) => service.state === 'failed');
    if (failed.length > 0) {
        summary.textContent =
            `${failed.map((service) => service.label).join(', ')} failed — open the Rig window for the log.`;
        return;
    }
    const pending = snapshot.services.filter((service) => service.state === 'starting');
    summary.textContent = pending.length > 0
        ? `Starting ${pending.map((service) => service.label).join(', ')}…`
        : 'Waiting for the dashboard to answer.';
}

/**
 * A one-time notice from the launch itself — today only "your old data directory
 * could not be moved". It belongs here because the Starting window is the first
 * thing an operator sees, and because the thing it is about happened before any
 * service existed to carry it.
 */
void window.farm.getStartupNotice().then((notice) => {
    if (!notice) return;
    const root = document.querySelector<HTMLElement>('#notice');
    const title = document.querySelector<HTMLElement>('#notice-title');
    const message = document.querySelector<HTMLElement>('#notice-message');
    if (!root || !title || !message) return;
    title.textContent = notice.title;
    message.textContent = notice.message;
    root.hidden = false;
});

document.querySelector('#services')?.addEventListener('click', () => { void window.farm.openServices(); });

window.farm.onFleet(render);
void window.farm.getFleet().then(render);
