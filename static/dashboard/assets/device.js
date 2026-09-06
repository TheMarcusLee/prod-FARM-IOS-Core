import { FramePump } from './shell.js';
function element(selector) {
    const value = document.querySelector(selector);
    if (!value)
        throw new Error(`Missing element: ${selector}`);
    return value;
}
const udid = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1) ?? '');
const elements = {
    screen: element('#screen'),
    status: element('#status'),
    statusText: element('#status span:last-child'),
    refresh: element('#refresh'),
    toggle: element('#toggle'),
    remoteButtons: Array.from(document.querySelectorAll('[data-remote-action]')),
    openPost: element('#open-post'),
    openDoomscroll: element('#open-doomscroll'),
    doomscrollDialog: element('#doomscroll-dialog'),
    closeDoomscroll: element('#close-doomscroll'),
    cancelDoomscroll: element('#cancel-doomscroll'),
    doomscrollDuration: element('#doomscroll-duration'),
    doomscrollDurationButtons: Array.from(document.querySelectorAll('[data-doomscroll-duration]')),
    postDialog: element('#post-dialog'),
    postForm: element('#post-form'),
    closePost: element('#close-post'),
    cancelPost: element('#cancel-post'),
    submitPost: element('#submit-post'),
    media: element('#media'),
    mediaList: element('#media-list'),
    musicUrl: element('#music-url'),
    caption: element('#caption'),
    postAccount: element('#post-account'),
    publishConfirm: element('#publish-confirm'),
    confirmPublish: element('#confirm-publish'),
    postResult: element('#post-result'),
    doomscrollForm: element('#doomscroll-form'),
    doomscrollRecurring: element('#doomscroll-recurring'),
    doomscrollStartOptions: element('#doomscroll-start-options'),
    doomscrollStartKind: element('#doomscroll-start-kind'),
    doomscrollOnceFields: element('#doomscroll-once-fields'),
    doomscrollRecurringFields: element('#doomscroll-recurring-fields'),
    doomscrollFrequency: element('#doomscroll-frequency'),
    doomscrollWeekdayFields: element('#doomscroll-weekday-fields'),
    doomscrollWeekdayInputs: Array.from(document.querySelectorAll('#doomscroll-weekday-fields input[type="checkbox"]')),
    doomscrollRunWindowField: element('#doomscroll-run-window-field'),
    doomscrollScheduleKind: element('#doomscroll-schedule-kind'),
    doomscrollWeekdays: element('#doomscroll-weekdays'),
    doomscrollRunAt: element('#doomscroll-run-at'),
    doomscrollRunAtIso: element('#doomscroll-run-at-iso'),
    timezoneInputs: Array.from(document.querySelectorAll('.browser-timezone')),
    postRecurring: element('#post-recurring'),
    postStartOptions: element('#post-start-options'),
    postStartKind: element('#post-start-kind'),
    postOnceFields: element('#post-once-fields'),
    postRecurringFields: element('#post-recurring-fields'),
    postFrequency: element('#post-frequency'),
    postWeekdayFields: element('#post-weekday-fields'),
    postWeekdayInputs: Array.from(document.querySelectorAll('#post-weekday-fields input[type="checkbox"]')),
    postRunWindowField: element('#post-run-window-field'),
    postRunAt: element('#post-run-at'),
    postLocalTime: element('#post-local-time'),
    postRunWindow: element('#post-run-window'),
    accountsForm: element('#accounts-form'),
    deviceAccounts: element('#device-accounts'),
    accountsResult: element('#accounts-result'),
    accountsDialog: element('#accounts-dialog'),
    openAccounts: element('#open-accounts'),
    closeAccounts: element('#close-accounts'),
    passcodeDialog: element('#passcode-dialog'),
    openPasscode: element('#open-passcode'),
    closePasscode: element('#close-passcode'),
    removeDialog: element('#remove-dialog'),
    openRemove: element('#open-remove'),
    closeRemove: element('#close-remove'),
    deviceSchedules: element('#device-schedules'),
    deviceExecutions: element('#device-executions'),
    tasksDialog: element('#tasks-dialog'),
    openTasks: element('#open-tasks'),
    closeTasks: element('#close-tasks'),
    passcodeForm: element('#passcode-form'),
    devicePasscode: element('#device-passcode'),
    passcodeClear: element('#passcode-clear'),
    passcodeState: element('#passcode-state'),
    passcodeResult: element('#passcode-result'),
    openCalibrate: element('#open-calibrate'),
    calibrateDialog: element('#calibrate-dialog'),
    closeCalibrate: element('#close-calibrate'),
    calScreen: element('#cal-screen'),
    calControl: element('#cal-control'),
    calUnlock: element('#cal-unlock'),
    calMarkers: element('#cal-markers'),
    calPoints: element('#cal-points'),
    calStatus: element('#cal-status'),
    calProfile: element('#cal-profile'),
    calResetAll: element('#cal-reset-all'),
    calCancel: element('#cal-cancel'),
    calSave: element('#cal-save'),
    removeDevice: element('#remove-device'),
    removeResult: element('#remove-result'),
};
let screenSize;
let pump = null;
let devicePlatform = 'ios';
let paused = false;
let connecting = false;
let pointerStart;
let orderedMedia = [];
let postPoll;
let connectionPoll;
let connectionChecking = false;
const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
elements.timezoneInputs.forEach((input) => { input.value = browserTimezone; });
function selectedWeekdays(inputs) {
    return inputs.filter(({ checked }) => checked).map(({ value }) => Number(value));
}
function updateDoomscrollSchedule() {
    const recurring = elements.doomscrollRecurring.checked;
    const kind = recurring ? elements.doomscrollFrequency.value : elements.doomscrollStartKind.value;
    elements.doomscrollScheduleKind.value = kind;
    elements.doomscrollWeekdays.value = selectedWeekdays(elements.doomscrollWeekdayInputs).join(',');
    elements.doomscrollStartOptions.hidden = recurring;
    elements.doomscrollOnceFields.hidden = recurring || kind !== 'once';
    elements.doomscrollRecurringFields.hidden = !recurring;
    elements.doomscrollWeekdayFields.hidden = !recurring || kind !== 'weekly';
    elements.doomscrollRunWindowField.hidden = kind === 'now';
    elements.doomscrollRunAt.required = kind === 'once';
}
function updatePostSchedule() {
    const recurring = elements.postRecurring.checked;
    const kind = recurring ? elements.postFrequency.value : elements.postStartKind.value;
    elements.postStartOptions.hidden = recurring;
    elements.postOnceFields.hidden = recurring || kind !== 'once';
    elements.postRecurringFields.hidden = !recurring;
    elements.postWeekdayFields.hidden = !recurring || kind !== 'weekly';
    elements.postRunWindowField.hidden = kind === 'now';
    elements.postRunAt.required = kind === 'once';
}
elements.doomscrollRecurring.addEventListener('change', updateDoomscrollSchedule);
elements.doomscrollStartKind.addEventListener('change', updateDoomscrollSchedule);
elements.doomscrollFrequency.addEventListener('change', updateDoomscrollSchedule);
elements.doomscrollWeekdayInputs.forEach((input) => input.addEventListener('change', updateDoomscrollSchedule));
elements.postRecurring.addEventListener('change', updatePostSchedule);
elements.postStartKind.addEventListener('change', updatePostSchedule);
elements.postFrequency.addEventListener('change', updatePostSchedule);
elements.doomscrollForm.addEventListener('submit', () => {
    updateDoomscrollSchedule();
    elements.doomscrollRunAtIso.value = elements.doomscrollRunAt.value
        ? new Date(elements.doomscrollRunAt.value).toISOString()
        : '';
});
elements.openDoomscroll.addEventListener('click', () => elements.doomscrollDialog.showModal());
elements.closeDoomscroll.addEventListener('click', () => elements.doomscrollDialog.close());
elements.cancelDoomscroll.addEventListener('click', () => elements.doomscrollDialog.close());
elements.doomscrollDurationButtons.forEach((button) => {
    button.addEventListener('click', () => {
        elements.doomscrollDuration.value = button.dataset.doomscrollDuration ?? '';
    });
});
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function setStatus(message, state = '') {
    elements.status.className = `bl-state ${state}`;
    const dot = elements.status.querySelector('.bl-dot');
    if (dot)
        dot.className = `bl-dot ${state}`;
    elements.statusText.textContent = message;
}
async function jsonRequest(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok)
        throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
}
/**
 * iOS phones have a real MJPEG stream; Android has none, so its frames are polled by the same
 * pump the wall uses. Either way `#screen` ends up showing the phone.
 */
