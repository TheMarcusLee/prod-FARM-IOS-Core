const byId = (id) => document.querySelector(`#${id}`);
async function request(url, options) {
    const response = await fetch(url, options);
    if (response.status === 204)
        return undefined;
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}
function json(url, method, payload) {
    return request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}
function say(element, message) {
    element.textContent = message;
}
function formValues(form) {
    const values = {};
    for (const [key, value] of new FormData(form).entries()) {
        if (typeof value === 'string')
            values[key] = value;
    }
    for (const box of form.querySelectorAll('input[type=checkbox]'))
        values[box.name] = box.checked;
    return values;
}
function refresh(section) {
    const targets = {
        library: ['/api/content/items', '#content-library'],
        sets: ['/api/content/sets', '#content-sets'],
        templates: ['/api/content/templates', '#caption-templates'],
        rules: ['/api/drip/rules', '#drip-rules'],
    }[section];
    if (typeof htmx === 'undefined') {
        location.reload();
        return;
    }
    // The fragments each render their own wrapper element, so the swap has to
    // be outerHTML. htmx.ajax defaults to innerHTML, which nested a second
    // #content-library inside the first on every refresh — duplicate ids, and
    // one more level of nesting each time the operator pressed Refresh.
    void htmx.ajax('GET', targets[0], { target: targets[1], swap: 'outerHTML' });
}
// ---- ingest ---------------------------------------------------------------
/**
 * The dropzone is the primary way media arrives; the file input behind it stays the thing that
 * actually carries the files, so the form posts exactly as it did before drag and drop existed.
 */
const dropzone = byId('upload-drop');
const fileInput = byId('upload-media');
const chosen = byId('upload-chosen');
function describeChosen() {
    const count = fileInput.files?.length ?? 0;
    chosen.textContent = count === 0 ? '' : count === 1
        ? (fileInput.files?.[0]?.name ?? '1 file ready')
        : `${count} files ready`;
}
byId('upload-choose').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', describeChosen);
dropzone.addEventListener('click', (event) => {
    if (!event.target.closest('button'))
        fileInput.click();
});
dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
    }
});
for (const name of ['dragenter', 'dragover']) {
    dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add('is-over'); });
}
for (const name of ['dragleave', 'dragend']) {
    dropzone.addEventListener(name, () => dropzone.classList.remove('is-over'));
}
dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-over');
    const dropped = event.dataTransfer?.files;
    if (!dropped?.length)
        return;
    fileInput.files = dropped;
    describeChosen();
});
// ---- chunked uploads -------------------------------------------------------
/**
 * Files at or above this go through `/api/uploads`; anything smaller is one
 * `POST /api/content/items` exactly as it always was. A 3 MB image does not
 * need a session, three round trips and a localStorage entry.
 */
const SMALL_FILE_BYTES = 8 * 1024 * 1024;
/** Three in flight: enough to fill a tunnel, few enough to leave the dashboard responsive. */
const PARALLEL_CHUNKS = 3;
const RESUME_PREFIX = 'backline.upload.';
const UPLOAD_ID_PATTERN = /^[0-9a-f]{32}$/;
const progressList = byId('upload-progress');
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
/**
 * The file the browser has now is the file the session was opened for only if
 * all three of these match; a re-picked file that differs in any of them gets a
 * new session rather than being stitched onto someone else's bytes.
 */
function fingerprintOf(file) {
    return `${RESUME_PREFIX}${file.name}:${file.size}:${file.lastModified}`;
}
function rememberUpload(file, id) {
    try {
        localStorage.setItem(fingerprintOf(file), id);
    }
    catch { /* private mode; resume is a nicety */ }
}
function forgetUpload(file) {
    try {
        localStorage.removeItem(fingerprintOf(file));
    }
    catch { /* as above */ }
}
function rememberedUpload(file) {
    try {
        const id = localStorage.getItem(fingerprintOf(file));
        return id && UPLOAD_ID_PATTERN.test(id) ? id : null;
    }
    catch {
        return null;
    }
}
/**
 * `crypto.subtle` only exists in a secure context. A farm reached over plain
 * http on a LAN address has none, and without per-chunk digests the protocol
 * would have to be told to skip its own integrity check — so those deployments
 * keep the single multipart POST instead.
 */
