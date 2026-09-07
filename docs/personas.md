# Personas

A persona is who an account behaves like.

Before personas, every account on the farm doomscrolled the same way: watch a random video for a
random number of seconds, then flip a coin for a like and another for a save. There were three
speeds — skimmer, casual, engaged — so a farm of forty phones was three people repeated. Nothing
about a run depended on what was actually on screen.

A persona changes that. It says: this handle is a home-gym person. It watches kettlebell clips right
through and scrolls past makeup in two seconds. It likes maybe six things in a sitting, saves one,
follows a creator only after it has liked three of their videos across a few sessions, occasionally
stops scrolling to search "kettlebell" itself, and goes to bed at eleven.

## What a persona is made of

| field | what it means |
|---|---|
| `niche` | A short name for what the account is into — "home gym", "slow cooking". Only used in log lines and on the page. |
| `interests` | The keywords and hashtags it cares about, lowercase. A video whose caption, hashtags, sound or creator hits one of these is a **match**. |
| `avoid` | Anything here is scrolled past on sight and never liked, whatever else is on screen. |
| `language` | One of a fixed list of codes. |
| `curiosity` | 0–1. How often it lingers on something outside its niche. |
| `warmth` | 0–1. Its overall willingness to like. |
| `budgets` | Per session: `likes`, `saves`, `follows`, `searches`, each a `{min, max}`. One number inside that range is drawn at the start of every session and is a hard ceiling for it. |
| `watch` | Seconds. `match` is the long band, for content that hit an interest; `other` is the short band for everything else. |
| `sessionMinutes` | How long one sitting lasts, `{min, max}`. |
| `activeHours` | Local-clock ranges the account is awake in, e.g. `08-23`. A range may wrap midnight (`22-03`). |
| `followRule` | "Like N videos from the same creator within M sessions, then follow them." |
| `presets` | Optional. The preset ids this persona was blended from. A record for the editor; no routine reads it, and a persona without it is not different in any way. |

Personas live in `SCHEDULER_DATA_DIR/personas.json`, keyed by handle, written temp-file-then-rename
like `devices.json`. It is a plain document: read it, diff it, copy it between farms.

**Every handle has a persona.** If none is stored, one is derived from the handle itself —
`@homegym.dan` starts out interested in `homegym`, `dan` and their hashtags, with a warmth and a
curiosity taken from a hash of the handle so two unconfigured accounts are still measurably
different people. Setting one up in the dashboard replaces the derived one.

## Setting one up

Open **Accounts**. Each handle has a persona panel: the niche, the interests as chips and as a
comma-separated field, what it avoids, the warmth and curiosity sliders, the budgets, the watch
bands, the session length, the active hours and the follow rule. Save and the panel comes back
showing what was actually stored — normalised, lowercased and de-duplicated — rather than what you
typed. "Reset to the default" deletes the stored persona and the account goes back to the one
derived from its handle.

Everything the form sends is a whitelist: unknown fields are dropped, terms must be plain words or
hashtags, and every number is clamped to a sane range.

## Presets

Fourteen fields is a lot to invent from a blank form for the fortieth account on a farm, so a
hundred niches come written out — real interests and avoid lists, a warmth and a curiosity that
suit the niche, budgets a person in it would plausibly spend, watch bands reflecting how long that
content actually holds someone, and the hours of the day they are on their phone.

An account with **no persona yet** sees the picker instead of an empty form: search it, or scan the
categories, and press the ones closest to the account. An account that already has one gets the
same picker above the form, with the presets it was built from as chips. Either way the picker only
*fills the form in* — nothing is stored until you press **Save persona**, so you always see the
values before they land. The blank form is still there, folded under *Or fill it in by hand*.

