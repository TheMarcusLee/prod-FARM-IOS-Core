import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Operator-editable configuration. Everything here ends up either in the child
 * process environment or in the embedded Postgres bootstrap, so it is deliberately
 * a flat, boring record of strings.
 */
export interface Settings {
    webPort: number;
    appiumPort: number;
    /** Non-empty means "use my Postgres, do not start the embedded one". */
    databaseUrl: string;
    /** Port for the embedded Postgres. Ignored when databaseUrl is set. */
    embeddedPostgresPort: number;
    /** Generated on first run; only ever stored in this 0600 file. */
    embeddedPostgresPassword: string;
    plugins: string;
    authPlugin: string;
    tiktokBundleId: string;
    iosPlatformVersion: string;
    xcodeOrgId: string;
    xcodeSigningId: string;
    wdaBundleId: string;
    /** 'on' | 'off' — 'off' skips adb entirely (docs/android-dashboard.md). */
    androidDiscovery: 'on' | 'off';
    launchAtLogin: boolean;
}

export const DEFAULT_SETTINGS: Omit<Settings, 'embeddedPostgresPassword'> = {
    webPort: 3000,
    appiumPort: 4725,
    databaseUrl: '',
    embeddedPostgresPort: 55432,
    plugins: '',
    authPlugin: '',
    tiktokBundleId: 'com.zhiliaoapp.musically',
    iosPlatformVersion: '16.7',
    xcodeOrgId: '',
    xcodeSigningId: 'Apple Development',
    wdaBundleId: 'com.example.WebDriverAgentRunner',
    androidDiscovery: 'on',
    launchAtLogin: false,
};

export const EMBEDDED_DB_NAME = 'phone_farm';
export const EMBEDDED_DB_USER = 'phone_farm';

function coerceNumber(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function coerceString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value.trim() : fallback;
}

/** Anything unrecognised in settings.json is dropped rather than trusted. */
export function normalizeSettings(raw: unknown): Settings {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        webPort: coerceNumber(input.webPort, DEFAULT_SETTINGS.webPort),
        appiumPort: coerceNumber(input.appiumPort, DEFAULT_SETTINGS.appiumPort),
        databaseUrl: coerceString(input.databaseUrl),
        embeddedPostgresPort: coerceNumber(input.embeddedPostgresPort, DEFAULT_SETTINGS.embeddedPostgresPort),
        embeddedPostgresPassword: coerceString(input.embeddedPostgresPassword) || generatePassword(),
        plugins: coerceString(input.plugins),
        authPlugin: coerceString(input.authPlugin),
        tiktokBundleId: coerceString(input.tiktokBundleId) || DEFAULT_SETTINGS.tiktokBundleId,
        iosPlatformVersion: coerceString(input.iosPlatformVersion) || DEFAULT_SETTINGS.iosPlatformVersion,
        xcodeOrgId: coerceString(input.xcodeOrgId),
        xcodeSigningId: coerceString(input.xcodeSigningId) || DEFAULT_SETTINGS.xcodeSigningId,
        wdaBundleId: coerceString(input.wdaBundleId) || DEFAULT_SETTINGS.wdaBundleId,
        androidDiscovery: coerceString(input.androidDiscovery) === 'off' ? 'off' : 'on',
        launchAtLogin: input.launchAtLogin === true,
    };
}

export function generatePassword(): string {
    // URL-safe so it can go into a DATABASE_URL without escaping.
    return randomBytes(24).toString('base64url');
}

export class SettingsStore {
    readonly file: string;
    private current: Settings;

    constructor(userDataDir: string) {
        this.file = path.join(userDataDir, 'settings.json');
        mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
        this.current = normalizeSettings(this.readRaw());
        this.write(this.current);
    }

    private readRaw(): unknown {
        try {
            return JSON.parse(readFileSync(this.file, 'utf8'));
        } catch {
            return {};
        }
    }

    get(): Settings {
        return { ...this.current };
    }

    /** Merges a partial update, re-normalises, and rewrites the 0600 file. */
    update(patch: Partial<Settings>): Settings {
        this.current = normalizeSettings({ ...this.current, ...patch });
        this.write(this.current);
        return this.get();
    }

    private write(settings: Settings): void {
        writeFileSync(this.file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        // writeFileSync only applies `mode` when it creates the file.
        chmodSync(this.file, 0o600);
    }
}

export interface EnvironmentInput {
    settings: Settings;
    /** Resolved connection string: the override, or the embedded one. */
    databaseUrl: string;
    repoRoot: string;
    schedulerDataDir: string;
    devicesConfigPath: string;
    wdaServiceSocket: string;
    appiumHome: string;
}

/** The environment every farm child process is given. Never inherits a stray .env. */
export function childEnvironment(input: EnvironmentInput): Record<string, string> {
    const { settings } = input;
    const env: Record<string, string> = {
        WEB_HOST: '127.0.0.1',
        WEB_PORT: String(settings.webPort),
        APPIUM_HOST: '127.0.0.1',
        APPIUM_PORT: String(settings.appiumPort),
        DATABASE_URL: input.databaseUrl,
        PHONE_FARM_PLUGINS: settings.plugins,
        TIKTOK_BUNDLE_ID: settings.tiktokBundleId,
        DEVICES_CONFIG_PATH: input.devicesConfigPath,
        SCHEDULER_DATA_DIR: input.schedulerDataDir,
        WDA_SERVICE_SOCKET: input.wdaServiceSocket,
        WDA_LOCAL_PORT: '8100',
        MJPEG_LOCAL_PORT: '9100',
        IOS_PLATFORM_VERSION: settings.iosPlatformVersion,
        XCODE_SIGNING_ID: settings.xcodeSigningId,
        WDA_BUNDLE_ID: settings.wdaBundleId,
        ANDROID_DISCOVERY: settings.androidDiscovery,
        APPIUM_HOME: input.appiumHome,
    };
    if (settings.xcodeOrgId) env.XCODE_ORG_ID = settings.xcodeOrgId;
    if (settings.authPlugin) env.PHONE_FARM_AUTH_PLUGIN = settings.authPlugin;
    return env;
}

export function embeddedDatabaseUrl(port: number, password: string): string {
    return `postgresql://${EMBEDDED_DB_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${EMBEDDED_DB_NAME}`;
}
