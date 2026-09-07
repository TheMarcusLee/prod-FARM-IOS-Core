# Instagram automation

The built-in Instagram plugin (`com.backline.instagram`) posts reels, single
photos and carousels, and runs a persona-driven warm-up. It is structured like
the TikTok plugin: two versioned tasks, one routine per platform behind each, a
device panel, and a network picker in the dashboard that chooses between the
two.

> **Nothing in this document has been confirmed against a phone.** Every
> selector and every coordinate ships as a guess and is marked as one in the
> source. Read [§ Selectors to verify](#selectors-to-verify) before the first
> hardware session, and correct the tables rather than the flows.

## What it can do

| Task | Payload | Notes |
| --- | --- | --- |
| `post@1` | `media[]`, `format`, `destination`, `account?`, `caption?`, `recurringPublishConfirmed?` | `format` is `reel`, `photo` or `carousel`; omitted, it is inferred from the media |
| `warmup@1` | `durationMinutes?`, `surface`, `personality`, `likeEnabled`, `saveEnabled`, `account?`, `persona?` | `surface` is `feed`, `reels` or `both` |

### Formats and limits

Validation lives in `src/instagram/post-manifest.ts` (`formatProblem`) and runs
in three places: the task validator, the upload route, and the routine itself
before a byte is pushed to the phone.

| Format | Media | Refused |
| --- | --- | --- |
| `reel` | exactly 1 video | an image, or more than one file |
| `photo` | exactly 1 image | a video, or more than one file |
| `carousel` | 2–20 images | fewer than 2, more than 20, or any video |

**No format mixes media.** A carousel with a clip in it is rejected with
"A post is either video or images — Instagram cannot mix them in one upload",
before anything is uploaded, pushed or opened. Instagram's own composer accepts
mixed carousels; the automated flow cannot, because the two kinds of media open
different editors.

Other limits: a caption is at most 2,200 characters, and on an `adb`-driven
phone it must be printable ASCII (`adb shell input text` cannot type anything
else — switch the device to the a11y bridge, which types UTF-8).

### Accounts

A phone's Instagram handles are **not** its TikTok handles. They live under
`pluginData["com.backline.instagram"].accounts` and are edited from the
Instagram device panel, or with
`PATCH /api/devices/:udid/instagram/accounts`.

A post with no `account` posts from whichever account the phone is already on —
the routine simply skips the switcher. A post that *names* an account switches
to it and refuses to continue unless it can read the handle back off the
profile header afterwards, because posting from the wrong account is the one
outcome that cannot be undone.

## The flows

### Android (`src/instagram/android/`)

Everything goes through the `DeviceDriver` abstraction (`adb` or the a11y
bridge), tree-first with an OCR fallback. Both routines wake the phone, launch
`com.instagram.android`, and press **Home** at the end so a phone is never left
sitting inside the app.

**`post.ts`**

1. Validate the format and the caption; **then** push the media, newest-last,
   so manifest file 1 is the newest gallery cell.
2. Wake → launch → optional account switch.
3. **+** → the surface strip (`REEL` for a reel, `POST` otherwise) → the
   gallery, if the build opened the camera instead of the grid.
4. For a carousel: **Select multiple**, then the cells top-left first — which,
   after the reversed push, is slide order.
5. **Next** up to four times, dismissing optional "Add audio"-style prompts,
   until the caption field is on screen.
6. Caption → type → **back** to close the keyboard.
7. **Share**, or — for a draft — **back** out of the share screen and take the
   **Save draft** sheet it opens. Instagram has no Drafts button on the share
   screen.
8. Wait for the confirmation string, then **Home**.

**`warmup.ts`** — persona-driven browsing. `beginSession` decides whether the
account is even awake and how long it feels like browsing; every post on screen
is read with `readVideo` and `decideForVideo` picks the watch time and whether
to like, save or follow. Without a persona it falls back to the three
personality profiles. `surface: 'both'` spends the first half of the session on
the feed and the rest in reels. Every swipe and every pause comes out of one
seeded `MotionSource` (`src/motion`), so a run is reproducible from its
execution id and different from every other run.

**Tolerant steps.** Optional screens are skipped, never fatal: the surface
strip, the gallery entry, audio prompts, the multi-select toggle for a single
file. A *required* control that is missing fails with the alternates that were
tried and the texts that were actually on screen — which is the information a
selector fix needs.

### iOS (`src/instagram/post.ts`, `src/instagram/warmup.ts`)

WebDriverAgent + XCUITest against `com.burbn.instagram`. XCUITest can barely
see inside Instagram, so — exactly as with TikTok on iOS — these are coordinate
flows driven from the device's coordinate profile, with OCR used only where a
*value* has to be read back (which account is active, whether a **Follow**
button is on screen).

Coordinates come from the `instagram` section of the profile in
`src/devices/coordinates.ts`, reached through `resolveDeviceCoordinates()`.
**Every default there is unverified** — see [coordinates.md](coordinates.md).
Unlike the TikTok section, the Instagram points are not yet exposed in the
dashboard's calibration dialog; edit the profile.

## Selectors to verify

Selectors marked GUESS have never been checked against a real device. You can confirm them by hand
and record them as data rather than as a code change — or have a cheap agent walk the flow and do it
for you: see [the calibration agent](agent.md).


Dump the tree on a real phone and correct the tables:

```sh
adb -s <serial> shell uiautomator dump /dev/tty
# if the device refuses /dev/tty:
adb -s <serial> shell uiautomator dump /sdcard/dump.xml \
  && adb -s <serial> shell cat /sdcard/dump.xml
```

`POST_SELECTORS` in `src/instagram/android/post.ts`:

| Control | Guessed alternates |
| --- | --- |
| `profileTab` | `profile_tab`, `tab_avatar`, "Profile", "Your profile" |
| `accountSwitcher` | `action_bar_title_chevron`, `title_view`, "Switch accounts" |
| `create` | `creation_tab`, `tab_icon_create`, "Create", "New post" |
| `reelTab` / `postTab` | `tab_reel` / `tab_post`, "Reel" / "Post" |
| `gallery` | `gallery_button`, "Gallery", "Add" |
| `selectMultiple` | `gallery_multi_select_button`, "Select multiple" |
| `next` | `next_button_textview`, `next_button`, "Next" |
| `dismissAudio` | "Not now", "Skip", "Dismiss" |
| `captionField` | `caption_input_text_view`, "Write a caption" |
| `share` | `share_footer_button`, "Share" |
| `saveDraft` | "Save draft", "Save as draft" |
| `publishSuccess` | "Posting", "Your post is being shared", "Sharing" |
| `draftSuccess` | "Draft saved", "Saved to drafts" |
| `galleryCellIds` | `gallery_grid_item_thumbnail`, `image_view`, `media_thumbnail` |

`FEED_SELECTORS` in `src/instagram/android/warmup.ts`: `homeTab`, `reelsTab`,
`like`, `save`, `follow`, `searchEntry`, `searchField`, `searchResult` — all
guesses.

Before the first run, grant the gallery permission **by hand**: open Instagram
→ **+** and accept the photos/media prompt. The routines never answer system
dialogs, and a phone that has never been through the picker stalls there.

## Environment

| Variable | Used by | Default |
| --- | --- | --- |
| `INSTAGRAM_PACKAGE` | Android routines | `com.instagram.android` |
| `INSTAGRAM_BUNDLE_ID` | iOS routines | `com.burbn.instagram` |
| `INSTAGRAM_SWITCH_ACCOUNT` | both warm-ups | — |
| `WARMUP_DURATION_MINUTES` / `WARMUP_SURFACE` / `WARMUP_PERSONALITY` | both warm-ups | `5` / `both` / `casual` |
| `WARMUP_PERSONA` / `WARMUP_LIKE_ENABLED` / `WARMUP_SAVE_ENABLED` / `WARMUP_FOLLOW_ENABLED` / `WARMUP_SEARCH_ENABLED` | both warm-ups | `false` / `true` / `true` / `true` / `true` |

`MOTION_SEED`, `MOTION_HAND` and `MOTION_SPEED` are exported by the executor
and behave exactly as they do for the TikTok routines ([motion.md](motion.md)).

## Routes

| Route | Purpose |
| --- | --- |
| `PATCH /api/devices/:udid/instagram/accounts` | the phone's Instagram handles |
| `POST /api/devices/:udid/instagram/posts` | multipart upload + schedule |
| `GET /api/devices/:udid/instagram/posts/current` | latest post run and its log |
| `POST /api/devices/:udid/fragments/instagram-warmup-run` | the warm-up form; returns the Activity fragment |

## In the dashboard

- **Device page** — the "Warm up" and "Prepare a post" dialogs have a
  **Network** picker. Instagram adds a **Surface** field to the warm-up, drops
  the TikTok-only Music URL from the post, makes the account optional and
  raises the media limit to 20. The Instagram panel further down the page keeps
  this phone's Instagram handles and offers the same two forms directly.
- **Control Center** — "Schedule post" and "Warm up" both start with the same
  **Network** picker and fan the chosen plugin's task out over the selection.

## Starter runbooks

Three flows ship per platform, seeded on first boot alongside the TikTok ones:
**Instagram warm-up**, **Instagram reel post** and **Instagram carousel post**
(`src/runbook/templates/instagram-*.json`). Every unconfirmed label in them is
marked `guess`, which the narration reads out as "(unverified)".
