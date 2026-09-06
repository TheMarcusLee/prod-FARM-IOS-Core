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
- `src/persona/observe.ts` — reading the video on screen, from a tree or from OCR words.
- `src/persona/decide.ts` — the decisions. Pure, and every random draw comes from an injected RNG,
  so a session is reproducible from a seed. One video costs a fixed six draws whatever it decides.
- `src/persona/memory.ts` — what an account remembers between runs.
- `src/persona/session.ts` — one sitting, from "is this account awake" to the line written back.
- `src/api/routes/personas.ts` — the editor on the Accounts page.
