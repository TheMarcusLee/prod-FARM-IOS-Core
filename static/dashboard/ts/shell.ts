/**
 * Shared browser code for every Backline page: small request helpers, the live-frame pump the
 * wall and the device page both use, and the handful of behaviours the plain pages need.
 * Loaded on every page, so nothing in here may assume an element exists.
 */

declare global {
    interface Window {
        __blShell?: true;
        htmx?: { process(element: Element): void };
    }
}

export function pick<T extends Element>(selector: string, root: ParentNode = document): T | null {
    return root.querySelector<T>(selector);
}

export function all<T extends Element>(selector: string, root: ParentNode = document): T[] {
    return Array.from(root.querySelectorAll<T>(selector));
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** JSON fetch that turns the farm's `{ error }` envelope into a thrown Error. */
export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
        headers: options.body ? { 'content-type': 'application/json' } : {},
        ...options,
    });
    if (response.status === 204) return undefined as T;
    const body = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}

export function send(url: string, body: unknown, method = 'POST'): Promise<unknown> {
    return request(url, { method, body: JSON.stringify(body ?? {}) });
}

/** Frames per second for each notch of the refresh slider; 0 means "hold the last frame". */
export const FRAME_RATES = [0, 0.5, 1, 2, 4] as const;
/** Tile minimum width in px for small, medium and large. */
export const TILE_SIZES = [120, 150, 210] as const;
export const TILE_SIZE_LABELS = ['S', 'M', 'L'] as const;

export function rateLabel(rate: number): string {
    return rate === 0 ? 'off' : `${rate} fps`;
}

/**
 * Keeps one `<img>` showing a phone. iOS phones have a real MJPEG stream, so the image is simply
 * pointed at it; Android has no stream, so its frames are polled at the chosen rate, each pump
 * offset from the others so a dozen tiles do not all fire in the same tick.
 */
export class FramePump {
    private timer: number | undefined;
    private running = false;
    private stopped = true;
    private objectUrl: string | undefined;

    constructor(
        private readonly image: HTMLImageElement,
        private readonly udid: string,
        private readonly platform: string,
        /** Fraction of a period this pump waits before its first frame, 0…1. */
        private readonly offset = 0,
    ) {}

    private fps = 1;

    setRate(fps: number): void {
        this.fps = fps;
        if (!this.stopped) {
            this.stop();
            this.start();
        }
    }

    private periodMs(): number {
        return this.fps > 0 ? Math.round(1000 / this.fps) : 1000;
    }

    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        if (this.platform === 'ios') {
            // One long-lived multipart response; the browser paints every frame.
            this.image.src = `/api/devices/${encodeURIComponent(this.udid)}/remote/stream`;
            return;
        }
        if (this.fps === 0) {
            if (!this.image.src) this.poll();
            return;
        }
        this.timer = window.setTimeout(() => this.poll(), Math.round(this.periodMs() * this.offset));
    }

    stop(): void {
        this.stopped = true;
        if (this.timer !== undefined) window.clearTimeout(this.timer);
        this.timer = undefined;
        // Closing the MJPEG response is the only way to stop the upstream device stream.
        if (this.platform === 'ios') this.image.removeAttribute('src');
    }

    /** The width to ask the farm for: the box on screen, in real device pixels. */
    private width(): number {
        const css = this.image.clientWidth || this.image.parentElement?.clientWidth || 200;
        return Math.max(80, Math.min(1200, Math.round(css * (window.devicePixelRatio || 1))));
    }

    /**
     * Fetched as a blob and swapped in once it has decoded. Assigning the URL to the visible
     * `<img>` directly would blank the tile for as long as the request takes — twelve tiles
     * flickering in turn is what that looks like on the wall.
     */
    private poll(): void {
        if (this.stopped || this.running) return;
        this.running = true;
        const again = (delay: number) => {
            this.running = false;
            if (this.stopped || this.fps === 0) return;
            this.timer = window.setTimeout(() => this.poll(), delay);
        };
        const url = `/api/devices/${encodeURIComponent(this.udid)}/remote/screenshot?width=${this.width()}`;
        void fetch(`${url}&t=${Date.now()}`, { cache: 'no-store' })
            .then(async (response) => {
                if (!response.ok) throw new Error(String(response.status));
                const next = URL.createObjectURL(await response.blob());
                const previous = this.objectUrl;
                this.image.src = next;
                this.objectUrl = next;
                if (previous) URL.revokeObjectURL(previous);
                again(this.periodMs());
            })
            .catch(() => again(Math.max(2000, this.periodMs())));
    }
}

export interface ScreenInfo {
    width: number;
    height: number;
}

