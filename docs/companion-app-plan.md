# Companion mobile app — plan

A phone app for the operator (and one or two teammates) to watch and steer the
farm from away from the desk. The farm is one Mac on the operator's premises
with 2 iPhones and ~10 Android phones attached; the desktop Electron app, the
MCP server, the content drip queue, the fleet page and the runbook recorder are
being built in parallel. This app is a **client of the same JSON API** — it adds
no automation of its own.

The wire contract is `docs/mobile-api.md`. This document is the why and the
order of work.

## 1. Goals and non-goals

### Goals

1. **Know when something breaks, within a minute, without opening anything.** A
   phone that drops off USB at 2 a.m. or an execution that fails three attempts
   in a row should arrive as a notification.
2. **Answer "is the farm fine?" in one glance.** 12 device cards, state,
   what is running, what is next.
3. **Do the three things that unblock a stuck run from a phone**: stop or retry
   an execution, reconnect or disable a device, kick off a doomscroll now.
4. **Approve content on the move.** The drip queue's planned posts, with a
   thumbnail and a caption, approved or skipped with a thumb.
5. **Be safe to lose.** A stolen phone must not be a stolen farm: a named,
   revocable token in the keystore and biometrics in front of remote control.

### Non-goals

- **Not a public product.** No multi-tenant model, no accounts service, no
  app-store listing. Distribution is TestFlight internal and Play internal
  track, for a handful of named people.
- **Not device registration.** Registration needs Xcode, a cable, and a
  graphical session on the Mac. It stays on the desktop.
- **Not a full remote-control console.** Live MJPEG, coordinate calibration and
  the runbook recorder belong on the desktop app with a mouse. The mobile app
  gets still frames and coarse taps for unsticking, not authoring.
- **Not an offline authoring tool.** With no Mac reachable there is nothing to
  control; the app degrades to a cached read-only view and says so.
- **No new automation surface.** Anything the app can do, the API can already
  do, so the desktop app and MCP server can do it too.

## 2. Stack: Expo (React Native) + EAS, TypeScript

**Recommendation: Expo SDK with EAS Build and EAS Update, TypeScript, on the
new architecture.**

### Why not the alternatives

| Option | Verdict |
| --- | --- |
| **Expo / React Native** | Chosen. Same language, same types, same people. |
| **Flutter** | Genuinely good UI toolkit, but it is a second language (Dart), a second type system, and a second set of HTTP/SSE/JSON plumbing for a two-person shop whose entire stack — farm, dashboard, Electron app — is TypeScript. Nothing in this app is graphically demanding enough to buy back that cost. |
| **Native Swift + Kotlin** | Two apps, two release pipelines, two sets of bugs, for an internal tool with maybe eight screens. The only native-only win here is push, and §4 shows we do not need APNs directly. |
| **Bare React Native** | Costs the Expo tooling (EAS Build without a Mac in the loop, EAS Update for JS-only fixes, `expo-secure-store`, `expo-local-authentication`, `expo-notifications`) and buys nothing this app needs. |
| **A responsive web page + Add to Home Screen** | Tempting — the dashboard is already server-rendered. But it cannot receive push on iOS reliably, cannot use the Secure Enclave for the token, and cannot use Face ID as a gate. Those are three of the five goals. |

### What this buys concretely

- `expo-secure-store` → Keychain (iOS) / Keystore-backed EncryptedSharedPreferences (Android) for the bearer token, no native code.
- `expo-local-authentication` → Face ID / fingerprint gate in front of remote control.
- `expo-notifications` → push registration and handling for the Expo path in §4.
- **EAS Build** → signed iOS builds without the operator's Mac being the build machine, which matters because that Mac is busy driving 12 phones.
- **EAS Update** → JS-only fixes to internal testers in minutes, without a store round trip. This is the single biggest velocity win for an internal tool.

### What the desktop (Electron) app owner can reuse

Put these in a shared workspace package (`packages/farm-client`) rather than
copying:

