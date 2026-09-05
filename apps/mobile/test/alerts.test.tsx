import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AlertsScreen } from '../src/screens/AlertsScreen';
import { renderWithProviders } from './render';

describe('Alerts', () => {
    it('renders the event list from the mock farm', async () => {
        await renderWithProviders(<AlertsScreen />);
        await waitFor(() => expect(screen.getAllByTestId(/^event-/).length).toBeGreaterThan(5));
        expect(screen.getAllByText('Run failed').length).toBeGreaterThan(0);
    });

    it('says the stream is live once SSE is subscribed', async () => {
        await renderWithProviders(<AlertsScreen />);
        await waitFor(() => expect(screen.getByTestId('alerts-stream-status')).toHaveTextContent('live'));
    });

    it('narrows to errors when the severity chip is tapped', async () => {
        await renderWithProviders(<AlertsScreen />);
        await waitFor(() => expect(screen.getAllByTestId(/^event-/).length).toBeGreaterThan(5));
        const all = screen.getAllByTestId(/^event-/).length;

        await fireEvent.press(screen.getByTestId('alerts-severity-error'));
        await waitFor(() => {
            const errors = screen.getAllByTestId(/^event-/);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.length).toBeLessThan(all);
        });
        // Only error-severity kinds survive the filter.
        expect(screen.queryByText('Run finished')).toBeNull();
    });

    it('narrows to device events when the group chip is tapped', async () => {
        await renderWithProviders(<AlertsScreen />);
        await waitFor(() => expect(screen.getAllByTestId(/^event-/).length).toBeGreaterThan(5));

        await fireEvent.press(screen.getByTestId('alerts-group-device'));
        await waitFor(() => expect(screen.queryByText('Run failed')).toBeNull());
        expect(screen.getAllByTestId(/^event-/).length).toBeGreaterThan(0);
    });

    it('offers acknowledge-all and clears the count', async () => {
        await renderWithProviders(<AlertsScreen />);
        const button = await screen.findByTestId('ack-all');
        expect(button).toBeTruthy();

        await fireEvent.press(button);
        await waitFor(() => expect(screen.queryByTestId('ack-all')).toBeNull());
    });

    it('renders the farm\'s operator-facing title and message verbatim', async () => {
        await renderWithProviders(<AlertsScreen />);
        await waitFor(() => expect(screen.getAllByTestId(/^event-/).length).toBeGreaterThan(5));
        expect(screen.getAllByText(/failed on .+ · slot \d+/).length).toBeGreaterThan(0);
        expect(screen.getAllByText('TikTok did not reach the feed after 3 attempts').length).toBeGreaterThan(0);
    });
});
