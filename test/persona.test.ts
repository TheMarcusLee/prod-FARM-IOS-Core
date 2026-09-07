import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inject } from './support.js';
import { createApp } from '../src/api/app.js';
import { defaultDashboardTheme } from '../src/dashboard-theme.js';
import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import type { DeviceDriver, MediaFile, Point, Rect, TimedPoint, UiNode } from '../src/drivers/types.js';
import type { OcrWord } from '../src/drivers/verify.js';
import {
    LANGUAGES, LIMITS, NICHE_PATTERN, defaultPersona, deletePersona, loadPersonas, personaFor, savePersona,
    validatePersona, type Persona,
} from '../src/persona/model.js';
import { videoFromTexts, videoFromTree, videoFromWords, findWordBounds, readVideo } from '../src/persona/observe.js';
import {
    applyDecision, createSessionState, decideForVideo, decideSearch, interestMatch, isActiveHour, sessionPlan,
    type SessionState,
} from '../src/persona/decide.js';
import {
    creatorLikeCounts, noteFollow, noteLike, readMemory, recordSession, startSession, summariseMemory, writeMemory,
    emptyMemory,
} from '../src/persona/memory.js';
import { beginSession, finishSession, noteDecision } from '../src/persona/session.js';
import {
    PERSONA_PRESETS, PRESET_CATEGORIES, applyPreset, findPreset, presetsByCategory,
} from '../src/persona/presets.js';
import { blendNiche, blendPresets, mergeHourRanges } from '../src/persona/blend.js';
import { personaFromForm } from '../src/api/routes/personas.js';
import { doomscrollOnAndroid } from '../src/tiktok/android/doomscroll.js';
import { createTikTokPlugin } from '../src/tiktok-plugin.js';
import type { TaskDefinition } from '../src/plugin.js';

/** A seeded PRNG so a "distribution" assertion means the same thing on every machine. */
function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const GYM: Persona = {
    ...defaultPersona('@homegym.dan'),
    niche: 'home gym',
    interests: ['homegym', 'kettlebell', '#garagegym'],
    avoid: ['makeup'],
    warmth: 0.8,
    curiosity: 0.3,
    budgets: { likes: { min: 6, max: 6 }, saves: { min: 2, max: 2 }, follows: { min: 1, max: 1 }, searches: { min: 1, max: 1 } },
    watch: { match: { min: 12, max: 30 }, other: { min: 2, max: 5 } },
    sessionMinutes: { min: 10, max: 20 },
    activeHours: [{ start: 8, end: 23 }],
    followRule: { likes: 3, withinSessions: 4 },
};

const MATCHING = videoFromTexts(['@liftdaily', 'kettlebell swings in the garage #homegym #garagegym', 'original sound - liftdaily']);
const OTHER = videoFromTexts(['@glosslab', 'three lipstick shades for autumn', 'original sound - glosslab']);
const AVOIDED = videoFromTexts(['@glosslab', 'a full makeup routine, start to finish']);

function stateFor(persona: Persona, rng = seeded(1), seed: Partial<SessionState> = {}): SessionState {
    return { ...createSessionState(sessionPlan(persona, rng, new Date(2026, 0, 5, 12, 0))), ...seed };
}

/* ---- The model --------------------------------------------------------- */

test('a persona is derived from the handle when nobody has set one up', () => {
    const persona = defaultPersona('@homegym.dan');
    assert.equal(persona.handle, '@homegym.dan');
    assert.equal(persona.niche, 'homegym dan');
    assert.ok(persona.interests.includes('homegym'));
    assert.ok(persona.interests.includes('#homegym'));
    assert.ok(persona.warmth > 0 && persona.warmth < 1);
    // Two different handles are two different people, and the same handle is stable.
    assert.deepEqual(defaultPersona('@homegym.dan'), persona);
    assert.notEqual(defaultPersona('@slowcook.ana').warmth + defaultPersona('@slowcook.ana').curiosity,
        persona.warmth + persona.curiosity);
    // A handle with nothing to go on still gets a workable persona rather than an empty one.
    assert.ok(defaultPersona('@x1').interests.length > 0);
});

test('validation whitelists the fields, normalises the terms and refuses nonsense', () => {
    const persona = validatePersona('homegym.dan', {
        niche: '  Home  Gym ',
        interests: 'Kettlebell, #HomeGym , kettlebell',
        avoid: ['MakeUp'],
        language: 'es',
        warmth: '0.75',
        curiosity: 0.2,
        budgets: { likes: { min: 2, max: 8 } },
        watch: { match: { min: 15, max: 40 } },
        sessionMinutes: { min: 5, max: 10 },
        activeHours: '08-12, 18-23',
        followRule: { likes: 4, withinSessions: 6 },
        // Not in the whitelist; must not survive.
        somethingElse: 'ignored',
    });
    assert.equal(persona.handle, '@homegym.dan');
    assert.equal(persona.niche, 'home gym');
    assert.deepEqual(persona.interests, ['kettlebell', '#homegym']);
    assert.deepEqual(persona.avoid, ['makeup']);
    assert.equal(persona.language, 'es');
    assert.equal(persona.warmth, 0.75);
    assert.deepEqual(persona.budgets.likes, { min: 2, max: 8 });
    assert.deepEqual(persona.activeHours, [{ start: 8, end: 12 }, { start: 18, end: 23 }]);
    assert.equal((persona as unknown as Record<string, unknown>).somethingElse, undefined);
    // Unset fields fall back to the handle-derived default rather than to nothing.
    assert.deepEqual(persona.budgets.saves, defaultPersona('@homegym.dan').budgets.saves);

    assert.throws(() => validatePersona('@a', { interests: 'gym', warmth: 4 }), /between 0 and 1/);
    assert.throws(() => validatePersona('@a', { interests: 'gym', budgets: { likes: { min: 9, max: 2 } } }), /not be greater/);
    assert.throws(() => validatePersona('@a', { interests: 'gym', language: 'klingon' }), /Language must be/);
    assert.throws(() => validatePersona('@a', { interests: '<script>alert(1)</script>' }), /not a usable interest term/);
    assert.throws(() => validatePersona('@a', { interests: [] }), /at least one interest/);
    assert.throws(() => validatePersona('bad handle!', { interests: 'gym' }), /letters, numbers/);
    assert.throws(() => validatePersona('@a', { interests: 'gym', activeHours: 'always' }), /not an hour range/);
    assert.ok(LANGUAGES.includes('en'));
});