| Reusable | Notes |
| --- | --- |
| **Types** | `RegisteredDevice`, `ScheduleTiming`, `TaskEnvelope`, `ExecutionRow`, `DeviceConnectionStatus`, and the planned event/fleet types, exported from the farm repo. One source of truth; the app never re-declares a shape. |
| **HTTP client** | Base URL + bearer header + the `{ "error": string }` unwrap + status→typed-error mapping. Identical on both. |
| **SSE client** | Same framing, same `Last-Event-ID` resume logic. Only the transport differs (`EventSource` on Electron, `react-native-sse` on mobile). |
| **Event → human string** | The mapping from `kind`/`data` to a title and body is shared by the notification, the desktop toast, and the Alerts list. Write it once. |
| **Task envelope helpers** | Building a valid `POST /api/schedules` body from `/api/plugins` output. |

Not reusable: navigation, layout, anything touching `window`. Keep the shared
package free of React.

## 3. Reaching the Mac from the phone

**The farm is never exposed on the public internet.** No port forwarding, no
dynamic DNS pointing at the operator's router, no reverse proxy on a VPS with
`:3000` behind it. The dashboard drives real phones with real logged-in
accounts and holds device passcodes in `devices.json`; treating it as an
internet-facing service is not a risk worth managing.

### Recommended: Tailscale

Install Tailscale on the Mac and on each phone; both join the same tailnet.

- The app's server URL becomes a MagicDNS name — `http://farm-mac.tailnet-1234.ts.net:3000`. Stable across the operator's router, café Wi-Fi, and LTE.
- WireGuard-based, NAT-traversing. **Nothing is opened on the router.**
- The bearer token works unchanged; Tailscale is transport, not auth. Two independent layers: you must be on the tailnet *and* hold a token.
- ACLs can restrict the phones' tailnet devices to `farm-mac:3000` only, so a compromised phone is not a foothold on the Mac's SSH.
- Tailscale's own device list is a second revocation point — remove the phone from the tailnet and it is off, even if the token leaks.
- Keep `WEB_HOST` bound to the Tailscale interface (or `0.0.0.0` with the Mac firewall allowing only `utun`), and keep `PHONE_FARM_AUTH_PLUGIN` configured — `assertSafeBind` refuses a non-loopback bind without one, and that check is doing real work here.

Cost: everyone must install and stay signed in to Tailscale. On a team of two
or three, that is a one-time conversation.

### Alternatives

| Option | Trade-off |
| --- | --- |
| **Plain WireGuard** | Same crypto, no dependency on Tailscale's coordination server, no account. But you hand-manage keys, and you need a stable inbound endpoint — meaning a forwarded UDP port on the operator's router or a relay VPS. That is exactly the exposure Tailscale removes. Choose this only if a third-party coordination server is unacceptable; accept the key management. |
| **Cloudflare Tunnel + Cloudflare Access** | Outbound-only from the Mac (no ports opened), real TLS on a real hostname, Access enforces SSO in front. Genuinely good. Costs: Cloudflare terminates TLS and can see the traffic, including screenshots of logged-in TikTok accounts; Access's JWT-vs-bearer interplay is fiddly for a native client (the app must carry a service token *and* the farm's bearer token); and it is another vendor in the path to a machine sitting 3 metres away. Reasonable fallback if Tailscale is blocked on a corporate network. |
| **Local Wi-Fi only** | Free and simple, works for "check the farm from the couch", useless for the 2 a.m. alert that matters. Support it as a fallback server URL, not the primary. |
| **Expose `:3000` with a reverse proxy** | Rejected. See above. |

Support **two saved server URLs** in Settings (`tailscale` and `lan`) and try
the LAN one first when its `/health` answers within 300 ms — it is faster and
saves battery at home. Fall back silently.

### TLS

Over Tailscale the link is already encrypted end-to-end by WireGuard, so plain
HTTP inside the tailnet is defensible. Do it properly anyway:

