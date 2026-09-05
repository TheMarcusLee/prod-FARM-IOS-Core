/**
 * Expo push registration and notification deep-linking.
 *
 * The farm has no path to APNs or FCM (plan §4), so the flow is: this app gets
 * an Expo push token, POSTs it to `/api/push/register` with the operator's
 * preferences, and the `farm-push-relay` on the Mac does the fan-out. We
 * re-register on launch and whenever the token changes.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { FarmClient, PushRegistrationInput } from '@farm/client';

export interface NotificationTarget {
    kind: 'device' | 'execution' | 'alerts';
    id?: string;
}

/** The relay sends `data: { eventId, kind, deviceUdid, executionId }`. */
export function targetForNotificationData(data: unknown): NotificationTarget {
    if (!data || typeof data !== 'object') return { kind: 'alerts' };
    const payload = data as Record<string, unknown>;
    if (typeof payload.executionId === 'string' && payload.executionId) {
        return { kind: 'execution', id: payload.executionId };
    }
    if (typeof payload.deviceUdid === 'string' && payload.deviceUdid) {
        return { kind: 'device', id: payload.deviceUdid };
    }
    return { kind: 'alerts' };
}

export function hrefForTarget(target: NotificationTarget): string {
    if (target.kind === 'device' && target.id) return `/device/${encodeURIComponent(target.id)}`;
    if (target.kind === 'execution' && target.id) return `/execution/${encodeURIComponent(target.id)}`;
    return '/alerts';
}

/**
 * Returns the Expo push token, or `null` with a reason the UI can show.
 * A simulator cannot receive push, and saying so beats a silent no-op.
 */
export async function requestExpoPushToken(): Promise<{ token: string | null; reason?: string }> {
    if (!Device.isDevice) return { token: null, reason: 'Push needs a real phone — the simulator cannot register.' };

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
        status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return { token: null, reason: 'Notification permission was declined.' };

    if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('farm-alerts', {
            name: 'Farm alerts',
            importance: Notifications.AndroidImportance.HIGH,
            vibrationPattern: [0, 250, 250, 250],
        });
    }

    const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        (Constants.easConfig as { projectId?: string } | undefined)?.projectId;
    try {
        const response = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
        return { token: response.data };
    } catch (error) {
        return { token: null, reason: `Expo would not issue a token: ${String(error)}` };
    }
}

/**
 * Idempotent on the token server-side, so calling this on every launch and on
 * every preference change is the intended usage.
 */
export async function registerPushToken(
    client: FarmClient,
    input: Omit<PushRegistrationInput, 'expoPushToken'> & { expoPushToken: string },
): Promise<void> {
    await client.registerPush(input);
}

/** Foreground presentation: an alert is worth interrupting for. */
export function configureNotificationHandler(): void {
    Notifications.setNotificationHandler({
        handleNotification: async () => ({
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: true,
            shouldSetBadge: true,
        }),
    });
}
