/**
 * Account identity colours. An account is a person's handle on a platform, and the operator
 * recognises it by colour long before they read the label — on a timeline clip, on a chip, in the
 * inspector. The palette and the "assign in order of account creation" rule are fixed by
 * docs/design/backline.md; this module is the one place that rule lives, so the Schedule page, the
 * Content page and anything else that shows an account agree about which handle is sage.
 */

import type { RegisteredDevice } from '../devices/registry.js';

export interface AccountColour {
    /** The palette entry's name, for debugging and for `data-` attributes. */
    name: string;
    /** The fill a clip or chip uses. */
    fill: string;
    /** The 1px border on that fill. */
    line: string;
    /** Text drawn on the fill — the darker tone of the same hue. */
    ink: string;
}

/** The eight identity colours, in the order the spec assigns them. */
export const ACCOUNT_PALETTE: readonly AccountColour[] = [
    { name: 'sage', fill: '#a3c497', line: '#7fa66a', ink: '#24391c' },
    { name: 'lilac', fill: '#b9a6dc', line: '#9a86c9', ink: '#2c2140' },
    { name: 'coral', fill: '#e6a48f', line: '#d9836b', ink: '#4a1f14' },
    { name: 'sky', fill: '#9dbfdd', line: '#6aa0c9', ink: '#16324a' },
    { name: 'mustard', fill: '#dcc27a', line: '#c9a94a', ink: '#3f3210' },
    { name: 'rose', fill: '#e0a3c4', line: '#c77ea6', ink: '#45182f' },
    { name: 'mint', fill: '#9fd3c3', line: '#6fb39f', ink: '#123b31' },
    { name: 'slate', fill: '#b3bccd', line: '#8593ab', ink: '#1c2534' },
];

/** A task with no account at all — a warm-up, a doomscroll, a runbook. Neutral, never an identity. */
export const UNASSIGNED_COLOUR: AccountColour = {
    name: 'neutral', fill: '#eee9dd', line: '#e3e6eb', ink: '#5b6270',
};

/** The palette cycles, so a ninth account is sage again rather than uncoloured. */
export function accountColourAt(index: number): AccountColour {
    if (!Number.isInteger(index) || index < 0) return UNASSIGNED_COLOUR;
    return ACCOUNT_PALETTE[index % ACCOUNT_PALETTE.length] as AccountColour;
}

/** Accounts a device declares, in the order its plugins list them. */
export function deviceAccounts(device: Pick<RegisteredDevice, 'pluginData'>): string[] {
    const found: string[] = [];
    for (const data of Object.values(device.pluginData ?? {})) {
        const candidate = (data as { accounts?: unknown }).accounts;
        if (!Array.isArray(candidate)) continue;
        for (const entry of candidate) if (typeof entry === 'string' && entry.trim()) found.push(entry.trim());
    }
    return found;
}

/**
 * Every account the farm knows, in registration order: device by device in the order devices were
 * registered, then anything else (a drip rule for an account no device lists yet) in the order it
 * was seen. Append-only by construction, so an account's colour never moves when a new one appears.
 */
export function collectAccounts(
    devices: readonly Pick<RegisteredDevice, 'pluginData'>[],
    extra: Iterable<string> = [],
): string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const add = (account: string) => {
        const name = account.trim();
        if (!name || seen.has(name)) return;
        seen.add(name);
        ordered.push(name);
    };
    for (const device of devices) for (const account of deviceAccounts(device)) add(account);
    for (const account of extra) if (typeof account === 'string') add(account);
    return ordered;
}

/** Maps each account to its colour. Order in, colour out — the whole contract. */
export function assignAccountColours(accounts: readonly string[]): Map<string, AccountColour> {
    const colours = new Map<string, AccountColour>();
    let index = 0;
    for (const account of accounts) {
        if (colours.has(account)) continue;
        colours.set(account, accountColourAt(index));
        index += 1;
    }
    return colours;
}

/** The colour to paint something with, falling back to the neutral fill for account-less work. */
export function colourFor(colours: ReadonlyMap<string, AccountColour>, account: string | null | undefined): AccountColour {
    if (!account) return UNASSIGNED_COLOUR;
    return colours.get(account) ?? UNASSIGNED_COLOUR;
}
