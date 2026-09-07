import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Confirmed selectors, kept as data rather than as an edit to the routine.
 *
 * Every Android routine ships a table of *guesses*: lists of alternates for each on-screen
 * control, because TikTok, Instagram, YouTube and Threads relabel and re-id things between
 * builds, regions and A/B buckets. The only way to know which alternate is real is to look at a
 * phone — so when somebody (an operator, or the calibration agent in src/agent) does look, the
 * answer lands here instead of in a code change, keyed by plugin, device and selector name.
 *
 * One file, one JSON array, next to the scheduler's other state. No Postgres: this has to be
 * readable by a routine running as a short-lived child process with no database connection.
 */

/** Structurally the `Selector` each network's `ui.ts` declares; kept independent so this module imports none of them. */
export interface SelectorEntry {
    /** Visible text or content-desc; case-insensitive substring unless `exact`. */
    text?: string;
    exact?: boolean;
    /** Android `resource-id`, with or without the `<package>:id/` prefix. */
    id?: string;
}

export type SelectorEntryList = readonly SelectorEntry[];

/** A routine's selector table: named lists, plus the odd bare list of id fragments. */
export type SelectorTable = Readonly<Record<string, SelectorEntryList | readonly string[]>>;

/** The wildcard udid: an override that holds for every phone in the farm. */
export const ANY_DEVICE = '*';

export interface SelectorOverride {
    /** The plugin whose routine reads this table, e.g. `com.git-agni.tiktok`. */
    plugin: string;
    /** A device udid / adb serial, or `*` for the whole fleet. */
    udid: string;
    /** The key in the routine's selector table, e.g. `captionField`. */
    name: string;
    /** What actually matched on the phone. Tried before the built-in alternates. */
    entry: SelectorEntry;
    /** Free text: the build, the screen, whatever made this the right answer. */
    note?: string;
    /** Who confirmed it — an operator's name, or `agent:<model>`. */
    confirmedBy: string;
    /** ISO-8601. */
    confirmedAt: string;
}

export interface SelectorOverrideInput {
    plugin: string;
    udid: string;
    name: string;
    entry: SelectorEntry;
    note?: string;
    confirmedBy: string;
    /** Defaults to now. */
    confirmedAt?: string;
}

export function selectorOverridesPath(dataDirectory = process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data'): string {
    return path.resolve(dataDirectory, 'selector-overrides.json');
}

function validEntry(entry: unknown): entry is SelectorEntry {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const { text, id, exact } = entry as SelectorEntry;
    if (text !== undefined && typeof text !== 'string') return false;
    if (id !== undefined && typeof id !== 'string') return false;
    if (exact !== undefined && typeof exact !== 'boolean') return false;
    // A selector that matches on neither text nor id matches everything, which is worse than
    // having no override at all.
    return Boolean(text?.trim() || id?.trim());
}

/**
 * An override is written by an agent through an MCP tool, so it is checked here rather than
 * trusted: a selector list is what decides which pixel a phone gets tapped on.
 */
export function assertValidOverride(input: SelectorOverrideInput): void {
    for (const [field, value] of Object.entries({ plugin: input.plugin, udid: input.udid, name: input.name, confirmedBy: input.confirmedBy })) {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`Selector override ${field} is required`);
    }
    if (!/^[A-Za-z0-9_]{1,64}$/.test(input.name)) {
        throw new Error(`Selector name ${JSON.stringify(input.name)} must be a table key: letters, digits and underscores`);
    }
    if (!validEntry(input.entry)) throw new Error('A selector override entry needs a non-empty text or id');
}

function sameKey(a: { plugin: string; udid: string; name: string }, b: { plugin: string; udid: string; name: string }): boolean {
    return a.plugin === b.plugin && a.udid === b.udid && a.name === b.name;
}

