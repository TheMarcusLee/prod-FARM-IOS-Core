/**
 * One account built out of several presets.
 *
 * An operator promoting in a narrow space rarely wants a whole niche — they want the overlap of
 * two or three of them. "AI tools" plus "indie hacking" plus "productivity" is not any one preset;
 * it is a person who watches all three and whose feed is the intersection those interests pull in.
 *
 * A blend is deliberately boring arithmetic, because an operator has to be able to predict it from
 * the panel:
 *
 * - **interests** — every chosen preset's list, in order, de-duplicated. The first preset wins the
 *   room if the total runs past `LIMITS.terms`, which is why the picker keeps the chips in the
 *   order they were added.
 * - **avoid** — every chosen preset's avoid list, minus anything another chosen preset is actually
 *   interested in. Blending "crypto and web3" with "personal finance" must not produce an account
 *   that scrolls past the word `crypto`; the interest wins over the other preset's veto.
 * - **the dials** — curiosity, warmth, every budget, both watch bands and the session length are
 *   the mean across the presets, rounded. Two calm niches make a calm account; one loud one pulls
 *   it up a little rather than taking it over.
 * - **activeHours** — the union of the windows, overlaps merged, capped at `LIMITS.activeHours` by
 *   keeping the widest. Somebody in three niches is awake for the union of them, not the average.
 * - **followRule** — the most conservative of them: the highest like count, inside the fewest
 *   sessions. A blend must never follow faster than its most cautious ingredient.
 *
 * The result is a persona like any other: it goes out through `validatePersona`, and it records
 * the ids it was made from in `presets` so the editor can show the chips and blend again.
 */

import {
    LIMITS, NICHE_PATTERN, PersonaError, normaliseHandle, validatePersona,
    type HourRange, type Persona, type Range,
} from './model.js';
import { PERSONA_PRESETS, findPreset, type PersonaPreset } from './presets.js';

export interface BlendOptions {
    /** Overrides the language; without it, the first preset's (every shipped preset is `en`). */
    language?: string;
    /** Overrides the generated niche. */
    niche?: string;
}

/* ---- The pieces -------------------------------------------------------- */

function mean(values: number[]): number {
    return values.reduce((total, value) => total + value, 0) / values.length;
}

/** A 0–1 dial, to the two decimals `validatePersona` keeps. */
function meanUnit(values: number[]): number {
    return Math.round(mean(values) * 100) / 100;
}

/** A `{min,max}` pair, each end averaged and rounded, never inverted. */
function meanRange(ranges: Range[]): Range {
    const min = Math.round(mean(ranges.map((range) => range.min)));
    const max = Math.round(mean(ranges.map((range) => range.max)));
    return { min: Math.min(min, max), max: Math.max(min, max) };
}

/** The hours a range covers, as a set of local-clock hours. `22-03` wraps midnight. */
function hoursOf({ start, end }: HourRange): number[] {
    const hours: number[] = [];
    for (let hour = start; hours.length < 24; hour = (hour + 1) % 24) {
        if (hour === end % 24 && hours.length > 0) break;
        hours.push(hour);
        if (hour === (end - 1 + 24) % 24) break;
    }
    return hours;
}

/**
 * Every window the blend is awake in: the hours are unioned on a 24-hour clock, contiguous runs
 * become ranges again (so `08-12` and `11-15` come back as one `08-15`), and if there are more
 * runs than a persona may hold, the widest survive.
 */
export function mergeHourRanges(ranges: readonly HourRange[]): HourRange[] {
    const awake = new Set<number>();
    for (const range of ranges) for (const hour of hoursOf(range)) awake.add(hour);
    if (awake.size === 0) return [{ start: 8, end: 23 }];
    if (awake.size === 24) return [{ start: 0, end: 24 }];

    // Walk from an hour the account is asleep in, so a run that wraps midnight is one run.
    let origin = 0;
    while (awake.has(origin)) origin += 1;
    const merged: HourRange[] = [];
    let run: number[] = [];
    for (let step = 0; step <= 24; step += 1) {
        const hour = (origin + step) % 24;
        if (step < 24 && awake.has(hour)) {
            run.push(hour);
            continue;
        }
        if (run.length) {
            const start = run[0]!;
            const last = run[run.length - 1]!;
            merged.push({ start, end: last === 23 ? 24 : last + 1 });
            run = [];
        }
    }
    const widest = [...merged]
        .sort((a, b) => hoursOf(b).length - hoursOf(a).length || a.start - b.start)
        .slice(0, LIMITS.activeHours);
    return widest.sort((a, b) => a.start - b.start);
}

