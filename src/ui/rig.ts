/**
 * What the rig is doing, in plain words. One description of the running farm feeds both the
 * sidebar status block (`renderShell`'s `rig`) and the Rig page. See docs/design/backline.md.
 */
import type { DeviceConnectionStatus } from '../devices/connection-manager.js';
import type { RegisteredDevice } from '../devices/registry.js';
import { platformOf } from '../drivers/select.js';
import type { RigStatus } from './shell.js';

export type RigServiceState = 'running' | 'idle' | 'stopped';

export interface RigService {
    name: string;
    /** One sentence, in the operator's language: what it does and what it is doing now. */
    detail: string;
    state: RigServiceState;
    /** Where to read when it is not running. */
    docs?: string;
}

export interface RigFacts {
    devices: readonly RegisteredDevice[];
    /** UDIDs the farm can currently reach. */
    connected: ReadonlySet<string>;
    /** Per-device state from the wda-service supervisor; empty when it is not running. */
    statuses: readonly DeviceConnectionStatus[];
    /** True when the scheduler database answered. */
    database: boolean;
    /** Executions the worker is running right now. */
    running: number;
    /** Executions waiting to start. */
    queued: number;
    /** True when the event log is readable. */
    eventLog: boolean;
    /** Push registrations that would receive an alert. */
    pushRegistrations: number;
    /** Version reported by /health, when it is known. */
    release?: string;
}

function countPlatform(devices: readonly RegisteredDevice[], platform: 'ios' | 'android'): number {
    return devices.filter((device) => !device.disabled && platformOf(device) === platform).length;
}

function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}

/** The rows the Rig page shows, worst first is not sorted — the order is the order of the stack. */
export function rigServices(facts: RigFacts): RigService[] {
    const android = countPlatform(facts.devices, 'android');
    const ios = countPlatform(facts.devices, 'ios');
    const attachedAndroid = facts.devices.filter((device) => !device.disabled
        && platformOf(device) === 'android' && facts.connected.has(device.udid)).length;
    const attachedIos = facts.devices.filter((device) => !device.disabled
        && platformOf(device) === 'ios' && facts.connected.has(device.udid)).length;
    return [
        {
            name: 'Dashboard', state: 'running',
            detail: facts.release ? `Web and API, release ${facts.release}` : 'Web and API for this farm',
        },
        {
            name: 'Database', state: facts.database ? 'running' : 'stopped',
            detail: facts.database
                ? 'PostgreSQL holds schedules, runs and alerts'
                : 'Not connected — schedules and history are unavailable',
            docs: '/docs/getting-started',
        },
        {
            name: 'Worker', state: facts.running > 0 ? 'running' : facts.database ? 'idle' : 'stopped',
            detail: facts.database
                ? `Runs scheduled tasks · ${plural(facts.running, 'running')}, ${plural(facts.queued, 'queued')}`
                : 'Needs the database before it can pick up work',
            docs: '/docs/operations',
        },
        {
            name: 'Android bridge', state: attachedAndroid > 0 ? 'running' : android > 0 ? 'stopped' : 'idle',
            detail: android === 0
                ? 'No Android phones are registered yet'
                : `adb · ${attachedAndroid} of ${plural(android, 'phone')} attached`,
            docs: '/docs/android-dashboard',
        },
        {
            name: 'iPhone bridge', state: attachedIos > 0 ? 'running' : ios > 0 ? 'stopped' : 'idle',
            detail: ios === 0
                ? 'No iPhones are registered yet'
                : `WebDriverAgent · ${attachedIos} of ${plural(ios, 'phone')} ready`,
            docs: '/docs/getting-started',
        },
        {
            name: 'Device supervisor', state: facts.statuses.length ? 'running' : 'stopped',
            detail: facts.statuses.length
                ? `Watches ${plural(facts.statuses.length, 'phone')} and reconnects them`
                : 'Not running — phones are only seen when they are enumerated',
            docs: '/docs/operations',
        },
        {
            name: 'Alerts', state: facts.eventLog ? (facts.pushRegistrations > 0 ? 'running' : 'idle') : 'stopped',
            detail: facts.eventLog
                ? facts.pushRegistrations > 0
                    ? `Event log and push to ${plural(facts.pushRegistrations, 'phone')}`
                    : 'Event log is recording · no phones registered for push yet'
                : 'Event log is unavailable',
            docs: '/docs/fleet-and-alerts',
        },
    ];
}

/** The three-line block at the foot of the sidebar. */
export function rigStatus(facts: RigFacts): RigStatus {
    const services = rigServices(facts);
    const stopped = services.filter(({ state }) => state === 'stopped');
    const active = facts.devices.filter((device) => !device.disabled);
    const android = countPlatform(facts.devices, 'android');
    const ios = countPlatform(facts.devices, 'ios');
    const worker = facts.running > 0
        ? `Worker busy · ${plural(facts.running, 'running')}`
        : facts.database ? 'Worker idle' : 'Worker waiting for the database';
    return {
        headline: stopped.length
            ? `Rig degraded · ${plural(stopped.length, 'service')} down`
            : `Rig running · ${plural(services.length, 'service')}`,
        ok: stopped.length === 0,
        lines: [
            `${plural(active.length, 'phone')} · ${android} adb · ${ios} iPhone`,
            worker,
        ],
    };
}
