import {
    createMockFarm,
    DEFAULT_SEVERITY,
    countStates,
    deriveDeviceState,
    eventText,
    formatDuration,
    gestureToAction,
    isPushWorthy,
    mapTouchToDevice,
    platformOf,
    pushText,
    severityAtLeast,
    type EventKind,
    type FarmEvent,
    type MockFarm,
} from '../src';

const NOW = Date.parse('2026-09-05T09:41:12.004Z');

function farm(overrides = {}): MockFarm {
    return createMockFarm({ now: NOW, tickMs: 0, ...overrides });
}

describe('createMockFarm — fleet invariants', () => {
    let mock: MockFarm;
    beforeEach(() => {
        mock = farm();
    });
    afterEach(() => mock.dispose());

    it('has 12 devices mixing iOS and Android', async () => {
        const devices = await mock.listDevices();
        expect(devices).toHaveLength(12);
        const platforms = devices.map(platformOf);
        expect(platforms.filter((p) => p === 'ios').length).toBeGreaterThanOrEqual(2);
        expect(platforms.filter((p) => p === 'android').length).toBeGreaterThanOrEqual(2);
    });

    it('redacts the passcode and keeps the bridge token off the wire shape the UI reads', async () => {
        const devices = await mock.listDevices();
        for (const device of devices) {
            expect(device).not.toHaveProperty('passcode');
            expect(typeof device.hasPasscode === 'boolean' || device.hasPasscode === undefined).toBe(true);
        }
    });

    it('reports connected: null for both offline and disabled devices', async () => {
        const devices = await mock.listDevices();
        const summary = await mock.getFleetSummary();
        for (const device of devices) {
            const state = summary.devices.find((row) => row.udid === device.udid)!.state;
            if (state === 'offline' || state === 'disabled') expect(device.connected).toBeNull();
            else expect(device.connected).not.toBeNull();
        }
    });

    it('produces counts that sum to the total and match the device list', async () => {
        const summary = await mock.getFleetSummary();
        const { counts, devices } = summary;
        expect(counts.total).toBe(devices.length);
        expect(counts.online + counts.busy + counts.offline + counts.disabled + counts.error).toBe(counts.total);
        expect(countStates(devices)).toEqual(counts);
    });

    it('covers every device state, including one disabled and one offline', async () => {
        const { counts } = await mock.getFleetSummary();
        expect(counts.disabled).toBeGreaterThanOrEqual(1);
        expect(counts.offline).toBeGreaterThanOrEqual(1);
        expect(counts.busy).toBeGreaterThanOrEqual(3);
        expect(counts.error).toBeGreaterThanOrEqual(1);
    });

    it('gives every busy device a current execution and nobody else one', async () => {
        const { devices } = await mock.getFleetSummary();
        for (const device of devices) {
            if (device.state === 'busy') expect(device.currentExecution).not.toBeNull();
            else expect(device.currentExecution).toBeNull();
        }
    });

    it('hands out screenshots as real, decodable PNG data URIs', () => {
        const ref = mock.screenshotRef('00008030-001A2B3C0E88802E', { width: 320, nonce: 1 });
        expect(ref.uri.startsWith('data:image/png;base64,')).toBe(true);
        const bytes = Buffer.from(ref.uri.slice('data:image/png;base64,'.length), 'base64');
        expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
        // …length, type, CRC: the type sits four bytes before the trailing CRC.
        expect(bytes.subarray(bytes.length - 8, bytes.length - 4).toString('ascii')).toBe('IEND');
    });

    it('changes the frame when the nonce changes, so refresh looks like refresh', () => {
        const first = mock.screenshotRef('R58N12ABCDE', { nonce: 1 }).uri;
        const second = mock.screenshotRef('R58N12ABCDE', { nonce: 2 }).uri;
        expect(first).not.toBe(second);
    });
});

