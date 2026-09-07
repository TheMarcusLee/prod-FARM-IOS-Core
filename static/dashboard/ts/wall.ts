/**
 * The Control Center: the wall of live phone screens, its filters, its selection and its
 * inspector. Server-rendered markup, no framework. See docs/design/backline.md.
 */
import {
    FramePump, TILE_SIZES, TILE_SIZE_LABELS, all, devicePoint, errorMessage, pick,
    remember, remembered, remoteAction, request, screenInfo, send,
    type RemoteAction, type ScreenInfo,
} from './shell.js';
import {
    LivePlayer, MAX_SOCKET_FAILURES, STILLS_FPS, VIEW_MODE_LABELS, chooseMode, hasWebCodecs,
    liveVideoAvailable, orientedScreen, viewMode, type ViewMode,
} from './live.js';

interface Tile {
    element: HTMLElement;
    udid: string;
    slot: string;
    name: string;
    platform: string;
    link: string;
    tags: string[];
    checkbox: HTMLInputElement | null;
    pump: FramePump | null;
    image: HTMLImageElement | null;
    canvas: HTMLCanvasElement | null;
    player: LivePlayer | null;
    /** Sockets this tile has lost; two and it stays on stills. */
    failures: number;
    visible: boolean;
}

const wall = pick<HTMLElement>('#wall');
const filters = pick<HTMLElement>('#wall-filters');
const selectionLabel = pick<HTMLElement>('#wall-selection');

const tiles: Tile[] = all<HTMLElement>('[data-tile]').map((element, index, list) => {
    const image = pick<HTMLImageElement>('[data-frame]', element);
    const udid = element.dataset.udid ?? '';
    const platform = element.dataset.platform ?? 'android';
    return {
        element, udid, platform,
        slot: element.dataset.slot ?? '',
        name: pick<HTMLElement>('.bl-tile-name', element)?.textContent ?? udid,
        link: element.dataset.link ?? 'usb',
        tags: (element.dataset.tags ?? '').split(',').filter(Boolean),
        checkbox: pick<HTMLInputElement>('[data-select]', element),
        pump: image ? new FramePump(image, udid, platform, index / Math.max(list.length, 1)) : null,
        image,
        canvas: pick<HTMLCanvasElement>('[data-canvas]', element),
        player: null,
        failures: 0,
        visible: false,
    };
});

const byUdid = new Map(tiles.map((tile) => [tile.udid, tile]));

/* ---- filters and sliders ---------------------------------------------- */

let link = remembered('wall.link') ?? 'all';
let group = remembered('wall.group') ?? '';

function matches(tile: Tile): boolean {
    if (group && !tile.tags.includes(group)) return false;
    if (link === 'usb') return tile.link === 'usb' && tile.platform === 'android';
    if (link === 'wifi') return tile.link === 'wifi';
    if (link === 'ios') return tile.platform === 'ios';
    return true;
}

function applyFilters(): void {
    for (const tile of tiles) {
        const shown = matches(tile);
        tile.element.hidden = !shown;
        if (!shown) {
            tile.pump?.stop();
            tile.player?.stop();
            if (tile.checkbox) tile.checkbox.checked = false;
        }
    }
    for (const button of all<HTMLButtonElement>('[data-link-filter]')) {
        button.setAttribute('aria-pressed', String(button.dataset.linkFilter === link));
    }
    for (const chip of all<HTMLButtonElement>('[data-group]')) {
        chip.setAttribute('aria-pressed', String((chip.dataset.group ?? '') === group));
    }
    countSelection();
    refreshFrames();
}

filters?.addEventListener('click', (event) => {
    const linkButton = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-link-filter]');
    if (linkButton) {
        link = linkButton.dataset.linkFilter ?? 'all';
        remember('wall.link', link);
        applyFilters();
        return;
    }
    const chip = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-group]');
    if (chip) {
        group = chip.dataset.group ?? '';
        remember('wall.group', group);
        applyFilters();
        return;
    }
    const pickButton = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-pick]');
    if (pickButton) select(pickButton.dataset.pick ?? '');
});

const sizeSlider = pick<HTMLInputElement>('#wall-size');
const sizeValue = pick<HTMLElement>('#wall-size-value');
const qualitySlider = pick<HTMLInputElement>('#wall-quality');
const qualityValue = pick<HTMLElement>('#wall-quality-value');

