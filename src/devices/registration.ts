import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remote, type Browser } from 'webdriverio';

import { bridgePingUrl } from '../drivers/a11y-bridge.js';
import { errorMessage, runCommand, type CommandRunner } from '../drivers/common.js';
import { driverForDevice } from '../drivers/select.js';
import type { DeviceDriver, DriverKind, Platform } from '../drivers/types.js';
import { switchTikTokAccount, tapCoordinate } from '../tiktok/actions.js';
import { coordinateProfiles, coordinatesForProfile, profileForProductType, type CoordinateProfile } from './coordinates.js';
import { devicePlatform, discoverConnectedDevices, type Device } from './discovery.js';
import {
    BRIDGE_DEVICE_PORT, BRIDGE_LOCAL_PORT, BRIDGE_PACKAGE, createAndroidProbe, type AndroidProbe,
} from './registration-android.js';
import { loadRegisteredDevices, mutateRegisteredDevices, type RegisteredDevice } from './registry.js';
import { passcodeForDevice, setDevicePasscode } from './secrets.js';
import { WdaRemoteControl } from './wda-remote.js';
import { diagnoseWdaLaunchFailure } from './wda/diagnostics.js';

export type RegistrationCheckState = 'pending' | 'checking' | 'blocked' | 'passed' | 'failed';
export type RegistrationAction = 'refresh' | 'prepare' | 'verify' | 'finalize';
export type RegistrationCheckName = 'host' | 'connection' | 'signing' | 'developer'
    | 'wda' | 'appium' | 'video' | 'touch' | 'tiktok' | 'accounts' | 'driver';

export interface RegistrationCheck {
    state: RegistrationCheckState;
    message: string;
    updatedAt: string;
}

export interface RegistrationSnapshot {
    id: string;
    device: Device;
    name: string;
    /** Decides which check set runs; taken from the discovered candidate. */
    platform: Platform;
    /** Android only: which control channel the phone will be driven through. */
    driver?: DriverKind;
    /** Android + a11y-bridge: local end of `adb forward`, and the URL the driver will use. */
    bridgePort?: number;
    bridgeUrl?: string;
    /** The checks this platform runs, in the order the wizard shows them. */
    checkNames: RegistrationCheckName[];
    coordinateProfile?: CoordinateProfile;
    availableProfiles: Array<{ name: CoordinateProfile; displayName: string; screenSize: { width: number; height: number } }>;
    recommendedProfile?: CoordinateProfile;
    wdaLocalPort: number;
    mjpegLocalPort: number;
    tiktokAccounts: string[];
    hasPasscode: boolean;
    busy: boolean;
    /** Only the names in `checkNames` are populated. */
    checks: Partial<Record<RegistrationCheckName, RegistrationCheck>>;
    logs: string[];
    canFinalize: boolean;
    finalized: boolean;
}

export interface RegistrationUpdate {
    name?: string;
    coordinateProfile?: string;
    tiktokAccounts?: string[];
    passcode?: string;
    /** Android only: 'adb' or 'a11y-bridge'. */
    driver?: string;
    /** Android + a11y-bridge: local forwarded port, or an explicit base URL for the Wi-Fi build. */
    bridgePort?: number;
    bridgeUrl?: string;
}

interface RegistrationSession extends RegistrationSnapshot {
    passcode?: string;
    supervisor?: ChildProcess;
    /** Read from the bridge ContentProvider during prepare; never leaves the process in a snapshot. */
    bridgeToken?: string;
}

export interface DeviceRegistrationManager {
    start(): Promise<void>;
    close(): Promise<void>;
    candidates(): Promise<Device[]>;
    create(udid: string): Promise<RegistrationSnapshot>;
    get(id: string): Promise<RegistrationSnapshot | undefined>;
    update(id: string, input: RegistrationUpdate): Promise<RegistrationSnapshot>;
    run(id: string, action: RegistrationAction, options?: { authorizeTeamRegistration?: boolean }): Promise<RegistrationSnapshot>;
    cancel(id: string): Promise<void>;
}

interface RegistrationManagerOptions {
    repositoryRoot?: string;
    discoverDevices?: () => Promise<Device[]>;
    loadDevices?: () => Promise<RegisteredDevice[]>;
    stateDirectory?: string;
    fetchImpl?: typeof fetch;
    /** Every adb call goes through here, so tests never spawn adb. */
    runCommand?: CommandRunner;
    /** Android live checks build the chosen driver through this; overridden with a fake in tests. */
    createDriver?: (device: RegisteredDevice) => DeviceDriver;
}

const iosCheckNames: RegistrationCheckName[] = [
    'host', 'connection', 'signing', 'developer', 'wda', 'appium', 'video', 'touch', 'tiktok', 'accounts',
];

const androidCheckNames: RegistrationCheckName[] = [
    'host', 'connection', 'developer', 'driver', 'video', 'touch', 'tiktok', 'accounts',
];

export function checkNamesForPlatform(platform: Platform): RegistrationCheckName[] {
    return platform === 'android' ? [...androidCheckNames] : [...iosCheckNames];
}

function now(): string {
    return new Date().toISOString();
}

function check(state: RegistrationCheckState, message: string): RegistrationCheck {
    return { state, message, updatedAt: now() };
}