test('personas round-trip through the store, and a corrupt entry does not blank the file', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'persona-store-'));
    context.after(() => rm(directory, { recursive: true, force: true }));

    await savePersona('@homegym.dan', { interests: 'kettlebell', niche: 'home gym' }, directory);
    await savePersona('@slowcook.ana', { interests: 'braising' }, directory);
    const stored = await loadPersonas(directory);
    assert.deepEqual(Object.keys(stored).sort(), ['@homegym.dan', '@slowcook.ana']);
    assert.equal((await personaFor('@homegym.dan', directory)).niche, 'home gym');
    // An unknown handle is the default, not an error.
    assert.equal((await personaFor('@nobody', directory)).handle, '@nobody');

    const raw = JSON.parse(await readFile(path.join(directory, 'personas.json'), 'utf8')) as Record<string, unknown>;
    assert.ok(raw['@homegym.dan']);

    assert.equal(await deletePersona('@homegym.dan', directory), true);
    assert.equal(await deletePersona('@homegym.dan', directory), false);
    assert.deepEqual(Object.keys(await loadPersonas(directory)), ['@slowcook.ana']);
});

/* ---- Observing --------------------------------------------------------- */

function node(partial: Partial<UiNode>): UiNode {
    return {
        id: '', type: 'android.widget.TextView', text: '', description: '',
        bounds: { left: 0, top: 0, right: 100, bottom: 40 },
        clickable: false, enabled: true, children: [], ...partial,
    };
}

test('a video is read out of an Android tree, ids first', () => {
    const root = node({
        type: 'FrameLayout',
        children: [
            node({ id: 'com.zhiliaoapp.musically:id/title_author', text: 'liftdaily' }),
            node({ id: 'com.zhiliaoapp.musically:id/desc', text: 'kettlebell swings in the garage #homegym #garagegym' }),
            node({ id: 'com.zhiliaoapp.musically:id/music_title', text: 'original sound - liftdaily' }),
            node({ description: 'Like' }),
            node({ text: 'Home' }),
        ],
    });
    const video = videoFromTree(root);
    assert.equal(video.creator, '@liftdaily');
    assert.match(video.caption, /kettlebell swings/);
    assert.deepEqual(video.hashtags, ['homegym', 'garagegym']);
    assert.match(video.sound, /original sound/);
    assert.ok(video.texts.includes('Home'));
});

test('a partial tree still reads, and an empty one is not an error', async () => {
    const bare = videoFromTree(node({ children: [node({ text: '@liftdaily' })] }));
    assert.equal(bare.creator, '@liftdaily');
    assert.equal(bare.caption, '');
    assert.deepEqual(bare.hashtags, []);

    const empty = await readVideo({ uiTree: async () => node({}) });
    assert.deepEqual(empty, { creator: '', caption: '', hashtags: [], sound: '', texts: [] });

    // A driver that throws must not take the run down with it.
    const broken = await readVideo({ uiTree: async () => { throw new Error('no tree'); } });
    assert.equal(broken.creator, '');
});

test('a video is read out of OCR words, in reading order', async () => {
    const word = (text: string, top: number, left: number): OcrWord => ({
        text, bounds: { left, top, right: left + text.length * 10, bottom: top + 20 },
    });
    const words = [
        word('swings', 200, 90), word('kettlebell', 200, 0), word('#homegym', 200, 200),
        word('@liftdaily', 160, 0), word('Follow', 400, 900),
    ];
    const video = videoFromWords(words);
    assert.equal(video.creator, '@liftdaily');
    assert.equal(video.caption, 'kettlebell swings #homegym');
    assert.deepEqual(video.hashtags, ['homegym']);
    assert.deepEqual(findWordBounds(words, 'follow'), { left: 900, top: 400, right: 960, bottom: 420 });
    assert.equal(findWordBounds(words, 'Share'), undefined);

    // The OCR path is what iOS uses: no tree, a screenshot and a recognizer.
    const read = await readVideo({ screenshot: async () => Buffer.alloc(0) }, async () => words);
    assert.equal(read.creator, '@liftdaily');
});

/* ---- Deciding ---------------------------------------------------------- */

test('matching content gets the long band and non-matching the short one', () => {
    const matchMs: number[] = [];
    const otherMs: number[] = [];
    let curious = 0;
    let looped = 0;
    for (let seed = 0; seed < 3_000; seed += 1) {
        const state = stateFor(GYM, seeded(seed));
        const match = decideForVideo(GYM, MATCHING, state, seeded(seed + 10_000));
        const other = decideForVideo(GYM, OTHER, state, seeded(seed + 20_000));
        assert.ok(match.matched, 'the kettlebell clip is a match');
        assert.ok(!other.matched, 'the lipstick clip is not');
        matchMs.push(match.watchMs);
        otherMs.push(other.watchMs);
        if (other.curious) curious += 1;
        if (match.looped) looped += 1;
        // The bands, including the loop stretch and the curiosity linger.
        assert.ok(match.watchMs >= 12_000 && match.watchMs <= 30_000 * 1.8, `match watch ${match.watchMs}`);
        assert.ok(other.watchMs >= 2_000 && other.watchMs <= 12_000, `other watch ${other.watchMs}`);
        // Saves only ever happen on a match.
        assert.ok(!other.save);
    }
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    assert.ok(mean(matchMs) > mean(otherMs) * 4, 'a match is watched far longer than the rest');
    assert.ok(curious > 100 && curious < 1_200, `curiosity fired ${curious} times in 3000`);
    assert.ok(looped > 100, `re-watched ${looped} times in 3000`);
});

test('curiosity is the dial that decides whether it looks outside its niche', () => {
    const count = (curiosity: number) => {
        let lingered = 0;
        for (let seed = 0; seed < 1_000; seed += 1) {
            if (decideForVideo({ ...GYM, curiosity }, OTHER, stateFor(GYM), seeded(seed)).curious) lingered += 1;
        }
        return lingered;
    };
    assert.equal(count(0), 0);
    assert.ok(count(1) > count(0.3));
    assert.ok(count(0.3) > 0);
});

test('a video on the avoid list is scrolled past and never engaged with', () => {
    for (let seed = 0; seed < 500; seed += 1) {
        const decision = decideForVideo(GYM, AVOIDED, stateFor(GYM), seeded(seed));
        assert.equal(decision.like, false);
        assert.equal(decision.save, false);
        assert.equal(decision.follow, false);
        assert.equal(decision.watchMs, 2_000);
        assert.match(decision.reason, /avoid list/);
    }
});