function applySize(): void {
    const notch = Number(sizeSlider?.value ?? 1);
    const size = TILE_SIZES[notch] ?? TILE_SIZES[1]!;
    wall?.style.setProperty('--bl-tile', `${size}px`);
    if (sizeValue) sizeValue.textContent = TILE_SIZE_LABELS[notch] ?? 'M';
}

/** Off, stills or live — what the operator asked the wall for. */
function preference(): ViewMode {
    return viewMode(Number(qualitySlider?.value ?? 2));
}

function applyQuality(): void {
    const wanted = preference();
    if (qualityValue) qualityValue.textContent = VIEW_MODE_LABELS[wanted];
    // Moving the slider to Live is a fresh request: sockets that failed earlier are forgiven.
    if (wanted === 'live') {
        for (const tile of tiles) { tile.failures = 0; tile.player?.reset(); }
        inspectorFailures = 0;
        inspectorPlayer?.reset();
    }
    for (const tile of tiles) tile.pump?.setRate(STILLS_FPS);
    refreshFrames();
    bindInspectorFrames();
}

sizeSlider?.addEventListener('input', () => { applySize(); remember('tileSize', sizeSlider.value); });
qualitySlider?.addEventListener('input', () => { applyQuality(); remember('tileQuality', qualitySlider.value); });

/* ---- live frames ------------------------------------------------------ */

/** Whether this farm has scrcpy at all; until the answer is in, the wall shows stills. */
let liveServer = false;
void liveVideoAvailable().then((available) => {
    liveServer = available;
    refreshFrames();
    bindInspectorFrames();
});

function modeFor(platform: string, failures: number): ViewMode {
    return chooseMode({
        preference: preference(), webCodecs: hasWebCodecs(), serverAvailable: liveServer,
        socketFailures: failures, platform,
    });
}

/** The still image is what the tile shows until a picture has actually been decoded. */
function showStills(tile: Tile): void {
    if (tile.canvas) tile.canvas.hidden = true;
    if (tile.image) tile.image.hidden = false;
}

function tilePlayer(tile: Tile): LivePlayer | null {
    if (!tile.canvas) return null;
    tile.player ??= new LivePlayer({
        canvas: tile.canvas, udid: tile.udid, profile: 'wall',
        onFallback() {
            tile.failures = MAX_SOCKET_FAILURES;
            showStills(tile);
            refreshFrames();
        },
        onPainted() {
            if (tile.canvas) tile.canvas.hidden = false;
            if (tile.image) tile.image.hidden = true;
        },
    });
    return tile.player;
}

function refreshFrames(): void {
    const hidden = document.hidden;
    for (const tile of tiles) {
        const off = hidden || tile.element.hidden || !tile.visible;
        const wanted = off ? 'off' : modeFor(tile.platform, tile.failures);
        if (wanted === 'live') {
            const player = tilePlayer(tile);
            if (player) {
                tile.pump?.stop();
                player.start();
                continue;
            }
        }
        tile.player?.stop();
        // "Off" holds whatever the tile is showing, live picture included; only stills needs the
        // image back in front of the canvas.
        if (wanted === 'stills') {
            showStills(tile);
            tile.pump?.start();
        } else {
            tile.pump?.stop();
        }
    }
}

const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        const tile = tiles.find(({ element }) => element === entry.target);
        if (tile) tile.visible = entry.isIntersecting;
    }
    refreshFrames();
}, { rootMargin: '160px' });
for (const tile of tiles) observer.observe(tile.element);
document.addEventListener('visibilitychange', () => {
    refreshFrames();
    bindInspectorFrames();
});

/* ---- selection -------------------------------------------------------- */

function selected(): Tile[] {
    return tiles.filter((tile) => !tile.element.hidden && tile.checkbox?.checked);
}

function countSelection(): void {
    const count = selected().length;
    if (selectionLabel) selectionLabel.textContent = `${count} selected`;
    remember('wall.selection', selected().map(({ udid }) => udid).join(','));
}

