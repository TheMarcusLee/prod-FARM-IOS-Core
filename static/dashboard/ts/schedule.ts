export {};

/**
 * The Schedule timeline's client half. The server renders the first frame; this script keeps it
 * current — it re-reads `/api/schedule/timeline` every 30 seconds, redraws the lanes and moves the
 * playhead, and turns a click on a clip into a positioned popover with the actions that apply.
 *
 * The markup it produces mirrors `src/schedule/page.ts` element for element. They are two files
 * because the page and the dashboard bundle compile under different tsconfigs, not because they are
 * allowed to disagree; change one and change the other.
 */

interface AccountColour { name: string; fill: string; line: string; ink: string }

interface Clip {
    id: string;
    deviceUdid: string;
    kind: 'execution' | 'plan';
    status: 'planned' | 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'cancelled';
    account: string | null;
    colour: AccountColour;
    startsAt: string;
    endsAt: string;
    time: string;
    title: string;
    summary: string;
    scheduleId: string | null;
    schedulePaused: boolean;
    progress?: number;
    retryOf?: string;
    retriedBy?: string;
    error?: string;
    taskLabel: string;
}

interface Track {
    deviceUdid: string; name: string; slot: string;
    state: 'online' | 'offline' | 'disabled'; accounts: string[]; clips: Clip[];
}

interface Timeline {
    from: string; to: string; now: string; range: string; heading: string;
    ticks: Array<{ at: string; label: string }>;
    accounts: Array<{ account: string; colour: AccountColour }>;
    tracks: Track[];
    counts: { posts: number; accounts: number; needsYou: number };
    recent: Array<{ at: string; time: string; title: string; severity: string; deviceName?: string }>;
    planner: { rules: number; enabled: number; nextRunAt: string | null; warnings: string[] } | null;
}

const REFRESH_MS = 30_000;

const root = document.querySelector<HTMLElement>('#schedule-root');
const scroll = document.querySelector<HTMLElement>('#schedule-timeline');
const heading = document.querySelector<HTMLElement>('#schedule-heading');
const sub = document.querySelector<HTMLElement>('#schedule-sub');
const legend = document.querySelector<HTMLElement>('#schedule-legend');
const recent = document.querySelector<HTMLElement>('#schedule-recent');
const updated = document.querySelector<HTMLElement>('#schedule-updated');
const popover = document.querySelector<HTMLElement>('#schedule-popover');
const picker = document.querySelector<HTMLDialogElement>('#schedule-picker');

/**
 * The `alert` glyph, copied verbatim from `src/ui/icons.ts`. Page scripts compile under
 * tsconfig.web.json and cannot import from `src/`, so this is the one place a glyph is repeated;
 * change it there first and bring the path across.
 */
const ALERT_GLYPH = '<svg class="bl-icon" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M8 2.5l6 11H2z"/><path d="M8 6.5v3M8 11.5h.01"/></svg>';

let current: Timeline | null = null;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function geometry(clip: Clip, from: string, to: string): { left: number; width: number } {
    const start = Date.parse(from);
    const span = Math.max(1, Date.parse(to) - start);
    const left = Math.max(0, Math.min(((Date.parse(clip.startsAt) - start) / span) * 100, 100));
    const width = Math.max(3.2, ((Date.parse(clip.endsAt) - Date.parse(clip.startsAt)) / span) * 100);
    return { left, width: Math.min(width, 100 - left) };
}

function clipNode(clip: Clip, payload: Timeline): HTMLButtonElement {
    const node = element('button', 'bl-clip');
    node.type = 'button';
    if (clip.status === 'failed') node.classList.add('is-failed');
    else if (clip.retryOf) node.classList.add('is-retry');
    if (clip.status === 'succeeded') node.classList.add('is-done');
    if (clip.status === 'running') node.classList.add('is-running');
    if (clip.status === 'planned') node.classList.add('is-planned');
    if (clip.status === 'cancelled' || clip.status === 'stopped') node.classList.add('is-stopped');

    const { left, width } = geometry(clip, payload.from, payload.to);
    node.style.left = `${left.toFixed(3)}%`;
    node.style.width = `${width.toFixed(3)}%`;
    if (clip.status !== 'failed' && !clip.retryOf) {
        node.style.background = clip.colour.fill;
        node.style.borderColor = clip.colour.line;
        node.style.color = clip.colour.ink;
    }
    node.dataset.clip = clip.id;
    node.title = clip.summary;
    if (clip.progress !== undefined) {
        const bar = element('span', 'bl-clip-progress');
        bar.style.width = `${(clip.progress * 100).toFixed(1)}%`;
        node.append(bar);
    }
    if (clip.status === 'failed') {
        node.insertAdjacentHTML('beforeend', ALERT_GLYPH);
        node.append(element('span', undefined, 'failed'));
    } else if (clip.retryOf) {
        node.append(element('span', undefined, `retry ${clip.time}`));
    } else {
        node.append(element('span', undefined, clip.title));
    }
    return node;
}