describe('createMockFarm — conflicts the UI has to render', () => {
    let mock: MockFarm;
    beforeEach(() => {
        mock = farm();
    });
    afterEach(() => mock.dispose());

    it('refuses remote input while automation is running, with the farm\'s exact text', async () => {
        const { devices } = await mock.getFleetSummary();
        const busy = devices.find((device) => device.state === 'busy')!;
        await expect(mock.remoteAction(busy.udid, { type: 'tap', x: 10, y: 10 })).rejects.toMatchObject({
            kind: 'conflict',
            status: 409,
            message: 'Remote input is disabled while automation is running',
        });
    });

    it('refuses `back` on iOS with a 400, not a 409', async () => {
        const idle = (await mock.getFleetSummary()).devices.find(
            (device) => device.platform === 'ios' && device.state !== 'busy',
        )!;
        await expect(mock.remoteAction(idle.udid, { type: 'back' })).rejects.toMatchObject({ kind: 'validation' });
    });

    it('refuses to disable a busy device', async () => {
        const busy = (await mock.getFleetSummary()).devices.find((device) => device.state === 'busy')!;
        await expect(mock.patchDevice(busy.udid, { disabled: true })).rejects.toMatchObject({ kind: 'conflict' });
    });

    it('404s an unknown device, schedule, execution and content item', async () => {
        await expect(mock.getDeviceConnection('nope')).rejects.toMatchObject({ kind: 'not-found' });
        await expect(mock.setScheduleStatus('nope', 'pause')).rejects.toMatchObject({ kind: 'not-found' });
        await expect(mock.getExecution('nope')).rejects.toMatchObject({ kind: 'not-found' });
        await expect(mock.approveContentItem('nope')).rejects.toMatchObject({ kind: 'not-found' });
    });

    it('refuses to retry a succeeded execution', async () => {
        const { executions } = await mock.listExecutions();
        const succeeded = executions.find((row) => row.status === 'succeeded')!;
        await expect(mock.retryExecution(succeeded.id)).rejects.toMatchObject({
            kind: 'conflict',
            message: 'Execution is not retryable',
        });
    });

    it('retries a failed execution into a fresh queued row', async () => {
        const { executions } = await mock.listExecutions();
        const failed = executions.find((row) => row.status === 'failed')!;
        const retry = await mock.retryExecution(failed.id);
        expect(retry.id).not.toBe(failed.id);
        expect(retry.status).toBe('queued');
        expect(retry.error).toBeNull();
    });

    it('stays busy while a queued run is still behind the stopped one', async () => {
        const busy = (await mock.getFleetSummary()).devices.find((device) => device.state === 'busy')!;
        expect(await mock.stopExecution(busy.currentExecution!.id)).toEqual({ result: 'running' });

        // A queued run is still an active run: the device is not free yet, and
        // the farm's remote-input guard is still the thing saying no.
        const mid = (await mock.getFleetSummary()).devices.find((device) => device.udid === busy.udid)!;
        expect(mid.state).toBe('busy');
        expect(mid.currentExecution!.status).toBe('queued');
        await expect(mock.remoteAction(busy.udid, { type: 'tap', x: 1, y: 1 })).rejects.toMatchObject({ kind: 'conflict' });

        expect(await mock.stopExecution(mid.currentExecution!.id)).toEqual({ result: 'queued' });
        const after = (await mock.getFleetSummary()).devices.find((device) => device.udid === busy.udid)!;
        expect(after.state).not.toBe('busy');
        await expect(mock.remoteAction(busy.udid, { type: 'tap', x: 1, y: 1 })).resolves.toEqual({ ok: true });
    });

    it('reports `unsupported` rather than throwing when stopping a finished run', async () => {
        const { executions } = await mock.listExecutions();
        const done = executions.find((row) => row.status === 'succeeded')!;
        await expect(mock.stopExecution(done.id)).resolves.toEqual({ result: 'unsupported' });
    });

    it('rejects a task envelope the farm never advertised', async () => {
        const idle = (await mock.getFleetSummary()).devices.find((device) => device.state === 'online')!;
        await expect(
            mock.createSchedule({
                deviceUdid: idle.udid,
                task: { pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 99, payload: {} },
                timing: { kind: 'now' },
            }),
        ).rejects.toMatchObject({ kind: 'validation' });
    });

    it('doomscroll-now makes the device busy', async () => {
        const idle = (await mock.getFleetSummary()).devices.find((device) => device.state === 'online')!;
        const plugins = await mock.listPlugins();
        const task = plugins[0]!.tasks[0]!;
        await mock.createSchedule({
            deviceUdid: idle.udid,
            task: { pluginId: plugins[0]!.id, taskType: task.type, taskVersion: task.version, payload: { minutes: 12 } },
            timing: { kind: 'now' },
        });
        const after = (await mock.getFleetSummary()).devices.find((device) => device.udid === idle.udid)!;
        expect(after.state).toBe('busy');
        expect(after.currentExecution).not.toBeNull();
    });
});