test('budgets are never exceeded, however long the session runs', () => {
    for (let seed = 0; seed < 200; seed += 1) {
        const rng = seeded(seed);
        const state = stateFor(GYM, rng);
        for (let video = 0; video < 300; video += 1) {
            const decision = decideForVideo(GYM, MATCHING, state, rng);
            applyDecision(state, MATCHING, decision);
            assert.ok(state.used.likes <= state.budgets.likes);
            assert.ok(state.used.saves <= state.budgets.saves);
            assert.ok(state.used.follows <= state.budgets.follows);
        }
        assert.equal(state.budgets.likes, 6);
        assert.ok(state.used.likes > 0, 'a warm persona on 300 matching videos likes something');
        assert.ok(state.used.saves <= state.used.likes || state.used.likes === 0);
    }
});

test('a creator is only followed once the like rule is satisfied, and never twice', () => {
    const eligible = { ...stateFor(GYM), creatorLikes: { '@liftdaily': 3 }, followed: [] };
    let follows = 0;
    for (let seed = 0; seed < 1_000; seed += 1) {
        if (decideForVideo(GYM, MATCHING, { ...eligible, used: { ...eligible.used } }, seeded(seed)).follow) follows += 1;
    }
    assert.ok(follows > 100, `followed ${follows} times in 1000 once the rule was met`);

    // Two likes short of the rule: never, whatever the draw.
    const short = { ...stateFor(GYM), creatorLikes: { '@liftdaily': 1 }, followed: [] };
    for (let seed = 0; seed < 1_000; seed += 1) {
        assert.equal(decideForVideo(GYM, MATCHING, short, seeded(seed)).follow, false);
    }
    // Already followed: never again.
    const followed = { ...stateFor(GYM), creatorLikes: { '@liftdaily': 9 }, followed: ['@liftdaily'] };
    for (let seed = 0; seed < 500; seed += 1) {
        assert.equal(decideForVideo(GYM, MATCHING, followed, seeded(seed)).follow, false);
    }
    // A creator the account already likes counts as familiar even without a keyword hit.
    const familiar = interestMatch(GYM, videoFromTexts(['@liftdaily', 'a quiet morning']), eligible as SessionState);
    assert.ok(familiar.familiar);
});

test('the log line says what happened and why', () => {
    const state = { ...stateFor(GYM), used: { likes: 2, saves: 0, follows: 0, searches: 0 } };
    let liked = '';
    for (let seed = 0; seed < 500 && !liked; seed += 1) {
        const decision = decideForVideo(GYM, MATCHING, state, seeded(seed));
        if (decision.like) liked = decision.reason;
    }
    assert.match(liked, /^Liked/);
    assert.match(liked, /#garagegym|"kettlebell"|"homegym"/);
    assert.match(liked, /3 of 6 likes used/);
    assert.match(decideForVideo(GYM, OTHER, stateFor(GYM), seeded(7)).reason, /home gym/);
});

test('searching happens inside the budget, after a cooldown, and picks an interest', () => {
    const state = stateFor(GYM);
    // Nothing before the cooldown, whatever the draw.
    for (let seed = 0; seed < 500; seed += 1) {
        assert.equal(decideSearch(GYM, { ...state, sinceSearch: 0 }, seeded(seed)), undefined);
    }
    let searches = 0;
    const terms = new Set<string>();
    for (let seed = 0; seed < 2_000; seed += 1) {
        const decision = decideSearch(GYM, { ...state, sinceSearch: 9 }, seeded(seed));
        if (!decision) continue;
        searches += 1;
        terms.add(decision.term);
        assert.ok(GYM.interests.includes(decision.term));
        assert.match(decision.reason, /^Searched · /);
    }
    assert.ok(searches > 50 && searches < 500, `searched ${searches} times in 2000`);
    assert.ok(terms.size > 1, 'it does not always search the same thing');
    // Budget spent: never.
    const spent = { ...state, sinceSearch: 40, used: { ...state.used, searches: state.budgets.searches } };
    for (let seed = 0; seed < 500; seed += 1) assert.equal(decideSearch(GYM, spent, seeded(seed)), undefined);
});

/* ---- Session planning -------------------------------------------------- */

test('a session refuses to start outside the persona active hours', () => {
    assert.equal(isActiveHour(GYM, new Date(2026, 0, 5, 12, 0)), true);
    assert.equal(isActiveHour(GYM, new Date(2026, 0, 5, 3, 0)), false);
    // An overnight range wraps midnight rather than meaning nothing.
    const nightOwl = { ...GYM, activeHours: [{ start: 22, end: 3 }] };
    assert.equal(isActiveHour(nightOwl, new Date(2026, 0, 5, 23, 30)), true);
    assert.equal(isActiveHour(nightOwl, new Date(2026, 0, 5, 2, 0)), true);
    assert.equal(isActiveHour(nightOwl, new Date(2026, 0, 5, 12, 0)), false);

    for (let seed = 0; seed < 500; seed += 1) {
        const awake = sessionPlan(GYM, seeded(seed), new Date(2026, 0, 5, 12, 0));
        assert.equal(awake.active, true);
        assert.ok(awake.minutes >= GYM.sessionMinutes.min && awake.minutes <= GYM.sessionMinutes.max);
        assert.ok(awake.budgets.likes >= GYM.budgets.likes.min && awake.budgets.likes <= GYM.budgets.likes.max);
        const asleep = sessionPlan(GYM, seeded(seed), new Date(2026, 0, 5, 3, 0));
        assert.equal(asleep.active, false);
        assert.match(asleep.reason, /outside its active hours/);
    }
});

/* ---- Memory ------------------------------------------------------------ */

test('what an account remembers survives a run, and the follow window forgets old likes', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'persona-memory-'));
    context.after(() => rm(directory, { recursive: true, force: true }));

    const memory = emptyMemory('@homegym.dan');
    const first = startSession(memory);
    noteLike(memory, '@liftdaily', first);
    noteLike(memory, '@liftdaily', first);
    recordSession(memory, {
        index: first, startedAt: '2026-01-05T12:00:00.000Z', minutes: 14, videos: 30,
        likes: 2, saves: 1, follows: 0, searches: 1, matched: ['kettlebell'], followedCreators: [], ending: 'completed',
    });
    await writeMemory(memory, directory);

    const reloaded = await readMemory('@homegym.dan', directory);
    assert.equal(reloaded.sessionIndex, 1);
    assert.deepEqual(creatorLikeCounts(reloaded, 4, 1), { '@liftdaily': 2 });
    // Four sessions later, those two likes are outside the window.
    assert.deepEqual(creatorLikeCounts(reloaded, 4, 9), {});

    const second = startSession(reloaded);
    noteLike(reloaded, '@liftdaily', second);
    noteFollow(reloaded, '@liftdaily', second);
    await writeMemory(reloaded, directory);

    const summary = summariseMemory(await readMemory('@homegym.dan', directory));
    assert.deepEqual(summary.followed, ['@liftdaily']);
    assert.deepEqual(summary.favourites, [{ creator: '@liftdaily', likes: 3 }]);
    assert.deepEqual(summary.matched, ['kettlebell']);
    assert.match(summary.headline, /30 videos, 2 likes/);

    // A missing file is a stranger, not a crash.
    assert.deepEqual((await readMemory('@nobody', directory)).sessions, []);
});

