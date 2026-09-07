/**
 * Personas people actually run.
 *
 * A persona has fourteen fields and every one of them matters, which is a lot to invent from a
 * blank form for the fortieth account on a farm. These are a hundred niches written out properly:
 * real interests and avoid lists, a warmth and a curiosity that suit the niche, budgets that a
 * person in it would plausibly spend, watch bands that reflect how long that content actually
 * holds someone, and the hours of the day they are on their phone. A runner is up at six and
 * watches a form clip right through; a comedy account is warm, curious, and gone in four seconds.
 *
 * They are grouped into twelve categories because a list of a hundred is not a list anybody reads.
 * The category is a label for the picker and for `docs/personas.md`; nothing downstream branches on
 * it, and an account is never "a Fitness account" — it is whatever its persona says.
 *
 * A preset is a starting point, never a lock-in: `applyPreset` runs the body through
 * `validatePersona` like any other input, and the editor fills the form with it rather than
 * saving it, so an operator always sees the values before they land. Several at once is
 * `blendPresets` in `blend.ts` — the operator picks "AI tools", "indie hacking" and "productivity"
 * and gets one account that sits in all three.
 */

import { PersonaError, normaliseHandle, validatePersona, type Persona } from './model.js';

/** Everything a preset sets. The handle is the account's; nothing else is inherited. */
export type PresetBody = Omit<Persona, 'handle' | 'presets'>;

/**
 * The groups, in the order the picker shows them — roughly "what a body does", then "what a life
 * has in it", then "what is on the screen".
 */
export const PRESET_CATEGORIES = [
    'Fitness & sport',
    'Food & drink',
    'Appearance',
    'Home',
    'Money & work',
    'Tech & product',
    'Learning',
    'Creative',
    'Entertainment',
    'Lifestyle',
    'Vehicles & travel',
    'Animals & nature',
] as const;

export type PresetCategory = (typeof PRESET_CATEGORIES)[number];

export interface PersonaPreset {
    /** Stable id: what the picker posts and what the API takes. */
    id: string;
    /** How it reads in the picker. */
    label: string;
    /** One line, in the operator's language, about who this account would be. */
    description: string;
    /** Which group of the picker it sits in. */
    category: PresetCategory;
    persona: PresetBody;
}

