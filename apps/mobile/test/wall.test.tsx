import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { WallScreen } from '../src/screens/WallScreen';
import { renderWithProviders } from './render';

describe('Wall', () => {
    it('renders a tile per phone from the mock farm', async () => {
        await renderWithProviders(<WallScreen />);

        await waitFor(() => expect(screen.getByTestId('device-tile-00008030-001A2B3C0E88802E')).toBeTruthy());
        // The number chip carries the slot, so the name does not repeat it.
        expect(screen.getByText('iPhone 8')).toBeTruthy();
        expect(screen.queryByText('iPhone 8 · slot 1')).toBeNull();
        expect(screen.getAllByTestId(/^device-tile-/)).toHaveLength(12);
        expect(screen.getByText('demo data')).toBeTruthy();
    });

    it('numbers the phones 01 upwards, in fleet order', async () => {
        await renderWithProviders(<WallScreen />);
        await screen.findByTestId('device-tile-00008030-001A2B3C0E88802E');
        // The chip itself is hidden from the screen reader — the tile's own
        // label carries the number, so it is not announced twice.
        const labels = screen.getAllByTestId(/^device-tile-/).map((tile) => String(tile.props.accessibilityLabel));
        expect(labels[0]).toBe('01 iPhone 8, busy');
        expect(labels[1]).toBe('02 iPhone 11, online');
        expect(labels[11]).toBe('12 Redmi Note 12, disabled');
    });

    it('summarises the wall the way the design words it', async () => {
        await renderWithProviders(<WallScreen />);
        const summary = await screen.findByTestId('wall-summary');
        // 12 phones, one offline and one disabled → 10 live; three are busy and
        // whichever of those carry a post task are counted as posting.
        expect(summary).toHaveTextContent('10 of 12 live');
        expect(screen.getByText(/needs you/)).toBeTruthy();
    });

    it('labels every tile with its number, name and state for a screen reader', async () => {
        await renderWithProviders(<WallScreen />);
        const tile = await screen.findByTestId('device-tile-9A271FFAZ00K4M');
        // The erroring phone. "needs you", not "error" — the design fixes the word.
        expect(tile.props.accessibilityLabel).toBe('09 Moto G54, needs you');
    });

    it('filters to the phones that need you, and back to all', async () => {
        await renderWithProviders(<WallScreen />);
        await screen.findByTestId('device-tile-00008030-001A2B3C0E88802E');

        await fireEvent.press(screen.getByTestId('wall-filter-needs-you'));
        await waitFor(() => expect(screen.getAllByTestId(/^device-tile-/)).toHaveLength(1));
        expect(screen.getByTestId('device-tile-9A271FFAZ00K4M')).toBeTruthy();

        await fireEvent.press(screen.getByTestId('wall-filter-offline'));
        // One unplugged, one deactivated.
        await waitFor(() => expect(screen.getAllByTestId(/^device-tile-/)).toHaveLength(2));

        await fireEvent.press(screen.getByTestId('wall-filter-all'));
        await waitFor(() => expect(screen.getAllByTestId(/^device-tile-/)).toHaveLength(12));
    });

    it('says an unplugged phone is off the bus rather than showing a blank frame', async () => {
        await renderWithProviders(<WallScreen />);
        await screen.findByTestId('device-tile-RF8M90XYZ03');
        expect(screen.getByText('not on the bus')).toBeTruthy();
    });

    it('opens the selection bar on a long press and closes it on Clear', async () => {
        await renderWithProviders(<WallScreen />);
        const tile = await screen.findByTestId('device-tile-00008030-001A2B3C0E88802E');
        expect(screen.queryByTestId('wall-selection-bar')).toBeNull();

        await fireEvent(tile, 'longPress');
        const bar = await screen.findByTestId('wall-selection-bar');
        expect(bar.props.accessibilityLabel).toBe('1 phones selected');
        expect(screen.getByText('1 phone selected')).toBeTruthy();
        // The four bulk actions the design puts in the bar.
        for (const id of ['wall-bulk-post', 'wall-bulk-warmup', 'wall-bulk-reconnect', 'wall-bulk-pause']) {
            expect(screen.getByTestId(id)).toBeTruthy();
        }

        await fireEvent.press(screen.getByTestId('wall-selection-clear'));
        await waitFor(() => expect(screen.queryByTestId('wall-selection-bar')).toBeNull());
    });

    it('adds a second phone to the selection with a tap once selecting', async () => {
        await renderWithProviders(<WallScreen />);
        const first = await screen.findByTestId('device-tile-00008030-001A2B3C0E88802E');
        await fireEvent(first, 'longPress');
        await screen.findByTestId('wall-selection-bar');

        await fireEvent.press(screen.getByTestId('device-tile-00008101-000E2D3A1A08001E'));
        await waitFor(() => expect(screen.getByText('2 phones selected')).toBeTruthy());
    });

    it('schedules a post on the selection through the bulk API', async () => {
        await renderWithProviders(<WallScreen />);
        const tile = await screen.findByTestId('device-tile-00008101-000E2D3A1A08001E');
        await fireEvent(tile, 'longPress');
        await screen.findByTestId('wall-selection-bar');

        await fireEvent.press(screen.getByTestId('wall-bulk-post'));
        // The bar closes once the farm has taken it.
        await waitFor(() => expect(screen.queryByTestId('wall-selection-bar')).toBeNull(), { timeout: 5_000 });
    });
});
