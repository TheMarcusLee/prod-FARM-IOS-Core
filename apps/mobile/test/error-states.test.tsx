/**
 * What each screen does when the Mac does not answer, or answers badly.
 *
 * The first block drives the real provider stack against a configured (not
 * demo) farm with a scripted `fetch`, so `FarmProvider` → `ErrorState` is
 * exercised end to end. The second drives `ErrorState` directly, because a
 * countdown is easier to assert on with fake timers than through a screen.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { FarmError } from '@farm/client';
import { ErrorState } from '../src/components';
import { AlertsScreen } from '../src/screens/AlertsScreen';
import { FleetScreen } from '../src/screens/FleetScreen';
import { QueueScreen } from '../src/screens/QueueScreen';
import { ThemeProvider } from '../src/theme';
import { StorageKeys } from '../src/lib/storage';
import { Providers } from './render';

/** A farm that is configured — so not demo mode — but unreachable. */
async function configureRealFarm(): Promise<void> {
    await AsyncStorage.setItem(
        StorageKeys.settings,
        JSON.stringify({ tailscaleUrl: 'http://farm-mac.ts.net:3000', lanUrl: '', demoMode: false }),
    );
    (require('expo-secure-store') as { getItemAsync: jest.Mock }).getItemAsync.mockResolvedValue('pf_live_abc');
}

function answerWith(reply: () => Response | Promise<Response>): jest.Mock {
    const fetchMock = jest.fn(async () => reply());
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    return fetchMock;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

describe('screens with an unreachable or unhappy farm', () => {
    const realFetch = globalThis.fetch;

    beforeEach(async () => {
        await AsyncStorage.clear();
        jest.clearAllMocks();
    });

    afterEach(() => {
        (globalThis as { fetch: unknown }).fetch = realFetch;
    });

    it('Fleet says it cannot reach the Mac, with nothing cached to fall back on', async () => {
        await configureRealFarm();
        answerWith(() => {
            throw new TypeError('Network request failed');
        });

        await render(<FleetScreen />, { wrapper: Providers });
        await screen.findByTestId('fleet-error', {}, { timeout: 10_000 });
        expect(screen.getByText("Can't reach the Mac")).toBeTruthy();
        expect(screen.getByText(/both on the tailnet/)).toBeTruthy();
    });

    it('Alerts sends a rejected token to Settings rather than offering Try again', async () => {
        await configureRealFarm();
        answerWith(() => json({ error: 'Authentication required' }, 401));

        await render(<AlertsScreen />, { wrapper: Providers });
        await screen.findByTestId('alerts-error', {}, { timeout: 10_000 });
        expect(screen.getByText('That token is not working')).toBeTruthy();
        expect(screen.getByTestId('error-open-settings')).toBeTruthy();
        expect(screen.queryByTestId('error-retry')).toBeNull();
    });

    it('Queue shows the farm\'s own countdown for a 429 and offers no immediate retry', async () => {
        await configureRealFarm();
        answerWith(() => json({ error: 'Rate limit exceeded — retry in 6 seconds' }, 429, { 'retry-after': '6' }));

        await render(<QueueScreen />, { wrapper: Providers });
        await screen.findByTestId('queue-error', {}, { timeout: 10_000 });
        expect(screen.getByText('Slow down')).toBeTruthy();
        expect(screen.getByText(/Try again in 6s/)).toBeTruthy();
        expect(screen.queryByTestId('error-retry')).toBeNull();
    });
});

describe('ErrorState', () => {
    const renderState = (error: FarmError, onRetry?: () => void) =>
        render(<ErrorState error={error} onRetry={onRetry} testID="state" />, { wrapper: ThemeProvider });

    it('counts a rate limit down and only then offers a retry', async () => {
        jest.useFakeTimers();
        const retry = jest.fn();
        await renderState(new FarmError('rate-limited', 'slow down', { status: 429, retryAfterMs: 2_000 }), retry);

        expect(screen.getByText(/Try again in 2s/)).toBeTruthy();
        await act(async () => {
            jest.advanceTimersByTime(2_000);
        });
        // The countdown has run out, so the button is the right thing to show.
        expect(screen.queryByText(/Try again in/)).toBeNull();
        expect(screen.getByTestId('error-retry')).toBeTruthy();
        jest.useRealTimers();
    });

    it('routes a 403 CSRF refusal to Settings, like a 401', async () => {
        await renderState(new FarmError('forbidden', 'Cross-origin write blocked.', { status: 403 }));
        expect(screen.getByText('That token is not working')).toBeTruthy();
        expect(screen.getByTestId('error-open-settings')).toBeTruthy();
    });

    it('keeps Try again for a 503, which is worth another go', async () => {
        const retry = jest.fn();
        await renderState(new FarmError('unavailable', 'The event log is unavailable', { status: 503 }), retry);
        expect(screen.getByText('That part of the farm is down')).toBeTruthy();
        expect(screen.getByTestId('error-retry')).toBeTruthy();
    });

    it('announces the whole failure to a screen reader, not just the headline', async () => {
        await renderState(new FarmError('conflict', 'Remote input is disabled while automation is running'));
        expect(screen.getByTestId('state').props.accessibilityLabel).toBe(
            'The farm said no. Remote input is disabled while automation is running',
        );
    });

    it('never renders the bearer token, whatever the farm put in the message', async () => {
        await renderState(new FarmError('validation', 'rejected pf_live_secret', { status: 400 }));
        // A token in an error body is the farm's problem, but the app must not
        // be the thing that puts one on a screenshot.
        expect(router.push).not.toHaveBeenCalledWith(expect.stringContaining('pf_live'));
    });
});
