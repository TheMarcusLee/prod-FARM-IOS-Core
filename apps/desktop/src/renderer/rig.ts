import type { FleetSnapshot, Settings } from './global.d.ts';
import { button, createJobCard, type JobCard } from './job-card.ts';
import { icon } from './icons.ts';
import { createLiveLog } from './live-log.ts';
import { headerState, rigRows, type RigRow } from './rig-model.ts';

const list = document.querySelector<HTMLElement>('#list');
const jobList = document.querySelector<HTMLElement>('#jobs');
const actionStatus = document.querySelector<HTMLElement>('#action-status');
const headerDot = document.querySelector<HTMLElement>('#header-dot');
const headerText = document.querySelector<HTMLElement>('#header-text');
const openDashboard = document.querySelector<HTMLButtonElement>('#open-dashboard');
const copyDashboard = document.querySelector<HTMLButtonElement>('#copy-dashboard');

document.querySelector('#mark')?.append(icon('signal'));
document.querySelector('#settings')?.append(icon('gear'));

/** One row element per service, kept so an open menu survives an update. */
const rows = new Map<string, Row>();
/** Job cards persist until the main process drops the job from the snapshot. */
const jobCards = new Map<string, JobCard>();
/** Settings only supply the ports the rows name; the rig works without them. */
let settings: Settings | null = null;

const live = createLiveLog('Worker · live', 'The worker has not said anything yet.');
document.querySelector('#live')?.replaceWith(live.root);

interface Row {
    root: HTMLElement;
    update(model: RigRow): void;
}

/** Closes whatever row menu is open; there is only ever one. */
let closeOpenMenu: (() => void) | null = null;
document.addEventListener('click', () => closeOpenMenu?.());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeOpenMenu?.(); });

/**
 * The row menu. Start, stop, restart and the log files are the whole of what an
 * operator does to one service, and none of it is wanted often enough to spend a
 * button each — so the row stays quiet until the pointer is on it.
 */
function createMenu(model: RigRow): HTMLElement {
    const host = document.createElement('div');
    host.className = 'bl-row-menu';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'bl-btn bl-btn-icon bl-btn-sm bl-btn-quiet';
    trigger.setAttribute('aria-label', `Actions for ${model.name}`);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.append(icon('chevronDown'));

    const menu = document.createElement('div');
    menu.className = 'bl-menu';
    menu.hidden = true;

    const close = (): void => {
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        if (closeOpenMenu === close) closeOpenMenu = null;
    };
    trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        const opening = menu.hidden;
        closeOpenMenu?.();
        if (!opening) return;
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        closeOpenMenu = close;
    });
    menu.addEventListener('click', () => { close(); });

    const id = model.id;
    if (id) {
        menu.append(
            button('Start', () => window.farm.startService(id), ''),
            button('Stop', () => window.farm.stopService(id), ''),
            button('Restart', () => window.farm.restartService(id), ''),
        );
    }
    for (const logId of model.logIds) {
        const label = model.logIds.length > 1 ? `Logs — ${logId}` : 'Logs';
        menu.append(button(label, () => window.farm.openLogs(logId), ''));
    }
    host.append(trigger, menu);
    return host;
}

function createRow(model: RigRow): Row {
    const root = document.createElement('section');
    root.className = 'bl-row';
    const head = document.createElement('div');
    head.className = 'bl-row-head';

    const dot = document.createElement('span');
    const grow = document.createElement('div');
    grow.className = 'bl-row-grow';
    const name = document.createElement('div');
    name.className = 'bl-row-name';
    const detail = document.createElement('div');
    detail.className = 'bl-row-detail';
    grow.append(name, detail);
    const state = document.createElement('span');

    head.append(dot, grow, state);
    // The push relay is not this app's to start or stop, so it gets no menu.
    if (model.id || model.logIds.length > 0) head.append(createMenu(model));
    root.append(head);

    return {
        root,
        update(next) {
            dot.className = `bl-dot ${next.tone}`;
            state.className = `bl-state ${next.tone}`;
            state.textContent = next.word;
            name.textContent = next.name;
            detail.textContent = next.detail;
            detail.title = next.detail;
        },
    };
}

function renderJobs(snapshot: FleetSnapshot): void {
    if (!jobList) return;
    const present = new Set(snapshot.jobs.map((job) => job.id));
    for (const [id, card] of jobCards) {
        if (present.has(id)) continue;
        card.root.remove();
        jobCards.delete(id);
    }
    for (const job of snapshot.jobs) {
        let card = jobCards.get(job.id);
        if (!card) {
            card = createJobCard(job.id, { showOpen: true });
            jobCards.set(job.id, card);
            jobList.append(card.root);
        }
        card.update(job);
    }
}

function report(result: { ok: boolean; message: string }): void {
    if (!actionStatus) return;
    actionStatus.className = `bl-status ${result.ok ? 'ok' : 'error'}`;
    actionStatus.textContent = result.message;
}

function render(snapshot: FleetSnapshot): void {
    const header = headerState(snapshot);
    if (headerDot) headerDot.className = `bl-dot ${header.tone}`;
    if (headerText) {
        headerText.textContent = header.text;
        headerText.title = header.text;
    }
    if (openDashboard) openDashboard.disabled = snapshot.dashboardUrl === null;
    if (copyDashboard) copyDashboard.disabled = snapshot.dashboardUrl === null;

    renderJobs(snapshot);
    live.show(snapshot.services.find((service) => service.id === 'worker')?.recentLogs ?? []);

    if (!list) return;
    for (const model of rigRows(snapshot, settings)) {
        const key = model.id ?? model.name;
        let row = rows.get(key);
        if (!row) {
            row = createRow(model);
            rows.set(key, row);
            list.append(row.root);
        }
        row.update(model);
    }
}

document.querySelector('#settings')?.addEventListener('click', () => { void window.farm.openSettings(); });
document.querySelector('#open-dashboard')?.addEventListener('click', () => { void window.farm.openDashboard(); });
document.querySelector('#restart-all')?.addEventListener('click', () => { void window.farm.restartAll(); });
document.querySelector('#start-all')?.addEventListener('click', () => { void window.farm.startAll(); });
document.querySelector('#stop-all')?.addEventListener('click', () => { void window.farm.stopAll(); });
document.querySelector('#data-folder')?.addEventListener('click', () => { void window.farm.openDataFolder(); });
document.querySelector('#prepare-iphones')?.addEventListener('click', () => {
    if (actionStatus) { actionStatus.className = 'bl-status'; actionStatus.textContent = 'Checking the prerequisites…'; }
    void window.farm.prepareWda(null).then(report);
});
document.querySelector('#copy-dashboard')?.addEventListener('click', () => {
    void window.farm.copyDashboardUrl().then(report);
});
document.querySelector('#copy-mcp')?.addEventListener('click', () => {
    void window.farm.copyMcpConfig().then(report);
});
document.querySelector('#diagnostics')?.addEventListener('click', () => {
    if (actionStatus) { actionStatus.className = 'bl-status'; actionStatus.textContent = 'Collecting…'; }
    void window.farm.exportDiagnostics().then(report);
});

window.farm.onFleet(render);
void window.farm.getFleet().then(render);
// The ports the rows name live in settings, not in the fleet snapshot.
void window.farm.getSettings().then((loaded) => {
    settings = loaded;
    return window.farm.getFleet().then(render);
});