### Fitness & sport

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `fitness` | Gym sessions, form checks and progress clips. | 0.55 / 0.3 | 5–12 | 14–40s / 2–6s | 12–28 min | 06–09, 17–23 |
| `home-gym` | Garage racks, adjustable dumbbells and small-space setups. | 0.6 / 0.2 | 4–10 | 18–45s / 2–5s | 10–25 min | 06–08, 18–23 |
| `running` | Race training, splits, and far too many shoe reviews. | 0.5 / 0.25 | 4–9 | 15–38s / 2–5s | 8–20 min | 05–08, 18–22 |
| `yoga` | Flows, hip openers and a mat by the window at seven. | 0.55 / 0.3 | 4–10 | 30–75s / 3–7s | 10–25 min | 06–08, 19–22 |
| `pilates` | Reformer classes, wall pilates and posture work. | 0.55 / 0.28 | 5–11 | 25–60s / 2–6s | 10–24 min | 07–09, 18–22 |
| `calisthenics` | Pull-up bars, levers and a handstand that is nearly there. | 0.5 / 0.25 | 5–12 | 20–55s / 2–6s | 12–28 min | 06–09, 17–22 |
| `cycling` | Road and gravel, watts, bike fits and long Sunday rides. | 0.45 / 0.3 | 4–9 | 25–65s / 3–7s | 12–30 min | 05–08, 18–22 |
| `swimming` | Stroke technique, lane sets and open water. | 0.45 / 0.25 | 3–9 | 20–55s / 2–6s | 8–20 min | 06–08, 19–22 |
| `martial-arts` | Rolling, pad work and technique breakdowns. | 0.5 / 0.3 | 5–12 | 25–70s / 3–7s | 15–35 min | 07–09, 19–23 |
| `golf` | Swing changes, short game and a handicap going the wrong way. | 0.45 / 0.3 | 4–10 | 25–60s / 3–7s | 12–30 min | 06–09, 18–22 |
| `basketball` | Highlights, handles and drills from the driveway. | 0.55 / 0.4 | 7–16 | 15–40s / 2–5s | 15–40 min | 12–14, 18–24 |
| `soccer` | Match clips, transfer talk and five-a-side on Thursdays. | 0.55 / 0.4 | 8–18 | 15–42s / 2–5s | 15–40 min | 12–14, 17–24 |
| `hiking` | Trails, day packs and summits worth the early start. | 0.6 / 0.45 | 5–12 | 25–70s / 3–8s | 12–30 min | 07–10, 19–23 |
| `camping` | Tent setups, campfire cooking and gear laid out on the floor. | 0.6 / 0.4 | 5–12 | 25–70s / 3–8s | 12–32 min | 08–11, 19–23 |
| `fishing` | Fly, carp and bass — tackle, knots and catch-and-cook. | 0.55 / 0.3 | 4–10 | 30–80s / 3–8s | 15–40 min | 05–08, 19–22 |

### Food & drink

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `cooking` | Weeknight dinners, one-pan things and knife work. | 0.6 / 0.4 | 6–14 | 20–50s / 3–7s | 12–30 min | 11–14, 16–22 |
| `baking` | Sourdough, laminated dough and cakes that take a weekend. | 0.65 / 0.3 | 5–12 | 25–60s / 3–7s | 15–35 min | 09–13, 19–23 |
| `coffee` | Espresso dialling-in, pour over and a grinder budget out of hand. | 0.6 / 0.35 | 6–13 | 20–50s / 2–6s | 10–25 min | 06–10, 13–15 |
| `cocktails-wine` | Home bar builds, negronis and natural wine. | 0.6 / 0.4 | 6–14 | 20–50s / 3–7s | 12–30 min | 17–20, 21–24 |
| `meal-prep` | Sunday batch cooking, macros and five identical lunches. | 0.55 / 0.3 | 5–12 | 25–60s / 2–6s | 10–25 min | 09–12, 18–22 |
| `vegan` | Plant-based cooking, tofu that is actually good, and swaps. | 0.6 / 0.35 | 6–14 | 25–60s / 3–7s | 12–30 min | 11–14, 18–22 |
| `food-travel` | Hidden gems, street food and where to eat in a new city. | 0.65 / 0.55 | 7–16 | 20–50s / 3–7s | 15–35 min | 12–14, 19–24 |

