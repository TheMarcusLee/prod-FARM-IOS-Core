import type { FleetSnapshot, ServiceSnapshot } from './global.d.ts';

const list = document.querySelector<HTMLElement>('#list');
const summary = document.querySelector<HTMLElement>('#summary');
/** Keeps one row element per service so log scroll position survives updates. */
const rows = new Map<string, ReturnType<typeof createRow>>();

function stateSummary(services: readonly ServiceSnapshot[]): string {
    const healthy = services.filter((service) => service.state === 'healthy').length;
    const failed = services.filter((service) => service.state === 'failed').length;
    return `${healthy}/${services.length} healthy${failed ? ` · ${failed} failed` : ''}`;
}

function createRow(service: ServiceSnapshot) {
    const root = document.createElement('section');
    root.className = 'service';

    const head = document.createElement('div');
    head.className = 'service-head';

    const dot = document.createElement('span');
    dot.className = 'dot';

    const grow = document.createElement('div');
    grow.className = 'grow';
    const title = document.createElement('h2');
    const detail = document.createElement('div');
    detail.className = 'detail';
    grow.append(title, detail);

    const state = document.createElement('span');
    state.className = 'state';

    const start = button('Start', () => window.farm.startService(service.id));
    const stop = button('Stop', () => window.farm.stopService(service.id));
    const restart = button('Restart', () => window.farm.restartService(service.id));
    const logs = button('Open logs', () => window.farm.openLogs(service.id));

    head.append(dot, grow, state, start, stop, restart, logs);

    const pre = document.createElement('pre');
    pre.className = 'logs';
    root.append(head, pre);

    return { root, dot, title, detail, state, start, stop, restart, pre };
}

function button(label: string, action: () => Promise<unknown>): HTMLButtonElement {
    const element = document.createElement('button');
    element.textContent = label;
    element.addEventListener('click', () => {
        element.disabled = true;
        void action().finally(() => { element.disabled = false; });
    });
    return element;
}

function update(row: ReturnType<typeof createRow>, service: ServiceSnapshot): void {
    row.dot.className = `dot ${service.state}`;
    row.title.textContent = service.label + (service.optional ? ' (optional)' : '');
    row.state.textContent = service.state;
    row.detail.textContent = '';
    if (service.detail) row.detail.append(document.createTextNode(service.detail));
    if (service.restarts > 0) {
        row.detail.append(document.createTextNode(`${service.detail ? ' · ' : ''}${service.restarts} restart(s)`));
    }
    if (service.help) {
        const help = document.createElement('a');
        help.href = '#';
        help.textContent = ' Help';
        help.addEventListener('click', (event) => {
            event.preventDefault();
            void window.farm.openHelp(service.help ?? '');
        });
        row.detail.append(help);
    }
    row.start.disabled = service.state === 'healthy' || service.state === 'starting';
    row.stop.disabled = service.state === 'stopped' || service.state === 'not-configured';
    const stuck = row.pre.scrollTop + row.pre.clientHeight >= row.pre.scrollHeight - 8;
    row.pre.textContent = service.recentLogs.length
        ? service.recentLogs.map((line) => line.text).join('\n')
        : '(no output yet)';
    if (stuck) row.pre.scrollTop = row.pre.scrollHeight;
}

function render(snapshot: FleetSnapshot): void {
    if (!list) return;
    if (summary) summary.textContent = stateSummary(snapshot.services);
    for (const service of snapshot.services) {
        let row = rows.get(service.id);
        if (!row) {
            row = createRow(service);
            rows.set(service.id, row);
            list.append(row.root);
        }
        update(row, service);
    }
}

document.querySelector('#start-all')?.addEventListener('click', () => { void window.farm.startAll(); });
document.querySelector('#stop-all')?.addEventListener('click', () => { void window.farm.stopAll(); });
document.querySelector('#settings')?.addEventListener('click', () => { void window.farm.openSettings(); });

window.farm.onFleet(render);
void window.farm.getFleet().then(render);
