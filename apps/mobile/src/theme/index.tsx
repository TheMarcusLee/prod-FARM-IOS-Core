/**
 * The Backline tokens, verbatim from `docs/design/backline.md`.
 *
 * Light is primary — the reference feel is Apple's pro apps in their light
 * appearance — and dark is the same table's second column, not a re-invention.
 * Nothing here is picked by eye: if a value is not in that table it does not
 * belong in this file.
 *
 * The type is the system font (SF / Roboto). The design's Hanken Grotesk is a
 * web and desktop face; the phone does not bundle a font.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { useOptionalSettings } from '../context/SettingsContext';
import type { AccountColor, DeviceState, EventSeverity, ExecutionStatus, ScheduleStatus, WallState } from '@farm/client';

export interface Palette {
    /** window / page background */
    bg: string;
    /** sidebars, cards, tiles, inspector */
    panel: string;
    /** inset areas, segmented control track, sliders */
    panel2: string;
    /** every border */
    line: string;
    /** checkbox borders, dividers that must read */
    lineStrong: string;
    text: string;
    /** secondary text, nav items */
    text2: string;
    /** labels, meta */
    text3: string;
    /** placeholders, timestamps */
    text4: string;
    /** selection, active nav, "posting" state, links */
    accent: string;
    /** active nav background, selected tile ring base */
    accentSoft: string;
    /** live, online, succeeded */
    ok: string;
    /** idle-with-caveat, degraded */
    warn: string;
    /** failed, needs-you, destructive */
    bad: string;
    /** needs-you callout background */
    badSoft: string;
    /** filled primary button background */
    ink: string;
    /** text on an `ink` fill — not a design token, the other half of one. */
    onInk: string;
    /** the "needs you" callout border, the one hairline the table names inline */
    badLine: string;
    /** the scrim over a mirrored screen. `ink` at 72%, per PhoneDevice. */
    scrim: string;
}

const light: Palette = {
    bg: '#f4f5f7',
    panel: '#ffffff',
    panel2: '#f0f1f4',
    line: '#e3e6eb',
    lineStrong: '#c5cad3',
    text: '#1e2430',
    text2: '#3c4350',
    text3: '#5b6270',
    text4: '#9aa1ad',
    accent: '#2f6fe4',
    accentSoft: '#e8f0fe',
    ok: '#2f9e5b',
    warn: '#c9931f',
    bad: '#d7503c',
    badSoft: '#fdf1ef',
    ink: '#1e2430',
    onInk: '#ffffff',
    badLine: '#f3c9c2',
    scrim: 'rgba(30,36,48,0.72)',
};

const dark: Palette = {
    bg: '#0f1115',
    panel: '#171a20',
    panel2: '#1f232b',
    line: '#2a2f39',
    lineStrong: '#3a4150',
    text: '#e6e9ee',
    text2: '#b8bfca',
    text3: '#8b93a1',
    text4: '#5f6775',
    accent: '#5b8def',
    accentSoft: '#1b2a48',
    ok: '#3fb768',
    warn: '#d8ab3c',
    bad: '#ef6f61',
    badSoft: '#3a1f1b',
    ink: '#e6e9ee',
    onInk: '#0f1115',
    badLine: '#5c342d',
    scrim: 'rgba(15,17,21,0.78)',
};

/**
 * Account identity, used only on clips, chips and the inspector. Assigned in
 * order of account creation; `text` is the darker tone, for a label on a fill.
 */
export const accountColors: Record<AccountColor, { light: string; dark: string; text: string }> = {
    sage: { light: '#a3c497', dark: '#7fa66a', text: '#3c5233' },
    lilac: { light: '#b9a6dc', dark: '#9a86c9', text: '#42355c' },
    coral: { light: '#e6a48f', dark: '#d9836b', text: '#63342a' },
    sky: { light: '#9dbfdd', dark: '#6aa0c9', text: '#2f4a5e' },
    mustard: { light: '#dcc27a', dark: '#c9a94a', text: '#584821' },
    rose: { light: '#e0a3c4', dark: '#c77ea6', text: '#5c3247' },
    mint: { light: '#9fd3c3', dark: '#6fb39f', text: '#2f5449' },
    slate: { light: '#b3bccd', dark: '#8593ab', text: '#3a4453' },
};