function startStream() {
    if (paused || !screenSize)
        return;
    setStatus('Connecting to the phone', 'busy');
    pump?.stop();
    pump = new FramePump(elements.screen, udid, devicePlatform);
    pump.setRate(4);
    pump.start();
    setStatus('Live', 'live');
}
async function connectRemote() {
    if (paused || connecting || !screenSize)
        return;
    connecting = true;
    try {
        startStream();
    }
    finally {
        connecting = false;
    }
}
async function pollConnection(reloadWhenReady = false) {
    if (connectionChecking)
        return;
    connectionChecking = true;
    window.clearTimeout(connectionPoll);
    try {
        const connection = await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/connection`);
        if (connection.wda === 'ready') {
            if (reloadWhenReady) {
                location.reload();
                return;
            }
            connectionPoll = window.setTimeout(() => void connectRemote(), 2_000);
            return;
        }
        const appium = connection.appium === 'ready' ? '' : ' Appium is unavailable.';
        setStatus(`${connection.message}.${appium}`.replace('..', '.'), connection.wda === 'error' ? 'error' : '');
        connectionPoll = window.setTimeout(() => void pollConnection(reloadWhenReady), 2_000);
    }
    catch (error) {
        setStatus(errorMessage(error), 'error');
        connectionPoll = window.setTimeout(() => void pollConnection(reloadWhenReady), 2_000);
    }
    finally {
        connectionChecking = false;
    }
}
function useDeviceSummary(summary) {
    const width = Number(summary.dataset.screenWidth);
    const height = Number(summary.dataset.screenHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height))
        return;
    screenSize = { width, height };
    devicePlatform = summary.dataset.platform === 'android' ? 'android' : 'ios';
    const platform = devicePlatform === 'android' ? 'Android' : 'iOS';
    const name = summary.querySelector('h1')?.textContent;
    if (name)
        document.title = `${name} · ${platform} Automation`;
    elements.screen.alt = `Live screen from the connected ${platform} device`;
    // Wake, unlock and the volume keys are WebDriverAgent verbs with no adb equivalent;
    // recents is the other way round, an Android keyevent iOS has no button for.
    for (const button of elements.remoteButtons) {
        const action = button.dataset.remoteAction ?? '';
        if (platform === 'Android') {
            button.hidden = !['up', 'down', 'left', 'right', 'home', 'recents', 'power'].includes(action);
        }
        else {
            button.hidden = action === 'recents';
        }
    }
    void connectRemote();
}
document.addEventListener('htmx:afterSwap', () => {
    const summary = document.querySelector('#device-summary[data-screen-width]');
    if (summary)
        useDeviceSummary(summary);
});
document.addEventListener('htmx:afterRequest', (event) => {
    const detail = event.detail;
    if (detail?.elt === elements.doomscrollForm && detail.successful) {
        elements.doomscrollDialog.close();
    }
});
function pointFromEvent(event) {
    if (!screenSize)
        throw new Error('Screen dimensions are unavailable');
    const rect = elements.screen.getBoundingClientRect();
    return {
        x: Math.round((event.clientX - rect.left) * screenSize.width / rect.width),
        y: Math.round((event.clientY - rect.top) * screenSize.height / rect.height),
    };
}
/**
 * Runbook recorder hook. The Runbooks panel sets `data-runbook-recording` to the runbook it is
 * recording into; while it is set, every remote action this page performs is also appended to that
 * runbook as a step. Fire-and-forget: a recorder problem must never break remote control.
 */
function recordRunbookStep(action) {
    const runbookId = document.documentElement.dataset.runbookRecording;
    if (!runbookId)
        return;
    void fetch(`/api/runbooks/${encodeURIComponent(runbookId)}/steps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
    }).catch(() => undefined);
}
async function sendAction(action) {
    setStatus('Sending input…');
    elements.remoteButtons.forEach((button) => { button.disabled = true; });
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/remote/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action),
        });
        setStatus(action.type === 'tap' ? `Tapped (${action.x}, ${action.y})` : 'Remote connected', 'ready');
        recordRunbookStep(action);
    }
    catch (error) {
        setStatus(errorMessage(error), 'error');
    }
    finally {
        elements.remoteButtons.forEach((button) => { button.disabled = false; });
    }
}
function directionalSwipe(direction) {
    if (!screenSize) {
        setStatus('Screen dimensions are unavailable', 'error');
        return;
    }
    const left = Math.round(screenSize.width * 0.22);
    const right = Math.round(screenSize.width * 0.78);
    const top = Math.round(screenSize.height * 0.25);
    const bottom = Math.round(screenSize.height * 0.75);
    const centerX = Math.round(screenSize.width / 2);
    const centerY = Math.round(screenSize.height / 2);
    const points = {
        left: [right, centerY, left, centerY],
        right: [left, centerY, right, centerY],
        up: [centerX, bottom, centerX, top],
        down: [centerX, top, centerX, bottom],
    };
    const [startX, startY, endX, endY] = points[direction];
    return { type: 'swipe', startX, startY, endX, endY, durationMs: 350 };
}
elements.remoteButtons.forEach((button) => {
    button.addEventListener('click', () => {
        const action = button.dataset.remoteAction;
        if (action === 'home' || action === 'recents' || action === 'power' || action === 'wake'
            || action === 'unlock' || action === 'volumeUp' || action === 'volumeDown') {
            void sendAction({ type: action });
            return;
        }
        if (action === 'left' || action === 'right' || action === 'up' || action === 'down') {
            const swipe = directionalSwipe(action);
            if (swipe)
                void sendAction(swipe);
        }
    });
});
elements.screen.addEventListener('pointerdown', (event) => {
    if (!screenSize)
        return;
    elements.screen.setPointerCapture(event.pointerId);
    pointerStart = { ...pointFromEvent(event), time: performance.now() };
});
elements.screen.addEventListener('pointerup', (event) => {
    if (!pointerStart || !screenSize)
        return;
    const end = pointFromEvent(event);
    const start = pointerStart;
    pointerStart = undefined;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (distance < 12) {
        void sendAction({ type: 'tap', x: end.x, y: end.y });
    }
    else {
        const durationMs = Math.max(150, Math.min(1200, Math.round(performance.now() - (start.time ?? 0))));
        void sendAction({
            type: 'swipe',
            startX: start.x,
            startY: start.y,
            endX: end.x,
            endY: end.y,
            durationMs,
        });
    }
});
elements.screen.addEventListener('pointercancel', () => { pointerStart = undefined; });
elements.screen.addEventListener('load', () => setStatus('Live video connected', 'ready'));
elements.screen.addEventListener('error', () => {
    if (paused)
        return;
    elements.screen.removeAttribute('src');
    setStatus('Video stream disconnected; checking the phone connection…', 'error');
    void pollConnection();
});
elements.refresh.addEventListener('click', async () => {
    elements.refresh.disabled = true;
    window.clearTimeout(connectionPoll);
    elements.screen.removeAttribute('src');
    setStatus('Restarting the phone connection…');
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/reconnect`, { method: 'POST' });
        elements.refresh.disabled = false;
        void pollConnection(true);
    }
    catch (error) {
        setStatus(errorMessage(error), 'error');
        elements.refresh.disabled = false;
    }
});
elements.toggle.addEventListener('click', () => {
    paused = !paused;
    elements.toggle.textContent = paused ? 'Resume' : 'Pause';
    if (paused) {
        pump?.stop();
        elements.screen.removeAttribute('src');
        setStatus('Paused');
    }
    else {
        void connectRemote();
    }
});
function renderMedia() {
    elements.mediaList.replaceChildren(...orderedMedia.map((file, index) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = `${index + 1}. ${file.name}`;
        const up = document.createElement('button');
        up.type = 'button';
        up.textContent = '↑';
        up.title = 'Move earlier';
        up.disabled = index === 0;
        const down = document.createElement('button');
        down.type = 'button';
        down.textContent = '↓';
        down.title = 'Move later';
        down.disabled = index === orderedMedia.length - 1;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        up.addEventListener('click', () => { [orderedMedia[index - 1], orderedMedia[index]] = [orderedMedia[index], orderedMedia[index - 1]]; renderMedia(); });
        down.addEventListener('click', () => { [orderedMedia[index], orderedMedia[index + 1]] = [orderedMedia[index + 1], orderedMedia[index]]; renderMedia(); });
        remove.addEventListener('click', () => { orderedMedia.splice(index, 1); renderMedia(); });
        item.append(name, up, down, remove);
        return item;
    }));
}
function selectedDestination() {
    return elements.postForm.elements.namedItem('destination').value;
}
function postTiming() {
    const kind = elements.postRecurring.checked ? elements.postFrequency.value : elements.postStartKind.value;
    if (kind === 'now')
        return { kind };
    if (kind === 'once') {
        if (!elements.postRunAt.value)
            throw new Error('Choose a one-time start date');
        return { kind, runAt: new Date(elements.postRunAt.value).toISOString() };
    }
    if (kind === 'daily')
        return { kind, localTime: elements.postLocalTime.value, timezone: browserTimezone };
    const weekdays = selectedWeekdays(elements.postWeekdayInputs);
    if (weekdays.length === 0)
        throw new Error('Choose at least one recurring day');
    return {
        kind: 'weekly', localTime: elements.postLocalTime.value, timezone: browserTimezone,
        weekdays,
    };
}
function updateDestination() {
    const publishing = selectedDestination() === 'publish';
    elements.publishConfirm.classList.toggle('visible', publishing);
    if (!publishing)
        elements.confirmPublish.checked = false;
    elements.submitPost.textContent = publishing ? 'Post publicly' : 'Save to Drafts';
}
async function pollPost() {
    try {
        const run = await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/posts/current`);
        elements.postResult.textContent = run.status === 'running'
            ? 'Post automation is running. Follow its live output in the Automation log.'
            : '';
        if (run.status === 'running') {
            postPoll = window.setTimeout(() => void pollPost(), 1000);
        }
        else {
            elements.submitPost.disabled = false;
            elements.postResult.textContent = run.status === 'succeeded'
                ? `Completed: ${run.destination === 'publish' ? 'post submitted' : 'draft saved'}.`
                : 'Automation failed. Review the Automation log and the phone screen.';
        }
    }
    catch (error) {
        elements.postResult.textContent = errorMessage(error);
        elements.submitPost.disabled = false;
    }
}
function formatDate(value) {
    return value ? new Date(value).toLocaleString() : '—';
}
function taskActionButton(label, action) {
    const buttonElement = document.createElement('button');
    buttonElement.className = 'bl-btn bl-btn-sm';
    buttonElement.type = 'button';
    buttonElement.textContent = label;
    buttonElement.addEventListener('click', () => {
        void (async () => {
            try {
                await action();
                await loadDeviceTasks();
            }
            catch (error) {
                window.alert(errorMessage(error));
            }
        })();
    });
    return buttonElement;
}
function taskTitle(taskType, payload) {
    if (taskType === 'doomscroll') {
        const details = payload?.durationMinutes ? ` · ${payload.durationMinutes} min` : '';
        return `Doomscroll${details}`;
    }
    const destination = payload?.destination === 'publish' ? 'Post publicly' : 'Save to drafts';
    return payload?.account ? `${destination} · ${payload.account}` : destination;
}
function timingDescription(timing) {
    if (timing.kind === 'once')
        return `Once · ${formatDate(timing.runAt ?? null)}`;
    if (timing.kind === 'daily')
        return `Daily · ${timing.localTime ?? '—'} · ${timing.timezone ?? 'local time'}`;
    if (timing.kind === 'weekly') {
        const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const days = timing.weekdays?.map((day) => names[day] ?? String(day)).join(', ') || 'no days';
        return `Weekly ${days} · ${timing.localTime ?? '—'} · ${timing.timezone ?? 'local time'}`;
    }
    return 'Run immediately';
}
/** One row of a `.bl-table`; the empty state is a single spanning row. */
function tableRow(cells, actions) {
    const row = document.createElement('tr');
    for (const cell of cells) {
        const td = document.createElement('td');
        if (typeof cell === 'string')
            td.textContent = cell;
        else
            td.append(cell);
        row.append(td);
    }
    const last = document.createElement('td');
    last.className = 'bl-row-actions';
    last.append(...actions);
    row.append(last);
    return row;
}
function emptyRow(sentence) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'bl-muted';
    cell.textContent = sentence;
    row.append(cell);
    return row;
}
function stateCell(status) {
    const state = document.createElement('span');
    const tone = status === 'running' ? 'busy' : status === 'failed' ? 'error'
        : status === 'succeeded' || status === 'active' ? 'online' : '';
    state.className = `bl-state ${tone}`;
    const dot = document.createElement('span');
    dot.className = `bl-dot ${tone}`;
    state.append(dot, document.createTextNode(status));
    return state;
}
function renderDeviceSchedules(schedules) {
    if (!schedules.length) {
        elements.deviceSchedules.replaceChildren(emptyRow('No schedules for this phone yet.'));
        return;
    }
    elements.deviceSchedules.replaceChildren(...schedules.map((schedule) => {
        const actions = [];
        if (schedule.status === 'active')
            actions.push(taskActionButton('Pause', async () => {
                await jsonRequest(`/api/schedules/${schedule.id}/pause`, { method: 'POST' });
            }));
        if (schedule.status === 'paused')
            actions.push(taskActionButton('Resume', async () => {
                await jsonRequest(`/api/schedules/${schedule.id}/resume`, { method: 'POST' });
            }));
        if (schedule.status !== 'cancelled' && schedule.status !== 'completed') {
            actions.push(taskActionButton('Cancel', async () => {
                await jsonRequest(`/api/schedules/${schedule.id}/cancel`, { method: 'POST' });
            }));
        }
        return tableRow([
            taskTitle(schedule.taskType, schedule.payload),
            `${timingDescription(schedule.timing)} · next ${formatDate(schedule.nextRunAt)}`,
            stateCell(schedule.status),
        ], actions);
    }));
}
function renderDeviceExecutions(executions) {
    if (!executions.length) {
        elements.deviceExecutions.replaceChildren(emptyRow('Nothing has run on this phone yet.'));
        return;
    }
    elements.deviceExecutions.replaceChildren(...executions.map((execution) => {
        const actions = [];
        if (execution.status === 'queued' || (execution.status === 'running' && execution.taskType === 'doomscroll')) {
            actions.push(taskActionButton(execution.status === 'queued' ? 'Cancel' : 'Stop', async () => {
                await jsonRequest(`/api/executions/${execution.id}/stop`, { method: 'POST' });
            }));
        }
        if (execution.status === 'failed' || execution.status === 'stopped') {
            actions.push(taskActionButton('Retry', async () => {
                if (execution.taskType === 'post'
                    && !window.confirm('The post may already have reached TikTok. Retry only after checking the phone.'))
                    return;
                await jsonRequest(`/api/executions/${execution.id}/retry`, { method: 'POST' });
            }));
        }
        return tableRow([
            execution.taskType === 'post' ? 'Post' : 'Warm up',
            `${formatDate(execution.scheduledFor)}${execution.error ? ` · ${execution.error}` : ''}`,
            stateCell(execution.status),
        ], actions);
    }));
}
async function loadDeviceTasks() {
    try {
        const query = `deviceUdid=${encodeURIComponent(udid)}`;
        const [scheduleData, executionData] = await Promise.all([
            jsonRequest(`/api/schedules?${query}`),
            jsonRequest(`/api/executions?${query}`),
        ]);
        renderDeviceSchedules(scheduleData.schedules);
        renderDeviceExecutions(executionData.executions);
    }
    catch (error) {
        const message = errorMessage(error);
        elements.deviceSchedules.replaceChildren(emptyRow(message));
        elements.deviceExecutions.replaceChildren(emptyRow(message));
    }
}
elements.openPost.addEventListener('click', () => elements.postDialog.showModal());
elements.closePost.addEventListener('click', () => elements.postDialog.close());
elements.cancelPost.addEventListener('click', () => elements.postDialog.close());
elements.media.addEventListener('change', () => {
    orderedMedia = Array.from(elements.media.files ?? []);
    renderMedia();
});
elements.postForm.addEventListener('change', (event) => {
    if (event.target.name === 'destination')
        updateDestination();
});
elements.postForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const destination = selectedDestination();
    if (orderedMedia.length === 0) {
        elements.postResult.textContent = 'Choose media first.';
        return;
    }
    if (orderedMedia.length > 3) {
        elements.postResult.textContent = 'Choose no more than three slideshow images.';
        return;
    }
    const videos = orderedMedia.filter(({ type }) => type.startsWith('video/'));
    const images = orderedMedia.filter(({ type }) => type.startsWith('image/'));
    if (!((videos.length === 1 && orderedMedia.length === 1) || images.length === orderedMedia.length)) {
        elements.postResult.textContent = 'Choose exactly one video, or only slideshow images.';
        return;
    }
    if (destination === 'publish' && !elements.confirmPublish.checked) {
        elements.postResult.textContent = 'Confirm public publishing before continuing.';
        return;
    }
    const form = new FormData();
    for (const file of orderedMedia)
        form.append('media', file, file.name);
    form.append('destination', destination);
    form.append('musicUrl', elements.musicUrl.value);
    form.append('caption', elements.caption.value);
    form.append('account', elements.postAccount.value);
    try {
        form.append('timing', JSON.stringify(postTiming()));
    }
    catch (error) {
        elements.postResult.textContent = errorMessage(error);
        return;
    }
    form.append('runWindowMinutes', elements.postRunWindow.value);
    form.append('recurringPublishConfirmed', String(destination !== 'publish' || elements.confirmPublish.checked));
    elements.submitPost.disabled = true;
    elements.postResult.textContent = 'Uploading media to the automation server…';
    try {
        const result = await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/posts`, { method: 'POST', body: form });
        window.clearTimeout(postPoll);
        if (result.status === 'running') {
            await pollPost();
        }
        else {
            elements.submitPost.disabled = false;
            elements.postResult.textContent = 'Post automation scheduled. Follow its status and live output in the Automation log.';
        }
        void loadDeviceTasks();
    }
    catch (error) {
        elements.postResult.textContent = errorMessage(error);
        elements.submitPost.disabled = false;
    }
});
elements.accountsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.accountsResult.textContent = 'Saving…';
    try {
        const result = await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/accounts`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accounts: elements.deviceAccounts.value.split(',') }),
        });
        const previousDoomscroll = (document.querySelector('#doomscroll-account'))?.value ?? '';
        elements.postAccount.replaceChildren(new Option('Choose an account…', '', false, true));
        elements.postAccount.options[0].disabled = true;
        const doomscrollAccount = element('#doomscroll-account');
        doomscrollAccount.replaceChildren(new Option("Don't switch", ''));
        for (const account of result.accounts) {
            elements.postAccount.add(new Option(account, account));
            doomscrollAccount.add(new Option(account, account));
        }
        if (result.accounts.includes(previousDoomscroll))
            doomscrollAccount.value = previousDoomscroll;
        elements.deviceAccounts.value = result.accounts.join(', ');
        elements.accountsResult.textContent = result.accounts.length ? 'Accounts saved.' : 'Account switching is optional.';
    }
    catch (error) {
        elements.accountsResult.textContent = errorMessage(error);
    }
});
const cal = {
    screen: undefined,
    points: [],
    overrides: {},
    armed: undefined,
};
function calValue(name) {
    const point = cal.points.find((entry) => entry.name === name);
    return cal.overrides[name] ?? point.default;
}
function renderCalPoints() {
    elements.calPoints.replaceChildren(...cal.points.map((point) => {
        const value = calValue(point.name);
        const overridden = point.name in cal.overrides;
        const li = document.createElement('li');
        li.className = `cal-point${overridden ? ' overridden' : ''}${cal.armed === point.name ? ' armed' : ''}`;
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'cal-pick';
        pick.textContent = cal.armed === point.name ? `${point.label} — click the screen` : point.label;
        pick.addEventListener('click', () => { cal.armed = cal.armed === point.name ? undefined : point.name; renderCal(); });
        const xy = document.createElement('span');
        xy.className = 'cal-xy';
        xy.textContent = `${value.x}, ${value.y}`;
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'cal-reset';
        reset.title = 'Reset to profile';
        reset.textContent = '↺';
        reset.addEventListener('click', () => { delete cal.overrides[point.name]; renderCal(); });
        li.append(pick, xy, reset);
        return li;
    }));
}
function renderCalMarkers() {
    if (!cal.screen)
        return;
    elements.calMarkers.replaceChildren(...cal.points.map((point) => {
        const value = calValue(point.name);
        const marker = document.createElement('span');
        marker.className = `m${point.name in cal.overrides ? ' overridden' : ''}${cal.armed === point.name ? ' armed' : ''}`;
        marker.style.left = `${(value.x / cal.screen.width) * 100}%`;
        marker.style.top = `${(value.y / cal.screen.height) * 100}%`;
        marker.title = point.label;
        return marker;
    }));
}
function renderCal() {
    renderCalPoints();
    renderCalMarkers();
}
async function openCalibrate() {
    elements.calStatus.textContent = 'Loading…';
    elements.calibrateDialog.showModal();
    try {
        const data = await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/coordinates`);
        cal.screen = data.screenSize;
        cal.points = data.points;
        cal.overrides = {};
        for (const point of data.points)
            if (point.overridden)
                cal.overrides[point.name] = point.current;
        cal.armed = undefined;
        elements.calControl.checked = false;
        elements.calScreen.parentElement?.classList.remove('controlling');
        elements.calProfile.textContent = data.profile;
        elements.calScreen.src = `/api/devices/${encodeURIComponent(udid)}/remote/stream?t=${Date.now()}`;
        elements.calStatus.textContent = '';
        renderCal();
    }
    catch (error) {
        elements.calStatus.textContent = errorMessage(error);
    }
}
function closeCalibrate() {
    elements.calScreen.src = '';
    elements.calibrateDialog.close();
}
elements.openCalibrate.addEventListener('click', () => void openCalibrate());
elements.closeCalibrate.addEventListener('click', closeCalibrate);
elements.calCancel.addEventListener('click', closeCalibrate);
elements.openTasks.addEventListener('click', () => {
    void loadDeviceTasks();
    elements.tasksDialog.showModal();
});
elements.closeTasks.addEventListener('click', () => elements.tasksDialog.close());
elements.openAccounts.addEventListener('click', () => elements.accountsDialog.showModal());
elements.closeAccounts.addEventListener('click', () => elements.accountsDialog.close());
elements.openPasscode.addEventListener('click', () => {
    elements.passcodeResult.textContent = '';
    elements.passcodeDialog.showModal();
});
elements.closePasscode.addEventListener('click', () => elements.passcodeDialog.close());
elements.openRemove.addEventListener('click', () => {
    elements.removeResult.textContent = '';
    elements.removeDialog.showModal();
});
elements.closeRemove.addEventListener('click', () => elements.removeDialog.close());
elements.calResetAll.addEventListener('click', () => {
    if (!confirm('Reset all touch points to the profile defaults?'))
        return;
    cal.overrides = {};
    cal.armed = undefined;
    renderCal();
});
function calPointFromEvent(event) {
    const rect = elements.calScreen.getBoundingClientRect();
    return {
        x: Math.round((event.clientX - rect.left) * cal.screen.width / rect.width),
        y: Math.round((event.clientY - rect.top) * cal.screen.height / rect.height),
    };
}
async function calSendAction(action) {
    elements.calStatus.textContent = 'Sending input…';
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/remote/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action),
        });
        elements.calStatus.textContent = action.type === 'tap' ? `Tapped (${action.x}, ${action.y})` : 'Sent.';
    }
    catch (error) {
        elements.calStatus.textContent = errorMessage(error);
    }
}
let calPointerStart;
elements.calControl.addEventListener('change', () => {
    elements.calScreen.parentElement?.classList.toggle('controlling', elements.calControl.checked);
    if (elements.calControl.checked) {
        cal.armed = undefined;
        renderCal();
    }
});
elements.calUnlock.addEventListener('click', () => void calSendAction({ type: 'unlock' }));
elements.calScreen.addEventListener('click', (event) => {
    if (elements.calControl.checked || !cal.armed || !cal.screen)
        return;
    cal.overrides[cal.armed] = calPointFromEvent(event);
    cal.armed = undefined;
    renderCal();
});
elements.calScreen.addEventListener('pointerdown', (event) => {
    if (!elements.calControl.checked || !cal.screen)
        return;
    elements.calScreen.setPointerCapture(event.pointerId);
    calPointerStart = { ...calPointFromEvent(event), time: performance.now() };
});
elements.calScreen.addEventListener('pointerup', (event) => {
    if (!calPointerStart || !cal.screen)
        return;
    const start = calPointerStart;
    const end = calPointFromEvent(event);
    calPointerStart = undefined;
    if (Math.hypot(end.x - start.x, end.y - start.y) < 12) {
        void calSendAction({ type: 'tap', x: end.x, y: end.y });
    }
    else {
        const durationMs = Math.max(150, Math.min(1200, Math.round(performance.now() - start.time)));
        void calSendAction({ type: 'swipe', startX: start.x, startY: start.y, endX: end.x, endY: end.y, durationMs });
    }
});
elements.calScreen.addEventListener('pointercancel', () => { calPointerStart = undefined; });
elements.calSave.addEventListener('click', async () => {
    elements.calSave.disabled = true;
    elements.calStatus.textContent = 'Saving…';
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ coordinates: cal.overrides }),
        });
        const count = Object.keys(cal.overrides).length;
        elements.calStatus.textContent = count ? `Saved ${count} override${count === 1 ? '' : 's'}.` : 'Cleared all overrides.';
        for (const point of cal.points)
            point.overridden = point.name in cal.overrides;
        renderCal();
    }
    catch (error) {
        elements.calStatus.textContent = errorMessage(error);
    }
    finally {
        elements.calSave.disabled = false;
    }
});
async function patchPasscode(passcode, pending, done) {
    elements.passcodeResult.textContent = pending;
    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udid)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ passcode }),
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error ?? `Request failed (${response.status})`);
        }
        const data = await response.json();
        elements.passcodeState.textContent = data.hasPasscode ? '· set' : '· not set';
        elements.devicePasscode.value = '';
        elements.passcodeResult.textContent = done;
    }
    catch (error) {
        elements.passcodeResult.textContent = errorMessage(error);
    }
}
elements.passcodeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = elements.devicePasscode.value.trim();
    if (!/^\d{4,}$/.test(value)) {
        elements.passcodeResult.textContent = 'Enter at least four digits.';
        return;
    }
    void patchPasscode(value, 'Saving…', 'Passcode saved.');
});
elements.passcodeClear.addEventListener('click', () => {
    if (!confirm('Clear this device’s passcode? Automation will not be able to unlock a locked phone.'))
        return;
    void patchPasscode('', 'Clearing…', 'Passcode cleared.');
});
elements.removeDevice.addEventListener('click', async () => {
    elements.removeDevice.disabled = true;
    elements.removeResult.textContent = 'Removing…';
    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udid)}`, { method: 'DELETE' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error ?? `Request failed (${response.status})`);
        }
        location.href = '/';
    }
    catch (error) {
        elements.removeDevice.disabled = false;
        elements.removeResult.textContent = errorMessage(error);
    }
});
updateDestination();
updateDoomscrollSchedule();
updatePostSchedule();
// The schedule and history tables live on the page now, so they load with it.
void loadDeviceTasks();
setInterval(() => void loadDeviceTasks(), 5_000);
const loadedSummary = document.querySelector('#device-summary[data-screen-width]');
if (loadedSummary)
    useDeviceSummary(loadedSummary);