### Appearance

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `beauty` | Makeup looks, hauls and the products behind them. | 0.7 / 0.45 | 8–18 | 15–42s / 2–6s | 15–40 min | 08–11, 19–24 |
| `skincare` | Routines, actives, and dermatologists correcting them. | 0.55 / 0.3 | 5–12 | 20–48s / 2–6s | 12–28 min | 07–10, 20–24 |
| `fashion` | Outfits, thrifting and building a wardrobe that works. | 0.65 / 0.5 | 7–16 | 12–35s / 2–5s | 15–35 min | 08–10, 18–24 |
| `hair` | Curly routines, colour, blowouts and the salon chair. | 0.65 / 0.4 | 7–16 | 18–45s / 2–6s | 15–35 min | 08–11, 19–24 |
| `nails` | Gel sets, nail art and the tech doing them. | 0.7 / 0.35 | 8–18 | 15–40s / 2–5s | 12–30 min | 09–12, 19–24 |
| `mens-grooming` | Fades, beard trims, fragrance and a two-step routine. | 0.5 / 0.35 | 5–12 | 18–45s / 2–6s | 10–25 min | 07–09, 19–23 |
| `streetwear` | Sneakers, drops, outfit grids and thrift flips. | 0.6 / 0.5 | 8–18 | 12–35s / 2–5s | 15–40 min | 12–14, 18–24 |

### Home

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `diy-home` | Renovation, tools and repairs done at the weekend. | 0.5 / 0.35 | 4–10 | 25–65s / 3–8s | 12–30 min | 08–11, 19–23 |
| `interior-design` | Mood boards, palettes and rooms that were beige on Monday. | 0.6 / 0.45 | 6–14 | 20–50s / 3–7s | 15–35 min | 09–12, 19–23 |
| `plants-gardening` | Houseplants, propagation and an allotment in April. | 0.65 / 0.35 | 6–14 | 25–60s / 3–7s | 12–30 min | 07–10, 17–21 |
| `minimalism` | Owning less on purpose — decluttering and slow living. | 0.45 / 0.3 | 4–9 | 30–70s / 2–6s | 8–20 min | 07–09, 20–23 |
| `organising` | Deep cleans, restocks and a pantry in matching jars. | 0.6 / 0.35 | 7–16 | 20–50s / 2–6s | 15–35 min | 09–12, 19–23 |
| `van-life` | Camper builds, solar setups and waking up somewhere else. | 0.6 / 0.4 | 5–12 | 30–80s / 3–8s | 15–40 min | 08–11, 19–23 |

### Money & work

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `personal-finance` | Budgeting, index funds and getting out of debt. | 0.35 / 0.25 | 3–8 | 30–70s / 3–8s | 10–25 min | 07–09, 20–23 |
| `real-estate` | House tours, first-time buyers and rental numbers. | 0.35 / 0.3 | 3–8 | 30–75s / 3–8s | 10–25 min | 08–10, 19–23 |
| `side-hustles` | Evening income — reselling, print on demand, first orders. | 0.4 / 0.45 | 4–10 | 25–60s / 3–7s | 12–30 min | 07–09, 20–24 |
| `entrepreneurship` | Owners packing orders, cash flow and the first hire. | 0.45 / 0.4 | 5–11 | 25–65s / 3–7s | 12–30 min | 07–09, 12–14, 20–23 |
| `marketing-growth` | Hooks, content strategy, UGC and what the analytics said. | 0.45 / 0.5 | 6–14 | 25–60s / 3–7s | 15–35 min | 08–11, 13–15, 20–23 |
| `career-job-search` | CVs, interview questions and asking for the raise. | 0.4 / 0.35 | 4–10 | 25–65s / 2–6s | 10–25 min | 07–09, 12–14, 20–23 |
| `freelancing` | Rates, scope creep, invoices and finding the next client. | 0.45 / 0.4 | 5–11 | 25–60s / 3–7s | 12–30 min | 08–10, 13–15, 20–23 |
| `crypto-web3` | Self-custody and on-chain talk — interested, and slow to like. | 0.2 / 0.35 | 2–6 | 25–60s / 2–6s | 10–25 min | 07–09, 21–24 |
| `stock-trading` | Earnings, charts and a portfolio checked far too often. | 0.3 / 0.3 | 3–8 | 25–60s / 2–6s | 10–25 min | 06–09, 14–17, 21–23 |

