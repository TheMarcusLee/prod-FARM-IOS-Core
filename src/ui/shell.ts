/**
 * The Backline page shell: sidebar, toolbar, content. Every dashboard page renders through
 * `renderShell` so navigation, branding and the token stylesheet are one thing, not five copies.
 * See docs/design/backline.md.
 */
import { icon, type IconName } from './icons.js';

export const PRODUCT_NAME = 'Backline';

export type NavKey = 'control' | 'schedule' | 'content' | 'runbooks' | 'accounts' | 'alerts' | 'devices' | 'rig' | 'settings';

interface NavItem { key: NavKey; label: string; href: string; icon: IconName; divider?: boolean }

export const NAV: readonly NavItem[] = [
    { key: 'control', label: 'Control Center', href: '/', icon: 'grid' },
    { key: 'schedule', label: 'Schedule', href: '/schedule', icon: 'clock' },
    { key: 'content', label: 'Content', href: '/content', icon: 'film' },
    { key: 'runbooks', label: 'Runbooks', href: '/runbooks', icon: 'list' },
    { key: 'accounts', label: 'Accounts', href: '/accounts', icon: 'person' },
    { key: 'alerts', label: 'Alerts', href: '/alerts', icon: 'bell' },
    { key: 'devices', label: 'Devices', href: '/devices', icon: 'phone', divider: true },
    { key: 'rig', label: 'Rig', href: '/rig', icon: 'rig' },
    { key: 'settings', label: 'Settings', href: '/settings', icon: 'gear' },
];

export function escapeHtml(value: unknown): string {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export interface RigStatus {
    /** One line, e.g. "Rig running". */
    headline: string;
    ok: boolean;
    /** Up to two short detail lines. */
    lines: string[];
}

export interface ShellInput {
    /** Browser tab title; the product name is appended. */
    title: string;
    active: NavKey;
    /** Rendered inside the toolbar after the page title; buttons, segmented controls. */
    toolbar?: string;
    /** Rendered at the toolbar's right edge (counts, user, theme). */
    toolbarRight?: string;
    /** The page body. Use `.bl-page` for padded pages or `.bl-cc` for the three-column wall. */
    body: string;
    /** Extra head markup: stylesheets, scripts. htmx and the token stylesheet are always included. */
    head?: string;
    unreadAlerts?: number;
    rig?: RigStatus;
    /** Extra nav entries plugins contribute, already rendered as `<a>` elements. */
    pluginNav?: string;
    /** Sign-out link or user chip, rendered under the rig status. */
    authNav?: string;
    /** 'auto' follows the OS; 'light' pins light. */
    theme?: 'auto' | 'light';
}

function navHtml(active: NavKey, unread: number, pluginNav: string): string {
    return NAV.map((item) => {
        const divider = item.divider ? '<div class="bl-nav-divider"></div>' : '';
        const current = item.key === active ? ' aria-current="page"' : '';
        const count = item.key === 'alerts' && unread > 0 ? `<span class="bl-count">${unread > 99 ? '99+' : unread}</span>` : '';
        return `${divider}<a href="${item.href}"${current}>${icon(item.icon)}${escapeHtml(item.label)}${count}</a>`;
    }).join('') + pluginNav;
}

function rigHtml(rig: RigStatus | undefined): string {
    const status = rig ?? { headline: 'Rig status unknown', ok: false, lines: [] };
    return `<div class="bl-rig-status"><strong><span class="bl-dot ${status.ok ? 'ok' : ''}"></span>${escapeHtml(status.headline)}</strong>${status.lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}</div>`;
}

export function renderShell(input: ShellInput): string {
    const theme = input.theme ?? 'light';
    return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} · ${PRODUCT_NAME}</title>
<link rel="stylesheet" href="/assets/backline.css">
<script src="/assets/htmx.min.js" defer></script>
${input.head ?? ''}
</head>
<body>
<div class="bl-app">
<aside class="bl-sidebar">
<a class="bl-brand" href="/"><span class="bl-brand-mark">${icon('signal')}</span>${PRODUCT_NAME}</a>
<nav class="bl-nav" aria-label="Primary">${navHtml(input.active, input.unreadAlerts ?? 0, input.pluginNav ?? '')}</nav>
${rigHtml(input.rig)}
${input.authNav ?? ''}
</aside>
<div class="bl-main">
<header class="bl-toolbar"><h1>${escapeHtml(input.title)}</h1><div class="bl-toolbar-actions">${input.toolbar ?? ''}</div><div class="bl-toolbar-right">${input.toolbarRight ?? ''}</div></header>
<main class="bl-content">${input.body}</main>
</div>
</div>
</body>
</html>`;
}

/** A state dot plus its word, using the exact vocabulary from the design spec. */
export function stateBadge(state: 'online' | 'posting' | 'busy' | 'offline' | 'disabled' | 'error' | 'live'): string {
    const word = state === 'error' ? 'needs you' : state;
    return `<span class="bl-state ${state}"><span class="bl-dot ${state}"></span>${word}</span>`;
}

/** Zero-padded slot number, the operator's handle for a phone: 01 … 99. */
export function slotNumber(index: number): string {
    return String(index + 1).padStart(2, '0');
}
