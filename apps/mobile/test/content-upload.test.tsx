/**
 * The Content screen's "Add clip": picking from the library, watching the
 * percentage move, and cancelling. The upload itself is the mock farm's, which
 * reports the same `UploadProgress` shape the real client does.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

const mockPicker = {
    granted: true,
    result: {
        canceled: false,
        assets: [{ uri: 'file:///clip.mov', fileName: 'IMG_0042.mov', type: 'video', mimeType: 'video/quicktime' }],
    } as { canceled: boolean; assets: unknown[] },
};

jest.mock('expo-image-picker', () => ({
    requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: mockPicker.granted })),
    launchImageLibraryAsync: jest.fn(async () => mockPicker.result),
}));

import { ContentScreen } from '../src/screens/ContentScreen';
import { renderWithProviders } from './render';

/** React Native reads a local `file://` through `fetch`; jsdom has no such thing. */
function stubFetch(size: number): jest.Mock {
    const blob = { size, type: 'video/quicktime', slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) };
    const fetchMock = jest.fn(async () => ({ blob: async () => blob }));
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    return fetchMock;
}

describe('Content: add a clip', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        (globalThis as { fetch?: unknown }).fetch = originalFetch;
        mockPicker.granted = true;
        mockPicker.result = {
            canceled: false,
            assets: [{ uri: 'file:///clip.mov', fileName: 'IMG_0042.mov', type: 'video', mimeType: 'video/quicktime' }],
        };
    });

    it('offers the button and uploads the picked clip with a percentage', async () => {
        stubFetch(24 * 1024 * 1024);
        await renderWithProviders(<ContentScreen />);
        const add = await screen.findByTestId('content-add');

        await fireEvent.press(add);

        const row = await screen.findByTestId('content-upload');
        expect(row).toBeTruthy();
        expect(screen.getByText('IMG_0042.mov')).toBeTruthy();
        await waitFor(() => expect(screen.getByTestId('content-upload-status')).toHaveTextContent(/Uploading · \d+%/));
        // The row goes away once the farm has the file.
        await waitFor(() => expect(screen.queryByTestId('content-upload')).toBeNull(), { timeout: 4_000 });
    });

    it('says nothing happened when the picker is cancelled', async () => {
        stubFetch(1024);
        mockPicker.result = { canceled: true, assets: [] };
        await renderWithProviders(<ContentScreen />);

        await fireEvent.press(await screen.findByTestId('content-add'));
        expect(screen.queryByTestId('content-upload')).toBeNull();
    });

    it('drops the row when the operator cancels the upload', async () => {
        stubFetch(80 * 1024 * 1024);
        await renderWithProviders(<ContentScreen />);

        await fireEvent.press(await screen.findByTestId('content-add'));
        await screen.findByTestId('content-upload');
        await fireEvent.press(screen.getByTestId('content-upload-cancel'));
        await waitFor(() => expect(screen.queryByTestId('content-upload')).toBeNull());
    });
});