for (const tile of tiles) {
    tile.checkbox?.addEventListener('change', countSelection);
    tile.element.addEventListener('click', (event) => {
        if ((event.target as Element | null)?.closest('.bl-check')) return;
        select(tile.udid);
    });
    tile.element.addEventListener('dblclick', () => {
        window.location.assign(`/devices/${encodeURIComponent(tile.udid)}`);
    });
}

/* ---- the inspector ---------------------------------------------------- */

let inspectorPump: FramePump | null = null;
let inspectorPlayer: LivePlayer | null = null;
let inspectorFailures = 0;
let inspectorViewer: HTMLElement | null = null;
let inspectorScreen: ScreenInfo | undefined;
let inspectorUdid = pick<HTMLElement>('#inspector')?.dataset.udid ?? '';

function markSelected(udid: string): void {
    for (const tile of tiles) tile.element.classList.toggle('is-selected', tile.udid === udid);
    for (const button of all<HTMLButtonElement>('[data-pick]')) {
        button.setAttribute('aria-pressed', String(button.dataset.pick === udid));
    }
}

async function select(udid: string): Promise<void> {
    if (!udid || udid === inspectorUdid) {
        markSelected(udid);
        return;
    }
    inspectorUdid = udid;
    remember('wall.focus', udid);
    markSelected(udid);
    const holder = pick<HTMLElement>('#inspector');
    if (!holder) return;
    try {
        const markup = await fetch(`/api/fragments/inspector/${encodeURIComponent(udid)}`).then((r) => r.text());
        holder.outerHTML = markup;
        window.htmx?.process(pick<HTMLElement>('#inspector') ?? document.body);
        bindInspector();
    } catch (error) {
        holder.textContent = errorMessage(error);
    }
}

/**
 * The inspector is the one place that is worth a real stream: it is large, it is the thing being
 * driven, and there is only ever one of it. Live when the farm can, four stills a second when not.
 */
function bindInspectorFrames(): void {
    const viewer = inspectorViewer;
    if (!viewer || viewer.dataset.live !== '1') return;
    const udid = viewer.dataset.udid ?? '';
    const platform = viewer.dataset.platform ?? 'android';
    const image = pick<HTMLImageElement>('[data-frame]', viewer);
    const canvas = pick<HTMLCanvasElement>('[data-canvas]', viewer);
    const wanted = document.hidden ? 'off' : modeFor(platform, inspectorFailures);
    if (wanted === 'live' && canvas) {
        inspectorPump?.stop();
        inspectorPlayer ??= new LivePlayer({
            canvas, udid, profile: 'viewer',
            onFallback() {
                inspectorFailures = MAX_SOCKET_FAILURES;
                inspectorPlayer = null;
                canvas.hidden = true;
                if (image) image.hidden = false;
                bindInspectorFrames();
            },
            onPainted() {
                canvas.hidden = false;
                if (image) image.hidden = true;
            },
        });
        inspectorPlayer.start();
        return;
    }
    inspectorPlayer?.stop();
    if (wanted === 'off') {
        inspectorPump?.stop();
        return;
    }
    if (canvas) canvas.hidden = true;
    if (image) image.hidden = false;
    if (!image) return;
    inspectorPump ??= new FramePump(image, udid, platform);
    inspectorPump.setRate(4);
    inspectorPump.start();
}

function bindInspector(): void {
    inspectorPump?.stop();
    inspectorPump = null;
    inspectorPlayer?.stop();
    inspectorPlayer = null;
    inspectorFailures = 0;
    inspectorScreen = undefined;
    const viewer = pick<HTMLElement>('[data-viewer]');
    inspectorViewer = viewer;
    if (!viewer) return;
    const udid = viewer.dataset.udid ?? '';
    if (viewer.dataset.live === '1') {
        bindInspectorFrames();
        void screenInfo(udid).then((info) => { inspectorScreen = info; });
    }
    bindViewerInput(viewer, udid);
    // Selecting another phone re-renders the inspector; a recording that is still open puts its
    // bar and its sentences back rather than quietly vanishing.
    if (recording?.udid === udid) void showNarration(recording.runbookId);
    for (const button of all<HTMLButtonElement>('[data-hw]')) {
        button.addEventListener('click', () => void hardware(udid, button.dataset.hw ?? ''));
    }
    const stop = pick<HTMLButtonElement>('[data-inspector-stop]');
    stop?.addEventListener('click', () => {
        stop.disabled = true;
        void send(`/api/executions/${stop.dataset.inspectorStop}/stop`, {})
            .catch((error: unknown) => window.alert(errorMessage(error)))
            .finally(() => { stop.disabled = false; });
    });
}

