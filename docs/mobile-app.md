# Companion mobile app

The operator's phone app: watch the fleet, unstick a run, approve a post, get
paged when something breaks. It is a **client of the same JSON API** as the
dashboard — it adds no automation of its own and holds no state the Mac does not
already have.

- The *why* and the order of work: [`docs/companion-app-plan.md`](companion-app-plan.md).
- The wire contract: [`docs/mobile-api.md`](mobile-api.md).
- This document: how to run it, point it at a farm, and ship it.

## Layout

```
apps/mobile/              Expo app (Expo Router, TypeScript strict)
  app/                    routes — (tabs)/ plus device/[udid] and execution/[id]
  src/screens/            one file per screen; the routes are three-line wrappers
  src/components/         Card, Badge, Button, StatusDot and four layout scraps
  src/context/            Settings, Farm, Alerts, Safety — React context, no store
  src/lib/                secure storage, push registration
  test/                   React Native Testing Library
packages/farm-client/     the typed API client — no React, no DOM
  src/models.ts           every wire shape, mirrored from docs/mobile-api.md
  src/http.ts             base URL + bearer + timeouts + { error } unwrap
  src/client.ts           the FarmClient interface both implementations satisfy
  src/sse.ts              SSE parser, Last-Event-ID resume, jittered backoff
  src/event-text.ts       event → human string, shared with the desktop app
  src/mock/               createMockFarm() — 12 fake devices that tick
  test/                   jest, node environment
```

`packages/farm-client` has **no build step**: `main` points at `src/index.ts`
and Metro transpiles it. The Electron app can depend on it the same way. Keep it
free of React imports — that is the one rule that makes the reuse work.

**Every network call goes through `farm-client`.** No screen calls `fetch`. When
the farm renames a field, `models.ts` is the only file that changes.

## Setup

```sh
cd apps/mobile
npm install
npm run start          # Metro; press i for iOS, a for Android
# or, from the repo root
npm run mobile:start
```

Requirements: Node 22+, and Xcode with a simulator for iOS. Nothing else — the
app runs against demo data out of the box.

### Tests

```sh
npm run mobile:test    # from the repo root
```

One `jest` invocation, two projects: `farm-client` in a node environment
(HTTP error mapping, the SSE parser and its `Last-Event-ID` resume, the mock
farm's invariants) and `app` under `jest-expo` (Fleet and Alerts rendering from
the mock client). 95 tests.

`npm run check` at the repo root is unchanged — the farm's own typecheck and
tests do not see `apps/mobile`.

## Demo mode

**Demo data is on by default.** A fresh install has no token and no Mac to talk
to, and an empty grid is a worse first screen than fake data that says it is
fake. Settings → Demo → *Use demo data* toggles it.

`createMockFarm()` implements the same `FarmClient` interface as the HTTP
client, so flipping the toggle swaps one object in a React context and no screen
knows the difference. It gives you:

- 12 devices — 2 iOS, 10 Android; three busy, one offline, one disabled, one
  erroring — with tags, so the filter chips have something to filter.
- Schedules covering all four timing shapes and all four statuses; executions
  covering all seven statuses, with logs.
- Events ticking every five seconds through the same subscription the SSE client
  uses, so the Alerts tab is live.
- Real PNG screenshots, generated in-process by a ~100-line encoder, so the
  thumbnails are pictures rather than grey boxes.
- The conflicts that matter: remote input during a run is a `409` with the
  farm's exact wording, disabling a busy device is a `409`, retrying a succeeded
  execution is a `409`, an unknown id is a `404`. Those branches are most of what
  the UI has to render, and they are the ones a happy-path fake would hide.

Nothing leaves the phone in demo mode. The mock is also what the tests run
against, so it is not throwaway code.

## Connecting to a real farm over Tailscale

**The farm is never exposed on the public internet.** No port forwarding, no
reverse proxy on a VPS. Tailscale is the transport.

1. Install Tailscale on the Mac and on the phone; join the same tailnet.
2. On the Mac, keep `WEB_HOST` bound to the Tailscale interface and
   `PHONE_FARM_AUTH_PLUGIN` configured — `assertSafeBind` refuses a non-loopback
   bind without one, and that check is doing real work here.
3. Mint a token **for that phone**, named:

   ```sh
   npm run token:create -- --name marcus-iphone
   ```

4. In the app: Settings → Server → paste the MagicDNS URL
   (`http://farm-mac.tailnet-1234.ts.net:3000`), then **Test** — it hits
   `/health`, which is cheap and does not touch USB. It reports the round-trip
   time and the farm's release sha.
