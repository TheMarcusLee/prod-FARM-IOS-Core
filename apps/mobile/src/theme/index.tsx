/**
 * Two palettes and a spacing scale. No UI kit: the app is eight screens of
 * lists and cards, and a design system would be more code than the screens.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import type { DeviceState, EventSeverity, ExecutionStatus, ScheduleStatus } from '@farm/client';

export interface Palette {
    background: string;
    surface: string;
    surfaceRaised: string;
    border: string;
    text: string;
    textMuted: string;
    textFaint: string;
    accent: string;
    accentText: string;
    online: string;
    busy: string;
    offline: string;
    disabled: string;
    error: string;
    warning: string;
    info: string;
    danger: string;
    overlay: string;
}

const dark: Palette = {
    background: '#0B0C0E',
    surface: '#15171B',
    surfaceRaised: '#1E2127',
    border: '#282C34',
    text: '#F2F4F7',
    textMuted: '#9BA3AF',
    textFaint: '#646C79',
    accent: '#4C8DFF',
    accentText: '#FFFFFF',
    online: '#3FB950',
    busy: '#4C8DFF',
    offline: '#646C79',
    disabled: '#4A4F58',
    error: '#F85149',
    warning: '#D29922',
    info: '#58A6FF',
    danger: '#F85149',
    overlay: 'rgba(11,12,14,0.82)',
};

const light: Palette = {
    background: '#F6F7F9',
    surface: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    border: '#E1E4E9',
    text: '#10131A',
    textMuted: '#5A6472',
    textFaint: '#8A94A3',
    accent: '#0B62E0',
    accentText: '#FFFFFF',
    online: '#1A7F37',
    busy: '#0B62E0',
    offline: '#8A94A3',
    disabled: '#B4BAC4',
    error: '#CF222E',
    warning: '#9A6700',
    info: '#0B62E0',
    danger: '#CF222E',
    overlay: 'rgba(246,247,249,0.86)',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

export interface Theme {
    colors: Palette;
    scheme: 'light' | 'dark';
    spacing: typeof spacing;
    radius: typeof radius;
}

const ThemeContext = createContext<Theme>({ colors: dark, scheme: 'dark', spacing, radius });

export function ThemeProvider({ children }: { children: ReactNode }) {
    const scheme = useColorScheme() === 'light' ? 'light' : 'dark';
    const value = useMemo<Theme>(
        () => ({ colors: scheme === 'light' ? light : dark, scheme, spacing, radius }),
        [scheme],
    );
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
    return useContext(ThemeContext);
}

/* ------------------------------------------------------ semantic colours */

export function deviceStateColor(state: DeviceState, colors: Palette): string {
    switch (state) {
        case 'online':
            return colors.online;
        case 'busy':
            return colors.busy;
        case 'offline':
            return colors.offline;
        case 'disabled':
            return colors.disabled;
        case 'error':
            return colors.error;
    }
}

export function severityColor(severity: EventSeverity, colors: Palette): string {
    return severity === 'error' ? colors.error : severity === 'warning' ? colors.warning : colors.info;
}

export function executionStatusColor(status: ExecutionStatus, colors: Palette): string {
    switch (status) {
        case 'running':
            return colors.busy;
        case 'queued':
            return colors.info;
        case 'succeeded':
            return colors.online;
        case 'failed':
            return colors.error;
        case 'stopped':
        case 'cancelled':
            return colors.warning;
        case 'skipped':
            return colors.offline;
    }
}

export function scheduleStatusColor(status: ScheduleStatus, colors: Palette): string {
    switch (status) {
        case 'active':
            return colors.online;
        case 'paused':
            return colors.warning;
        case 'completed':
            return colors.offline;
        case 'cancelled':
            return colors.disabled;
    }
}
