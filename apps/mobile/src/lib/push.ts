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

/**
 * A notification payload arrives from off-device, so it is input, not data this
 * app produced. An id is only followed if it looks like one the farm mints:
 * device UDIDs and execution UUIDs/ULIDs are all `[A-Za-z0-9._:-]`, and nothing
 * the farm issues is anywhere near 128 characters. Anything else — a path
 * traversal, a `?`, a URL — falls back to the Alerts tab rather than being
 * pushed at the router.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isSafeRouteId(value: unknown): value is string {
    return typeof value === 'string' && SAFE_ID.test(value);
}

/** The relay sends `data: { eventId, kind, deviceUdid, executionId }`. */
export function targetForNotificationData(data: unknown): NotificationTarget {
    if (!data || typeof data !== 'object') return { kind: 'alerts' };
    const payload = data as Record<string, unknown>;
    if (isSafeRouteId(payload.executionId)) return { kind: 'execution', id: payload.executionId };
    if (isSafeRouteId(payload.deviceUdid)) return { kind: 'device', id: payload.deviceUdid };
    return { kind: 'alerts' };
}

export function hrefForTarget(target: NotificationTarget): string {
    if (target.kind === 'device' && isSafeRouteId(target.id)) return `/device/${encodeURIComponent(target.id)}`;
    if (target.kind === 'execution' && isSafeRouteId(target.id)) return `/execution/${encodeURIComponent(target.id)}`;
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
 * `POST /api/push/register` upserts on the Expo token, so calling this on every
 * launch and on every preference change is the intended usage — the farm
 * answers `201` the first time and `200` after that.
 *
 * The guard here is only about not making the same call twice in one process:
 * an unchanged registration is skipped so a settings tap does not fire a write
 * per keystroke. `reset()` on a client swap, because the *other* Mac has never
 * heard of this phone.
 */
let lastRegistered: string | null = null;

export function resetPushRegistration(): void {
    lastRegistered = null;
}

export async function registerPushToken(
    client: FarmClient,
    input: Omit<PushRegistrationInput, 'expoPushToken'> & { expoPushToken: string },
): Promise<void> {
    const fingerprint = JSON.stringify([input.expoPushToken, input.name, input.minSeverity, input.kinds ?? null]);
    if (fingerprint === lastRegistered) return;
    await client.registerPush(input);
    // Only on success: a failed registration must be retried on the next launch.
    lastRegistered = fingerprint;
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