async function sha256Hex(bytes) {
    if (!globalThis.crypto?.subtle)
        return null;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
/**
 * Built with DOM calls rather than a template string: a file name is the one
 * piece of text on this page that comes straight from the operator's disk.
 */
function createRow(file) {
    const element = document.createElement('li');
    element.className = 'bl-upload';
    const head = document.createElement('div');
    head.className = 'bl-upload-head';
    const name = document.createElement('span');
    name.className = 'bl-upload-name';
    name.textContent = file.name;
    name.title = file.name;
    const meta = document.createElement('span');
    meta.className = 'bl-upload-meta';
    meta.setAttribute('aria-live', 'polite');
    head.append(name, meta);
    const bar = document.createElement('div');
    bar.className = 'bl-upload-bar';
    const fill = document.createElement('div');
    fill.className = 'bl-upload-fill';
    bar.append(fill);
    const actions = document.createElement('div');
    actions.className = 'bl-upload-actions';
    const pause = document.createElement('button');
    pause.type = 'button';
    pause.className = 'bl-btn';
    pause.textContent = 'Pause';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'bl-btn';
    cancel.textContent = 'Cancel';
    actions.append(pause, cancel);
    element.append(head, bar, actions);
    progressList.append(element);
    return {
        element,
        setMeta: (text) => { meta.textContent = text; },
        setProgress: (fraction) => { fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`; },
        setFailed: () => element.classList.add('is-failed'),
        pause,
        cancel,
        remove: () => { actions.remove(); setTimeout(() => element.remove(), 6_000); },
    };
}
/** The session to continue, or a fresh one. A remembered id that has expired is simply dropped. */
async function openSession(file, mimeType) {
    const remembered = rememberedUpload(file);
    if (remembered) {
        const existing = await request(`/api/uploads/${remembered}`).catch(() => null);
        if (existing && existing.size === file.size)
            return existing;
        forgetUpload(file);
    }
    const created = await request('/api/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, size: file.size, mimeType }),
    });
    rememberUpload(file, created.id);
    return { ...created, received: created.received ?? [] };
}
async function putChunk(session, index, file, signal) {
    const start = index * session.chunkSize;
    const bytes = await file.slice(start, Math.min(start + session.chunkSize, file.size)).arrayBuffer();
    const digest = await sha256Hex(bytes);
    if (!digest)
        throw new Error('This browser cannot hash a chunk — reload the dashboard over https.');
    const response = await fetch(`/api/uploads/${session.id}/chunks/${index}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': digest },
        body: bytes,
        signal,
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `Chunk ${index} was refused (${response.status})`);
    }
}
/** The old path, kept whole: small files, and any browser without a subtle crypto. */
async function uploadWholeFile(file, options) {
    const form = new FormData();
    form.append('media', file);
    if (options.tags)
        form.append('tags', options.tags);
    if (options.crop)
        form.append('crop', 'true');
    await request('/api/content/items', { method: 'POST', body: form });
}
/**
 * One file, start to finish: open or resume a session, send the chunks that are
 * still missing three at a time, then complete. Pause parks the workers between
 * chunks; cancel aborts the request in flight and drops the session on the farm.
 */
async function uploadFile(file, options) {
    const row = createRow(file);
    const controls = { paused: false, cancelled: false };
    const aborter = new AbortController();
    row.pause.addEventListener('click', () => {
        controls.paused = !controls.paused;
        row.pause.textContent = controls.paused ? 'Resume' : 'Pause';
    });
    row.cancel.addEventListener('click', () => {
        controls.cancelled = true;
        aborter.abort();
    });
    const mimeType = file.type || 'application/octet-stream';
    const small = file.size < SMALL_FILE_BYTES || !globalThis.crypto?.subtle;
    try {
        if (small) {
            row.pause.disabled = true;
            row.setMeta(`${formatBytes(file.size)} · uploading`);
            row.setProgress(0.5);
            await uploadWholeFile(file, options);
            row.setProgress(1);
            row.setMeta(`${formatBytes(file.size)} · done`);
            row.remove();
            refresh('library');
            return;
        }
        const session = await openSession(file, mimeType);
        const done = new Set(session.received);
        const pending = [];
        for (let index = 0; index < session.chunkCount; index += 1)
            if (!done.has(index))
                pending.push(index);
        let sent = 0;
        const startedAt = Date.now();
        const report = () => {
            const uploaded = done.size * session.chunkSize;
            const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
            const speed = sent / elapsed;
            const percent = Math.round((Math.min(uploaded, file.size) / file.size) * 100);
            row.setProgress(Math.min(uploaded, file.size) / file.size);
            row.setMeta(controls.paused
                ? `${formatBytes(file.size)} · ${percent}% · paused`
                : `${formatBytes(file.size)} · ${percent}% · ${formatBytes(Math.round(speed))}/s`);
        };
        report();
        const next = () => pending.shift();
        const worker = async () => {
            for (let index = next(); index !== undefined; index = next()) {
                while (controls.paused && !controls.cancelled) {
                    report();
                    await new Promise((resolve) => setTimeout(resolve, 250));
                }
                if (controls.cancelled)
                    throw new Error('Cancelled');
                await putChunk(session, index, file, aborter.signal);
                done.add(index);
                sent += index === session.chunkCount - 1 ? file.size - index * session.chunkSize : session.chunkSize;
                report();
            }
        };
        await Promise.all(Array.from({ length: PARALLEL_CHUNKS }, worker));
        row.setMeta(`${formatBytes(file.size)} · finishing`);
        await request(`/api/uploads/${session.id}/complete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tags: options.tags, crop: options.crop }),
        });
        forgetUpload(file);
        row.setProgress(1);
        row.setMeta(`${formatBytes(file.size)} · done`);
        row.remove();
        refresh('library');
    }
    catch (error) {
        row.setFailed();
        if (controls.cancelled) {
            const id = rememberedUpload(file);
            if (id)
                void request(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => undefined);
            forgetUpload(file);
            row.setMeta('cancelled');
            row.remove();
            return;
        }
        // The session is deliberately kept: picking the same file again picks
        // up from the chunks that did land, even after a reload.
        row.pause.disabled = true;
        row.cancel.textContent = 'Dismiss';
        row.cancel.addEventListener('click', () => row.element.remove());
        row.setMeta(error.message);
    }
}
byId('upload-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = byId('upload-result');
    const files = [...(fileInput.files ?? [])];
    if (!files.length) {
        say(result, 'Choose at least one file first.');
        return;
    }
    const options = {
        tags: byId('upload-tags').value.trim(),
        crop: byId('upload-crop').checked,
    };
    say(result, `Uploading ${files.length} file(s). Normalising follows in the background.`);
    for (const file of files)
        void uploadFile(file, options);
    form.reset();
    describeChosen();
});
byId('ingest-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = byId('ingest-result');
    say(result, 'Scanning…');
    void json('/api/content/ingest', 'POST', formValues(form))
        .then((body) => { say(result, `Queued ${body.ingested} file(s).`); refresh('library'); })
        .catch((error) => say(result, error.message));
});
byId('ingest-url-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = byId('ingest-url-result');
    say(result, 'Downloading…');
    void json('/api/content/ingest-url', 'POST', formValues(form))
        .then(() => { say(result, 'Downloaded and queued.'); form.reset(); refresh('library'); })
        .catch((error) => say(result, error.message));
});
// ---- library --------------------------------------------------------------
byId('library-filter').addEventListener('change', (event) => {
    const tag = event.currentTarget.value.trim();
    if (typeof htmx === 'undefined')
        return;
    void htmx.ajax('GET', `/api/content/items${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`, '#content-library');
});
document.addEventListener('click', (event) => {
    const button = event.target?.closest('button');
    if (!button)
        return;
    const failed = (error) => window.alert(error.message);
    if (button.dataset.deleteItem) {
        if (!window.confirm('Delete this media and its files?'))
            return;
        void request(`/api/content/items/${button.dataset.deleteItem}`, { method: 'DELETE' })
            .then(() => refresh('library')).catch(failed);
    }
    else if (button.dataset.editItem) {
        const tags = window.prompt('Tags (comma separated)', button.dataset.tags ?? '');
        if (tags === null)
            return;
        const hashtags = window.prompt('Hashtags (comma separated)', button.dataset.hashtags ?? '');
        if (hashtags === null)
            return;
        const caption = window.prompt('Title / caption seed', button.dataset.caption ?? '');
        if (caption === null)
            return;
        void json(`/api/content/items/${button.dataset.editItem}`, 'PATCH', { tags, hashtags, caption })
            .then(() => refresh('library')).catch(failed);
    }
    else if (button.dataset.deleteSet) {
        if (!window.confirm('Delete this set?'))
            return;
        void request(`/api/content/sets/${button.dataset.deleteSet}`, { method: 'DELETE' })
            .then(() => { refresh('sets'); void loadChoices(); }).catch(failed);
    }
    else if (button.dataset.deleteTemplate) {
        if (!window.confirm('Delete this caption template?'))
            return;
        void request(`/api/content/templates/${button.dataset.deleteTemplate}`, { method: 'DELETE' })
            .then(() => { refresh('templates'); void loadChoices(); }).catch(failed);
    }
    else if (button.dataset.toggleRule) {
        void json(`/api/drip/rules/${button.dataset.toggleRule}`, 'PATCH', { enabled: button.dataset.enabled === 'true' })
            .then(() => refresh('rules')).catch(failed);
    }
    else if (button.dataset.deleteRule) {
        if (!window.confirm('Delete this drip rule? Planned posts stay scheduled.'))
            return;
        void request(`/api/drip/rules/${button.dataset.deleteRule}`, { method: 'DELETE' })
            .then(() => refresh('rules')).catch(failed);
    }
});
// ---- sets, templates, rules ------------------------------------------------
byId('set-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    void json('/api/content/sets', 'POST', formValues(form))
        .then(() => { form.reset(); refresh('sets'); void loadChoices(); })
        .catch((error) => window.alert(error.message));
});
byId('template-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    void json('/api/content/templates', 'POST', formValues(form))
        .then(() => { form.reset(); refresh('templates'); void loadChoices(); })
        .catch((error) => window.alert(error.message));
});
byId('template-preview-button').addEventListener('click', () => {
    const form = byId('template-form');
    const template = (new FormData(form).get('template') ?? '');
    void json('/api/content/templates/preview', 'POST', { template })
        .then((body) => say(byId('template-preview'), body.preview || '(empty)'))
        .catch((error) => say(byId('template-preview'), error.message));
});
byId('rule-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = byId('rule-result');
    void json('/api/drip/rules', 'POST', formValues(form))
        .then(() => { say(result, 'Rule created.'); refresh('rules'); })
        .catch((error) => say(result, error.message));
});
byId('plan-now').addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    void json('/api/drip/plan', 'POST', {})
        .then((body) => {
        const report = body;
        say(byId('rule-result'), `Planned ${report.planned} post(s).${report.skipped.length ? ` ${report.skipped.join('; ')}` : ''}`);
        refresh('rules');
    })
        .catch((error) => say(byId('rule-result'), error.message))
        .finally(() => { button.disabled = false; });
});
function fill(select, options, keepBlank) {
    const current = select.value;
    select.replaceChildren();
    if (keepBlank)
        select.append(new Option('—', ''));
    for (const option of options)
        select.append(new Option(option.label, option.value));
    select.value = current;
}
async function loadChoices() {
    const [devices, sets, templates] = await Promise.all([
        request('/api/devices').catch(() => []),
        request('/api/content/sets').catch(() => ({ sets: [] })),
        request('/api/content/templates').catch(() => ({ templates: [] })),
    ]);
    fill(byId('rule-device'), devices.map((device) => ({ value: device.udid, label: device.name })), false);
    fill(byId('rule-set'), sets.sets.map((set) => ({ value: set.id, label: set.name })), true);
    fill(byId('rule-template'), templates.templates.map((template) => ({ value: template.id, label: template.name })), true);
}
byId('refresh-content').addEventListener('click', () => {
    for (const section of ['library', 'sets', 'templates', 'rules'])
        refresh(section);
    void loadChoices();
});
void loadChoices();
export {};
