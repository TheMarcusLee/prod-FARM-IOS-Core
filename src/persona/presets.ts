/**
 * Personas people actually run.
 *
 * A persona has fourteen fields and every one of them matters, which is a lot to invent from a
 * blank form for the fortieth account on a farm. These are twenty niches written out properly:
 * real interests and avoid lists, a warmth and a curiosity that suit the niche, budgets that a
 * person in it would plausibly spend, watch bands that reflect how long that content actually
 * holds someone, and the hours of the day they are on their phone. A runner is up at six and
 * watches a form clip right through; a comedy account is warm, curious, and gone in four seconds.
 *
 * A preset is a starting point, never a lock-in: `applyPreset` runs the body through
 * `validatePersona` like any other input, and the editor fills the form with it rather than
 * saving it, so an operator always sees the values before they land.
 */

import { PersonaError, normaliseHandle, validatePersona, type Persona } from './model.js';

/** Everything a preset sets. The handle is the account's; nothing else is inherited. */
export type PresetBody = Omit<Persona, 'handle'>;

export interface PersonaPreset {
    /** Stable id: what the select posts and what the API takes. */
    id: string;
    /** How it reads in the picker. */
    label: string;
    /** One line, in the operator's language, about who this account would be. */
    description: string;
    persona: PresetBody;
}

interface Draft {
    id: string;
    label: string;
    description: string;
    niche: string;
    interests: string[];
    avoid: string[];
    curiosity: number;
    warmth: number;
    /** likes, saves, follows, searches — each `[min, max]` per session. */
    likes: [number, number];
    saves: [number, number];
    follows: [number, number];
    searches: [number, number];
    /** Seconds on a video that matched, and on one that did not. */
    match: [number, number];
    other: [number, number];
    session: [number, number];
    hours: Array<[number, number]>;
    follow: [number, number];
}

function build(draft: Draft): PersonaPreset {
    const range = ([min, max]: [number, number]) => ({ min, max });
    return {
        id: draft.id,
        label: draft.label,
        description: draft.description,
        persona: {
            niche: draft.niche,
            interests: draft.interests,
            avoid: draft.avoid,
            language: 'en',
            curiosity: draft.curiosity,
            warmth: draft.warmth,
            budgets: {
                likes: range(draft.likes), saves: range(draft.saves),
                follows: range(draft.follows), searches: range(draft.searches),
            },
            watch: { match: range(draft.match), other: range(draft.other) },
            sessionMinutes: range(draft.session),
            activeHours: draft.hours.map(([start, end]) => ({ start, end })),
            followRule: { likes: draft.follow[0], withinSessions: draft.follow[1] },
        },
    };
}

/**
 * The library. Ordered the way somebody scans a list — the fitness cluster, then food, then
 * appearance, then the rest — rather than alphabetically.
 */
