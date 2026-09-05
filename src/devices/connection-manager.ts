import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bridgePingUrl } from '../drivers/a11y-bridge.js';
import { farmEntryArgs } from '../runtime/farm-entry.js';
import { driverKindOf, platformOf } from '../drivers/select.js';
import { discoverConnectedDeviceUdids } from './discovery.js';
import { activeDevices, loadRegisteredDevices, type RegisteredDevice } from './registry.js';

export type DeviceConnectionPhase = 'disconnected' | 'connecting' | 'unlock-required' | 'ready' | 'error';
export type AppiumConnectionPhase = 'ready' | 'unavailable';

export interface DeviceConnectionStatus {
    udid: string;
    physical: 'connected' | 'disconnected';
    /** Control-channel phase. Named for WDA historically; on Android it reports adb or the bridge. */
    wda: DeviceConnectionPhase;
    appium: AppiumConnectionPhase;
    managed: boolean;
    message: string;
    retryCount: number;
    updatedAt: string;
}

export interface DeviceConnections {
    start(): Promise<void>;
    close(): Promise<void>;
    status(udid: string): DeviceConnectionStatus | undefined;
    statuses(): DeviceConnectionStatus[];
    reconnect(udid: string): Promise<DeviceConnectionStatus | undefined>;
}

interface SupervisorMessage {
    state: DeviceConnectionPhase;
    message: string;
}

interface RuntimeState {
    device: RegisteredDevice;
    status: DeviceConnectionStatus;
    child?: ChildProcess;
    outputBuffer: string;
    retryAt: number;
}

interface ManagerOptions {
    loadDevices?: () => Promise<RegisteredDevice[]>;
    connectedUdids?: () => Promise<string[]>;
    spawnSupervisor?: (device: RegisteredDevice) => ChildProcess;
    endpointReady?: (url: string) => Promise<boolean>;
    pollIntervalMs?: number;
    now?: () => number;
}

const supervisorPrefix = '[wda-state] ';

export function parseSupervisorMessage(line: string): SupervisorMessage | undefined {
    const marker = line.indexOf(supervisorPrefix);
    if (marker < 0) return;
    try {
        const value = JSON.parse(line.slice(marker + supervisorPrefix.length)) as Partial<SupervisorMessage>;
        if (!['disconnected', 'connecting', 'unlock-required', 'ready', 'error'].includes(value.state ?? '')) return;
        if (typeof value.message !== 'string') return;
        return value as SupervisorMessage;
    } catch {
        return;
    }
}

async function defaultEndpointReady(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        return response.ok;
    } catch {
        return false;
    }
}