test('a session books its likes and follows into the memory it was opened with', () => {
    const memory = emptyMemory('@homegym.dan');
    const session = beginSession(GYM, memory, seeded(3), new Date(2026, 0, 5, 12, 0));
    assert.equal(session.plan.active, true);
    assert.equal(session.index, 1);

    noteDecision(session, MATCHING, {
        watchMs: 20_000, like: true, save: false, follow: false, reason: '', matched: true,
        terms: ['kettlebell'], curious: false, looped: false,
    });
    noteDecision(session, MATCHING, {
        watchMs: 20_000, like: true, save: true, follow: true, reason: '', matched: true,
        terms: ['kettlebell'], curious: false, looped: false,
    });
    finishSession(session, { minutes: 12, ending: 'completed' });

    assert.equal(memory.creators['@liftdaily']!.likes.length, 2);
    assert.deepEqual(memory.followed, ['@liftdaily']);
    assert.equal(memory.sessions[0]!.likes, 2);
    assert.deepEqual(memory.sessions[0]!.matched, ['kettlebell']);
    assert.equal(memory.sessions[0]!.ending, 'completed');
});

/* ---- The routine ------------------------------------------------------- */

interface FakeDriver {
    driver: DeviceDriver;
    taps: string[];
    swipes: number;
}

function fakeDriver(root: UiNode): FakeDriver {
    const state: FakeDriver = { taps: [], swipes: 0, driver: undefined as unknown as DeviceDriver };
    const contains = ({ bounds }: UiNode, { x, y }: Point) =>
        x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
    const press = (point: Point): void => {
        const hit = root.children.filter((child) => contains(child, point)).at(-1);
        state.taps.push(hit ? (hit.text || hit.description || hit.id) : '(nothing)');
    };
    state.driver = {
        kind: 'adb', platform: 'android', udid: 'R58N1ABCDE',
        launchApp: async () => {}, terminateApp: async () => {},
        tap: async (point: Point) => { press(point); },
        swipe: async () => { state.swipes += 1; },
        // Swipes play a generated arc through gesture(), and a tap plays a two-sample path that
        // does not move — a press. The phone cannot tell them apart either, so nor does this.
        gesture: async (path: TimedPoint[]) => {
            const first = path[0]!;
            const last = path[path.length - 1]!;
            if (first.x === last.x && first.y === last.y) press(first);
            else state.swipes += 1;
        },
        type: async () => {}, pressKey: async () => {},
        screenshot: async () => Buffer.alloc(0),
        uiTree: async () => root,
        screen: async () => ({ width: 1080, height: 2340, scale: 1 }),
        pushMedia: async (_file: MediaFile) => {},
        pause: async () => {},
    } as unknown as DeviceDriver;
    return state;
}

const SCREEN: Rect = { left: 0, top: 0, right: 1080, bottom: 2340 };

function feed(creator: string, caption: string): UiNode {
    return node({
        type: 'FrameLayout', bounds: SCREEN,
        children: [
            node({ id: 'com.zhiliaoapp.musically:id/title_author', text: creator, bounds: { left: 40, top: 1900, right: 600, bottom: 1960 } }),
            node({ id: 'com.zhiliaoapp.musically:id/desc', text: caption, bounds: { left: 40, top: 1970, right: 900, bottom: 2060 } }),
            node({ id: 'com.zhiliaoapp.musically:id/ivm_like', description: 'Like', clickable: true, bounds: { left: 980, top: 1400, right: 1060, bottom: 1480 } }),
            node({ id: 'com.zhiliaoapp.musically:id/ivm_collect', description: 'Add to Favorites', clickable: true, bounds: { left: 980, top: 1550, right: 1060, bottom: 1630 } }),
            node({ id: 'com.zhiliaoapp.musically:id/ivm_follow', description: 'Follow', clickable: true, bounds: { left: 980, top: 1250, right: 1060, bottom: 1330 } }),
        ],
    });
}

async function scrollAs(root: UiNode, persona: Persona): Promise<{ fake: FakeDriver; summary: Awaited<ReturnType<typeof doomscrollOnAndroid>> }> {
    const fake = fakeDriver(root);
    let clock = 0;
    const summary = await doomscrollOnAndroid(fake.driver, {
        durationMinutes: 1, personality: 'casual', likeEnabled: true, saveEnabled: true,
        // One seed for the run: the swipe arcs and the tap jitter both come out of it, so the
        // pixels a tap lands on are the same on every run of this test.
        searchEnabled: false, persona, seed: 'persona-routine-test',
        // Every draw at zero: the persona still refuses to engage with content it does not care about.
        random: () => 0,
        now: () => (clock += 2_000),
    });
    return { fake, summary };
}

test('the routine likes what the persona cares about and leaves the rest alone', async () => {
    const warm: Persona = { ...GYM, watch: { match: { min: 1, max: 2 }, other: { min: 1, max: 1 } } };

    const liked = await scrollAs(feed('liftdaily', 'kettlebell swings in the garage #homegym'), warm);
    assert.equal(liked.summary.reason, 'completed');
    assert.ok(liked.summary.videosViewed >= 1);
    assert.ok(liked.fake.taps.includes('Like'), 'a matching video is liked');
    assert.ok(liked.summary.likes > 0);
    assert.ok(liked.fake.swipes > 0);
    // Three likes for the same creator inside the rule, so it eventually follows them.
    assert.ok(liked.fake.taps.includes('Follow'), 'the creator it keeps liking gets followed');
    assert.ok(liked.summary.follows <= 1, 'never past the follow budget');

    const ignored = await scrollAs(feed('glosslab', 'three lipstick shades for autumn'), { ...warm, curiosity: 0 });
    assert.ok(!ignored.fake.taps.includes('Like'), 'nothing outside the niche is liked');
    assert.equal(ignored.summary.likes, 0);
    assert.equal(ignored.summary.saves, 0);
    assert.equal(ignored.summary.follows, 0);
});

