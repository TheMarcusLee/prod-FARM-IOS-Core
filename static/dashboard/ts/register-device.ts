export {};

type CheckState = 'pending' | 'checking' | 'blocked' | 'passed' | 'failed';
type Platform = 'ios' | 'android';
interface Device { name: string; osVersion: string; udid: string; platform?: Platform }
interface RegistrationCheck { state: CheckState; message: string; updatedAt: string }
interface Snapshot {
    id: string; device: Device & { productType?: string; modelName?: string }; name: string; coordinateProfile?: string;
    platform: Platform; driver?: string; bridgePort?: number; bridgeUrl?: string; checkNames: string[];
    availableProfiles: Array<{ name: string; displayName: string; screenSize: { width: number; height: number } }>;
    recommendedProfile?: string;
    wdaLocalPort: number; mjpegLocalPort: number; tiktokAccounts: string[]; hasPasscode: boolean;
    busy: boolean; checks: Record<string, RegistrationCheck>; logs: string[]; canFinalize: boolean; finalized: boolean;
}

function platformOf(device: Pick<Device, 'platform'>): Platform {
    return device.platform ?? 'ios';
}

function osLabel(device: Device): string {
    return `${platformOf(device) === 'android' ? 'Android' : 'iOS'} ${device.osVersion}`;
}

// One heading per check name, per platform: the same slot means different work on each.
const CHECK_LABELS: Record<Platform, Record<string, string>> = {
    ios: {
        host: 'Host tooling', connection: 'USB connection', signing: 'Xcode signing', developer: 'Developer Mode',
        wda: 'WebDriverAgent', appium: 'Appium session', video: 'Video stream', touch: 'Touch input',
        tiktok: 'TikTok installed', accounts: 'TikTok accounts',
    },
    android: {
        host: 'adb on PATH', connection: 'adb sees the phone', developer: 'USB debugging authorised',
        driver: 'Control channel', video: 'Screen capture', touch: 'Input dispatch',
        tiktok: 'TikTok installed', accounts: 'TikTok accounts',
    },
};

function checkLabel(platform: Platform, name: string): string {
    return CHECK_LABELS[platform][name] ?? name.replace(/^./, (letter) => letter.toUpperCase());
}

const candidatePanel = document.querySelector<HTMLElement>('#candidate-panel')!;
const candidateList = document.querySelector<HTMLElement>('#candidate-list')!;
const registrationPanel = document.querySelector<HTMLElement>('#registration-panel')!;
const title = document.querySelector<HTMLElement>('#registration-title')!;
const busy = document.querySelector<HTMLElement>('#registration-busy')!;
const errorBox = document.querySelector<HTMLElement>('#registration-error')!;
const form = document.querySelector<HTMLFormElement>('#registration-details')!;
const nameInput = document.querySelector<HTMLInputElement>('#registration-name')!;
const profileInput = document.querySelector<HTMLSelectElement>('#registration-profile')!;
const accountsInput = document.querySelector<HTMLInputElement>('#registration-accounts')!;
const passcodeInput = document.querySelector<HTMLInputElement>('#registration-passcode')!;
const ports = document.querySelector<HTMLElement>('#registration-ports')!;
const checks = document.querySelector<HTMLElement>('#registration-checks')!;
const logs = document.querySelector<HTMLElement>('#registration-logs')!;
const authorize = document.querySelector<HTMLInputElement>('#authorize-registration')!;
const driverField = document.querySelector<HTMLElement>('#registration-driver-field')!;
const driverInput = document.querySelector<HTMLSelectElement>('#registration-driver')!;
const bridgeField = document.querySelector<HTMLElement>('#registration-bridge-field')!;
const bridgeInput = document.querySelector<HTMLInputElement>('#registration-bridge-url')!;
const profileField = document.querySelector<HTMLElement>('#registration-profile-field')!;
const passcodeField = document.querySelector<HTMLElement>('#registration-passcode-field')!;
const authorizationField = document.querySelector<HTMLElement>('#authorization-field')!;
const guidanceIos = document.querySelector<HTMLElement>('#guidance-ios')!;
const guidanceAndroid = document.querySelector<HTMLElement>('#guidance-android')!;
const prepareButton = document.querySelector<HTMLButtonElement>('#action-prepare')!;
const verifyButton = document.querySelector<HTMLButtonElement>('#action-verify')!;
const finalizeButton = document.querySelector<HTMLButtonElement>('#action-finalize')!;
let currentId: string | undefined;
let poll: number | undefined;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options);
    if (response.status === 204) return undefined as T;
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}

