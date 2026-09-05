import path from 'node:path';

import { WdaRemoteControl } from '../devices/wda-remote.js';
import { pause, runCommand, type CommandRunner } from './common.js';
import {
    DriverError, UnsupportedOperationError,
    type DeviceDriver, type Key, type MediaFile, type Point, type ScreenGeometry, type Swipe, type UiNode,
} from './types.js';

export interface WdaDriverOptions {
    udid: string;
    wdaUrl: string;
    passcode?: string;
    fetchImpl?: typeof fetch;
    /** Override how media reaches the camera roll; defaults to pymobiledevice3 over USB. */
    pushMedia?: (file: MediaFile) => Promise<void>;
    run?: CommandRunner;
}

/** iOS via WebDriverAgent. Wraps the existing WdaRemoteControl so the plugin process and the worker share one client. */
export function createWdaDriver(options: WdaDriverOptions): DeviceDriver {
    const { udid } = options;
    const remote = new WdaRemoteControl({
        deviceUdid: udid,
        wdaUrl: options.wdaUrl,
        passcode: options.passcode,
        fetchImpl: options.fetchImpl,
    });
    const post = (pathname: string, body: unknown) => remote.request(pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const pushMedia = options.pushMedia ?? ((file: MediaFile) => pushMediaWithPymobiledevice3(udid, file, options.run ?? runCommand));

    return {
        kind: 'wda',
        platform: 'ios',
        udid,
        launchApp: async (bundleId) => { await post('/wda/apps/launch', { bundleId }); },
        terminateApp: async (bundleId) => { await post('/wda/apps/terminate', { bundleId }); },
        tap: ({ x, y }: Point) => remote.performAction(udid, { type: 'tap', x, y }),
        swipe: ({ from, to, durationMs }: Swipe) => remote.performAction(udid, {
            type: 'swipe', startX: from.x, startY: from.y, endX: to.x, endY: to.y, durationMs,
        }),
        type: async (text) => { await post('/wda/keys', { value: [...text] }); },
        pressKey: (key) => pressWdaKey(key, remote, udid, post),
        screenshot: () => remote.getScreenshot(udid),
        uiTree: () => fetchWdaTree(remote),
        screen: () => wdaScreenGeometry(remote, udid),
        pushMedia,
        pause,
    };
}

async function pressWdaKey(key: Key, remote: WdaRemoteControl, udid: string, post: (pathname: string, body: unknown) => Promise<Response>): Promise<void> {
    switch (key) {
        case 'home': return remote.performAction(udid, { type: 'home' });
        case 'enter': { await post('/wda/keys', { value: ['\n'] }); return; }
        case 'delete': { await post('/wda/keys', { value: ['\b'] }); return; }
        case 'back': throw new UnsupportedOperationError('wda', 'pressKey(back) — iOS has no back button; swipe from the left edge instead');
    }
}

async function wdaScreenGeometry(remote: WdaRemoteControl, udid: string): Promise<ScreenGeometry> {
    const { screenSize, scale } = await remote.getScreenInfo(udid);
    return { width: screenSize.width, height: screenSize.height, scale };
}

interface WdaSourceNode {
    type?: string;
    name?: string;
    label?: string;
    value?: string;
    rawIdentifier?: string;
    rect?: { x: number; y: number; width: number; height: number };
    isEnabled?: string | boolean;
    children?: WdaSourceNode[];
}

async function fetchWdaTree(remote: WdaRemoteControl): Promise<UiNode> {
    const response = await remote.request('/source?format=json');
    const payload = await response.json() as { value?: WdaSourceNode };
    if (!payload.value) throw new DriverError('WebDriverAgent returned an empty source tree');
    return normaliseWdaNode(payload.value);
}

export function normaliseWdaNode(node: WdaSourceNode): UiNode {
    const rect = node.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    const label = node.label ?? '';
    const text = node.value ?? label;
    const type = node.type ?? '';
    return {
        id: node.rawIdentifier ?? node.name ?? '',
        type,
        text,
        description: label !== text ? label : '',
        bounds: { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height },
        clickable: /Button|Cell|Link|Tab|Switch|Image/.test(type),
        enabled: node.isEnabled === true || node.isEnabled === '1' || node.isEnabled === undefined,
        children: (node.children ?? []).map(normaliseWdaNode),
    };
}

/**
 * WDA cannot write to the camera roll. pymobiledevice3 (pip install pymobiledevice3) can push
 * over USB via AFC; Photos indexes /DCIM on the next launch. Keep this on the sync pass before
 * the posting window, not inside the routine.
 */
async function pushMediaWithPymobiledevice3(udid: string, file: MediaFile, run: CommandRunner): Promise<void> {
    const fileName = file.fileName ?? path.basename(file.localPath);
    await run('pymobiledevice3', ['afc', 'push', '--udid', udid, file.localPath, `/DCIM/100APPLE/${fileName}`], { timeoutMs: 120_000 });
}