- Use `tailscale cert` to get a real Let's Encrypt certificate for the MagicDNS
  name and terminate TLS on the Mac. Public CA, real hostname, no pinning
  problems, no exceptions in the app.
- This avoids the alternative — a self-signed cert plus `NSExceptionDomains` /
  Android network-security-config exceptions — which is a permanent
  ATS/cleartext hole in the app binary and a permanent temptation to add "just
  one more" exception.
- If TLS on the Mac is deferred, allow cleartext for **the tailnet hostname
  only**, never `*`, and file it as debt.

## 4. Push notifications

The farm process has no path to APNs or FCM: it holds no APNs key, no Firebase
project, and no public endpoint for a provider to call back. Something has to
carry an event from the Mac to Apple's and Google's push infrastructure. Three
ways to do that.

### (a) Expo Push Service via a relay on the Mac

A tiny process — `farm-push-relay`, launchd-supervised alongside `worker` —
that subscribes to `GET /api/events/stream`, filters, and POSTs to Expo's push
API, which fans out to APNs and FCM.

```
farm web  ──SSE──▶  farm-push-relay  ──HTTPS──▶  exp.host/--/api/v2/push/send  ──▶ APNs / FCM  ──▶  phone
   ▲                       │
   └───── POST /api/push/register ◀── app (on launch, after permission grant)
```

- **Pros:** rich payloads (deep links straight to the failing device), per-token preferences, one code path across both platforms, no APNs key to manage, works with the exact severity/kind vocabulary the events table already has.
- **Cons:** ~200 lines of relay to write and supervise, Expo's push service is a third party in the path, and it is app-code work — so it is not landing this week.

### (b) Self-hosted ntfy — **recommended for day one**

`ntfy` is a pub-sub notification server. Run it in Docker on the Mac (or use
`ntfy.sh` with an unguessable topic; self-hosted on the tailnet is better).
Point one of the farm's **existing generic webhook alert channels** at a topic:

```
POST http://farm-mac.tailnet-1234.ts.net:8080/farm-alerts-<random>
Title: Doomscroll failed on iPhone 8 · slot 1
Priority: high
Tags: warning
Body:  TikTok did not reach the feed after 3 attempts
```

The operator installs the ntfy app from the App Store / Play Store, subscribes
to the topic, and gets background push. ntfy's iOS app receives via ntfy's own
APNs-registered service, so self-hosting the server does not cost you iOS push
— but note that this means the ntfy hosted service relays the notification, so
**keep titles and bodies free of account handles, passcodes, and UDIDs**; a
device *name* and a task name is enough to act on.

- **Pros:** **zero app code.** Working alerts the same day the webhook channel is pointed at it. Independent of the companion app's release cycle — it keeps working while the app is being rewritten. Priority, tags, and click-through URLs all supported.
- **Cons:** a second app on the operator's phone; no deep link into *our* app; per-person filtering means per-person topics; iOS delivery leans on ntfy's relay.

### (c) APNs direct (and FCM direct)

The farm holds an APNs auth key and talks HTTP/2 to Apple, plus a Firebase
service account for Android.

- **Pros:** no third party beyond Apple/Google; lowest latency.
- **Cons:** two provider integrations, an APNs key living on the Mac next to the device passcodes, token rotation, Android needing Firebase anyway, and all of it to be maintained by a two-person team. **Rejected** — the cost is real and the benefit over (a) is negligible at this scale.

### Decision

**Ship (b) for alerts on day one. Build (a) as the in-app path in M2.** They
coexist happily: ntfy is the always-on pager, Expo push is the one that opens
the right screen. Revisit only if Expo's service becomes a problem.

### The relay's contract

**On the farm (new endpoint — see `docs/mobile-api.md`):**

```
POST /api/push/register
{ "expoPushToken": "ExponentPushToken[…]", "name": "marcus-iphone",
  "minSeverity": "warning",
  "kinds": ["execution.failed", "device.disconnected", "device.error", "execution.stuck"] }
```