/**
 * "ai tools · indie hacking · productivity", or the longest prefix of it that still fits the forty
 * characters a niche gets — "ai tools · indie hacking · 2 more".
 */
export function blendNiche(labels: readonly string[]): string {
    const parts = labels.map((label) => label.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean);
    if (!parts.length) return 'blended feed';
    const fits = (value: string) => NICHE_PATTERN.test(value);

    const full = parts.join(' · ');
    if (fits(full)) return full;
    for (let keep = parts.length - 1; keep >= 1; keep -= 1) {
        const shortened = `${parts.slice(0, keep).join(' · ')} · ${parts.length - keep} more`;
        if (fits(shortened)) return shortened;
    }
    // A single label nobody could shorten further: strip it back to what a niche may hold.
    const trimmed = parts[0]!.replace(/[^a-z0-9 &'\-/·]/g, '').slice(0, 40).trim();
    return fits(trimmed) ? trimmed : 'blended feed';
}

/* ---- The blend --------------------------------------------------------- */

/** The chosen presets, in the order given, or a sentence naming the one that does not exist. */
export function resolvePresets(ids: unknown): PersonaPreset[] {
    if (!Array.isArray(ids)) {
        if (typeof ids === 'string') return resolvePresets(ids.split(','));
        throw new PersonaError('Choose at least one preset');
    }
    const chosen: PersonaPreset[] = [];
    for (const id of ids) {
        const trimmed = typeof id === 'string' ? id.trim() : id;
        if (trimmed === '') continue;
        const preset = findPreset(trimmed);
        if (!preset) throw new PersonaError(`"${String(id)}" is not one of the presets`);
        if (!chosen.some((entry) => entry.id === preset.id)) chosen.push(preset);
    }
    if (!chosen.length) throw new PersonaError('Choose at least one preset');
    if (chosen.length > LIMITS.presets) {
        throw new PersonaError(`A persona may be blended from at most ${LIMITS.presets} presets`);
    }
    return chosen;
}

/**
 * One persona from several presets. A single id is the same call and gives back what `applyPreset`
 * would, so the editor has one code path whether the operator picked one chip or four.
 */
export function blendPresets(handle: string, ids: unknown, options: BlendOptions = {}): Persona {
    const chosen = resolvePresets(ids);
    const bodies = chosen.map(({ persona }) => persona);

    const interests: string[] = [];
    for (const body of bodies) {
        for (const interest of body.interests) {
            if (interests.length >= LIMITS.terms) break;
            if (!interests.includes(interest)) interests.push(interest);
        }
    }

    // An interest anywhere in the blend outranks another preset's veto on the same word.
    const wanted = new Set(interests);
    const avoid: string[] = [];
    for (const body of bodies) {
        for (const term of body.avoid) {
            if (avoid.length >= LIMITS.terms) break;
            if (wanted.has(term) || avoid.includes(term)) continue;
            avoid.push(term);
        }
    }

    const blended = {
        niche: options.niche ?? blendNiche(chosen.map(({ label }) => label)),
        interests,
        avoid,
        language: options.language ?? bodies[0]!.language,
        curiosity: meanUnit(bodies.map((body) => body.curiosity)),
        warmth: meanUnit(bodies.map((body) => body.warmth)),
        budgets: {
            likes: meanRange(bodies.map((body) => body.budgets.likes)),
            saves: meanRange(bodies.map((body) => body.budgets.saves)),
            follows: meanRange(bodies.map((body) => body.budgets.follows)),
            searches: meanRange(bodies.map((body) => body.budgets.searches)),
        },
        watch: {
            match: meanRange(bodies.map((body) => body.watch.match)),
            other: meanRange(bodies.map((body) => body.watch.other)),
        },
        sessionMinutes: meanRange(bodies.map((body) => body.sessionMinutes)),
        activeHours: mergeHourRanges(bodies.flatMap((body) => body.activeHours)),
        followRule: {
            likes: Math.max(...bodies.map((body) => body.followRule.likes)),
            withinSessions: Math.min(...bodies.map((body) => body.followRule.withinSessions)),
        },
        presets: chosen.map(({ id }) => id),
    };

    return validatePersona(normaliseHandle(handle), blended as unknown as Record<string, unknown>);
}

/** Labels for a set of ids, for a panel that wants to name what it was built from. */
export function presetLabels(ids: readonly string[]): string[] {
    return ids.map((id) => PERSONA_PRESETS.find((preset) => preset.id === id)?.label ?? id);
}