function showError(error?: unknown): void {
    errorBox.hidden = !error;
    errorBox.textContent = error ? (error instanceof Error ? error.message : String(error)) : '';
}

async function candidates(): Promise<void> {
    showError();
    candidateList.textContent = 'Checking connected devices…';
    try {
        const data = await request<{ devices: Device[] }>('/api/device-registrations/candidates');
        if (!data.devices.length) {
            candidateList.innerHTML = '<div class="empty-state"><h3>No unregistered device is readable</h3><p>Connect by USB, unlock the device, accept Trust, and click Recheck.</p></div>';
            return;
        }
        candidateList.replaceChildren(...data.devices.map((device) => {
            const card = document.createElement('article'); card.className = 'candidate-card';
            const copy = document.createElement('div');
            const heading = document.createElement('h3'); heading.textContent = device.name;
            const badge = document.createElement('span');
            badge.className = `badge platform-${platformOf(device)}`;
            badge.textContent = platformOf(device) === 'android' ? 'Android' : 'iOS';
            const meta = document.createElement('p'); meta.textContent = `${osLabel(device)} · ${device.udid}`;
            copy.append(heading, badge, meta);
            const button = document.createElement('button'); button.className = 'button primary'; button.type = 'button'; button.textContent = 'Set up this device';
            button.addEventListener('click', () => void create(device.udid));
            card.append(copy, button); return card;
        }));
    } catch (error) { candidateList.textContent = ''; showError(error); }
}

async function create(udid: string): Promise<void> {
    const snapshot = await request<Snapshot>('/api/device-registrations', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ udid }),
    });
    currentId = snapshot.id;
    candidatePanel.hidden = true; registrationPanel.hidden = false;
    render(snapshot);
    poll = window.setInterval(() => void refreshSnapshot(), 2_000);
}

function render(snapshot: Snapshot): void {
    const android = snapshot.platform === 'android';
    title.textContent = `${snapshot.name} · ${osLabel(snapshot.device)}`;
    busy.hidden = !snapshot.busy;
    // Coordinate packs, passcodes and Apple team registration are iOS-only concepts.
    profileField.hidden = android;
    passcodeField.hidden = android;
    authorizationField.hidden = android;
    guidanceIos.hidden = android;
    guidanceAndroid.hidden = !android;
    driverField.hidden = !android;
    bridgeField.hidden = !android || snapshot.driver !== 'a11y-bridge';
    profileInput.required = !android;
    prepareButton.textContent = android ? 'Set up the driver' : 'Register and prepare WDA';
    verifyButton.textContent = android ? 'Verify capture, input, and TikTok' : 'Verify Appium, video, touch, and accounts';
    if (android && document.activeElement !== driverInput) driverInput.value = snapshot.driver ?? 'adb';
    if (android && document.activeElement !== bridgeInput) bridgeInput.value = snapshot.bridgeUrl ?? '';
    if (document.activeElement !== nameInput) nameInput.value = snapshot.name;
    if (!android && document.activeElement !== profileInput) {
        const previous = profileInput.value;
        profileInput.replaceChildren(new Option('Choose a coordinate profile', ''));
        for (const profile of snapshot.availableProfiles) {
            const recommended = profile.name === snapshot.recommendedProfile ? ' · recommended for this model' : '';
            profileInput.add(new Option(`${profile.displayName} (${profile.name}) · ${profile.screenSize.width}×${profile.screenSize.height}${recommended}`, profile.name));
        }
        profileInput.value = snapshot.coordinateProfile ?? (snapshot.availableProfiles.some(({ name }) => name === previous) ? previous : '');
    }
    if (document.activeElement !== accountsInput) accountsInput.value = snapshot.tiktokAccounts.join(', ');
    passcodeInput.placeholder = snapshot.hasPasscode ? 'Passcode saved in this setup session' : 'Optional numeric passcode';
    ports.textContent = android
        ? `${snapshot.driver ?? 'adb'} · serial ${snapshot.device.udid}`
        : `WDA ${snapshot.wdaLocalPort} · video ${snapshot.mjpegLocalPort}`;
    checks.replaceChildren(...snapshot.checkNames.map((key) => {
        const value = snapshot.checks[key] ?? { state: 'pending' as CheckState, message: 'Not checked yet', updatedAt: '' };
        const row = document.createElement('article'); row.className = `registration-check ${value.state}`;
        const state = document.createElement('span'); state.className = `check-mark ${value.state}`; state.textContent = value.state === 'passed' ? '✓' : value.state === 'checking' ? '…' : '!';
        const copy = document.createElement('div'); const heading = document.createElement('h3'); heading.textContent = checkLabel(snapshot.platform, key);
        const message = document.createElement('p'); message.textContent = value.message; copy.append(heading, message); row.append(state, copy); return row;
    }));
    logs.textContent = snapshot.logs.length ? snapshot.logs.join('\n') : 'No setup output yet.';
    finalizeButton.disabled = !snapshot.canFinalize || snapshot.busy;
    for (const element of registrationPanel.querySelectorAll<HTMLButtonElement>('button')) {
        if (element.id !== 'action-cancel') element.disabled = snapshot.busy || (element.id === 'action-finalize' && !snapshot.canFinalize);
    }
    if (snapshot.finalized) {
        if (poll) window.clearInterval(poll);
        window.location.assign(`/devices/${encodeURIComponent(snapshot.device.udid)}`);
    }
}