test('a persona asleep does not scroll at all', async () => {
    const fake = fakeDriver(feed('liftdaily', 'kettlebell swings'));
    const midnight = new Date(2026, 0, 5, 3, 0).getTime();
    const summary = await doomscrollOnAndroid(fake.driver, {
        personality: 'casual', likeEnabled: true, saveEnabled: true, seed: 'persona-routine-test',
        persona: GYM, random: () => 0.5, now: () => midnight,
    });
    assert.equal(summary.reason, 'asleep');
    assert.equal(summary.videosViewed, 0);
    assert.equal(fake.swipes, 0);
    assert.deepEqual(fake.taps, []);
});

test('the run hands its memory back so the next session knows more than this one', async () => {
    const fake = fakeDriver(feed('liftdaily', 'kettlebell swings #homegym'));
    let clock = 0;
    let saved: Awaited<ReturnType<typeof readMemory>> | undefined;
    await doomscrollOnAndroid(fake.driver, {
        durationMinutes: 1, personality: 'casual', likeEnabled: true, saveEnabled: true, searchEnabled: false,
        seed: 'persona-routine-test',
        persona: { ...GYM, watch: { match: { min: 1, max: 2 }, other: { min: 1, max: 1 } } },
        memory: emptyMemory('@homegym.dan'),
        saveMemory: async (memory) => { saved = memory; },
        random: () => 0, now: () => (clock += 2_000),
    });
    assert.ok(saved, 'the memory was written back');
    assert.equal(saved!.sessionIndex, 1);
    assert.ok((saved!.creators['@liftdaily']?.likes.length ?? 0) > 0);
    assert.equal(saved!.sessions[0]!.ending, 'completed');
});

test('the doomscroll payload accepts persona runs and keeps the old model as the fallback', () => {
    const task = createTikTokPlugin().tasks.find(({ type }) => type === 'doomscroll') as TaskDefinition;
    const context = { timingKind: 'now' } as never;

    const persona = task.validate({
        personality: 'casual', likeEnabled: true, saveEnabled: true, account: '@homegym.dan',
    }, context) as Record<string, unknown>;
    // An account means a persona unless the payload says otherwise, and then no duration is needed.
    assert.equal(persona.persona, true);
    assert.equal(persona.durationMinutes, undefined);

    const explicit = task.validate({
        personality: 'engaged', likeEnabled: true, saveEnabled: false, account: '@a', persona: false, durationMinutes: 12,
    }, context) as Record<string, unknown>;
    assert.equal(explicit.persona, false);
    assert.equal(explicit.durationMinutes, 12);

    assert.throws(() => task.validate({ personality: 'casual', likeEnabled: true, saveEnabled: true }, context),
        /durationMinutes is required/);
    assert.throws(() => task.validate({ personality: 'casual', likeEnabled: true, saveEnabled: true, persona: true }, context),
        /needs an account/);
    assert.throws(() => task.validate({ personality: 'casual', likeEnabled: true, saveEnabled: true, account: '@a', persona: 'yes' }, context),
        /persona must be true or false/);
});

/* ---- The editor -------------------------------------------------------- */

test('the form body is a whitelist', () => {
    const parsed = personaFromForm({ niche: 'home gym', interests: 'kettlebell', likesMin: '2', likesMax: '8', evil: 'x' });
    assert.equal(parsed.niche, 'home gym');
    assert.deepEqual((parsed.budgets as Record<string, unknown>).likes, { min: 2, max: 8 });
    assert.equal((parsed as Record<string, unknown>).evil, undefined);
});

