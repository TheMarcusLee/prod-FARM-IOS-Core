/**
 * Boots the Schedule, Content and Runbooks pages against fabricated data on 127.0.0.1:3998, so the
 * three surfaces can be looked at (and screenshotted for docs/design/screenshots) without a
 * database, a phone or a rig. Nothing here touches production code paths beyond the route modules
 * themselves — the scheduler, the content store and the device registry are all fakes.
 *
 *   node --import tsx scripts/preview-pages.mts
 */

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = await mkdtemp(path.join(os.tmpdir(), 'backline-preview-'));
process.env.DEVICES_CONFIG_PATH = path.join(workspace, 'devices.json');
process.env.SCHEDULER_DATA_DIR = workspace;
process.env.ANDROID_DISCOVERY = 'off';

const { registerContentRoutes } = await import('../src/api/routes/content.js');
const { registerScheduleRoutes } = await import('../src/api/routes/schedule.js');
const { registerRunbookRoutes } = await import('../src/runbook/routes.js');
const { createMemoryEventStore } = await import('../src/fleet/events.js');
const { writeRunbook } = await import('../src/runbook/store.js');

type Row = Record<string, unknown>;

const STATIC_ROOT = fileURLToPath(new URL('../static/dashboard/', import.meta.url));
const PORT = 3998;

const NAMES = [
    'iPhone 8', 'Pixel 7', 'Galaxy A52', 'Moto G54', 'iPhone SE', 'Galaxy A14',
    'Pixel 6a', 'iPhone 11', 'Moto G34', 'Redmi Note 12', 'iPhone XR', 'Galaxy A34',
];
const ACCOUNTS = [
    '@farm.one', '@farm.two', '@farm.three', '@farm.four', '@farm.five',
    '@farm.six', '@farm.seven', '@farm.eight',
];

const now = new Date();
function at(hour: number, minute: number): Date {
    const value = new Date(now.getTime());
    value.setHours(hour, minute, 0, 0);
    return value;
}

const devices = NAMES.map((name, index) => ({
    udid: `preview-device-${String(index + 1).padStart(2, '0')}`,
    name,
    platform: index % 2 === 0 ? 'ios' : 'android',
    pluginData: index < ACCOUNTS.length
        ? { 'com.git-agni.tiktok': { accounts: [ACCOUNTS[index]] } }
        : {},
    ...(index === 8 ? { disabled: true } : {}),
}));
await writeFile(process.env.DEVICES_CONFIG_PATH, JSON.stringify(devices, null, 2));

const hour = now.getHours();
/** Tonight's work: one running post, one failure with its retry, a spread of queued and done posts. */
const executions: Row[] = [
    exec('e-01', 0, at(hour - 2, 12), 'succeeded', { account: ACCOUNTS[0], caption: 'day 14' }),
    exec('e-02', 1, at(hour, 2), 'running', { account: ACCOUNTS[1], caption: 'gym pov #3' }),
    exec('e-03', 1, at(hour + 2, 35), 'queued', { account: ACCOUNTS[1], caption: 'gym pov #4' }),
    exec('e-04', 2, at(hour, 25), 'failed', { account: ACCOUNTS[2], caption: 'stitch reply' },
        'The Post button was not found on screen'),
    exec('e-05', 2, at(hour + 1, 30), 'queued', { account: ACCOUNTS[2], caption: 'stitch reply' }),
    exec('e-06', 3, at(hour + 1, 40), 'queued', { account: ACCOUNTS[3], caption: 'morning routine' }),
    exec('e-07', 3, at(hour + 4, 50), 'queued', { account: ACCOUNTS[3], caption: 'recap' }),
    exec('e-08', 5, at(hour - 1, 40), 'succeeded', { account: ACCOUNTS[5], caption: 'warm-up scroll' }),
    exec('e-09', 5, at(hour + 2, 15), 'queued', { account: ACCOUNTS[5], caption: 'unboxing' }),
    exec('e-10', 6, at(hour + 3, 10), 'queued', { account: ACCOUNTS[6], caption: 'day 15' }),
    exec('e-11', 7, at(hour + 3, 55), 'queued', { account: ACCOUNTS[7], caption: 'q and a' }),
];

function exec(id: string, deviceIndex: number, when: Date, status: string, payload: Row, error?: string): Row {
    return {
        id, scheduleId: `s-${deviceIndex}`, deviceUdid: devices[deviceIndex]!.udid,
        pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1, payload,
        scheduledFor: when, deadlineAt: new Date(when.getTime() + 26 * 60_000),
        status, queueJobId: null,
        startedAt: status === 'running' || status === 'succeeded' || status === 'failed' ? when : null,
        finishedAt: status === 'succeeded' || status === 'failed' ? new Date(when.getTime() + 9 * 60_000) : null,
        exitCode: null, error: error ?? null, stopRequestedAt: null,
        createdAt: when, updatedAt: when,
    };
}

