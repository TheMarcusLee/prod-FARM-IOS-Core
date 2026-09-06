/**
 * What one account is *interested in*.
 *
 * The old doomscroll model had three personalities — skimmer, casual, engaged — and every account
 * on the farm was one of them. That produces three identical people watching random videos at three
 * different speeds, which is not what a real account looks like. A persona says instead: this
 * handle is a home-gym person, it watches kettlebell clips right through, it scrolls past makeup in
 * two seconds, it likes maybe six things an hour, and it goes to bed at eleven.
 *
 * Personas live as one JSON document keyed by handle under `SCHEDULER_DATA_DIR/personas.json`,
 * written temp-file-then-rename like `devices.json`. No table, no migration: an operator can read
 * the file, diff it, and copy it between farms.
 *
 * Everything that reaches this file from a browser goes through `validatePersona`, which is an
 * explicit whitelist — unknown keys are dropped rather than stored, and every number is clamped to
 * a range that keeps a mistyped budget from turning an account into a like-bot.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** An inclusive `min`–`max` pair. Used for per-session budgets, watch bands and session length. */
export interface Range {
    min: number;
    max: number;
}

/** A local-clock window the account is awake in. `start` may be greater than `end` (overnight). */
export interface HourRange {
    /** Local hour, 0–23. */
    start: number;
    /** Local hour, 1–24. */
    end: number;
}

/** How many of each engagement the account is allowed in one session. */
export interface PersonaBudgets {
    likes: Range;
    saves: Range;
    follows: Range;
    searches: Range;
}

/** Seconds spent on a video, split by whether it matched the account's interests. */
export interface WatchBands {
    /** The long band: content that hit an interest. */
    match: Range;
    /** The short band: everything else. */
    other: Range;
}

/** "Like N videos from the same creator within M sessions, then follow them." */
export interface FollowRule {
    likes: number;
    withinSessions: number;
}

export interface Persona {
    /** The TikTok handle this persona belongs to, `@name`. */
    handle: string;
    /** A short human name for the niche — "home gym", "slow cooking". */
    niche: string;
    /** Keywords and hashtags it cares about, lowercase, `#` optional. */
    interests: string[];
    /** Keywords it scrolls past on sight. */
    avoid: string[];
    language: string;
    /** 0–1: how often it looks outside its niche. */
    curiosity: number;
    /** 0–1: overall willingness to like. */
    warmth: number;
    budgets: PersonaBudgets;
    /** Seconds. */
    watch: WatchBands;
    sessionMinutes: Range;
    activeHours: HourRange[];
    followRule: FollowRule;
}

export class PersonaError extends Error {}

/* ---- Handles ----------------------------------------------------------- */

export const HANDLE_PATTERN = /^@[A-Za-z0-9._]{1,64}$/;

/** Handles are keys in one JSON object and file names for the memory files, so they are checked. */
export function normaliseHandle(value: unknown): string {
    if (typeof value !== 'string') throw new PersonaError('Account handle must be text');
    const handle = value.trim().startsWith('@') ? value.trim() : `@${value.trim()}`;
    if (!HANDLE_PATTERN.test(handle)) {
        throw new PersonaError('Account handles may contain letters, numbers, periods and underscores');
    }
    return handle;
}

/* ---- Whitelists -------------------------------------------------------- */

/**
 * The languages a persona may declare. A closed list rather than a free string: this value is only
 * ever used to bias what the account watches, and an unbounded field is one more thing to escape.
 */
export const LANGUAGES = [
    'en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'tr', 'ru', 'ar', 'hi', 'id', 'th', 'vi',
    'ja', 'ko', 'zh',
] as const;

export type Language = (typeof LANGUAGES)[number];