/* ---- recording from the inspector ------------------------------------- */

/**
 * "Record what I do next": one press creates a runbook on this phone and starts recording into it.
 * While it is open, every remote action this page performs is also written down as a step, and the
 * sentences it becomes appear under the viewer. Naming happens at the end, not the beginning.
 */
let recording: { runbookId: string; udid: string } | undefined;

async function recordStep(udid: string, action: RemoteAction): Promise<void> {
    if (!recording || recording.udid !== udid) return;
    try {
        await send(`/api/runbooks/${encodeURIComponent(recording.runbookId)}/steps`, { action });
    } catch {
        // A recorder problem must never break remote control.
    }
}

function recordingBar(): HTMLElement | null {
    return pick<HTMLElement>('#inspector-recording');
}

async function showNarration(runbookId: string): Promise<void> {
    const holder = recordingBar();
    if (!holder) return;
    const done = '<div class="bl-rb-banner"><span class="bl-rec-dot"></span><span>Recording. Everything you do here is written down.</span>'
        + '<button type="button" class="bl-btn bl-btn-danger bl-btn-sm" data-record-done>Done</button></div>';
    const story = await fetch(`/plugins/com.farm.runbook/runbooks/${encodeURIComponent(runbookId)}/story`)
        .then((response) => response.text()).catch(() => '');
    holder.innerHTML = done + story;
    holder.hidden = false;
    window.htmx?.process(holder);
}

async function startRecording(udid: string): Promise<void> {
    const started = await request<{ runbookId: string; device: string }>('/api/runbooks/record/here', {
        method: 'POST', body: JSON.stringify({ udid }),
    });
    recording = { runbookId: started.runbookId, udid };
    report(`Recording on ${started.device}`);
    await showNarration(started.runbookId);
}

/** Done stops the recording and asks the only two questions a runbook has. */
async function finishRecording(): Promise<void> {
    const open = recording;
    if (!open) return;
    recording = undefined;
    const holder = recordingBar();
    if (holder) {
        holder.hidden = true;
        holder.innerHTML = '';
    }
    await send(`/api/runbooks/${encodeURIComponent(open.runbookId)}/record/stop`, {});
    const answers = await ask('Name this runbook', [
        { name: 'name', label: 'What is it called?', type: 'text' },
        { name: 'description', label: 'What is it for? (optional)', type: 'text' },
    ], 'Save');
    if (!answers?.values.name) {
        report('Recorded, unnamed — name it on its page.');
        return;
    }
    await request(`/api/runbooks/${encodeURIComponent(open.runbookId)}/name`, {
        method: 'POST',
        body: JSON.stringify({ name: answers.values.name, description: answers.values.description ?? '' }),
    });
    window.location.assign(`/runbooks/${encodeURIComponent(open.runbookId)}`);
}

document.addEventListener('click', (event) => {
    const start = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-record-runbook]');
    if (start) {
        start.disabled = true;
        void startRecording(start.dataset.recordRunbook ?? '')
            .catch((error: unknown) => report(errorMessage(error)))
            .finally(() => { start.disabled = false; });
        return;
    }
    if ((event.target as Element | null)?.closest('[data-record-done]')) {
        void finishRecording().catch((error: unknown) => report(errorMessage(error)));
    }
});

/** Click to tap, drag to swipe — mapped into the phone's own coordinate space. */
export function bindViewerInput(viewer: HTMLElement, udid: string): void {
    let start: { x: number; y: number; at: number } | undefined;
    // A live stream reports the size it is really encoding, which is the one that says which way
    // up the phone is; the cached screen size only says how big it is.
    const mapped = (): ScreenInfo | undefined =>
        (inspectorScreen ? orientedScreen(inspectorScreen, inspectorPlayer?.size()) : undefined);
    viewer.addEventListener('pointerdown', (event) => {
        const screen = mapped();
        if (!screen) return;
        const point = devicePoint(viewer, screen, event);
        start = { ...point, at: Date.now() };
    });
    viewer.addEventListener('pointerup', (event) => {
        const screen = mapped();
        if (!screen || !start) return;
        const end = devicePoint(viewer, screen, event);
        const moved = Math.hypot(end.x - start.x, end.y - start.y);
        const action: RemoteAction = moved < 12
            ? { type: 'tap', x: end.x, y: end.y }
            : {
                type: 'swipe', startX: start.x, startY: start.y, endX: end.x, endY: end.y,
                durationMs: Math.max(80, Math.min(1200, Date.now() - start.at)),
            };
        start = undefined;
        void remoteAction(udid, action)
            .then(() => recordStep(udid, action))
            .catch((error: unknown) => window.alert(errorMessage(error)));
    });
}