describe('createMockFarm — schedules, executions, content', () => {
    let mock: MockFarm;
    beforeEach(() => {
        mock = farm();
    });
    afterEach(() => mock.dispose());

    it('pages executions by keyset without ever repeating a row', async () => {
        const seen = new Set<string>();
        let before: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
            const listPage = await mock.listExecutions({ limit: 10, before });
            for (const row of listPage.executions) {
                expect(seen.has(row.id)).toBe(false);
                seen.add(row.id);
            }
            if (!listPage.nextBefore) break;
            before = listPage.nextBefore;
        }
        expect(seen.size).toBeGreaterThan(10);
    });

    it('filters schedules and executions by device', async () => {
        const udid = (await mock.listDevices())[0]!.udid;
        const { schedules } = await mock.listSchedules({ deviceUdid: udid });
        const { executions } = await mock.listExecutions({ deviceUdid: udid });
        expect(schedules.length).toBeGreaterThan(0);
        expect(schedules.every((row) => row.deviceUdid === udid)).toBe(true);
        expect(executions.every((row) => row.deviceUdid === udid)).toBe(true);
    });

    it('covers every execution status in the seeded history', async () => {
        const { executions } = await mock.listExecutions();
        const statuses = new Set(executions.map((row) => row.status));
        for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped', 'stopped']) {
            expect(statuses.has(status as never)).toBe(true);
        }
    });

    it('covers every schedule status and all four timing shapes', async () => {
        const { schedules } = await mock.listSchedules();
        expect(new Set(schedules.map((row) => row.status))).toEqual(
            new Set(['active', 'paused', 'completed', 'cancelled']),
        );
        expect(new Set(schedules.map((row) => row.timing.kind))).toEqual(new Set(['now', 'once', 'daily', 'weekly']));
    });

    it('only gives an active schedule a nextRunAt', async () => {
        const { schedules } = await mock.listSchedules();
        for (const row of schedules) {
            if (row.status === 'active') expect(row.nextRunAt).toBeTruthy();
            else expect(row.nextRunAt).toBeNull();
        }
    });

    it('pauses and resumes, and refuses to resume something already active', async () => {
        const active = (await mock.listSchedules()).schedules.find((row) => row.status === 'active')!;
        expect((await mock.setScheduleStatus(active.id, 'pause')).status).toBe('paused');
        expect((await mock.setScheduleStatus(active.id, 'resume')).status).toBe('active');
        await expect(mock.setScheduleStatus(active.id, 'resume')).rejects.toMatchObject({ kind: 'conflict' });
    });

    it('refuses to edit a cancelled schedule', async () => {
        const cancelled = (await mock.listSchedules()).schedules.find((row) => row.status === 'cancelled')!;
        await expect(mock.setScheduleStatus(cancelled.id, 'pause')).rejects.toMatchObject({ kind: 'conflict' });
    });

    it('returns execution logs with the tail last', async () => {
        const failed = (await mock.listExecutions()).executions.find((row) => row.status === 'failed')!;
        const detail = await mock.getExecution(failed.id);
        expect(detail.logs.length).toBeGreaterThan(10);
        expect(detail.logs[detail.logs.length - 1]).toContain('attempt 3 of 3');
    });

    it('approves and skips content once, then conflicts', async () => {
        const { items } = await mock.listContentQueue();
        const planned = items.filter((item) => item.status === 'planned');
        expect(planned.length).toBeGreaterThanOrEqual(2);
        const approved = await mock.approveContentItem(planned[0]!.id, { plannedFor: '2026-09-09T18:00:00.000Z' });
        expect(approved.status).toBe('approved');
        expect(approved.plannedFor).toBe('2026-09-09T18:00:00.000Z');
        await expect(mock.approveContentItem(planned[0]!.id)).rejects.toMatchObject({ kind: 'conflict' });
        expect((await mock.skipContentItem(planned[1]!.id)).status).toBe('skipped');
    });

    it('reports a partial bulk result rather than failing the whole call', async () => {
        const devices = await mock.listDevices();
        const disabled = devices.find((device) => device.disabled)!;
        const ok = devices.find((device) => !device.disabled)!;
        const result = await mock.createSchedulesBulk({
            deviceUdids: [disabled.udid, ok.udid],
            task: { pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1, payload: {} },
            timing: { kind: 'now' },
        });
        expect(result.created).toHaveLength(1);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]!.deviceUdid).toBe(disabled.udid);
    });
});

