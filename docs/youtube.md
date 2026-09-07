# YouTube Shorts

The built-in YouTube plugin (`com.backline.youtube`) posts Shorts and warms
phones up on the Shorts feed. It is built exactly like the TikTok plugin: two
versioned tasks, one routine per platform behind each of them, and nothing in
the plugin itself that knows how a phone works.

| Task | What it does | Routine (Android / iOS) |
|---|---|---|
| `post@1` | Uploads one vertical clip (≤ 60 s) as a Short, with a title, an optional description, and either Public or a draft | `src/youtube/android/post.ts` / `src/youtube/post.ts` |
| `warmup@1` | Browses the Shorts feed as the account's persona — watching, liking, subscribing, occasionally commenting — and ends on the home screen | `src/youtube/android/warmup.ts` / `src/youtube/warmup.ts` |

App ids: **`com.google.android.youtube`** (package) and
**`com.google.ios.youtube`** (bundle). Override them with `YOUTUBE_PACKAGE` /
`YOUTUBE_BUNDLE_ID`.

## What the routines expect on the phone

- **YouTube installed and already signed in**, with every channel the schedule
  uses added to the in-app account list. The routines never type credentials.
- **Gallery permission granted once, by hand**: open YouTube → **+** → *Upload
  a video* and accept the photos/media prompt. The routines do not answer system
  permission dialogs.
- **Screen unlocked and staying awake** on Android (Developer options → *Stay
  awake*); on iPhone the WDA remote unlocks with the device's passcode layout.
- Media is pushed with `adb push` into `/sdcard/DCIM/Camera` plus a
  media-scanner broadcast, so the newest gallery cell is the clip just pushed.
- A Short is **one video**. The plugin refuses more than one file, and refuses an
  image — an image slideshow is a TikTok idea, not a Shorts one.

## The posting flow

Create (**+**) → *Upload a video* / gallery → the newest clip → **Next** through
the Shorts editor → title → (description, when the build has a box for it) →
**Visibility → Public** → the *made for kids* question → **Upload Short**.
A `draft` destination skips the visibility step and taps **Save draft** instead.

Three of those steps are deliberately **tolerant** — they are skipped with a log
line rather than failing the run, because YouTube shows them on some builds and
not others:

- the description box,
- the visibility row and its sheet,
- the audience ("Is this video made for kids?") question, which some channels
  have already answered account-wide.

Everything else is required: a missing Create, Upload, title box or Upload Short
fails with the alternates that were tried and the texts that were on screen.

### Channel switching

Avatar → (*Switch account*) → the row whose text is **exactly** the handle →
reopen the avatar sheet and confirm. The check reads the *header* of the account
sheet, not merely "the handle is somewhere on screen": the sheet lists every
channel on the phone, so presence proves nothing about which one is active. Row
matching is exact so `@bob` can never land on `@bobby`.

## The warm-up

The decision layer is `src/persona/**`, unchanged and shared with TikTok:

- **watch time**, **like** and **subscribe** come straight out of
  `decideForVideo`. Subscribing is the persona's `follow` — "a channel it keeps
  enjoying" is the same judgement as a creator it keeps enjoying.
- **commenting** is this plugin's own step (`decideComment` in
  `src/youtube/android/warmup.ts`): only on a video that matched the persona's
  interests, only inside a small budget derived from the session, and then only
  about a fifth of the time. It is **off unless asked for** — it is the one
  thing here that is public and permanent. Phrases come from `COMMENT_PHRASES`,
  and a comment the device driver cannot type (adb is ASCII-only) is skipped.
- pacing, flick arcs and press durations come from `src/motion`, seeded once per
  run from `MOTION_SEED`.
- an account outside its persona's active hours does not browse at all; the run
  ends `asleep` after one clock read.

However it ends — finished, stopped, or an error on the way — the routine
**presses Home**, so a phone is never left looping a Short between runs.

## Environment

The executor exports the device (`DEVICE_UDID`, `DEVICE_PLATFORM`,
`DEVICE_DRIVER`, `ANDROID_SERIAL`, `A11Y_BRIDGE_URL` / `A11Y_BRIDGE_TOKEN`,
`MOTION_SEED`, `MOTION_HAND`, `MOTION_SPEED`); the plugin adds:

| Variable | Task | Meaning |
|---|---|---|
| `YOUTUBE_PACKAGE` / `YOUTUBE_BUNDLE_ID` | both | App id overrides |
| `YOUTUBE_DURATION_MINUTES` | warm-up | 1–180; absent lets the persona choose |
| `YOUTUBE_PERSONALITY` | warm-up | `skimmer` \| `casual` \| `engaged`, the pre-persona fallback |
| `YOUTUBE_PERSONA` | warm-up | `true` when browsing as the account's persona |
| `YOUTUBE_LIKE_ENABLED` / `YOUTUBE_SUBSCRIBE_ENABLED` / `YOUTUBE_COMMENT_ENABLED` | warm-up | Engagement switches (comments default `false`) |
| `YOUTUBE_SWITCH_ACCOUNT` | both | `@handle` of the channel to post/browse as |

## Running one by hand