async function hardware(udid: string, key: string): Promise<void> {
    try {
        if (key === 'screenshot') {
            window.open(`/api/devices/${encodeURIComponent(udid)}/remote/screenshot`, '_blank', 'noopener');
            return;
        }
        if (key === 'text') {
            const text = window.prompt('Text to type on this phone');
            if (!text) return;
            await remoteAction(udid, { type: 'text', text });
            await recordStep(udid, { type: 'text', text } as RemoteAction);
            return;
        }
        await remoteAction(udid, { type: key as 'home' });
        await recordStep(udid, { type: key } as RemoteAction);
    } catch (error) {
        window.alert(errorMessage(error));
    }
}

/* ---- keyboard --------------------------------------------------------- */

document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (pick('dialog[open]')) return;
    const visible = tiles.filter((tile) => !tile.element.hidden);
    if (!visible.length) return;
    const index = Math.max(0, visible.findIndex(({ udid }) => udid === inspectorUdid));
    const columns = Math.max(1, Math.round((wall?.clientWidth ?? 800) / (visible[0]!.element.clientWidth || 180)));
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = index + 1;
    else if (event.key === 'ArrowLeft') next = index - 1;
    else if (event.key === 'ArrowDown') next = index + columns;
    else if (event.key === 'ArrowUp') next = index - columns;
    else if (event.key === ' ') {
        const tile = visible[index];
        if (tile?.checkbox) {
            event.preventDefault();
            tile.checkbox.checked = !tile.checkbox.checked;
            countSelection();
        }
        return;
    } else if (event.key === 'Enter') {
        event.preventDefault();
        window.location.assign(`/devices/${encodeURIComponent(visible[index]!.udid)}`);
        return;
    } else return;
    event.preventDefault();
    const tile = visible[Math.max(0, Math.min(visible.length - 1, next))];
    if (!tile) return;
    tile.element.focus();
    void select(tile.udid);
});

/* ---- dialogs ---------------------------------------------------------- */

interface Field {
    name: string;
    label: string;
    type: 'text' | 'number' | 'datetime-local' | 'select' | 'file';
    value?: string;
    options?: Array<[string, string]>;
    accept?: string;
    multiple?: boolean;
    min?: string;
    max?: string;
}

interface Answers {
    values: Record<string, string>;
    files: File[];
}

function ask(title: string, fields: Field[], submitLabel: string): Promise<Answers | null> {
    return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.className = 'bl-dialog';
        const form = document.createElement('form');
        form.method = 'dialog';
        const head = document.createElement('div');
        head.className = 'bl-dialog-head';
        head.textContent = title;
        const body = document.createElement('div');
        body.className = 'bl-dialog-body';
        const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
        for (const field of fields) {
            const label = document.createElement('label');
            label.className = 'bl-field';
            const caption = document.createElement('span');
            caption.textContent = field.label;
            let input: HTMLInputElement | HTMLSelectElement;
            if (field.type === 'select') {
                const select = document.createElement('select');
                select.className = 'bl-select';
                for (const [value, text] of field.options ?? []) select.add(new Option(text, value));
                input = select;
            } else {
                const box = document.createElement('input');
                box.className = 'bl-input';
                box.type = field.type;
                if (field.accept) box.accept = field.accept;
                if (field.multiple) box.multiple = true;
                if (field.min) box.min = field.min;
                if (field.max) box.max = field.max;
                input = box;
            }
            if (field.value !== undefined) input.value = field.value;
            inputs.set(field.name, input);
            label.append(caption, input);
            body.append(label);
        }
        const actions = document.createElement('div');
        actions.className = 'bl-btn-row';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'bl-btn';
        cancel.textContent = 'Cancel';
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.className = 'bl-btn bl-btn-primary';
        submit.textContent = submitLabel;
        actions.append(cancel, submit);
        body.append(actions);
        form.append(head, body);
        dialog.append(form);
        document.body.append(dialog);
        const finish = (answers: Answers | null) => {
            dialog.close();
            dialog.remove();
            resolve(answers);
        };
        cancel.addEventListener('click', () => finish(null));
        dialog.addEventListener('cancel', () => finish(null));
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const values: Record<string, string> = {};
            let files: File[] = [];
            for (const [name, input] of inputs) {
                values[name] = input.value;
                if (input instanceof HTMLInputElement && input.type === 'file') {
                    files = Array.from(input.files ?? []);
                }
            }
            finish({ values, files });
        });
        dialog.showModal();
    });
}