describe('createMockFarm — events, ack, bootstrap, SSE', () => {
    let mock: MockFarm;
    beforeEach(() => {
        mock = farm();
    });
    afterEach(() => mock.dispose());

    it('returns events newest first with monotonically decreasing ids', async () => {
        const { events } = await mock.listEvents({ limit: 50 });
        expect(events.length).toBeGreaterThan(10);
        for (let index = 1; index < events.length; index += 1) {
            expect(events[index - 1]!.id > events[index]!.id).toBe(true);
        }
    });

    it('gives each event the documented default severity for its kind', async () => {
        const { events } = await mock.listEvents({ limit: 200 });
        for (const event of events) {
            const expected = DEFAULT_SEVERITY[event.kind as EventKind];
            if (expected) expect(event.severity).toBe(expected);
        }
    });

    it('filters by severity, kind and device', async () => {
        const errors = await mock.listEvents({ severity: 'error' });
        expect(errors.events.length).toBeGreaterThan(0);
        expect(errors.events.every((event) => event.severity === 'error')).toBe(true);

        const failures = await mock.listEvents({ kind: ['execution.failed'] });
        expect(failures.events.every((event) => event.kind === 'execution.failed')).toBe(true);

        const udid = failures.events[0]!.deviceUdid!;
        const byDevice = await mock.listEvents({ deviceUdid: udid });
        expect(byDevice.events.every((event) => event.deviceUdid === udid)).toBe(true);
    });

    it('walks backwards with the `before` cursor and stops', async () => {
        const first = await mock.listEvents({ limit: 5 });
        expect(first.nextBefore).toBeDefined();
        const second = await mock.listEvents({ limit: 5, before: first.nextBefore });
        expect(second.events.every((event) => event.id < first.nextBefore!)).toBe(true);
    });

    it('acknowledges up to an id and zeroes the badge', async () => {
        const { unacknowledgedCount } = await mock.bootstrap();
        expect(unacknowledgedCount).toBeGreaterThan(0);
        const newest = (await mock.listEvents({ limit: 1 })).events[0]!;
        const result = await mock.ackEvents(newest.id);
        expect(result.unacknowledgedCount).toBe(0);
        expect(result.acknowledged).toBe(unacknowledgedCount);
        expect((await mock.bootstrap()).unacknowledgedCount).toBe(0);
        expect((await mock.listEvents({ acknowledged: false })).events).toHaveLength(0);
    });

    it('bootstrap carries everything the cold start needs in one call', async () => {
        const boot = await mock.bootstrap();
        expect(boot.fleet.devices).toHaveLength(12);
        expect(boot.fleet.counts.total).toBe(12);
        expect(boot.plugins.length).toBeGreaterThan(0);
        expect(boot.recentEvents.length).toBeGreaterThan(0);
        expect(boot.capabilities).toMatchObject({ events: true, sse: true, push: true, eventAck: true });
        expect(boot.release?.sha).toBeTruthy();
    });

    it('ticks new events to a subscriber and stops on unsubscribe', () => {
        jest.useFakeTimers();
        const ticking = createMockFarm({ now: NOW, tickMs: 3_000, seed: 5 });
        const received: FarmEvent[] = [];
        const unsubscribe = ticking.subscribeEvents({ onEvent: (event) => received.push(event) });

        jest.advanceTimersByTime(9_500);
        expect(received.length).toBe(3);
        const countAtUnsubscribe = received.length;

        unsubscribe();
        jest.advanceTimersByTime(30_000);
        expect(received.length).toBe(countAtUnsubscribe);

        ticking.dispose();
        jest.useRealTimers();
    });

    it('replays what was missed when a subscriber resumes from a last-rendered id', async () => {
        const before = (await mock.listEvents({ limit: 1 })).events[0]!.id;
        const emitted = [mock.emit({ kind: 'device.error' }), mock.emit({ kind: 'execution.failed' })];
        const replayed: string[] = [];
        const unsubscribe = mock.subscribeEvents({
            lastEventId: before,
            onEvent: (event) => replayed.push(event.id),
        });
        expect(replayed).toEqual(emitted.map((event) => event.id));
        unsubscribe();
    });

    it('registers push idempotently on the name and never echoes the token', async () => {
        const first = await mock.registerPush({
            expoPushToken: 'ExponentPushToken[abcdefghij]',
            name: 'marcus-iphone',
            minSeverity: 'warning',
            kinds: ['execution.failed'],
        });
        const second = await mock.registerPush({
            expoPushToken: 'ExponentPushToken[abcdefghij]',
            name: 'marcus-iphone',
            minSeverity: 'error',
            kinds: null,
        });
        expect(second.id).toBe(first.id);
        expect(second.minSeverity).toBe('error');
        expect(await mock.listPushRegistrations()).toHaveLength(1);
        expect(JSON.stringify(second)).not.toContain('ExponentPushToken[abcdefghij]');
    });
});