const schedules: Row[] = devices.slice(0, 8).map((device, index) => ({
    id: `s-${index}`, deviceUdid: device.udid, pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1,
    payload: {}, timing: { kind: 'daily', localTime: '19:00', timezone: 'UTC' },
    status: index === 4 ? 'paused' : 'active', runWindowMinutes: 30,
    nextRunAt: at(hour + 2, 0), createdAt: now, updatedAt: now,
}));

const items = Array.from({ length: 12 }, (_, index) => ({
    id: `item-${index}`, assetId: `asset-${index}`, originalAssetId: null,
    kind: index % 4 === 3 ? 'image' : 'video', durationMs: 18_000 + index * 1_500,
    width: 1080, height: 1920, normalized: index % 3 !== 2, sha256: `sha-${index}`,
    tags: index % 2 ? ['fitness', 'ugc'] : ['lifestyle'],
    caption: ['Leg day', 'Morning routine', 'Unboxing', 'Gym pov', 'Recap', 'Coffee run'][index % 6] ?? null,
    hashtags: ['gym', 'fyp'], posterPath: null, createdAt: now,
    usedCount: index % 5, lastUsedAt: index % 5 ? now : null,
    status: index === 7 ? 'processing' : index === 9 ? 'failed' : 'ready',
    error: index === 9 ? 'ffmpeg could not read the container' : null,
}));

const rules = devices.slice(0, 4).map((device, index) => ({
    id: `rule-${index}`, deviceUdid: device.udid, account: ACCOUNTS[index] as string, enabled: index !== 3,
    postsPerDay: 2 + (index % 2), windowStart: '09:00', windowEnd: '21:00', timezone: 'Europe/London',
    minGapMinutes: 120, destination: index % 2 ? 'publish' : 'draft', source: 'tag',
    setId: null, tag: index % 2 ? 'fitness' : 'lifestyle', captionTemplateId: null,
    pickOrder: 'random', avoidReuseDays: 30, lastPlannedDate: null, createdAt: now, updatedAt: now,
}));

const plans = [
    { id: 'plan-1', ruleId: 'rule-0', date: '', scheduleId: null, itemId: 'item-0', plannedFor: at(hour + 1, 20), usedMarkedAt: null, createdAt: now, status: null },
    { id: 'plan-2', ruleId: 'rule-1', date: '', scheduleId: null, itemId: 'item-1', plannedFor: at(hour + 4, 5), usedMarkedAt: null, createdAt: now, status: null },
    { id: 'plan-3', ruleId: 'rule-2', date: '', scheduleId: null, itemId: 'item-2', plannedFor: at(hour + 5, 25), usedMarkedAt: null, createdAt: now, status: null },
];

const sets = [
    { id: 'set-1', name: 'Gym b-roll', notes: 'Vertical clips only', createdAt: now, itemCount: 6 },
    { id: 'set-2', name: 'Slideshows', notes: null, createdAt: now, itemCount: 3 },
];
const templates = [
    { id: 'tpl-1', name: 'Hook', template: '{title} {random:new drop|back at it} {hashtags}', createdAt: now },
    { id: 'tpl-2', name: 'Plain', template: '{title}', createdAt: now },
];

const unused = () => { throw new Error('not used by the preview'); };
const store = {
    listItems: async () => items, item: async (id: string) => items.find((entry) => entry.id === id) ?? null,
    listSets: async () => sets, listTemplates: async () => templates,
    listRules: async () => rules, rule: async (id: string) => rules.find((entry) => entry.id === id) ?? null,
    upcomingPlans: async (ruleId?: string) => plans.filter((plan) => !ruleId || plan.ruleId === ruleId),
    insertAsset: unused, assetPath: async () => null, thumbnailAsset: async () => null,
    itemForAsset: async () => null, queuePlans: async () => [], queuePlan: async () => null,
    markPlanSkipped: async () => {}, insertItem: unused, updateItem: async () => null, deleteItem: async () => false,
    createSet: unused, deleteSet: async () => false, setItems: async () => [], setSetItems: async () => {},
    template: async () => null, createTemplate: unused, deleteTemplate: async () => false,
    createRule: unused, updateRule: async () => null, deleteRule: async () => false,
    candidateItems: async () => [], plansForDates: async () => [], insertPlan: unused,
    unstartedScheduleIds: async () => [], unstartedPlans: async () => [], deletePlans: async () => 0,
    succeededUnmarkedPlans: async () => [], markPlanUsed: async () => false, withPlannerLock: async () => null,
};

