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
byId('upload-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = byId('upload-result');
    say(result, 'Uploading…');
    void request('/api/content/items', { method: 'POST', body: new FormData(form) })
        .then(() => { say(result, 'Uploaded. Normalising in the background.'); form.reset(); refresh('library'); })
        .catch((error) => say(result, error.message));
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
