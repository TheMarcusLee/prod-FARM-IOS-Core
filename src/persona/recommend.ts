/**
 * "Here is what I am promoting — who should be promoting it?"
 *
 * An operator with a product does not think in the hundred niches of `presets.ts`. They think in
 * a paragraph: *a SaaS note-taking app that transcribes meetings and syncs with Notion*. This file
 * turns that paragraph into a shortlist of presets, with the words that earned each place on it.
 *
 * It is deliberately a local, pure, boring ranker rather than a model call:
 *
 * - it answers in a millisecond, so the operator can retype the description and watch the list move;
 * - it cannot invent a preset that does not ship, because it only ever scores the ones that do;
 * - it is the fallback when the agent is not installed or comes back with nonsense, which means the
 *   feature never depends on a CLI being present.
 *
 * The scoring is arithmetic an operator can predict from the panel. Every word in the description
 * and the audience is lowercased, stripped of punctuation and crudely stemmed; every preset's own
 * words go through the same mill, so both sides of a comparison are shaped the same way. A hit on
 * a preset's label or one of its interests is worth three or four; its niche two; its category one
 * and a half; a word from its one-line description one. A preset whose *avoid* list matches the
 * text is pushed down hard — a product about crypto should not be handed to the account that
 * scrolls past the word.
 *
 * `extraInterests` is the other half of the answer: the words in the description that no chosen
 * preset covers. That is where the brand name, the product noun and the feature words live, and
 * they are exactly what a promoting account should have in its interests on top of the niche.
 */

import { PERSONA_PRESETS, type PersonaPreset } from './presets.js';
import type { NetworkId } from '../content/networks.js';

/* ---- Words ------------------------------------------------------------- */

/**
 * Words that say nothing about a niche. English filler, plus the handful of nouns every product
 * description contains ("app", "platform", "users") — those would otherwise match every preset
 * whose description happens to mention an app, and appear in every list of extra interests.
 */
const STOPWORDS = new Set([
    'a', 'an', 'and', 'the', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing',
    'have', 'has', 'had', 'having', 'will', 'would', 'can', 'could', 'should', 'may', 'might',
    'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'without', 'from', 'into', 'onto', 'over',
    'under', 'about', 'as', 'it', 'its', 'we', 'our', 'us', 'you', 'your', 'they', 'them', 'their',
    'my', 'me', 'i', 'he', 'she', 'his', 'her', 'who', 'what', 'which', 'when', 'where', 'how',
    'all', 'any', 'every', 'each', 'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only',
    'own', 'same', 'so', 'too', 'very', 'just', 'up', 'out', 'down', 'off', 'again', 'once',
    'app', 'apps', 'product', 'products', 'platform', 'software', 'service', 'services', 'tool',
    'tools', 'website', 'site', 'user', 'users', 'customer', 'customers', 'people', 'thing',
    'things', 'use', 'uses', 'using', 'used', 'make', 'makes', 'making', 'help', 'helps', 'new',
    'best', 'simple', 'easy', 'free', 'great', 'good', 'better', 'lets', 'let', 'get', 'gets',
    'built', 'build', 'building', 'company', 'startup', 'business', 'turn', 'turns', 'turning',
    'want', 'wants', 'need', 'needs', 'one', 'two', 'place', 'way', 'ways', 'want', 'anything',
]);

/**
 * Crude, symmetric stemming. It does not have to be right in a linguist's sense — it has to do the
 * *same* thing to "recipes" in a product description and "recipe" in a preset's interest list, so
 * the two meet in the middle. Both sides always come through here.
 */