test('the Accounts page edits a persona through htmx fragments', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'persona-routes-'));
    const previous = process.env.SCHEDULER_DATA_DIR;
    process.env.SCHEDULER_DATA_DIR = directory;
    context.after(async () => {
        if (previous === undefined) delete process.env.SCHEDULER_DATA_DIR; else process.env.SCHEDULER_DATA_DIR = previous;
        await rm(directory, { recursive: true, force: true });
    });

    const app = await createApp({
        plugins: new PluginRegistry([]),
        scheduler: {} as SchedulerRepository,
        dashboardTheme: defaultDashboardTheme,
    });
    context.after(() => app.close());

    const url = `/accounts/${encodeURIComponent('@homegym.dan')}/persona`;
    const first = await inject(app, { method: 'GET', url });
    assert.equal(first.statusCode, 200);
    assert.match(first.body, /No persona set up yet/);
    assert.match(first.body, /name="interests"/);
    assert.match(first.body, /This account has not scrolled with a persona yet/);

    const saved = await inject(app, {
        method: 'POST', url,
        payload: new URLSearchParams({
            niche: 'home gym', interests: 'kettlebell, #homegym', avoid: 'makeup', language: 'en',
            warmth: '0.8', curiosity: '0.25', likesMin: '3', likesMax: '7', sessionMin: '10', sessionMax: '20',
            activeHours: '08-23', followLikes: '3', followSessions: '4',
        }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(saved.statusCode, 200);
    assert.match(saved.body, /Saved\./);
    assert.match(saved.body, /Reset to the default/);
    const stored = await loadPersonas(directory);
    assert.deepEqual(stored['@homegym.dan']!.interests, ['kettlebell', '#homegym']);
    assert.deepEqual(stored['@homegym.dan']!.budgets.likes, { min: 3, max: 7 });

    // A rejected edit comes back as the panel with the reason on it, not as a status htmx ignores.
    const rejected = await inject(app, {
        method: 'POST', url,
        payload: new URLSearchParams({ interests: '<script>', niche: 'home gym' }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(rejected.statusCode, 200);
    assert.match(rejected.body, /not a usable interest term/);
    assert.doesNotMatch(rejected.body, /<script>/);

    const reset = await inject(app, { method: 'DELETE', url });
    assert.equal(reset.statusCode, 200);
    assert.match(reset.body, /back to the persona derived from its handle/);
    assert.deepEqual(await loadPersonas(directory), {});

    assert.equal((await inject(app, { method: 'GET', url: '/accounts/not-a-handle!/persona' })).statusCode, 400);
});

/* ---- Presets ----------------------------------------------------------- */

test('every preset is a valid persona with a niche of its own', () => {
    assert.ok(PERSONA_PRESETS.length >= 12, `expected at least twelve niches, got ${PERSONA_PRESETS.length}`);
    const ids = PERSONA_PRESETS.map(({ id }) => id);
    assert.equal(new Set(ids).size, ids.length, 'preset ids are unique');

    for (const preset of PERSONA_PRESETS) {
        assert.match(preset.id, /^[a-z0-9][a-z0-9-]{1,31}$/);
        assert.ok(preset.description.trim().length > 10, `${preset.id} has no description worth reading`);
        // Applying it is a full validation pass: a typo in a preset fails here, not on a phone.
        const persona = applyPreset('@farm.one', preset.id);
        assert.equal(persona.handle, '@farm.one');
        assert.ok(persona.interests.length >= 6, `${preset.id} needs more than ${persona.interests.length} interests`);
        assert.ok(persona.avoid.length >= 1, `${preset.id} avoids nothing`);
        assert.ok(persona.activeHours.length >= 1 && persona.activeHours.length <= 6);
        assert.ok(persona.sessionMinutes.min >= 1 && persona.sessionMinutes.min <= persona.sessionMinutes.max);
        assert.ok(persona.watch.match.min > persona.watch.other.min, `${preset.id} watches a match no longer than the rest`);
        assert.ok(persona.budgets.likes.max > 0);
    }
    assert.throws(() => applyPreset('@farm.one', 'no-such-niche'), /not one of the presets/);
    assert.equal(findPreset('home-gym')?.label, 'Home gym');
    assert.equal(findPreset(42), undefined);
});

test('two presets watching the same feed behave like two different people', () => {
    const clip = videoFromTexts(['@liftdaily', 'kettlebell swings in the home gym #homegym #gymtok', 'original sound - liftdaily']);
    const outcomes = new Map<string, string>();
    for (const preset of PERSONA_PRESETS) {
        const persona = applyPreset('@farm.one', preset.id);
        const decision = decideForVideo(persona, clip, stateFor(persona, seeded(7)), seeded(9));
        const plan = sessionPlan(persona, seeded(3), new Date(2026, 0, 5, 12, 0));
        outcomes.set(preset.id, `${decision.matched}:${decision.like}:${decision.watchMs}:${plan.minutes}:${plan.budgets.likes}`);
    }
    // The gym accounts recognise it; the ones with nothing to do with it scroll past.
    assert.equal(outcomes.get('home-gym')!.startsWith('true'), true);
    assert.equal(outcomes.get('fitness')!.startsWith('true'), true);
    assert.equal(outcomes.get('baking')!.startsWith('false'), true);
    assert.equal(outcomes.get('personal-finance')!.startsWith('false'), true);
    // And they are not all the same person behind the same coin flip.
    assert.ok(new Set(outcomes.values()).size >= 15, `only ${new Set(outcomes.values()).size} distinct outcomes`);

    // A preset's avoid list is a veto, whatever else is on screen.
    const makeup = applyPreset('@farm.one', 'personal-finance');
    const crypto = videoFromTexts(['@moonboy', 'this crypto play changed my life']);
    const refused = decideForVideo(makeup, crypto, stateFor(makeup, seeded(7)), seeded(9));
    assert.equal(refused.like, false);
    assert.match(refused.reason, /avoid list/);
});

test('the Accounts page offers the presets, fills the form with one, and applies one over the API', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'persona-presets-'));
    const previous = process.env.SCHEDULER_DATA_DIR;
    process.env.SCHEDULER_DATA_DIR = directory;
    context.after(async () => {
        if (previous === undefined) delete process.env.SCHEDULER_DATA_DIR; else process.env.SCHEDULER_DATA_DIR = previous;
        await rm(directory, { recursive: true, force: true });
    });

    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler: {} as SchedulerRepository, dashboardTheme: defaultDashboardTheme,
    });
    context.after(() => app.close());
    const url = `/accounts/${encodeURIComponent('@farm.one')}/persona`;

    // Nothing stored: the niches, not twenty empty fields.
    const fresh = await inject(app, { method: 'GET', url });
    assert.match(fresh.body, /Start from a preset/);
    assert.match(fresh.body, /Garage racks, adjustable dumbbells/);
    assert.match(fresh.body, /Or fill it in by hand/);

    // Apply fills the form and stores nothing.
    const applied = await inject(app, { method: 'GET', url: `${url}?preset=home-gym` });
    assert.equal(applied.statusCode, 200);
    assert.match(applied.body, /Filled in from the Home gym preset/);
    assert.match(applied.body, /squat rack, power rack/);
    assert.deepEqual(await loadPersonas(directory), {}, 'Apply saves nothing');

    // An unknown preset is not an error anybody asked a question to get.
    assert.equal((await inject(app, { method: 'GET', url: `${url}?preset=nonsense` })).statusCode, 200);

    const saved = await inject(app, {
        method: 'POST', url: '/api/accounts/%40farm.one/persona/preset', payload: { preset: 'running' },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal((saved.json() as Persona).niche, 'running');
    assert.deepEqual((await loadPersonas(directory))['@farm.one']!.avoid, ['gambling', 'weight loss pills']);

    const refused = await inject(app, {
        method: 'POST', url: '/api/accounts/%40farm.one/persona/preset', payload: { preset: 'nonsense' },
    });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /not one of the presets/);

    const listed = await inject(app, { method: 'GET', url: '/api/persona-presets' });
    assert.equal((listed.json() as { presets: unknown[] }).presets.length, PERSONA_PRESETS.length);
});

/* ---- The library ------------------------------------------------------- */

test('the preset library is categorised, and every preset in it is a usable persona', () => {
    assert.ok(PERSONA_PRESETS.length >= 80, `expected a library, got ${PERSONA_PRESETS.length} presets`);
    const ids = PERSONA_PRESETS.map(({ id }) => id);
    assert.equal(new Set(ids).size, ids.length, 'preset ids are unique');

    // The twenty that shipped first are still there, under the ids anything stored already names.
    for (const id of ['fitness', 'home-gym', 'running', 'cooking', 'baking', 'beauty', 'skincare', 'fashion',
        'tech-gadgets', 'personal-finance', 'real-estate', 'travel', 'parenting', 'gaming', 'comedy', 'pets',
        'diy-home', 'cars', 'study-productivity', 'mindfulness']) {
        assert.ok(findPreset(id), `${id} was dropped from the library`);
    }

    const grouped = presetsByCategory();
    assert.deepEqual(grouped.map(({ category }) => category), [...PRESET_CATEGORIES],
        'every category has presets in it, in the order the picker shows them');
    assert.equal(grouped.reduce((total, { presets }) => total + presets.length, 0), PERSONA_PRESETS.length);

    for (const preset of PERSONA_PRESETS) {
        assert.ok((PRESET_CATEGORIES as readonly string[]).includes(preset.category), `${preset.id} has no category`);
        // Applying it is a full validation pass: a typo in a preset fails here, not on a phone.
        const persona = applyPreset('@farm.one', preset.id);
        assert.ok(persona.interests.length >= 8, `${preset.id} has only ${persona.interests.length} interests`);
        assert.ok(persona.avoid.length >= 1, `${preset.id} avoids nothing`);
        assert.deepEqual(persona.presets, [preset.id], `${preset.id} does not record itself`);
        assert.match(persona.niche, NICHE_PATTERN);
    }
});