Idempotent on `expoPushToken`. `GET /api/push/registrations` lists them,
`DELETE /api/push/registrations/:id` revokes one. Registrations are stored in
Postgres next to the events table, not in `devices.json`.

**The relay loop:**

1. Open `GET /api/events/stream` with its own bearer token (minted
   `--name push-relay`), sending `Last-Event-ID` from a small state file.
2. On each event: load the registration list (cached, refreshed every 30 s).
   For each registration, deliver if
   `severity >= minSeverity` **and** (`kinds` is null **or** includes `kind`).
3. **Coalesce.** More than 3 events of the same `kind` for the same
   `deviceUdid` within 5 minutes collapse into one "iPhone 8 · slot 1: 6
   failures in 5 min". A cable that is half-out will otherwise emit
   `device.disconnected`/`device.connected` in a loop all night.
4. **Quiet hours.** A configurable window in which only `severity: error`
   breaks through; everything else is held and folded into `digest.daily`.
5. POST batches of ≤100 messages to Expo. Body:
   `{ to, title, body, sound, priority, data: { eventId, kind, deviceUdid, executionId } }`
   — `data` is what the app uses to deep-link.
6. Read the receipts. On `DeviceNotRegistered`, call
   `DELETE /api/push/registrations/:id` and stop retrying that token.
7. Persist `Last-Event-ID` **after** a successful send, so a relay crash
   replays rather than drops. Duplicates are acceptable; the app dedupes on
   `data.eventId`.
8. On SSE disconnect: reconnect with backoff (1 s → 30 s, jittered). Treat
   >40 s without the 15 s heartbeat as a dead connection.

The relay never talks to Postgres directly and never imports farm internals. It
is an API client, so it can move off the Mac later without changing anything.

## 5. Screens and flows

Six tabs. Everything below the fold is a detail push, not another tab.

### Fleet (default tab)

```
┌──────────────────────────────────────┐
│ Farm            ● 10/12    ⟳ 4s ago │   header: reachability + counts
├──────────────────────────────────────┤
│ [ all ] [ busy ] [ offline ] [ tag ▾]│   filter chips, incl. device tags
├──────────────────────────────────────┤
│ ┌───────────┐ ┌───────────┐          │
│ │ [thumb]   │ │ [thumb]   │          │   2-up grid, thumbnails ?width=320
│ │ iPhone 8  │ │ Pixel 6a  │          │
│ │ ● busy    │ │ ○ offline │          │
│ │ doomscroll│ │ cable?    │          │   currentExecution.summary / message
│ │ 4m elapsed│ │ next 14:00│          │
│ └───────────┘ └───────────┘          │
└──────────────────────────────────────┘
```

`GET /api/fleet/summary` for state, `GET /api/devices` for identity and tags
(merged in the client, cached). Thumbnails are lazy: only cards on screen
fetch, at most 4 concurrently, every 10 s while the tab is foregrounded, paused
entirely when it is not. Pull to refresh. Long-press a card → the quick-action
sheet without leaving the grid.

### Device

```
┌──────────────────────────────────────┐
│ ‹ Fleet    iPhone 8 · slot 1     ⋯   │
├──────────────────────────────────────┤
│  ┌────────────────┐                  │
│  │                │  ● ready         │   still frame, tap to refresh
│  │  screenshot    │  WDA is ready    │   connection.message verbatim
│  │                │  iOS 16.7.2      │
│  └────────────────┘                  │
├──────────────────────────────────────┤
│ Running: doomscroll · 4m · [ Stop ]  │
│ ▸ logs (tail 50)                     │
├──────────────────────────────────────┤
│ [ Doomscroll now ] [ Reconnect ]     │
│ [ Disable device ]                   │
├──────────────────────────────────────┤
│ Remote control      [ locked  🔒 ]   │   toggle → biometric prompt
└──────────────────────────────────────┘
```

- Screenshot from `…/remote/screenshot?width=<device width>`, manual refresh
  plus a 5 s auto-refresh only while remote control is unlocked. A `503` keeps
  the last frame and shows a subtle "stale" mark.