### Tech & product

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `tech-gadgets` | Phones, keyboards, desk setups and teardowns. | 0.4 / 0.45 | 4–10 | 25–60s / 3–8s | 15–40 min | 12–14, 19–24 |
| `ai-tools` | Models, prompts, agents and the workflow around them. | 0.45 / 0.55 | 5–12 | 25–65s / 3–7s | 15–35 min | 08–10, 13–15, 21–24 |
| `indie-hacking` | Building in public — MRR screenshots, launches, solo founders. | 0.5 / 0.5 | 6–14 | 25–65s / 3–7s | 15–35 min | 07–09, 13–15, 21–24 |
| `no-code` | Bubble, Webflow, Airtable and automations held together with Zapier. | 0.45 / 0.5 | 5–12 | 30–70s / 3–7s | 15–35 min | 09–12, 20–23 |
| `dev-tools` | Languages, editors, git and the argument about tabs. | 0.35 / 0.4 | 4–10 | 30–80s / 2–6s | 15–40 min | 09–12, 14–18, 21–24 |
| `saas-productivity` | Notion, Obsidian, second brains and calendar blocking. | 0.45 / 0.45 | 5–12 | 25–60s / 2–6s | 12–30 min | 07–09, 13–15, 20–23 |
| `cybersecurity` | Phishing teardowns, breaches, CTFs and password hygiene. | 0.3 / 0.35 | 3–9 | 30–80s / 2–6s | 12–30 min | 08–10, 20–24 |
| `pc-building` | Parts lists, cable management and frames per second. | 0.45 / 0.4 | 5–12 | 25–70s / 3–8s | 15–40 min | 15–18, 19–24 |

### Learning

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `study-productivity` | Revision, note taking and getting through exam season. | 0.4 / 0.3 | 4–10 | 25–60s / 2–6s | 8–20 min | 07–09, 15–18, 21–23 |
| `language-learning` | Vocabulary, immersion clips and a streak worth protecting. | 0.5 / 0.4 | 5–12 | 25–60s / 2–6s | 10–25 min | 07–09, 12–14, 20–23 |
| `science` | Physics, space and explainers that run the full minute. | 0.4 / 0.5 | 5–12 | 30–90s / 3–8s | 15–35 min | 12–14, 20–24 |
| `history` | Rome, the war, archaeology and long documentary clips. | 0.4 / 0.45 | 5–12 | 35–95s / 3–8s | 15–40 min | 13–15, 20–24 |
| `books` | BookTok — recommendations, TBR piles and annotated paperbacks. | 0.65 / 0.4 | 7–16 | 20–55s / 2–6s | 15–35 min | 08–10, 20–24 |
| `writing` | Drafts, plot structure, querying agents and self publishing. | 0.5 / 0.4 | 5–12 | 25–70s / 2–6s | 12–30 min | 06–09, 21–24 |

### Creative

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `photography` | Primes, golden hour, Lightroom and street shooting. | 0.55 / 0.45 | 6–14 | 25–65s / 3–7s | 15–35 min | 08–10, 18–22 |
| `filmmaking` | Cinematography, colour grading and b-roll breakdowns. | 0.5 / 0.45 | 5–12 | 30–80s / 3–8s | 15–40 min | 11–14, 20–24 |
| `music-production` | Ableton, sample flips, mixing and beats at midnight. | 0.5 / 0.45 | 6–14 | 25–70s / 3–7s | 20–50 min | 14–17, 21–24, 00–02 |
| `guitar` | Riffs, fingerstyle, pedalboards and practice routines. | 0.6 / 0.4 | 7–16 | 20–55s / 2–6s | 15–35 min | 17–20, 21–24 |
| `drawing` | Sketchbooks, Procreate timelapses and character design. | 0.65 / 0.45 | 8–18 | 20–60s / 2–6s | 15–40 min | 13–16, 20–24 |
| `graphic-design` | Typography, logos, Figma and colour theory. | 0.5 / 0.45 | 5–12 | 20–55s / 2–6s | 12–30 min | 09–12, 14–18 |
| `game-dev-3d` | Unity, Unreal, Blender and devlogs at two in the morning. | 0.45 / 0.45 | 5–12 | 30–80s / 3–8s | 20–50 min | 13–16, 20–24, 00–01 |