/* ---- toolbar ---------------------------------------------------------- */

const TIKTOK = 'com.git-agni.tiktok';

function udids(): string[] {
    return selected().map(({ udid }) => udid);
}

function report(message: string): void {
    if (selectionLabel) selectionLabel.textContent = message;
}

async function uploadFiles(files: File[]): Promise<Array<{ id: string; name: string; mimeType: string }>> {
    const data = new FormData();
    for (const file of files) data.append('media', file);
    const response = await fetch('/api/assets', { method: 'POST', body: data });
    if (!response.ok) throw new Error('The upload failed');
    return response.json() as Promise<Array<{ id: string; name: string; mimeType: string }>>;
}

async function bulk(body: unknown): Promise<void> {
    const outcome = await request<{ created: number; failed: number }>('/api/schedules/bulk', {
        method: 'POST', body: JSON.stringify(body),
    });
    report(`${outcome.created} scheduled, ${outcome.failed} failed`);
}

const ACTIONS: Record<string, (chosen: string[]) => Promise<void>> = {
    async 'schedule-post'(chosen) {
        const answers = await ask('Schedule a post', [
            { name: 'media', label: 'Media', type: 'file', accept: 'video/*,image/*', multiple: true },
            { name: 'runAt', label: 'Start', type: 'datetime-local' },
            { name: 'destination', label: 'Finish as', type: 'select', options: [['draft', 'Save to drafts'], ['publish', 'Post publicly']] },
            { name: 'caption', label: 'Caption', type: 'text' },
            { name: 'stagger', label: 'Stagger between phones, minutes', type: 'number', value: '5', min: '0' },
        ], 'Schedule on the selection');
        if (!answers) return;
        if (!answers.files.length) return report('Choose at least one clip.');
        if (!answers.values.runAt) return report('Choose when the post should go out.');
        report('Uploading media');
        const uploaded = await uploadFiles(answers.files);
        await bulk({
            deviceUdids: chosen,
            task: {
                pluginId: TIKTOK, taskType: 'post', taskVersion: 1,
                payload: {
                    media: uploaded.map((asset) => ({ assetId: asset.id, name: asset.name, mimeType: asset.mimeType })),
                    destination: answers.values.destination, account: '',
                    ...(answers.values.caption ? { caption: answers.values.caption } : {}),
                },
            },
            timing: { kind: 'once', runAt: new Date(answers.values.runAt!).toISOString() },
            stagger: { kind: 'fixed', minutes: Number(answers.values.stagger ?? 0) },
        });
    },
    async 'warm-up'(chosen) {
        const answers = await ask('Warm up', [
            { name: 'durationMinutes', label: 'Minutes', type: 'number', value: '10', min: '1', max: '180' },
            { name: 'personality', label: 'Personality', type: 'select', options: [['casual', 'Casual'], ['skimmer', 'Skimmer'], ['engaged', 'Engaged']] },
            { name: 'stagger', label: 'Stagger between phones, minutes', type: 'number', value: '0', min: '0' },
        ], 'Warm up the selection');
        if (!answers) return;
        await bulk({
            deviceUdids: chosen,
            task: {
                pluginId: TIKTOK, taskType: 'doomscroll', taskVersion: 1,
                payload: {
                    durationMinutes: Number(answers.values.durationMinutes ?? 10),
                    personality: answers.values.personality, likeEnabled: true, saveEnabled: false,
                },
            },
            timing: { kind: 'now' },
            stagger: { kind: 'fixed', minutes: Number(answers.values.stagger ?? 0) },
        });
    },
    async 'push-media'(chosen) {
        const answers = await ask('Push media', [
            { name: 'media', label: 'File', type: 'file', accept: 'video/*,image/*' },
        ], 'Push to the selection');
        if (!answers) return;
        if (!answers.files.length) return report('Choose a file.');
        const [asset] = await uploadFiles(answers.files);
        if (!asset) return report('The upload failed.');
        const outcome = await request<{ pushed: number; failed: number }>('/api/devices/actions/push-media', {
            method: 'POST', body: JSON.stringify({ udids: chosen, assetId: asset.id }),
        });
        report(`${outcome.pushed} phones have the file, ${outcome.failed} failed`);
    },
    async 'run-runbook'(chosen) {
        const { runbooks } = await request<{ runbooks: Array<{ id: string; name: string }> }>('/api/runbooks');
        if (!runbooks.length) return report('No runbooks are recorded yet.');
        const answers = await ask('Run a runbook', [{
            name: 'runbookId', label: 'Runbook', type: 'select',
            options: runbooks.map((runbook) => [runbook.id, runbook.name] as [string, string]),
        }], 'Run on the selection');
        if (!answers) return;
        await bulk({
            deviceUdids: chosen,
            task: { pluginId: 'com.farm.runbook', taskType: 'run', taskVersion: 1, payload: { runbookId: answers.values.runbookId } },
            timing: { kind: 'now' },
        });
    },
    async 'install-apk'(chosen) {
        const answers = await ask('Install an APK', [
            { name: 'path', label: 'File name inside the farm’s apk folder', type: 'text', value: 'bridge.apk' },
        ], 'Install on the selection');
        if (!answers) return;
        const outcome = await request<{ installed: number; failed: number }>('/api/devices/actions/install-apk', {
            method: 'POST', body: JSON.stringify({ udids: chosen, path: answers.values.path }),
        });
        report(`${outcome.installed} installed, ${outcome.failed} failed`);
    },
    async reconnect(chosen) {
        let done = 0;
        for (const udid of chosen) {
            try {
                await send(`/api/devices/${encodeURIComponent(udid)}/reconnect`, {});
                done += 1;
            } catch { /* reported in the count */ }
        }
        report(`${done} of ${chosen.length} asked to reconnect`);
    },
    async pause(chosen) {
        let paused = 0;
        for (const udid of chosen) {
            const { schedules } = await request<{ schedules: Array<{ id: string; status: string }> }>(
                `/api/schedules?deviceUdid=${encodeURIComponent(udid)}`);
            for (const schedule of schedules.filter(({ status }) => status === 'active')) {
                await send(`/api/schedules/${schedule.id}/pause`, {});
                paused += 1;
            }
        }
        report(`${paused} schedules paused`);
    },
};

