# Threads (Meta)

The Threads plugin drives the phone, not an API: a thread is posted by tapping
Threads' own composer, and a warm-up is a person scrolling the feed. It is built
to the same shape as the built-in TikTok plugin — read
[plugins.md](plugins.md) and [android-tiktok.md](android-tiktok.md) first, and
this document only covers what is different.

| | |
| --- | --- |
| Plugin id | `com.backline.threads` |
| Tasks | `post` (v1), `warmup` (v1) |
| Android package | `com.instagram.barcelona` |
| iOS bundle id | `com.burbn.barcelona` |
| Android routines | `src/threads/android/{post,warmup}.ts` |
| iOS routines | `src/threads/{post,warmup}.ts` |
| Selector tables | `POST_SELECTORS` in `android/post.ts`, `FEED_SELECTORS` in `android/warmup.ts` |
| iOS coordinates | the `threads` block of the device's coordinate profile |

> **Nothing here has been run against a phone.** Every selector marked `GUESS`
> and every iOS coordinate is written from memory. See
> [device-testing-checklist.md](device-testing-checklist.md).

## The two tasks

### `post`

```jsonc
{
  "media": [{ "assetId": "…", "name": "a.jpg", "mimeType": "image/jpeg" }],
  "text": "morning from the workshop",   // ≤ 500 characters
  "account": "@farm.one",
  "destination": "draft",                 // or "publish"
  "recurringPublishConfirmed": true       // required for a daily/weekly public post
}
```

`text` is required unless the post carries media. The media decides the
**format**, and `threadFormat()` in `src/threads/post-manifest.ts` is the only
place that knows the rules:

| Format | Media |
| --- | --- |
| `text` | none — `text` is then required |
| `photo` | exactly one image |
| `carousel` | 2–20 images |
| `video` | exactly one video |

Mixing images and a video is refused, as is a second video, a twenty-first
image, and a post that is neither text nor media. Every one of those throws in
`validate()` — before a schedule is created — and again in the routine before a
byte is pushed to the phone, so a rejected post leaves nothing behind.

**Carousel order is manifest order.** Media is pushed to the gallery in reverse
so that file 1 is the *newest* item, and the picker's cells are tapped top-left
first, which is the same order back again. `test/threads-android.test.ts`
asserts both halves.

### `warmup`

```jsonc
{
  "durationMinutes": 12,       // omit to let the persona choose its own sitting
  "likeEnabled": true,
  "repostEnabled": false,
  "followEnabled": true,       // optional
  "account": "@farm.one",
  "persona": true              // defaults on whenever an account is named
}
```

The run opens Threads, lands on the feed, and reads each post through
`src/persona/observe.ts` — the accessibility tree on Android, OCR over a
screenshot on iOS. `decideForVideo` then answers *would this account watch,
like, keep, follow?* from the account's own interests and what it remembers
(`src/persona/**`, see [personas.md](personas.md)).

**Threads has no bookmark, so the persona's `save` signal is spent on a
repost.** It is the equivalent gesture: the thing an account does when a post is
worth passing on rather than merely worth a heart. `repostEnabled` gates it and
defaults to *off*, because a repost is public and a like is not.

Pacing is `src/motion`: every flick is a fresh arc drawn from the run's seed and
every gap between gestures comes out of the same stream, so no two runs move the
same way. See [motion.md](motion.md).

**The run always ends by pressing Home** — on a clean finish, on a stop, and
after a persona decides it is outside its waking hours.

## Android

Everything goes through the `DeviceDriver` abstraction (`src/drivers/`), so the
same routine runs over adb or over the accessibility bridge.

- **Wake, then launch.** A phone that dozed off shows nothing and launches
  nothing.
- **Optional screens are tolerated.** Threads' cold-start nudges (*Not now*,
  *Allow*, *Skip*) and the gallery permission sheet are tapped through
  `tapIfPresent`, never `tapFirst`, so their absence is not a failure.
- **Account switching is the profile tab.** Profile → the handle in the header →
  the row for the account, then the header is read back. The "already there"
  check is an **exact** match on purpose: a substring match would read `@bobby`
  as `@bob` and post from the wrong account.
- **Drafts are a sheet, not a button.** Threads has no Drafts control; backing
  out of a composer with content in it offers to keep the draft. The routine
  tries a direct control first, for the builds that grew one, then falls back.

### `adb input text` cannot type non-ASCII

Exactly as in `src/tiktok/android/post.ts`: `assertTextIsTypeable()` runs
**before** anything is pushed or opened and rejects any character outside
printable ASCII when the device is on the `adb` driver, naming the character and
telling the operator to move the phone to the `a11y-bridge` driver instead. It
also enforces the 500-character limit there, so a too-long body never becomes a
half-finished draft on a phone.

### Correcting a selector

Every control is a list of alternates tried in order. When a run fails, the
error names the control, every alternate it tried, and what the phone was
actually showing:

```
Threads control not found: Compose (tried #compose_tab, #creation_tab, …, "New thread").
Screen showed: For you, Following, Search, Activity, Profile
```

Fix the list at the top of `android/post.ts` or `android/warmup.ts` and drop the
`GUESS` note from its comment. Do not edit the flow.

## iOS

XCUITest cannot see into Threads' feed any more than it can into TikTok's, so
iOS is coordinate-driven through WebDriverAgent:

- coordinates come from the `threads` block of the device's profile in
  `src/devices/coordinates.ts` (see [coordinates.md](coordinates.md));
- the account switcher and the feed are read with OCR;
- `src/threads/ios-session.ts` holds what both routines share — the Appium
  session, the unlock, and the account switch.

The iOS warm-up notes a persona's search decision in the session but does not
drive the search screen yet.

## Starter runbooks

Three flows ship per platform, seeded on first boot
(`src/runbook/templates/`): **Threads warm-up**, **Threads text post** and
**Threads photo post**, each with an `-ios` twin. Every label nobody has
confirmed on hardware carries `guess: true`, which the narration reads out as
"(unverified)".

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `THREADS_PACKAGE` | Android | Package name override |
| `THREADS_BUNDLE_ID` | iOS | Bundle id override |
| `THREADS_SWITCH_ACCOUNT` | both | Handle to switch to before the run |
| `WARMUP_DURATION_MINUTES` | both | 1–180; absent lets the persona choose |
| `WARMUP_PERSONA` | both | `true` to browse as the account's persona |
| `WARMUP_LIKE_ENABLED` / `WARMUP_REPOST_ENABLED` | both | Engagement gates |
| `WARMUP_FOLLOW_ENABLED` / `WARMUP_SEARCH_ENABLED` | both | Engagement gates |
| `MOTION_SEED`, `MOTION_HAND`, `MOTION_SPEED` | both | Exported by the executor |