interface Draft {
    id: string;
    label: string;
    description: string;
    category: PresetCategory;
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
        category: draft.category,
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
 * The library. Ordered by category, and inside a category the way somebody scans a list — the
 * obvious ones first — rather than alphabetically.
 */
export const PERSONA_PRESETS: readonly PersonaPreset[] = [

    /* ---- Fitness & sport ----------------------------------------------- */

    build({
        id: 'fitness', label: 'Fitness', description: 'Gym sessions, form checks and progress clips.',
        category: 'Fitness & sport', niche: 'fitness',
        interests: ['gym', 'workout', 'lifting', 'squat', 'deadlift', 'bench press', 'progressive overload',
            'personal trainer', '#gymtok', '#fitness'],
        avoid: ['crypto', 'gambling', 'dropshipping'],
        curiosity: 0.3, warmth: 0.55,
        likes: [5, 12], saves: [1, 4], follows: [0, 2], searches: [0, 2],
        match: [14, 40], other: [2, 6], session: [12, 28], hours: [[6, 9], [17, 23]], follow: [3, 4],
    }),
    build({
        id: 'home-gym', label: 'Home gym', description: 'Garage racks, adjustable dumbbells and small-space setups.',
        category: 'Fitness & sport', niche: 'home gym',
        interests: ['home gym', 'garage gym', 'squat rack', 'power rack', 'adjustable dumbbells', 'kettlebell',
            'bumper plates', 'rubber flooring', '#homegym', '#garagegym'],
        avoid: ['makeup', 'nightclub', 'crypto'],
        curiosity: 0.2, warmth: 0.6,
        likes: [4, 10], saves: [2, 6], follows: [0, 1], searches: [1, 3],
        match: [18, 45], other: [2, 5], session: [10, 25], hours: [[6, 8], [18, 23]], follow: [3, 5],
    }),
    build({
        id: 'running', label: 'Running', description: 'Race training, splits, and far too many shoe reviews.',
        category: 'Fitness & sport', niche: 'running',
        interests: ['running', 'marathon', 'half marathon', '5k', '10k', 'tempo run', 'zone 2',
            'running shoes', 'race day', '#runtok'],
        avoid: ['gambling', 'weight loss pills'],
        curiosity: 0.25, warmth: 0.5,
        likes: [4, 9], saves: [1, 3], follows: [0, 1], searches: [1, 3],
        match: [15, 38], other: [2, 5], session: [8, 20], hours: [[5, 8], [18, 22]], follow: [3, 4],
    }),
    build({
        id: 'yoga', label: 'Yoga', description: 'Flows, hip openers and a mat by the window at seven.',
        category: 'Fitness & sport', niche: 'yoga',
        interests: ['yoga', 'vinyasa', 'yin yoga', 'sun salutation', 'hip openers', 'yoga flow',
            'downward dog', 'breathwork', '#yogatok', '#yoga'],
        avoid: ['gambling', 'crypto', 'diet pills'],
        curiosity: 0.3, warmth: 0.55,
        likes: [4, 10], saves: [2, 6], follows: [0, 1], searches: [1, 3],
        match: [30, 75], other: [3, 7], session: [10, 25], hours: [[6, 8], [19, 22]], follow: [3, 5],
    }),
    build({
        id: 'pilates', label: 'Pilates', description: 'Reformer classes, wall pilates and posture work.',
        category: 'Fitness & sport', niche: 'pilates',
        interests: ['pilates', 'reformer pilates', 'mat pilates', 'wall pilates', 'core work', 'posture',
            'glute bridge', 'hip mobility', '#pilatestok', '#pilates'],
        avoid: ['diet pills', 'gambling'],
        curiosity: 0.28, warmth: 0.55,
        likes: [5, 11], saves: [2, 6], follows: [0, 2], searches: [1, 3],
        match: [25, 60], other: [2, 6], session: [10, 24], hours: [[7, 9], [18, 22]], follow: [3, 4],
    }),
    build({
        id: 'calisthenics', label: 'Calisthenics', description: 'Pull-up bars, levers and a handstand that is nearly there.',
        category: 'Fitness & sport', niche: 'calisthenics',
        interests: ['calisthenics', 'pull ups', 'muscle up', 'handstand', 'front lever', 'dips',
            'street workout', 'bodyweight training', '#calisthenics', '#streetworkout'],
        avoid: ['steroids', 'gambling', 'crypto'],
        curiosity: 0.25, warmth: 0.5,
        likes: [5, 12], saves: [2, 5], follows: [0, 2], searches: [1, 3],
        match: [20, 55], other: [2, 6], session: [12, 28], hours: [[6, 9], [17, 22]], follow: [3, 4],
    }),
    build({
        id: 'cycling', label: 'Cycling', description: 'Road and gravel, watts, bike fits and long Sunday rides.',
        category: 'Fitness & sport', niche: 'cycling',
        interests: ['cycling', 'road bike', 'gravel bike', 'bike fit', 'ftp test', 'watts',
            'zwift', 'strava', '#cyclingtok', '#roadcycling'],
        avoid: ['gambling', 'crypto'],
        curiosity: 0.3, warmth: 0.45,
        likes: [4, 9], saves: [2, 6], follows: [0, 1], searches: [1, 3],
        match: [25, 65], other: [3, 7], session: [12, 30], hours: [[5, 8], [18, 22]], follow: [4, 5],
    }),
    build({
        id: 'swimming', label: 'Swimming', description: 'Stroke technique, lane sets and open water.',
        category: 'Fitness & sport', niche: 'swimming',
        interests: ['swimming', 'freestyle stroke', 'swim technique', 'open water swim', 'lap swimming',
            'flip turn', 'swim drills', 'triathlon', '#swimtok', '#swimming'],
        avoid: ['gore', 'gambling'],
        curiosity: 0.25, warmth: 0.45,
        likes: [3, 9], saves: [1, 5], follows: [0, 1], searches: [1, 3],
        match: [20, 55], other: [2, 6], session: [8, 20], hours: [[6, 8], [19, 22]], follow: [3, 5],
    }),
    build({
        id: 'martial-arts', label: 'Martial arts', description: 'Rolling, pad work and technique breakdowns.',
        category: 'Fitness & sport', niche: 'martial arts',
        interests: ['bjj', 'jiu jitsu', 'muay thai', 'boxing', 'sparring', 'guard pass',
            'mma', 'kickboxing', '#bjj', '#muaythai'],
        avoid: ['gore', 'street fight', 'gambling'],
        curiosity: 0.3, warmth: 0.5,
        likes: [5, 12], saves: [2, 6], follows: [0, 2], searches: [1, 3],
        match: [25, 70], other: [3, 7], session: [15, 35], hours: [[7, 9], [19, 23]], follow: [3, 4],
    }),
    build({
        id: 'golf', label: 'Golf', description: 'Swing changes, short game and a handicap going the wrong way.',
        category: 'Fitness & sport', niche: 'golf',
        interests: ['golf', 'golf swing', 'driver', 'putting', 'short game', 'golf course',
            'handicap', 'club fitting', '#golftok', '#golf'],
        avoid: ['gambling', 'crypto'],
        curiosity: 0.3, warmth: 0.45,
        likes: [4, 10], saves: [2, 6], follows: [0, 2], searches: [1, 3],
        match: [25, 60], other: [3, 7], session: [12, 30], hours: [[6, 9], [18, 22]], follow: [4, 5],
    }),
    build({
        id: 'basketball', label: 'Basketball', description: 'Highlights, handles and drills from the driveway.',
        category: 'Fitness & sport', niche: 'basketball',
        interests: ['basketball', 'nba', 'handles', 'jump shot', 'dunk', 'pick and roll',
            'ball handling drills', 'streetball', '#basketballtok', '#hoops'],
        avoid: ['gambling', 'betting picks'],
        curiosity: 0.4, warmth: 0.55,
        likes: [7, 16], saves: [1, 4], follows: [0, 2], searches: [0, 2],
        match: [15, 40], other: [2, 5], session: [15, 40], hours: [[12, 14], [18, 24]], follow: [4, 4],
    }),
    build({
        id: 'soccer', label: 'Football', description: 'Match clips, transfer talk and five-a-side on Thursdays.',
        category: 'Fitness & sport', niche: 'football',
        interests: ['football', 'soccer', 'premier league', 'transfer news', 'free kick',
            'first touch drills', 'goalkeeper', 'five a side', '#footballtok', '#soccer'],
        avoid: ['gambling', 'betting tips'],
        curiosity: 0.4, warmth: 0.55,
        likes: [8, 18], saves: [1, 4], follows: [0, 2], searches: [0, 2],
        match: [15, 42], other: [2, 5], session: [15, 40], hours: [[12, 14], [17, 24]], follow: [4, 4],
    }),
    build({
        id: 'hiking', label: 'Hiking and outdoors', description: 'Trails, day packs and summits worth the early start.',
        category: 'Fitness & sport', niche: 'hiking',
        interests: ['hiking', 'trail', 'thru hike', 'day hike', 'backpacking', 'trekking poles',
            'summit', 'national park', '#hikingtok', '#hiking'],
        avoid: ['gambling', 'crypto'],
        curiosity: 0.45, warmth: 0.6,
        likes: [5, 12], saves: [3, 8], follows: [0, 2], searches: [1, 3],
        match: [25, 70], other: [3, 8], session: [12, 30], hours: [[7, 10], [19, 23]], follow: [3, 5],
    }),
    build({
        id: 'camping', label: 'Camping', description: 'Tent setups, campfire cooking and gear laid out on the floor.',
        category: 'Fitness & sport', niche: 'camping',
        interests: ['camping', 'tent setup', 'campsite', 'campfire cooking', 'sleeping bag',
            'overlanding', 'bushcraft', 'gear check', '#camping', '#campvibes'],
        avoid: ['gambling', 'dropshipping'],
        curiosity: 0.4, warmth: 0.6,
        likes: [5, 12], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [25, 70], other: [3, 8], session: [12, 32], hours: [[8, 11], [19, 23]], follow: [3, 5],
    }),
    build({
        id: 'fishing', label: 'Fishing', description: 'Fly, carp and bass — tackle, knots and catch-and-cook.',
        category: 'Fitness & sport', niche: 'fishing',
        interests: ['fishing', 'fly fishing', 'bass fishing', 'carp fishing', 'tackle', 'lure',
            'catch and cook', 'river bank', '#fishingtok', '#flyfishing'],
        avoid: ['gambling', 'crypto'],
        curiosity: 0.3, warmth: 0.55,
        likes: [4, 10], saves: [2, 6], follows: [0, 2], searches: [1, 3],
        match: [30, 80], other: [3, 8], session: [15, 40], hours: [[5, 8], [19, 22]], follow: [3, 5],
    }),

    /* ---- Food & drink -------------------------------------------------- */

    build({
        id: 'cooking', label: 'Cooking', description: 'Weeknight dinners, one-pan things and knife work.',
        category: 'Food & drink', niche: 'cooking',
        interests: ['recipe', 'weeknight dinner', 'one pan', 'meal prep', 'pasta', 'curry', 'stir fry',
            'knife skills', '#cooking', '#recipe'],
        avoid: ['mukbang', 'diet pills'],
        curiosity: 0.4, warmth: 0.6,
        likes: [6, 14], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [20, 50], other: [3, 7], session: [12, 30], hours: [[11, 14], [16, 22]], follow: [3, 4],
    }),
    build({
        id: 'baking', label: 'Baking', description: 'Sourdough, laminated dough and cakes that take a weekend.',
        category: 'Food & drink', niche: 'baking',
        interests: ['baking', 'sourdough', 'bread', 'croissant', 'laminated dough', 'buttercream',
            'cake decorating', 'pastry', '#baketok', '#sourdough'],
        avoid: ['diet pills', 'mukbang'],
        curiosity: 0.3, warmth: 0.65,
        likes: [5, 12], saves: [3, 10], follows: [0, 2], searches: [1, 3],
        match: [25, 60], other: [3, 7], session: [15, 35], hours: [[9, 13], [19, 23]], follow: [3, 5],
    }),
    build({
        id: 'coffee', label: 'Coffee', description: 'Espresso dialling-in, pour over and a grinder budget out of hand.',
        category: 'Food & drink', niche: 'coffee',
        interests: ['coffee', 'espresso', 'latte art', 'pour over', 'v60', 'coffee beans',
            'grinder', 'flat white', '#coffeetok', '#specialtycoffee'],
        avoid: ['gambling', 'dropshipping', 'diet pills'],
        curiosity: 0.35, warmth: 0.6,
        likes: [6, 13], saves: [3, 8], follows: [0, 2], searches: [1, 3],
        match: [20, 50], other: [2, 6], session: [10, 25], hours: [[6, 10], [13, 15]], follow: [3, 4],
    }),
    build({
        id: 'cocktails-wine', label: 'Cocktails and wine', description: 'Home bar builds, negronis and natural wine.',
        category: 'Food & drink', niche: 'cocktails and wine',
        interests: ['cocktail', 'negroni', 'old fashioned', 'home bar', 'natural wine', 'wine tasting',
            'sommelier', 'whisky', '#cocktailtok', '#winetok'],
        avoid: ['gambling', 'binge drinking'],
        curiosity: 0.4, warmth: 0.6,
        likes: [6, 14], saves: [3, 8], follows: [0, 2], searches: [1, 3],
        match: [20, 50], other: [3, 7], session: [12, 30], hours: [[17, 20], [21, 24]], follow: [3, 4],
    }),
    build({
        id: 'meal-prep', label: 'Meal prep', description: 'Sunday batch cooking, macros and five identical lunches.',
        category: 'Food & drink', niche: 'meal prep',
        interests: ['meal prep', 'batch cooking', 'high protein', 'macros', 'sunday prep',
            'lunch ideas', 'freezer meals', 'protein bowl', '#mealprep', '#highprotein'],
        avoid: ['diet pills', 'detox tea'],
        curiosity: 0.3, warmth: 0.55,
        likes: [5, 12], saves: [4, 12], follows: [0, 2], searches: [1, 3],
        match: [25, 60], other: [2, 6], session: [10, 25], hours: [[9, 12], [18, 22]], follow: [3, 5],
    }),
    build({
        id: 'vegan', label: 'Vegan', description: 'Plant-based cooking, tofu that is actually good, and swaps.',
        category: 'Food & drink', niche: 'vegan',
        interests: ['vegan', 'plant based', 'tofu', 'tempeh', 'vegan recipe', 'dairy free',
            'seitan', 'chickpeas', '#vegantok', '#plantbased'],
        avoid: ['mukbang', 'diet pills', 'hunting'],
        curiosity: 0.35, warmth: 0.6,
        likes: [6, 14], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [25, 60], other: [3, 7], session: [12, 30], hours: [[11, 14], [18, 22]], follow: [3, 4],
    }),
    build({
        id: 'food-travel', label: 'Restaurants and food travel', description: 'Hidden gems, street food and where to eat in a new city.',
        category: 'Food & drink', niche: 'restaurants',
        interests: ['restaurant review', 'hidden gem', 'street food', 'food tour', 'michelin',
            'brunch spot', 'night market', 'where to eat', '#foodtok', '#streetfood'],
        avoid: ['mukbang', 'gambling'],
        curiosity: 0.55, warmth: 0.65,
        likes: [7, 16], saves: [4, 12], follows: [0, 2], searches: [1, 4],
        match: [20, 50], other: [3, 7], session: [15, 35], hours: [[12, 14], [19, 24]], follow: [3, 4],
    }),

    /* ---- Appearance ---------------------------------------------------- */

    build({
        id: 'beauty', label: 'Beauty', description: 'Makeup looks, hauls and the products behind them.',
        category: 'Appearance', niche: 'beauty',
        interests: ['makeup', 'foundation', 'eyeliner', 'lipstick', 'blush', 'contour', 'makeup haul',
            'get ready with me', '#makeuptok', '#beauty'],
        avoid: ['gore', 'politics'],
        curiosity: 0.45, warmth: 0.7,
        likes: [8, 18], saves: [2, 7], follows: [1, 3], searches: [1, 4],
        match: [15, 42], other: [2, 6], session: [15, 40], hours: [[8, 11], [19, 24]], follow: [3, 3],
    }),
    build({
        id: 'skincare', label: 'Skincare', description: 'Routines, actives, and dermatologists correcting them.',
        category: 'Appearance', niche: 'skincare',
        interests: ['skincare', 'retinol', 'niacinamide', 'spf', 'sunscreen', 'moisturiser', 'acne',
            'dermatologist', '#skincare', '#skintok'],
        avoid: ['gore', 'diet pills'],
        curiosity: 0.3, warmth: 0.55,
        likes: [5, 12], saves: [3, 8], follows: [0, 2], searches: [1, 4],
        match: [20, 48], other: [2, 6], session: [12, 28], hours: [[7, 10], [20, 24]], follow: [3, 4],
    }),
    build({
        id: 'fashion', label: 'Fashion', description: 'Outfits, thrifting and building a wardrobe that works.',
        category: 'Appearance', niche: 'fashion',
        interests: ['outfit', 'ootd', 'thrifting', 'capsule wardrobe', 'styling', 'denim', 'vintage',
            'street style', '#fashiontok', '#ootd'],
        avoid: ['gambling', 'dropshipping'],
        curiosity: 0.5, warmth: 0.65,
        likes: [7, 16], saves: [3, 9], follows: [1, 3], searches: [1, 3],
        match: [12, 35], other: [2, 5], session: [15, 35], hours: [[8, 10], [18, 24]], follow: [3, 3],
    }),
    build({
        id: 'hair', label: 'Hair', description: 'Curly routines, colour, blowouts and the salon chair.',
        category: 'Appearance', niche: 'hair',
        interests: ['hair', 'curly hair', 'hair routine', 'balayage', 'blowout', 'hair growth',
            'braids', 'barber', '#hairtok', '#curlyhair'],
        avoid: ['gore', 'politics'],
        curiosity: 0.4, warmth: 0.65,
        likes: [7, 16], saves: [3, 8], follows: [1, 3], searches: [1, 3],
        match: [18, 45], other: [2, 6], session: [15, 35], hours: [[8, 11], [19, 24]], follow: [3, 3],
    }),
    build({
        id: 'nails', label: 'Nails', description: 'Gel sets, nail art and the tech doing them.',
        category: 'Appearance', niche: 'nails',
        interests: ['nail art', 'gel nails', 'acrylics', 'nail tech', 'manicure', 'nail inspo',
            'builder gel', 'cuticle care', '#nailtok', '#nailart'],
        avoid: ['gore', 'politics'],
        curiosity: 0.35, warmth: 0.7,
        likes: [8, 18], saves: [3, 9], follows: [1, 3], searches: [1, 3],
        match: [15, 40], other: [2, 5], session: [12, 30], hours: [[9, 12], [19, 24]], follow: [3, 3],
    }),
    build({
        id: 'mens-grooming', label: 'Mens grooming', description: 'Fades, beard trims, fragrance and a two-step routine.',
        category: 'Appearance', niche: 'mens grooming',
        interests: ['mens grooming', 'beard trim', 'barber', 'fade haircut', 'skincare for men',
            'hair styling', 'fragrance', 'cologne', '#menshair', '#groomingtips'],
        avoid: ['gore', 'gambling'],
        curiosity: 0.35, warmth: 0.5,
        likes: [5, 12], saves: [2, 7], follows: [0, 2], searches: [1, 3],
        match: [18, 45], other: [2, 6], session: [10, 25], hours: [[7, 9], [19, 23]], follow: [3, 4],
    }),
    build({
        id: 'streetwear', label: 'Streetwear', description: 'Sneakers, drops, outfit grids and thrift flips.',
        category: 'Appearance', niche: 'streetwear',
        interests: ['streetwear', 'sneakers', 'hypebeast', 'thrift flip', 'jordan 1', 'drop',
            'outfit grid', 'techwear', '#streetwear', '#sneakertok'],
        avoid: ['gambling', 'replica sellers'],
        curiosity: 0.5, warmth: 0.6,
        likes: [8, 18], saves: [3, 8], follows: [1, 3], searches: [1, 3],
        match: [12, 35], other: [2, 5], session: [15, 40], hours: [[12, 14], [18, 24]], follow: [3, 3],
    }),

    /* ---- Home ---------------------------------------------------------- */

    build({
        id: 'diy-home', label: 'DIY and home', description: 'Renovation, tools and repairs done at the weekend.',
        category: 'Home', niche: 'diy home',
        interests: ['diy', 'renovation', 'power tools', 'tiling', 'plastering', 'flat pack',
            'garden makeover', 'home repair', '#diytok', '#homerenovation'],
        avoid: ['crypto', 'dropshipping'],
        curiosity: 0.35, warmth: 0.5,
        likes: [4, 10], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [25, 65], other: [3, 8], session: [12, 30], hours: [[8, 11], [19, 23]], follow: [3, 5],
    }),
    build({
        id: 'interior-design', label: 'Interior design', description: 'Mood boards, palettes and rooms that were beige on Monday.',
        category: 'Home', niche: 'interior design',
        interests: ['interior design', 'home decor', 'mood board', 'colour palette', 'living room',
            'styling shelves', 'mid century', 'lighting design', '#interiordesign', '#homedecor'],
        avoid: ['dropshipping', 'crypto'],
        curiosity: 0.45, warmth: 0.6,
        likes: [6, 14], saves: [4, 12], follows: [1, 3], searches: [1, 3],
        match: [20, 50], other: [3, 7], session: [15, 35], hours: [[9, 12], [19, 23]], follow: [3, 4],
    }),
    build({
        id: 'plants-gardening', label: 'Plants and gardening', description: 'Houseplants, propagation and an allotment in April.',
        category: 'Home', niche: 'plants and gardening',
        interests: ['houseplants', 'monstera', 'propagation', 'repotting', 'allotment', 'raised beds',
            'seed starting', 'compost', '#planttok', '#gardening'],
        avoid: ['gambling', 'crypto'],
        curiosity: 0.35, warmth: 0.65,
        likes: [6, 14], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [25, 60], other: [3, 7], session: [12, 30], hours: [[7, 10], [17, 21]], follow: [3, 5],
    }),
    build({
        id: 'minimalism', label: 'Minimalism', description: 'Owning less on purpose — decluttering and slow living.',
        category: 'Home', niche: 'minimalism',
        interests: ['minimalism', 'decluttering', 'capsule living', 'own less', 'slow living',
            'intentional living', 'no buy year', 'simple home', '#minimalism', '#slowliving'],
        avoid: ['dropshipping', 'haul', 'gambling'],
        curiosity: 0.3, warmth: 0.45,
        likes: [4, 9], saves: [2, 7], follows: [0, 1], searches: [1, 3],
        match: [30, 70], other: [2, 6], session: [8, 20], hours: [[7, 9], [20, 23]], follow: [4, 5],
    }),
    build({
        id: 'organising', label: 'Cleaning and organising', description: 'Deep cleans, restocks and a pantry in matching jars.',
        category: 'Home', niche: 'cleaning and organising',
        interests: ['cleaning', 'cleaning hacks', 'deep clean', 'restock', 'decluttering', 'laundry',
            'organisation', 'pantry organisation', '#cleantok', '#organisation'],
        avoid: ['gore', 'gambling'],
        curiosity: 0.35, warmth: 0.6,
        likes: [7, 16], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [20, 50], other: [2, 6], session: [15, 35], hours: [[9, 12], [19, 23]], follow: [3, 4],
    }),
    build({
        id: 'van-life', label: 'Van life', description: 'Camper builds, solar setups and waking up somewhere else.',
        category: 'Home', niche: 'van life',
        interests: ['van life', 'van build', 'camper conversion', 'off grid', 'solar setup',
            'roof rack', 'van tour', 'boondocking', '#vanlife', '#vanbuild'],
        avoid: ['gambling', 'crypto'],
        curiosity: 0.4, warmth: 0.6,
        likes: [5, 12], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [30, 80], other: [3, 8], session: [15, 40], hours: [[8, 11], [19, 23]], follow: [3, 5],
    }),

    /* ---- Money & work -------------------------------------------------- */

    build({
        id: 'personal-finance', label: 'Personal finance', description: 'Budgeting, index funds and getting out of debt.',
        category: 'Money & work', niche: 'personal finance',
        interests: ['budgeting', 'index funds', 'emergency fund', 'debt payoff', 'pension', 'isa',
            'saving money', 'credit score', '#moneytok', '#personalfinance'],
        avoid: ['crypto', 'nft', 'forex', 'gambling', 'get rich quick'],
        curiosity: 0.25, warmth: 0.35,
        likes: [3, 8], saves: [2, 7], follows: [0, 1], searches: [1, 3],
        match: [30, 70], other: [3, 8], session: [10, 25], hours: [[7, 9], [20, 23]], follow: [4, 6],
    }),
    build({
        id: 'real-estate', label: 'Real estate', description: 'House tours, first-time buyers and rental numbers.',
        category: 'Money & work', niche: 'real estate',
        interests: ['house tour', 'first time buyer', 'mortgage', 'rental property', 'landlord', 'renovation budget',
            'property market', 'open house', '#realestate', '#hometour'],
        avoid: ['crypto', 'get rich quick', 'gambling'],
        curiosity: 0.3, warmth: 0.35,
        likes: [3, 8], saves: [2, 6], follows: [0, 1], searches: [1, 3],
        match: [30, 75], other: [3, 8], session: [10, 25], hours: [[8, 10], [19, 23]], follow: [4, 6],
    }),
    build({
        id: 'side-hustles', label: 'Side hustles', description: 'Evening income — reselling, print on demand, first orders.',
        category: 'Money & work', niche: 'side hustles',
        interests: ['side hustle', 'extra income', 'print on demand', 'etsy shop', 'freelance gig',
            'weekend business', 'passive income', 'reselling', '#sidehustle', '#makemoneyonline'],
        avoid: ['gambling', 'get rich quick', 'forex', 'crypto'],
        curiosity: 0.45, warmth: 0.4,
        likes: [4, 10], saves: [3, 9], follows: [0, 2], searches: [1, 4],
        match: [25, 60], other: [3, 7], session: [12, 30], hours: [[7, 9], [20, 24]], follow: [4, 5],
    }),
    build({
        id: 'entrepreneurship', label: 'Small business', description: 'Owners packing orders, cash flow and the first hire.',
        category: 'Money & work', niche: 'small business',
        interests: ['small business', 'entrepreneur', 'business owner', 'packing orders', 'first sale',
            'cash flow', 'hiring', 'business advice', '#smallbusiness', '#entrepreneur'],
        avoid: ['gambling', 'get rich quick', 'mlm'],
        curiosity: 0.4, warmth: 0.45,
        likes: [5, 11], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [25, 65], other: [3, 7], session: [12, 30], hours: [[7, 9], [12, 14], [20, 23]], follow: [4, 5],
    }),
    build({
        id: 'marketing-growth', label: 'Marketing and growth', description: 'Hooks, content strategy, UGC and what the analytics said.',
        category: 'Money & work', niche: 'marketing and growth',
        interests: ['social media marketing', 'content strategy', 'hook', 'engagement rate', 'ugc',
            'brand deals', 'seo', 'ad creative', '#marketingtips', '#socialmediatips'],
        avoid: ['gambling', 'get rich quick', 'follower bots'],
        curiosity: 0.5, warmth: 0.45,
        likes: [6, 14], saves: [4, 12], follows: [1, 3], searches: [1, 4],
        match: [25, 60], other: [3, 7], session: [15, 35], hours: [[8, 11], [13, 15], [20, 23]], follow: [4, 4],
    }),
    build({
        id: 'career-job-search', label: 'Career and job search', description: 'CVs, interview questions and asking for the raise.',
        category: 'Money & work', niche: 'career',
        interests: ['job search', 'cv tips', 'resume', 'interview questions', 'linkedin',
            'cover letter', 'salary negotiation', 'career change', '#jobsearch', '#careertips'],
        avoid: ['gambling', 'get rich quick', 'mlm'],
        curiosity: 0.35, warmth: 0.4,
        likes: [4, 10], saves: [4, 12], follows: [0, 2], searches: [1, 4],
        match: [25, 65], other: [2, 6], session: [10, 25], hours: [[7, 9], [12, 14], [20, 23]], follow: [4, 6],
    }),
    build({
        id: 'freelancing', label: 'Freelancing', description: 'Rates, scope creep, invoices and finding the next client.',
        category: 'Money & work', niche: 'freelancing',
        interests: ['freelancing', 'client work', 'freelance rates', 'upwork', 'invoicing',
            'scope creep', 'portfolio', 'contract work', '#freelancer', '#freelancelife'],
        avoid: ['gambling', 'get rich quick', 'mlm'],
        curiosity: 0.4, warmth: 0.45,
        likes: [5, 11], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [25, 60], other: [3, 7], session: [12, 30], hours: [[8, 10], [13, 15], [20, 23]], follow: [4, 5],
    }),
    build({
        id: 'crypto-web3', label: 'Crypto and web3', description: 'Self-custody and on-chain talk — interested, and slow to like.',
        category: 'Money & work', niche: 'crypto and web3',
        interests: ['crypto', 'bitcoin', 'ethereum', 'defi', 'self custody', 'cold wallet',
            'on chain', 'stablecoin', '#cryptotok', '#bitcoin'],
        avoid: ['get rich quick', 'gambling', 'pump and dump', 'signal group'],
        curiosity: 0.35, warmth: 0.2,
        likes: [2, 6], saves: [2, 6], follows: [0, 1], searches: [1, 3],
        match: [25, 60], other: [2, 6], session: [10, 25], hours: [[7, 9], [21, 24]], follow: [5, 8],
    }),
    build({
        id: 'stock-trading', label: 'Stock trading', description: 'Earnings, charts and a portfolio checked far too often.',
        category: 'Money & work', niche: 'stock trading',
        interests: ['stocks', 'stock market', 'earnings report', 'ticker', 'options trading',
            'chart analysis', 'dividend stocks', 'portfolio', '#stocktok', '#investing'],
        avoid: ['pump and dump', 'gambling', 'signal group', 'get rich quick'],
        curiosity: 0.3, warmth: 0.3,
        likes: [3, 8], saves: [2, 7], follows: [0, 1], searches: [1, 4],
        match: [25, 60], other: [2, 6], session: [10, 25], hours: [[6, 9], [14, 17], [21, 23]], follow: [5, 7],
    }),

    /* ---- Tech & product ------------------------------------------------ */

    build({
        id: 'tech-gadgets', label: 'Tech gadgets', description: 'Phones, keyboards, desk setups and teardowns.',
        category: 'Tech & product', niche: 'tech gadgets',
        interests: ['gadget', 'smartphone', 'mechanical keyboard', 'desk setup', 'unboxing', 'benchmark',
            'battery life', 'teardown', '#techtok', '#gadgets'],
        avoid: ['crypto', 'nft', 'dropshipping'],
        curiosity: 0.45, warmth: 0.4,
        likes: [4, 10], saves: [2, 6], follows: [0, 2], searches: [1, 4],
        match: [25, 60], other: [3, 8], session: [15, 40], hours: [[12, 14], [19, 24]], follow: [4, 5],
    }),
    build({
        id: 'ai-tools', label: 'AI tools', description: 'Models, prompts, agents and the workflow around them.',
        category: 'Tech & product', niche: 'ai tools',
        interests: ['ai tools', 'chatgpt', 'prompt', 'llm', 'ai agent', 'midjourney',
            'automation workflow', 'copilot', '#aitools', '#ai'],
        avoid: ['crypto', 'nft', 'get rich quick'],
        curiosity: 0.55, warmth: 0.45,
        likes: [5, 12], saves: [4, 12], follows: [1, 3], searches: [2, 5],
        match: [25, 65], other: [3, 7], session: [15, 35], hours: [[8, 10], [13, 15], [21, 24]], follow: [4, 4],
    }),
    build({
        id: 'indie-hacking', label: 'Indie hacking', description: 'Building in public — MRR screenshots, launches, solo founders.',
        category: 'Tech & product', niche: 'indie hacking',
        interests: ['indie hacker', 'building in public', 'side project', 'mrr', 'launch day',
            'product hunt', 'solo founder', 'shipping', '#buildinpublic', '#indiehackers'],
        avoid: ['crypto', 'get rich quick', 'dropshipping'],
        curiosity: 0.5, warmth: 0.5,
        likes: [6, 14], saves: [3, 9], follows: [1, 3], searches: [1, 4],
        match: [25, 65], other: [3, 7], session: [15, 35], hours: [[7, 9], [13, 15], [21, 24]], follow: [3, 4],
    }),
    build({
        id: 'no-code', label: 'No-code', description: 'Bubble, Webflow, Airtable and automations held together with Zapier.',
        category: 'Tech & product', niche: 'no-code',
        interests: ['no code', 'bubble', 'webflow', 'airtable', 'zapier', 'make automation',
            'glide app', 'notion database', '#nocode', '#automation'],
        avoid: ['crypto', 'get rich quick'],
        curiosity: 0.5, warmth: 0.45,
        likes: [5, 12], saves: [4, 12], follows: [0, 2], searches: [2, 5],
        match: [30, 70], other: [3, 7], session: [15, 35], hours: [[9, 12], [20, 23]], follow: [4, 5],
    }),
    build({
        id: 'dev-tools', label: 'Programming', description: 'Languages, editors, git and the argument about tabs.',
        category: 'Tech & product', niche: 'programming',
        interests: ['programming', 'typescript', 'python', 'git', 'vs code', 'terminal',
            'refactoring', 'code review', '#devtok', '#programming'],
        avoid: ['crypto', 'nft', 'dropshipping'],
        curiosity: 0.4, warmth: 0.35,
        likes: [4, 10], saves: [3, 9], follows: [0, 2], searches: [1, 4],
        match: [30, 80], other: [2, 6], session: [15, 40], hours: [[9, 12], [14, 18], [21, 24]], follow: [4, 6],
    }),
    build({
        id: 'saas-productivity', label: 'Productivity apps', description: 'Notion, Obsidian, second brains and calendar blocking.',
        category: 'Tech & product', niche: 'productivity',
        interests: ['notion', 'obsidian', 'todoist', 'second brain', 'workflow', 'productivity app',
            'calendar blocking', 'task manager', '#notiontok', '#productivityapps'],
        avoid: ['crypto', 'get rich quick'],
        curiosity: 0.45, warmth: 0.45,
        likes: [5, 12], saves: [4, 12], follows: [0, 2], searches: [1, 4],
        match: [25, 60], other: [2, 6], session: [12, 30], hours: [[7, 9], [13, 15], [20, 23]], follow: [4, 5],
    }),
    build({
        id: 'cybersecurity', label: 'Cybersecurity', description: 'Phishing teardowns, breaches, CTFs and password hygiene.',
        category: 'Tech & product', niche: 'cybersecurity',
        interests: ['cybersecurity', 'infosec', 'phishing', 'password manager', 'two factor',
            'ctf', 'pentest', 'data breach', '#cybersecurity', '#infosec'],
        avoid: ['crypto', 'hacking services', 'gambling'],
        curiosity: 0.35, warmth: 0.3,
        likes: [3, 9], saves: [3, 9], follows: [0, 1], searches: [1, 4],
        match: [30, 80], other: [2, 6], session: [12, 30], hours: [[8, 10], [20, 24]], follow: [5, 6],
    }),
    build({
        id: 'pc-building', label: 'PC building', description: 'Parts lists, cable management and frames per second.',
        category: 'Tech & product', niche: 'pc building',
        interests: ['pc build', 'gpu', 'cpu cooler', 'cable management', 'custom loop', 'motherboard',
            'ram', 'benchmark fps', '#pcbuild', '#pcmasterrace'],
        avoid: ['crypto', 'mining rig', 'gambling'],
        curiosity: 0.4, warmth: 0.45,
        likes: [5, 12], saves: [2, 7], follows: [0, 2], searches: [1, 4],
        match: [25, 70], other: [3, 8], session: [15, 40], hours: [[15, 18], [19, 24]], follow: [4, 5],
    }),

    /* ---- Learning ------------------------------------------------------ */

    build({
        id: 'study-productivity', label: 'Study and productivity', description: 'Revision, note taking and getting through exam season.',
        category: 'Learning', niche: 'study productivity',
        interests: ['study', 'revision', 'note taking', 'exam', 'pomodoro', 'flashcards',
            'time management', 'study with me', '#studytok', '#productivity'],
        avoid: ['gambling', 'get rich quick'],
        curiosity: 0.3, warmth: 0.4,
        likes: [4, 10], saves: [3, 9], follows: [0, 1], searches: [1, 3],
        match: [25, 60], other: [2, 6], session: [8, 20], hours: [[7, 9], [15, 18], [21, 23]], follow: [4, 5],
    }),
    build({
        id: 'language-learning', label: 'Language learning', description: 'Vocabulary, immersion clips and a streak worth protecting.',
        category: 'Learning', niche: 'language learning',
        interests: ['language learning', 'spanish', 'french', 'duolingo', 'vocabulary',
            'immersion', 'grammar', 'pronunciation', '#langtok', '#learnspanish'],
        avoid: ['gambling', 'get rich quick'],
        curiosity: 0.4, warmth: 0.5,
        likes: [5, 12], saves: [4, 12], follows: [0, 2], searches: [1, 4],
        match: [25, 60], other: [2, 6], session: [10, 25], hours: [[7, 9], [12, 14], [20, 23]], follow: [4, 5],
    }),
    build({
        id: 'science', label: 'Science', description: 'Physics, space and explainers that run the full minute.',
        category: 'Learning', niche: 'science',
        interests: ['science', 'physics', 'astronomy', 'biology', 'chemistry', 'space',
            'experiment', 'research paper', '#sciencetok', '#space'],
        avoid: ['conspiracy', 'gambling', 'politics'],
        curiosity: 0.5, warmth: 0.4,
        likes: [5, 12], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [30, 90], other: [3, 8], session: [15, 35], hours: [[12, 14], [20, 24]], follow: [4, 5],
    }),
    build({
        id: 'history', label: 'History', description: 'Rome, the war, archaeology and long documentary clips.',
        category: 'Learning', niche: 'history',
        interests: ['history', 'ancient rome', 'world war two', 'archaeology', 'medieval',
            'historical documentary', 'museum', 'primary sources', '#historytok', '#history'],
        avoid: ['conspiracy', 'politics', 'gore'],
        curiosity: 0.45, warmth: 0.4,
        likes: [5, 12], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [35, 95], other: [3, 8], session: [15, 40], hours: [[13, 15], [20, 24]], follow: [4, 5],
    }),
    build({
        id: 'books', label: 'Books and reading', description: 'BookTok — recommendations, TBR piles and annotated paperbacks.',
        category: 'Learning', niche: 'books and reading',
        interests: ['booktok', 'reading', 'book recommendations', 'fantasy novel', 'romantasy',
            'tbr', 'annotations', 'library haul', '#booktok', '#reading'],
        avoid: ['gore', 'politics'],
        curiosity: 0.4, warmth: 0.65,
        likes: [7, 16], saves: [4, 12], follows: [1, 3], searches: [1, 3],
        match: [20, 55], other: [2, 6], session: [15, 35], hours: [[8, 10], [20, 24]], follow: [3, 3],
    }),
    build({
        id: 'writing', label: 'Writing', description: 'Drafts, plot structure, querying agents and self publishing.',
        category: 'Learning', niche: 'writing',
        interests: ['writing', 'first draft', 'nanowrimo', 'plot structure', 'character arc',
            'querying agents', 'self publishing', 'editing', '#writertok', '#amwriting'],
        avoid: ['gambling', 'get rich quick'],
        curiosity: 0.4, warmth: 0.5,
        likes: [5, 12], saves: [4, 12], follows: [0, 2], searches: [1, 3],
        match: [25, 70], other: [2, 6], session: [12, 30], hours: [[6, 9], [21, 24]], follow: [4, 5],
    }),

    /* ---- Creative ------------------------------------------------------ */

    build({
        id: 'photography', label: 'Photography', description: 'Primes, golden hour, Lightroom and street shooting.',
        category: 'Creative', niche: 'photography',
        interests: ['photography', 'lightroom', 'prime lens', 'golden hour', 'street photography',
            'film camera', 'editing preset', 'composition', '#photographytok', '#photography'],
        avoid: ['gambling', 'dropshipping'],
        curiosity: 0.45, warmth: 0.55,
        likes: [6, 14], saves: [4, 12], follows: [1, 3], searches: [1, 3],
        match: [25, 65], other: [3, 7], session: [15, 35], hours: [[8, 10], [18, 22]], follow: [3, 4],
    }),
    build({
        id: 'filmmaking', label: 'Filmmaking', description: 'Cinematography, colour grading and b-roll breakdowns.',
        category: 'Creative', niche: 'filmmaking',
        interests: ['filmmaking', 'cinematography', 'colour grading', 'b roll', 'camera movement',
            'lighting setup', 'short film', 'davinci resolve', '#filmtok', '#cinematography'],
        avoid: ['gambling', 'dropshipping'],
        curiosity: 0.45, warmth: 0.5,
        likes: [5, 12], saves: [4, 12], follows: [1, 3], searches: [1, 4],
        match: [30, 80], other: [3, 8], session: [15, 40], hours: [[11, 14], [20, 24]], follow: [4, 5],
    }),
    build({
        id: 'music-production', label: 'Music production', description: 'Ableton, sample flips, mixing and beats at midnight.',
        category: 'Creative', niche: 'music production',
        interests: ['music production', 'ableton', 'fl studio', 'sample flip', 'mixing',
            'mastering', 'sound design', 'beat making', '#musicproduction', '#beatmaker'],
        avoid: ['gambling', 'crypto'],
        curiosity: 0.45, warmth: 0.5,
        likes: [6, 14], saves: [3, 9], follows: [1, 3], searches: [1, 4],
        match: [25, 70], other: [3, 7], session: [20, 50], hours: [[14, 17], [21, 24], [0, 2]], follow: [4, 5],
    }),
    build({
        id: 'guitar', label: 'Guitar', description: 'Riffs, fingerstyle, pedalboards and practice routines.',
        category: 'Creative', niche: 'guitar',
        interests: ['guitar', 'guitar riff', 'fingerstyle', 'chord progression', 'pedalboard',
            'strat', 'bass guitar', 'practice routine', '#guitartok', '#guitarist'],
        avoid: ['gambling', 'crypto'],
        curiosity: 0.4, warmth: 0.6,
        likes: [7, 16], saves: [3, 9], follows: [1, 3], searches: [1, 3],
        match: [20, 55], other: [2, 6], session: [15, 35], hours: [[17, 20], [21, 24]], follow: [3, 4],
    }),
    build({
        id: 'drawing', label: 'Drawing and digital art', description: 'Sketchbooks, Procreate timelapses and character design.',
        category: 'Creative', niche: 'drawing',
        interests: ['drawing', 'sketchbook', 'procreate', 'digital art', 'line art', 'shading',
            'character design', 'art process', '#arttok', '#digitalart'],
        avoid: ['ai art', 'gore', 'art theft'],
        curiosity: 0.45, warmth: 0.65,
        likes: [8, 18], saves: [4, 12], follows: [1, 3], searches: [1, 3],
        match: [20, 60], other: [2, 6], session: [15, 40], hours: [[13, 16], [20, 24]], follow: [3, 3],
    }),
    build({
        id: 'graphic-design', label: 'Graphic design', description: 'Typography, logos, Figma and colour theory.',
        category: 'Creative', niche: 'graphic design',
        interests: ['graphic design', 'typography', 'logo design', 'brand identity', 'figma',
            'colour theory', 'layout', 'poster design', '#graphicdesign', '#designtok'],
        avoid: ['crypto', 'nft', 'dropshipping'],
        curiosity: 0.45, warmth: 0.5,
        likes: [5, 12], saves: [4, 12], follows: [1, 3], searches: [1, 4],
        match: [20, 55], other: [2, 6], session: [12, 30], hours: [[9, 12], [14, 18]], follow: [4, 4],
    }),
    build({
        id: 'game-dev-3d', label: '3D and game dev', description: 'Unity, Unreal, Blender and devlogs at two in the morning.',
        category: 'Creative', niche: '3d and game dev',
        interests: ['game dev', 'unity', 'unreal engine', 'blender', '3d modelling', 'shader',
            'devlog', 'level design', '#gamedev', '#blender3d'],
        avoid: ['crypto', 'nft', 'gambling'],
        curiosity: 0.45, warmth: 0.45,
        likes: [5, 12], saves: [3, 9], follows: [0, 2], searches: [1, 4],
        match: [30, 80], other: [3, 8], session: [20, 50], hours: [[13, 16], [20, 24], [0, 1]], follow: [4, 5],
    }),

    /* ---- Entertainment ------------------------------------------------- */

    build({
        id: 'comedy', label: 'Comedy', description: 'Sketches and bits — warm, easily distracted, gone in four seconds.',
        category: 'Entertainment', niche: 'comedy',
        interests: ['comedy', 'sketch', 'standup', 'skit', 'prank', 'impression', 'punchline',
            'funny', '#comedytok', '#funny'],
        avoid: ['gore', 'politics'],
        curiosity: 0.75, warmth: 0.75,
        likes: [10, 25], saves: [0, 3], follows: [0, 3], searches: [0, 1],
        match: [10, 30], other: [2, 4], session: [15, 45], hours: [[12, 14], [18, 24], [0, 1]], follow: [4, 3],
    }),
    build({
        id: 'gaming', label: 'Gaming', description: 'Playthroughs, patch notes and setups worth more than the car.',
        category: 'Entertainment', niche: 'gaming',
        interests: ['gaming', 'speedrun', 'patch notes', 'boss fight', 'indie game', 'controller',
            'pc build', 'gameplay', '#gamingtok', '#gamer'],
        avoid: ['gambling', 'crypto', 'csgo skins'],
        curiosity: 0.4, warmth: 0.5,
        likes: [6, 15], saves: [1, 4], follows: [0, 2], searches: [1, 3],
        match: [25, 70], other: [3, 8], session: [20, 60], hours: [[16, 24], [0, 2]], follow: [4, 5],
    }),
    build({
        id: 'film-tv', label: 'Film and TV', description: 'Reviews, recommendations, Letterboxd and what to watch tonight.',
        category: 'Entertainment', niche: 'film and tv',
        interests: ['film review', 'movie recommendation', 'tv show', 'letterboxd', 'box office',
            'series finale', 'film analysis', 'streaming release', '#filmtok', '#movietok'],
        avoid: ['gore', 'politics', 'leaks'],
        curiosity: 0.5, warmth: 0.55,
        likes: [7, 16], saves: [2, 7], follows: [0, 2], searches: [1, 3],
        match: [20, 60], other: [3, 7], session: [15, 40], hours: [[12, 14], [19, 24]], follow: [4, 4],
    }),
    build({
        id: 'anime', label: 'Anime', description: 'Seasonal watchlists, manga panels and edits on loop.',
        category: 'Entertainment', niche: 'anime',
        interests: ['anime', 'manga', 'one piece', 'shonen', 'anime edit', 'sub vs dub',
            'seasonal anime', 'studio ghibli', '#animetok', '#anime'],
        avoid: ['gore', 'politics', 'spoilers'],
        curiosity: 0.45, warmth: 0.7,
        likes: [10, 22], saves: [2, 7], follows: [1, 3], searches: [1, 3],
        match: [15, 45], other: [2, 5], session: [20, 50], hours: [[15, 18], [20, 24], [0, 2]], follow: [3, 3],
    }),
    build({
        id: 'true-crime', label: 'True crime', description: 'Cold cases and court footage — watches the whole thing, likes rarely.',
        category: 'Entertainment', niche: 'true crime',
        interests: ['true crime', 'cold case', 'unsolved', 'court footage', 'documentary',
            'case update', 'detective', 'forensics', '#truecrimetok', '#truecrime'],
        avoid: ['gore', 'conspiracy', 'politics'],
        curiosity: 0.35, warmth: 0.45,
        likes: [5, 12], saves: [2, 7], follows: [0, 2], searches: [1, 3],
        match: [40, 120], other: [3, 8], session: [20, 50], hours: [[12, 14], [21, 24], [0, 1]], follow: [4, 5],
    }),
    build({
        id: 'podcasts', label: 'Podcasts', description: 'Long-form clips, guest episodes and a listening queue.',
        category: 'Entertainment', niche: 'podcasts',
        interests: ['podcast', 'podcast clip', 'interview', 'long form', 'guest episode',
            'audio setup', 'episode recap', 'listening queue', '#podcasttok', '#podcastclips'],
        avoid: ['politics', 'gambling', 'gore'],
        curiosity: 0.5, warmth: 0.45,
        likes: [5, 12], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [30, 90], other: [3, 8], session: [15, 40], hours: [[7, 9], [17, 19], [21, 24]], follow: [4, 5],
    }),
    build({
        id: 'streaming-creators', label: 'Streamers', description: 'Twitch clips, stream setups and who is live tonight.',
        category: 'Entertainment', niche: 'streamers',
        interests: ['twitch', 'streamer', 'stream highlights', 'just chatting', 'stream setup',
            'vod', 'creator news', 'sub goal', '#twitchtok', '#streamer'],
        avoid: ['gambling', 'crypto', 'gore'],
        curiosity: 0.5, warmth: 0.6,
        likes: [8, 18], saves: [1, 5], follows: [1, 3], searches: [0, 2],
        match: [15, 45], other: [2, 5], session: [20, 60], hours: [[16, 19], [20, 24], [0, 2]], follow: [4, 3],
    }),
    build({
        id: 'esports', label: 'Esports', description: 'Tournaments, roster moves and clutch plays.',
        category: 'Entertainment', niche: 'esports',
        interests: ['esports', 'valorant', 'league of legends', 'counter strike', 'tournament',
            'roster move', 'clutch play', 'pro scrim', '#esports', '#valorant'],
        avoid: ['gambling', 'skin betting', 'crypto'],
        curiosity: 0.4, warmth: 0.55,
        likes: [8, 18], saves: [1, 5], follows: [0, 2], searches: [1, 3],
        match: [20, 55], other: [2, 6], session: [20, 50], hours: [[16, 19], [20, 24], [0, 2]], follow: [4, 4],
    }),
    build({
        id: 'board-games', label: 'Board games and TTRPG', description: 'Game nights, deck builders, minis and D&D tables.',
        category: 'Entertainment', niche: 'board games',
        interests: ['board games', 'tabletop', 'dungeons and dragons', 'board game night',
            'deck building', 'miniatures', 'painting minis', 'rules explainer', '#boardgametok', '#dnd'],
        avoid: ['gambling', 'crypto'],
        curiosity: 0.4, warmth: 0.6,
        likes: [6, 14], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [25, 70], other: [3, 7], session: [15, 40], hours: [[13, 16], [19, 23]], follow: [3, 4],
    }),

    /* ---- Lifestyle ----------------------------------------------------- */

    build({
        id: 'mindfulness', label: 'Mindfulness', description: 'Breathwork, journaling and winding down at night.',
        category: 'Lifestyle', niche: 'mindfulness',
        interests: ['mindfulness', 'meditation', 'breathwork', 'journaling', 'gratitude', 'anxiety',
            'sleep routine', 'grounding', '#mindfulness', '#meditation'],
        avoid: ['politics', 'gore', 'gambling'],
        curiosity: 0.25, warmth: 0.45,
        likes: [3, 8], saves: [2, 6], follows: [0, 1], searches: [0, 2],
        match: [30, 80], other: [3, 8], session: [6, 18], hours: [[6, 8], [21, 24]], follow: [3, 5],
    }),
    build({
        id: 'parenting', label: 'Parenting', description: 'Toddlers, sleep, school runs and other people surviving them.',
        category: 'Lifestyle', niche: 'parenting',
        interests: ['toddler', 'newborn', 'sleep training', 'weaning', 'school run', 'tantrum',
            'nursery', 'parenting hacks', '#momtok', '#parenting'],
        avoid: ['gore', 'politics', 'diet pills'],
        curiosity: 0.35, warmth: 0.7,
        likes: [6, 14], saves: [2, 7], follows: [0, 2], searches: [0, 2],
        match: [15, 40], other: [2, 6], session: [8, 20], hours: [[6, 8], [12, 14], [20, 23]], follow: [3, 4],
    }),
    build({
        id: 'dating', label: 'Dating and relationships', description: 'First dates, situationships and advice given far too confidently.',
        category: 'Lifestyle', niche: 'dating and relationships',
        interests: ['dating', 'relationship advice', 'first date', 'situationship', 'green flags',
            'couple goals', 'long distance', 'break up advice', '#datingtok', '#relationships'],
        avoid: ['gore', 'politics', 'pickup artist'],
        curiosity: 0.5, warmth: 0.65,
        likes: [8, 18], saves: [2, 7], follows: [0, 2], searches: [0, 2],
        match: [20, 50], other: [2, 6], session: [15, 40], hours: [[12, 14], [21, 24], [0, 1]], follow: [3, 3],
    }),
    build({
        id: 'wedding', label: 'Wedding planning', description: 'Venues, dresses, table settings and a spreadsheet.',
        category: 'Lifestyle', niche: 'wedding planning',
        interests: ['wedding', 'wedding dress', 'venue tour', 'bridesmaids', 'wedding planning',
            'first dance', 'table setting', 'engagement ring', '#weddingtok', '#bridetobe'],
        avoid: ['gore', 'politics', 'gambling'],
        curiosity: 0.35, warmth: 0.7,
        likes: [7, 16], saves: [5, 14], follows: [1, 3], searches: [1, 4],
        match: [20, 55], other: [2, 6], session: [15, 40], hours: [[9, 12], [20, 24]], follow: [3, 3],
    }),
    build({
        id: 'motherhood', label: 'Motherhood', description: 'Postpartum, nap schedules and the third coffee.',
        category: 'Lifestyle', niche: 'motherhood',
        interests: ['mum life', 'motherhood', 'postpartum', 'baby routine', 'nap schedule',
            'pregnancy', 'maternity leave', 'mum hacks', '#momsoftiktok', '#motherhood'],
        avoid: ['gore', 'politics', 'diet pills'],
        curiosity: 0.35, warmth: 0.75,
        likes: [8, 18], saves: [3, 9], follows: [1, 3], searches: [0, 2],
        match: [18, 45], other: [2, 6], session: [10, 25], hours: [[6, 8], [13, 15], [21, 24]], follow: [3, 3],
    }),
    build({
        id: 'dads', label: 'Dads', description: 'Girl dads, dad jokes and weekends built around small people.',
        category: 'Lifestyle', niche: 'dads',
        interests: ['dad life', 'girl dad', 'dad jokes', 'fatherhood', 'dad hacks',
            'playing with kids', 'dad and baby', 'weekend with kids', '#dadsoftiktok', '#girldad'],
        avoid: ['gore', 'politics', 'gambling'],
        curiosity: 0.4, warmth: 0.7,
        likes: [7, 16], saves: [2, 7], follows: [0, 2], searches: [0, 2],
        match: [15, 40], other: [2, 5], session: [10, 25], hours: [[6, 8], [19, 23]], follow: [3, 4],
    }),
    build({
        id: 'college-students', label: 'Students', description: 'Dorms, lecture notes, student budgets and the 1am feed.',
        category: 'Lifestyle', niche: 'students',
        interests: ['uni life', 'college', 'dorm room', 'lecture notes', 'student budget',
            'freshers', 'campus', 'exam season', '#unitok', '#collegelife'],
        avoid: ['gambling', 'get rich quick', 'vape'],
        curiosity: 0.55, warmth: 0.6,
        likes: [8, 18], saves: [3, 9], follows: [0, 2], searches: [0, 3],
        match: [15, 40], other: [2, 5], session: [15, 45], hours: [[9, 12], [16, 19], [22, 24], [0, 2]], follow: [4, 4],
    }),
    build({
        id: 'astrology', label: 'Astrology and tarot', description: 'Birth charts, retrogrades, tarot pulls and moon phases.',
        category: 'Lifestyle', niche: 'astrology',
        interests: ['astrology', 'birth chart', 'mercury retrograde', 'tarot', 'moon phase',
            'zodiac signs', 'manifestation', 'crystals', '#astrologytok', '#tarot'],
        avoid: ['gambling', 'politics', 'gore'],
        curiosity: 0.4, warmth: 0.7,
        likes: [8, 18], saves: [3, 9], follows: [1, 3], searches: [1, 3],
        match: [20, 55], other: [2, 6], session: [12, 30], hours: [[8, 10], [21, 24], [0, 1]], follow: [3, 3],
    }),
    build({
        id: 'faith', label: 'Faith', description: 'Devotionals, scripture, worship and sermon clips.',
        category: 'Lifestyle', niche: 'faith',
        interests: ['faith', 'bible study', 'scripture', 'prayer', 'worship', 'devotional',
            'sermon clip', 'church', '#faithtok', '#bibleverse'],
        avoid: ['politics', 'gore', 'gambling'],
        curiosity: 0.3, warmth: 0.65,
        likes: [6, 14], saves: [3, 9], follows: [0, 2], searches: [0, 2],
        match: [25, 70], other: [2, 6], session: [10, 25], hours: [[6, 8], [20, 23]], follow: [3, 4],
    }),
    build({
        id: 'mental-health', label: 'Mental health', description: 'Therapy language and coping skills — careful, warm, slow to engage.',
        category: 'Lifestyle', niche: 'mental health',
        interests: ['mental health', 'therapy', 'anxiety', 'burnout', 'coping skills',
            'grounding techniques', 'nervous system', 'therapist', '#mentalhealthtok', '#therapytok'],
        // The longest avoid list in the library, and deliberately so: this is the one niche where
        // the feed will happily serve something an account should never watch, let alone like.
        avoid: ['self harm', 'suicide', 'gore', 'diet pills', 'eating disorder', 'politics', 'gambling'],
        curiosity: 0.25, warmth: 0.5,
        likes: [4, 10], saves: [3, 9], follows: [0, 1], searches: [0, 2],
        match: [30, 90], other: [2, 6], session: [8, 20], hours: [[7, 9], [21, 24]], follow: [4, 6],
    }),
    build({
        id: 'sobriety', label: 'Sobriety', description: 'Sober curious, day counts, mocktails and recovery talk.',
        category: 'Lifestyle', niche: 'sobriety',
        interests: ['sober', 'sobriety', 'alcohol free', 'sober curious', 'day one',
            'mocktail', 'recovery', 'sober living', '#sobertok', '#alcoholfree'],
        avoid: ['gore', 'gambling', 'binge drinking', 'drug use'],
        curiosity: 0.3, warmth: 0.6,
        likes: [5, 12], saves: [2, 7], follows: [0, 2], searches: [0, 2],
        match: [30, 80], other: [2, 6], session: [10, 25], hours: [[7, 9], [19, 23]], follow: [3, 5],
    }),
    build({
        id: 'sleep', label: 'Sleep', description: 'Wind-down routines, insomnia and a feed that stops at one.',
        category: 'Lifestyle', niche: 'sleep',
        interests: ['sleep', 'sleep routine', 'insomnia', 'wind down', 'white noise',
            'sleep hygiene', 'circadian rhythm', 'bedtime', '#sleeptok', '#sleephygiene'],
        avoid: ['energy drinks', 'gore', 'politics'],
        curiosity: 0.25, warmth: 0.4,
        likes: [3, 8], saves: [2, 7], follows: [0, 1], searches: [0, 2],
        match: [30, 90], other: [3, 8], session: [6, 18], hours: [[21, 24], [0, 1]], follow: [4, 6],
    }),

    /* ---- Vehicles & travel --------------------------------------------- */

    build({
        id: 'cars', label: 'Cars', description: 'Builds, detailing and what a first car should cost.',
        category: 'Vehicles & travel', niche: 'cars',
        interests: ['car', 'car build', 'detailing', 'first car', 'engine swap', 'jdm', 'ev',
            'car review', '#cartok', '#carsoftiktok'],
        avoid: ['gambling', 'crypto', 'street takeover'],
        curiosity: 0.35, warmth: 0.45,
        likes: [5, 12], saves: [1, 5], follows: [0, 2], searches: [1, 3],
        match: [20, 55], other: [3, 7], session: [15, 35], hours: [[12, 14], [18, 24]], follow: [4, 5],
    }),
    build({
        id: 'travel', label: 'Travel', description: 'Flight deals, city guides and packing far too well.',
        category: 'Vehicles & travel', niche: 'travel',
        interests: ['travel', 'flight deal', 'city guide', 'hostel', 'road trip', 'packing tips',
            'carry on', 'itinerary', '#traveltok', '#travel'],
        avoid: ['gambling', 'timeshare'],
        curiosity: 0.6, warmth: 0.6,
        likes: [6, 14], saves: [4, 12], follows: [0, 2], searches: [1, 4],
        match: [20, 55], other: [3, 8], session: [15, 40], hours: [[12, 14], [20, 24]], follow: [3, 5],
    }),
    build({
        id: 'ev', label: 'Electric vehicles', description: 'Range tests, charging networks and battery health.',
        category: 'Vehicles & travel', niche: 'electric vehicles',
        interests: ['ev', 'electric car', 'charging network', 'range test', 'tesla',
            'battery health', 'home charger', 'ev road trip', '#evtok', '#electricvehicles'],
        avoid: ['crypto', 'gambling', 'conspiracy'],
        curiosity: 0.4, warmth: 0.4,
        likes: [4, 10], saves: [3, 9], follows: [0, 2], searches: [1, 4],
        match: [30, 80], other: [3, 8], session: [15, 35], hours: [[7, 9], [19, 23]], follow: [4, 5],
    }),
    build({
        id: 'motorcycles', label: 'Motorcycles', description: 'Track days, riding gear, chain maintenance and back roads.',
        category: 'Vehicles & travel', niche: 'motorcycles',
        interests: ['motorcycle', 'motorbike', 'track day', 'riding gear', 'chain maintenance',
            'cafe racer', 'adv bike', 'twisties', '#motorcycletok', '#bikelife'],
        avoid: ['gore', 'street racing', 'gambling'],
        curiosity: 0.35, warmth: 0.5,
        likes: [5, 12], saves: [2, 7], follows: [0, 2], searches: [1, 3],
        match: [25, 70], other: [3, 7], session: [15, 35], hours: [[7, 9], [18, 23]], follow: [4, 5],
    }),
    build({
        id: 'aviation', label: 'Aviation', description: 'Cockpit views, ATC audio, landings and flight training.',
        category: 'Vehicles & travel', niche: 'aviation',
        interests: ['aviation', 'cockpit', 'flight training', 'atc', 'landing', 'boeing',
            'airbus', 'avgeek', '#aviationtok', '#avgeek'],
        avoid: ['conspiracy', 'gore', 'gambling'],
        curiosity: 0.4, warmth: 0.45,
        likes: [5, 12], saves: [2, 7], follows: [0, 2], searches: [1, 3],
        match: [30, 90], other: [3, 8], session: [15, 40], hours: [[12, 14], [20, 24]], follow: [4, 5],
    }),
    build({
        id: 'budget-travel', label: 'Budget travel', description: 'Error fares, hostels, points and doing a week on very little.',
        category: 'Vehicles & travel', niche: 'budget travel',
        interests: ['budget travel', 'cheap flights', 'hostel', 'backpacking', 'travel hack',
            'error fare', 'points and miles', 'layover', '#budgettravel', '#travelhacks'],
        avoid: ['gambling', 'timeshare', 'get rich quick'],
        curiosity: 0.55, warmth: 0.6,
        likes: [6, 14], saves: [5, 14], follows: [0, 2], searches: [2, 5],
        match: [20, 55], other: [3, 7], session: [15, 40], hours: [[12, 14], [21, 24]], follow: [3, 5],
    }),
    build({
        id: 'luxury-travel', label: 'Luxury travel', description: 'Suite tours, business class and resorts saved for later.',
        category: 'Vehicles & travel', niche: 'luxury travel',
        interests: ['luxury travel', 'business class', 'first class', 'resort', 'suite tour',
            'five star hotel', 'spa day', 'private villa', '#luxurytravel', '#hoteltok'],
        avoid: ['gambling', 'timeshare', 'dropshipping'],
        curiosity: 0.5, warmth: 0.55,
        likes: [6, 14], saves: [4, 12], follows: [0, 2], searches: [1, 4],
        match: [25, 65], other: [3, 8], session: [15, 40], hours: [[13, 15], [21, 24]], follow: [3, 4],
    }),
    build({
        id: 'digital-nomad', label: 'Digital nomad', description: 'Remote work, visas, coworking and cost of living.',
        category: 'Vehicles & travel', niche: 'digital nomad',
        interests: ['digital nomad', 'remote work', 'coworking', 'visa run', 'nomad visa',
            'cost of living', 'wifi test', 'working abroad', '#digitalnomad', '#remotework'],
        avoid: ['gambling', 'get rich quick', 'crypto'],
        curiosity: 0.5, warmth: 0.5,
        likes: [5, 12], saves: [4, 12], follows: [0, 2], searches: [1, 4],
        match: [25, 65], other: [3, 7], session: [15, 35], hours: [[8, 11], [20, 23]], follow: [4, 5],
    }),

    /* ---- Animals & nature ---------------------------------------------- */

    build({
        id: 'pets', label: 'Pets', description: 'Dogs, cats, training clips and unreasonable amounts of them.',
        category: 'Animals & nature', niche: 'pets',
        interests: ['dog', 'puppy', 'cat', 'kitten', 'dog training', 'rescue dog', 'vet',
            'pet care', '#dogtok', '#cattok'],
        avoid: ['gore', 'animal abuse'],
        curiosity: 0.5, warmth: 0.8,
        likes: [10, 22], saves: [1, 4], follows: [1, 3], searches: [0, 2],
        match: [12, 35], other: [3, 7], session: [12, 35], hours: [[7, 10], [18, 24]], follow: [3, 3],
    }),
    build({
        id: 'dogs', label: 'Dogs', description: 'Recall, crate training, breed talk and the dog park.',
        category: 'Animals & nature', niche: 'dogs',
        interests: ['dog training', 'puppy', 'recall training', 'crate training', 'dog walk',
            'breed', 'vet visit', 'dog park', '#dogtok', '#puppytraining'],
        avoid: ['gore', 'animal abuse', 'dog fighting'],
        curiosity: 0.4, warmth: 0.8,
        likes: [10, 22], saves: [2, 7], follows: [1, 3], searches: [0, 2],
        match: [15, 40], other: [3, 7], session: [12, 35], hours: [[6, 9], [18, 23]], follow: [3, 3],
    }),
    build({
        id: 'cats', label: 'Cats', description: 'Cat behaviour, catios, litter box politics and rescues.',
        category: 'Animals & nature', niche: 'cats',
        interests: ['cat', 'kitten', 'cat behaviour', 'litter box', 'cat toys', 'rescue cat',
            'catio', 'vet visit', '#cattok', '#catsoftiktok'],
        avoid: ['gore', 'animal abuse'],
        curiosity: 0.4, warmth: 0.8,
        likes: [10, 22], saves: [1, 5], follows: [1, 3], searches: [0, 2],
        match: [12, 35], other: [3, 7], session: [12, 35], hours: [[7, 10], [20, 24]], follow: [3, 3],
    }),
    build({
        id: 'aquariums', label: 'Aquariums', description: 'Aquascaping, planted tanks, shrimp and water parameters.',
        category: 'Animals & nature', niche: 'aquariums',
        interests: ['aquarium', 'fish tank', 'aquascape', 'planted tank', 'betta',
            'shrimp tank', 'water parameters', 'cycling a tank', '#aquariumtok', '#aquascaping'],
        avoid: ['gore', 'animal abuse', 'gambling'],
        curiosity: 0.3, warmth: 0.6,
        likes: [5, 12], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [30, 90], other: [3, 8], session: [15, 40], hours: [[8, 10], [19, 23]], follow: [3, 5],
    }),
    build({
        id: 'birding', label: 'Birding', description: 'Garden feeders, binoculars, calls and migration season.',
        category: 'Animals & nature', niche: 'birding',
        interests: ['birding', 'bird watching', 'garden birds', 'binoculars', 'bird call',
            'migration', 'rspb', 'feeder setup', '#birdtok', '#birding'],
        avoid: ['gore', 'animal abuse', 'gambling'],
        curiosity: 0.3, warmth: 0.65,
        likes: [5, 12], saves: [2, 7], follows: [0, 2], searches: [1, 3],
        match: [25, 70], other: [3, 8], session: [10, 25], hours: [[6, 9], [16, 19]], follow: [3, 5],
    }),
    build({
        id: 'sustainability', label: 'Sustainability', description: 'Zero waste swaps, repairs, composting and second hand.',
        category: 'Animals & nature', niche: 'sustainability',
        interests: ['sustainability', 'zero waste', 'thrifting', 'repair not replace', 'composting',
            'plastic free', 'second hand', 'low waste swaps', '#sustainability', '#zerowaste'],
        avoid: ['dropshipping', 'fast fashion haul', 'crypto'],
        curiosity: 0.4, warmth: 0.55,
        likes: [5, 12], saves: [3, 9], follows: [0, 2], searches: [1, 3],
        match: [25, 65], other: [3, 7], session: [12, 30], hours: [[8, 11], [19, 23]], follow: [3, 4],
    }),
];

/** Every shipped preset id. `validatePersona` uses it to check a persona's `presets` field. */
export const PRESET_IDS: readonly string[] = PERSONA_PRESETS.map(({ id }) => id);

export function findPreset(id: unknown): PersonaPreset | undefined {
    return typeof id === 'string' ? PERSONA_PRESETS.find((preset) => preset.id === id.trim()) : undefined;
}

/** The library grouped for the picker: category order is `PRESET_CATEGORIES`, never alphabetical. */
export function presetsByCategory(): Array<{ category: PresetCategory; presets: PersonaPreset[] }> {
    return PRESET_CATEGORIES.map((category) => ({
        category,
        presets: PERSONA_PRESETS.filter((preset) => preset.category === category),
    })).filter(({ presets }) => presets.length > 0);
}

/**
 * A preset, as a persona for one handle. Validated on the way through like anything else, so a
 * preset with a typo in it fails here rather than reaching the store. The persona records which
 * preset it came from, so the editor can show the chip and re-blend from it later.
 */
export function applyPreset(handle: string, id: unknown): Persona {
    const preset = findPreset(id);
    if (!preset) throw new PersonaError(`"${String(id)}" is not one of the presets`);
    return validatePersona(normaliseHandle(handle), {
        ...(preset.persona as unknown as Record<string, unknown>),
        presets: [preset.id],
    });
}