const NICHE_PATTERN = /^[a-z0-9][a-z0-9 &'\-/]{0,39}$/;
/** An interest is one keyword or one hashtag: letters, digits, and the joining punctuation. */
const TERM_PATTERN = /^#?[a-z0-9][a-z0-9 ._-]{0,39}$/;

export const LIMITS = {
    terms: 40,
    activeHours: 6,
    /** Per-session engagement counts. A cap here is the last line against a runaway payload. */
    budget: { min: 0, max: 200 },
    /** Seconds on one video. */
    watchSeconds: { min: 1, max: 600 },
    sessionMinutes: { min: 1, max: 180 },
    followLikes: { min: 1, max: 20 },
    followSessions: { min: 1, max: 30 },
} as const;

/* ---- Validation -------------------------------------------------------- */

function object(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PersonaError(`${name} must be an object`);
    return value as Record<string, unknown>;
}

function unitInterval(value: unknown, name: string, fallback: number): number {
    if (value === undefined || value === null || value === '') return fallback;
    const number = typeof value === 'string' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1) {
        throw new PersonaError(`${name} must be between 0 and 1`);
    }
    return Math.round(number * 100) / 100;
}

function integer(value: unknown, name: string, min: number, max: number, fallback: number): number {
    if (value === undefined || value === null || value === '') return fallback;
    const number = typeof value === 'string' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
        throw new PersonaError(`${name} must be a whole number between ${min} and ${max}`);
    }
    return number;
}

function range(value: unknown, name: string, bounds: { min: number; max: number }, fallback: Range): Range {
    if (value === undefined || value === null) return { ...fallback };
    const input = object(value, name);
    const min = integer(input.min, `${name} minimum`, bounds.min, bounds.max, fallback.min);
    const max = integer(input.max, `${name} maximum`, bounds.min, bounds.max, fallback.max);
    if (min > max) throw new PersonaError(`${name} minimum must not be greater than its maximum`);
    return { min, max };
}

/**
 * Interests and avoid lists are the only free text a persona carries, and they are matched against
 * whatever TikTok put on screen — so they are lowercased, de-duplicated, and confined to a
 * character set that cannot be mistaken for markup.
 */
export function normaliseTerms(value: unknown, name: string): string[] {
    if (value === undefined || value === null) return [];
    const raw = typeof value === 'string'
        ? value.split(/[,\n]/)
        : Array.isArray(value) ? value : (() => { throw new PersonaError(`${name} must be a list`); })();
    const terms: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') throw new PersonaError(`${name} must be a list of words`);
        const term = entry.trim().toLowerCase().replace(/\s+/g, ' ');
        if (!term) continue;
        if (!TERM_PATTERN.test(term)) {
            throw new PersonaError(`"${entry.trim()}" is not a usable ${name} term — use letters, numbers, and an optional leading #`);
        }
        if (!terms.includes(term)) terms.push(term);
        if (terms.length > LIMITS.terms) throw new PersonaError(`${name} may hold at most ${LIMITS.terms} terms`);
    }
    return terms;
}

function hourRanges(value: unknown, fallback: HourRange[]): HourRange[] {
    if (value === undefined || value === null) return fallback.map((entry) => ({ ...entry }));
    // The editor posts "08:00-23:00, 07:00-09:00"; the API may post the structured form.
    const entries: unknown[] = typeof value === 'string'
        ? value.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
            const match = /^(\d{1,2})(?::\d{2})?\s*[-–]\s*(\d{1,2})(?::\d{2})?$/.exec(part);
            if (!match) throw new PersonaError(`"${part}" is not an hour range — write it as 08-23`);
            return { start: Number(match[1]), end: Number(match[2]) };
        })
        : Array.isArray(value) ? value : (() => { throw new PersonaError('Active hours must be a list'); })();
    if (entries.length > LIMITS.activeHours) throw new PersonaError(`At most ${LIMITS.activeHours} active-hour ranges`);
    const ranges = entries.map((entry) => {
        const input = object(entry, 'Active hours');
        const start = integer(input.start, 'Active hour start', 0, 23, 0);
        const end = integer(input.end, 'Active hour end', 1, 24, 24);
        if (start === end) throw new PersonaError('An active-hour range must not start and end at the same hour');
        return { start, end };
    });
    return ranges.length ? ranges : fallback.map((entry) => ({ ...entry }));
}