const scheduler = {
    async listExecutions(limit = 100) { return executions.slice(0, limit); },
    async listSchedules(limit = 100) { return schedules.slice(0, limit); },
    async execution(id: string) { return executions.find((row) => row.id === id) ?? null; },
    async setScheduleStatus() { return null; },
    async createTask() { return schedules[0]; },
};

const events = createMemoryEventStore([
    { id: 9, kind: 'execution.succeeded', severity: 'info', deviceUdid: devices[0]!.udid, executionId: 'e-01', scheduleId: 's-0', title: 'Posted day 14 to @farm.one', detail: null, createdAt: at(hour, 41) },
    { id: 8, kind: 'execution.failed', severity: 'error', deviceUdid: devices[2]!.udid, executionId: 'e-04', scheduleId: 's-2', title: 'Post failed, the Post button was not found. Retrying at 19:30.', detail: null, createdAt: at(hour, 34) },
    { id: 7, kind: 'device.connected', severity: 'info', deviceUdid: devices[3]!.udid, executionId: null, scheduleId: null, title: 'Moto G54 came back online', detail: null, createdAt: at(hour, 12) },
    { id: 5, kind: 'execution.started', severity: 'info', deviceUdid: devices[1]!.udid, executionId: 'e-02', scheduleId: 's-1', title: 'Posting gym pov #3 to @farm.two', detail: null, createdAt: at(hour, 2) },
    { id: 4, kind: 'schedule.paused', severity: 'warning', deviceUdid: devices[4]!.udid, executionId: null, scheduleId: 's-4', title: 'Warm-up on iPhone SE paused by the operator', detail: null, createdAt: at(hour - 3, 40) },
].map((event) => ({ ...event })) as never);

const app = Fastify({ logger: false });
await app.register(formbody);

const css = await readFile(path.join(STATIC_ROOT, 'backline.css'), 'utf8');
const legacy = await readFile(path.join(STATIC_ROOT, 'styles.css'), 'utf8');
const htmx = await readFile(new URL('../node_modules/htmx.org/dist/htmx.min.js', import.meta.url), 'utf8');
app.get('/assets/backline.css', async (_request, reply) => reply.type('text/css').send(css));
app.get('/assets/styles.css', async (_request, reply) => reply.type('text/css').send(legacy));
app.get('/assets/htmx.min.js', async (_request, reply) => reply.type('text/javascript').send(htmx));

await registerScheduleRoutes(app, {
    scheduler: scheduler as never,
    loadDevices: async () => devices as never,
    connectedUdids: async () => devices.filter((_, index) => index !== 8 && index !== 10).map(({ udid }) => udid),
    contentStore: store as never,
    events: events as never,
});
await registerContentRoutes(app, { scheduler: scheduler as never, store: store as never, plannerIntervalMinutes: 0 });

for (const [index, name] of ['Warm up the feed', 'Follow back', 'Clear notifications'].entries()) {
    await writeRunbook({
        id: `preview-runbook-${index}`, name, description: 'Recorded on Pixel 7',
        platform: index === 1 ? 'android' : 'any', createdAt: now.toISOString(), updatedAt: now.toISOString(),
        createdFor: { udid: devices[1]!.udid, screen: { width: 1080, height: 2400, scale: 1 } },
        steps: [
            { type: 'launchApp', appId: 'com.zhiliaoapp.musically' },
            { type: 'wait', ms: 2_000 },
            { type: 'tap', target: { id: 'com.app:id/feed', fraction: { x: 0.5, y: 0.6 } } },
            { type: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, durationMs: 300 },
            { type: 'screenshot', label: 'after scroll' },
        ], version: 1,
    } as never, workspace);
}

await registerRunbookRoutes({
    app, routePrefix: '/plugins/com.farm.runbook', scheduler: scheduler as never,
    remote: {} as never, loadDevices: async () => devices as never,
    saveDevices: async () => {}, mutateDevices: async () => undefined as never,
    renderActivity: async () => '',
}, { directory: workspace, createDriver: () => ({ async screen() { return { width: 1080, height: 2400, scale: 1 }; } }) as never });

await app.listen({ host: '127.0.0.1', port: PORT });
process.stdout.write(`Backline page preview on http://127.0.0.1:${PORT}/schedule\n`);
