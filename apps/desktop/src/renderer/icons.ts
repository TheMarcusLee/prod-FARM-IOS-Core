/**
 * The glyphs this app draws, copied byte for byte from `src/ui/icons.ts`.
 *
 * The renderer cannot import the farm's own module — it is bundled on its own,
 * from a file:// document with `default-src 'none'` — so the set is duplicated
 * rather than re-drawn. Keep the path data identical to the source set, and add
 * a glyph there first. Never an emoji, never an icon font.
 * See docs/design/backline.md.
 */
const PATHS = {
    signal: '<path d="M3 12V6M8 12V3M13 12V8"/>',
    check: '<path d="M3 8l3.5 3.5L13 5"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    chevronDown: '<path d="M3 6l5 5 5-5"/>',
    chevronRight: '<path d="M6 3l5 5-5 5"/>',
    gear: '<circle cx="8" cy="8" r="2.3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5V6h-3.5"/>',
    phone: '<rect x="5" y="1.5" width="6" height="13" rx="1.6"/><path d="M7 12.5h2"/>',
    download: '<path d="M8 3v8M4.5 7.5L8 11l3.5-3.5"/><path d="M3 13h10"/>',
    external: '<path d="M7 3H3.5v9.5H13V9M9 3h4v4M13 3L7.5 8.5"/>',
    alert: '<path d="M8 2.5l6 11H2z"/><path d="M8 6.5v3M8 11.5h.01"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** Inline SVG markup for a named icon; `size` in px (16 on desktop). */
export function iconMarkup(name: IconName, size = 16): string {
    return `<svg class="bl-icon" width="${size}" height="${size}" viewBox="0 0 16 16" `
        + `aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}

/** The same glyph as an element, for code that builds its DOM by hand. */
export function icon(name: IconName, size = 16): SVGSVGElement {
    const host = document.createElement('div');
    host.innerHTML = iconMarkup(name, size);
    return host.firstElementChild as SVGSVGElement;
}