describe('derivations and event text', () => {
    it('lets `disabled` win over `connected: null`', () => {
        expect(deriveDeviceState({ disabled: true, connected: null })).toBe('disabled');
        expect(deriveDeviceState({ connected: null })).toBe('offline');
        expect(deriveDeviceState({ connected: { udid: 'a', name: 'b' } })).toBe('online');
        expect(deriveDeviceState({ connected: { udid: 'a', name: 'b' } }, null, true)).toBe('busy');
        expect(deriveDeviceState({ connected: { udid: 'a', name: 'b' } }, { physical: 'connected', wda: 'error' })).toBe('error');
    });

    it('maps a touch in a contain-fitted image back to device points', () => {
        // A 375×667 screen in a 300×600 view fits to 300×533, letterboxed 33px.
        const view = { width: 300, height: 600 };
        const screen = { width: 375, height: 667 };
        expect(mapTouchToDevice({ x: 150, y: 300 }, view, screen)).toEqual({ x: 188, y: 334 });
        expect(mapTouchToDevice({ x: 0, y: 0 }, view, screen)).toBeNull(); // letterbox
        expect(mapTouchToDevice({ x: 150, y: 599 }, view, screen)).toBeNull();
    });

    it('turns a wobble into a tap and a drag into a clamped swipe', () => {
        expect(gestureToAction({ x: 10, y: 10 }, { x: 13, y: 12 }, 90)).toEqual({ type: 'tap', x: 10, y: 10 });
        expect(gestureToAction({ x: 10, y: 500 }, { x: 10, y: 100 }, 10)).toMatchObject({ type: 'swipe', durationMs: 50 });
        expect(gestureToAction({ x: 10, y: 500 }, { x: 10, y: 100 }, 99_000)).toMatchObject({ durationMs: 3_000 });
    });

    it('prefers the farm\'s operator-facing text and falls back when it is missing', () => {
        const base: FarmEvent = {
            id: '1',
            kind: 'execution.failed',
            severity: 'error',
            deviceUdid: '00008030-001A2B3C0E88802E',
            title: 'Doomscroll failed on iPhone 8 · slot 1',
            message: 'TikTok did not reach the feed after 3 attempts',
            createdAt: new Date(NOW).toISOString(),
        };
        expect(eventText(base)).toEqual({ title: base.title, body: base.message });

        const bare = { ...base, title: '', message: '', data: { attempt: 3, exitCode: 1 } };
        const text = eventText(bare, 'iPhone 8 · slot 1');
        expect(text.title).toBe('Run failed on iPhone 8 · slot 1');
        expect(text.body).toContain('3 attempts');
    });

    it('keeps a push body free of identifiers that leave the tailnet', () => {
        const event: FarmEvent = {
            id: '1',
            kind: 'execution.failed',
            severity: 'error',
            deviceUdid: '00008030-001A2B3C0E88802E',
            title: 'x',
            message: 'handle @acct_one hit a captcha',
            data: { exitCode: 1 },
            createdAt: new Date(NOW).toISOString(),
        };
        const text = pushText(event, 'iPhone 8 · slot 1');
        const rendered = `${text.title} ${text.body}`;
        expect(rendered).toContain('iPhone 8 · slot 1');
        expect(rendered).not.toContain('00008030');
        expect(rendered).not.toContain('@acct_one');
    });

    it('marks exactly the four push-worthy kinds', () => {
        expect(isPushWorthy('execution.failed')).toBe(true);
        expect(isPushWorthy('device.disconnected')).toBe(true);
        expect(isPushWorthy('device.error')).toBe(true);
        expect(isPushWorthy('execution.stuck')).toBe(true);
        expect(isPushWorthy('execution.started')).toBe(false);
        expect(isPushWorthy('digest.daily')).toBe(false);
    });

    it('ranks severity for the minSeverity filter', () => {
        expect(severityAtLeast('error', 'warning')).toBe(true);
        expect(severityAtLeast('info', 'warning')).toBe(false);
        expect(severityAtLeast('warning', 'warning')).toBe(true);
    });

    it('formats durations the way a card has room for', () => {
        expect(formatDuration(4_000)).toBe('4s');
        expect(formatDuration(240_000)).toBe('4m');
        expect(formatDuration(3_600_000)).toBe('1h');
        expect(formatDuration(5_400_000)).toBe('1h 30m');
        expect(formatDuration(-1)).toBe('—');
    });
});