function defaultSpawnSupervisor(device: RegisteredDevice): ChildProcess {
    const script = fileURLToPath(new URL('./wda/start.ts', import.meta.url));
    return spawn(process.execPath, farmEntryArgs(script, { envFiles: ['.env', '.env.devices'] }), {
        cwd: process.cwd(),
        env: {
            ...process.env,
            IOS_UDID: device.udid,
            WDA_LOCAL_PORT: String(device.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)),
            MJPEG_LOCAL_PORT: String(device.mjpegLocalPort ?? Number(process.env.MJPEG_LOCAL_PORT ?? 9100)),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

export class DeviceConnectionManager implements DeviceConnections {
    private readonly loadDevices: () => Promise<RegisteredDevice[]>;
    private readonly connectedUdids: () => Promise<string[]>;
    private readonly spawnSupervisor: (device: RegisteredDevice) => ChildProcess;
    private readonly endpointReady: (url: string) => Promise<boolean>;
    private readonly pollIntervalMs: number;
    private readonly now: () => number;
    private readonly runtimes = new Map<string, RuntimeState>();
    private timer?: NodeJS.Timeout;
    private pending: Promise<void> = Promise.resolve();
    private running = false;
    private closing = false;
    private appium: AppiumConnectionPhase = 'unavailable';

    constructor(options: ManagerOptions = {}) {
        this.loadDevices = options.loadDevices ?? loadRegisteredDevices;
        this.connectedUdids = options.connectedUdids ?? discoverConnectedDeviceUdids;
        this.spawnSupervisor = options.spawnSupervisor ?? defaultSpawnSupervisor;
        this.endpointReady = options.endpointReady ?? defaultEndpointReady;
        this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
        this.now = options.now ?? Date.now;
    }

    async start(): Promise<void> {
        if (this.timer) return;
        await this.reconcile();
        let lastReconcileError = '';
        this.timer = setInterval(() => {
            // A tick that lands while a pass is still running is dropped, not queued: the next
            // one is two seconds away and would see the same phones.
            if (this.running) return;
            void this.reconcile().catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                if (message === lastReconcileError) return;
                lastReconcileError = message;
                console.error(error);
            });
        }, this.pollIntervalMs);
    }

    status(udid: string): DeviceConnectionStatus | undefined {
        const value = this.runtimes.get(udid)?.status;
        return value ? { ...value } : undefined;
    }

    statuses(): DeviceConnectionStatus[] {
        return Array.from(this.runtimes.values(), ({ status }) => ({ ...status }));
    }

    /**
     * Runs a full pass. Concurrent callers queue behind the pass in flight rather than being
     * dropped, so `reconnect()` always observes a reading taken after it asked for one.
     */
    reconcile(): Promise<void> {
        const run = this.pending.then(() => this.runReconcile());
        this.pending = run.catch(() => undefined);
        return run;
    }

    private async runReconcile(): Promise<void> {
        if (this.closing) return;
        this.running = true;
        try {
            const [allDevices, connected, appiumReady] = await Promise.all([
                this.loadDevices(),
                this.connectedUdids(),
                this.endpointReady(`http://${process.env.APPIUM_HOST ?? '127.0.0.1'}:${Number(process.env.APPIUM_PORT ?? 4725)}/status`),
            ]);
            this.appium = appiumReady ? 'ready' : 'unavailable';
            // Disabled devices are supervised exactly like unregistered ones:
            // their WDA child is stopped and their runtime forgotten.
            const devices = activeDevices(allDevices);
            const registered = new Set(devices.map(({ udid }) => udid));
            for (const [udid, runtime] of this.runtimes) {
                if (!registered.has(udid)) {
                    await this.stopChild(runtime);
                    this.runtimes.delete(udid);
                }
            }
            const attached = new Set(connected);
            await Promise.all(devices.map(async (device) => {
                const runtime = this.runtimes.get(device.udid) ?? this.createRuntime(device);
                runtime.device = device;
                runtime.status.physical = attached.has(device.udid) ? 'connected' : 'disconnected';
                // Android phones have no WDA to supervise; their channel is adb or the on-device bridge.
                if (platformOf(device) === 'android') return this.reconcileAndroid(runtime, attached.has(device.udid));
                if (!runtime.child && this.now() >= runtime.retryAt) this.startChild(runtime);
                const wdaPort = device.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100);
                const ready = attached.has(device.udid)
                    && await this.endpointReady(`http://127.0.0.1:${wdaPort}/status`);
                if (ready) this.update(runtime, 'ready', 'WDA is ready');
                else if (!attached.has(device.udid)) this.update(runtime, 'disconnected', 'Reconnect the USB cable');
                else if (runtime.status.wda === 'ready' || runtime.status.wda === 'disconnected') {
                    this.update(runtime, 'connecting', 'Starting WDA');
                }
            }));
        } finally {
            this.running = false;
        }
    }

    private async reconcileAndroid(runtime: RuntimeState, attached: boolean): Promise<void> {
        const device = runtime.device;
        const wantsBridge = driverKindOf(device) === 'a11y-bridge';
        const bridgeUrl = wantsBridge ? device.android?.bridgeUrl : undefined;
        if (wantsBridge && !bridgeUrl) {
            // Otherwise this reads as a healthy adb phone and the first task fails at driver build.
            this.update(runtime, 'error', 'This device is set to the a11y-bridge driver but has no android.bridgeUrl; re-run the driver setup');
            return;
        }
        if (!bridgeUrl) {
            if (attached) this.update(runtime, 'ready', 'adb is connected');
            else this.update(runtime, 'disconnected', 'Not visible to adb — check the USB cable or wireless debugging');
            return;
        }
        const bridge = await this.endpointReady(bridgePingUrl(bridgeUrl));
        // Over Wi-Fi the bridge answering is the connection; adb is optional once bootstrapped.
        runtime.status.physical = attached || bridge ? 'connected' : 'disconnected';
        if (bridge) this.update(runtime, 'ready', attached ? 'Bridge is ready (adb attached)' : 'Bridge is ready over Wi-Fi');
        else if (attached) this.update(runtime, 'connecting', `adb sees the phone but the bridge at ${bridgeUrl} is not answering; check the accessibility service and the port forward`);
        else this.update(runtime, 'disconnected', 'Neither adb nor the bridge can reach the phone');
    }

    async reconnect(udid: string): Promise<DeviceConnectionStatus | undefined> {
        const runtime = this.runtimes.get(udid);
        if (!runtime) return;
        if (platformOf(runtime.device) === 'android') {
            // There is no child to restart; a fresh pass is the whole of a reconnect. Clear the
            // retry counter so the UI does not keep showing failures from before the replug.
            runtime.status.retryCount = 0;
            runtime.retryAt = 0;
            await this.reconcile();
            return this.status(udid);
        }
        await this.stopChild(runtime);
        runtime.status.retryCount = 0;
        runtime.retryAt = 0;
        this.update(runtime, runtime.status.physical === 'connected' ? 'connecting' : 'disconnected',
            runtime.status.physical === 'connected' ? 'Restarting WDA' : 'Reconnect the USB cable');
        this.startChild(runtime);
        return this.status(udid);
    }

    async close(): Promise<void> {
        this.closing = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        await Promise.all(Array.from(this.runtimes.values(), (runtime) => this.stopChild(runtime)));
    }

    private createRuntime(device: RegisteredDevice): RuntimeState {
        const now = new Date(this.now()).toISOString();
        const runtime: RuntimeState = {
            device,
            outputBuffer: '',
            retryAt: 0,
            status: {
                udid: device.udid,
                physical: 'disconnected',
                wda: 'disconnected',
                appium: this.appium,
                managed: true,
                message: 'Checking USB connection',
                retryCount: 0,
                updatedAt: now,
            },
        };
        this.runtimes.set(device.udid, runtime);
        return runtime;
    }

    private update(runtime: RuntimeState, wda: DeviceConnectionPhase, message: string): void {
        if (runtime.status.wda === wda && runtime.status.message === message
            && runtime.status.appium === this.appium) return;
        runtime.status = {
            ...runtime.status,
            wda,
            appium: this.appium,
            message,
            updatedAt: new Date(this.now()).toISOString(),
        };
    }

    private startChild(runtime: RuntimeState): void {
        if (runtime.child || this.closing) return;
        try {
            const child = this.spawnSupervisor(runtime.device);
            runtime.child = child;
            runtime.outputBuffer = '';
            this.update(runtime, runtime.status.physical === 'connected' ? 'connecting' : 'disconnected',
                runtime.status.physical === 'connected' ? 'Starting WDA' : 'Waiting for the USB cable');
            const consume = (chunk: Buffer | string) => this.consumeOutput(runtime, chunk.toString());
            child.stdout?.on('data', consume);
            child.stderr?.on('data', consume);
            child.once('error', (error) => this.update(runtime, 'error', error.message));
            child.once('exit', (code, signal) => {
                if (runtime.child !== child) return;
                runtime.child = undefined;
                if (this.closing) return;
                runtime.status.retryCount += 1;
                const seconds = [2, 5, 10, 30][Math.min(runtime.status.retryCount - 1, 3)]!;
                runtime.retryAt = this.now() + seconds * 1_000;
                this.update(runtime, runtime.status.physical === 'connected' ? 'error' : 'disconnected',
                    runtime.status.physical === 'connected'
                        ? `WDA supervisor exited ${signal ? `after ${signal}` : `with code ${code ?? 'unknown'}`}; retrying in ${seconds}s`
                        : 'Reconnect the USB cable');
            });
        } catch (error) {
            runtime.status.retryCount += 1;
            runtime.retryAt = this.now() + 2_000;
            this.update(runtime, 'error', error instanceof Error ? error.message : String(error));
        }
    }

    private consumeOutput(runtime: RuntimeState, output: string): void {
        runtime.outputBuffer += output;
        const lines = runtime.outputBuffer.split(/\r?\n/);
        runtime.outputBuffer = lines.pop() ?? '';
        for (const line of lines) {
            const state = parseSupervisorMessage(line);
            if (!state) continue;
            if (state.state === 'error') runtime.status.retryCount += 1;
            if (state.state === 'ready') runtime.status.retryCount = 0;
            this.update(runtime, state.state, state.message);
        }
    }

    private async stopChild(runtime: RuntimeState): Promise<void> {
        const child = runtime.child;
        runtime.child = undefined;
        if (!child || child.exitCode !== null || child.killed) return;
        child.kill('SIGTERM');
        await Promise.race([
            new Promise<void>((resolve) => child.once('exit', () => resolve())),
            new Promise<void>((resolve) => { setTimeout(resolve, 5_000).unref(); }),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
    }
}