- **Remote control is locked by default on every entry to the screen.**
  Unlocking runs `expo-local-authentication`; the unlock lasts 2 minutes or
  until the app backgrounds, whichever is first. While locked, taps on the
  image do nothing and the overlay says why.
- When unlocked: tap maps image coordinates → device coordinates using
  `remote/info`'s `screen.screenSize`; drag becomes a swipe with a measured
  `durationMs`; a Home button. `409` from the server ("Remote input is disabled
  while automation is running") is rendered as a banner with a **Stop the run**
  button — that is the actual intent behind the failed tap.
- Quick actions: **Doomscroll now** posts a schedule with `timing: { kind: "now" }`
  and the envelope from `/api/plugins`; **Reconnect** posts
  `…/reconnect`; **Disable** patches `{ disabled: true }` behind a confirm,
  and surfaces the `409` if a run is active.

### Queue

Two segments, one list.

- **Schedules** — grouped by device, showing timing in the schedule's own
  timezone *and* the phone's local time (the operator will be in a different
  one). Swipe → pause/resume/cancel. Cancel confirms.
- **Executions** — reverse chronological, status pill, duration, error line.
  Tap → detail with the log tail. Swipe → stop (queued/running) or retry
  (failed/stopped).

Both cap at the server's 200 rows. When the app needs deeper history, ask for
keyset pagination on these two (listed as a gap).

### Content

The drip queue's planned posts.

```
┌──────────────────────────────────────┐
│ Up next                              │
│ ┌──────┐ "day 14 of building…"       │
│ │thumb │ iPhone 8 · Sat 18:00        │
│ └──────┘ [ Skip ]        [ Approve ] │
└──────────────────────────────────────┘
```

`GET /api/content/queue`; approve/skip post to the item. Approve optionally
re-times via a date picker. Optimistic update with rollback on error — the
operator is often approving five in a row on a train.

### Alerts

`GET /api/events` with filter chips for severity, kind group, and device.
Live-appends from `GET /api/events/stream` while foregrounded. A tap deep-links
to the device or execution. Swipe-to-acknowledge, and "mark all read" posting
`POST /api/events/ack { upToId }` — acknowledgement is **per token**, so two
teammates keep separate unread state.

This screen is also where a push notification lands when the app was cold: the
notification's `data.eventId` is resolved via `/api/events` and the app
navigates onward.

### Settings

Server URLs (tailscale + lan) with a **Test** button hitting `/health`; token
paste field (write-only — once stored it shows `pf_live_…3c4f` and a **Replace**
button, never the value); notification preferences (`minSeverity`, kind
checkboxes) which re-`POST /api/push/register` on change; Tailscale status —
reachability, resolved hostname, round-trip time, and a link out to the
Tailscale app when unreachable; app version and the farm's `/health.release.sha`
side by side, which is the first thing to check when the app and the farm
disagree.

### Offline behaviour, and SSE vs polling

**Cache what was last seen; never fabricate.** The fleet summary, device list,
and the last 200 events persist to disk (`expo-sqlite` or MMKV). Offline, the
app renders them behind a dimmed banner — *"Last updated 12 minutes ago — can't
reach the Mac"* — with every action control disabled. Nothing is queued for
later replay: a stop or a tap that fires twenty minutes late on a phone farm is
worse than one that never fired.

**Foregrounded → SSE.** One `/api/events/stream` connection, resumed with
`Last-Event-ID`. The 15 s heartbeat is the liveness check; >40 s of silence
means reconnect with jittered backoff. Fleet state still refreshes on a 15 s
timer, because events describe transitions and the summary describes state.

**Backgrounded → nothing.** Both platforms suspend sockets within seconds, and
fighting that with background tasks costs battery for results that arrive late
and unreliably. Close the SSE connection on `AppState` change to `background`,
and **let push be the background transport** — that is the whole reason §4
exists. On return to foreground: reconnect SSE with the stored `Last-Event-ID`,
refetch the fleet summary, and reconcile.

