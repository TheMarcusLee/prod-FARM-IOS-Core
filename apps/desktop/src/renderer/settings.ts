import type { Settings } from './global.d.ts';

const form = document.querySelector<HTMLFormElement>('#settings');
const saveStatus = document.querySelector<HTMLElement>('#save-status');
const resetStatus = document.querySelector<HTMLElement>('#reset-status');

const numberFields = ['webPort', 'appiumPort', 'embeddedPostgresPort'] as const;

function fill(settings: Settings): void {
    if (!form) return;
    for (const [key, value] of Object.entries(settings)) {
        const field = form.elements.namedItem(key);
        if (!field) continue;
        if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = value === true;
        else if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.value = String(value ?? '');
    }
}

/** Only the fields present in the form are sent; secrets are never round-tripped. */
function collect(): Partial<Settings> {
    if (!form) return {};
    const data = new FormData(form);
    const patch: Record<string, unknown> = {};
    for (const [key, value] of data.entries()) {
        patch[key] = (numberFields as readonly string[]).includes(key) ? Number(value) : String(value);
    }
    const launch = form.elements.namedItem('launchAtLogin');
    patch.launchAtLogin = launch instanceof HTMLInputElement && launch.checked;
    return patch as Partial<Settings>;
}

form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (saveStatus) { saveStatus.className = 'status'; saveStatus.textContent = 'Saving…'; }
    void window.farm.saveSettings(collect()).then((result) => {
        fill(result.settings);
        if (!saveStatus) return;
        saveStatus.className = 'status ok';
        saveStatus.textContent = result.restartRequired
            ? 'Saved. The services were stopped — start them again from the Services panel.'
            : 'Saved.';
    }).catch((error: unknown) => {
        if (!saveStatus) return;
        saveStatus.className = 'status error';
        saveStatus.textContent = error instanceof Error ? error.message : String(error);
    });
});

document.querySelector('#reset-db')?.addEventListener('click', () => {
    if (resetStatus) { resetStatus.className = 'status'; resetStatus.textContent = 'Waiting for confirmation…'; }
    void window.farm.resetDatabase().then((result) => {
        if (!resetStatus) return;
        resetStatus.className = `status ${result.ok ? 'ok' : 'error'}`;
        resetStatus.textContent = result.message;
    });
});

void window.farm.getSettings().then(fill);
