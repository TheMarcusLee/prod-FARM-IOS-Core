import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

import type { DeviceAutomation, PluginProcessSpecification, TaskExecutionContext } from '../plugin.js';
import { discoverConnectedDevices, type Device } from '../devices/discovery.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../devices/registry.js';
import { passcodeForDevice } from '../devices/secrets.js';
import { bridgePingUrl } from '../drivers/a11y-bridge.js';
import { driverForDevice, driverKindOf, platformOf } from '../drivers/select.js';
import type { DeviceDriver } from '../drivers/types.js';
import type { ExecutionRow } from '../database/schema.js';
import type { PluginRegistry } from '../registry.js';
import type { TaskExecutionResult } from '../types.js';
import type { SchedulerRepository } from './repository.js';

async function endpointReady(url: string): Promise<boolean> {
    try {
        return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
        return false;
    }
}

function wdaUrlFor(registered: RegisteredDevice): string {
    return `http://127.0.0.1:${registered.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`;
}

/**
 * Why the device cannot run yet, or undefined when every channel its driver needs is answering.
 * iOS needs the phone on USB plus WDA and Appium; adb needs the phone visible to adb; the bridge
 * only needs its HTTP port, so a phone on Wi-Fi with nothing attached still counts as ready.
 */
export async function readinessProblem(
    registered: RegisteredDevice,
    discovered: boolean,
    ready: (url: string) => Promise<boolean> = endpointReady,
): Promise<string | undefined> {
    switch (driverKindOf(registered)) {
        case 'wda': {
            if (!discovered) return 'device is offline';
            const wdaUrl = wdaUrlFor(registered);
            if (!await ready(`${wdaUrl}/status`)) return `WDA is unavailable at ${wdaUrl}`;
            const appium = `http://${process.env.APPIUM_HOST ?? '127.0.0.1'}:${Number(process.env.APPIUM_PORT ?? 4725)}`;
            if (!await ready(`${appium}/status`)) return `Appium is unavailable at ${appium}`;
            return;
        }
        case 'a11y-bridge': {
            const bridgeUrl = registered.android?.bridgeUrl;
            if (!bridgeUrl) return 'device uses the a11y-bridge driver but has no android.bridgeUrl';
            if (!await ready(bridgePingUrl(bridgeUrl))) return `bridge is unavailable at ${bridgeUrl}`;
            return;
        }
        case 'adb':
            return discovered ? undefined : 'device is not visible to adb';
    }
}

/** What a plugin sees as the device when it is reachable only through the bridge and not through adb. */
function identityFromRegistration(registered: RegisteredDevice): Device {
    return { name: registered.name, udid: registered.udid, osVersion: 'unknown', platform: platformOf(registered) };
}