document.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-wall-action]');
    if (!button) return;
    const action = button.dataset.wallAction ?? '';
    if (action === 'select-all') {
        const visible = tiles.filter((tile) => !tile.element.hidden);
        const target = visible.some((tile) => !tile.checkbox?.checked);
        for (const tile of visible) if (tile.checkbox) tile.checkbox.checked = target;
        countSelection();
        return;
    }
    const run = ACTIONS[action];
    if (!run) return;
    const chosen = udids();
    if (!chosen.length) return report('Select at least one phone.');
    button.disabled = true;
    void run(chosen)
        .catch((error: unknown) => report(errorMessage(error)))
        .finally(() => { button.disabled = false; });
});

/* ---- restore ---------------------------------------------------------- */

const savedSize = remembered('tileSize');
if (savedSize && sizeSlider) sizeSlider.value = savedSize;
const savedQuality = remembered('tileQuality');
if (savedQuality && qualitySlider) qualitySlider.value = savedQuality;
for (const udid of (remembered('wall.selection') ?? '').split(',').filter(Boolean)) {
    const tile = byUdid.get(udid);
    if (tile?.checkbox) tile.checkbox.checked = true;
}
applySize();
applyFilters();
bindInspector();
applyQuality();
const focus = remembered('wall.focus');
if (focus && byUdid.has(focus)) void select(focus);
else markSelected(inspectorUdid);
