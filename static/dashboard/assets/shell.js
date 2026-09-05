/**
 * Shared browser code for every Backline page: small request helpers, the live-frame pump the
 * wall and the device page both use, and the handful of behaviours the plain pages need.
 * Loaded on every page, so nothing in here may assume an element exists.
 */
export function pick(selector, root = document) {
    return root.querySelector(selector);
}
export function all(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** JSON fetch that turns the farm's `{ error }` envelope into a thrown Error. */
export async function request(url, options = {}) {
    const response = await fetch(url, {
        headers: options.body ? { 'content-type': 'application/json' } : {},
        ...options,
    });
    if (response.status === 204)
        return undefined;
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}
export function send(url, body, method = 'POST') {
    return request(url, { method, body: JSON.stringify(body ?? {}) });
}
/** Frames per second for each notch of the refresh slider; 0 means "hold the last frame". */
export const FRAME_RATES = [0, 0.5, 1, 2, 4];
/** Tile minimum width in px for small, medium and large. */
export const TILE_SIZES = [120, 170, 240];
export const TILE_SIZE_LABELS = ['S', 'M', 'L'];
export function rateLabel(rate) {
    return rate === 0 ? 'off' : `${rate} fps`;
}
/**
 * Keeps one `<img>` showing a phone. iOS phones have a real MJPEG stream, so the image is simply
 * pointed at it; Android has no stream, so its frames are polled at the chosen rate, each pump
 * offset from the others so a dozen tiles do not all fire in the same tick.
 */
export class FramePump {
    image;
    udid;
    platform;
    offset;
    timer;
    running = false;
    stopped = true;
    constructor(image, udid, platform, 
    /** Fraction of a period this pump waits before its first frame, 0…1. */
    offset = 0) {
        this.image = image;
        this.udid = udid;
        this.platform = platform;
        this.offset = offset;
    }
    fps = 1;
    setRate(fps) {
        this.fps = fps;
        if (!this.stopped) {
            this.stop();
            this.start();
        }
    }
    periodMs() {
        return this.fps > 0 ? Math.round(1000 / this.fps) : 1000;
    }
    start() {
        if (!this.stopped)
            return;
        this.stopped = false;
        if (this.platform === 'ios') {
            // One long-lived multipart response; the browser paints every frame.
            this.image.src = `/api/devices/${encodeURIComponent(this.udid)}/remote/stream`;
            return;
        }
        if (this.fps === 0) {
            if (!this.image.src)
                this.poll();
            return;
        }
        this.timer = window.setTimeout(() => this.poll(), Math.round(this.periodMs() * this.offset));
    }
    stop() {
        this.stopped = true;
        if (this.timer !== undefined)
            window.clearTimeout(this.timer);
        this.timer = undefined;
        // Closing the MJPEG response is the only way to stop the upstream device stream.
        if (this.platform === 'ios')
            this.image.removeAttribute('src');
    }
    /** The width to ask the farm for: the box on screen, in real device pixels. */
    width() {
        const css = this.image.clientWidth || this.image.parentElement?.clientWidth || 200;
        return Math.max(80, Math.min(1200, Math.round(css * (window.devicePixelRatio || 1))));
    }
    poll() {
        if (this.stopped || this.running)
            return;
        this.running = true;
        const next = () => {
            this.running = false;
            if (this.stopped || this.fps === 0)
                return;
            this.timer = window.setTimeout(() => this.poll(), this.periodMs());
        };
        this.image.onload = next;
        this.image.onerror = () => {
            this.running = false;
            if (this.stopped)
                return;
            this.timer = window.setTimeout(() => this.poll(), Math.max(2000, this.periodMs()));
        };
        this.image.src = `/api/devices/${encodeURIComponent(this.udid)}/remote/screenshot`
            + `?width=${this.width()}&t=${Date.now()}`;
    }
}
/** The phone's own coordinate space, so a click on a scaled image lands where the operator meant. */
export async function screenInfo(udid) {
    try {
        const info = await request(`/api/devices/${encodeURIComponent(udid)}/remote/info`);
        return info.screen.screenSize;
    }
    catch {
        return undefined;
    }
}
/** Map a pointer event on a viewer image to the phone's coordinates. */
export function devicePoint(image, screen, event) {
    const box = image.getBoundingClientRect();
    return {
        x: Math.round(((event.clientX - box.left) / box.width) * screen.width),
        y: Math.round(((event.clientY - box.top) / box.height) * screen.height),
    };
}
export function remoteAction(udid, action) {
    return send(`/api/devices/${encodeURIComponent(udid)}/remote/action`, action);
}
/** A remembered slider or selection. Any storage failure simply means "no preference". */
export function remember(key, value) {
    try {
        window.localStorage.setItem(`backline.${key}`, value);
    }
    catch { /* private window */ }
}
export function remembered(key) {
    try {
        return window.localStorage.getItem(`backline.${key}`);
    }
    catch {
        return null;
    }
}
function say(message) {
    const target = pick('#device-registry-result');
    if (target)
        target.textContent = message;
    else if (message)
        window.alert(message);
}
function initRegistry() {
    document.addEventListener('click', (event) => {
        const target = event.target;
        const row = target?.closest('[data-device-row]');
        if (!row)
            return;
        const disable = target?.closest('[data-device-disable]');
        const remove = target?.closest('[data-device-remove]');
        if (!disable && !remove)
            return;
        event.preventDefault();
        const udid = row.dataset.udid ?? '';
        void (async () => {
            try {
                if (remove) {
                    if (!window.confirm('Remove this phone? Its schedules are cancelled and its settings are forgotten.'))
                        return;
                    await request(`/api/devices/${encodeURIComponent(udid)}`, { method: 'DELETE' });
                }
                else {
                    await send(`/api/devices/${encodeURIComponent(udid)}`, { disabled: disable.dataset.deviceDisable === 'true' }, 'PATCH');
                }
                window.location.reload();
            }
            catch (error) {
                say(errorMessage(error));
            }
        })();
    });
}
function initCopy() {
    document.addEventListener('click', (event) => {
        const button = event.target?.closest('[data-copy]');
        if (!button)
            return;
        const source = pick(button.dataset.copy ?? '');
        if (!source)
            return;
        void navigator.clipboard?.writeText(source.textContent ?? '').then(() => {
            const label = button.textContent;
            button.textContent = 'Copied';
            window.setTimeout(() => { button.textContent = label; }, 1500);
        }).catch(() => { });
    });
    const reset = pick('[data-reset-tiles]');
    reset?.addEventListener('click', () => {
        remember('tileSize', '1');
        remember('tileRate', '2');
        reset.textContent = 'Reset';
    });
}
function alertRow(event) {
    const row = document.createElement('li');
    row.className = 'bl-alert';
    row.dataset.eventId = String(event.id);
    const dot = document.createElement('span');
    dot.className = `bl-dot ${event.severity === 'error' ? 'bad' : event.severity === 'warning' ? 'warn' : ''}`;
    const copy = document.createElement('div');
    copy.className = 'bl-alert-copy';
    const title = document.createElement('div');
    title.className = 'bl-alert-title';
    title.textContent = event.title;
    const meta = document.createElement('div');
    meta.className = 'bl-alert-meta';
    for (const word of [event.kind, event.severity]) {
        const chip = document.createElement('span');
        chip.className = 'bl-chip bl-chip-sm';
        chip.textContent = word;
        meta.append(chip);
    }
    const time = document.createElement('time');
    time.textContent = event.createdAt;
    meta.append(time);
    copy.append(title, meta);
    row.append(dot, copy);
    return row;
}
function initAlerts() {
    const list = pick('#alerts-list');
    const unread = pick('#alerts-unread');
    const ack = pick('[data-ack-all]');
    ack?.addEventListener('click', () => {
        const newest = Number(list?.dataset.newest ?? 0);
        void send('/api/events/ack', { upToId: newest })
            .then(() => window.location.reload())
            .catch((error) => { if (unread)
            unread.textContent = errorMessage(error); });
    });
    if (!list)
        return;
    const stream = new EventSource('/api/events/stream');
    stream.addEventListener('message', (message) => {
        try {
            const event = JSON.parse(message.data);
            if (!event?.id || list.querySelector(`[data-event-id="${event.id}"]`))
                return;
            list.prepend(alertRow(event));
            list.dataset.newest = String(event.id);
        }
        catch { /* a heartbeat, not an event */ }
    });
    window.addEventListener('beforeunload', () => stream.close());
}
export function initShell() {
    if (window.__blShell)
        return;
    window.__blShell = true;
    initRegistry();
    initCopy();
    initAlerts();
}
initShell();
