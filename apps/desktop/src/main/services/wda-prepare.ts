import { existsSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';

import { runCommand } from '../health.ts';
import type { JobDefinition } from '../jobs.ts';
import type { SpawnSpec } from '../process.ts';
import type { JobCheck } from '../types.ts';
import { farmEntryArgs, farmNodeSpawn, type ServiceContext } from './context.ts';

export const WDA_PREPARE_JOB_ID = 'wda-prepare';
export const WDA_PREPARE_SCRIPT = 'src/devices/wda/prepare.ts';

/**
 * What the app cannot do for the operator. `xcodebuild build-for-testing` signs
 * and installs the runner, but iOS will not let it launch until the developer
 * certificate is trusted on the device itself, and that dialog only exists in
 * Settings on the phone.
 */
export const WDA_TRUST_NOTE = [
    'After this finishes, do one thing by hand on each iPhone — no tool can do it for you:',
    '',
    '  1. Unlock the phone and keep it connected.',
    '  2. Settings → General → VPN & Device Management.',
    '  3. Tap your Apple Development certificate, then "Trust".',
    '  4. Settings → Privacy & Security → Developer Mode must be on (iOS 16+);',
    '     turning it on restarts the phone.',
    '',
    'Until that is done, WebDriverAgent is installed but iOS refuses to launch it,',
    'and the wda service will report the device as unavailable.',
].join('\n');

/** Every device in devices.json, or the one the operator picked. */
export type WdaPrepareTarget = { kind: 'all' } | { kind: 'udid'; udid: string };

export function wdaPrepareArgs(target: WdaPrepareTarget): string[] {
    return target.kind === 'all' ? ['--all'] : ['--udid', target.udid];
}

function registeredDeviceCount(devicesConfigPath: string): number {
    try {
        const parsed: unknown = JSON.parse(readFileSync(devicesConfigPath, 'utf8'));
        const devices = Array.isArray(parsed)
            ? parsed
            : (parsed as { devices?: unknown })?.devices;
        return Array.isArray(devices) ? devices.length : 0;
    } catch {
        return 0;
    }
}

/**
 * The preconditions, in the order they bite. Every one of them is reported,
 * passing or not, so the operator sees the whole picture rather than the first
 * thing that broke.
 */
export async function wdaPrepareChecks(
    context: ServiceContext,
    target: WdaPrepareTarget,
): Promise<JobCheck[]> {
    const checks: JobCheck[] = [];

    if (process.platform !== 'darwin') {
        return [{ label: 'macOS', ok: false, detail: 'WebDriverAgent can only be built on macOS with Xcode.' }];
    }

    // `xcode-select -p` pointing at CommandLineTools is the classic failure: the
    // command line tools alone cannot build an iOS test runner.
    const developerDir = await runCommand('xcode-select', ['-p'], { timeoutMs: 15_000 });
    const path = developerDir.stdout.trim();
    const fullXcode = developerDir.ok && path.includes('.app/Contents/Developer');
    checks.push({
        label: 'Xcode',
        ok: fullXcode,
        detail: fullXcode
            ? `Developer directory: ${path}`
            : path
                ? `xcode-select points at ${path}. Install Xcode from the App Store and run: sudo xcode-select -s /Applications/Xcode.app`
                : 'xcode-select -p failed — Xcode is not installed.',
    });

    if (fullXcode) {
        const version = await runCommand('xcodebuild', ['-version'], { timeoutMs: 30_000 });
        checks.push({
            label: 'xcodebuild',
            ok: version.ok,
            detail: version.ok
                ? version.stdout.trim().split('\n')[0] ?? 'available'
                : 'xcodebuild refused to run. Open Xcode once to accept its licence.',
        });
    }

    const orgId = context.settings.xcodeOrgId.trim();
    checks.push({
        label: 'XCODE_ORG_ID',
        ok: orgId.length > 0,
        detail: orgId ? orgId : 'Empty. Settings → Devices → XCODE_ORG_ID (your 10-character Apple Team ID).',
    });

    const signingId = context.settings.xcodeSigningId.trim();
    checks.push({
        label: 'XCODE_SIGNING_ID',
        ok: signingId.length > 0,
        detail: signingId ? signingId : 'Empty. "Apple Development" is the usual value.',
    });

    const bundleId = context.settings.wdaBundleId.trim();
    checks.push({
        label: 'WDA_BUNDLE_ID',
        ok: bundleId.length > 0,
        detail: bundleId ? bundleId : 'Empty. Settings → Devices → WDA_BUNDLE_ID.',
    });

    // prepare.ts patches and builds WebDriverAgent out of the Appium XCUITest
    // driver's own checkout, which `appium driver install` puts under APPIUM_HOME.
    // Without it the build fails on an unresolved path, so say so here. The path
    // follows APPIUM_HOME rather than the checkout, so it is right for a packaged
    // app too — there the driver lives beside the operator's other data.
    const driverPath = nodePath.resolve(
        context.env.XCUITEST_DRIVER_PATH
        ?? nodePath.join(context.paths.appiumHome, 'node_modules/appium-xcuitest-driver'),
    );
    const driverPresent = existsSync(nodePath.join(driverPath, 'node_modules/appium-webdriveragent'));
    checks.push({
        label: 'XCUITest driver',
        ok: driverPresent,
        detail: driverPresent
            ? driverPath
            : `Not at ${driverPath}. Run "npm run appium:install-driver" in the farm checkout, `
                + `or install it into ${context.paths.appiumHome}, or set XCUITEST_DRIVER_PATH.`,
    });

    if (target.kind === 'all') {
        const count = registeredDeviceCount(context.paths.devicesConfigPath);
        checks.push({
            label: 'Registered devices',
            ok: count > 0,
            detail: count > 0
                ? `${count} device(s) in devices.json`
                : 'devices.json has no devices — register an iPhone in the dashboard first, or build for one UDID.',
        });
    } else {
        checks.push({ label: 'Target device', ok: target.udid.length > 0, detail: target.udid || 'No UDID given.' });
    }

    return checks;
}

export function wdaPrepareSpawn(context: ServiceContext, target: WdaPrepareTarget): SpawnSpec {
    return {
        ...farmNodeSpawn(context, [
            ...farmEntryArgs(context, WDA_PREPARE_SCRIPT),
            ...wdaPrepareArgs(target),
        ]),
        // A cold WebDriverAgent build is long; give it room to stop cleanly.
        stopTimeoutMs: 20_000,
    };
}

/**
 * The same work as `npm run wda:prepare -- --all`, run as a supervised job.
 *
 * It spawns the repository's own `src/devices/wda/prepare.ts` directly rather
 * than through npm: a packaged app has no npm, and the desktop app already
 * builds the environment (`XCODE_ORG_ID`, `XCODE_SIGNING_ID`, `WDA_BUNDLE_ID`,
 * `IOS_PLATFORM_VERSION`) that the npm script would have read from `.env`.
 */
export function wdaPrepareJob(context: ServiceContext, target: WdaPrepareTarget): JobDefinition {
    return {
        id: WDA_PREPARE_JOB_ID,
        label: 'Prepare WebDriverAgent',
        note: WDA_TRUST_NOTE,
        command: `npm run wda:prepare -- ${wdaPrepareArgs(target).join(' ')}`,
        checks: () => wdaPrepareChecks(context, target),
        spawn: () => wdaPrepareSpawn(context, target),
    };
}
