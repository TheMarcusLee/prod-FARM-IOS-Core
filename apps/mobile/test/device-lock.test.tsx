/**
 * "Touch is locked while a post runs. Hold to unlock."
 *
 * The bar is the only way in, the hold is 800 ms, and it still goes through the
 * biometric gate — a long press is a deliberate act, not an authenticated one.
 * A refused Face ID must leave the bar locked.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { DeviceScreen } from '../src/screens/DeviceScreen';
import { renderWithProviders } from './render';

const BUSY_DEVICE = '00008030-001A2B3C0E88802E';

function authentication(): jest.Mock {
    return (require('expo-local-authentication') as { authenticateAsync: jest.Mock }).authenticateAsync;
}

describe('the device screen lock', () => {
    beforeEach(() => {
        authentication().mockReset();
        authentication().mockResolvedValue({ success: true });
    });

    it('starts locked, with the design\'s wording', async () => {
        await renderWithProviders(<DeviceScreen udid={BUSY_DEVICE} />);
        const bar = await screen.findByTestId('device-lock-bar');
        expect(screen.getByText('Touch is locked while a post runs. Hold to unlock.')).toBeTruthy();
        expect(bar.props.accessibilityLabel).toBe('Touch is locked. Hold to unlock.');
    });

    it('unlocks on a hold, after the biometric prompt', async () => {
        await renderWithProviders(<DeviceScreen udid={BUSY_DEVICE} />);
        const bar = await screen.findByTestId('device-lock-bar');

        await fireEvent(bar, 'longPress');
        await waitFor(() => expect(screen.getByText(/Touch is live for \d+s\. Tap to lock\./)).toBeTruthy());
        expect(authentication()).toHaveBeenCalledTimes(1);
    });

    it('stays locked when the biometric prompt is refused', async () => {
        authentication().mockResolvedValue({ success: false });
        await renderWithProviders(<DeviceScreen udid={BUSY_DEVICE} />);
        const bar = await screen.findByTestId('device-lock-bar');

        await fireEvent(bar, 'longPress');
        await waitFor(() => expect(authentication()).toHaveBeenCalled());
        expect(screen.getByText('Touch is locked while a post runs. Hold to unlock.')).toBeTruthy();
    });

    it('does not unlock on a plain tap — the gesture is a hold', async () => {
        await renderWithProviders(<DeviceScreen udid={BUSY_DEVICE} />);
        const bar = await screen.findByTestId('device-lock-bar');

        await fireEvent.press(bar);
        expect(authentication()).not.toHaveBeenCalled();
        expect(screen.getByText('Touch is locked while a post runs. Hold to unlock.')).toBeTruthy();
    });

    it('locks again on a tap once it is live', async () => {
        await renderWithProviders(<DeviceScreen udid={BUSY_DEVICE} />);
        const bar = await screen.findByTestId('device-lock-bar');

        await fireEvent(bar, 'longPress');
        await waitFor(() => expect(screen.getByText(/Touch is live/)).toBeTruthy());

        await fireEvent.press(bar);
        await waitFor(() =>
            expect(screen.getByText('Touch is locked while a post runs. Hold to unlock.')).toBeTruthy(),
        );
    });

    it('keeps the hardware keys inert while touch is locked', async () => {
        await renderWithProviders(<DeviceScreen udid={BUSY_DEVICE} />);
        const home = await screen.findByTestId('device-key-home');
        expect(home.props.accessibilityState.disabled).toBe(true);

        await fireEvent(await screen.findByTestId('device-lock-bar'), 'longPress');
        await waitFor(() => expect(screen.getByTestId('device-key-home').props.accessibilityState.disabled).toBe(false));
    });

    it('draws the header the mockup draws: number, name and a state line', async () => {
        await renderWithProviders(<DeviceScreen udid={BUSY_DEVICE} />);
        await screen.findByTestId('device-lock-bar');
        expect(screen.getByText('01')).toBeTruthy();
        expect(screen.getByText('iPhone 8')).toBeTruthy();
        // "Busy · what it is doing · live 2 fps", as the mockup words it.
        expect(screen.getByTestId('device-state-line')).toHaveTextContent(/^Busy · .+ · live 2 fps$/);
    });
});

/**
 * Recents and Power were drawn but inert — the farm had no verb for either. It
 * does now (`adb` keyevents 187 and 26; the WDA lock on iOS), so the two keys
 * send like the rest. Recents is Android-only, because iOS has no such key.
 */
describe('the recents and power keys', () => {
    const ANDROID_DEVICE = 'R58N12ABCDF';

    beforeEach(() => {
        authentication().mockReset();
        authentication().mockResolvedValue({ success: true });
    });

    async function unlocked(udid: string) {
        await renderWithProviders(<DeviceScreen udid={udid} />);
        await fireEvent(await screen.findByTestId('device-lock-bar'), 'longPress');
        await waitFor(() => expect(screen.getByTestId('device-key-power').props.accessibilityState.disabled).toBe(false));
    }

    it('are both live on an Android phone once touch is unlocked', async () => {
        await unlocked(ANDROID_DEVICE);
        expect(screen.getByTestId('device-key-recents').props.accessibilityState.disabled).toBe(false);

        // Neither press raises "the farm has no … action yet".
        const alert = jest.spyOn(require('react-native').Alert, 'alert');
        await fireEvent.press(screen.getByTestId('device-key-recents'));
        await fireEvent.press(screen.getByTestId('device-key-power'));
        await waitFor(() => expect(alert).not.toHaveBeenCalled());
        alert.mockRestore();
    });

    it('offers power but not recents on an iPhone', async () => {
        await unlocked(BUSY_DEVICE);
        expect(screen.getByTestId('device-key-power').props.accessibilityState.disabled).toBe(false);
        expect(screen.getByTestId('device-key-recents').props.accessibilityState.disabled).toBe(true);
    });
});