export const PERSONA_PRESETS: readonly PersonaPreset[] = [
    build({
        id: 'fitness', label: 'Fitness', description: 'Gym sessions, form checks and progress clips.',
        niche: 'fitness',
        interests: ['gym', 'workout', 'lifting', 'squat', 'deadlift', 'bench press', 'progressive overload',
            'personal trainer', '#gymtok', '#fitness'],
        avoid: ['crypto', 'gambling', 'dropshipping'],
        curiosity: 0.3, warmth: 0.55,
        likes: [5, 12], saves: [1, 4], follows: [0, 2], searches: [0, 2],
        match: [14, 40], other: [2, 6], session: [12, 28], hours: [[6, 9], [17, 23]], follow: [3, 4],
    }),
    build({
        id: 'home-gym', label: 'Home gym', description: 'Garage racks, adjustable dumbbells and small-space setups.',
        niche: 'home gym',
        interests: ['home gym', 'garage gym', 'squat rack', 'power rack', 'adjustable dumbbells', 'kettlebell',
            'bumper plates', 'rubber flooring', '#homegym', '#garagegym'],
        avoid: ['makeup', 'nightclub', 'crypto'],
        curiosity: 0.2, warmth: 0.6,
        likes: [4, 10], saves: [2, 6], follows: [0, 1], searches: [1, 3],
        match: [18, 45], other: [2, 5], session: [10, 25], hours: [[6, 8], [18, 23]], follow: [3, 5],
    }),
    build({
        id: 'running', label: 'Running', description: 'Race training, splits, and far too many shoe reviews.',
        niche: 'running',
        interests: ['running', 'marathon', 'half marathon', '5k', '10k', 'tempo run', 'zone 2',
            'running shoes', 'race day', '#runtok'],
        avoid: ['gambling', 'weight loss pills'],
        curiosity: 0.25, warmth: 0.5,
        likes: [4, 9], saves: [1, 3], follows: [0, 1], searches: [1, 3],
        match: [15, 38], other: [2, 5], session: [8, 20], hours: [[5, 8], [18, 22]], follow: [3, 4],
    }),
    build({
        id: 'cooking', label: 'Cooking', description: 'Weeknight dinners, one-pan things and knife work.',
        niche: 'cooking',
        interests: ['recipe', 'weeknight dinner', 'one pan', 'meal prep', 'pasta', 'curry', 'stir fry',
            'knife skills', '#cooking', '#recipe'],
        avoid: ['mukbang', 'diet pills'],
        curiosity: 0.4, warmth: 0.6,
        likes: [6, 14], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [20, 50], other: [3, 7], session: [12, 30], hours: [[11, 14], [16, 22]], follow: [3, 4],
    }),
    build({
        id: 'baking', label: 'Baking', description: 'Sourdough, laminated dough and cakes that take a weekend.',
        niche: 'baking',
        interests: ['baking', 'sourdough', 'bread', 'croissant', 'laminated dough', 'buttercream',
            'cake decorating', 'pastry', '#baketok', '#sourdough'],
        avoid: ['diet pills', 'mukbang'],
        curiosity: 0.3, warmth: 0.65,
        likes: [5, 12], saves: [3, 10], follows: [0, 2], searches: [1, 3],
        match: [25, 60], other: [3, 7], session: [15, 35], hours: [[9, 13], [19, 23]], follow: [3, 5],
    }),
    build({
        id: 'beauty', label: 'Beauty', description: 'Makeup looks, hauls and the products behind them.',
        niche: 'beauty',
        interests: ['makeup', 'foundation', 'eyeliner', 'lipstick', 'blush', 'contour', 'makeup haul',
            'get ready with me', '#makeuptok', '#beauty'],
        avoid: ['gore', 'politics'],
        curiosity: 0.45, warmth: 0.7,
        likes: [8, 18], saves: [2, 7], follows: [1, 3], searches: [1, 4],
        match: [15, 42], other: [2, 6], session: [15, 40], hours: [[8, 11], [19, 24]], follow: [3, 3],
    }),
    build({
        id: 'skincare', label: 'Skincare', description: 'Routines, actives, and dermatologists correcting them.',
        niche: 'skincare',
        interests: ['skincare', 'retinol', 'niacinamide', 'spf', 'sunscreen', 'moisturiser', 'acne',
            'dermatologist', '#skincare', '#skintok'],
        avoid: ['gore', 'diet pills'],
        curiosity: 0.3, warmth: 0.55,
        likes: [5, 12], saves: [3, 8], follows: [0, 2], searches: [1, 4],
        match: [20, 48], other: [2, 6], session: [12, 28], hours: [[7, 10], [20, 24]], follow: [3, 4],
    }),
    build({
        id: 'fashion', label: 'Fashion', description: 'Outfits, thrifting and building a wardrobe that works.',
        niche: 'fashion',
        interests: ['outfit', 'ootd', 'thrifting', 'capsule wardrobe', 'styling', 'denim', 'vintage',
            'street style', '#fashiontok', '#ootd'],
        avoid: ['gambling', 'dropshipping'],
        curiosity: 0.5, warmth: 0.65,
        likes: [7, 16], saves: [3, 9], follows: [1, 3], searches: [1, 3],
        match: [12, 35], other: [2, 5], session: [15, 35], hours: [[8, 10], [18, 24]], follow: [3, 3],
    }),
    build({
        id: 'tech-gadgets', label: 'Tech gadgets', description: 'Phones, keyboards, desk setups and teardowns.',
        niche: 'tech gadgets',
        interests: ['gadget', 'smartphone', 'mechanical keyboard', 'desk setup', 'unboxing', 'benchmark',
            'battery life', 'teardown', '#techtok', '#gadgets'],
        avoid: ['crypto', 'nft', 'dropshipping'],
        curiosity: 0.45, warmth: 0.4,
        likes: [4, 10], saves: [2, 6], follows: [0, 2], searches: [1, 4],
        match: [25, 60], other: [3, 8], session: [15, 40], hours: [[12, 14], [19, 24]], follow: [4, 5],
    }),
    build({
        id: 'personal-finance', label: 'Personal finance', description: 'Budgeting, index funds and getting out of debt.',
        niche: 'personal finance',
        interests: ['budgeting', 'index funds', 'emergency fund', 'debt payoff', 'pension', 'isa',
            'saving money', 'credit score', '#moneytok', '#personalfinance'],
        avoid: ['crypto', 'nft', 'forex', 'gambling', 'get rich quick'],
        curiosity: 0.25, warmth: 0.35,
        likes: [3, 8], saves: [2, 7], follows: [0, 1], searches: [1, 3],
        match: [30, 70], other: [3, 8], session: [10, 25], hours: [[7, 9], [20, 23]], follow: [4, 6],
    }),
    build({
        id: 'real-estate', label: 'Real estate', description: 'House tours, first-time buyers and rental numbers.',
        niche: 'real estate',
        interests: ['house tour', 'first time buyer', 'mortgage', 'rental property', 'landlord', 'renovation budget',
            'property market', 'open house', '#realestate', '#hometour'],
        avoid: ['crypto', 'get rich quick', 'gambling'],
        curiosity: 0.3, warmth: 0.35,
        likes: [3, 8], saves: [2, 6], follows: [0, 1], searches: [1, 3],
        match: [30, 75], other: [3, 8], session: [10, 25], hours: [[8, 10], [19, 23]], follow: [4, 6],
    }),
    build({
        id: 'travel', label: 'Travel', description: 'Flight deals, city guides and packing far too well.',
        niche: 'travel',
        interests: ['travel', 'flight deal', 'city guide', 'hostel', 'road trip', 'packing tips',
            'carry on', 'itinerary', '#traveltok', '#travel'],
        avoid: ['gambling', 'timeshare'],
        curiosity: 0.6, warmth: 0.6,
        likes: [6, 14], saves: [4, 12], follows: [0, 2], searches: [1, 4],
        match: [20, 55], other: [3, 8], session: [15, 40], hours: [[12, 14], [20, 24]], follow: [3, 5],
    }),
    build({
        id: 'parenting', label: 'Parenting', description: 'Toddlers, sleep, school runs and other people surviving them.',
        niche: 'parenting',
        interests: ['toddler', 'newborn', 'sleep training', 'weaning', 'school run', 'tantrum',
            'nursery', 'parenting hacks', '#momtok', '#parenting'],
        avoid: ['gore', 'politics', 'diet pills'],
        curiosity: 0.35, warmth: 0.7,
        likes: [6, 14], saves: [2, 7], follows: [0, 2], searches: [0, 2],
        match: [15, 40], other: [2, 6], session: [8, 20], hours: [[6, 8], [12, 14], [20, 23]], follow: [3, 4],
    }),
    build({
        id: 'gaming', label: 'Gaming', description: 'Playthroughs, patch notes and setups worth more than the car.',
        niche: 'gaming',
        interests: ['gaming', 'speedrun', 'patch notes', 'boss fight', 'indie game', 'controller',
            'pc build', 'gameplay', '#gamingtok', '#gamer'],
        avoid: ['gambling', 'crypto', 'csgo skins'],
        curiosity: 0.4, warmth: 0.5,
        likes: [6, 15], saves: [1, 4], follows: [0, 2], searches: [1, 3],
        match: [25, 70], other: [3, 8], session: [20, 60], hours: [[16, 24], [0, 2]], follow: [4, 5],
    }),
    build({
        id: 'comedy', label: 'Comedy', description: 'Sketches and bits — warm, easily distracted, gone in four seconds.',
        niche: 'comedy',
        interests: ['comedy', 'sketch', 'standup', 'skit', 'prank', 'impression', 'punchline',
            'funny', '#comedytok', '#funny'],
        avoid: ['gore', 'politics'],
        curiosity: 0.75, warmth: 0.75,
        likes: [10, 25], saves: [0, 3], follows: [0, 3], searches: [0, 1],
        match: [10, 30], other: [2, 4], session: [15, 45], hours: [[12, 14], [18, 24], [0, 1]], follow: [4, 3],
    }),
    build({
        id: 'pets', label: 'Pets', description: 'Dogs, cats, training clips and unreasonable amounts of them.',
        niche: 'pets',
        interests: ['dog', 'puppy', 'cat', 'kitten', 'dog training', 'rescue dog', 'vet',
            'pet care', '#dogtok', '#cattok'],
        avoid: ['gore', 'animal abuse'],
        curiosity: 0.5, warmth: 0.8,
        likes: [10, 22], saves: [1, 4], follows: [1, 3], searches: [0, 2],
        match: [12, 35], other: [3, 7], session: [12, 35], hours: [[7, 10], [18, 24]], follow: [3, 3],
    }),
    build({
        id: 'diy-home', label: 'DIY and home', description: 'Renovation, tools and repairs done at the weekend.',
        niche: 'diy home',
        interests: ['diy', 'renovation', 'power tools', 'tiling', 'plastering', 'flat pack',
            'garden makeover', 'home repair', '#diytok', '#homerenovation'],
        avoid: ['crypto', 'dropshipping'],
        curiosity: 0.35, warmth: 0.5,
        likes: [4, 10], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [25, 65], other: [3, 8], session: [12, 30], hours: [[8, 11], [19, 23]], follow: [3, 5],
    }),
    build({
        id: 'cars', label: 'Cars', description: 'Builds, detailing and what a first car should cost.',
        niche: 'cars',
        interests: ['car', 'car build', 'detailing', 'first car', 'engine swap', 'jdm', 'ev',
            'car review', '#cartok', '#carsoftiktok'],
        avoid: ['gambling', 'crypto', 'street takeover'],
        curiosity: 0.35, warmth: 0.45,
        likes: [5, 12], saves: [1, 5], follows: [0, 2], searches: [1, 3],
        match: [20, 55], other: [3, 7], session: [15, 35], hours: [[12, 14], [18, 24]], follow: [4, 5],
    }),
    build({
        id: 'study-productivity', label: 'Study and productivity', description: 'Revision, note taking and getting through exam season.',
        niche: 'study productivity',
        interests: ['study', 'revision', 'note taking', 'exam', 'pomodoro', 'flashcards',
            'time management', 'study with me', '#studytok', '#productivity'],
        avoid: ['gambling', 'get rich quick'],
        curiosity: 0.3, warmth: 0.4,
        likes: [4, 10], saves: [3, 9], follows: [0, 1], searches: [1, 3],
        match: [25, 60], other: [2, 6], session: [8, 20], hours: [[7, 9], [15, 18], [21, 23]], follow: [4, 5],
    }),
    build({
        id: 'mindfulness', label: 'Mindfulness', description: 'Breathwork, journaling and winding down at night.',
        niche: 'mindfulness',
        interests: ['mindfulness', 'meditation', 'breathwork', 'journaling', 'gratitude', 'anxiety',
            'sleep routine', 'grounding', '#mindfulness', '#meditation'],
        avoid: ['politics', 'gore', 'gambling'],
        curiosity: 0.25, warmth: 0.45,
        likes: [3, 8], saves: [2, 6], follows: [0, 1], searches: [0, 2],
        match: [30, 80], other: [3, 8], session: [6, 18], hours: [[6, 8], [21, 24]], follow: [3, 5],
    }),
];

export function findPreset(id: unknown): PersonaPreset | undefined {
    return typeof id === 'string' ? PERSONA_PRESETS.find((preset) => preset.id === id.trim()) : undefined;
}

/**
 * A preset, as a persona for one handle. Validated on the way through like anything else, so a
 * preset with a typo in it fails here rather than reaching the store.
 */
export function applyPreset(handle: string, id: unknown): Persona {
    const preset = findPreset(id);
    if (!preset) throw new PersonaError(`"${String(id)}" is not one of the presets`);
    return validatePersona(normaliseHandle(handle), preset.persona as unknown as Record<string, unknown>);
}