The one exception worth considering later is an iOS Live Activity for a
long-running batch, but only after M3.

## 6. Farm-side API gaps

Concrete checklist. **Small** ≈ under a day; **medium** ≈ one to three days.
Nothing here changes an existing response shape.

| # | Gap | Shape | Size |
| --- | --- | --- | --- |
| 1 | **Push registration** | `POST /api/push/register { expoPushToken, name, minSeverity, kinds }`; `GET /api/push/registrations`; `DELETE /api/push/registrations/:id`. New `scheduler.push_registrations` table + migration. Idempotent on token. | small |
| 2 | **Push relay process** | Not an endpoint — the `farm-push-relay` script of §4, plus an `npm run push:relay` entry and a launchd plist example. | medium |
| 3 | **Screenshot thumbnails** | `GET /api/devices/:udid/remote/screenshot?width=<px>` (clamp 120–1080, preserve aspect, keep `cache-control: no-store`, keep the quiet `503`). Resize in-process with `sharp`. Without this, a 12-card grid pulls ~30 MB per refresh. | small |
| 4 | **Mobile bootstrap** | `GET /api/mobile/bootstrap` → `{ serverTime, release, plugins, fleet, recentEvents, unacknowledgedCount, capabilities }`. Pure composition of existing calls; collapses 5 cold-start round trips into 1 and carries the `capabilities` flags that let one app build talk to an older farm. | small |
| 5 | **Event acknowledgement** | `POST /api/events/ack { upToId }`, per-token; `GET /api/events?acknowledged=false`; `unacknowledgedCount` in bootstrap. Needs the token identity to be addressable, which comes with gap 6. | medium |
| 6 | **Named token identity** | `npm run token:create -- --name` must persist the name and expose the caller's token id/name on the request (a `request.apiToken` decoration), plus `GET /api/tokens` and `DELETE /api/tokens/:id`. Prerequisite for per-device revocation (§7) and per-token ack. | medium |
| 7 | **Asset thumbnails** | `GET /api/assets/:id/thumbnail` → small JPEG; first frame for video, downscale for images. The Content screen is unusable without it. | medium |
| 8 | **Content queue read/approve/skip** | `GET /api/content/queue`, `POST /api/content/queue/:id/approve`, `POST /api/content/queue/:id/skip`. Owned by the drip-queue work; confirm the shapes in `docs/mobile-api.md` match. | small (if drip already models it) |
| 9 | **Keyset pagination on schedules/executions** | `?limit=&before=` on `/api/schedules` and `/api/executions`, matching the events cursor. Today both are capped at 200 with no way to go deeper. Not needed for M2. | small |
| 10 | **Rate limits** | `@fastify/rate-limit` keyed on token id: `/remote/action` 10/s, `/remote/screenshot` 5/s per device, writes 60/min, everything else 300/min. See §7. | small |
| 11 | **`state` in fleet summary** | Confirm `/api/fleet/summary` returns the derived `online\|busy\|offline\|disabled\|error` badge rather than making every client re-derive it from four fields. Coordinate with the fleet page owner. | small |
| 12 | **Device tags in `GET /api/devices`** | `PATCH /api/devices/:udid { tags }` is planned; make sure `tags` also comes back from `GET /api/devices`, not only from the fleet summary. | small |

## 7. Security

The threat model is narrow and real: **a phone is lost or stolen**, or a
teammate leaves. Everything below serves that.

