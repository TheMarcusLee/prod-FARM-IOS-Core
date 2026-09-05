import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    DEFAULT_SETTINGS, SettingsStore, childEnvironment, embeddedDatabaseUrl,
    generatePassword, normalizeSettings,
} from '../src/main/settings.ts';
import { appPaths } from '../src/main/paths.ts';

/** A directory that looks like a farm of the given shape to `farmEntryExtension`. */
function farmTree(entry: 'server.ts' | 'server.js'): string {
    const root = mkdtempSync(path.join(tmpdir(), 'farm-shape-'));
    mkdirSync(path.join(root, 'src', 'api'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'api', entry), '');
    return root;
}

function scratch(): string {
    return mkdtempSync(path.join(tmpdir(), 'farm-desktop-'));
}

test('normalizeSettings fills defaults and drops unknown keys', () => {
    const settings = normalizeSettings({ webPort: 8080, nonsense: 'ignored' });

    assert.equal(settings.webPort, 8080);
    assert.equal(settings.appiumPort, DEFAULT_SETTINGS.appiumPort);
    assert.equal(settings.androidDiscovery, 'on');
    assert.equal(settings.launchAtLogin, false);
    assert.equal('nonsense' in settings, false);
    assert.ok(settings.embeddedPostgresPassword.length >= 24);
});

test('normalizeSettings rejects out-of-range and non-numeric ports', () => {
    assert.equal(normalizeSettings({ webPort: 0 }).webPort, DEFAULT_SETTINGS.webPort);
    assert.equal(normalizeSettings({ webPort: 70_000 }).webPort, DEFAULT_SETTINGS.webPort);
    assert.equal(normalizeSettings({ webPort: 'abc' }).webPort, DEFAULT_SETTINGS.webPort);
    assert.equal(normalizeSettings({ webPort: '4000' }).webPort, 4000);
});

test('androidDiscovery only ever becomes on or off', () => {
    assert.equal(normalizeSettings({ androidDiscovery: 'off' }).androidDiscovery, 'off');
    assert.equal(normalizeSettings({ androidDiscovery: 'maybe' }).androidDiscovery, 'on');
});

test('the settings file is created 0600 and round-trips', () => {
    const directory = scratch();
    const store = new SettingsStore(directory);

    assert.equal(statSync(store.file).mode & 0o777, 0o600);
    const password = store.get().embeddedPostgresPassword;
    assert.ok(password);

    store.update({ webPort: 3100, plugins: '@acme/plugin' });
    const reopened = new SettingsStore(directory);

    assert.equal(reopened.get().webPort, 3100);
    assert.equal(reopened.get().plugins, '@acme/plugin');
    assert.equal(reopened.get().embeddedPostgresPassword, password, 'the generated password is stable');
});

test('a corrupt settings file falls back to defaults instead of throwing', () => {
    const directory = scratch();
    writeFileSync(path.join(directory, 'settings.json'), '{ not json');

    const store = new SettingsStore(directory);

    assert.equal(store.get().webPort, DEFAULT_SETTINGS.webPort);
    assert.doesNotThrow(() => JSON.parse(readFileSync(store.file, 'utf8')));
});

test('the 0600 mode survives a rewrite of an existing file', () => {
    const directory = scratch();
    const store = new SettingsStore(directory);
    store.update({ webPort: 3200 });

    assert.equal(statSync(store.file).mode & 0o777, 0o600);
});

test('generated passwords are URL-safe so they can go straight into a DATABASE_URL', () => {
    for (let index = 0; index < 20; index += 1) {
        const password = generatePassword();
        assert.match(password, /^[A-Za-z0-9_-]+$/);
    }
});

test('embeddedDatabaseUrl encodes the password and parses back', () => {
    const url = new URL(embeddedDatabaseUrl(55432, 'a-b_c'));

    assert.equal(url.protocol, 'postgresql:');
    assert.equal(url.port, '55432');
    assert.equal(url.pathname, '/phone_farm');
    assert.equal(decodeURIComponent(url.password), 'a-b_c');
});

