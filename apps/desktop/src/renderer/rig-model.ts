import { serviceTone, serviceWord } from '../main/state-words.ts';
import type { FleetSnapshot, ServiceSnapshot, Settings } from './global.d.ts';
import { pausedReason } from './paused.ts';

/**
 * The Rig window says what each part of the farm is for, in the operator's
 * words, rather than repeating the supervisor's service ids. This module is the
 * whole translation and it is pure: no DOM, so it is testable on its own.
 * See docs/design/backline.md.
 */
export interface RigRow {
    /** The supervisor id this row starts, stops and restarts; null when it is not ours to run. */
    id: string | null;
    name: string;
    detail: string;
    word: string;
    tone: string;
    /** The services whose log files the row's menu can open, in order. */
    logIds: string[];
}

/** The rows, top to bottom. `migrations` has no row: it is part of the database. */
const ROWS: { id: string | null; name: string; logIds?: string[] }[] = [
    { id: 'postgres', name: 'Database', logIds: ['postgres', 'migrations'] },
    { id: 'worker', name: 'Worker' },
    { id: 'web', name: 'Dashboard' },
    { id: 'adb', name: 'Android bridge' },
    { id: 'wda', name: 'iPhone bridge' },
    { id: null, name: 'Push relay' },
    { id: 'appium', name: 'Appium' },
];

/**
 * How many phones `adb` reported the last time it listed them.
 *
 * The count is not in the snapshot — the app never talks to the farm's API — but
 * the bridge logs `adb devices` every time it starts, and that output is already
 * on its way to this window. Null means it has not said yet.
 */
export function attachedAndroidPhones(service: ServiceSnapshot | undefined): number | null {
    if (!service) return null;
    let counted: number | null = null;
    for (const line of service.recentLogs) {
        const text = line.text.trim();
        if (/^list of devices attached$/i.test(text)) { counted = 0; continue; }
        if (counted === null) continue;
        if (/^\S+\s+device$/.test(text)) counted += 1;
    }
    return counted;
}

function migrationPhrase(migrations: ServiceSnapshot | undefined): string {
    switch (migrations?.state) {
        case 'healthy': return 'migrations applied';
        case 'starting': return 'applying migrations';
        case 'failed': return 'migrations failed';
        default: return '';
    }
}

function databaseDetail(snapshot: FleetSnapshot, settings: Settings | null): string {
    const external = (settings?.databaseUrl ?? '').trim().length > 0;
    const kind = external ? 'Your own Postgres server' : 'Embedded Postgres 17';
    const phrase = migrationPhrase(snapshot.services.find((service) => service.id === 'migrations'));
    return phrase ? `${kind} · ${phrase}` : kind;
}

function dashboardPort(snapshot: FleetSnapshot, settings: Settings | null): string {
    if (settings) return String(settings.webPort);
    const url = snapshot.dashboardUrl;
    return url ? new URL(url).port : '3000';
}

/** What a row says when nothing has gone wrong: what the service is *for*. */
function plainDetail(row: { id: string | null }, snapshot: FleetSnapshot, settings: Settings | null): string {
    switch (row.id) {
        case 'postgres': return databaseDetail(snapshot, settings);
        case 'worker': return 'Runs scheduled tasks';
        case 'web': return `Web and API on port ${dashboardPort(snapshot, settings)}`;
        case 'adb': {
            const phones = attachedAndroidPhones(snapshot.services.find((service) => service.id === 'adb'));
            if (phones === null) return 'adb';
            return `adb · ${phones} ${phones === 1 ? 'phone' : 'phones'} attached`;
        }
        case 'wda': return 'WebDriverAgent';
        case 'appium': return `Device automation on port ${settings?.appiumPort ?? 4725}`;
        // The relay runs beside the app, not inside it: it has its own process and
        // its own token, and this app has never supervised it (docs/architecture.md).
        default: return 'Runs beside the app · npm run push:relay';
    }
}

export function rigRows(snapshot: FleetSnapshot, settings: Settings | null): RigRow[] {
    return ROWS.map((row) => {
        if (row.id === null) {
            return { id: null, name: row.name, detail: plainDetail(row, snapshot, settings), word: 'Not configured', tone: 'idle', logIds: [] };
        }
        const service = snapshot.services.find((candidate) => candidate.id === row.id);
        if (!service) {
            return { id: row.id, name: row.name, detail: plainDetail(row, snapshot, settings), word: 'Idle', tone: 'idle', logIds: [] };
        }
        // A service that failed or was never configured has one thing worth saying,
        // and the supervisor already wrote it as a sentence: show that instead.
        const explained = service.state === 'failed' || service.state === 'not-configured';
        const parts = [explained && service.detail ? service.detail : plainDetail(row, snapshot, settings)];
        if (service.restarts > 0) parts.push(`restarted ${service.restarts} ${service.restarts === 1 ? 'time' : 'times'}`);
        return {
            id: row.id,
            name: row.name,
            detail: parts.filter(Boolean).join(' · '),
            word: serviceWord(service.state),
            tone: serviceTone(service.state),
            logIds: (row.logIds ?? [row.id]).filter((id) => snapshot.services.some((candidate) => candidate.id === id)),
        };
    });
}

/** The one line under the window title: what the farm is doing right now. */
export function headerState(snapshot: FleetSnapshot): { text: string; tone: string } {
    const paused = pausedReason(snapshot);
    if (paused) return { text: paused, tone: 'bad' };
    if (snapshot.dashboardUrl) {
        return {
            text: `Backline is running · dashboard at ${snapshot.dashboardUrl.replace(/^https?:\/\//, '')}`,
            tone: 'ok',
        };
    }
    return { text: 'Backline is starting · the dashboard is not up yet', tone: 'accent' };
}