```sh
ANDROID_SERIAL=R58N12ABCDE DEVICE_PLATFORM=android DEVICE_DRIVER=adb \
  node --import tsx src/youtube/android/post.ts /path/to/manifest.json

ANDROID_SERIAL=R58N12ABCDE DEVICE_DRIVER=adb YOUTUBE_DURATION_MINUTES=3 \
  YOUTUBE_PERSONALITY=casual YOUTUBE_LIKE_ENABLED=true YOUTUBE_SUBSCRIBE_ENABLED=true \
  node --import tsx src/youtube/android/warmup.ts
```

The manifest shape is `src/youtube/post-manifest.ts`: `device`, `files` (exactly
one), `title`, `destination`, optional `caption`, `account` and `madeForKids`.

## The selector table

Selectors marked GUESS have never been checked against a real device. You can confirm them by hand
and record them as data rather than as a code change — or have a cheap agent walk the flow and do it
for you: see [the calibration agent](agent.md).


Targeting is tree-first (`resource-id`, text, `content-desc`) with an OCR
fallback, never recorded coordinates. Every control is a list of alternates
tried in order, kept in one table per routine:

- posting: `POST_SELECTORS` at the top of `src/youtube/android/post.ts`
- the feed: `FEED_SELECTORS` at the top of `src/youtube/android/warmup.ts`

| Control | Selectors tried, in order | Marked GUESS in source? |
|---|---|---|
| Account avatar | `#image_view`, `#avatar`, `#account_button`, "Account", "Your account", "Profile" | **GUESS** |
| Active channel (header, read only) | `#account_name`, `#channel_name`, `#account_title`, `#header_name` | **GUESS** |
| Switch account | `#switch_account`, "Switch account", "Switch accounts", "Use another account" | **GUESS** |
| Create (+) | `#create_tab`, `#fab_create`, `#image_create`, "Create", "Create a Short", "Add" | unmarked |
| Upload a video | `#upload_video`, `#gallery_button`, `#shorts_camera_gallery`, "Upload a video", "Upload video", "Gallery", "Add" | unmarked |
| Next (editor, then details) | `#btn_next`, `#next_button`, "Next", "Done" | unmarked |
| Title field | `#title_edit_text`, `#video_title`, `#edit_text`, "Add a title", "Add a title that describes your Short", "Title" | unmarked |
| Description field | `#description_edit_text`, `#video_description`, "Add description", "Description" | **GUESS** — optional |
| Visibility | `#privacy_button`, `#visibility_button`, "Visibility", "Who can see", "Private", "Unlisted" | **GUESS** — optional |
| Public | "Public", "Everyone" | unmarked |
| Audience | `#audience_button`, `#made_for_kids`, "Audience", "made for kids", "Select audience" | **GUESS** — optional |
| Not made for kids | "No, it's not made for kids", "not made for kids" | **GUESS** |
| Upload Short | `#upload_button`, `#publish_button`, "Upload Short", "Upload", "Post" | unmarked |
| Save draft | `#save_draft`, "Save draft", "Save as draft", "Drafts" | **GUESS** |
| Upload confirmation | "Uploading", "being uploaded", "Your Short is uploading", "Upload complete", "Posted" | **GUESS** |
| Draft confirmation | "Draft saved", "Saved to drafts", "Drafts" | **GUESS** |
| Gallery cell | `resource-id` ending `thumbnail`, `iv_thumbnail`, `image_view`, `video_thumbnail`, `media_item`; or a `content-desc` containing video/seconds/photo/image | **GUESS** |
| Shorts tab | `#shorts_tab`, `#pivot_shorts`, "Shorts" | **GUESS** |
| Like | `#reel_like_button`, `#like_button`, "Like this video along with", "Like", "Unlike" | **GUESS** |
| Subscribe | `#reel_subscribe_button`, `#subscribe_button`, "Subscribe" | **GUESS** |
| Comments | `#reel_comment_button`, `#comments_entry_point`, "Comments", "Comment" | **GUESS** |
| Comment box | `#comment_edit_text`, `#create_comment`, "Add a comment", "Add a public comment" | **GUESS** |
| Send comment | `#send_button`, `#comment_send`, "Comment", "Send" | **GUESS** |

**No row above has been confirmed against a real device.** Read the real values
off a phone and correct the table; the flow itself should not need to change:

```sh
adb -s <serial> shell uiautomator dump /dev/tty
# if the device refuses /dev/tty:
adb -s <serial> shell uiautomator dump /sdcard/dump.xml \
  && adb -s <serial> shell cat /sdcard/dump.xml
```

Every failure message already names the control, the alternates that were tried
and the texts that were on screen.

## iPhone

The iOS routines drive through WebDriverAgent with coordinate taps, the same way
the TikTok ones do, because XCUITest cannot see into the Shorts player. The
points live in the `youtube` block of the device's coordinate profile
(`src/devices/coordinates.ts`) — **every one of them is unverified**; see
[coordinates.md](coordinates.md). Unlike the TikTok points they are not yet
re-pointable per device from the dashboard.

## Starter runbooks

Three flows ship for each platform (`src/runbook/templates`), for the operator
who would rather record and replay than schedule a task:
`youtube-warm-up`, `shorts-post`, `shorts-post-draft`, each with an `-ios` twin.
Every label in them that nobody has confirmed on hardware carries `guess: true`,
which the narration reads out as "(unverified)".