test('childEnvironment binds loopback and carries the configured values', () => {
    const settings = normalizeSettings({ webPort: 3300, appiumPort: 4800, plugins: '@acme/p', androidDiscovery: 'off' });
    const paths = appPaths('/repo', '/userdata');

    const env = childEnvironment({
        settings,
        databaseUrl: 'postgresql://u:p@127.0.0.1:5432/db',
        repoRoot: paths.repoRoot,
        schedulerDataDir: paths.schedulerDataDir,
        devicesConfigPath: paths.devicesConfigPath,
        wdaServiceSocket: paths.wdaServiceSocket,
        appiumHome: paths.appiumHome,
    });

    assert.equal(env.WEB_HOST, '127.0.0.1', 'never bound off loopback without an auth plugin');
    assert.equal(env.WEB_PORT, '3300');
    assert.equal(env.APPIUM_PORT, '4800');
    assert.equal(env.PHONE_FARM_PLUGINS, '@acme/p');
    assert.equal(env.ANDROID_DISCOVERY, 'off');
    assert.equal(env.DATABASE_URL, 'postgresql://u:p@127.0.0.1:5432/db');
    assert.equal(env.SCHEDULER_DATA_DIR, '/userdata/scheduler-data');
    assert.equal(env.DEVICES_CONFIG_PATH, '/userdata/devices.json');
    assert.equal(env.WDA_SERVICE_SOCKET, '/userdata/wda.sock');
    assert.equal(env.APPIUM_HOME, '/repo/.appium2');
    assert.equal('XCODE_ORG_ID' in env, false, 'an empty signing id is omitted, not passed as ""');
    assert.equal('PHONE_FARM_AUTH_PLUGIN' in env, false);
});

test('childEnvironment passes the signing and auth values once they are set', () => {
    const settings = normalizeSettings({ xcodeOrgId: 'ABCDE12345', authPlugin: '@acme/auth' });
    const paths = appPaths('/repo', '/userdata');

    const env = childEnvironment({
        settings,
        databaseUrl: 'postgresql://u:p@127.0.0.1:5432/db',
        repoRoot: paths.repoRoot,
        schedulerDataDir: paths.schedulerDataDir,
        devicesConfigPath: paths.devicesConfigPath,
        wdaServiceSocket: paths.wdaServiceSocket,
        appiumHome: paths.appiumHome,
    });

    assert.equal(env.XCODE_ORG_ID, 'ABCDE12345');
    assert.equal(env.PHONE_FARM_AUTH_PLUGIN, '@acme/auth');
});

test('the WDA unix socket path stays inside the platform length limit', () => {
    const paths = appPaths('/repo', '/Users/someone/Library/Application Support/Phone Farm');

    assert.ok(Buffer.byteLength(paths.wdaServiceSocket) < 104, paths.wdaServiceSocket);
});

test('APPIUM_HOME stays out of the app bundle once the farm is compiled', () => {
    // Appium writes its driver manifest into APPIUM_HOME on every start. In a
    // packaged app repoRoot is Contents/Resources/farm: writing there breaks the
    // code signature and would be thrown away by the next update anyway.
    const checkout = farmTree('server.ts');
    assert.equal(appPaths(checkout, '/userdata').compiled, false);
    assert.equal(
        appPaths(checkout, '/userdata').appiumHome, path.join(checkout, '.appium2'),
        'a checkout shares the driver `npm run appium:install-driver` installed',
    );

    const packaged = farmTree('server.js');
    assert.equal(appPaths(packaged, '/userdata').compiled, true);
    assert.equal(
        appPaths(packaged, '/userdata').appiumHome, path.join('/userdata', 'appium'),
        'a packaged app keeps its Appium home beside the operator other data',
    );
});

test('the environment hands the resolved Appium home to every child', () => {
    const env = childEnvironment({
        settings: normalizeSettings({}),
        databaseUrl: 'postgresql://u:p@127.0.0.1:5432/db',
        repoRoot: '/resources/farm',
        schedulerDataDir: '/userdata/scheduler-data',
        devicesConfigPath: '/userdata/devices.json',
        wdaServiceSocket: '/userdata/wda.sock',
        appiumHome: '/userdata/appium',
    });

    assert.equal(env.APPIUM_HOME, '/userdata/appium');
    assert.ok(!env.APPIUM_HOME.startsWith('/resources/farm'), 'never inside the app bundle');
});