/**
 * Turns anything (a browser form body, a hand-edited `personas.json` entry) into a persona, or
 * throws with a sentence the operator can act on. Unknown keys are ignored, never stored.
 */
export function validatePersona(handleInput: unknown, value: unknown): Persona {
    const handle = normaliseHandle(handleInput);
    const input = object(value, 'Persona');
    const base = defaultPersona(handle);

    const niche = typeof input.niche === 'string' && input.niche.trim()
        ? input.niche.trim().toLowerCase().replace(/\s+/g, ' ')
        : base.niche;
    if (!NICHE_PATTERN.test(niche)) {
        throw new PersonaError('Niche must be a short phrase of letters, numbers, spaces or hyphens');
    }

    const language = input.language === undefined || input.language === null || input.language === ''
        ? base.language
        : String(input.language).trim().toLowerCase();
    if (!(LANGUAGES as readonly string[]).includes(language)) {
        throw new PersonaError(`Language must be one of ${LANGUAGES.join(', ')}`);
    }

    const budgetsInput = input.budgets === undefined ? {} : object(input.budgets, 'Budgets');
    const watchInput = input.watch === undefined ? {} : object(input.watch, 'Watch');
    const followInput = input.followRule === undefined ? {} : object(input.followRule, 'Follow rule');

    const watch: WatchBands = {
        match: range(watchInput.match, 'Matching watch time', LIMITS.watchSeconds, base.watch.match),
        other: range(watchInput.other, 'Other watch time', LIMITS.watchSeconds, base.watch.other),
    };

    const interests = input.interests === undefined ? base.interests : normaliseTerms(input.interests, 'interest');
    if (!interests.length) throw new PersonaError('A persona needs at least one interest');

    return {
        handle,
        niche,
        interests,
        avoid: input.avoid === undefined ? base.avoid : normaliseTerms(input.avoid, 'avoid'),
        language,
        curiosity: unitInterval(input.curiosity, 'Curiosity', base.curiosity),
        warmth: unitInterval(input.warmth, 'Warmth', base.warmth),
        budgets: {
            likes: range(budgetsInput.likes, 'Like budget', LIMITS.budget, base.budgets.likes),
            saves: range(budgetsInput.saves, 'Save budget', LIMITS.budget, base.budgets.saves),
            follows: range(budgetsInput.follows, 'Follow budget', LIMITS.budget, base.budgets.follows),
            searches: range(budgetsInput.searches, 'Search budget', LIMITS.budget, base.budgets.searches),
        },
        watch,
        sessionMinutes: range(input.sessionMinutes, 'Session length', LIMITS.sessionMinutes, base.sessionMinutes),
        activeHours: hourRanges(input.activeHours, base.activeHours),
        followRule: {
            likes: integer(followInput.likes, 'Follow rule likes', LIMITS.followLikes.min, LIMITS.followLikes.max, base.followRule.likes),
            withinSessions: integer(
                followInput.withinSessions, 'Follow rule sessions',
                LIMITS.followSessions.min, LIMITS.followSessions.max, base.followRule.withinSessions,
            ),
        },
    };
}

/* ---- Defaults ---------------------------------------------------------- */

/** A stable small integer from a handle, so an unconfigured account is still *a particular* person. */
function handleSeed(handle: string): number {
    let hash = 2166136261;
    for (const character of handle) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash);
}

/** The words in a handle, minus the noise every farm handle carries. */
const HANDLE_NOISE = new Set(['the', 'official', 'real', 'tt', 'tiktok', 'account', 'hq', 'daily', 'co', 'app']);

export function handleWords(handle: string): string[] {
    return handle.replace(/^@/, '')
        .split(/[^a-z0-9]+/i)
        .map((word) => word.toLowerCase().replace(/\d+$/, ''))
        .filter((word) => word.length > 2 && !HANDLE_NOISE.has(word));
}

/**
 * What an account behaves like before anybody has told it who it is. Derived from the handle, so
 * `@homegym.dan` starts out interested in home gyms and `@slowcook.ana` in slow cooking — and two
 * accounts with no persona are still measurably different people rather than the same coin flip.
 */