function render(payload: Timeline): void {
    current = payload;
    if (root) { root.dataset.from = payload.from; root.dataset.to = payload.to; }
    if (heading) heading.textContent = payload.heading;
    if (sub) {
        const { posts, accounts, needsYou } = payload.counts;
        const first = `${posts} ${posts === 1 ? 'post' : 'posts'} across ${accounts} ${accounts === 1 ? 'account' : 'accounts'}`;
        sub.textContent = needsYou ? `${first} · ${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you` : first;
    }
    if (legend) {
        const box = element('div', 'bl-legend');
        for (const entry of payload.accounts) {
            const item = element('span', 'bl-legend-item');
            const swatch = element('span', 'bl-legend-swatch');
            swatch.style.background = entry.colour.fill;
            swatch.style.borderColor = entry.colour.line;
            item.append(swatch, document.createTextNode(entry.account));
            box.append(item);
        }
        legend.replaceChildren(payload.accounts.length ? box : document.createTextNode(''));
    }

    if (scroll) {
        const grid = element('div', 'bl-tl');
        grid.style.setProperty('--bl-tl-step', `${(100 / Math.max(1, payload.ticks.length - 1)).toFixed(4)}%`);
        grid.append(element('div', 'bl-tl-corner'));
        const ruler = element('div', 'bl-tl-ruler');
        for (const tick of payload.ticks) ruler.append(element('span', undefined, tick.label));
        grid.append(ruler);
        // The band the playhead's label is drawn in, so it never sits on an hour mark.
        grid.append(element('div', 'bl-tl-band-corner'), element('div', 'bl-tl-band'));
        for (const track of payload.tracks) {
            const name = element('div', 'bl-tl-track-name');
            name.dataset.state = track.state;
            name.append(element('span', 'bl-tl-slot', track.slot), element('span', 'bl-tl-device', track.name));
            const lane = element('div', 'bl-tl-track bl-tl-lane');
            lane.dataset.device = track.deviceUdid;
            for (const clip of track.clips) lane.append(clipNode(clip, payload));
            grid.append(name, lane);
        }
        if (!payload.tracks.length) {
            const row = element('div', 'bl-tl-empty-row');
            const text = element('p', 'bl-tl-empty', 'No phones are active. ');
            const link = element('a', undefined, 'Register one');
            link.setAttribute('href', '/devices/register');
            text.append(link, document.createTextNode(' and its posts appear here.'));
            row.append(text);
            grid.append(row);
        }
        const overlay = element('div', 'bl-tl-overlay');
        const start = Date.parse(payload.from);
        const span = Math.max(1, Date.parse(payload.to) - start);
        const at = ((Date.now() - start) / span) * 100;
        if (at >= 0 && at <= 100 && payload.tracks.length) {
            const head = element('div', 'bl-playhead');
            head.style.left = `${at.toFixed(3)}%`;
            const stamp = new Date();
            head.append(element('span', 'bl-playhead-label',
                `now ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`));
            overlay.append(head);
        }
        grid.append(overlay);
        scroll.replaceChildren(grid);
    }

    if (recent) {
        if (!payload.recent.length) {
            recent.replaceChildren(element('p', 'bl-empty', 'Nothing has run yet. Schedule a post and it shows up here.'));
        } else {
            const list = element('ul', 'bl-recent');
            for (const event of payload.recent) {
                const row = element('li', `bl-recent-row is-${event.severity}`);
                row.append(element('time', undefined, event.time), element('span', undefined, event.title));
                if (event.deviceName) row.append(element('em', undefined, event.deviceName));
                list.append(row);
            }
            recent.replaceChildren(list);
        }
    }
    if (updated) {
        const stamp = new Date(payload.now);
        updated.textContent = `Updated ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
    }
}

function findClip(id: string): Clip | undefined {
    return current?.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id);
}

function hidePopover(): void {
    if (popover) { popover.hidden = true; popover.replaceChildren(); }
}

async function act(url: string, confirmation?: string): Promise<void> {
    if (confirmation && !window.confirm(confirmation)) return;
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        window.alert(body.error ?? `Request failed (${response.status})`);
        return;
    }
    hidePopover();
    await load();
}

function actionButton(label: string, run: () => Promise<void>, danger = false): HTMLButtonElement {
    const button = element('button', `bl-btn bl-btn-sm${danger ? ' bl-btn-danger' : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', () => {
        button.disabled = true;
        void run().finally(() => { button.disabled = false; });
    });
    return button;
}