### Entertainment

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `comedy` | Sketches and bits — warm, easily distracted, gone in four seconds. | 0.75 / 0.75 | 10–25 | 10–30s / 2–4s | 15–45 min | 12–14, 18–24, 00–01 |
| `gaming` | Playthroughs, patch notes and setups worth more than the car. | 0.5 / 0.4 | 6–15 | 25–70s / 3–8s | 20–60 min | 16–24, 00–02 |
| `film-tv` | Reviews, recommendations, Letterboxd and what to watch tonight. | 0.55 / 0.5 | 7–16 | 20–60s / 3–7s | 15–40 min | 12–14, 19–24 |
| `anime` | Seasonal watchlists, manga panels and edits on loop. | 0.7 / 0.45 | 10–22 | 15–45s / 2–5s | 20–50 min | 15–18, 20–24, 00–02 |
| `true-crime` | Cold cases and court footage — watches the whole thing, likes rarely. | 0.45 / 0.35 | 5–12 | 40–120s / 3–8s | 20–50 min | 12–14, 21–24, 00–01 |
| `podcasts` | Long-form clips, guest episodes and a listening queue. | 0.45 / 0.5 | 5–12 | 30–90s / 3–8s | 15–40 min | 07–09, 17–19, 21–24 |
| `streaming-creators` | Twitch clips, stream setups and who is live tonight. | 0.6 / 0.5 | 8–18 | 15–45s / 2–5s | 20–60 min | 16–19, 20–24, 00–02 |
| `esports` | Tournaments, roster moves and clutch plays. | 0.55 / 0.4 | 8–18 | 20–55s / 2–6s | 20–50 min | 16–19, 20–24, 00–02 |
| `board-games` | Game nights, deck builders, minis and D&D tables. | 0.6 / 0.4 | 6–14 | 25–70s / 3–7s | 15–40 min | 13–16, 19–23 |

### Lifestyle

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `mindfulness` | Breathwork, journaling and winding down at night. | 0.45 / 0.25 | 3–8 | 30–80s / 3–8s | 6–18 min | 06–08, 21–24 |
| `parenting` | Toddlers, sleep, school runs and other people surviving them. | 0.7 / 0.35 | 6–14 | 15–40s / 2–6s | 8–20 min | 06–08, 12–14, 20–23 |
| `dating` | First dates, situationships and advice given far too confidently. | 0.65 / 0.5 | 8–18 | 20–50s / 2–6s | 15–40 min | 12–14, 21–24, 00–01 |
| `wedding` | Venues, dresses, table settings and a spreadsheet. | 0.7 / 0.35 | 7–16 | 20–55s / 2–6s | 15–40 min | 09–12, 20–24 |
| `motherhood` | Postpartum, nap schedules and the third coffee. | 0.75 / 0.35 | 8–18 | 18–45s / 2–6s | 10–25 min | 06–08, 13–15, 21–24 |
| `dads` | Girl dads, dad jokes and weekends built around small people. | 0.7 / 0.4 | 7–16 | 15–40s / 2–5s | 10–25 min | 06–08, 19–23 |
| `college-students` | Dorms, lecture notes, student budgets and the 1am feed. | 0.6 / 0.55 | 8–18 | 15–40s / 2–5s | 15–45 min | 09–12, 16–19, 22–24, 00–02 |
| `astrology` | Birth charts, retrogrades, tarot pulls and moon phases. | 0.7 / 0.4 | 8–18 | 20–55s / 2–6s | 12–30 min | 08–10, 21–24, 00–01 |
| `faith` | Devotionals, scripture, worship and sermon clips. | 0.65 / 0.3 | 6–14 | 25–70s / 2–6s | 10–25 min | 06–08, 20–23 |
| `mental-health` | Therapy language and coping skills — careful, warm, slow to engage. | 0.5 / 0.25 | 4–10 | 30–90s / 2–6s | 8–20 min | 07–09, 21–24 |
| `sobriety` | Sober curious, day counts, mocktails and recovery talk. | 0.6 / 0.3 | 5–12 | 30–80s / 2–6s | 10–25 min | 07–09, 19–23 |
| `sleep` | Wind-down routines, insomnia and a feed that stops at one. | 0.4 / 0.25 | 3–8 | 30–90s / 3–8s | 6–18 min | 21–24, 00–01 |

