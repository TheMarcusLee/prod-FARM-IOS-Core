/**
 * One sitting, from "is this account even awake" to the line that gets written back to its memory.
 *
 * Both doomscroll routines drive the same three calls — `beginSession`, `noteDecision` per video,
 * `finishSession` at the end — so the Android and iOS runs cannot drift apart in how they book a
 * like or when they decide a creator is worth following. The file layer stays in `memory.ts`; this
 * is pure bookkeeping over what that layer handed back, which keeps it testable without a disk.
 */

import type { ObservedVideo } from './observe.js';
import type { Persona } from './model.js';
import {
    applyDecision, applySearch, createSessionState, sessionPlan,
    type Rng, type SearchDecision, type SessionPlan, type SessionState, type VideoDecision,
} from './decide.js';
import {
    creatorLikeCounts, noteFollow, noteLike, recordSession, startSession,
    type PersonaMemory, type SessionRecord,
} from './memory.js';

export interface PersonaSession {
    persona: Persona;
    plan: SessionPlan;
    state: SessionState;
    memory: PersonaMemory;
    /** The index this session's likes are recorded against. */
    index: number;
    startedAt: string;
    /** How many times each interest matched, so the memory can say what the account is actually into. */
    matches: Map<string, number>;
    followedHere: string[];
}

/**
 * Opens a session: picks its length and budgets, and seeds the state from what the account
 * remembers. `plan.active` is false when the local clock is outside the persona's hours — the
 * caller should log `plan.reason` and not scroll.
 */
export function beginSession(persona: Persona, memory: PersonaMemory, rng: Rng, now: Date = new Date()): PersonaSession {
    const plan = sessionPlan(persona, rng, now);
    const index = startSession(memory);
    const state = createSessionState(plan, {
        creatorLikes: creatorLikeCounts(memory, persona.followRule.withinSessions, index),
        followed: memory.followed,
    });
    return { persona, plan, state, memory, index, startedAt: now.toISOString(), matches: new Map(), followedHere: [] };
}

/** Books one video's decision against both the session and the account's memory. */
export function noteDecision(session: PersonaSession, video: ObservedVideo, decision: VideoDecision): void {
    applyDecision(session.state, video, decision);
    for (const term of decision.terms) session.matches.set(term, (session.matches.get(term) ?? 0) + 1);
    if (decision.like && video.creator) noteLike(session.memory, video.creator, session.index);
    if (decision.follow && video.creator) {
        noteFollow(session.memory, video.creator, session.index);
        session.followedHere.push(video.creator);
    }
}

export function noteSearch(session: PersonaSession, decision: SearchDecision): void {
    applySearch(session.state, decision);
}

export interface SessionOutcome {
    minutes: number;
    ending: string;
}

/** Writes the session's line into the memory and hands it back, ready to be saved. */
export function finishSession(session: PersonaSession, outcome: SessionOutcome): PersonaMemory {
    const record: SessionRecord = {
        index: session.index,
        startedAt: session.startedAt,
        minutes: Math.max(0, Math.round(outcome.minutes)),
        videos: session.state.videos,
        likes: session.state.used.likes,
        saves: session.state.used.saves,
        follows: session.state.used.follows,
        searches: session.state.used.searches,
        matched: [...session.matches.entries()].sort((a, b) => b[1] - a[1]).map(([term]) => term).slice(0, 8),
        followedCreators: [...session.followedHere],
        ending: outcome.ending,
    };
    recordSession(session.memory, record);
    return session.memory;
}

/** The session's own summary, for the closing log line. */
export function describeSession(session: PersonaSession): string {
    const { used, budgets, videos } = session.state;
    return `${videos} videos · ${used.likes}/${budgets.likes} likes · ${used.saves}/${budgets.saves} saves · `
        + `${used.follows}/${budgets.follows} follows · ${used.searches}/${budgets.searches} searches`;
}

export type { SessionState, SessionPlan };