/* ---- Blends ------------------------------------------------------------ */

test('a blend joins the interests, drops the vetoes the others want, and averages the dials', () => {
    const ai = applyPreset('@farm.one', 'ai-tools');
    const indie = applyPreset('@farm.one', 'indie-hacking');
    const blended = blendPresets('@farm.one', ['ai-tools', 'indie-hacking', 'saas-productivity']);

    // Union in order, de-duplicated, the first preset's terms first.
    assert.deepEqual(blended.interests.slice(0, ai.interests.length), ai.interests);
    for (const interest of indie.interests) assert.ok(blended.interests.includes(interest));
    assert.equal(new Set(blended.interests).size, blended.interests.length, 'no duplicated interests');
    assert.deepEqual(blended.presets, ['ai-tools', 'indie-hacking', 'saas-productivity']);

    // Means, rounded: two dials and one budget is enough to show the arithmetic.
    const dials = ['ai-tools', 'indie-hacking', 'saas-productivity'].map((id) => applyPreset('@farm.one', id));
    const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
    assert.equal(blended.curiosity, Math.round(mean(dials.map((one) => one.curiosity)) * 100) / 100);
    assert.equal(blended.warmth, Math.round(mean(dials.map((one) => one.warmth)) * 100) / 100);
    assert.equal(blended.budgets.likes.max, Math.round(mean(dials.map((one) => one.budgets.likes.max))));
    assert.equal(blended.watch.match.min, Math.round(mean(dials.map((one) => one.watch.match.min))));

    // The most conservative follow rule of the three: the most likes, inside the fewest sessions.
    assert.equal(blended.followRule.likes, Math.max(...dials.map((one) => one.followRule.likes)));
    assert.equal(blended.followRule.withinSessions, Math.min(...dials.map((one) => one.followRule.withinSessions)));

    // One preset's avoid list must not veto another preset's interest.
    const money = blendPresets('@farm.one', ['personal-finance', 'crypto-web3']);
    assert.ok(money.interests.includes('crypto'));
    assert.ok(!money.avoid.includes('crypto'), 'crypto is an interest of the blend, not a veto in it');
    assert.ok(money.avoid.includes('gambling'), 'a veto both presets keep survives');

    // A single id is still a blend, and matches what applying that preset alone would give.
    const alone = blendPresets('@farm.one', ['running']);
    assert.deepEqual(alone.interests, applyPreset('@farm.one', 'running').interests);
    assert.equal(alone.niche, 'running');

    assert.throws(() => blendPresets('@farm.one', ['ai-tools', 'nonsense']), /not one of the presets/);
    assert.throws(() => blendPresets('@farm.one', []), /at least one preset/);
});

test('a blend caps the interests without silently losing the last preset', () => {
    const ids = PERSONA_PRESETS.slice(0, 8).map(({ id }) => id);
    const blended = blendPresets('@farm.one', ids);
    assert.ok(blended.interests.length <= LIMITS.terms);
    assert.ok(blended.avoid.length <= LIMITS.terms);
    // Eighty terms is enough for the three-preset blend the picker is for: nothing is dropped.
    const three = blendPresets('@farm.one', ['ai-tools', 'indie-hacking', 'saas-productivity']);
    for (const id of ['ai-tools', 'indie-hacking', 'saas-productivity']) {
        for (const interest of applyPreset('@farm.one', id).interests) {
            assert.ok(three.interests.includes(interest), `${interest} was dropped at the cap`);
        }
    }
    assert.throws(() => blendPresets('@farm.one', PERSONA_PRESETS.slice(0, 9).map(({ id }) => id)), /at most/);
});

test('active hours are unioned, overlaps merged and the widest kept', () => {
    assert.deepEqual(mergeHourRanges([{ start: 8, end: 12 }, { start: 11, end: 15 }]), [{ start: 8, end: 15 }]);
    assert.deepEqual(mergeHourRanges([{ start: 22, end: 2 }, { start: 1, end: 4 }]), [{ start: 22, end: 4 }]);
    assert.deepEqual(mergeHourRanges([{ start: 6, end: 9 }, { start: 18, end: 23 }]),
        [{ start: 6, end: 9 }, { start: 18, end: 23 }]);
    assert.deepEqual(mergeHourRanges([{ start: 0, end: 12 }, { start: 12, end: 24 }]), [{ start: 0, end: 24 }]);

    // Seven windows do not fit in a persona; the six widest survive, in clock order.
    const many = mergeHourRanges([
        { start: 1, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }, { start: 9, end: 12 },
        { start: 13, end: 16 }, { start: 17, end: 20 }, { start: 21, end: 24 },
    ]);
    assert.equal(many.length, LIMITS.activeHours);
    assert.deepEqual([...many].sort((a, b) => a.start - b.start), many);
    assert.ok(!many.some(({ start }) => start === 1), 'the one-hour window is the one that goes');

    const blended = blendPresets('@farm.one', ['running', 'gaming', 'sleep']);
    assert.ok(blended.activeHours.length <= LIMITS.activeHours);
    assert.ok(blended.activeHours.some(({ start }) => start === 5), 'the runner is still up at five');
});

test('a blended niche names its presets and still fits what a niche may hold', () => {
    assert.equal(blendNiche(['AI tools', 'Indie hacking', 'Productivity']), 'ai tools · indie hacking · productivity');
    const long = blendNiche(['Restaurants and food travel', 'Cleaning and organising', 'Board games and TTRPG']);
    assert.match(long, NICHE_PATTERN);
    assert.match(long, /more$/);
    for (const preset of PERSONA_PRESETS) {
        assert.match(blendNiche([preset.label, 'Sleep', 'Cats']), NICHE_PATTERN, `${preset.id} blends into a bad niche`);
    }
});