### Vehicles & travel

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `cars` | Builds, detailing and what a first car should cost. | 0.45 / 0.35 | 5–12 | 20–55s / 3–7s | 15–35 min | 12–14, 18–24 |
| `travel` | Flight deals, city guides and packing far too well. | 0.6 / 0.6 | 6–14 | 20–55s / 3–8s | 15–40 min | 12–14, 20–24 |
| `ev` | Range tests, charging networks and battery health. | 0.4 / 0.4 | 4–10 | 30–80s / 3–8s | 15–35 min | 07–09, 19–23 |
| `motorcycles` | Track days, riding gear, chain maintenance and back roads. | 0.5 / 0.35 | 5–12 | 25–70s / 3–7s | 15–35 min | 07–09, 18–23 |
| `aviation` | Cockpit views, ATC audio, landings and flight training. | 0.45 / 0.4 | 5–12 | 30–90s / 3–8s | 15–40 min | 12–14, 20–24 |
| `budget-travel` | Error fares, hostels, points and doing a week on very little. | 0.6 / 0.55 | 6–14 | 20–55s / 3–7s | 15–40 min | 12–14, 21–24 |
| `luxury-travel` | Suite tours, business class and resorts saved for later. | 0.55 / 0.5 | 6–14 | 25–65s / 3–8s | 15–40 min | 13–15, 21–24 |
| `digital-nomad` | Remote work, visas, coworking and cost of living. | 0.5 / 0.5 | 5–12 | 25–65s / 3–7s | 15–35 min | 08–11, 20–23 |

### Animals & nature

| preset | who it is | warmth / curiosity | likes | watches match / rest | session | awake |
|---|---|---|---|---|---|---|
| `pets` | Dogs, cats, training clips and unreasonable amounts of them. | 0.8 / 0.5 | 10–22 | 12–35s / 3–7s | 12–35 min | 07–10, 18–24 |
| `dogs` | Recall, crate training, breed talk and the dog park. | 0.8 / 0.4 | 10–22 | 15–40s / 3–7s | 12–35 min | 06–09, 18–23 |
| `cats` | Cat behaviour, catios, litter box politics and rescues. | 0.8 / 0.4 | 10–22 | 12–35s / 3–7s | 12–35 min | 07–10, 20–24 |
| `aquariums` | Aquascaping, planted tanks, shrimp and water parameters. | 0.6 / 0.3 | 5–12 | 30–90s / 3–8s | 15–40 min | 08–10, 19–23 |
| `birding` | Garden feeders, binoculars, calls and migration season. | 0.65 / 0.3 | 5–12 | 25–70s / 3–8s | 10–25 min | 06–09, 16–19 |
| `sustainability` | Zero waste swaps, repairs, composting and second hand. | 0.55 / 0.4 | 5–12 | 25–65s / 3–7s | 12–30 min | 08–11, 19–23 |

Every preset goes through the same `validatePersona` whitelist as a hand-typed form, so a typo in
one fails in a test rather than on a phone. They are a starting point, not a category: nothing
downstream branches on a preset or on its category, and editing one afterwards is just editing a
persona.

`POST /api/accounts/:handle/persona/preset` with `{ "preset": "home-gym" }` — or
`{ "presets": ["ai-tools", "indie-hacking"] }` — applies and stores one in a single call, for
seeding a batch of new accounts from a script. `GET /api/persona-presets` lists the ids, labels,
descriptions and categories, plus the ids grouped by category in picker order.

## Blending presets

An operator promoting in a narrow space rarely wants a whole niche. They want the overlap of two or
three: "AI tools" **and** "indie hacking" **and** "productivity" is not any one preset, it is the
person who watches all three. Pick several in the picker and the panel fills from the blend.

| field | how it blends |
|---|---|
| `interests` | Every chosen preset's list, in order, de-duplicated. If the total runs past the cap the first preset keeps its place, which is why the chips stay in the order they were added. |
| `avoid` | The union of the avoid lists, **minus anything another chosen preset is interested in**. Blending `crypto-web3` with `personal-finance` gives an account that watches crypto rather than one that scrolls past the word. |
| `niche` | The labels, joined — `ai tools · indie hacking · productivity`. A niche holds forty characters, so a blend too long to name in full shortens to `ai tools · indie hacking · 2 more`. |
| `curiosity`, `warmth`, `budgets`, `watch`, `sessionMinutes` | The mean across the presets, rounded. Two calm niches make a calm account; one loud one pulls it up rather than taking it over. |
| `activeHours` | The union of the windows, overlaps merged (`08–12` and `11–15` become `08–15`), capped at six by keeping the widest. Somebody in three niches is awake for all of them, not for the average of them. |
| `followRule` | The most conservative of them: the highest like count, inside the fewest sessions. A blend never follows faster than its most cautious ingredient. |
| `language` | The first preset's, or whatever the request asked for. |