/** The phone's own coordinate space, so a click on a scaled image lands where the operator meant. */
export async function screenInfo(udid: string): Promise<ScreenInfo | undefined> {
    try {
        const info = await request<{ screen: { screenSize: ScreenInfo } }>(
            `/api/devices/${encodeURIComponent(udid)}/remote/info`);
        return info.screen.screenSize;
    } catch {
        return undefined;
    }
}

/** Map a pointer event on a viewer image to the phone's coordinates. */
export function devicePoint(image: HTMLElement, screen: ScreenInfo, event: PointerEvent): { x: number; y: number } {
    const box = image.getBoundingClientRect();
    return {
        x: Math.round(((event.clientX - box.left) / box.width) * screen.width),
        y: Math.round(((event.clientY - box.top) / box.height) * screen.height),
    };
}

export type RemoteAction =
    | { type: 'tap'; x: number; y: number }
    | { type: 'swipe'; startX: number; startY: number; endX: number; endY: number; durationMs: number }
    | { type: 'home' | 'back' | 'recents' | 'lock' | 'power' | 'wake' | 'unlock' | 'volumeUp' | 'volumeDown' }
    | { type: 'text'; text: string };

export function remoteAction(udid: string, action: RemoteAction): Promise<unknown> {
    return send(`/api/devices/${encodeURIComponent(udid)}/remote/action`, action);
}

/** A remembered slider or selection. Any storage failure simply means "no preference". */
export function remember(key: string, value: string): void {
    try { window.localStorage.setItem(`backline.${key}`, value); } catch { /* private window */ }
}

export function remembered(key: string): string | null {
    try { return window.localStorage.getItem(`backline.${key}`); } catch { return null; }
}

function say(message: string): void {
    const target = pick<HTMLElement>('#device-registry-result');
    if (target) target.textContent = message;
    else if (message) window.alert(message);
}

function initRegistry(): void {
    document.addEventListener('click', (event) => {
        const target = event.target as Element | null;
        const row = target?.closest<HTMLElement>('[data-device-row]');
        if (!row) return;
        const disable = target?.closest<HTMLButtonElement>('[data-device-disable]');
        const remove = target?.closest<HTMLButtonElement>('[data-device-remove]');
        if (!disable && !remove) return;
        event.preventDefault();
        const udid = row.dataset.udid ?? '';
        void (async () => {
            try {
                if (remove) {
                    if (!window.confirm('Remove this phone? Its schedules are cancelled and its settings are forgotten.')) return;
                    await request(`/api/devices/${encodeURIComponent(udid)}`, { method: 'DELETE' });
                } else {
                    await send(`/api/devices/${encodeURIComponent(udid)}`,
                        { disabled: disable!.dataset.deviceDisable === 'true' }, 'PATCH');
                }
                window.location.reload();
            } catch (error) {
                say(errorMessage(error));
            }
        })();
    });
}

function initCopy(): void {
    document.addEventListener('click', (event) => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-copy]');
        if (!button) return;
        const source = pick<HTMLElement>(button.dataset.copy ?? '');
        if (!source) return;
        void navigator.clipboard?.writeText(source.textContent ?? '').then(() => {
            const label = button.textContent;
            button.textContent = 'Copied';
            window.setTimeout(() => { button.textContent = label; }, 1500);
        }).catch(() => { /* clipboard blocked */ });
    });
    const reset = pick<HTMLButtonElement>('[data-reset-tiles]');
    reset?.addEventListener('click', () => {
        remember('tileSize', '1');
        remember('tileRate', '2');
        reset.textContent = 'Reset';
    });
}

function alertRow(event: { id: number; kind: string; severity: string; title: string; createdAt: string; deviceUdid: string | null }): HTMLElement {
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

function initAlerts(): void {
    const list = pick<HTMLElement>('#alerts-list');
    const unread = pick<HTMLElement>('#alerts-unread');
    const ack = pick<HTMLButtonElement>('[data-ack-all]');
    ack?.addEventListener('click', () => {
        const newest = Number(list?.dataset.newest ?? 0);
        void send('/api/events/ack', { upToId: newest })
            .then(() => window.location.reload())
            .catch((error: unknown) => { if (unread) unread.textContent = errorMessage(error); });
    });
    if (!list) return;
    const stream = new EventSource('/api/events/stream');
    stream.addEventListener('message', (message) => {
        try {
            const event = JSON.parse((message as MessageEvent<string>).data);
            if (!event?.id || list.querySelector(`[data-event-id="${event.id}"]`)) return;
            list.prepend(alertRow(event));
            list.dataset.newest = String(event.id);
        } catch { /* a heartbeat, not an event */ }
    });
    window.addEventListener('beforeunload', () => stream.close());
}

export function initShell(): void {
    if (window.__blShell) return;
    window.__blShell = true;
    initRegistry();
    initCopy();
    initAlerts();
}

initShell();