async function refreshSnapshot(): Promise<void> {
    if (!currentId) return;
    try { render(await request<Snapshot>(`/api/device-registrations/${encodeURIComponent(currentId)}`)); } catch (error) { showError(error); }
}

async function action(name: 'refresh' | 'prepare' | 'verify' | 'finalize'): Promise<void> {
    if (!currentId) return;
    showError();
    try {
        const snapshot = await request<Snapshot>(`/api/device-registrations/${encodeURIComponent(currentId)}/actions/${name}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ authorizeTeamRegistration: authorize.checked }),
        });
        render(snapshot);
    } catch (error) { showError(error); }
}

document.querySelector<HTMLButtonElement>('#refresh-candidates')!.addEventListener('click', () => void candidates());
document.querySelector<HTMLButtonElement>('#action-refresh')!.addEventListener('click', () => void action('refresh'));
prepareButton.addEventListener('click', () => {
    // The Apple team-registration warning is meaningless on Android.
    if (!authorizationField.hidden && !authorize.checked
        && !window.confirm('Continue without allowing automatic Apple Developer team device registration? Xcode may ask you to register it manually.')) return;
    void action('prepare');
});
verifyButton.addEventListener('click', () => void action('verify'));
driverInput.addEventListener('change', () => {
    bridgeField.hidden = driverInput.value !== 'a11y-bridge';
});
finalizeButton.addEventListener('click', () => void action('finalize'));
document.querySelector<HTMLButtonElement>('#action-cancel')!.addEventListener('click', async () => {
    if (!currentId || !window.confirm('Cancel this setup? Apple Developer registration or an installed WDA app cannot be undone automatically.')) return;
    await request(`/api/device-registrations/${encodeURIComponent(currentId)}`, { method: 'DELETE' });
    if (poll) window.clearInterval(poll); currentId = undefined; registrationPanel.hidden = true; candidatePanel.hidden = false; await candidates();
});
form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!currentId) return;
    showError();
    try {
        const snapshot = await request<Snapshot>(`/api/device-registrations/${encodeURIComponent(currentId)}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(driverField.hidden ? {
                name: nameInput.value, coordinateProfile: profileInput.value,
                tiktokAccounts: accountsInput.value.split(','), passcode: passcodeInput.value || undefined,
            } : {
                name: nameInput.value, driver: driverInput.value, bridgeUrl: bridgeInput.value.trim(),
                tiktokAccounts: accountsInput.value.split(','),
            }),
        });
        passcodeInput.value = ''; render(snapshot);
    } catch (error) { showError(error); }
});

void (async () => {
    await candidates();
    const requestedUdid = new URLSearchParams(window.location.search).get('udid');
    if (requestedUdid) await create(requestedUdid).catch(showError);
})();
