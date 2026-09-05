/**
 * The Control Center: the wall of live phone screens, its filters, its selection and its
 * inspector. Server-rendered markup, no framework. See docs/design/backline.md.
 */
import { FRAME_RATES, FramePump, TILE_SIZES, TILE_SIZE_LABELS, all, devicePoint, errorMessage, pick, rateLabel, remember, remembered, remoteAction, request, screenInfo, send, } from './shell.js';
const wall = pick('#wall');
const filters = pick('#wall-filters');
const selectionLabel = pick('#wall-selection');
const tiles = all('[data-tile]').map((element, index, list) => {
    const image = pick('[data-frame]', element);
    const udid = element.dataset.udid ?? '';
    const platform = element.dataset.platform ?? 'android';
    return {
        element, udid, platform,
        slot: element.dataset.slot ?? '',
        name: pick('.bl-tile-name', element)?.textContent ?? udid,
        link: element.dataset.link ?? 'usb',
        tags: (element.dataset.tags ?? '').split(',').filter(Boolean),
        checkbox: pick('[data-select]', element),
        pump: image ? new FramePump(image, udid, platform, index / Math.max(list.length, 1)) : null,
        visible: false,
    };
});
const byUdid = new Map(tiles.map((tile) => [tile.udid, tile]));
/* ---- filters and sliders ---------------------------------------------- */
let link = remembered('wall.link') ?? 'all';
let group = remembered('wall.group') ?? '';
function matches(tile) {
    if (group && !tile.tags.includes(group))
        return false;
    if (link === 'usb')
        return tile.link === 'usb' && tile.platform === 'android';
    if (link === 'wifi')
        return tile.link === 'wifi';
    if (link === 'ios')
        return tile.platform === 'ios';
    return true;
}
function applyFilters() {
    for (const tile of tiles) {
        const shown = matches(tile);
        tile.element.hidden = !shown;
        if (!shown) {
            tile.pump?.stop();
            if (tile.checkbox)
                tile.checkbox.checked = false;
        }
    }
    for (const button of all('[data-link-filter]')) {
        button.setAttribute('aria-pressed', String(button.dataset.linkFilter === link));
    }
    for (const chip of all('[data-group]')) {
        chip.setAttribute('aria-pressed', String((chip.dataset.group ?? '') === group));
    }
    countSelection();
    refreshPumps();
}
filters?.addEventListener('click', (event) => {
    const linkButton = event.target?.closest('[data-link-filter]');
    if (linkButton) {
        link = linkButton.dataset.linkFilter ?? 'all';
        remember('wall.link', link);
        applyFilters();
        return;
    }
    const chip = event.target?.closest('[data-group]');
    if (chip) {
        group = chip.dataset.group ?? '';
        remember('wall.group', group);
        applyFilters();
        return;
    }
    const pickButton = event.target?.closest('[data-pick]');
    if (pickButton)
        select(pickButton.dataset.pick ?? '');
});
const sizeSlider = pick('#wall-size');
const sizeValue = pick('#wall-size-value');
const rateSlider = pick('#wall-rate');
const rateValue = pick('#wall-rate-value');
function applySize() {
    const notch = Number(sizeSlider?.value ?? 1);
    const size = TILE_SIZES[notch] ?? TILE_SIZES[1];
    wall?.style.setProperty('--bl-tile', `${size}px`);
    if (sizeValue)
        sizeValue.textContent = TILE_SIZE_LABELS[notch] ?? 'M';
}
function currentRate() {
    return FRAME_RATES[Number(rateSlider?.value ?? 2)] ?? 1;
}
function applyRate() {
    const rate = currentRate();
    if (rateValue)
        rateValue.textContent = rateLabel(rate);
    for (const tile of tiles)
        tile.pump?.setRate(rate);
    inspectorPump?.setRate(Math.max(rate, 4));
}
sizeSlider?.addEventListener('input', () => { applySize(); remember('tileSize', sizeSlider.value); });
rateSlider?.addEventListener('input', () => { applyRate(); remember('tileRate', rateSlider.value); });
/* ---- live frames ------------------------------------------------------ */
function refreshPumps() {
    const hidden = document.hidden;
    if (hidden)
        inspectorPump?.stop();
    else
        inspectorPump?.start();
    for (const tile of tiles) {
        if (!tile.pump)
            continue;
        if (hidden || tile.element.hidden || !tile.visible)
            tile.pump.stop();
        else
            tile.pump.start();
    }
}
const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        const tile = tiles.find(({ element }) => element === entry.target);
        if (tile)
            tile.visible = entry.isIntersecting;
    }
    refreshPumps();
}, { rootMargin: '160px' });
for (const tile of tiles)
    observer.observe(tile.element);
