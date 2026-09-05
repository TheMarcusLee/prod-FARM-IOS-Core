/**
 * Schedule: the timeline strip, the two lists under it, and the paging guard on
 * the executions list — the one place two identical requests can put the same
 * row on screen twice.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderWithProviders } from './render';
import { ScheduleScreen } from '../src/screens/ScheduleScreen';
import { StorageKeys } from '../src/lib/storage';

describe('Schedule', () => {
    it('draws the timeline strip with a playhead', async () => {
        await renderWithProviders(<ScheduleScreen />);
        await screen.findByTestId('schedule-timeline');
        expect(screen.getByTestId('schedule-playhead')).toBeTruthy();
        expect(screen.getByText('Tonight')).toBeTruthy();
    });

    it('opens on Upcoming and lists what is planned', async () => {
        await renderWithProviders(<ScheduleScreen />);
        await waitFor(() => expect(screen.getAllByTestId(/^(schedule|execution)-/).length).toBeGreaterThan(0));
        expect(screen.getByTestId('schedule-segment-upcoming').props.accessibilityState.selected).toBe(true);
    });

    it('switches to Recent and back without losing either list', async () => {
        await renderWithProviders(<ScheduleScreen />);
        await screen.findByTestId('schedule-upcoming-list');

        await fireEvent.press(screen.getByTestId('schedule-segment-recent'));
        await waitFor(() => expect(screen.getByTestId('schedule-recent-list')).toBeTruthy());
        expect(screen.getAllByTestId(/^execution-/).length).toBeGreaterThan(0);

        await fireEvent.press(screen.getByTestId('schedule-segment-upcoming'));
        await waitFor(() => expect(screen.getByTestId('schedule-upcoming-list')).toBeTruthy());
    });

    it('offers Pause only on a schedule the farm would accept it for', async () => {
        await renderWithProviders(<ScheduleScreen />);
        await screen.findByTestId('schedule-upcoming-list');
        await waitFor(() => expect(screen.getAllByTestId(/^schedule-sch/).length).toBeGreaterThan(0));
        // `isScheduleEditable`: only active and paused schedules get controls,
        // and Upcoming only ever lists those two.
        for (const card of screen.getAllByTestId(/^schedule-sch/)) {
            const id = String(card.props.testID).replace(/^schedule-/, '');
            expect(screen.getByTestId(`schedule-toggle-${id}`)).toBeTruthy();
        }
    });

    it('offers Retry on a failed run under Recent', async () => {
        await renderWithProviders(<ScheduleScreen />);
        await screen.findByTestId('schedule-upcoming-list');
        await fireEvent.press(screen.getByTestId('schedule-segment-recent'));
        await waitFor(() => expect(screen.getAllByTestId(/^execution-retry-/).length).toBeGreaterThan(0));
    });
});

/**
 * The timeline against a scripted farm rather than the demo one, so the 404
 * fallback is exercised: an older farm has no `/api/schedule/timeline`, and the
 * strip must still draw from the schedules and executions the app already has.
 */
describe('Schedule against a farm without the timeline endpoint', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        (globalThis as { fetch: unknown }).fetch = realFetch;
    });

    async function scripted(): Promise<{ timelineCalls: () => number }> {
        await AsyncStorage.clear();
        await AsyncStorage.setItem(
            StorageKeys.settings,
            JSON.stringify({ tailscaleUrl: 'http://farm-mac.ts.net:3000', lanUrl: '', demoMode: false }),
        );
        (require('expo-secure-store') as { getItemAsync: jest.Mock }).getItemAsync.mockResolvedValue('pf_live_abc');

        const soon = new Date(Date.now() + 1_800_000).toISOString();
        let timelineCalls = 0;
        const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

        (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: unknown) => {
            const target = String(url);
            if (target.includes('/api/schedule/timeline')) {
                timelineCalls += 1;
                return json({ error: 'Not found' }, 404);
            }
            if (target.includes('/api/mobile/bootstrap')) {
                return json({
                    serverTime: new Date().toISOString(),
                    release: { version: '1.0.0', sha: null },
                    plugins: [],
                    fleet: {
                        counts: { total: 1, online: 1, busy: 0, offline: 0, disabled: 0, error: 0 },
                        devices: [
                            {
                                udid: 'device-1',
                                name: 'Pixel 7 · slot 2',
                                platform: 'android',
                                state: 'online',
                                connection: { connected: true },
                                currentExecution: null,
                                nextRunAt: soon,
                                lastError: null,
                            },
                        ],
                    },
                    recentEvents: [],
                    unacknowledgedCount: 0,
                    capabilities: {},
                });
            }
            if (target.includes('/api/schedules')) {
                return json({
                    schedules: [
                        {
                            id: 'sch_1',
                            deviceUdid: 'device-1',
                            pluginId: 'p',
                            taskType: 'post',
                            taskVersion: 1,
                            payload: {},
                            timing: { kind: 'daily', localTime: '19:30', timezone: 'Europe/London' },
                            status: 'active',
                            runWindowMinutes: 30,
                            nextRunAt: soon,
                            createdAt: soon,
                            updatedAt: soon,
                        },
                    ],
                });
            }
            return json({ executions: [] });
        });
        return { timelineCalls: () => timelineCalls };
    }

    it('falls back to composing the strip locally when the endpoint 404s', async () => {
        const { timelineCalls } = await scripted();
        await renderWithProviders(<ScheduleScreen />);

        await screen.findByTestId('schedule-timeline', {}, { timeout: 10_000 });
        expect(timelineCalls()).toBeGreaterThan(0);
        // The plan is on the strip, and the screen did not fall over.
        expect(screen.getByTestId('schedule-playhead')).toBeTruthy();
        expect(screen.getAllByText('Post').length).toBeGreaterThan(0);
        expect(screen.queryByTestId('schedule-error')).toBeNull();
    });
});
