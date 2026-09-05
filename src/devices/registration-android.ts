/**
 * The adb-side of the registration wizard: one small function per shell probe, plus pure
 * parsers for their output so the whole Android path can be tested without adb on the host.
 * See docs/adr/0001-multi-platform-device-drivers.md and docs/android-dashboard.md.
 */
import { parseAdbDevices } from '../drivers/adb.js';
import { errorMessage, runCommand, type CommandRunner } from '../drivers/common.js';

/** sim-use device bridge APK; see src/drivers/README.md for the bootstrap steps. */
export const BRIDGE_PACKAGE = 'com.linecorp.simuse.devicebridge';
/** Port the bridge's HTTP server listens on inside the phone. */
/** The port the bridge APK listens on (SimuseAccessibilityService.SERVER_PORT). */
export const BRIDGE_DEVICE_PORT = 8080;
/** Default local end of `adb forward`; any free port works. */
export const BRIDGE_LOCAL_PORT = 18_300;
export const BRIDGE_TOKEN_URI = `content://${BRIDGE_PACKAGE}/auth_token`;

export type AdbDeviceState = 'device' | 'unauthorized' | 'offline' | 'missing';

/**
 * `adb devices -l` lists one device per line after a header, behind the daemon banner adb prints
 * the first time it starts its server. Anything that is neither `device` nor `unauthorized`
 * (`offline`, `recovery`, `sideload`, `no permissions`, ...) is not usable, so it reads as offline.
 */
export function parseAdbDeviceState(stdout: string, serial: string): AdbDeviceState {
    const listed = parseAdbDevices(stdout).find((device) => device.serial === serial);
    if (!listed) return 'missing';
    return listed.state === 'device' || listed.state === 'unauthorized' ? listed.state : 'offline';
}

/** The local end of an `adb forward` bridge URL, when the URL is one (rather than a Wi-Fi address). */
export function localBridgePort(bridgeUrl: string | undefined): number | undefined {
    if (!bridgeUrl) return undefined;
    let url: URL;
    try {
        url = new URL(bridgeUrl);
    } catch {
        return undefined;
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return undefined;
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
}

/** `pm list packages <name>` prints `package:<name>` for every match, nothing for none. */
export function parsePackageInstalled(stdout: string, packageName: string): boolean {
    return stdout.split(/\r?\n/).some((line) => line.trim() === `package:${packageName}`);
}

/** `settings get secure enabled_accessibility_services` prints a colon-separated list, or `null`. */
export function parseAccessibilityEnabled(stdout: string, packageName: string): boolean {
    return stdout.trim().split(':').some((entry) => entry.trim().startsWith(`${packageName}/`));
}

/** `content query` prints one `Row: 0 name=value, name=value` line per row. */
export function parseContentRow(row: string): Map<string, string> {
    const columns = new Map<string, string>();
    // Split only where a new `name=` starts, so a value containing ", " stays in one piece.
    for (const column of row.split(/,\s+(?=[\w:.-]+=)/)) {
        const separator = column.indexOf('=');
        if (separator > 0) columns.set(column.slice(0, separator).trim(), column.slice(separator + 1).trim());
    }
    return columns;
}

/** Columns that could hold the token, most specific first; anything else is a last resort. */
const TOKEN_COLUMNS = ['result', 'auth_token', 'token', 'value'];

/**
 * The provider answers `Row: 0 result={"status":"success","result":"<uuid>"}` (the same JSON
 * envelope the bridge's HTTP routes use); older builds print the bare token, and a provider that
 * returns several columns puts an `_id` in front of it. Accept all three.
 */
export function parseBridgeToken(stdout: string): string | undefined {
    for (const line of stdout.split(/\r?\n/)) {
        const row = line.trim().match(/^Row:\s*\d+\s+(.*)$/)?.[1];
        if (!row) continue;
        const columns = parseContentRow(row);
        const names = [...TOKEN_COLUMNS.filter((name) => columns.has(name)), ...columns.keys()];
        for (const name of names) {
            const token = tokenFromColumn(columns.get(name));
            if (token) return token;
        }
    }
    return undefined;
}

function tokenFromColumn(value: string | undefined): string | undefined {
    if (!value || value === 'NULL') return undefined;
    if (!value.startsWith('{')) return value;
    try {
        const envelope = JSON.parse(value) as { status?: string; result?: unknown };
        if (envelope.status === 'success' && typeof envelope.result === 'string' && envelope.result) return envelope.result;
    } catch {
        // Not JSON after all; the caller tries the next column.
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
            try {
                await run('adb', ['-s', serial, 'forward', `tcp:${localPort}`, `tcp:${devicePort}`], { timeoutMs: 10_000 });
            } catch (error) {
                // adb says "cannot bind listener" when something else — often another phone's
                // forward — already owns the port, which is not obvious from the raw message.
                throw new Error(
                    `Could not forward local port ${localPort} to ${serial}:${devicePort}. `
                    + `Something else may already be listening on 127.0.0.1:${localPort} `
                    + `(check "adb forward --list"); choose a different bridge port. ${errorMessage(error)}`,
                );
            }
        },
    };
}
