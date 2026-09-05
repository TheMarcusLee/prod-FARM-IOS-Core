import assert from 'node:assert/strict';
import test from 'node:test';

import type { DeviceConnectionStatus } from '../src/devices/connection-manager.js';
import { connectedFleetUdids } from '../src/fleet/connectivity.js';

function status(udid: string, physical: 'connected' | 'disconnected'): DeviceConnectionStatus {
    return { udid, physical, wda: physical === 'connected' ? 'ready' : 'disconnected', appium: 'unavailable', managed: true, message: '', retryCount: 0, updatedAt: '' };
}

test('a bridge phone the connection manager sees over Wi-Fi counts as connected without adb', async () => {
    const udids = await connectedFleetUdids({
        discover: async () => ['iphone-1', 'R58N1'],
        statuses: async () => [status('R58N1', 'connected'), status('wifi-pixel', 'connected'), status('shelf', 'disconnected')],
    });
    assert.deepEqual(udids.sort(), ['R58N1', 'iphone-1', 'wifi-pixel']);
});

test('either source failing degrades to the other', async () => {
    assert.deepEqual(await connectedFleetUdids({
        discover: async () => { throw new Error('adb missing'); },
        statuses: async () => [status('wifi-pixel', 'connected')],
    }), ['wifi-pixel']);
    assert.deepEqual(await connectedFleetUdids({
        discover: async () => ['iphone-1'],
        statuses: async () => { throw new Error('wda-service socket down'); },
    }), ['iphone-1']);
});