test('a persona file written before blends existed still loads', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'persona-old-'));
    context.after(async () => rm(directory, { recursive: true, force: true }));

    // Exactly what an older Backline wrote: every field of the day, and no `presets` key.
    const old = {
        '@homegym.dan': {
            handle: '@homegym.dan', niche: 'home gym', interests: ['kettlebell', '#homegym'], avoid: ['makeup'],
            language: 'en', curiosity: 0.2, warmth: 0.6,
            budgets: { likes: { min: 4, max: 10 }, saves: { min: 2, max: 6 }, follows: { min: 0, max: 1 }, searches: { min: 1, max: 3 } },
            watch: { match: { min: 18, max: 45 }, other: { min: 2, max: 5 } },
            sessionMinutes: { min: 10, max: 25 }, activeHours: [{ start: 6, end: 8 }],
            followRule: { likes: 3, withinSessions: 5 },
        },
    };
    await writeFile(path.join(directory, 'personas.json'), JSON.stringify(old, null, 2));

    const loaded = await loadPersonas(directory);
    const persona = loaded['@homegym.dan'];
    assert.ok(persona, 'the old entry loaded');
    assert.deepEqual(persona.interests, ['kettlebell', '#homegym']);
    assert.equal(persona.presets, undefined, 'nothing was invented for it');
    assert.ok(!Object.hasOwn(persona, 'presets'), 'and no empty key was added either');

    // Saving it back keeps it that way; blending is what puts the field there.
    await savePersona('@homegym.dan', persona as unknown as Record<string, unknown>, directory);
    assert.ok(!Object.hasOwn((await loadPersonas(directory))['@homegym.dan']!, 'presets'));

    assert.throws(() => validatePersona('@homegym.dan', { ...persona, presets: ['no-such-preset'] }),
        /not one of the presets/);
    assert.deepEqual(validatePersona('@homegym.dan', { ...persona, presets: 'home-gym, running' }).presets,
        ['home-gym', 'running']);
});

test('the editor blends from the picker and the API answers with the same body', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'persona-blend-'));
    const previous = process.env.SCHEDULER_DATA_DIR;
    process.env.SCHEDULER_DATA_DIR = directory;
    context.after(async () => {
        if (previous === undefined) delete process.env.SCHEDULER_DATA_DIR; else process.env.SCHEDULER_DATA_DIR = previous;
        await rm(directory, { recursive: true, force: true });
    });

    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler: {} as SchedulerRepository, dashboardTheme: defaultDashboardTheme,
    });
    context.after(() => app.close());
    const url = `/accounts/${encodeURIComponent('@farm.one')}/persona`;

    // The picker is grouped, searchable, and every option carries the selection it would produce.
    const fresh = await inject(app, { method: 'GET', url });
    assert.match(fresh.body, /Tech &amp; product/);
    assert.match(fresh.body, /data-preset-search/);
    assert.match(fresh.body, /data-preset-terms/);

    const blended = await inject(app, { method: 'GET', url: `${url}?presets=ai-tools,indie-hacking,saas-productivity` });
    assert.equal(blended.statusCode, 200);
    assert.match(blended.body, /Blended from AI tools, Indie hacking and Productivity apps/);
    assert.match(blended.body, /building in public/);
    assert.match(blended.body, /name="presets" value="ai-tools,indie-hacking,saas-productivity"/);
    assert.deepEqual(await loadPersonas(directory), {}, 'a blend saves nothing');

    // An unknown id in the list is dropped, not an error nobody asked a question to get.
    const partial = await inject(app, { method: 'GET', url: `${url}?presets=ai-tools,nonsense` });
    assert.equal(partial.statusCode, 200);
    assert.match(partial.body, /Filled in from the AI tools preset/);

    // The same blend as JSON, still without storing it.
    const preview = await inject(app, {
        method: 'POST', url: '/api/personas/%40farm.one/blend',
        payload: { presets: ['ai-tools', 'indie-hacking', 'saas-productivity'] },
    });
    assert.equal(preview.statusCode, 200);
    const body = preview.json() as Persona;
    assert.deepEqual(body, blendPresets('@farm.one', ['ai-tools', 'indie-hacking', 'saas-productivity']));
    assert.deepEqual(await loadPersonas(directory), {}, 'the preview saves nothing either');
    assert.equal((await inject(app, {
        method: 'POST', url: '/api/personas/%40farm.one/blend', payload: { presets: ['nonsense'] },
    })).statusCode, 400);

    // Saving the form the picker filled keeps the chips with it.
    const saved = await inject(app, {
        method: 'POST', url,
        payload: new URLSearchParams({
            niche: body.niche, interests: body.interests.join(', '), avoid: body.avoid.join(', '), language: 'en',
            warmth: String(body.warmth), curiosity: String(body.curiosity),
            likesMin: '5', likesMax: '12', sessionMin: '14', sessionMax: '33',
            activeHours: '08-10, 21-24', followLikes: '4', followSessions: '4',
            presets: 'ai-tools,indie-hacking,saas-productivity',
        }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(saved.statusCode, 200);
    const stored = (await loadPersonas(directory))['@farm.one'];
    assert.deepEqual(stored?.presets, ['ai-tools', 'indie-hacking', 'saas-productivity']);
    // And the panel comes back with those chips on it, ready to be blended again. Its copy of the
    // library is a placeholder: a page of forty configured accounts does not carry forty copies.
    assert.match(saved.body, /value="ai-tools,indie-hacking,saas-productivity"/);
    assert.doesNotMatch(saved.body, /data-preset-terms/);
    const library = await inject(app, {
        method: 'GET', url: `${url}/library?presets=ai-tools,indie-hacking`,
    });
    assert.equal(library.statusCode, 200);
    assert.match(library.body, /Garage racks, adjustable dumbbells/);
    assert.match(library.body, /data-preset-search/);
    // An option already picked offers the selection without it; the others offer it with them.
    assert.match(library.body, /value="indie-hacking" data-preset-terms="ai tools/);
    assert.match(library.body, /value="ai-tools,indie-hacking,yoga"/);

    // The one-call endpoint blends and stores.
    const applied = await inject(app, {
        method: 'POST', url: '/api/accounts/%40farm.two/persona/preset', payload: { presets: ['yoga', 'coffee'] },
    });
    assert.equal(applied.statusCode, 200);
    assert.deepEqual((applied.json() as Persona).presets, ['yoga', 'coffee']);
    assert.deepEqual((await loadPersonas(directory))['@farm.two']!.presets, ['yoga', 'coffee']);

    const listed = await inject(app, { method: 'GET', url: '/api/persona-presets' });
    const catalogue = listed.json() as {
        presets: Array<{ id: string; category: string }>;
        categories: Array<{ category: string; presets: string[] }>;
    };
    assert.equal(catalogue.presets.length, PERSONA_PRESETS.length);
    assert.deepEqual(catalogue.categories.map(({ category }) => category), [...PRESET_CATEGORIES]);
    assert.ok(catalogue.categories.every(({ presets }) => presets.length > 0));
});
