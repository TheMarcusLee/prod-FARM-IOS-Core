/**
 * The adb-side of the registration wizard: one small function per shell probe, plus pure
 * parsers for their output so the whole Android path can be tested without adb on the host.
 * See docs/adr/0001-multi-platform-device-drivers.md and docs/android-dashboard.md.
 */
import { runCommand, type CommandRunner } from '../drivers/common.js';

/** sim-use device bridge APK; see src/drivers/README.md for the bootstrap steps. */
export const BRIDGE_PACKAGE = 'com.linecorp.simuse.devicebridge';
/** Port the bridge's HTTP server listens on inside the phone. */
/** The port the bridge APK listens on (SimuseAccessibilityService.SERVER_PORT). */
export const BRIDGE_DEVICE_PORT = 8080;
/** Default local end of `adb forward`; any free port works. */
export const BRIDGE_LOCAL_PORT = 18_300;
export const BRIDGE_TOKEN_URI = `content://${BRIDGE_PACKAGE}/auth_token`;

export type AdbDeviceState = 'device' | 'unauthorized' | 'offline' | 'missing';

/** `adb devices -l` lists one device per line after a header: `<serial>\t<state> [key:value ...]`. */
export function parseAdbDeviceState(stdout: string, serial: string): AdbDeviceState {
    for (const line of stdout.split(/\r?\n/).slice(1)) {
        const [listed, state] = line.trim().split(/\s+/);
        if (listed !== serial || !state) continue;
        if (state === 'device' || state === 'unauthorized' || state === 'offline') return state;
        return 'offline';
    }
    return 'missing';
}

/** `pm list packages <name>` prints `package:<name>` for every match, nothing for none. */
export function parsePackageInstalled(stdout: string, packageName: string): boolean {
    return stdout.split(/\r?\n/).some((line) => line.trim() === `package:${packageName}`);
}

/** `settings get secure enabled_accessibility_services` prints a colon-separated list, or `null`. */
export function parseAccessibilityEnabled(stdout: string, packageName: string): boolean {
    return stdout.trim().split(':').some((entry) => entry.trim().startsWith(`${packageName}/`));
}

/** `content query` prints `Row: 0 auth_token=<value>` (column name unknown, so take the last `=`). */
/**
 * The provider answers `Row: 0 result={"status":"success","result":"<uuid>"}` (the same JSON
 * envelope the bridge's HTTP routes use); older builds print the bare token. Accept both.
 */
export function parseBridgeToken(stdout: string): string | undefined {
    for (const line of stdout.split(/\r?\n/)) {
        const match = line.match(/^Row:\s*\d+\s+\S+?=(.+)$/);
        const value = match?.[1]?.trim();
        if (!value || value === 'NULL') continue;
        if (!value.startsWith('{')) return value;
        try {
            const envelope = JSON.parse(value) as { status?: string; result?: unknown };
            if (envelope.status === 'success' && typeof envelope.result === 'string' && envelope.result) return envelope.result;
        } catch {
            // Not JSON after all; fall through to the next row.
        }
    }
    return undefined;
}

export interface AndroidProbe {
    /** `adb version`, trimmed to its first line; throws when adb is not on PATH. */
    hostVersion(): Promise<string>;
    deviceState(serial: string): Promise<AdbDeviceState>;
    packageInstalled(serial: string, packageName: string): Promise<boolean>;
    accessibilityEnabled(serial: string, packageName: string): Promise<boolean>;
    bridgeToken(serial: string): Promise<string | undefined>;
    forwardBridgePort(serial: string, localPort: number, devicePort: number): Promise<void>;
}

/** Every adb call the wizard makes, behind an injectable CommandRunner so tests never spawn adb. */
export function createAndroidProbe(run: CommandRunner = runCommand): AndroidProbe {
    const shell = async (serial: string, ...args: string[]): Promise<string> => {
        const { stdout } = await run('adb', ['-s', serial, 'shell', ...args], { timeoutMs: 15_000 });
        return String(stdout);
    };
    return {
        hostVersion: async () => {
            const { stdout } = await run('adb', ['version'], { timeoutMs: 10_000 });
            return String(stdout).split(/\r?\n/)[0]?.trim() ?? 'adb';
        },
        deviceState: async (serial) => {
            const { stdout } = await run('adb', ['devices', '-l'], { timeoutMs: 10_000 });
            return parseAdbDeviceState(String(stdout), serial);
        },
        packageInstalled: async (serial, packageName) =>
            parsePackageInstalled(await shell(serial, 'pm', 'list', 'packages', packageName), packageName),
        accessibilityEnabled: async (serial, packageName) =>
            parseAccessibilityEnabled(await shell(serial, 'settings', 'get', 'secure', 'enabled_accessibility_services'), packageName),
        bridgeToken: async (serial) => parseBridgeToken(await shell(serial, 'content', 'query', '--uri', BRIDGE_TOKEN_URI)),
        forwardBridgePort: async (serial, localPort, devicePort) => {
            await run('adb', ['-s', serial, 'forward', `tcp:${localPort}`, `tcp:${devicePort}`], { timeoutMs: 10_000 });
        },
    };
}
