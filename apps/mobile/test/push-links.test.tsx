/**
 * Two things that arrive from outside the app: a notification payload, and the
 * push registration that asks for them.
 */
import { createMockFarm } from '@farm/client';
import {
    hrefForTarget,
    isSafeRouteId,
    registerPushToken,
    resetPushRegistration,
    targetForNotificationData,
} from '../src/lib/push';

describe('notification deep links', () => {
    it('follows a device or execution id the farm could plausibly have minted', () => {
        expect(targetForNotificationData({ deviceUdid: '00008030-001A2B3C0E88802E' })).toEqual({
            kind: 'device',
            id: '00008030-001A2B3C0E88802E',
        });
        // An execution wins: it is the more specific place to land.
        expect(
            targetForNotificationData({
                deviceUdid: '00008030-001A2B3C0E88802E',
                executionId: '0b6d1c77-5e1a-4d33-9b8e-2f5a9c0f7e42',
            }),
        ).toEqual({ kind: 'execution', id: '0b6d1c77-5e1a-4d33-9b8e-2f5a9c0f7e42' });
    });

    it('refuses anything that is not an id and lands on Alerts instead', () => {
        for (const hostile of [
            '../../settings',
            'a/b',
            'x?y=1',
            'https://evil.example/',
            '',
            ' ',
            '-leading-dash',
            'a'.repeat(200),
        ]) {
            expect(isSafeRouteId(hostile)).toBe(false);
            expect(targetForNotificationData({ deviceUdid: hostile })).toEqual({ kind: 'alerts' });
        }
        expect(targetForNotificationData(null)).toEqual({ kind: 'alerts' });
        expect(targetForNotificationData('a string, not an object')).toEqual({ kind: 'alerts' });
        expect(targetForNotificationData({ deviceUdid: 42 })).toEqual({ kind: 'alerts' });
    });

    it('builds a route only for an id it already accepted', () => {
        expect(hrefForTarget({ kind: 'device', id: 'device-1' })).toBe('/device/device-1');
        expect(hrefForTarget({ kind: 'device', id: '../settings' })).toBe('/alerts');
        expect(hrefForTarget({ kind: 'alerts' })).toBe('/alerts');
    });
});

describe('push registration', () => {
    beforeEach(() => resetPushRegistration());

    const input = {
        expoPushToken: 'ExponentPushToken[abcdefghijklmnopqrstuv]',
        name: 'marcus-iphone',
        minSeverity: 'warning' as const,
        kinds: null,
    };

    it('posts once for an unchanged registration, however often it is called', async () => {
        const farm = createMockFarm({ tickMs: 0 });
        const spy = jest.spyOn(farm, 'registerPush');
        await registerPushToken(farm, input);
        await registerPushToken(farm, input);
        await registerPushToken(farm, input);
        expect(spy).toHaveBeenCalledTimes(1);
        farm.dispose();
    });

    it('posts again when the Expo token rotates or the preferences move', async () => {
        const farm = createMockFarm({ tickMs: 0 });
        const spy = jest.spyOn(farm, 'registerPush');
        await registerPushToken(farm, input);
        await registerPushToken(farm, { ...input, expoPushToken: 'ExponentPushToken[rotated0000000000000000]' });
        await registerPushToken(farm, { ...input, minSeverity: 'error' });
        expect(spy).toHaveBeenCalledTimes(3);
        farm.dispose();
    });

    it('retries after a failure rather than remembering it as done', async () => {
        const farm = createMockFarm({ tickMs: 0 });
        const spy = jest
            .spyOn(farm, 'registerPush')
            .mockRejectedValueOnce(new Error('the Mac was asleep'));
        await expect(registerPushToken(farm, input)).rejects.toThrow('the Mac was asleep');
        await registerPushToken(farm, input);
        expect(spy).toHaveBeenCalledTimes(2);
        farm.dispose();
    });
});
