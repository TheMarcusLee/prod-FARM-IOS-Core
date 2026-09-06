import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

import type { DeviceAutomation, PluginProcessSpecification, TaskExecutionContext } from '../plugin.js';
import { connectedDevices, type Device } from '../devices/discovery.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../devices/registry.js';
import { passcodeForDevice } from '../devices/secrets.js';
import { bridgePingUrl } from '../drivers/a11y-bridge.js';
import { driverForDevice, driverKindOf, platformOf } from '../drivers/select.js';
import type { DeviceDriver } from '../drivers/types.js';
import type { ExecutionRow } from '../database/schema.js';
import { motionProfileFor } from '../motion/profile.js';
import { createRng, seedForExecution } from '../motion/rng.js';
import { farmEntryArgs } from '../runtime/farm-entry.js';
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
            // launchApp, terminateApp and pushMedia fall through to adb (see drivers/select.ts), so a
            // phone answering only on the bridge would start a run and fail on its first launch step.
            if (!discovered && !registered.android?.bridgeOnly) {
                return 'bridge is up but the device is not visible to adb, which the bridge driver still needs '
                    + 'for launch, terminate and media push — set android.bridgeOnly to run without it';
            }
            return;
        }
        case 'adb':
            return discovered ? undefined : 'device is not visible to adb';
    }
}

/**
 * `RUN_START_JITTER_MINUTES`: either `4` (meaning 0–4) or `1-6`. Two phones on the same schedule
 * are claimed within the same tick and would otherwise start their runs in the same second, which
 * is the one thing no two people ever do.
 */
export const DEFAULT_START_JITTER_MINUTES = { min: 0, max: 4 } as const;

export function parseStartJitterMinutes(raw: string | undefined): { min: number; max: number } {
    if (raw === undefined || raw.trim() === '') return { ...DEFAULT_START_JITTER_MINUTES };
    const parts = raw.split('-').map((part) => Number(part.trim()));
    const [first, second] = parts.length === 1 ? [0, parts[0]!] : parts;
    if (parts.length > 2 || !Number.isFinite(first) || !Number.isFinite(second!) || first! < 0 || second! < first!) {
        throw new Error(`RUN_START_JITTER_MINUTES must be a number of minutes or a "min-max" range; received ${raw}`);
    }
    return { min: first!, max: second! };
}

/**
 * How long this execution waits before it starts. Seeded from the execution id, so a run that
 * misbehaved can be replayed exactly, and capped at half the time left in the run window: a
 * jitter that ran to the deadline would guarantee the run never happened.
 */
export function startJitterMs(
    executionId: string,
    nowMs: number,
    deadlineMs: number,
    raw = process.env.RUN_START_JITTER_MINUTES,
): number {
    const { min, max } = parseStartJitterMinutes(raw);
    if (max <= 0) return 0;
    const drawn = (min + createRng(`${executionId}:start-jitter`)() * (max - min)) * 60_000;
    const remaining = Math.max(0, deadlineMs - nowMs);
    return Math.max(0, Math.round(Math.min(drawn, remaining / 2)));
}

/** A sleep that ends early on a stop, without turning the stop into a failure. */
function waitOut(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (milliseconds <= 0 || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, milliseconds);
        signal.addEventListener('abort', done, { once: true });
    });
}

/** What a plugin sees as the device when it is reachable only through the bridge and not through adb. */
function identityFromRegistration(registered: RegisteredDevice): Device {
    return { name: registered.name, udid: registered.udid, osVersion: 'unknown', platform: platformOf(registered) };
}

async function waitForDevice(execution: ExecutionRow, registered: RegisteredDevice, signal: AbortSignal): Promise<Device> {
    let lastProblem = 'device is offline';
    while (Date.now() <= execution.deadlineAt.getTime()) {
        if (signal.aborted) throw new Error('Execution stopped while waiting for the device');
        // Cached for a couple of seconds and shared: a worker with several executions waiting on
        // their phones used to run one full USB enumeration per execution per 5 s tick.
        const discovered = (await connectedDevices()).find(({ udid }) => udid === execution.deviceUdid);
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
export function pluginEnvironment(
    registered: RegisteredDevice,
    passcode: string | undefined,
    motionSeed?: string,
): Record<string, string> {
    const platform = platformOf(registered);
    const profile = motionProfileFor(registered.udid, registered.motion);
    const base = {
        DEVICE_UDID: registered.udid, DEVICE_PLATFORM: platform, DEVICE_DRIVER: driverKindOf(registered),
        // The routine's own gestures and pauses come from this seed, so a run replays from its id.
        ...(motionSeed ? { MOTION_SEED: motionSeed } : {}),
        MOTION_HAND: profile.hand, MOTION_SPEED: profile.speed,
    };
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

/**
 * The plugin child process is handed A11Y_BRIDGE_TOKEN and IOS_PASSCODE, and everything it
 * prints is appended verbatim to the execution log the dashboard renders and PostgreSQL keeps.
 * One routine echoing its environment, or a stack trace carrying an Authorization header, would
 * put a live credential in storage for good — so every line goes through here on the way out.
 */
export function createLogRedactor(secrets: Array<string | undefined>): (line: string) => string {
    // Short values would match half the log; a bridge token is a uuid and a passcode is four
    // digits at minimum, so the floor only excludes what was never a usable secret anyway.
    const values = [...new Set(secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length >= 4))]
        // Longest first, so a token that contains another secret is replaced whole.
        .sort((left, right) => right.length - left.length);
    return (line) => {
        let value = line.replace(
            /\b(A11Y_BRIDGE_TOKEN|IOS_PASSCODE)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
            (_match, name: string) => `${name}=<redacted>`,
        );
        for (const secret of values) value = value.split(secret).join('<redacted>');
        return value;
    };
}

async function runPluginProcess(
    specification: PluginProcessSpecification,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
    onLines: (lines: string[]) => Promise<void>,
): Promise<TaskExecutionResult> {
    const child = spawn(process.execPath, [
        ...farmEntryArgs(specification.entrypoint, { envFiles: ['.env', '.env.devices'] }),
        ...(specification.args ?? []),
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
    const motionSeed = String(seedForExecution(execution.id));
    const jitterMs = startJitterMs(execution.id, Date.now(), execution.deadlineAt.getTime());
    let device: Device;
    try {
        await repository.appendLogs(execution.id, attempt, [
            `Motion seed ${motionSeed} (${motionProfileFor(registered.udid, registered.motion).hand}-handed, `
            + `${motionProfileFor(registered.udid, registered.motion).speed}); start jitter ${(jitterMs / 1000).toFixed(1)}s`,
        ]);
        await waitOut(jitterMs, controller.signal);
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
        const driver = driverForDevice(registered, { passcode, motionSeed });
        const redact = createLogRedactor([passcode, registered.android?.bridgeToken]);
        const environment: NodeJS.ProcessEnv = { ...process.env, ...pluginEnvironment(registered, passcode, motionSeed) };
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
            runProcess: (specification) => runPluginProcess(
                specification, environment, controller.signal,
                (lines) => repository.appendLogs(execution.id, attempt, lines.map(redact)),
            ),
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