document.addEventListener('visibilitychange', refreshPumps);
/* ---- selection -------------------------------------------------------- */
function selected() {
    return tiles.filter((tile) => !tile.element.hidden && tile.checkbox?.checked);
}
function countSelection() {
    const count = selected().length;
    if (selectionLabel)
        selectionLabel.textContent = `${count} selected`;
    remember('wall.selection', selected().map(({ udid }) => udid).join(','));
}
for (const tile of tiles) {
    tile.checkbox?.addEventListener('change', countSelection);
    tile.element.addEventListener('click', (event) => {
        if (event.target?.closest('.bl-check'))
            return;
        select(tile.udid);
    });
    tile.element.addEventListener('dblclick', () => {
        window.location.assign(`/devices/${encodeURIComponent(tile.udid)}`);
    });
}
/* ---- the inspector ---------------------------------------------------- */
let inspectorPump = null;
let inspectorScreen;
let inspectorUdid = pick('#inspector')?.dataset.udid ?? '';
function markSelected(udid) {
    for (const tile of tiles)
        tile.element.classList.toggle('is-selected', tile.udid === udid);
    for (const button of all('[data-pick]')) {
        button.setAttribute('aria-pressed', String(button.dataset.pick === udid));
    }
}
async function select(udid) {
    if (!udid || udid === inspectorUdid) {
        markSelected(udid);
        return;
    }
    inspectorUdid = udid;
    remember('wall.focus', udid);
    markSelected(udid);
    const holder = pick('#inspector');
    if (!holder)
        return;
    try {
        const markup = await fetch(`/api/fragments/inspector/${encodeURIComponent(udid)}`).then((r) => r.text());
        holder.outerHTML = markup;
        window.htmx?.process(pick('#inspector') ?? document.body);
        bindInspector();
    }
    catch (error) {
        holder.textContent = errorMessage(error);
    }
}
function bindInspector() {
    inspectorPump?.stop();
    inspectorPump = null;
    inspectorScreen = undefined;
    const viewer = pick('[data-viewer]');
    if (!viewer)
        return;
    const udid = viewer.dataset.udid ?? '';
    const image = pick('[data-frame]', viewer);
    if (image && viewer.dataset.live === '1') {
        inspectorPump = new FramePump(image, udid, viewer.dataset.platform ?? 'android');
        inspectorPump.setRate(Math.max(currentRate(), 4));
        if (!document.hidden)
            inspectorPump.start();
        void screenInfo(udid).then((info) => { inspectorScreen = info; });
    }
    bindViewerInput(viewer, udid);
    for (const button of all('[data-hw]')) {
        button.addEventListener('click', () => void hardware(udid, button.dataset.hw ?? ''));
    }
    const stop = pick('[data-inspector-stop]');
    stop?.addEventListener('click', () => {
        stop.disabled = true;
        void send(`/api/executions/${stop.dataset.inspectorStop}/stop`, {})
            .catch((error) => window.alert(errorMessage(error)))
            .finally(() => { stop.disabled = false; });
    });
}
/** Click to tap, drag to swipe — mapped into the phone's own coordinate space. */
export function bindViewerInput(viewer, udid) {
    let start;
    viewer.addEventListener('pointerdown', (event) => {
        if (!inspectorScreen)
            return;
        const point = devicePoint(viewer, inspectorScreen, event);
        start = { ...point, at: Date.now() };
    });
    viewer.addEventListener('pointerup', (event) => {
        if (!inspectorScreen || !start)
            return;
        const end = devicePoint(viewer, inspectorScreen, event);
        const moved = Math.hypot(end.x - start.x, end.y - start.y);
        const action = moved < 12
            ? { type: 'tap', x: end.x, y: end.y }
            : {
                type: 'swipe', startX: start.x, startY: start.y, endX: end.x, endY: end.y,
                durationMs: Math.max(80, Math.min(1200, Date.now() - start.at)),
            };
        start = undefined;
        void remoteAction(udid, action).catch((error) => window.alert(errorMessage(error)));
    });
}
async function hardware(udid, key) {
    try {
        if (key === 'screenshot') {
            window.open(`/api/devices/${encodeURIComponent(udid)}/remote/screenshot`, '_blank', 'noopener');
            return;
        }
        if (key === 'text') {
            const text = window.prompt('Text to type on this phone');
            if (!text)
                return;
            await remoteAction(udid, { type: 'text', text });
            return;
        }
        if (key === 'recents') {
            // adb has no "recents" verb of its own; the farm's key set stops at home and back.
            await remoteAction(udid, { type: 'home' });
            await remoteAction(udid, { type: 'home' });
            return;
        }
        await remoteAction(udid, { type: key });
    }
    catch (error) {
        window.alert(errorMessage(error));
    }
}
/* ---- keyboard --------------------------------------------------------- */
document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
        return;
    if (pick('dialog[open]'))
        return;
    const visible = tiles.filter((tile) => !tile.element.hidden);
    if (!visible.length)
        return;
    const index = Math.max(0, visible.findIndex(({ udid }) => udid === inspectorUdid));
    const columns = Math.max(1, Math.round((wall?.clientWidth ?? 800) / (visible[0].element.clientWidth || 180)));
    let next;
    if (event.key === 'ArrowRight')
        next = index + 1;
    else if (event.key === 'ArrowLeft')
        next = index - 1;
    else if (event.key === 'ArrowDown')
        next = index + columns;
    else if (event.key === 'ArrowUp')
        next = index - columns;
    else if (event.key === ' ') {
        const tile = visible[index];
        if (tile?.checkbox) {
            event.preventDefault();
            tile.checkbox.checked = !tile.checkbox.checked;
            countSelection();
        }
        return;
    }
    else if (event.key === 'Enter') {
        event.preventDefault();
        window.location.assign(`/devices/${encodeURIComponent(visible[index].udid)}`);
        return;
    }
    else
        return;
    event.preventDefault();
    const tile = visible[Math.max(0, Math.min(visible.length - 1, next))];
    if (!tile)
        return;
    tile.element.focus();
    void select(tile.udid);
});
function ask(title, fields, submitLabel) {
    return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.className = 'bl-dialog';
        const form = document.createElement('form');
        form.method = 'dialog';
        const head = document.createElement('div');
        head.className = 'bl-dialog-head';
        head.textContent = title;
        const body = document.createElement('div');
        body.className = 'bl-dialog-body';
        const inputs = new Map();
        for (const field of fields) {
            const label = document.createElement('label');
            label.className = 'bl-field';
            const caption = document.createElement('span');
            caption.textContent = field.label;
            let input;
            if (field.type === 'select') {
                const select = document.createElement('select');
                select.className = 'bl-select';
                for (const [value, text] of field.options ?? [])
                    select.add(new Option(text, value));
                input = select;
            }
            else {
                const box = document.createElement('input');
                box.className = 'bl-input';
                box.type = field.type;
                if (field.accept)
                    box.accept = field.accept;
                if (field.multiple)
                    box.multiple = true;
                if (field.min)
                    box.min = field.min;
                if (field.max)
                    box.max = field.max;
                input = box;
            }
            if (field.value !== undefined)
                input.value = field.value;
            inputs.set(field.name, input);
            label.append(caption, input);
            body.append(label);
        }
        const actions = document.createElement('div');
        actions.className = 'bl-btn-row';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'bl-btn';
        cancel.textContent = 'Cancel';
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.className = 'bl-btn bl-btn-primary';
        submit.textContent = submitLabel;
        actions.append(cancel, submit);
        body.append(actions);
        form.append(head, body);
        dialog.append(form);
        document.body.append(dialog);
        const finish = (answers) => {
            dialog.close();
            dialog.remove();
            resolve(answers);
        };
        cancel.addEventListener('click', () => finish(null));
        dialog.addEventListener('cancel', () => finish(null));
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const values = {};
            let files = [];
            for (const [name, input] of inputs) {
                values[name] = input.value;
                if (input instanceof HTMLInputElement && input.type === 'file') {
                    files = Array.from(input.files ?? []);
                }
            }
            finish({ values, files });
        });
        dialog.showModal();
    });
}
/* ---- toolbar ---------------------------------------------------------- */
const TIKTOK = 'com.git-agni.tiktok';
function udids() {
    return selected().map(({ udid }) => udid);
}
function report(message) {
    if (selectionLabel)
        selectionLabel.textContent = message;
}
async function uploadFiles(files) {
    const data = new FormData();
    for (const file of files)
        data.append('media', file);
    const response = await fetch('/api/assets', { method: 'POST', body: data });
    if (!response.ok)
        throw new Error('The upload failed');
    return response.json();
}
async function bulk(body) {
    const outcome = await request('/api/schedules/bulk', {
        method: 'POST', body: JSON.stringify(body),
    });
    report(`${outcome.created} scheduled, ${outcome.failed} failed`);
}
const ACTIONS = {
    async 'schedule-post'(chosen) {
        const answers = await ask('Schedule a post', [
            { name: 'media', label: 'Media', type: 'file', accept: 'video/*,image/*', multiple: true },
            { name: 'runAt', label: 'Start', type: 'datetime-local' },
            { name: 'destination', label: 'Finish as', type: 'select', options: [['draft', 'Save to drafts'], ['publish', 'Post publicly']] },
            { name: 'caption', label: 'Caption', type: 'text' },
            { name: 'stagger', label: 'Stagger between phones, minutes', type: 'number', value: '5', min: '0' },
        ], 'Schedule on the selection');
        if (!answers)
            return;
        if (!answers.files.length)
            return report('Choose at least one clip.');
        if (!answers.values.runAt)
            return report('Choose when the post should go out.');
        report('Uploading media');
        const uploaded = await uploadFiles(answers.files);
        await bulk({
            deviceUdids: chosen,
            task: {
                pluginId: TIKTOK, taskType: 'post', taskVersion: 1,
                payload: {
                    media: uploaded.map((asset) => ({ assetId: asset.id, name: asset.name, mimeType: asset.mimeType })),
                    destination: answers.values.destination, account: '',
                    ...(answers.values.caption ? { caption: answers.values.caption } : {}),
                },
            },
            timing: { kind: 'once', runAt: new Date(answers.values.runAt).toISOString() },
            stagger: { kind: 'fixed', minutes: Number(answers.values.stagger ?? 0) },
        });
    },
    async 'warm-up'(chosen) {
        const answers = await ask('Warm up', [
            { name: 'durationMinutes', label: 'Minutes', type: 'number', value: '10', min: '1', max: '180' },
            { name: 'personality', label: 'Personality', type: 'select', options: [['casual', 'Casual'], ['skimmer', 'Skimmer'], ['engaged', 'Engaged']] },
            { name: 'stagger', label: 'Stagger between phones, minutes', type: 'number', value: '0', min: '0' },
        ], 'Warm up the selection');
        if (!answers)
            return;
        await bulk({
            deviceUdids: chosen,
            task: {
                pluginId: TIKTOK, taskType: 'doomscroll', taskVersion: 1,
                payload: {
                    durationMinutes: Number(answers.values.durationMinutes ?? 10),
                    personality: answers.values.personality, likeEnabled: true, saveEnabled: false,
                },
            },
            timing: { kind: 'now' },
            stagger: { kind: 'fixed', minutes: Number(answers.values.stagger ?? 0) },
        });
    },
    async 'push-media'(chosen) {
        const answers = await ask('Push media', [
            { name: 'media', label: 'File', type: 'file', accept: 'video/*,image/*' },
        ], 'Push to the selection');
        if (!answers)
            return;
        if (!answers.files.length)
            return report('Choose a file.');
        const [asset] = await uploadFiles(answers.files);
        if (!asset)
            return report('The upload failed.');
        const outcome = await request('/api/devices/actions/push-media', {
            method: 'POST', body: JSON.stringify({ udids: chosen, assetId: asset.id }),
        });
        report(`${outcome.pushed} phones have the file, ${outcome.failed} failed`);
    },
    async 'run-runbook'(chosen) {
        const { runbooks } = await request('/api/runbooks');
        if (!runbooks.length)
            return report('No runbooks are recorded yet.');
        const answers = await ask('Run a runbook', [{
                name: 'runbookId', label: 'Runbook', type: 'select',
                options: runbooks.map((runbook) => [runbook.id, runbook.name]),
            }], 'Run on the selection');
        if (!answers)
            return;
        await bulk({
            deviceUdids: chosen,
            task: { pluginId: 'com.farm.runbook', taskType: 'run', taskVersion: 1, payload: { runbookId: answers.values.runbookId } },
            timing: { kind: 'now' },
        });
    },
    async 'install-apk'(chosen) {
        const answers = await ask('Install an APK', [
            { name: 'path', label: 'File name inside the farm’s apk folder', type: 'text', value: 'bridge.apk' },
        ], 'Install on the selection');
        if (!answers)
            return;
        const outcome = await request('/api/devices/actions/install-apk', {
            method: 'POST', body: JSON.stringify({ udids: chosen, path: answers.values.path }),
        });
        report(`${outcome.installed} installed, ${outcome.failed} failed`);
    },
    async reconnect(chosen) {
        let done = 0;
        for (const udid of chosen) {
            try {
                await send(`/api/devices/${encodeURIComponent(udid)}/reconnect`, {});
                done += 1;
            }
            catch { /* reported in the count */ }
        }
        report(`${done} of ${chosen.length} asked to reconnect`);
    },
    async pause(chosen) {
        let paused = 0;
        for (const udid of chosen) {
            const { schedules } = await request(`/api/schedules?deviceUdid=${encodeURIComponent(udid)}`);
            for (const schedule of schedules.filter(({ status }) => status === 'active')) {
                await send(`/api/schedules/${schedule.id}/pause`, {});
                paused += 1;
            }
        }
        report(`${paused} schedules paused`);
    },
};
document.addEventListener('click', (event) => {
    const button = event.target?.closest('[data-wall-action]');
    if (!button)
        return;
    const action = button.dataset.wallAction ?? '';
    if (action === 'select-all') {
        const visible = tiles.filter((tile) => !tile.element.hidden);
        const target = visible.some((tile) => !tile.checkbox?.checked);
        for (const tile of visible)
            if (tile.checkbox)
                tile.checkbox.checked = target;
        countSelection();
        return;
    }
    const run = ACTIONS[action];
    if (!run)
        return;
    const chosen = udids();
    if (!chosen.length)
        return report('Select at least one phone.');
    button.disabled = true;
    void run(chosen)
        .catch((error) => report(errorMessage(error)))
        .finally(() => { button.disabled = false; });
});
/* ---- restore ---------------------------------------------------------- */
const savedSize = remembered('tileSize');
if (savedSize && sizeSlider)
    sizeSlider.value = savedSize;
const savedRate = remembered('tileRate');
if (savedRate && rateSlider)
    rateSlider.value = savedRate;
for (const udid of (remembered('wall.selection') ?? '').split(',').filter(Boolean)) {
    const tile = byUdid.get(udid);
    if (tile?.checkbox)
        tile.checkbox.checked = true;
}
applySize();
applyRate();
applyFilters();
bindInspector();
const focus = remembered('wall.focus');
if (focus && byUdid.has(focus))
    void select(focus);
else
    markSelected(inspectorUdid);