**Token storage.** The bearer token lives in `expo-secure-store` — Keychain
with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` on iOS (never synced to iCloud, never
restored to a different device from backup), Keystore-backed encrypted prefs on
Android. Never in `AsyncStorage`, never in an env var baked into the bundle,
never logged, never in a crash report. Entry is paste-only into a write-only
field; after that the UI shows a suffix and a **Replace** button.

**Per-device tokens, named.** Every phone gets its own token:
`npm run token:create -- --name marcus-iphone`. One lost phone is one
`DELETE /api/tokens/:id`, not a fleet-wide rotation that breaks the desktop app
and the relay at the same time. The relay gets its own (`push-relay`), as does
each MCP client. Show the token name in Settings so the operator can say *which*
one to revoke. This is gap 6 and it is a prerequisite for taking the app
seriously, not a nice-to-have.

**Biometrics in front of control.** Reads need only the token. **Writes that
touch a phone** — remote tap/swipe/home, disable, reconnect, run-now, stop —
require the app to be **foregrounded** and a successful
`expo-local-authentication` prompt within the last 2 minutes. Backgrounding the
app relocks immediately. Approve/skip on the Content tab and pause/cancel on
schedules are lower stakes and sit behind the same lock only if the operator
turns on "strict mode".

Note this is a **client-side** gate — the API cannot tell a biometric-verified
request from any other. It exists to stop someone holding the unlocked phone,
not to stop someone holding the token. Do not describe it as more than that.

**Rate limits (gap 10).** Keyed on token id, not IP — every request arrives
from the same tailnet address.

| Route | Limit |
| --- | --- |
| `POST /api/devices/:udid/remote/action` | 10/s per device, burst 20 |
| `GET /api/devices/:udid/remote/screenshot` | 5/s per device |
| `POST /api/schedules`, `/api/schedules/bulk` | 30/min per token |
| Other writes | 60/min per token |
| Reads | 300/min per token |

These protect the *phones* more than the server: a runaway retry loop hammering
`remote/action` is a real way to wedge a WDA session.

**Everything else.**

- Never expose the farm publicly (§3). Tailscale ACLs restrict phones to
  `farm-mac:3000`.
- Screenshots contain logged-in TikTok accounts. Do not write them to the
  camera roll, do not include them in crash reports, and do not let the OS app
  switcher snapshot them — blur the screen on `AppState` `inactive`.
- Push bodies traverse Expo/ntfy and APNs/FCM: **device name and task name
  only**. No UDIDs, no handles, no passcodes, no log lines.
- The app never handles device passcodes. `GET /api/devices` already redacts
  them to `hasPasscode`; do not add a UI that would want them.
- `android.bridgeToken` comes back in the device record. Do not render it.
- Certificate handling per §3: a real cert via `tailscale cert`, and no
  blanket ATS or cleartext exceptions in the app binary.
- Optional and cheap: an app-level PIN for cold start, for the case where the
  phone's own lock is weak.

## 8. Milestones

Effort is for **one engineer**, working days, excluding review.

### M1 — Alerts via ntfy · **1 day** · no app code

Docker `ntfy` on the Mac; a random-suffix topic; the farm's existing generic
webhook alert channel pointed at it with title/priority mapped from
`severity`/`kind`; the ntfy app installed and subscribed on each phone; a
deliberate failure fired end to end to prove it.

Ships the highest-value goal before a line of React Native exists, and keeps
working forever as the fallback pager.

*Needs real phones?* No — a fake `device.error` event proves the path.

### M2 — Read-only app · **5–6 days**

Expo scaffold, secure token storage, Settings with server URL + `/health` test,
Fleet grid, Device detail (screenshot, connection, current execution, logs),
Queue (read-only), Alerts with filters and live SSE. Push registration and the
relay (gaps 1, 2) land here so in-app notifications arrive; bootstrap and
thumbnails (gaps 3, 4) are prerequisites.

*Buildable against fake data:* everything. Stand up the mock server (§9) on day
one and build all five screens against it.
*Needs real phones:* screenshot latency and thumbnail sizing, MJPEG-vs-still
judgement, and how a genuinely flapping device renders. Half a day at the end.

### M3 — Control · **4–5 days**

Biometric gate, remote tap/swipe/home with coordinate mapping, stop/retry,
pause/resume/cancel, reconnect/disable, doomscroll-now, the `409`-to-banner
flows, rate limits (gap 10), named tokens with revocation (gap 6).

*Needs real phones:* most of it. Coordinate mapping, gesture timing, and the
`activeExecution` guard's real behaviour cannot be faked convincingly. Budget
2 of the 5 days on the actual farm.

### M4 — Content approvals · **3–4 days**

Content tab, asset thumbnails (gap 7), approve/skip with optimistic updates and
re-timing, event acknowledgement (gap 5).

*Blocked on:* the drip queue landing its own model and endpoints. Build against
the mock in parallel; integrate when it lands.
*Needs real phones:* no, until an approved post actually runs.

**Total ≈ 13–16 engineer-days** across roughly four calendar weeks alongside
other work, with useful alerting from day one.

### Now vs. real phones

| Buildable today against fakes | Needs the farm |
| --- | --- |
| Every screen's layout and state handling | Screenshot latency, size, and refresh cadence |
| SSE client, reconnect, `Last-Event-ID` replay | Remote tap coordinate mapping across profiles |
| Push relay (replay a recorded event stream) | The `409`-during-execution flow |
| Offline cache and the stale banner | Reconnect and disable against a real supervisor |
| Token storage, biometric gate | Tailscale round-trip time on LTE |
| Error and empty states | Thumbnail load with 12 devices on a phone connection |

## 9. Testing and release

### Testing

**Mock server first, and it is not throwaway.** A small Fastify app serving the
shapes in `docs/mobile-api.md` from fixtures: 12 devices (2 iOS, 10 Android,
one disabled, one offline, three busy), a schedule/execution set covering every
status, a scriptable event stream, and a fault mode per endpoint (`503`
screenshots, `409` remote actions, 5 s latency, mid-stream SSE disconnect). It
unblocks M2 on day one, backs the E2E suite, and is the only way to reproduce
"the cable is half-out" on demand. Generate its types from the farm's exported
types so drift is a compile error.

**Unit / integration (Jest + React Native Testing Library) — where the value
is.** The SSE reconnect and replay logic, the offline cache and staleness
rules, the coordinate mapping, the biometric-gate state machine, the event →
notification string mapping, and every error-status branch. These are the parts
that will actually break, and they are all testable without a device.

**E2E: Maestro, not Detox.** Maestro's YAML flows are minutes to write and
survive refactors; Detox's speed and precision matter for a consumer app with a
hundred screens and a large team, not for eight screens and two people. Keep
about six flows: launch → token entry → fleet loads; alert tap → device detail;
unlock → tap → `409` banner → stop; pause/resume a schedule; approve a content
item; go offline → stale banner → controls disabled. Run them on the mock
server in CI on every PR.

**Manual, on the farm, before each internal release:** a written 15-minute
checklist — one real remote tap, one real stop, one real reconnect, one push
received with the app killed, one push received over LTE with the app killed.
The last two are the ones that regress silently and matter most.

**Do not automate against real phones.** They are production; an E2E suite that
taps a logged-in TikTok account is a way to lose an account.

### Release

- **iOS: TestFlight internal testing.** Up to 100 internal testers, no App
  Review for internal builds, and it does not need a public listing. `eas build
  --platform ios --profile preview` → `eas submit`.
- **Android: Play Console internal testing track.** Same shape; a small named
  tester list, minutes to propagate. (An `.apk` over Tailscale would work for
  two people, but the internal track gives update prompts and crash reports for
  the same effort.)
- **EAS Update** for JS-only fixes between builds — the common case for an
  internal tool. Two channels: `preview` (auto-published from `main`) and
  `production` (published manually, pinned to a build).
- **Versioning:** app version + the farm's `/health.release.sha` shown side by
  side in Settings, so "it's broken" starts with knowing which halves are
  talking.
- **Crash reporting:** Sentry, with a scrubber that drops screenshot bodies,
  bearer tokens, and any `pluginData`.
- **Cadence:** a build per milestone, updates in between. No public release,
  ever — this is internal software for a farm in one room.
