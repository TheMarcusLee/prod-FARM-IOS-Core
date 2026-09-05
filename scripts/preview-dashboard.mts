/**
 * Serve the dashboard against a made-up fleet, so the design can be looked at without a rig.
 *
 *   node --import tsx scripts/preview-dashboard.mts
 *
 * Twelve phones, a running task, a failed one and a handful of schedules. Nothing here touches a
 * real device: discovery is switched off and every driver is a fake that draws a screen.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.ANDROID_DISCOVERY = 'off';
process.env.PHONE_FARM_TRUSTED_ORIGINS = 'http://127.0.0.1:3999';

const workspace = await mkdtemp(path.join(os.tmpdir(), 'backline-preview-'));
process.env.DEVICES_CONFIG_PATH = path.join(workspace, 'devices.json');
process.env.SCHEDULER_DATA_DIR = path.join(workspace, 'data');

const PHONES: Array<[string, 'android' | 'ios', string[], string[]]> = [
    ['iPhone 8', 'ios', ['posting'], ['@farm.one']],
    ['Pixel 7', 'android', ['posting'], ['@farm.two']],
    ['Galaxy A52', 'android', ['posting'], ['@farm.three']],
    ['Moto G54', 'android', ['posting'], ['@farm.four']],
    ['Pixel 6a', 'android', ['warm-up'], ['@farm.five']],
    ['Redmi Note 12', 'android', ['warm-up'], ['@farm.six']],
    ['Galaxy A14', 'android', ['posting'], ['@farm.seven']],
    ['Pixel 8', 'android', ['posting'], ['@farm.eight']],
    ['Moto G73', 'android', ['shelf'], []],
    ['Galaxy A34', 'android', ['posting'], ['@farm.ten']],
    ['iPhone 11', 'ios', ['warm-up'], ['@farm.eleven']],
    ['Moto G84', 'android', ['posting'], ['@farm.twelve']],
];

await writeFile(process.env.DEVICES_CONFIG_PATH, JSON.stringify(PHONES.map(([name, platform, tags, accounts], index) => ({
    name,
    udid: platform === 'ios' ? `00008030-000${index}1E0A3C40802E` : `R58N12ABCD${index}`,
    platform,
    ...(platform === 'android' ? { driver: index % 4 === 1 ? 'a11y-bridge' : 'adb', android: { serial: `R58N12ABCD${index}`, ...(index % 4 === 1 ? { bridgeUrl: 'http://192.168.1.40:8080' } : {}) } } : {}),
    tags,
    pluginData: { 'com.git-agni.tiktok': { accounts } },
})), null, 2));

const { createApp } = await import('../src/api/app.js');
const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
const { PluginRegistry } = await import('../src/registry.js');

const devices = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(process.env.DEVICES_CONFIG_PATH!, 'utf8')));
// Every phone but 03 and 07 answers; that is what makes the wall interesting.
const OFFLINE = new Set([devices[2].udid, devices[6].udid]);

const now = new Date();
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

const executions = [
    {
        id: 'e-running', scheduleId: 's1', deviceUdid: devices[1].udid, pluginId: 'com.git-agni.tiktok',
        taskType: 'post', taskVersion: 1, status: 'running', payload: {},
        scheduledFor: at(-3), deadlineAt: at(30), startedAt: at(-3), finishedAt: null, error: null,
        attempt: 1, createdAt: at(-3),
    },
    {
        id: 'e-failed', scheduleId: 's2', deviceUdid: devices[2].udid, pluginId: 'com.git-agni.tiktok',
        taskType: 'post', taskVersion: 1, status: 'failed', payload: {},
        scheduledFor: at(-40), deadlineAt: at(-10), startedAt: at(-40), finishedAt: at(-38),
        error: 'The Post button was not found', attempt: 1, createdAt: at(-40),
    },
    ...devices.slice(3, 8).map((device: { udid: string }, index: number) => ({
        id: `e-done-${index}`, scheduleId: `s${index + 3}`, deviceUdid: device.udid,
        pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1, status: 'succeeded', payload: {},
        scheduledFor: at(-200 - index * 10), deadlineAt: at(-170), startedAt: at(-200), finishedAt: at(-198),
        error: null, attempt: 1, createdAt: at(-200),
    })),
];

const schedules = devices.map((device: { udid: string }, index: number) => ({
    id: `s-${index}`, deviceUdid: device.udid, pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1,
    payload: {}, timing: { kind: 'daily', localTime: '21:05' }, status: 'active',
    nextRunAt: at(60 + index * 17), runWindowMinutes: 30, createdAt: now,
}));

const LOG = [
    '18:30:31 Tapped Create, then Upload',
    '18:30:44 Selected 1 clip from Recents',
    '18:31:02 Waiting for the editor',
];

const scheduler = {
    connection: null,
    async listExecutions(_limit: number, deviceUdid?: string) {
        return deviceUdid ? executions.filter((row) => row.deviceUdid === deviceUdid) : executions;
    },
    async listSchedules(_limit: number, deviceUdid?: string) {
        return deviceUdid ? schedules.filter((row: { deviceUdid: string }) => row.deviceUdid === deviceUdid) : schedules;
    },
    async execution(id: string) {
        const row = executions.find((entry) => entry.id === id);
        return row ? { ...row, logs: LOG } : null;
    },
    async activeExecution() { return null; },
};

// A screen that looks like a phone, so the wall is legible in a screenshot.
function screenPng(seed: number): Buffer {
    const hues = ['c9d6e8', 'd8d0e8', 'cfe0e8', 'dfe8d2', 'e8dcd0', 'd6e8e2'];
    const hue = hues[seed % hues.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="270" height="570">`
        + `<rect width="270" height="570" fill="#${hue}"/>`
        + `<text x="135" y="46" text-anchor="middle" font-family="Helvetica" font-size="26" fill="#ffffffcc">18:31</text>`
        + Array.from({ length: 8 }, (_, index) => `<rect x="${16 + (index % 4) * 62}" y="${470 + Math.floor(index / 4) * 40}" width="52" height="26" rx="7" fill="#ffffff99"/>`).join('')
        + '</svg>';
    return Buffer.from(svg);
}

const { default: sharp } = await import('sharp');
const frames = new Map<string, Buffer>();
for (const [index, device] of devices.entries()) {
    frames.set(device.udid, await sharp(screenPng(index)).png().toBuffer());
}

// The wizard, with one Android phone waiting to be set up.
const { checkNamesForPlatform } = await import('../src/devices/registration.js');
const candidate = { name: 'Pixel 8a', osVersion: '14', udid: 'R58N12WAITING', platform: 'android' as const, modelName: 'Pixel 8a' };
const state = (name: string, message: string) => ({ state: name as never, message, updatedAt: new Date(0).toISOString() });
let draft = {
    id: candidate.udid, device: candidate, name: candidate.name, platform: 'android' as const,
    checkNames: checkNamesForPlatform('android'), driver: 'adb' as const,
    availableProfiles: [], recommendedProfile: undefined, wdaLocalPort: 0, mjpegLocalPort: 0,
    tiktokAccounts: [], hasPasscode: false, busy: false,
    checks: {
        host: state('passed', 'adb 1.0.41 is on the PATH'),
        connection: state('passed', 'The phone answers adb'),
        developer: state('passed', 'USB debugging is allowed'),
        driver: state('checking', 'Reading the driver'),
        tiktok: state('pending', 'Not checked yet'),
        video: state('pending', 'Not checked yet'),
        touch: state('pending', 'Not checked yet'),
        accounts: state('pending', 'Not checked yet'),
    },
    logs: ['adb -s R58N12WAITING shell wm size', 'Physical size: 1080x2400'],
    canFinalize: false, finalized: false,
} as never;
const registrations = {
    async start() {}, async close() {},
    async candidates() { return [candidate]; },
    async create() { return draft; },
    async get() { return draft; },
    async update() { return draft; },
    async run() { return draft; },
    async cancel() {},
};

const app = await createApp({
    plugins: new PluginRegistry([]),
    registrations: registrations as never,
    scheduler: scheduler as never,
    dashboardTheme: defaultDashboardTheme,
    connectedUdids: async () => devices
        .map(({ udid }: { udid: string }) => udid)
        .filter((udid: string) => !OFFLINE.has(udid)),
    createDriver: (device) => ({
        kind: 'adb', platform: 'android', udid: device.udid,
        async launchApp() {}, async terminateApp() {}, async tap() {}, async swipe() {}, async type() {},
        async pressKey() {}, async uiTree() { throw new Error('not used'); }, async pushMedia() {}, async pause() {},
        async screenshot() { return frames.get(device.udid) ?? frames.values().next().value!; },
        async screen() { return { width: 1080, height: 2400, scale: 1 }; },
    }) as never,
});

// Answer every frame request from the fakes, including the iOS MJPEG stream, before the real
// routes get a chance to look for a phone that is not there.
app.addHook('onRequest', async (request, reply) => {
    const match = /^\/api\/devices\/([^/]+)\/remote\/(stream|screenshot)/.exec(request.url);
    if (!match) return;
    const frame = frames.get(decodeURIComponent(match[1]!));
    if (!frame) return;
    await reply.header('cache-control', 'no-store').type('image/png').send(frame);
});

// The device page asks discovery what the phone is; discovery is off here, so answer for it.
app.addHook('onRequest', async (request, reply) => {
    const summary = /^\/api\/devices\/([^/]+)\/fragments\/summary/.exec(request.url);
    if (summary) {
        const device = devices.find(({ udid }: { udid: string }) => udid === decodeURIComponent(summary[1]!));
        if (!device) return;
        await reply.type('text/html').send(`<section id="device-summary" class="bl-device-summary" data-screen-width="1080" data-screen-height="2400" data-platform="${device.platform}" data-driver="${device.driver ?? 'wda'}"><div class="bl-rows"><div><span>Platform</span><span>${device.platform === 'android' ? 'Android 14' : 'iOS 16.7'}</span></div><div><span>Driver</span><span>${device.driver ?? 'wda'}</span></div><div><span>Screen</span><span>1080 × 2400 pixels · 1×</span></div><div><span>Identifier</span><span class="bl-faint">${device.udid}</span></div></div></section>`);
        return;
    }
    const info = /^\/api\/devices\/([^/]+)\/remote\/info/.exec(request.url);
    if (info && frames.has(decodeURIComponent(info[1]!))) {
        await reply.send({ screen: { screenSize: { width: 1080, height: 2400 }, scale: 1 } });
    }
});

await app.listen({ host: '127.0.0.1', port: 3999 });
process.stdout.write('Backline preview on http://127.0.0.1:3999\n');
