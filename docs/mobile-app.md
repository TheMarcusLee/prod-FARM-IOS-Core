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
  src/components/         Card, Badge, Button, StatusDot plus Row, Muted,
                          SectionTitle, EmptyState, StaleBanner, ErrorBanner, Loading
  src/context/            Settings, Farm, Alerts, Safety — React context, no store
  src/hooks/              shared hooks
  src/theme/              colours, spacing, type scale
  src/lib/                secure storage, push registration
  test/                   React Native Testing Library
packages/farm-client/     the typed API client — no React, no DOM
  src/models.ts           every wire shape, mirrored from docs/mobile-api.md
  src/http.ts             base URL + bearer + timeouts + { error } unwrap
  src/errors.ts           status → typed error
  src/client.ts           the FarmClient interface both implementations satisfy
  src/derive.ts           shared derivations (device badge, counters)
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
- Events ticking every four seconds through the same subscription the SSE client
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
   shows a masked suffix and a **Replace** button. (The screen's placeholder
   string still reads `pf_live_…`; real tokens are `pf_` plus 43 base64url
   characters, with no `live` segment.)
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
eas build --platform ios          # no eas.json is committed; eas init writes one
eas submit --platform ios
```

There is **no `apps/mobile/eas.json` in the repository**, so there are no build
profiles and no configured update channels yet — `eas init` / `eas build`
creates them on first use. Decide the profile and channel names then.

- The bundle identifier and package name are `ai.gethandler.farm.companion`.
  Change both before the first build if that is not your team's namespace.
- **`extra.eas.projectId` is not committed.** `eas init` adds it; without it
  `getExpoPushTokenAsync` cannot mint a token, which is the first thing that
  breaks on a device build.
- EAS Update ships JS-only fixes in minutes, which is the common case for an
  internal tool. `app.json` has no `updates` block yet; add one with the
  channels you settle on.
- Config plugins are already declared in `app.json`: `expo-router`,
  `expo-secure-store`, `expo-local-authentication` (with the Face ID usage
  string), `expo-notifications`.
- The app version and the farm's `/health.release.sha` sit side by side in
  Settings → About. That is the first thing to check when the app and the farm
  disagree.
- Crash reporting (Sentry) is **not** wired up yet. When it is, it needs a
  scrubber that drops screenshot bodies, bearer tokens and any `pluginData` —
  screenshots contain logged-in accounts.

## Contract questions, resolved

The app was written against `docs/mobile-api.md` while parts of the farm were
still landing, and it had to guess at a few shapes. The farm has since shipped
all of them; this is where the guesses ended up. Each correction is a one-line
change in `packages/farm-client/src/models.ts`.

**Wrong, and fixed in the client**

| Guess | Truth |
| --- | --- |
| Event `id` is a **string** (ULID), compared lexicographically | It is a **number** — the `scheduler.events` bigint identity, serialised as a JSON number. `models.ts` now types it `number` and compares `before` / `upToId` numerically. |
| `capabilities.screenshotThumbnails` is the thumbnail signal, and the app reads it | The farm never emits that key. `GET /api/mobile/bootstrap` returns `{ push, eventAck, thumbnails, contentQueue, tokens, rateLimits }`. `?width=` on the screenshot is implemented unconditionally. |
| A missing `capabilities` **key** means `false` | Every consumer gates on an explicit `false`, so a missing key means *available*. A missing `capabilities` object likewise means "assume everything works". |
| `POST /api/content/queue/:id/approve` accepts an empty body "when the slot is not being moved" | The handler reads no body at all. Re-timing is not supported in any form; move a slot with `PATCH /api/schedules/:id`. |

**Right, now confirmed against the code**

| Guess | Confirmed |
| --- | --- |
| `Last-Event-ID` is sent as a header | The farm honours the header **and** `?lastEventId=`, header first. |
| The SSE endpoint accepts `Authorization: Bearer` | It does; the `XMLHttpRequest` reader is still needed because `EventSource` cannot set headers. |
| Keyset paging on `/api/schedules` and `/api/executions` | Shipped: `?limit=` (default and max 200) and `?before=`, cursor in the lowercase `x-next-before` header. |
| `tags` on `PATCH /api/devices/:udid` replaces the whole array | Shipped: trimmed, de-duplicated, capped at 20. |
| A `429` maps to a rate-limit error | Rate limits are live, with `x-ratelimit-*` and `retry-after`. |
| `POST /api/events/ack` returns the post-ack `unacknowledgedCount` | It does. |
| `POST /api/push/register` returns the registration on both `201` and `200` | It does. |
| `FleetDevice.platform` absent means iOS | Matches `platformOf()` on the farm. |
| `POST /api/schedules`'s `assetIds` is optional | It is. |
| `GET /api/mobile/bootstrap`'s `release` is optional | Present only when a `RELEASED` marker exists. |

**Still open**

- **`remote/info`'s `screen.screenSize` units.** The client assumes points, and
  that `/remote/action`'s `x`/`y` are the same units with `scale` *not* applied.
  If that is wrong every tap lands out by a factor of 2 or 2.625. It cannot be
  settled without a real phone — see
  [device-testing-checklist.md](device-testing-checklist.md).
- `nextBefore` on `/api/events` is **always present**, and `null` only when the
  page was not full. An exactly-full last page still returns a cursor, so the
  client will make one extra request at the end of a list.
- `stopExecution`'s `result: "not-found"` is unreachable in practice — the route
  answers `404` first. The client models both, harmlessly.

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
