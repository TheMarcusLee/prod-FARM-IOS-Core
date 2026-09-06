/**
 * The decision layer: given a persona, the video on screen, and what the session has spent so far,
 * what does this account do?
 *
 * Everything here is pure and every random draw goes through an injected `rng`, so a decision is
 * reproducible from a seed and the distributions can be asserted over thousands of draws rather
 * than hoped at. The routines own the phone; this file owns the judgement, and the two only meet
 * through `VideoDecision`.
 *
 * One rule shapes the whole file: **a video costs a fixed number of draws whatever is decided**.
 * `decideForVideo` pulls its six values up front. A branch that consumed draws conditionally would
 * make every downstream decision depend on the outcome of the last one, and a seeded test would
 * stop meaning anything.
 */

import type { ObservedVideo } from './observe.js';
import type { Persona, Range } from './model.js';

export type Rng = () => number;

export interface SessionBudgets {
    likes: number;
    saves: number;
    follows: number;
    searches: number;
}

/** What one sitting looks like, decided once at the start of the run. */
export interface SessionPlan {
    /** False when the local clock is outside the persona's active hours; the run should not start. */
    active: boolean;
    /** Plain words for the log: "outside its active hours (03:00, awake 08-23)". */
    reason: string;
    minutes: number;
    budgets: SessionBudgets;
}

export interface SessionState {
    budgets: SessionBudgets;
    used: SessionBudgets;
    videos: number;
    /**
     * Likes this account has given each creator inside the follow rule's window — carried in from
     * the memory file plus whatever this session has added. This is what makes "follow creators it
     * keeps enjoying" mean anything across runs.
     */
    creatorLikes: Record<string, number>;
    /** Creators already followed, so the routine never taps Follow on somebody it follows. */
    followed: string[];
    /** Videos since the last search, so searches do not cluster at the top of a session. */
    sinceSearch: number;
    /** Interests already searched this session. */
    searched: string[];
}

export interface VideoDecision {
    watchMs: number;
    like: boolean;
    save: boolean;
    follow: boolean;
    /** One sentence in plain words: "Liked · #homegym matched, 3 of 6 likes used". */
    reason: string;
    /** True when the video hit the persona's interests. */
    matched: boolean;
    /** Which interests hit, for the log line and the memory file. */
    terms: string[];
    /** True when the persona lingered on something outside its niche. */
    curious: boolean;
    /** True when the watch time was stretched to re-watch a video it liked. */
    looped: boolean;
}

export interface SearchDecision {
    term: string;
    reason: string;
}

/* ---- Small pure helpers ------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** A value inside an inclusive range, from one draw. */
export function within({ min, max }: Range, draw: number): number {
    return min + (max - min) * clamp(draw, 0, 1);
}

function wholeWithin(range: Range, draw: number): number {
    return Math.round(within(range, draw));
}

/* ---- Active hours ------------------------------------------------------ */

/** True when `at`'s local hour falls in any of the persona's ranges. A range may wrap midnight. */
export function isActiveHour(persona: Persona, at: Date): boolean {
    if (!persona.activeHours.length) return true;
    const hour = at.getHours() + at.getMinutes() / 60;
    return persona.activeHours.some(({ start, end }) =>
        (start < end ? hour >= start && hour < end : hour >= start || hour < end));
}

function hoursSentence(persona: Persona): string {
    return persona.activeHours.map(({ start, end }) =>
        `${String(start).padStart(2, '0')}-${String(end).padStart(2, '0')}`).join(', ') || 'any hour';
}

/**
 * How long this sitting lasts and what it is allowed to spend. Five draws, always in this order:
 * length, likes, saves, follows, searches.
 */
export function sessionPlan(persona: Persona, rng: Rng, now: Date = new Date()): SessionPlan {
    const minutes = wholeWithin(persona.sessionMinutes, rng());
    const budgets: SessionBudgets = {
        likes: wholeWithin(persona.budgets.likes, rng()),
        saves: wholeWithin(persona.budgets.saves, rng()),
        follows: wholeWithin(persona.budgets.follows, rng()),
        searches: wholeWithin(persona.budgets.searches, rng()),
    };
    const active = isActiveHour(persona, now);
    const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const reason = active
        ? `${persona.niche} · ${minutes} min, up to ${budgets.likes} likes, ${budgets.saves} saves, ${budgets.follows} follows, ${budgets.searches} searches`
        : `outside its active hours (${clock} local, awake ${hoursSentence(persona)})`;
    return { active, reason, minutes, budgets };
}

/** A fresh state for a plan, seeded with what the memory file remembers about this account. */
export function createSessionState(
    plan: SessionPlan,
    memory: { creatorLikes?: Record<string, number>; followed?: readonly string[] } = {},
): SessionState {
    return {
        budgets: { ...plan.budgets },
        used: { likes: 0, saves: 0, follows: 0, searches: 0 },
        videos: 0,
        creatorLikes: { ...(memory.creatorLikes ?? {}) },
        followed: [...(memory.followed ?? [])],
        sinceSearch: 0,
        searched: [],
    };
}

