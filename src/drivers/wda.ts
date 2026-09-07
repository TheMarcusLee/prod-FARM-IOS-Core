import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { WdaRemoteControl } from '../devices/wda-remote.js';
import type { MotionSettings } from '../motion/profile.js';
import type { Seed } from '../motion/rng.js';
import { driverMotion, straightPath, type MotionSource } from '../motion/source.js';
import { pause } from './common.js';
import {
    DriverError, UnsupportedOperationError,
    type DeviceDriver, type Key, type MediaFile, type Point, type ScreenGeometry, type Swipe,
    type TimedPoint, type UiNode,
} from './types.js';

export interface WdaDriverOptions {
    udid: string;
    wdaUrl: string;
    passcode?: string;
    fetchImpl?: typeof fetch;
    /** Handedness and pace for the generated swipe arcs; defaults to the udid's stable profile. */
    motion?: MotionSettings;
    /** One seed per run, so a replay draws the same paths. Defaults to `MOTION_SEED` or the clock. */
    motionSeed?: Seed;
    /** Override how media reaches the camera roll; defaults to the fork's `/wda/import-media` endpoint. */
    pushMedia?: (file: MediaFile) => Promise<void>;
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
    const pushMedia = options.pushMedia ?? ((file: MediaFile) => pushMediaViaWda(file, post));
    let hand: MotionSource | undefined;
    const motion = () => (hand ??= driverMotion(udid, options.motion, options.motionSeed));
    const gesture = (path: TimedPoint[]) => remote.performAction(udid, { type: 'gesture', path });

    return {
        kind: 'wda',
        platform: 'ios',
        udid,
        launchApp: async (bundleId) => { await post('/wda/apps/launch', { bundleId }); },
        terminateApp: async (bundleId) => { await post('/wda/apps/terminate', { bundleId }); },
        tap: ({ x, y }: Point) => remote.performAction(udid, { type: 'tap', x, y }),
        swipe: ({ from, to, durationMs, straight }: Swipe) => gesture(
            straight ? straightPath(from, to, durationMs) : motion().path(from, to, durationMs),
        ),
        gesture,
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
        case 'power': return remote.performAction(udid, { type: 'power' });
        case 'wake': return remote.performAction(udid, { type: 'wake' });
        case 'back': throw new UnsupportedOperationError('wda', 'pressKey(back) — iOS has no back button; swipe from the left edge instead');
        case 'recents': throw new UnsupportedOperationError('wda', 'pressKey(recents) — iOS has no recents key; double-press Home or swipe up and hold instead');
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

const MAX_IMPORT_BYTES = 350 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.gif': 'image/gif',
};

export function mimeTypeForFileName(fileName: string): string {
    return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * This fork patches WebDriverAgent with `/wda/import-media`, which saves a base64 body into the
 * Photos library (see tiktok/post.ts). The base64 copy plus JSON.stringify's copy put the practical
 * ceiling near 350 MB, so refuse larger files with a clear message instead of an OOM.
 */
async function pushMediaViaWda(file: MediaFile, post: (pathname: string, body: unknown) => Promise<Response>): Promise<void> {
    const fileName = file.fileName ?? path.basename(file.localPath);
    const data = await readFile(file.localPath);
    if (data.length > MAX_IMPORT_BYTES) {
        throw new DriverError(`${fileName} is ${(data.length / 1_048_576).toFixed(0)} MB; the WDA media import limit is 350 MB`);
    }
    const response = await post('/wda/import-media', {
        name: fileName, mimeType: file.mimeType ?? mimeTypeForFileName(fileName), data: data.toString('base64'),
    });
    const result = await response.json() as { value?: { error?: unknown; assetCount?: number } };
    if (result.value && typeof result.value === 'object' && 'error' in result.value) {
        throw new DriverError(`WebDriverAgent could not import ${fileName}: ${JSON.stringify(result.value.error)}`);
    }
}