export async function loadSelectorOverrides(filePath = selectorOverridesPath()): Promise<SelectorOverride[]> {
    let raw: string;
    try {
        raw = await readFile(filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${filePath} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${filePath} must contain an array of selector overrides`);
    // A single malformed row must not take the whole table (and every routine that reads it) down.
    return parsed.filter((row): row is SelectorOverride => {
        const candidate = row as SelectorOverride | null;
        return Boolean(candidate && typeof candidate === 'object' && !Array.isArray(candidate)
            && typeof candidate.plugin === 'string' && typeof candidate.udid === 'string'
            && typeof candidate.name === 'string' && validEntry(candidate.entry));
    });
}

/** Written whole, through a temporary file, so a reader never sees half a table. */
export async function saveSelectorOverrides(
    overrides: readonly SelectorOverride[], filePath = selectorOverridesPath(),
): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(overrides, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filePath);
}

/**
 * Upsert: one row per (plugin, udid, name), so calibrating the same control twice corrects the
 * answer rather than stacking two of them.
 */
export async function recordSelectorOverride(
    input: SelectorOverrideInput, filePath = selectorOverridesPath(),
): Promise<SelectorOverride> {
    assertValidOverride(input);
    const override: SelectorOverride = {
        plugin: input.plugin, udid: input.udid, name: input.name, entry: input.entry,
        ...(input.note ? { note: input.note } : {}),
        confirmedBy: input.confirmedBy,
        confirmedAt: input.confirmedAt ?? new Date().toISOString(),
    };
    const existing = await loadSelectorOverrides(filePath);
    await saveSelectorOverrides([...existing.filter((row) => !sameKey(row, override)), override], filePath);
    return override;
}

export async function removeSelectorOverride(
    key: { plugin: string; udid: string; name: string }, filePath = selectorOverridesPath(),
): Promise<boolean> {
    const existing = await loadSelectorOverrides(filePath);
    const kept = existing.filter((row) => !sameKey(row, key));
    if (kept.length === existing.length) return false;
    await saveSelectorOverrides(kept, filePath);
    return true;
}

/**
 * The override that applies to this phone: one recorded for the device itself beats one recorded
 * for the fleet, because a per-device answer was written by someone looking at that phone.
 */
export function overrideFor(
    overrides: readonly SelectorOverride[], plugin: string, udid: string, name: string,
): SelectorOverride | undefined {
    const matching = overrides.filter((row) => row.plugin === plugin && row.name === name);
    return matching.find((row) => row.udid === udid) ?? matching.find((row) => row.udid === ANY_DEVICE);
}

/**
 * A routine reads its table once per run, and a run is a child process that lives for minutes.
 * Caching the file per path keeps a table of a dozen selectors from being a dozen reads, and
 * `refreshSelectorOverrides` exists so the long-lived web process sees a freshly recorded one.
 */
const cache = new Map<string, Promise<SelectorOverride[]>>();

export function cachedSelectorOverrides(filePath = selectorOverridesPath()): Promise<SelectorOverride[]> {
    let pending = cache.get(filePath);
    if (!pending) {
        // A failed read must not be cached as the answer for the life of the process.
        pending = loadSelectorOverrides(filePath).catch((error) => { cache.delete(filePath); throw error; });
        cache.set(filePath, pending);
    }
    return pending;
}

export function refreshSelectorOverrides(filePath?: string): void {
    if (filePath === undefined) cache.clear();
    else cache.delete(filePath);
}

/** Where a resolved list came from, so an error message can name the selector it failed on. */
export interface NamedSelectorList extends SelectorEntryList {
    /** The table key, e.g. `captionField`. Carried on the array so call sites need no extra argument. */
    readonly selectorName?: string;
    /** True when an override was applied on top of the built-in alternates. */
    readonly overridden?: boolean;
}

function tag(list: SelectorEntry[], name: string, overridden: boolean): NamedSelectorList {
    return Object.defineProperties(list, {
        selectorName: { value: name, enumerable: false },
        overridden: { value: overridden, enumerable: false },
    }) as NamedSelectorList;
}

/**
 * The one helper every Android routine asks: what should I look for, for this control, on this
 * phone? A confirmed override goes first and the built-in guesses stay behind it, so an override
 * that is itself stale still falls through to the alternates rather than failing the run.
 */
export async function resolveSelectors(
    plugin: string, udid: string, name: string, builtIn: SelectorEntryList, filePath?: string,
): Promise<NamedSelectorList> {
    const override = overrideFor(await cachedSelectorOverrides(filePath), plugin, udid, name);
    if (!override) return tag([...builtIn], name, false);
    const rest = builtIn.filter((entry) => !sameEntry(entry, override.entry));
    return tag([override.entry, ...rest], name, true);
}

export function sameEntry(a: SelectorEntry, b: SelectorEntry): boolean {
    return a.id === b.id && a.text === b.text && Boolean(a.exact) === Boolean(b.exact);
}

function isEntryList(value: SelectorEntryList | readonly string[]): value is SelectorEntryList {
    return value.every((item) => typeof item === 'object');
}

/**
 * Resolve a whole table in one pass, which is how the routines use it: one call at the top of the
 * flow, then the rest of the flow reads the resolved table exactly as it read the built-in one.
 * Entries that are not selector lists (the picker's bare `resource-id` fragments) pass through.
 */
export async function resolveTable<T extends SelectorTable>(
    plugin: string, udid: string, table: T, filePath?: string,
): Promise<T> {
    const entries = await Promise.all(Object.entries(table).map(async ([name, value]) => {
        if (!Array.isArray(value) || !isEntryList(value as SelectorEntryList | readonly string[])) return [name, value] as const;
        return [name, await resolveSelectors(plugin, udid, name, value as SelectorEntryList, filePath)] as const;
    }));
    return Object.fromEntries(entries) as unknown as T;
}

/** The table key a resolved list came from, when it went through `resolveTable`. */
export function selectorNameOf(selectors: SelectorEntryList): string | undefined {
    return (selectors as NamedSelectorList).selectorName;
}