function showPopover(clip: Clip, anchor: HTMLElement): void {
    if (!popover || !root) return;
    const track = current?.tracks.find(({ deviceUdid }) => deviceUdid === clip.deviceUdid);
    popover.replaceChildren();
    popover.append(element('h3', undefined, clip.taskLabel));
    popover.append(element('p', 'bl-muted', clip.summary));

    const rows = element('div', 'bl-rows');
    const row = (label: string, value: string) => {
        const line = element('div');
        line.append(element('span', undefined, label), element('span', undefined, value));
        rows.append(line);
    };
    row('Phone', track ? `${track.slot} · ${track.name}` : clip.deviceUdid);
    if (clip.account) row('Account', clip.account);
    row('Starts', new Date(clip.startsAt).toLocaleString());
    row('State', clip.status === 'failed' ? 'needs you' : clip.status);
    if (clip.retryOf) row('Retry of', 'an earlier attempt');
    popover.append(rows);

    const actions = element('div', 'bl-popover-actions');
    if (clip.kind === 'execution' && (clip.status === 'queued' || clip.status === 'running')) {
        actions.append(actionButton('Stop', () => act(`/api/executions/${encodeURIComponent(clip.id)}/stop`)));
    }
    if (clip.kind === 'execution' && (clip.status === 'failed' || clip.status === 'stopped')) {
        actions.append(actionButton('Retry', () => act(`/api/executions/${encodeURIComponent(clip.id)}/retry`,
            'The post may already have reached the app. Retry only after checking the phone.')));
    }
    if (clip.scheduleId) {
        const paused = clip.schedulePaused;
        actions.append(actionButton(paused ? 'Resume schedule' : 'Pause schedule',
            () => act(`/api/schedules/${encodeURIComponent(clip.scheduleId as string)}/${paused ? 'resume' : 'pause'}`)));
    }
    if (clip.kind === 'plan') {
        actions.append(actionButton('Skip', () => act(`/api/content/queue/${encodeURIComponent(clip.id.slice('plan:'.length))}/skip`,
            'Skip this planned post?')));
    }
    const open = element('a', 'bl-btn bl-btn-sm', 'Open device');
    open.href = `/devices/${encodeURIComponent(clip.deviceUdid)}`;
    actions.append(open);
    popover.append(actions);

    // Positioned against the page, not the lane, so a clip near the right edge
    // opens inward instead of off-screen.
    popover.hidden = false;
    const bounds = anchor.getBoundingClientRect();
    const frame = root.getBoundingClientRect();
    const width = popover.offsetWidth;
    const left = Math.min(Math.max(bounds.left - frame.left, 8), Math.max(8, frame.width - width - 8));
    popover.style.left = `${left}px`;
    const below = bounds.bottom - frame.top + 8;
    const fits = below + popover.offsetHeight < frame.height;
    popover.style.top = `${fits ? below : Math.max(8, bounds.top - frame.top - popover.offsetHeight - 8)}px`;
}

document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const clipNodeAt = target?.closest<HTMLElement>('[data-clip]');
    if (clipNodeAt) {
        const clip = findClip(clipNodeAt.dataset.clip ?? '');
        if (clip) showPopover(clip, clipNodeAt);
        return;
    }
    if (target?.closest('#schedule-popover')) return;
    if (target?.closest('#schedule-post')) { picker?.showModal(); return; }
    hidePopover();
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hidePopover();
});

function rangeQuery(): string {
    const range = new URLSearchParams(location.search).get('range');
    return range ? `?range=${encodeURIComponent(range)}` : '';
}

async function load(): Promise<void> {
    try {
        const response = await fetch(`/api/schedule/timeline${rangeQuery()}`, { headers: { accept: 'application/json' } });
        if (!response.ok) return;
        render(await response.json() as Timeline);
    } catch {
        // A refresh that fails leaves the last good frame on screen; the next
        // tick tries again. Blanking the timeline would be worse than stale.
    }
}

void load();
setInterval(() => void load(), REFRESH_MS);
