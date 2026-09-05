/**
 * The tab set is part of the design, not an implementation detail: Wall,
 * Schedule, Content, Alerts, Rig, in that order, with Settings *not* a tab.
 * This drives the real layout with `expo-router/js-tabs` stubbed so the
 * `Tabs.Screen` options can be read back.
 */
import { render } from '@testing-library/react-native';
import { Providers } from './render';

interface Recorded {
    name: string;
    options: Record<string, unknown>;
}

/** `mock`-prefixed so `jest.mock`'s hoisting lets the factory reach it. */
const mockRecorded: Recorded[] = [];

jest.mock('expo-router/js-tabs', () => {
    const Screen = (screenProps: { name: string; options: Record<string, unknown> }) => {
        mockRecorded.push({ name: screenProps.name, options: screenProps.options });
        return null;
    };
    const Tabs = (tabsProps: { children: unknown }) => tabsProps.children;
    Tabs.Screen = Screen;
    return { Tabs };
});

import TabsLayout from '../app/(tabs)/_layout';

async function renderTabs(): Promise<void> {
    mockRecorded.length = 0;
    await render(<TabsLayout />, { wrapper: Providers });
}

describe('the tab bar', () => {
    it('is Wall, Schedule, Content, Alerts, Rig — and nothing else', async () => {
        await renderTabs();
        expect(mockRecorded.map((row) => row.name)).toEqual(['index', 'schedule', 'content', 'alerts', 'rig']);
        expect(mockRecorded.map((row) => row.options.title)).toEqual(['Wall', 'Schedule', 'Content', 'Alerts', 'Rig']);
        // Settings moved under Rig; there is no tab for it any more, and the
        // old Fleet/Queue names are gone with it.
        expect(mockRecorded.some((row) => ['settings', 'queue'].includes(row.name))).toBe(false);
        expect(mockRecorded.some((row) => ['Settings', 'Queue', 'Fleet'].includes(String(row.options.title)))).toBe(false);
    });

    it('draws a glyph for every tab, and never a text character', async () => {
        await renderTabs();
        for (const row of mockRecorded) {
            expect(typeof row.options.tabBarIcon).toBe('function');
            const icon = row.options.tabBarIcon as (input: { color: string }) => { type?: unknown } | null;
            const element = icon({ color: '#2f6fe4' });
            // A React element for the SVG icon, not a `<Text>` glyph.
            expect(element).toBeTruthy();
            expect(String(element?.type ?? '')).not.toContain('Text');
            // Labels are words: no emoji, no box-drawing characters.
            expect(String(row.options.title)).toMatch(/^[A-Za-z ]+$/);
        }
    });

    it('carries the unacknowledged count on Alerts and nowhere else', async () => {
        await renderTabs();
        const alerts = mockRecorded.find((row) => row.name === 'alerts');
        expect(alerts).toBeTruthy();
        for (const row of mockRecorded.filter((entry) => entry.name !== 'alerts')) {
            expect(row.options.tabBarBadge).toBeUndefined();
        }
    });

    it('draws its own headers rather than a stack header with a floating gear', async () => {
        await renderTabs();
        // `headerShown: false` is in `screenOptions`, so no screen re-enables it.
        for (const row of mockRecorded) expect(row.options.headerShown).toBeUndefined();
    });
});