function publicSnapshot(session: RegistrationSession): RegistrationSnapshot {
    const { passcode: _passcode, supervisor: _supervisor, bridgeToken: _bridgeToken, ...snapshot } = session;
    return structuredClone(snapshot);
}

/** A check the platform does not run reads as `pending`, so callers never need a null test. */
function stateOf(session: RegistrationSnapshot, name: RegistrationCheckName): RegistrationCheckState {
    return session.checks[name]?.state ?? 'pending';
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function isPng(image: Buffer): boolean {
    return image.length > PNG_MAGIC.length && image.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

function normalizeAccounts(accounts: string[]): string[] {
    const normalized = accounts.map((value) => value.trim()).filter(Boolean).map((value) => value.startsWith('@') ? value : `@${value}`);
    return Array.from(new Set(normalized));
}

function sanitizedLine(line: string): string {
    return line
        .replace(/IOS_PASSCODE[^\s=]*=\S+/gi, 'IOS_PASSCODE=<redacted>')
        .replace(/(-?password\s*[=:]\s*)\S+/gi, '$1<redacted>')
        .slice(0, 1_000);
}

async function portAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
}

export function allocateDevicePorts(devices: RegisteredDevice[], reserved: Array<{ wdaLocalPort: number; mjpegLocalPort: number }> = []): Promise<{ wdaLocalPort: number; mjpegLocalPort: number }> {
    return (async () => {
        const used = new Set<number>();
        for (const device of devices) {
            used.add(device.wdaLocalPort ?? 8100);
            used.add(device.mjpegLocalPort ?? 9100);
        }
        for (const pair of reserved) {
            used.add(pair.wdaLocalPort);
            used.add(pair.mjpegLocalPort);
        }
        for (let offset = 0; offset < 1_000; offset += 1) {
            const wdaLocalPort = 8100 + offset;
            const mjpegLocalPort = 9100 + offset;
            if (used.has(wdaLocalPort) || used.has(mjpegLocalPort)) continue;
            if (await portAvailable(wdaLocalPort) && await portAvailable(mjpegLocalPort)) {
                return { wdaLocalPort, mjpegLocalPort };
            }
        }
        throw new Error('No free WDA/MJPEG port pair is available');
    })();
}

export class DeviceRegistrationService implements DeviceRegistrationManager {
    private readonly workspaceRoot: string;
    private readonly packageRoot: string;
    private readonly discoverDevices: () => Promise<Device[]>;
    private readonly loadDevices: () => Promise<RegisteredDevice[]>;
    private readonly stateDirectory: string;
    private readonly fetch: typeof fetch;
    private readonly android: AndroidProbe;
    private readonly createDriver: (device: RegisteredDevice) => DeviceDriver;
    private readonly sessions = new Map<string, RegistrationSession>();
    private activePreparation?: string;

    constructor(options: RegistrationManagerOptions = {}) {
        this.android = createAndroidProbe(options.runCommand ?? runCommand);
        this.createDriver = options.createDriver ?? ((device) => driverForDevice(device));
        this.workspaceRoot = options.repositoryRoot ?? process.cwd();
        this.packageRoot = fileURLToPath(new URL('../../', import.meta.url));
        this.discoverDevices = options.discoverDevices ?? discoverConnectedDevices;
        this.loadDevices = options.loadDevices ?? loadRegisteredDevices;
        this.stateDirectory = options.stateDirectory ?? path.join(this.workspaceRoot, '.wda/registrations');
        this.fetch = options.fetchImpl ?? fetch;
    }

    async start(): Promise<void> {
        await mkdir(this.stateDirectory, { recursive: true });
        for (const entry of await readdir(this.stateDirectory)) {
            if (!entry.endsWith('.json')) continue;
            try {
                const stored = JSON.parse(await readFile(path.join(this.stateDirectory, entry), 'utf8')) as RegistrationSnapshot & {
                    compatibleProfiles?: CoordinateProfile[];
                };
                if (!stored.finalized) {
                    const recommendedProfile = stored.recommendedProfile ?? profileForProductType(stored.device.productType);
                    const hasPasscode = Boolean(await passcodeForDevice(stored.id, { allowLegacyFallback: false }));
                    // Drafts written before the platform split have neither field.
                    const platform = stored.platform ?? devicePlatform(stored.device);
                    const restored: RegistrationSession & { compatibleProfiles?: CoordinateProfile[] } = {
                    ...stored,
                    platform,
                    checkNames: stored.checkNames ?? checkNamesForPlatform(platform),
                    availableProfiles: coordinateProfiles().map(({ name, displayName, screenSize }) => ({ name, displayName, screenSize })),
                    ...(recommendedProfile ? { recommendedProfile } : {}),
                    coordinateProfile: stored.coordinateProfile ?? recommendedProfile,
                    busy: false,
                    hasPasscode,
                    };
                    delete restored.compatibleProfiles;
                    this.sessions.set(stored.id, restored);
                }
            } catch {
                // Ignore an incomplete local draft and let the user start again.
            }
        }
    }

    async close(): Promise<void> {
        await Promise.all(Array.from(this.sessions.values(), (session) => this.stopSupervisor(session)));
    }

    async candidates(): Promise<Device[]> {
        const [connected, registered] = await Promise.all([this.discoverDevices(), this.loadDevices()]);
        const known = new Set(registered.map(({ udid }) => udid));
        return connected.filter(({ udid }) => !known.has(udid) || this.sessions.get(udid)?.finalized === false);
    }

    async create(udid: string): Promise<RegistrationSnapshot> {
        const existing = this.sessions.get(udid);
        if (existing) {
            await this.refreshFor(existing);
            existing.recommendedProfile ??= profileForProductType(existing.device.productType);
            if (!existing.coordinateProfile && existing.recommendedProfile) existing.coordinateProfile = existing.recommendedProfile;
            await this.persist(existing);
            return publicSnapshot(existing);
        }
        const candidate = (await this.candidates()).find((device) => device.udid === udid);
        if (!candidate) throw new Error('The selected device is not connected or is already registered');
        const platform = devicePlatform(candidate);
        const names = checkNamesForPlatform(platform);
        // Android phones have no WebDriverAgent, so they claim no host ports.
        const ports = platform === 'android'
            ? { wdaLocalPort: 0, mjpegLocalPort: 0 }
            : await allocateDevicePorts(await this.loadDevices(), Array.from(this.sessions.values()));
        const checks = Object.fromEntries(names.map((name) => [name, check('pending', 'Not checked yet')])) as RegistrationSession['checks'];
        const session: RegistrationSession = {
            id: udid,
            device: candidate,
            name: candidate.name,
            platform,
            checkNames: names,
            ...(platform === 'android' ? { driver: 'adb' as DriverKind, bridgePort: BRIDGE_LOCAL_PORT } : {}),
            availableProfiles: coordinateProfiles().map(({ name, displayName, screenSize }) => ({ name, displayName, screenSize })),
            ...(platform === 'android' ? {} : {
                recommendedProfile: profileForProductType(candidate.productType),
                coordinateProfile: profileForProductType(candidate.productType),
            }),
            ...ports,
            tiktokAccounts: [],
            hasPasscode: false,
            busy: false,
            checks,
            logs: [],
            canFinalize: false,
            finalized: false,
        };
        this.sessions.set(udid, session);
        await this.refreshFor(session);
        return publicSnapshot(session);
    }

    async get(id: string): Promise<RegistrationSnapshot | undefined> {
        const session = this.sessions.get(id);
        return session ? publicSnapshot(session) : undefined;
    }

    async update(id: string, input: RegistrationUpdate): Promise<RegistrationSnapshot> {
        const session = this.required(id);
        if (session.busy) throw new Error('Wait for the current registration check to finish');
        if (input.name !== undefined) {
            const name = input.name.trim();
            if (!name) throw new Error('Device name is required');
            session.name = name.slice(0, 100);
        }
        if (input.coordinateProfile !== undefined) {
            if (!session.availableProfiles.some(({ name }) => name === input.coordinateProfile)) {
                throw new Error('Unknown coordinate profile');
            }
            session.coordinateProfile = input.coordinateProfile as CoordinateProfile;
        }
        if (input.driver !== undefined) {
            if (session.platform !== 'android') throw new Error('Only Android devices choose a driver');
            if (input.driver !== 'adb' && input.driver !== 'a11y-bridge') throw new Error('driver must be "adb" or "a11y-bridge"');
            if (session.driver !== input.driver) {
                session.driver = input.driver;
                session.bridgeToken = undefined;
                session.checks.driver = check('pending', input.driver === 'adb'
                    ? 'Recheck the adb channel' : 'Bootstrap the accessibility bridge');
            }
        }
        if (input.bridgePort !== undefined) {
            if (session.platform !== 'android') throw new Error('Only Android devices use a bridge port');
            if (!Number.isInteger(input.bridgePort) || input.bridgePort < 1 || input.bridgePort > 65_535) {
                throw new Error('Bridge port must be a TCP port number');
            }
            session.bridgePort = input.bridgePort;
        }
        if (input.bridgeUrl !== undefined) {
            if (session.platform !== 'android') throw new Error('Only Android devices use a bridge URL');
            const value = input.bridgeUrl.trim();
            if (value && !/^https?:\/\/\S+$/.test(value)) throw new Error('Bridge URL must be an http(s) URL');
            session.bridgeUrl = value || undefined;
        }
        if (input.tiktokAccounts !== undefined) session.tiktokAccounts = normalizeAccounts(input.tiktokAccounts);
        if (input.passcode !== undefined) {
            if (input.passcode && !/^\d{4,}$/.test(input.passcode)) throw new Error('Device passcode must contain at least four digits');
            session.passcode = input.passcode || undefined;
            session.hasPasscode = Boolean(input.passcode);
        }
        session.checks.accounts = check('pending', 'Verify the configured TikTok accounts');
        this.recalculate(session);
        await this.persist(session);
        return publicSnapshot(session);
    }

    async run(id: string, action: RegistrationAction, options: { authorizeTeamRegistration?: boolean } = {}): Promise<RegistrationSnapshot> {
        const session = this.required(id);
        if (session.busy) throw new Error('A registration action is already running');
        const usesXcode = action === 'prepare' && session.platform === 'ios';
        if (usesXcode && this.activePreparation && this.activePreparation !== id) {
            throw new Error('Another device is currently being provisioned by Xcode');
        }
        if (action === 'finalize') {
            session.busy = true;
            try {
                return await (session.platform === 'android' ? this.finalizeAndroid(session) : this.finalize(session));
            } finally {
                session.busy = false;
                await this.persist(session);
            }
        }
        if (usesXcode) this.activePreparation = id;
        const android = session.platform === 'android';
        session.busy = true;
        void (async () => {
            try {
                if (action === 'refresh') await this.refreshFor(session);
                if (action === 'prepare') {
                    await (android ? this.prepareAndroid(session) : this.prepare(session, Boolean(options.authorizeTeamRegistration)));
                }
                if (action === 'verify') await (android ? this.verifyAndroid(session) : this.verify(session));
            } catch (error) {
                this.log(session, error instanceof Error ? error.message : String(error));
            } finally {
                if (usesXcode && this.activePreparation === id) this.activePreparation = undefined;
                session.busy = false;
                this.recalculate(session);
                await this.persist(session).catch((error: unknown) => {
                    this.log(session, `Failed to persist registration state: ${error instanceof Error ? error.message : String(error)}`);
                });
            }
        })().catch((error: unknown) => {
            console.error('Registration background task crashed:', error);
        });
        await this.persist(session);
        return publicSnapshot(session);
    }

    async cancel(id: string): Promise<void> {
        const session = this.required(id);
        await this.stopSupervisor(session);
        this.sessions.delete(id);
        await rm(this.statePath(id), { force: true });
    }

    private required(id: string): RegistrationSession {
        const session = this.sessions.get(id);
        if (!session) throw new Error('Registration draft not found');
        return session;
    }

    /** The one place that picks a platform's checks; every caller goes through it. */
    private refreshFor(session: RegistrationSession): Promise<void> {
        return session.platform === 'android' ? this.refreshAndroid(session) : this.refresh(session);
    }

    private async refresh(session: RegistrationSession): Promise<void> {
        session.checks.host = check('checking', 'Checking local iOS tooling');
        session.checks.connection = check('checking', 'Checking the USB device');
        const driverProject = path.resolve(this.workspaceRoot, process.env.XCUITEST_DRIVER_PATH
            ?? '.appium2/node_modules/appium-xcuitest-driver', 'node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj');
        try {
            await Promise.all([access(driverProject), access(process.env.XCODE_DEVELOPER_DIR ?? '/Applications/Xcode_26.2.app/Contents/Developer')]);
            session.checks.host = check('passed', 'Xcode, XCUITest, and WebDriverAgent are available');
        } catch {
            session.checks.host = check('blocked', 'Install the repository XCUITest driver and configure XCODE_DEVELOPER_DIR');
        }
        const connected = (await this.discoverDevices()).find(({ udid }) => udid === session.device.udid);
        if (connected) {
            session.device = connected;
            session.recommendedProfile = profileForProductType(connected.productType);
            session.coordinateProfile ??= session.recommendedProfile;
            session.checks.connection = check('passed', `${connected.name} is connected, paired, and readable over USB`);
        } else {
            session.checks.connection = check('blocked', 'Reconnect USB, unlock the device, and accept Trust This Computer');
        }
        const signingValues = ['XCODE_ORG_ID', 'WDA_BUNDLE_ID'].filter((name) => !process.env[name]);
        session.checks.signing = signingValues.length
            ? check('blocked', `Configure ${signingValues.join(' and ')} in .env after signing in to Xcode`)
            : check('passed', 'Shared WDA signing settings are configured');
        await this.inspectWda(session);
        await this.inspectTikTok(session);
        await this.persist(session);
    }

    private async prepare(session: RegistrationSession, authorized: boolean): Promise<void> {
        if (stateOf(session, 'connection') !== 'passed' || stateOf(session, 'host') !== 'passed') {
            throw new Error('Connect and trust the device and complete host setup before preparing WDA');
        }
        session.checks.signing = check('checking', 'Building and provisioning WebDriverAgent');
        session.checks.developer = check('checking', 'Checking Developer Mode through an Xcode device build');
        session.checks.wda = check('checking', 'Preparing WebDriverAgent');
        const prepareScript = path.join(this.packageRoot, 'src/devices/wda/prepare.ts');
        const result = await this.runCommand(session, process.execPath, [
            '--env-file-if-exists=.env', '--env-file-if-exists=.env.devices', '--import', 'tsx', prepareScript,
        ], {
            ...process.env,
            IOS_UDID: session.device.udid,
            WDA_LOCAL_PORT: String(session.wdaLocalPort),
            MJPEG_LOCAL_PORT: String(session.mjpegLocalPort),
            ALLOW_PROVISIONING_DEVICE_REGISTRATION: String(authorized),
        });
        if (!result.ok) {
            const diagnosis = diagnoseWdaLaunchFailure(result.output) ?? 'WDA preparation failed; inspect the sanitized setup log';
            const target: RegistrationCheckName = /Developer Mode/i.test(diagnosis) ? 'developer' : 'signing';
            session.checks[target] = check('blocked', diagnosis);
            session.checks.wda = check('failed', diagnosis);
            return;
        }
        session.checks.signing = check('passed', 'Xcode signing and provisioning succeeded');
        session.checks.developer = check('passed', 'The device accepted an Xcode development build');
        await this.startSupervisor(session);
        const ready = await this.waitForEndpoint(`http://127.0.0.1:${session.wdaLocalPort}/status`, 120_000);
        if (!ready) {
            session.checks.wda = check('blocked', 'WDA did not become ready; unlock the phone and trust WebDriverAgent under VPN & Device Management if prompted');
            return;
        }
        session.checks.wda = check('passed', 'WebDriverAgent is installed, running, and reachable');
        await this.refreshScreenProfiles(session);
    }

    private async verify(session: RegistrationSession): Promise<void> {
        await this.inspectWda(session);
        if (stateOf(session, 'wda') !== 'passed') throw new Error('Prepare and start WDA before runtime verification');
        if (!session.coordinateProfile) throw new Error('Choose a coordinate profile that matches the device screen');
        session.checks.appium = check('checking', 'Creating a no-reset Appium session');
        session.checks.video = check('checking', 'Reading the WDA video stream');
        session.checks.touch = check('checking', 'Checking mapped TikTok touch input');
        session.checks.accounts = check('checking', 'Verifying TikTok accounts with OCR');
        await this.inspectTikTok(session);
        if (stateOf(session, 'tiktok') !== 'passed') return;
        const control = new WdaRemoteControl({
            deviceUdid: session.device.udid,
            wdaUrl: `http://127.0.0.1:${session.wdaLocalPort}`,
            mjpegUrl: `http://127.0.0.1:${session.mjpegLocalPort}`,
            passcode: session.passcode ?? await passcodeForDevice(session.device.udid, { allowLegacyFallback: false }),
            passcodeKeypadLayout: coordinatesForProfile(session.coordinateProfile).passcodeKeypad,
        });
        let driver: Browser | undefined;
        try {
            const appiumPort = Number(process.env.APPIUM_PORT ?? 4725);
            driver = await remote({
                hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
                port: appiumPort,
                path: '/',
                logLevel: 'error',
                capabilities: {
                    platformName: 'iOS',
                    'appium:automationName': 'XCUITest',
                    'appium:udid': session.device.udid,
                    'appium:bundleId': process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically',
                    'appium:noReset': true,
                    'appium:forceAppLaunch': true,
                    'appium:webDriverAgentUrl': `http://127.0.0.1:${session.wdaLocalPort}`,
                },
            });
            session.checks.appium = check('passed', 'Appium attached to WDA and launched TikTok without resetting it');
            const stream = await control.getMjpegStream(session.device.udid);
            const reader = stream.body!.getReader();
            const first = await reader.read();
            await reader.cancel();
            if (first.done || !first.value?.length) throw new Error('The WDA video stream returned no frames');
            session.checks.video = check('passed', 'WDA returned a live MJPEG frame');
            const coordinates = coordinatesForProfile(session.coordinateProfile).tiktok;
            const beforeTouch = await control.getScreenshot(session.device.udid);
            await tapCoordinate(driver, coordinates.profileTab.x, coordinates.profileTab.y, 'Profile tab readiness check');
            await driver.pause(1_000);
            const profileScreen = await control.getScreenshot(session.device.udid);
            if (profileScreen.equals(beforeTouch)) throw new Error('The Profile tap produced no visible screen change');
            await tapCoordinate(driver, coordinates.homeTab.x, coordinates.homeTab.y, 'Home tab readiness check');
            await driver.pause(1_000);
            const homeScreen = await control.getScreenshot(session.device.udid);
            if (homeScreen.equals(profileScreen)) throw new Error('The Home tap produced no visible screen change');
            session.checks.touch = check('passed', 'Profile and Home taps both produced visible screen changes');
            const accountCoordinates = {
                profileTabX: coordinates.profileTab.x,
                profileTabY: coordinates.profileTab.y,
                switcherTriggerX: coordinates.accountSwitcher.x,
                switcherTriggerY: coordinates.accountSwitcher.y,
            };
            if (session.tiktokAccounts.length) {
                for (const account of session.tiktokAccounts) {
                    await switchTikTokAccount(driver, control, session.device.udid, account, accountCoordinates);
                }
                session.checks.accounts = check('passed', `Verified ${session.tiktokAccounts.length} TikTok account${session.tiktokAccounts.length === 1 ? '' : 's'}`);
            } else {
                session.checks.accounts = check('passed', 'No TikTok accounts configured; add them later from the device workspace');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(session, message);
            if (stateOf(session, 'appium') === 'checking') session.checks.appium = check('failed', message);
            else if (stateOf(session, 'video') === 'checking') session.checks.video = check('failed', message);
            else if (stateOf(session, 'touch') === 'checking') session.checks.touch = check('failed', message);
            else session.checks.accounts = check('blocked', message);
        } finally {
            if (driver) await driver.deleteSession().catch(() => undefined);
        }
    }

    private async finalize(session: RegistrationSession): Promise<RegistrationSnapshot> {
        this.recalculate(session);
        if (!session.canFinalize) throw new Error('Every live readiness check must pass before registration can finish');
        const added = await mutateRegisteredDevices((devices) => {
            if (devices.some(({ udid }) => udid === session.device.udid)) return false;
            devices.push({
                name: session.name,
                udid: session.device.udid,
                coordinateProfile: session.coordinateProfile,
                wdaLocalPort: session.wdaLocalPort,
                mjpegLocalPort: session.mjpegLocalPort,
                ...(session.passcode ? { passcode: session.passcode } : {}),
                // coordinateProfile is a top-level field; don't duplicate it into pluginData.
                pluginData: { 'com.git-agni.tiktok': { accounts: session.tiktokAccounts } },
            });
            return true;
        });
        if (!added && session.passcode) {
            await setDevicePasscode(session.device.udid, session.passcode);
        }
        session.checks.wda = check('checking', 'Handing WDA ownership to the persistent fleet service');
        await this.stopSupervisor(session);
        if (!(await this.waitForEndpoint(`http://127.0.0.1:${session.wdaLocalPort}/status`, 30_000))) {
            session.checks.wda = check('blocked', 'The device is saved, but the fleet WDA service is not ready yet; recheck and finish again');
            this.recalculate(session);
            await this.persist(session);
            return publicSnapshot(session);
        }
        session.checks.wda = check('passed', 'Persistent fleet WDA is ready');
        session.finalized = true;
        this.recalculate(session);
        await this.persist(session);
        return publicSnapshot(session);
    }

    // ---- Android ----------------------------------------------------------
    // Same snapshot, check and persist machinery as iOS; only the probes differ.

    /** The devices.json shape this draft will be saved as, and what the live checks drive. */
    private androidRecord(session: RegistrationSession): RegisteredDevice {
        const serial = session.device.udid;
        const driver: DriverKind = session.driver ?? 'adb';
        return {
            name: session.name,
            udid: serial,
            platform: 'android',
            driver,
            android: {
                serial,
                ...(driver === 'a11y-bridge' ? {
                    bridgeUrl: this.bridgeBaseUrl(session),
                    ...(session.bridgeToken ? { bridgeToken: session.bridgeToken } : {}),
                } : {}),
            },
            pluginData: { 'com.git-agni.tiktok': { accounts: session.tiktokAccounts } },
        };
    }

    /** An explicit URL wins (the Wi-Fi APK fork); otherwise the local end of `adb forward`. */
    private bridgeBaseUrl(session: RegistrationSession): string {
        return session.bridgeUrl ?? `http://127.0.0.1:${session.bridgePort ?? BRIDGE_LOCAL_PORT}`;
    }

    private async refreshAndroid(session: RegistrationSession): Promise<void> {
        session.checks.host = check('checking', 'Looking for adb on PATH');
        session.checks.connection = check('checking', 'Asking adb about this serial');
        try {
            session.checks.host = check('passed', `${await this.android.hostVersion()} is on PATH`);
        } catch (error) {
            session.checks.host = check('blocked', `Install Android platform-tools and put adb on PATH: ${errorMessage(error)}`);
            session.checks.connection = check('pending', 'Waiting for a usable adb');
            await this.persist(session);
            return;
        }
        await this.inspectAndroidConnection(session);
        await this.inspectAndroidDriver(session, false);
        await this.inspectAndroidTikTok(session);
        await this.persist(session);
    }

    private async inspectAndroidConnection(session: RegistrationSession): Promise<void> {
        const serial = session.device.udid;
        let state: Awaited<ReturnType<AndroidProbe['deviceState']>>;
        try {
            state = await this.android.deviceState(serial);
        } catch (error) {
            session.checks.connection = check('blocked', `adb devices failed: ${errorMessage(error)}`);
            session.checks.developer = check('pending', 'Waiting for adb');
            return;
        }
        if (state === 'device') {
            session.checks.connection = check('passed', `adb sees ${serial} in the device state`);
            session.checks.developer = check('passed', 'USB debugging is authorised for this computer');
            const connected = (await this.discoverDevices()).find(({ udid }) => udid === serial);
            if (connected) session.device = connected;
            return;
        }
        if (state === 'unauthorized') {
            session.checks.connection = check('blocked', `adb sees ${serial}, but this computer is not authorised yet`);
            session.checks.developer = check('blocked',
                'Unlock the phone and tap Allow on the "Allow USB debugging?" prompt — tick "Always allow from this computer" — then recheck');
            return;
        }
        session.checks.connection = check('blocked', state === 'offline'
            ? `adb reports ${serial} as offline; replug the cable or re-run adb connect for wireless debugging`
            : `adb cannot see ${serial}; enable Developer options → USB debugging and reconnect`);
        session.checks.developer = check('pending', 'Waiting for adb to see the phone');
    }

    /** `bootstrap` also writes the port forward; a plain recheck only reads. */
    private async inspectAndroidDriver(session: RegistrationSession, bootstrap: boolean): Promise<void> {
        if (stateOf(session, 'connection') !== 'passed') {
            session.checks.driver = check('pending', 'Connect and authorise the phone before checking the driver');
            return;
        }
        const serial = session.device.udid;
        if ((session.driver ?? 'adb') === 'adb') {
            session.checks.driver = check('passed', 'The adb driver needs nothing installed on the phone');
            return;
        }
        session.checks.driver = check('checking', 'Checking the accessibility bridge');
        try {
            if (!await this.android.packageInstalled(serial, BRIDGE_PACKAGE)) {
                session.checks.driver = check('blocked', `${BRIDGE_PACKAGE} is not installed; adb -s ${serial} install app-release.apk`);
                return;
            }
            if (!await this.android.accessibilityEnabled(serial, BRIDGE_PACKAGE)) {
                session.checks.driver = check('blocked', 'Enable Settings → Accessibility → sim-use bridge on the phone, then recheck');
                return;
            }
            const token = await this.android.bridgeToken(serial);
            if (!token) {
                session.checks.driver = check('blocked', 'The bridge auth_token provider returned nothing; open the bridge app once, then recheck');
                return;
            }
            session.bridgeToken = token;
            // With the Wi-Fi build of the APK there is nothing to forward.
            if (bootstrap && !session.bridgeUrl) {
                await this.android.forwardBridgePort(serial, session.bridgePort ?? BRIDGE_LOCAL_PORT, BRIDGE_DEVICE_PORT);
            }
        } catch (error) {
            session.checks.driver = check('blocked', errorMessage(error));
            return;
        }
        const url = this.bridgeBaseUrl(session);
        session.checks.driver = await this.endpointReady(bridgePingUrl(url))
            ? check('passed', `The bridge answers at ${url}`)
            : check('blocked', `${bridgePingUrl(url)} is not answering; run "Set up the driver" to forward the port, or check the accessibility service`);
    }

    private async inspectAndroidTikTok(session: RegistrationSession): Promise<void> {
        if (stateOf(session, 'connection') !== 'passed') {
            session.checks.tiktok = check('pending', 'Connect the phone before checking TikTok');
            return;
        }
        const packageName = process.env.TIKTOK_PACKAGE ?? 'com.zhiliaoapp.musically';
        try {
            session.checks.tiktok = await this.android.packageInstalled(session.device.udid, packageName)
                ? check('passed', `TikTok (${packageName}) is installed`)
                : check('blocked', `Install TikTok (${packageName}) from Play, sign in, then recheck`);
        } catch (error) {
            session.checks.tiktok = check('blocked', `Could not list installed packages: ${errorMessage(error)}`);
        }
    }

    private async prepareAndroid(session: RegistrationSession): Promise<void> {
        if (stateOf(session, 'connection') !== 'passed') {
            throw new Error('Connect and authorise the phone over adb before setting up the driver');
        }
        await this.inspectAndroidDriver(session, true);
        await this.persist(session);
    }

    private async verifyAndroid(session: RegistrationSession): Promise<void> {
        if (stateOf(session, 'driver') !== 'passed') throw new Error('Finish the driver checks before runtime verification');
        session.checks.video = check('checking', 'Taking a screenshot through the driver');
        session.checks.touch = check('checking', 'Sending a harmless Home key through the driver');
        session.checks.accounts = check('checking', 'Recording the configured TikTok accounts');
        await this.inspectAndroidTikTok(session);
        const driver = this.createDriver(this.androidRecord(session));
        try {
            const image = await driver.screenshot();
            if (!isPng(image)) throw new Error('The driver returned something that is not a PNG screenshot');
            const screen = await driver.screen();
            session.checks.video = check('passed', `screencap works: ${screen.width} × ${screen.height} px`);
            // Home is the safest input there is: no content is touched and the phone stays usable.
            await driver.pressKey('home');
            session.checks.touch = check('passed', `The phone accepted a Home key through the ${driver.kind} driver`);
        } catch (error) {
            const message = errorMessage(error);
            this.log(session, message);
            if (stateOf(session, 'video') === 'checking') session.checks.video = check('failed', message);
            else session.checks.touch = check('failed', message);
            return;
        }
        session.checks.accounts = session.tiktokAccounts.length
            ? check('passed', `Recorded ${session.tiktokAccounts.length} TikTok account${session.tiktokAccounts.length === 1 ? '' : 's'} for this phone`)
            : check('passed', 'No TikTok accounts configured; add them later from the device workspace');
    }

    private async finalizeAndroid(session: RegistrationSession): Promise<RegistrationSnapshot> {
        this.recalculate(session);
        if (!session.canFinalize) throw new Error('Every Android readiness check must pass before registration can finish');
        const record = this.androidRecord(session);
        const added = await mutateRegisteredDevices((devices) => {
            if (devices.some(({ udid }) => udid === record.udid)) return false;
            // Explicit whitelist — never spread a draft session into devices.json.
            devices.push({
                name: record.name,
                udid: record.udid,
                platform: 'android',
                driver: record.driver,
                ...(record.android ? { android: record.android } : {}),
                pluginData: record.pluginData,
            });
            return true;
        });
        if (!added) this.log(session, 'This serial is already in devices.json; the existing entry was kept');
        // Nothing to hand over: there is no WDA supervisor on Android.
        session.finalized = true;
        this.recalculate(session);
        await this.persist(session);
        return publicSnapshot(session);
    }

    private async inspectWda(session: RegistrationSession): Promise<void> {
        const ready = await this.waitForEndpoint(`http://127.0.0.1:${session.wdaLocalPort}/status`, 5_000);
        session.checks.wda = ready ? check('passed', 'WebDriverAgent is reachable') : check('pending', 'Prepare WebDriverAgent for this device');
        if (ready) await this.refreshScreenProfiles(session);
    }

    private async refreshScreenProfiles(session: RegistrationSession): Promise<void> {
        try {
            const remoteControl = new WdaRemoteControl({
                deviceUdid: session.device.udid,
                wdaUrl: `http://127.0.0.1:${session.wdaLocalPort}`,
            });
            const { screenSize } = await remoteControl.getScreenInfo(session.device.udid);
            const matching = session.availableProfiles.filter((profile) => profile.screenSize.width === screenSize.width && profile.screenSize.height === screenSize.height);
            if (!session.coordinateProfile && matching.length === 1) session.coordinateProfile = matching[0]!.name;
            const selected = session.availableProfiles.find(({ name }) => name === session.coordinateProfile);
            if (selected && (selected.screenSize.width !== screenSize.width || selected.screenSize.height !== screenSize.height)) {
                session.checks.touch = check('pending', `Manual override: ${selected.displayName} targets ${selected.screenSize.width} × ${selected.screenSize.height}, while WDA reports ${screenSize.width} × ${screenSize.height}; live touch verification is required`);
            }
        } catch (error) {
            this.log(session, error instanceof Error ? error.message : String(error));
        }
    }

    private async inspectTikTok(session: RegistrationSession): Promise<void> {
        if (stateOf(session, 'connection') !== 'passed') {
            session.checks.tiktok = check('pending', 'Connect the device before checking TikTok');
            return;
        }
        try {
            const require = createRequire(import.meta.url);
            const { services } = require('appium-ios-device') as {
                services: { startInstallationProxyService(udid: string): Promise<{ lookupApplications(options: { bundleIds: string[] }): Promise<Record<string, unknown>>; close(): void }> };
            };
            const client = await services.startInstallationProxyService(session.device.udid);
            try {
                const bundleId = process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically';
                const apps = await client.lookupApplications({ bundleIds: [bundleId] });
                session.checks.tiktok = apps[bundleId]
                    ? check('passed', `TikTok (${bundleId}) is installed`)
                    : check('blocked', 'Install TikTok from the App Store, sign in, then recheck');
            } finally {
                client.close();
            }
        } catch (error) {
            session.checks.tiktok = check('blocked', `Unlock and trust the device to inspect installed apps: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async startSupervisor(session: RegistrationSession): Promise<void> {
        await this.stopSupervisor(session);
        const script = path.join(this.packageRoot, 'src/devices/wda/start.ts');
        const child = spawn(process.execPath, [
            '--env-file-if-exists=.env', '--env-file-if-exists=.env.devices', '--import', 'tsx', script,
        ], {
            cwd: this.workspaceRoot,
            env: {
                ...process.env,
                IOS_UDID: session.device.udid,
                WDA_LOCAL_PORT: String(session.wdaLocalPort),
                MJPEG_LOCAL_PORT: String(session.mjpegLocalPort),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        session.supervisor = child;
        const append = (chunk: Buffer) => {
            for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) this.log(session, line);
        };
        child.stdout?.on('data', append);
        child.stderr?.on('data', append);
        child.once('exit', () => { if (session.supervisor === child) session.supervisor = undefined; });
    }

    private async stopSupervisor(session: RegistrationSession): Promise<void> {
        const child = session.supervisor;
        session.supervisor = undefined;
        if (!child || child.exitCode !== null || child.killed) return;
        child.kill('SIGTERM');
        await Promise.race([
            new Promise<void>((resolve) => child.once('exit', () => resolve())),
            new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
    }

    private async runCommand(session: RegistrationSession, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
        return new Promise((resolve) => {
            const child = spawn(command, args, { cwd: this.workspaceRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '';
            const append = (chunk: Buffer) => {
                const value = chunk.toString();
                output = `${output}${value}`.slice(-100_000);
                for (const line of value.split(/\r?\n/).filter(Boolean)) this.log(session, line);
            };
            child.stdout.on('data', append);
            child.stderr.on('data', append);
            child.once('error', (error) => resolve({ ok: false, output: `${output}\n${error.message}` }));
            child.once('exit', (code) => resolve({ ok: code === 0, output }));
        });
    }

    private async endpointReady(url: string): Promise<boolean> {
        try {
            const response = await this.fetch(url, { signal: AbortSignal.timeout(2_000) });
            return response.ok;
        } catch {
            return false;
        }
    }

    private async waitForEndpoint(url: string, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this.endpointReady(url)) return true;
            await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        return false;
    }

    private recalculate(session: RegistrationSession): void {
        session.canFinalize = session.checkNames.every((name) => stateOf(session, name) === 'passed')
            && Boolean(session.name)
            // Coordinate packs are an iOS concept; the Android routine targets the tree.
            && (session.platform === 'android' || Boolean(session.coordinateProfile));
    }

    private log(session: RegistrationSession, value: string): void {
        const line = sanitizedLine(value.trim());
        if (!line) return;
        session.logs.push(line);
        session.logs = session.logs.slice(-100);
    }

    private statePath(id: string): string {
        return path.join(this.stateDirectory, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    }

    private async persist(session: RegistrationSession): Promise<void> {
        await mkdir(this.stateDirectory, { recursive: true });
        const target = this.statePath(session.id);
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(publicSnapshot(session), null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, target);
    }
}