async function waitForDevice(execution: ExecutionRow, registered: RegisteredDevice, signal: AbortSignal): Promise<Device> {
    let lastProblem = 'device is offline';
    while (Date.now() <= execution.deadlineAt.getTime()) {
        if (signal.aborted) throw new Error('Execution stopped while waiting for the device');
        const discovered = (await discoverConnectedDevices()).find(({ udid }) => udid === execution.deviceUdid);
        const problem = await readinessProblem(registered, Boolean(discovered));
        if (!problem) return discovered ?? identityFromRegistration(registered);
        lastProblem = problem;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(`Execution window expired: ${lastProblem}`);
}

/** The iOS-era automation surface, served by whichever driver the device uses. */
export function automationFromDriver(driver: DeviceDriver): DeviceAutomation {
    return {
        activateApp: (appId) => driver.launchApp(appId),
        terminateApp: (appId) => driver.terminateApp(appId),
        pause: (milliseconds, signal) => driver.pause(milliseconds, signal),
        screenshot: () => driver.screenshot(),
        tap: (x, y) => driver.tap({ x, y }),
        swipe: (startX, startY, endX, endY, durationMs) => driver.swipe({ from: { x: startX, y: startY }, to: { x: endX, y: endY }, durationMs }),
    };
}

/**
 * Variables handed to the plugin child process. DEVICE_* are platform-neutral; IOS_UDID and
 * WDA_URL stay for the existing iOS routines, ANDROID_SERIAL is honoured by adb itself.
 */
export function pluginEnvironment(registered: RegisteredDevice, passcode: string | undefined): Record<string, string> {
    const platform = platformOf(registered);
    const base = { DEVICE_UDID: registered.udid, DEVICE_PLATFORM: platform, DEVICE_DRIVER: driverKindOf(registered) };
    if (platform === 'ios') {
        return { ...base, IOS_UDID: registered.udid, WDA_URL: wdaUrlFor(registered), ...(passcode ? { IOS_PASSCODE: passcode } : {}) };
    }
    const android = registered.android ?? { serial: registered.udid };
    return {
        ...base,
        ANDROID_SERIAL: android.serial,
        ...(android.bridgeUrl ? { A11Y_BRIDGE_URL: android.bridgeUrl } : {}),
        ...(android.bridgeToken ? { A11Y_BRIDGE_TOKEN: android.bridgeToken } : {}),
    };
}

async function runPluginProcess(
    specification: PluginProcessSpecification,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
    onLines: (lines: string[]) => Promise<void>,
): Promise<TaskExecutionResult> {
    const child = spawn(process.execPath, [
        '--env-file-if-exists=.env', '--env-file-if-exists=.env.devices', '--import', 'tsx',
        specification.entrypoint, ...(specification.args ?? []),
    ], { cwd: process.cwd(), env: { ...environment, ...specification.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending: string[] = [];
    const append = (chunk: Buffer | string) => { pending.push(...chunk.toString().split(/\r?\n/).filter(Boolean)); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const flush = async () => {
        if (!pending.length) return;
        const lines = pending;
        pending = [];
        await onLines(lines);
    };
    const timer = setInterval(() => void flush().catch(console.error), 3_000);
    let stopped = false;
    const stop = () => {
        stopped = true;
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
        const result = await new Promise<TaskExecutionResult>((resolve) => {
            child.once('error', (error) => resolve({ exitCode: null, stopped, error: error.message }));
            child.once('exit', (exitCode, childSignal) => resolve({
                exitCode,
                stopped,
                ...(exitCode === 0 ? {} : {
                    error: childSignal ? `Plugin process stopped by ${childSignal}` : `Plugin process exited with ${exitCode}`,
                }),
            }));
        });
        await flush();
        return result;
    } finally {
        clearInterval(timer);
        signal.removeEventListener('abort', stop);
    }
}

export async function executeAutomation(
    repository: SchedulerRepository,
    plugins: PluginRegistry,
    execution: ExecutionRow,
    attempt: number,
    signal: AbortSignal,
): Promise<TaskExecutionResult> {
    const registered = (await loadRegisteredDevices()).find(({ udid }) => udid === execution.deviceUdid);
    if (!registered) return { exitCode: null, stopped: false, error: 'Device is not registered' };
    if (Date.now() > execution.deadlineAt.getTime()) {
        return { exitCode: null, stopped: false, error: 'Execution window expired before the worker claimed the task' };
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    const stopPoll = setInterval(() => void repository.stopRequested(execution.id).then((requested) => {
        if (requested) controller.abort(new Error('Stop requested'));
    }).catch(console.error), 1_000);
    let device: Device;
    try {
        device = await waitForDevice(execution, registered, controller.signal);
    } catch (error) {
        clearInterval(stopPoll);
        signal.removeEventListener('abort', forwardAbort);
        return { exitCode: null, stopped: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) };
    }
    const workspaceDirectory = await mkdtemp(`${os.tmpdir()}/phone-farm-${execution.id}-`);
    const task = { pluginId: execution.pluginId, taskType: execution.taskType, taskVersion: execution.taskVersion, payload: execution.payload };
    try {
        const definition = plugins.task(task);
        const passcode = platformOf(registered) === 'ios' ? await passcodeForDevice(device.udid) : undefined;
        const driver = driverForDevice(registered, { passcode });
        const environment: NodeJS.ProcessEnv = { ...process.env, ...pluginEnvironment(registered, passcode) };
        const context: TaskExecutionContext = {
            executionId: execution.id,
            attempt,
            workspaceDirectory,
            device,
            devicePluginData: registered.pluginData[execution.pluginId] ?? {},
            automation: automationFromDriver(driver),
            driver,
            assets: await repository.executionAssets(execution),
            signal: controller.signal,
            log: (line) => repository.appendLogs(execution.id, attempt, [line]),
            runProcess: (specification) => runPluginProcess(specification, environment, controller.signal, (lines) => repository.appendLogs(execution.id, attempt, lines)),
        };
        return await definition.execute(context, execution.payload);
    } catch (error) {
        return { exitCode: null, stopped: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) };
    } finally {
        clearInterval(stopPoll);
        signal.removeEventListener('abort', forwardAbort);
        await rm(workspaceDirectory, { recursive: true, force: true });
    }
}
