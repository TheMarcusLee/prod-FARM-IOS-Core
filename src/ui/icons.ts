/**
 * The Backline icon set: stroke SVG on a 16 grid, 1.6 stroke, round caps, currentColor.
 * Add glyphs here rather than inlining them in pages. See docs/design/backline.md.
 */
const PATHS: Record<string, string> = {
    grid: '<rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/>',
    clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
    film: '<rect x="2" y="3" width="12" height="10" rx="1.8"/><path d="M6.5 6.5v3l3-1.5z" fill="currentColor" stroke="none"/>',
    list: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.8"/><path d="M5 6h6M5 9h4"/>',
    person: '<circle cx="8" cy="6" r="3"/><path d="M2.5 14a5.5 5.5 0 0 1 11 0"/>',
    bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1H3z"/><path d="M6.5 14h3"/>',
    phone: '<rect x="5" y="1.5" width="6" height="13" rx="1.6"/><path d="M7 12.5h2"/>',
    rig: '<path d="M2 5h12M2 11h12"/><circle cx="6" cy="5" r="1.8" fill="var(--bl-panel, #fff)"/><circle cx="10" cy="11" r="1.8" fill="var(--bl-panel, #fff)"/>',
    gear: '<circle cx="8" cy="8" r="2.3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
    check: '<path d="M3 8l3.5 3.5L13 5"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    chevronRight: '<path d="M6 3l5 5-5 5"/>',
    chevronLeft: '<path d="M10 3L5 8l5 5"/>',
    chevronDown: '<path d="M3 6l5 5 5-5"/>',
    home: '<circle cx="8" cy="8" r="5"/>',
    back: '<path d="M10 3L5 8l5 5"/>',
    recents: '<rect x="3" y="3" width="10" height="10" rx="2"/>',
    power: '<path d="M8 2v6M4.5 5a5 5 0 1 0 7 0"/>',
    camera: '<rect x="2" y="4" width="12" height="9" rx="1.8"/><circle cx="8" cy="8.5" r="2.2"/>',
    keyboard: '<rect x="2" y="5" width="12" height="7" rx="1.5"/><path d="M5 8.5h6"/>',
    lock: '<rect x="4" y="7" width="8" height="7" rx="1.5"/><path d="M6 7V5a2 2 0 0 1 4 0v2"/>',
    unlock: '<rect x="4" y="7" width="8" height="7" rx="1.5"/><path d="M6 7V5a2 2 0 0 1 3.6-1.2"/>',
    expand: '<path d="M2 6V2h4M14 10v4h-4M14 6V2h-4M2 10v4h4"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5V6h-3.5"/>',
    play: '<path d="M5 3l8 5-8 5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M5 3v10M11 3v10" stroke-width="2"/>',
    stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/>',
    upload: '<path d="M8 11V3M4.5 6.5L8 3l3.5 3.5"/><path d="M3 13h10"/>',
    download: '<path d="M8 3v8M4.5 7.5L8 11l3.5-3.5"/><path d="M3 13h10"/>',
    alert: '<path d="M8 2.5l6 11H2z"/><path d="M8 6.5v3M8 11.5h.01"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.5v4M8 5h.01"/>',
    signal: '<path d="M3 12V6M8 12V3M13 12V8"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
    tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="6" cy="6" r="1" fill="currentColor" stroke="none"/>',
    calendar: '<rect x="2" y="3" width="12" height="11" rx="1.8"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>',
    wifi: '<path d="M2 6.5a9 9 0 0 1 12 0M4.5 9a5.5 5.5 0 0 1 7 0"/><circle cx="8" cy="12" r="1" fill="currentColor" stroke="none"/>',
    usb: '<path d="M8 2v12M8 2l-1.5 2h3zM5 9.5l3 2.5 3-2.5M4.5 7h1.5M10 5h1.5"/>',
    trash: '<path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>',
    edit: '<path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/>',
    external: '<path d="M7 3H3.5v9.5H13V9M9 3h4v4M13 3L7.5 8.5"/>',
    moon: '<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
};

export type IconName = keyof typeof PATHS;

/** Inline SVG markup for a named icon; `size` in px (16 on desktop, 24 on the phone). */
export function icon(name: IconName, size = 16, className = 'bl-icon'): string {
    const paths = PATHS[name];
    if (!paths) throw new Error(`Unknown icon: ${String(name)}`);
    return `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${paths}</svg>`;
}

export const ICON_NAMES = Object.keys(PATHS) as IconName[];