/** The palette's account fill and its 1px darker border, for one clip. */
export function accountFill(name: string, scheme: 'light' | 'dark'): { fill: string; border: string; text: string } {
    const entry = accountColors[name as AccountColor] ?? accountColors.slate;
    return scheme === 'dark'
        ? { fill: entry.dark, border: entry.text, text: '#0f1115' }
        : { fill: entry.light, border: entry.dark, text: entry.text };
}

/** 4, 6, 8, 10, 12, 14, 16, 18, 20, 24 — the whole scale, nothing between. */
export const spacing = {
    xs: 4,
    xs2: 6,
    sm: 8,
    sm2: 10,
    md: 12,
    md2: 14,
    lg: 16,
    lg2: 18,
    xl: 20,
    xxl: 24,
} as const;

/** 6 small controls · 8 buttons/inputs · 10 callouts · 12 cards · 14 tiles. */
export const radius = { sm: 6, md: 8, lg: 10, card: 12, tile: 14, pill: 999 } as const;

/** 11 / 12 / 12.5 / 13.5 body / 14 / 17 page title / 24 phone screen title. */
export const type = {
    micro: 11,
    small: 12,
    meta: 12.5,
    body: 13.5,
    strong: 14,
    title: 17,
    display: 24,
} as const;

export interface Theme {
    colors: Palette;
    scheme: 'light' | 'dark';
    spacing: typeof spacing;
    radius: typeof radius;
    type: typeof type;
}

const ThemeContext = createContext<Theme>({ colors: light, scheme: 'light', spacing, radius, type });

export function ThemeProvider({ children }: { children: ReactNode }) {
    const system = useColorScheme();
    const preference = useOptionalSettings()?.settings.theme ?? 'system';
    // Light is primary: anything that is not explicitly dark renders light.
    const scheme = preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference;
    const value = useMemo<Theme>(
        () => ({ colors: scheme === 'dark' ? dark : light, scheme, spacing, radius, type }),
        [scheme],
    );
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
    return useContext(ThemeContext);
}

/* ------------------------------------------------------ semantic colours */

/**
 * The state vocabulary is fixed: online (ok), posting (accent), busy (accent),
 * offline (text-4), disabled (text-4), error / needs you (bad).
 */
export function wallStateColor(state: WallState, colors: Palette): string {
    switch (state) {
        case 'online':
            return colors.ok;
        case 'posting':
        case 'busy':
            return colors.accent;
        case 'offline':
        case 'disabled':
            return colors.text4;
        case 'error':
            return colors.bad;
    }
}

export function deviceStateColor(state: DeviceState, colors: Palette): string {
    return wallStateColor(state, colors);
}

export function severityColor(severity: EventSeverity, colors: Palette): string {
    return severity === 'error' ? colors.bad : severity === 'warning' ? colors.warn : colors.accent;
}

export function executionStatusColor(status: ExecutionStatus, colors: Palette): string {
    switch (status) {
        case 'running':
        case 'queued':
            return colors.accent;
        case 'succeeded':
            return colors.ok;
        case 'failed':
            return colors.bad;
        case 'stopped':
        case 'cancelled':
            return colors.warn;
        case 'skipped':
            return colors.text4;
    }
}

export function scheduleStatusColor(status: ScheduleStatus, colors: Palette): string {
    switch (status) {
        case 'active':
            return colors.ok;
        case 'paused':
            return colors.warn;
        case 'completed':
        case 'cancelled':
            return colors.text4;
    }
}
