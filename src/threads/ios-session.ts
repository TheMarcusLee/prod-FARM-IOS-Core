import { remote, type Browser } from 'webdriverio';

import { loadRegisteredDevices } from '../devices/registry.js';
import { resolveDeviceCoordinates, type ThreadsCoordinates } from '../devices/coordinates.js';
import { WdaRemoteControl } from '../devices/wda-remote.js';
import { coordinateProfile } from '../tiktok/runtime-settings.js';
import { findHandleMatch, pointFromWord, recognizeWords } from '../tiktok/ocr.js';
import { tapCoordinate } from '../tiktok/actions.js';
import type { MotionSource } from '../motion/source.js';

/**
 * What the two iOS Threads routines share: the Appium session, the coordinate profile, and the
 * account switch.
 *
 * iOS drives Threads the way it drives TikTok — WebDriverAgent and fixed coordinates rather than
 * the accessibility tree — because XCUITest cannot see into either app's feed. Every coordinate
 * comes from the device's profile (`threads` in `src/devices/coordinates.ts`) and **every value
 * in the shipped profile is a guess**; see docs/coordinates.md.
 */

export const THREADS_IOS_BUNDLE_ID = 'com.burbn.barcelona';

export function bundleId(): string {
    return process.env.THREADS_BUNDLE_ID?.trim() || THREADS_IOS_BUNDLE_ID;
}

export function positiveInteger(name: string, fallback: number): number {
    const raw = process.env[name] ?? String(fallback);
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
}

export function booleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`${name} must be 'true' or 'false'; received ${raw}`);
}

export function boundedInteger(name: string, fallback: number, min: number, max: number): number {
    const value = positiveInteger(name, fallback);
    if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}; received ${value}`);
    return value;
}

export interface ThreadsDeviceContext {
    threads: ThreadsCoordinates;
    screenSize: { width: number; height: number };
    remote: WdaRemoteControl;
}

/** The device's coordinate profile plus an unlocked phone, before any app is opened. */
export async function prepareDevice(udid: string): Promise<ThreadsDeviceContext> {
    const registered = (await loadRegisteredDevices()).find((device) => device.udid === udid);
    const coordinates = resolveDeviceCoordinates(coordinateProfile(registered), registered?.coordinates);
    const control = new WdaRemoteControl({ deviceUdid: udid, passcodeKeypadLayout: coordinates.passcodeKeypad });
    console.log('Checking device lock state');
    await control.unlock(udid);
    return { threads: coordinates.threads, screenSize: coordinates.screenSize, remote: control };
}

export async function openSession(udid: string): Promise<Browser> {
    const app = bundleId();
    const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
        platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': udid,
        'appium:bundleId': app, 'appium:noReset': true, 'appium:forceAppLaunch': true,
        'appium:shouldTerminateApp': true, 'appium:newCommandTimeout': 180,
        'appium:waitForIdleTimeout': 0,
    };
    if (process.env.WDA_URL) {
        capabilities['appium:webDriverAgentUrl'] = process.env.WDA_URL;
        capabilities['appium:wdaRemotePort'] = positiveInteger('WDA_REMOTE_PORT', 8100);
    }
    const driver = await remote({
        hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
        port: positiveInteger('APPIUM_PORT', 4725),
        path: '/', logLevel: 'info', connectionRetryCount: 0, connectionRetryTimeout: 180_000,
        capabilities,
    });
    await driver.updateSettings({ defaultActiveApplication: app });
    return driver;
}

/**
 * Profile tab → the handle in the header → the row for the account we want, located by OCR
 * because XCUITest cannot read Threads' own switcher sheet. Verified by reading the header back:
 * posting from the wrong account is the one outcome that cannot be undone.
 */
export async function switchThreadsAccount(
    driver: Browser, control: WdaRemoteControl, udid: string, handle: string,
    coordinates: ThreadsCoordinates, motion?: MotionSource,
): Promise<void> {
    console.log(`Switching to Threads account "${handle}"`);
    const { scale } = await control.getScreenInfo(udid);
    await tapCoordinate(driver, coordinates.profileTab.x, coordinates.profileTab.y, 'Profile tab', motion);
    await driver.pause(2_000);

    const alreadyThere = findHandleMatch(await recognizeWords(await control.getScreenshot(udid)), handle);
    if (alreadyThere) {
        console.log(`Already on Threads account ${handle}`);
        return;
    }

    await tapCoordinate(driver, coordinates.accountSwitcher.x, coordinates.accountSwitcher.y, 'account switcher', motion);
    await driver.pause(2_000);
    const row = findHandleMatch(await recognizeWords(await control.getScreenshot(udid)), handle);
    if (!row) throw new Error(`Threads account "${handle}" is not in the switcher on ${udid}`);
    const point = pointFromWord(row, scale);
    await tapCoordinate(driver, point.x, point.y, `account row for ${handle}`, motion);
    // Threads reloads app state after a switch.
    await driver.pause(6_000);

    await tapCoordinate(driver, coordinates.profileTab.x, coordinates.profileTab.y, 'Profile tab (verify)', motion);
    await driver.pause(2_500);
    if (!findHandleMatch(await recognizeWords(await control.getScreenshot(udid)), handle)) {
        throw new Error(`Switched but could not confirm Threads account "${handle}" is active on ${udid}`);
    }
    console.log(`Confirmed active Threads account: ${handle}`);
}