A blended persona records what it was built from in `presets`, which is the one field nothing
downstream reads — `decide.ts` never sees it, and it exists so the editor can draw the chips and
blend again. A persona file written before blends existed has no `presets` key and loads exactly as
it did; saving it back does not add one.

Because three preset interest lists have to fit side by side, `LIMITS.terms` is **80** terms per
list rather than the forty of the single-preset days. Nothing is silently dropped for a blend of
three; a blend of eight will hit the cap, and the presets at the front of the list keep their
terms.

```
POST /api/personas/@farm.one/blend
{ "presets": ["ai-tools", "indie-hacking", "saas-productivity"] }
```

returns the blended persona **without storing it** — the same body the panel would put in the form.
`POST /api/accounts/:handle/persona/preset` with the same `presets` array is the version that
saves. At most eight presets go into one blend.

## What happens during a run

Every video, the routine:

1. **Reads what is on screen.** On Android that is the accessibility tree — the creator's handle,
   the caption, the hashtags, the sound row. On iOS XCUITest cannot see into the feed, so it is OCR
   over a screenshot. A partial read is normal; a missing caption just makes the video less likely
   to match.
2. **Decides.** Interest match is keyword and hashtag overlap plus creator memory — a creator this
   account has liked before counts as familiar, so a feed narrows over time. A match gets the long
   watch band and a like probability scaled by `warmth`, by how strong the match is, and by how much
   of the like budget is left. A non-match gets the short band, with a `curiosity`-sized chance to
   linger into the long one. Saves happen only on matches and at about a quarter of the like rate.
   A match is sometimes re-watched, which is a real signal and a real behaviour.
3. **Acts,** through the same selector tables the routines already use for the feed, plus `follow`
   for the "+" badge on the creator's avatar.
4. **Says what it did, in plain words.** Every decision is one log line with its reason:

   ```
   Liked · #garagegym matched, 3 of 6 likes used
   Watched · "kettlebell" matched, watched 22s (twice)
   Scrolled past · nothing matched home gym, watched 3s
   Scrolled past · "makeup" is on its avoid list, watched 2s
   Searched · "kettlebell", 1 of 1 searches used
   ```

Occasionally the account searches its own niche instead of taking the feed's word for it: tap
search, type an interest, open the top result, scroll a few, come back.

## Memory

The follow rule is meaningless inside one session — nobody likes the same creator three times in
twenty minutes — so the counters live on disk, one small file per handle under
`SCHEDULER_DATA_DIR/persona-memory/`. It holds which sessions each creator was liked in, who has
already been followed, and a line per recent session. That is what "already followed" reads, and
what the Accounts panel shows as **what it did lately**.

A memory file is disposable. Delete it and the account starts over as a stranger.

## Scheduling a persona run

The doomscroll task payload gained one field:

```json
{ "personality": "casual", "likeEnabled": true, "saveEnabled": true, "account": "@homegym.dan", "persona": true }
```

`persona` defaults to `true` whenever the task names an account, because an account is a handle and
every handle has a persona. Set it to `false` to get the old three-personality model back; that is
what `personality` is still there for, and a run without a persona still requires
`durationMinutes`.

Leave `durationMinutes` out of a persona run and the session picks its own length inside
`sessionMinutes`. A run that starts outside the persona's active hours does not scroll at all — it
logs why and exits — unless `durationMinutes` was given explicitly, which is how an operator
overrides the sleep window.

The routines read this from the environment: `DOOMSCROLL_PERSONA`, plus
`DOOMSCROLL_FOLLOW_ENABLED` and `DOOMSCROLL_SEARCH_ENABLED` (both default `true`) if you want to
run a persona with the feed only.

## Where the code lives

- `src/persona/model.ts` — the persona, its validation whitelist, the handle-derived default, the store.
- `src/persona/presets.ts` — the hundred niches in their twelve categories, and applying one to a handle.
- `src/persona/blend.ts` — several presets as one persona.
- `src/persona/observe.ts` — reading the video on screen, from a tree or from OCR words.
- `src/persona/decide.ts` — the decisions. Pure, and every random draw comes from an injected RNG,
  so a session is reproducible from a seed. One video costs a fixed six draws whatever it decides.
- `src/persona/memory.ts` — what an account remembers between runs.
- `src/persona/session.ts` — one sitting, from "is this account awake" to the line written back.
- `src/api/routes/personas.ts` — the editor on the Accounts page.
