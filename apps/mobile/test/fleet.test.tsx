import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { FleetScreen } from '../src/screens/FleetScreen';
import { renderWithProviders } from './render';

describe('Fleet', () => {
    it('renders a card per device from the mock farm', async () => {
        await renderWithProviders(<FleetScreen />);

        await waitFor(() => expect(screen.getByTestId('device-card-00008030-001A2B3C0E88802E')).toBeTruthy());
        expect(screen.getByText('iPhone 8 · slot 1')).toBeTruthy();
        expect(screen.getByText('Pixel 6a · slot 3')).toBeTruthy();
        // 12 devices, and the demo data is labelled as such.
        expect(screen.getAllByTestId(/^device-card-/)).toHaveLength(12);
        expect(screen.getByText('demo data')).toBeTruthy();
    });

    it('shows the up/total summary from the fleet counts', async () => {
        await renderWithProviders(<FleetScreen />);
        const summary = await screen.findByTestId('fleet-summary');
        // 12 total, minus one offline, one disabled and one erroring → 9 up.
        expect(summary).toHaveTextContent('9/12 up');
    });

    it('renders the derived state and the current run on a busy card', async () => {
        await renderWithProviders(<FleetScreen />);
        await screen.findByTestId('device-card-00008030-001A2B3C0E88802E');
        expect(screen.getAllByText('busy').length).toBeGreaterThanOrEqual(3);
        expect(screen.getAllByText(/Doomscroll for \d+ minutes|Post for \d+ minutes/).length).toBeGreaterThan(0);
    });

    it('filters down to the busy devices when the chip is tapped', async () => {
        await renderWithProviders(<FleetScreen />);
        await screen.findByTestId('device-card-00008030-001A2B3C0E88802E');

        await fireEvent.press(screen.getByTestId('fleet-filter-busy'));
        await waitFor(() => expect(screen.getAllByTestId(/^device-card-/).length).toBe(3));

        await fireEvent.press(screen.getByTestId('fleet-filter-all'));
        await waitFor(() => expect(screen.getAllByTestId(/^device-card-/).length).toBe(12));
    });

    it('filters by device tag', async () => {
        await renderWithProviders(<FleetScreen />);
        await screen.findByTestId('device-card-00008030-001A2B3C0E88802E');
        await fireEvent.press(screen.getByTestId('fleet-filter-tag:posting'));
        await waitFor(() => {
            const cards = screen.getAllByTestId(/^device-card-/);
            expect(cards.length).toBeGreaterThan(0);
            expect(cards.length).toBeLessThan(12);
        });
    });

    it('renders an offline device with the connection message rather than "idle"', async () => {
        await renderWithProviders(<FleetScreen />);
        await screen.findByTestId('device-card-RF8M90XYZ03');
        expect(screen.getByText('Not attached — check the cable')).toBeTruthy();
    });
});
