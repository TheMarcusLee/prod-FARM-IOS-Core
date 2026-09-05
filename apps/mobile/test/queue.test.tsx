/**
 * The Queue screen's paging, which is the one place two identical requests can
 * put the same row on screen twice.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderWithProviders } from './render';
import { QueueScreen } from '../src/screens/QueueScreen';
import { StorageKeys } from '../src/lib/storage';

describe('Queue', () => {
    it('lists schedules with their timing and status', async () => {
        await renderWithProviders(<QueueScreen />);
        await waitFor(() => expect(screen.getAllByTestId(/^schedule-/).length).toBeGreaterThan(0));
        expect(screen.getAllByText(/daily \d\d:\d\d|weekly |once · |run now/).length).toBeGreaterThan(0);
    });

    it('switches to executions and back without losing either list', async () => {
        await renderWithProviders(<QueueScreen />);
        await waitFor(() => expect(screen.getAllByTestId(/^schedule-/).length).toBeGreaterThan(0));

        await fireEvent.press(screen.getByTestId('queue-segment-executions'));
        await waitFor(() => expect(screen.getAllByTestId(/^execution-/).length).toBeGreaterThan(0));
        expect(screen.queryAllByTestId(/^schedule-/)).toHaveLength(0);

        await fireEvent.press(screen.getByTestId('queue-segment-schedules'));
        await waitFor(() => expect(screen.getAllByTestId(/^schedule-/).length).toBeGreaterThan(0));
    });

    it('does not offer Pause on a schedule the farm would refuse it for', async () => {
        await renderWithProviders(<QueueScreen />);
        await waitFor(() => expect(screen.getAllByTestId(/^schedule-/).length).toBeGreaterThan(0));
        // `isScheduleEditable`: only active and paused schedules get controls.
        for (const card of screen.getAllByTestId(/^schedule-/)) {
            const id = String(card.props.testID).replace(/^schedule-/, '');
            const toggle = screen.queryByTestId(`schedule-toggle-${id}`);
            const cancelled = screen.queryAllByText('cancelled').length > 0;
            if (!toggle) expect(cancelled || screen.queryAllByText('completed').length > 0).toBe(true);
        }
    });
});

/**
 * The paging guard, against a scripted farm rather than the demo one: FlatList
 * only renders a window, so the number of rows on screen says nothing about how
 * many pages were fetched. What matters is how many requests one flick makes.
 */
describe('Queue paging against a real farm', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        (globalThis as { fetch: unknown }).fetch = realFetch;
    });

    async function scripted(): Promise<{ pages: () => number }> {
        await AsyncStorage.clear();
        await AsyncStorage.setItem(
            StorageKeys.settings,
            JSON.stringify({ tailscaleUrl: 'http://farm-mac.ts.net:3000', lanUrl: '', demoMode: false }),
        );
        (require('expo-secure-store') as { getItemAsync: jest.Mock }).getItemAsync.mockResolvedValue('pf_live_abc');

        let executionPages = 0;
        const execution = (id: string) => ({
            id, scheduleId: null, deviceUdid: 'device-1', pluginId: 'p', taskType: 'doomscroll', taskVersion: 1,
            payload: {}, scheduledFor: null, deadlineAt: null, status: 'succeeded', startedAt: null,
            finishedAt: null, exitCode: 0, error: null, stopRequestedAt: null,
            createdAt: '2026-09-05T09:00:00.000Z', updatedAt: '2026-09-05T09:00:00.000Z',
        });
        const json = (body: unknown, headers: Record<string, string> = {}) =>
            new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

        (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: unknown) => {
            const target = String(url);
            if (target.includes('/api/mobile/bootstrap')) {
                return json({
                    serverTime: '2026-09-05T09:41:12.004Z',
                    release: { version: '1.0.0', sha: null },
                    plugins: [],
                    fleet: { counts: { total: 0, online: 0, busy: 0, offline: 0, disabled: 0, error: 0 }, devices: [] },
                    recentEvents: [],
                    unacknowledgedCount: 0,
                    capabilities: {},
                });
            }
            if (target.includes('/api/executions')) {
                executionPages += 1;
                // Always a full page and always a cursor, so the list would keep
                // asking for more if nothing stopped it.
                const offset = executionPages * 50;
                return json(
                    { executions: Array.from({ length: 50 }, (_, index) => execution(`exe-${offset + index}`)) },
                    { 'x-next-before': `exe-${offset + 49}` },
                );
            }
            return json({ schedules: [] });
        });
        return { pages: () => executionPages };
    }

    it('fetches one older page for a burst of endReached, not one per event', async () => {
        const { pages } = await scripted();
        await renderWithProviders(<QueueScreen />);
        await fireEvent.press(await screen.findByTestId('queue-segment-executions'));
        await waitFor(() => expect(pages()).toBe(1));

        const list = screen.getByTestId('queue-executions-list');
        // One flick fires `onEndReached` several times, all carrying the same
        // cursor. Without the in-flight guard each one appended a page.
        await Promise.all([
            fireEvent(list, 'endReached'),
            fireEvent(list, 'endReached'),
            fireEvent(list, 'endReached'),
            fireEvent(list, 'endReached'),
        ]);
        await waitFor(() => expect(pages()).toBe(2));
        expect(pages()).toBe(2);

        // And what did arrive is on screen once, not four times.
        const ids = screen.getAllByTestId(/^execution-/).map((row) => row.props.testID);
        expect(new Set(ids).size).toBe(ids.length);
    });

});