export function stem(word: string): string {
    let value = word;
    if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
    if (value.length > 4 && /(ch|sh|ss|x|z|s)es$/.test(value)) return value.slice(0, -2);
    if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss') && !value.endsWith('us')) {
        value = value.slice(0, -1);
    }
    if (value.length > 5 && value.endsWith('ing')) {
        const base = value.slice(0, -3);
        // "running" → "runn" → "run": a doubled final consonant is the English spelling rule, not a letter.
        value = /([bdfglmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
    } else if (value.length > 5 && value.endsWith('ed')) {
        const base = value.slice(0, -2);
        value = /([bdfglmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
    }
    return value;
}

/** The words of a piece of text, lowercased, punctuation gone, hashes dropped. Order kept. */
export function words(text: string): string[] {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

/** The stems of a piece of text, in order. Stopwords are kept: the caller decides what to ignore. */
export function tokenise(text: string): string[] {
    return words(text).map(stem);
}

/* ---- Scoring ----------------------------------------------------------- */

/** How much a hit on each part of a preset is worth. Label and interests are what an operator means. */
const WEIGHTS = {
    label: 3,
    labelPhrase: 2,
    interest: 3,
    interestPhrase: 1,
    niche: 2,
    category: 1.5,
    description: 1,
    /** Per avoid term the text hits. Heavy, and it is a subtraction. */
    avoid: 3,
} as const;

export interface RankedPreset {
    id: string;
    label: string;
    category: string;
    /** Higher is a better fit. Zero and below never appear in a result. */
    score: number;
    /** The preset's own words that the description hit — what the panel prints as the reason. */
    matched: string[];
}

export interface RankOptions {
    /** How many presets to return. Six is what the panel shows. */
    limit?: number;
    /**
     * Score below which a preset is not worth offering. The default is two, which is one hit on a
     * niche: a single word from a preset's one-line description is a coincidence, not a fit.
     */
    minimumScore?: number;
}

/** True when every word of `term` appears in the text. A phrase has to be there whole. */
function hits(term: string, text: ReadonlySet<string>): boolean {
    const parts = tokenise(term).filter((part) => part.length > 1);
    if (!parts.length) return false;
    // A term that is nothing but filler ("the", "app") is not evidence of anything.
    if (parts.every((part) => STOPWORDS.has(part))) return false;
    return parts.every((part) => text.has(part));
}

function scorePreset(preset: PersonaPreset, text: ReadonlySet<string>): RankedPreset {
    const matched = new Map<string, number>();
    const credit = (term: string, weight: number): void => {
        const key = term.replace(/^#/, '').trim();
        if (!key) return;
        matched.set(key, Math.max(matched.get(key) ?? 0, weight));
    };

    for (const word of words(preset.label)) {
        if (hits(word, text)) credit(word, WEIGHTS.label);
    }
    if (words(preset.label).length > 1 && hits(preset.label, text)) credit(preset.label.toLowerCase(), WEIGHTS.label + WEIGHTS.labelPhrase);

    for (const interest of preset.persona.interests) {
        // A hashtag counts as its word: "#sourdough" in the preset is what "sourdough" in the
        // description is talking about, and an operator never types the hash.
        const plain = interest.replace(/^#/, '');
        if (!hits(plain, text)) continue;
        credit(plain, WEIGHTS.interest + (words(plain).length > 1 ? WEIGHTS.interestPhrase : 0));
    }

    for (const word of words(preset.persona.niche)) {
        if (hits(word, text)) credit(word, WEIGHTS.niche);
    }
    for (const word of words(preset.category)) {
        if (hits(word, text)) credit(word, WEIGHTS.category);
    }
    for (const word of words(preset.description)) {
        if (hits(word, text)) credit(word, WEIGHTS.description);
    }

    let score = 0;
    for (const weight of matched.values()) score += weight;

    // The veto, from the other direction: a product this preset's account scrolls past on sight.
    for (const term of preset.persona.avoid) {
        if (hits(term.replace(/^#/, ''), text)) score -= WEIGHTS.avoid;
    }

    // "note taking, note, taking" is one reason written three times: a word already inside a
    // phrase that matched adds nothing to the sentence under the chip.
    const ordered = [...matched.entries()]
        .sort(([leftTerm, left], [rightTerm, right]) => right - left || leftTerm.localeCompare(rightTerm))
        .map(([term]) => term);
    const phrases = ordered.filter((term) => term.includes(' '));
    const reason = ordered
        .filter((term) => term.includes(' ') || !phrases.some((phrase) => phrase.split(' ').includes(term)))
        .slice(0, 6);
    return {
        id: preset.id, label: preset.label, category: preset.category,
        score: Math.round(score * 10) / 10, matched: reason,
    };
}

/**
 * Every preset scored against one piece of text, best first. Ties keep library order, so the same
 * description always produces the same list.
 */
export function rankPresets(text: string, options: RankOptions = {}): RankedPreset[] {
    const limit = Math.max(1, Math.min(options.limit ?? 6, PERSONA_PRESETS.length));
    const minimum = options.minimumScore ?? 2;
    const set = new Set(tokenise(text));
    const order = new Map(PERSONA_PRESETS.map((preset, index) => [preset.id, index]));
    return PERSONA_PRESETS
        .map((preset) => scorePreset(preset, set))
        .filter((ranked) => ranked.score >= minimum)
        .sort((left, right) => right.score - left.score || (order.get(left.id)! - order.get(right.id)!))
        .slice(0, limit);
}

/* ---- Extra interests --------------------------------------------------- */

/** Interests are lowercase words and hashtags; anything else cannot be stored on a persona. */
const TERM_SHAPE = /^[a-z0-9][a-z0-9 .-]{1,39}$/;

export interface ExtraInterestOptions {
    limit?: number;
    /** Presets already chosen; anything they cover is not "extra". */
    presets?: readonly string[];
}

/**
 * The words the chosen presets do *not* already cover: the brand name, the product noun, the two
 * features nobody has a niche for. Bigrams first, because "meeting notes" is a better interest
 * than "meeting" and "notes" separately, and a word inside a chosen bigram is not repeated alone.
 */
export function extraInterests(text: string, options: ExtraInterestOptions = {}): string[] {
    const limit = Math.max(0, options.limit ?? 8);
    if (!limit) return [];

    const covered = new Set<string>();
    for (const id of options.presets ?? []) {
        const preset = PERSONA_PRESETS.find((entry) => entry.id === id);
        if (!preset) continue;
        for (const source of [preset.label, preset.description, preset.category, preset.persona.niche,
            ...preset.persona.interests, ...preset.persona.avoid]) {
            for (const token of tokenise(source.replace(/^#/, ''))) covered.add(token);
        }
    }

    const raw = words(text);
    const usable = (index: number): boolean => {
        const word = raw[index];
        if (!word || word.length < 3 || /^\d+$/.test(word)) return false;
        const token = stem(word);
        return !STOPWORDS.has(word) && !STOPWORDS.has(token) && !covered.has(token);
    };

    const counts = new Map<string, number>();
    const bump = (term: string): void => { counts.set(term, (counts.get(term) ?? 0) + 1); };
    for (let index = 0; index < raw.length; index += 1) {
        if (!usable(index)) continue;
        if (usable(index + 1)) bump(`${raw[index]} ${raw[index + 1]}`);
        bump(raw[index]!);
    }

    // Most-mentioned first, and first-mentioned when two words are mentioned as often.
    const seen = new Map(raw.map((word, index) => [word, index]));
    const ranked = [...counts.entries()]
        .filter(([term]) => TERM_SHAPE.test(term))
        .sort(([leftTerm, left], [rightTerm, right]) => {
            const pairs = rightTerm.includes(' ') ? 1 : 0;
            const otherPairs = leftTerm.includes(' ') ? 1 : 0;
            return right - left || otherPairs - pairs
                || (seen.get(leftTerm.split(' ')[0]!) ?? 0) - (seen.get(rightTerm.split(' ')[0]!) ?? 0);
        });

    const chosen: string[] = [];
    const spent = new Set<string>();
    for (const [term] of ranked) {
        if (chosen.length >= limit) break;
        const parts = term.split(' ');
        if (parts.some((part) => spent.has(part))) continue;
        chosen.push(term);
        for (const part of parts) spent.add(part);
    }
    return chosen;
}

/* ---- The whole answer -------------------------------------------------- */

export interface RecommendedPreset {
    id: string;
    label: string;
    category: string;
    /** One line about why this preset is on the list. */
    why: string;
    /** The ranker's score, absent on an agent's answer. */
    score?: number;
}

export interface Recommendation {
    /** Which half of the feature produced this: the local ranker, or the agent. */
    source: 'ranker' | 'agent';
    presets: RecommendedPreset[];
    /** Words to add to the promoting account's interests on top of the presets. */
    extraInterests: string[];
    /** Words the promoting account should scroll past. */
    avoid: string[];
    /** One sentence about who this is for, when the agent wrote one. */
    audienceSummary?: string;
    /** Networks worth promoting on, when the agent named any. */
    networks: NetworkId[];
    /** Why the answer came from where it did — set when the agent could not be used. */
    note?: string;
    createdAt: string;
}

export interface RecommendInput {
    description: string;
    audience?: string;
    name?: string;
}

/** The description, the audience and the name as one piece of text — what everything scores against. */
export function recommendationText(input: RecommendInput): string {
    return [input.name ?? '', input.description, input.audience ?? ''].filter(Boolean).join('\n');
}

function why(ranked: RankedPreset): string {
    return ranked.matched.length
        ? `Matched ${ranked.matched.slice(0, 4).join(', ')}`
        : 'Close to the words in the description';
}

/** The local recommendation: rank, then take the words the shortlist does not already cover. */
export function recommendLocally(input: RecommendInput, options: RankOptions = {}): Recommendation {
    const text = recommendationText(input);
    const ranked = rankPresets(text, options);
    return {
        source: 'ranker',
        presets: ranked.map((entry) => ({
            id: entry.id, label: entry.label, category: entry.category, why: why(entry), score: entry.score,
        })),
        extraInterests: extraInterests(text, { presets: ranked.map(({ id }) => id) }),
        avoid: [],
        networks: [],
        createdAt: new Date().toISOString(),
    };
}