5. Settings → Token → paste. It goes straight to `expo-secure-store`
   (Keychain, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` — never synced to iCloud, never
   restored to a different phone from a backup) and is never shown again: the UI
   shows `pf_live_…3c4f` and a **Replace** button.
6. Turn *Use demo data* off.

A second **LAN** URL is supported as a fallback for when you are at home.

**TLS.** Over Tailscale the link is already WireGuard-encrypted, so plain HTTP
inside the tailnet is defensible. Do it properly anyway: `tailscale cert` gives
you a real Let's Encrypt certificate for the MagicDNS name. The app ships **no**
ATS or cleartext exceptions, so if you terminate TLS you will not need to add
any; if you stay on HTTP, add the exception for the tailnet hostname only, never
`*`, and file it as debt.

**Revocation.** One token per phone means one lost phone is one
`DELETE /api/tokens/:id`, not a fleet-wide rotation that breaks the desktop app
and the push relay at the same time. Tailscale's own device list is a second
revocation point.

### The biometric gate — what it is and is not

Writes that touch a phone (remote tap/swipe/home, stop, retry, reconnect,
disable, run-now) require the app to be **foregrounded** and a successful
`expo-local-authentication` prompt within the last two minutes. Backgrounding
relocks immediately, and remote control is locked on every entry to a device
screen.

This is a **client-side** gate. The API cannot tell a Face ID-verified request
from any other. It stops someone holding the unlocked phone; it does not stop
someone holding the token. The real guard is server-side: the farm answers `409`
to remote input whenever the device has a queued or running execution, and the
app renders that as a banner with a **Stop the run** button — which is the actual
intent behind the failed tap.

### Offline

The last fleet snapshot is cached to AsyncStorage and rendered behind a dimmed
*"Last updated 12 minutes ago — can't reach the Mac"* banner, with every action
control disabled. **Nothing is queued for replay**: a stop or a tap that fires
twenty minutes late on a phone farm is worse than one that never fired.

Foregrounded, the app holds one `/api/events/stream` connection and polls the
fleet summary every 15 s. Backgrounded, it closes the socket and does nothing —
both platforms suspend sockets within seconds, and push is the background
transport.

## Push setup

The farm has no path to APNs or FCM, so the chain is:

```
farm web ──SSE──▶ farm-push-relay ──HTTPS──▶ Expo ──▶ APNs/FCM ──▶ phone
   ▲                     │
   └── POST /api/push/register ◀── this app
```

1. Run `ntfy` first (plan §8, M1) — it is zero app code and keeps working
   forever as the fallback pager.
2. Build and run `farm-push-relay` (gap 2) with its own named token.
3. In the app: Settings → Notifications → **Push alerts** on. It asks for the OS
   permission, fetches an Expo push token, and `POST /api/push/register`s it
   with the device label and the minimum severity. Registration is idempotent on
   the token, so it re-registers on every launch and on every preference change.
4. A tapped notification deep-links via `data.executionId` → `/execution/:id`,
   else `data.deviceUdid` → `/device/:udid`, else the Alerts tab. Cold start is
   handled too (`getLastNotificationResponseAsync`).

**Push needs a real device.** A simulator cannot register, and the app says so
rather than failing silently.

**Push bodies leave the tailnet.** `pushText()` in `farm-client` deliberately
carries a device *name* and a task name and nothing else — no UDIDs, no account
handles, no log lines. There is a test asserting that.

## EAS build notes

No public release, ever. TestFlight internal and the Play internal track, for a
handful of named people.

```sh
npm i -g eas-cli
eas login
eas init                       # writes extra.eas.projectId into app.json
eas build --platform ios --profile preview
eas submit --platform ios
```

- The bundle identifier and package name are `ai.gethandler.farm.companion`.
  Change both before the first build if that is not your team's namespace.
- **`extra.eas.projectId` is not committed.** `eas init` adds it; without it
  `getExpoPushTokenAsync` cannot mint a token, which is the first thing that
  breaks on a device build.
- Two update channels: `preview` (auto-published from `main`) and `production`
  (published manually, pinned to a build). EAS Update ships JS-only fixes in
  minutes, which is the common case for an internal tool.
- Config plugins are already declared in `app.json`: `expo-router`,
  `expo-secure-store`, `expo-local-authentication` (with the Face ID usage
  string), `expo-notifications`.
- The app version and the farm's `/health.release.sha` sit side by side in
  Settings → About. That is the first thing to check when the app and the farm
  disagree.
- Crash reporting (Sentry) is **not** wired up yet. When it is, it needs a
  scrubber that drops screenshot bodies, bearer tokens and any `pluginData` —
  screenshots contain logged-in accounts.

## Contract fields this app had to guess

Everything marked **planned** or **gap** in `docs/mobile-api.md` is being built
in parallel. Where the document left a shape ambiguous, the app made a choice.
Each of these is a one-line fix in `packages/farm-client/src/models.ts` if the
farm lands something different.

| # | Guess | Why, and what breaks if it is wrong |
| --- | --- | --- |
| 1 | **Event `id` is a string.** `docs/mobile-api.md` shows ULIDs (`01J9Z3M8QF…`); `docs/fleet-and-alerts.md` shows integers (`id: 42`). The client types it as `string` and compares cursors lexicographically. | ULIDs sort correctly as strings; **bare integers do not** (`"9" > "10"`). If the farm ships integer ids, `before` paging and the "is this event newer than the one I rendered" check both need a numeric comparator. This is the guess most worth confirming. |
| 2 | **`Last-Event-ID` is sent as a header.** `fleet-and-alerts.md` mentions `?lastEventId=` as an alternative. | If only the query parameter is honoured, resume silently replays from the beginning. |
| 3 | **The SSE endpoint accepts `Authorization: Bearer`.** `EventSource` cannot carry headers, so the client uses an `XMLHttpRequest` reader; the header is set manually. | If the stream only accepts a query-string token, the Alerts tab never goes live. |
| 4 | **`FleetCurrentExecution.startedAt` is nullable.** The example shows a value, but a `queued` execution has not started. | Cosmetic — a bad relative time. |
| 5 | **`FleetDevice.platform` is optional and absent means iOS**, mirroring `GET /api/devices`. | An Android device would render as iOS and offer no Back button. |
| 6 | **`connection.wda` can also be `unavailable`.** The doc lists that value for `appium` but not for `wda`; the client's union accepts it for both. | A widened union — safe either way. |
| 7 | **`nextBefore` is absent on the last page *and* on an empty page.** | An extra empty request at the end of the list. |
| 8 | **Keyset paging on `/api/schedules` and `/api/executions`** (`?limit=&before=`, gap 9). The client sends them; a farm that ignores them just returns its 200-row cap. | Nothing breaks today; the Queue tab simply stops at 200 rows. |
| 9 | **`?width=` on the screenshot is ignored harmlessly by an older farm** (gap 3), returning full resolution. | 12 full-size PNGs per refresh on a phone connection. `capabilities.screenshotThumbnails` is the intended signal; the app reads it. |
| 10 | **`tags` comes back from `GET /api/devices` as well as the fleet summary** (gap 12), and `PATCH /api/devices { tags }` replaces the whole array. | The tag filter chips come from the fleet summary, so the app survives without it. |
| 11 | **`remote/info`'s `screen.screenSize` is in points, and `/remote/action`'s `x`/`y` are in the same units** — `scale` is *not* applied. | Every tap lands at the wrong place, by a factor of 2 or 2.625. Untestable without a real phone; flagged in the plan as needing farm time. |
| 12 | **A `429` maps to a rate-limit error.** The documented status table stops at `503`; rate limits are gap 10. | Without it a `429` would render as a generic validation error. |
| 13 | **`POST /api/events/ack` returns the post-ack `unacknowledgedCount`.** | The tab badge would be one refresh behind. |
| 14 | **`POST /api/push/register` returns the registration on both `201` and `200`**, and `tokenSuffix` may appear on the single-registration response too (the doc only promises it on the list). | Cosmetic. |
| 15 | **`thumbnailUrl` on a content item is server-relative and needs the bearer header** like every other route. The app builds the URL from `assetId` via `assetThumbnailRef()` rather than trusting the field, so a change of shape does not reach the UI. | A broken thumbnail. |
| 16 | **`POST /api/content/queue/:id/approve` accepts an empty JSON body** when the slot is not being moved. | A `400` on every approve. |
| 17 | **`POST /api/schedules`'s `assetIds` is optional.** | A `400` on doomscroll-now. |
| 18 | **A missing `capabilities` key means `false`, but a missing `capabilities` object means "assume everything works".** Otherwise a farm that predates gap 4 would have every tab hidden. | The app 404s rather than hiding a tab — a worse failure, but a loud one. |
| 19 | **`stopExecution`'s `result: "not-found"` is unreachable** — the doc says `404` for that case. The client models both. | Nothing. |
| 20 | **`GET /api/mobile/bootstrap`'s `release` is optional**, present only when a `RELEASED` marker exists, matching `/health`. | A `—` in Settings → About. |

## What is not built yet

- Maestro E2E flows (plan §9). The unit and RNTL layers are in place.
- Kind-by-kind notification preferences — Settings registers the four
  push-worthy kinds and exposes only `minSeverity`. The API already takes the
  full list.
- Long-press quick-action sheet on a Fleet card; the actions live on the device
  screen.
- Content approval with re-timing (a date picker). Approve keeps the planned
  slot; the client method already takes `plannedFor`.
- Sentry, and the app-level PIN for cold start.