/* ---- Interest matching ------------------------------------------------- */

export interface InterestMatch {
    matched: boolean;
    /** 0–1. Rises with the number of interests that hit and with how well the account knows the creator. */
    score: number;
    /** The interests that hit, as the persona wrote them. */
    terms: string[];
    /** The avoid terms that hit; any of these vetoes engagement outright. */
    avoided: string[];
    /** True when the creator is one this account has liked before. */
    familiar: boolean;
}

/** Everything legible about the video, lowercased, as one string to search. */
function haystack(video: ObservedVideo): string {
    return [video.caption, video.sound, video.creator, ...video.hashtags.map((tag) => `#${tag}`), ...video.texts]
        .join(' ')
        .toLowerCase();
}

/** A term hits when it appears as a word (or hashtag) rather than inside a longer one. */
function hits(text: string, term: string): boolean {
    const needle = term.replace(/^#/, '').trim();
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    return new RegExp(`(^|[^a-z0-9])#?${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

/**
 * Keyword and hashtag overlap, plus creator memory. Three hits is a strong match; one hit on a
 * creator the account already likes is a strong match too, which is how a feed narrows over time.
 */
export function interestMatch(persona: Persona, video: ObservedVideo, state?: SessionState): InterestMatch {
    const text = haystack(video);
    const terms = persona.interests.filter((interest) => hits(text, interest));
    const avoided = persona.avoid.filter((term) => hits(text, term));
    const priorLikes = video.creator ? state?.creatorLikes[video.creator] ?? 0 : 0;
    const familiar = priorLikes > 0;
    if (avoided.length) return { matched: false, score: 0, terms, avoided, familiar };
    const keywordScore = clamp(terms.length / 3, 0, 1);
    const creatorScore = clamp(priorLikes / 3, 0, 0.5);
    const score = clamp(keywordScore + creatorScore, 0, 1);
    return { matched: terms.length > 0 || (familiar && score >= 0.3), score, terms, avoided, familiar };
}

/* ---- The decision ------------------------------------------------------ */

/** Remaining budget as a 0–1 fraction; a nearly spent budget makes the account choosier. */
function remaining(state: SessionState, key: keyof SessionBudgets): number {
    const budget = state.budgets[key];
    if (budget <= 0) return 0;
    return clamp((budget - state.used[key]) / budget, 0, 1);
}

function seconds(ms: number): number {
    return Math.round(ms / 1000);
}

/**
 * What this account does with the video in front of it.
 *
 * Six draws, always in this order: watch, like, save, follow, curiosity, loop.
 */
export function decideForVideo(
    persona: Persona,
    video: ObservedVideo,
    state: SessionState,
    rng: Rng,
): VideoDecision {
    const draws = { watch: rng(), like: rng(), save: rng(), follow: rng(), curiosity: rng(), loop: rng() };
    const match = interestMatch(persona, video, state);

    // A video that hits the avoid list is scrolled past at the bottom of the short band, and
    // nothing is engaged with — whatever else is on screen.
    if (match.avoided.length) {
        const watchMs = Math.round(persona.watch.other.min * 1000);
        return {
            watchMs, like: false, save: false, follow: false, matched: false,
            terms: [], curious: false, looped: false,
            reason: `Scrolled past · "${match.avoided[0]}" is on its avoid list, watched ${seconds(watchMs)}s`,
        };
    }

    // Non-matching content gets the short band, with a curiosity-sized chance to linger into the
    // long one — the moment an account discovers something next to its niche.
    const curious = !match.matched && draws.curiosity < persona.curiosity * 0.4;
    const band: Range = match.matched
        ? persona.watch.match
        : curious
            ? { min: persona.watch.other.max, max: Math.max(persona.watch.other.max, persona.watch.match.min) }
            : persona.watch.other;
    let watchMs = Math.round(within(band, draws.watch) * 1000);

    const likeChance = match.matched
        ? clamp(persona.warmth * (0.35 + 0.65 * match.score) * (0.4 + 0.6 * remaining(state, 'likes')), 0, 0.95)
        // Outside the niche an account still likes the occasional thing, but rarely.
        : clamp(persona.warmth * persona.curiosity * 0.12 * remaining(state, 'likes'), 0, 0.2);
    const like = state.used.likes < state.budgets.likes && draws.like < likeChance;

    // Saves are for things worth coming back to, so they only ever happen on a match and at a
    // fraction of the like rate.
    const saveChance = match.matched ? likeChance * 0.28 : 0;
    const save = state.used.saves < state.budgets.saves && draws.save < saveChance;

    // Re-watching is a real signal and a real behaviour: sometimes a match plays twice.
    const looped = match.matched && draws.loop < 0.1 + 0.2 * match.score;
    if (looped) watchMs = Math.round(watchMs * 1.8);

    const creatorLikes = (video.creator ? state.creatorLikes[video.creator] ?? 0 : 0) + (like ? 1 : 0);
    const followEligible = Boolean(video.creator)
        && match.matched
        && !state.followed.includes(video.creator)
        && state.used.follows < state.budgets.follows
        && creatorLikes >= persona.followRule.likes;
    // Even when the rule is satisfied, a real person does not follow the instant the counter trips.
    const follow = followEligible && draws.follow < 0.6;

    return {
        watchMs, like, save, follow, matched: match.matched, terms: match.terms, curious, looped,
        reason: describeDecision({ persona, video, state, match, like, save, follow, watchMs, curious, looped }),
    };
}

interface DescribeInput {
    persona: Persona;
    video: ObservedVideo;
    state: SessionState;
    match: InterestMatch;
    like: boolean;
    save: boolean;
    follow: boolean;
    watchMs: number;
    curious: boolean;
    looped: boolean;
}

/**
 * The log line. The operator reading a run's output should be able to tell whether the account is
 * behaving like the person they described, without opening the code.
 */
export function describeDecision(input: DescribeInput): string {
    const { persona, video, state, match, like, save, follow, watchMs } = input;
    const verbs: string[] = [];
    if (like) verbs.push('Liked');
    if (save) verbs.push('Saved');
    if (follow) verbs.push('Followed');
    const verb = verbs.length ? verbs.join(' and ') : input.curious ? 'Lingered' : match.matched ? 'Watched' : 'Scrolled past';

    const why = match.terms.length
        ? `${match.terms.slice(0, 2).map((term) => (term.startsWith('#') ? term : `"${term}"`)).join(' and ')} matched`
        : match.familiar && match.matched
            ? `${video.creator || 'that creator'} is one it keeps enjoying`
            : input.curious
                ? `nothing matched ${persona.niche}, but it looked anyway`
                : `nothing matched ${persona.niche}`;

    const parts = [why, `watched ${seconds(watchMs)}s${input.looped ? ' (twice)' : ''}`];
    if (like) parts.push(`${state.used.likes + 1} of ${state.budgets.likes} likes used`);
    if (save) parts.push(`${state.used.saves + 1} of ${state.budgets.saves} saves used`);
    if (follow) {
        parts.push(`${(state.creatorLikes[video.creator] ?? 0) + (like ? 1 : 0)} likes for ${video.creator} in the last ${persona.followRule.withinSessions} sessions`);
    }
    return `${verb} · ${parts.join(', ')}`;
}

/** Books a decision against the session. The routines call this after the taps have happened. */
export function applyDecision(state: SessionState, video: ObservedVideo, decision: VideoDecision): void {
    state.videos += 1;
    state.sinceSearch += 1;
    if (decision.like) {
        state.used.likes += 1;
        if (video.creator) state.creatorLikes[video.creator] = (state.creatorLikes[video.creator] ?? 0) + 1;
    }
    if (decision.save) state.used.saves += 1;
    if (decision.follow) {
        state.used.follows += 1;
        if (video.creator && !state.followed.includes(video.creator)) state.followed.push(video.creator);
    }
}

/* ---- Searching --------------------------------------------------------- */

/** Videos an account watches before it would plausibly go looking for something itself. */
const SEARCH_COOLDOWN_VIDEOS = 6;

/**
 * Occasionally, an account stops scrolling and searches its own niche. Two draws, always: the gate,
 * and which interest. Returns undefined when the budget is spent, the cooldown has not passed, or
 * the draw simply said no.
 */
export function decideSearch(persona: Persona, state: SessionState, rng: Rng): SearchDecision | undefined {
    const gate = rng();
    const pick = rng();
    if (state.used.searches >= state.budgets.searches) return undefined;
    if (state.sinceSearch < SEARCH_COOLDOWN_VIDEOS) return undefined;
    // Spread the remaining searches over the videos a session plausibly still has left.
    if (gate >= 0.06 + 0.06 * persona.curiosity) return undefined;
    const unused = persona.interests.filter((interest) => !state.searched.includes(interest));
    const pool = unused.length ? unused : persona.interests;
    if (!pool.length) return undefined;
    const term = pool[Math.min(pool.length - 1, Math.floor(clamp(pick, 0, 0.999999) * pool.length))]!;
    return {
        term,
        reason: `Searched · "${term}", ${state.used.searches + 1} of ${state.budgets.searches} searches used`,
    };
}

/** Books a search against the session. */
export function applySearch(state: SessionState, decision: SearchDecision): void {
    state.used.searches += 1;
    state.sinceSearch = 0;
    if (!state.searched.includes(decision.term)) state.searched.push(decision.term);
}