export function defaultPersona(handleInput: string): Persona {
    const handle = normaliseHandle(handleInput);
    const words = handleWords(handle);
    const seed = handleSeed(handle);
    const niche = words.length ? words.slice(0, 2).join(' ') : 'general feed';
    const interests = words.length ? [...words, ...words.map((word) => `#${word}`)].slice(0, 8) : ['fyp', 'foryou'];
    // Two dials spread across the fleet rather than every default account sharing one temperament.
    const warmth = 0.25 + ((seed % 41) / 100);
    const curiosity = 0.15 + ((Math.floor(seed / 41) % 36) / 100);
    return {
        handle,
        niche,
        interests,
        avoid: [],
        language: 'en',
        curiosity: Math.round(curiosity * 100) / 100,
        warmth: Math.round(warmth * 100) / 100,
        budgets: {
            likes: { min: 3, max: 9 },
            saves: { min: 0, max: 2 },
            follows: { min: 0, max: 1 },
            searches: { min: 0, max: 2 },
        },
        watch: { match: { min: 12, max: 34 }, other: { min: 2, max: 6 } },
        sessionMinutes: { min: 8, max: 22 },
        activeHours: [{ start: 8, end: 23 }],
        followRule: { likes: 3, withinSessions: 4 },
    };
}

/* ---- Store ------------------------------------------------------------- */

export type PersonaFile = Record<string, Persona>;

export function personaStorePath(directory?: string): string {
    const root = directory ?? path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
    return path.join(root, 'personas.json');
}

export async function loadPersonas(directory?: string): Promise<PersonaFile> {
    let raw: string;
    try {
        raw = await readFile(personaStorePath(directory), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new PersonaError(`personas.json contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const personas: PersonaFile = {};
    for (const [handle, value] of Object.entries(object(parsed, 'personas.json'))) {
        // One bad entry must not blank the whole file for every other account.
        try {
            const persona = validatePersona(handle, value);
            personas[persona.handle] = persona;
        } catch { /* skipped */ }
    }
    return personas;
}

/** The stored persona for a handle, or the handle-derived default. Never throws for a missing file. */
export async function personaFor(handle: string, directory?: string): Promise<Persona> {
    const personas = await loadPersonas(directory);
    return personas[normaliseHandle(handle)] ?? defaultPersona(handle);
}

/** True when this handle has a persona an operator actually configured. */
export async function hasPersona(handle: string, directory?: string): Promise<boolean> {
    return Object.hasOwn(await loadPersonas(directory), normaliseHandle(handle));
}

export async function savePersonas(personas: PersonaFile, directory?: string): Promise<void> {
    const target = personaStorePath(directory);
    await mkdir(path.dirname(target), { recursive: true });
    const ordered = Object.fromEntries(Object.entries(personas).sort(([a], [b]) => a.localeCompare(b)));
    const temporaryPath = `${target}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(ordered, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, target);
}

// Two editor saves for two accounts arriving together would otherwise each read the same file and
// the second write would drop the first — the same guard `devices.json` uses.
let storeMutation: Promise<unknown> = Promise.resolve();

export function mutatePersonas<T>(mutate: (personas: PersonaFile) => T | Promise<T>, directory?: string): Promise<T> {
    const run = storeMutation.then(async () => {
        const personas = await loadPersonas(directory);
        const result = await mutate(personas);
        await savePersonas(personas, directory);
        return result;
    });
    storeMutation = run.catch(() => undefined);
    return run;
}

/** Stores one persona, validating first. Returns what was written. */
export async function savePersona(handle: string, value: unknown, directory?: string): Promise<Persona> {
    const persona = validatePersona(handle, value);
    await mutatePersonas((personas) => { personas[persona.handle] = persona; }, directory);
    return persona;
}

export async function deletePersona(handle: string, directory?: string): Promise<boolean> {
    const key = normaliseHandle(handle);
    return mutatePersonas((personas) => {
        if (!Object.hasOwn(personas, key)) return false;
        delete personas[key];
        return true;
    }, directory);
}
