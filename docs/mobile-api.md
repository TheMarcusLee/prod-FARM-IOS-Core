# Mobile API contract

The surface the companion app codes against. Endpoints marked **planned** are
being implemented in parallel (fleet page, events/SSE, drip queue, MCP server);
their shapes here are the agreed contract, not a proposal. Endpoints marked
**gap** do not exist yet and are requested by the app — see
`docs/companion-app-plan.md` §6.

Everything else is live today in `src/api/app.ts`.

## Base

| | |
| --- | --- |
| Base URL | `http://<magicdns-name>:3000` (Tailscale), e.g. `http://farm-mac.tailnet-1234.ts.net:3000` |
| Content type | `application/json` unless noted (screenshots are `image/png`, SSE is `text/event-stream`) |
| Auth | `Authorization: Bearer <token>` on **every** request, including `GET` |
| Time | All timestamps are ISO-8601 with offset, serialised from `timestamptz` |

### Authentication

Tokens are minted on the Mac:

```sh
npm run token:create -- --name "marcus-iphone"   # planned CLI, prints the token once
```

```http
GET /api/devices HTTP/1.1
Authorization: Bearer pf_live_9f3c…
```

Every token has a name and an id, and every authenticated request carries that
identity server-side (`request.apiToken`), which is what per-device revocation
and the rate limits below key on. A cookie session is `{ id: "session",
name: "local" }`.

Password login exists only for the browser dashboard. The app must never use it.

### Rate limits

Keyed on the **token id** (falling back to the client IP), because every request
arrives from the same tailnet address. Only `/api/*` is counted; the dashboard's
own fragments and static assets are not.

| Route | Limit | Environment variable |
| --- | --- | --- |
| `POST /api/devices/:udid/remote/action` | 10/s, per device *and* token | `RATE_LIMIT_ACTION` |
| `GET /api/devices/:udid/remote/screenshot` | 5/s, per device *and* token | `RATE_LIMIT_SCREENSHOT` |
| Other writes | 60/min per token | `RATE_LIMIT_WRITE` |
| Reads | 300/min per token | `RATE_LIMIT_READ` |

`RATE_LIMITS=off` disables them entirely (tests). A refusal is a `429` with the
standard headers and the usual `{ "error": … }` body — respect `retry-after`
rather than retrying immediately.

A `Bearer` header also satisfies the app's CSRF guard: `createApp` rejects any
non-`GET` request that has neither a `Bearer` token nor a trusted `Origin`
(`src/api/app.ts`, the `onRequest` hook). So an app request without the header
fails with `403` on writes and `401` on reads — two different symptoms of the
same missing header.

### Errors

Every failure is a JSON object with a single `error` string. `setErrorHandler`
maps a thrown `statusCode` through, defaulting to `400`.

```json
{ "error": "Remote input is disabled while automation is running" }
```

| Status | When |
| --- | --- |
| `400` | Validation failure (bad payload, bad timing, unknown remote action) |
| `401` | Missing/invalid token |
| `403` | Cross-origin write blocked (missing `Bearer`) |
| `404` | Unknown device, schedule, execution, or asset |
| `409` | State conflict — remote input during a run, disabling a busy device, resuming a completed schedule, retrying a non-retryable execution |
| `413` | Body over the 50 MB limit (`createApp`'s `bodyLimit`). Only reachable on an upload; the message is Fastify's, not the farm's |
| `429` | Rate limit spent — see below. Carries `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` and `retry-after` |
| `503` | Subsystem unavailable — device flapping (screenshot), registration not configured, stream down |

`503` from `/remote/screenshot` has an **empty body**, not JSON — it is
deliberately quiet so a 5 s poll does not fill the log. Treat it as "no frame
right now" and keep the previous image.

### Pagination

Keyset everywhere, in two dialects:

| Family | Style |
| --- | --- |
| `/api/schedules`, `/api/executions` | Keyset (**implemented**). `?limit=` (default and max 200, newest first) plus `?before=<row id or ISO createdAt>`, and the optional `?deviceUdid=`. The next cursor comes back in the **`X-Next-Before`** response header, not in the body. Omit both parameters and the response is exactly what it always was: 200 newest rows and no header. |
| `/api/events` | Keyset (**implemented**). `?limit=` (default 50, max 200) plus `?before=<eventId>` to walk backwards, `?since=`/`?until=` for a time window; the cursor is `nextBefore` in the body. Ids are JSON **numbers**, not strings. |

Event ids are monotonic, so `before` is a stable cursor across inserts. For
schedules and executions the cursor is `(createdAt, id)`, so two rows created in
the same instant still page cleanly. `?before=` with an unknown row id is a
`400`. Do not paginate with offsets.

---

## Devices

### `GET /api/devices`

Registered devices joined with live USB discovery. This is the fleet's source
of truth for what exists; `/api/fleet/summary` is the source of truth for what
it is *doing*.

```json
[
  {
    "udid": "00008030-001A2B3C0E88802E",
    "name": "iPhone 8 · slot 1",
    "platform": "ios",
    "driver": "wda",
    "osVersion": "16.7.2",
    "productType": "iPhone10,4",
    "wdaLocalPort": 8100,
    "mjpegLocalPort": 9100,
    "coordinateProfile": "iphone8",
    "hasPasscode": true,
    "pluginData": { "com.git-agni.tiktok": { "handle": "@acct_one" } },
    "connected": {
      "udid": "00008030-001A2B3C0E88802E",
      "name": "iPhone 8 · slot 1",
      "osVersion": "16.7.2",
      "productType": "iPhone10,4"
    }
  },
  {
    "udid": "R58N12ABCDE",
    "name": "Pixel 6a · slot 7",
    "platform": "android",
    "driver": "a11y-bridge",
    "android": { "serial": "R58N12ABCDE", "bridgeUrl": "http://127.0.0.1:18307" },
    "hasPasscode": false,
    "disabled": true,
    "pluginData": {},
    "connected": null
  }
]
```

Notes the app must respect:

- `passcode` is **never** returned. `hasPasscode` is the only signal.
- `connected: null` means either not attached *or* `disabled: true` — check
  `disabled` before rendering "unplugged".
- `platform` absent means iOS; `driver` absent means `wda` on iOS, `adb` on
  Android (`src/drivers/select.ts`).
- `android.bridgeToken` is present in the record. Do not display it.
- `tags` comes back whenever the device has any: `GET /api/devices` returns the
  registry record minus the passcode, so `PATCH`-ing tags makes them visible
  here as well as in the fleet summary.

### `GET /api/devices/:udid/connection`

Live control-channel health, preferring the `wda-service` supervisor's own
state and falling back to a direct probe.

```json
{
  "udid": "00008030-001A2B3C0E88802E",
  "physical": "connected",
  "wda": "ready",
  "appium": "unavailable",
  "managed": true,
  "message": "WDA is ready",
  "retryCount": 0,
  "updatedAt": "2026-09-05T09:41:12.004Z"
}
```

`physical` is `connected | disconnected`. `wda` is the control-channel phase
(`ready`, `connecting`, `unlock-required`, `disconnected`, `error`); on Android
it reports adb or the bridge despite the name. Render `message` verbatim — it
is written to be operator-facing.

### `PATCH /api/devices/:udid`

Whitelisted fields only: `name`, `wdaLocalPort`, `mjpegLocalPort`, `passcode`,
`coordinates`, `disabled`, `coordinateProfile`, `pluginData`, and **planned**
`tags`.

```http
PATCH /api/devices/R58N12ABCDE
Authorization: Bearer …
Content-Type: application/json

{ "disabled": true }
```

Returns the updated, redacted device. `409` if the device has a queued or
running execution. `passcode: ""` clears the passcode; omitting it leaves it —
the app should never send this field.

`tags` (planned) replaces the whole array:

```json
{ "tags": ["warm-up", "us-east", "slot-row-2"] }
```

### `POST /api/devices/:udid/reconnect`

No body. Returns `202`:

```json
{ "ok": true, "message": "The shared WDA supervisor will reconnect automatically" }
```

`409` while automation is running.

### `GET /api/devices/:udid/remote/screenshot`

Returns `image/png`, `cache-control: no-store`. `503` with an empty body when
the device is flapping.

**Implemented** — `?width=<px>` for a thumbnail, clamped to 120–1080 and
aspect-preserving (never upscaled), resized in-process with `sharp`. Works for
both the iOS remote and the Android driver path. `cache-control: no-store` and
the quiet `503` are unchanged; a value that is not a number means full
resolution.

```http
GET /api/devices/00008030-…/remote/screenshot?width=320
```

### `GET /api/devices/:udid/remote/info`

```json
{
  "device": { "udid": "…", "name": "…", "osVersion": "16.7.2", "productType": "iPhone10,4" },
  "screen": { "screenSize": { "width": 750, "height": 1334 }, "scale": 2 }
}
```

Needed to map a tap in the app's image view back to device coordinates.
`404` if the device is not currently connected.

### `POST /api/devices/:udid/remote/action`

```json
{ "type": "tap", "x": 375, "y": 812 }
```

| `type` | Fields | Platforms |
| --- | --- | --- |
| `tap` | `x`, `y` | iOS, Android |
| `swipe` | `startX`, `startY`, `endX`, `endY`, `durationMs` | iOS, Android |
| `home` | — | iOS, Android |
| `back` | — | Android only |
| `text` | `text` | Android only |

Returns `{ "ok": true }`. `409` — `"Remote input is disabled while automation
is running"` — whenever the device has a queued or running execution. This
guard is server-side and non-negotiable; the app's safety toggle is a second
lock, not the first.

`400` with `"\"back\" is an iOS-only remote action"`-style text for an
unsupported verb on the platform.

`GET /api/devices/:udid/remote/stream` (MJPEG) exists but the app should not
use it — see the plan's §5 note on battery and background limits.

---

## Fleet — implemented

### `GET /api/fleet/summary`

**Counters only.** This is `summarizeFleet()` in `src/fleet/summary.ts`, shared
with the `/fleet` page and the tray app. It does **not** carry a device list,
and its `devices` object is a four-way registration/USB count, *not* the derived
per-device badge:

```json
{
  "generatedAt": "2026-09-05T09:41:12.004Z",
  "devices": { "total": 12, "online": 10, "offline": 1, "disabled": 1 },
  "byPlatform": { "ios": 9, "android": 3 },
  "running": 3,
  "queued": 2,
  "stuck": 0,
  "failedLast24h": 1,
  "succeededLast24h": 14,
  "plannedNext24h": 7
}
```

An earlier sketch of this endpoint described `{ counts, devices }` with a card
per device. That shape exists, but it is the `fleet` half of
`GET /api/mobile/bootstrap` — which is therefore what a Fleet screen should
poll. This one is for a header line and a tray badge.

`state` on a bootstrap device is the single derived badge the app renders:
`online | busy | offline | disabled | error`. The derivation is one pure
function —
`derivedDeviceState` in `src/fleet/summary.ts`, precedence
`disabled → offline → error → busy → online` — and
`GET /api/mobile/bootstrap` returns it per device, so the app never
re-derives a badge from four fields.

### `POST /api/schedules/bulk`

```json
{
  "deviceUdids": ["00008030-…", "R58N12ABCDE"],
  "tags": ["warm-up"],
  "task": { "pluginId": "com.git-agni.tiktok", "taskType": "doomscroll", "taskVersion": 1, "payload": { "minutes": 12 } },
  "timing": { "kind": "daily", "localTime": "09:30", "timezone": "America/New_York" },
  "runWindowMinutes": 30
}
```

`deviceUdids` and `tags` are unioned. Response reports per-device outcome so a
partial failure is legible — `created`/`failed` are **counts**, and the rows are
in `results`:

```json
{
  "created": 1,
  "failed": 1,
  "results": [
    { "deviceUdid": "00008030-…", "ok": true, "scheduleId": "8c1f…" },
    { "deviceUdid": "R58N12ABCDE", "ok": false, "error": "This device is disabled — activate it before scheduling automation" }
  ]
}
```

`201` when anything was created, `400` when nothing was.

---

## Schedules

### `GET /api/schedules?deviceUdid=`

```json
{
  "schedules": [
    {
      "id": "8c1f6b2e-9c0a-4a5f-9a1e-1f0f4b6d7c11",
      "deviceUdid": "00008030-001A2B3C0E88802E",
      "pluginId": "com.git-agni.tiktok",
      "taskType": "doomscroll",
      "taskVersion": 1,
      "payload": { "minutes": 12 },
      "timing": { "kind": "daily", "localTime": "09:30", "timezone": "America/New_York" },
      "status": "active",
      "runWindowMinutes": 30,
      "nextRunAt": "2026-09-06T13:30:00.000Z",
      "createdAt": "2026-09-01T11:02:44.881Z",
      "updatedAt": "2026-09-05T09:30:07.220Z"
    }
  ]
}
```

`status`: `active | paused | completed | cancelled`.

`timing` is one of four shapes (`src/types.ts`):

| `kind` | Fields |
| --- | --- |
| `now` | — |
| `once` | `runAt` (ISO) |
| `daily` | `localTime` `"HH:MM"`, `timezone` (IANA) |
| `weekly` | `localTime`, `timezone`, `weekdays` (`0`–`6`) |

### `POST /api/schedules`

```json
{
  "deviceUdid": "00008030-001A2B3C0E88802E",
  "task": { "pluginId": "com.git-agni.tiktok", "taskType": "doomscroll", "taskVersion": 1, "payload": { "minutes": 12 } },
  "timing": { "kind": "now" },
  "runWindowMinutes": 30,
  "assetIds": []
}
```

`201` with the schedule row. `404` unknown device, `409` disabled device,
`400` for payload/timing validation (including the minimum-gap rule in
`src/scheduler/validation.ts`).

The app must send `taskVersion` explicitly. Discover valid envelopes from
`GET /api/plugins`; never hard-code a version, and never send a version the
farm did not advertise — a stored envelope is resolved strictly and an unknown
version fails loudly rather than running v2 logic.

### `POST /api/schedules/:id/status`

```json
{ "status": "paused" }
```

Also available as `POST /api/schedules/:id/pause | /resume | /cancel` with no
body — prefer these from the app; they are one fewer thing to get wrong.

`409` on a disallowed transition (`completed` and `cancelled` schedules can only
be cancelled). The error text comes from `ScheduleTransitionError`.

### `PATCH /api/schedules/:id`

`{ timing?, runWindowMinutes?, recurringPublishConfirmed? }`. Returns the row,
or `409` `"Completed or cancelled schedules cannot be edited"`.

---

## Executions

### `GET /api/executions?deviceUdid=`

```json
{
  "executions": [
    {
      "id": "0b6d1c77-5e1a-4d33-9b8e-2f5a9c0f7e42",
      "scheduleId": "8c1f6b2e-9c0a-4a5f-9a1e-1f0f4b6d7c11",
      "deviceUdid": "00008030-001A2B3C0E88802E",
      "pluginId": "com.git-agni.tiktok",
      "taskType": "doomscroll",
      "taskVersion": 1,
      "payload": { "minutes": 12 },
      "scheduledFor": "2026-09-05T13:30:00.000Z",
      "deadlineAt": "2026-09-05T14:00:00.000Z",
      "status": "running",
      "queueJobId": "…",
      "startedAt": "2026-09-05T13:30:04.771Z",
      "finishedAt": null,
      "exitCode": null,
      "error": null,
      "stopRequestedAt": null,
      "createdAt": "2026-09-05T13:30:00.512Z",
      "updatedAt": "2026-09-05T13:30:04.771Z"
    }
  ]
}
```

`status`: `queued | running | succeeded | failed | cancelled | skipped | stopped`.

### `GET /api/executions/:id`

The row above plus `logs`:

```json
{ "id": "0b6d…", "status": "failed", "error": "TikTok did not reach the feed", "logs": ["…", "…"] }
```

Logs are a flat array of lines across attempts. On mobile, render the tail
first and cap what you hold in memory.

### `POST /api/executions/:id/stop`

```json
{ "result": "running" }
```

`result` is `queued | running | not-found | unsupported`. `404` for
`not-found`. Do not send the `HX-Request` header — that path returns HTML.

### `POST /api/executions/:id/retry`

Returns the new execution row, or `409` `"Execution is not retryable"`.

---

## Events — implemented

### `GET /api/events`

| Query | Meaning |
| --- | --- |
| `since` | ISO timestamp, inclusive lower bound |
| `until` | ISO timestamp, exclusive upper bound |
| `kind` | **One** of the kinds below. Not repeatable — `parseEventQuery` reads a single string, so `?kind=a&kind=b` is a `400`. Filter on more than one client-side. |
| `deviceUdid` | Filter to one device |
| `severity` | `info \| warning \| error` |
| `limit` | Default 50, max 200 |
| `before` | Keyset cursor — return events with id < this |

```json
{
  "events": [
    {
      "id": 42,
      "kind": "execution.failed",
      "severity": "error",
      "deviceUdid": "00008030-001A2B3C0E88802E",
      "executionId": "0b6d1c77-5e1a-4d33-9b8e-2f5a9c0f7e42",
      "scheduleId": "8c1f6b2e-9c0a-4a5f-9a1e-1f0f4b6d7c11",
      "title": "com.git-agni.tiktok/doomscroll@1 failed on 00008030-001A2B3C0E88802E",
      "detail": {
        "task": "com.git-agni.tiktok/doomscroll@1",
        "status": "failed",
        "scheduledFor": "2026-09-05T13:30:00.000Z",
        "deadlineAt": "2026-09-05T14:00:00.000Z",
        "exitCode": 1,
        "error": "TikTok did not reach the feed"
      },
      "createdAt": "2026-09-05T13:44:02.118Z"
    }
  ],
  "nextBefore": 42
}
```

`nextBefore` is absent when the page is the last one.

`serializeEvent` (`src/fleet/events.ts`) sends exactly these nine keys.
Two corrections to the earlier sketch of this shape, which described a
`message` string and a `data` object:

- `id` is the `scheduler.events` bigint identity, a JSON **number**. Cursors
  (`before`, `upToId`) compare numerically; only the SSE `Last-Event-ID`
  header carries it as a string.
- There is no `message`. The structured payload is **`detail`**, and it is
  `null` when the recorder wrote none. `title` is the operator-facing line;
  a prose body is the client's to compose from `detail` (`eventText()` in
  `@farm/client` does it). The keys in `detail` are whatever the recorder put
  there: `task`/`status`/`exitCode`/`error` for an execution
  (`src/fleet/scheduler-events.ts`), `physical`/`wda`/`message` for a device
  (`src/fleet/device-monitor.ts`), counters for the daily digest.

**Kinds and their default severity**

| Kind | Severity | Carries |
| --- | --- | --- |
| `execution.started` | info | `deviceUdid`, `executionId`, `scheduleId` |
| `execution.succeeded` | info | as above |
| `execution.failed` | error | as above + `detail.exitCode`, `detail.error` |
| `execution.stopped` | warning | as above |
| `execution.stuck` | error | as above + `detail.deadlineAt`, `detail.startedAt` |
| `device.connected` | info | `deviceUdid` + `detail.message` |
| `device.disconnected` | warning | `deviceUdid` + `detail.message` |
| `device.error` | error | `deviceUdid` + `detail.error` |
| `schedule.created` | info | `scheduleId`, `deviceUdid` |
| `schedule.paused` | info | `scheduleId` |
| `schedule.cancelled` | info | `scheduleId` |
| `digest.daily` | info | `detail` = roll-up counters, no device |

Only `execution.failed`, `device.disconnected`, `device.error` and
`execution.stuck` should be push-worthy by default.

### `GET /api/events/stream`

Server-Sent Events. `Accept: text/event-stream`, same bearer token.

```
id: 42
event: execution.failed
data: {"id":42,"kind":"execution.failed","severity":"error","deviceUdid":"00008030-…","executionId":"0b6d…","scheduleId":"8c1f…","title":"com.git-agni.tiktok/doomscroll@1 failed on 00008030-…","detail":{"exitCode":1,"error":"TikTok did not reach the feed"},"createdAt":"2026-09-05T13:44:02.118Z"}

: heartbeat

```

- `event:` is the event `kind`, so a client can subscribe selectively.
- `data:` is one JSON object, identical to an `/api/events` element.
- A comment line (`: heartbeat`) every **15 s** keeps intermediaries and
  Tailscale's idle handling from dropping the socket. Treat >40 s of silence as
  a dead connection and reconnect.
- Reconnect with `Last-Event-ID: <id>` to replay everything after that id, or
  with `?lastEventId=`. Persist the last id the app *rendered*, not the last it
  received. `0` is a valid cursor meaning "from the beginning", so do not test
  it for truthiness.

React Native's `fetch` does not stream. Use `react-native-sse` or an
`XMLHttpRequest` reader; either way the header must be set manually, since
`EventSource` cannot carry an `Authorization` header.

---

## Push registration — gap

### `POST /api/push/register`

```json
{
  "expoPushToken": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "name": "marcus-iphone",
  "minSeverity": "warning",
  "kinds": ["execution.failed", "device.disconnected", "device.error", "execution.stuck"]
}
```

`kinds` omitted or `null` means "all kinds at or above `minSeverity`".
Idempotent on `expoPushToken` — re-registering updates preferences and bumps
`lastSeenAt`. Returns `201` on create, `200` on update:

```json
{
  "id": "b4a1…",
  "name": "marcus-iphone",
  "tokenSuffix": "x2q9fa",
  "minSeverity": "warning",
  "kinds": ["execution.failed", "device.disconnected", "device.error", "execution.stuck"],
  "tokenId": "5d2c…",
  "createdAt": "2026-09-05T09:12:00.000Z",
  "lastSeenAt": "2026-09-05T09:12:00.000Z",
  "lastError": null
}
```

`400` when `expoPushToken` is not an `ExponentPushToken[…]` / `ExpoPushToken[…]`,
when `name` is empty, or when `kinds` holds an unknown kind. `tokenId` is the API
token identity that registered the phone.

### `GET /api/push/registrations`

```json
{ "registrations": [ { "id": "b4a1…", "name": "marcus-iphone", "tokenSuffix": "x2q9fa",
  "minSeverity": "warning", "kinds": ["execution.failed"], "tokenId": "…",
  "createdAt": "…", "lastSeenAt": "…", "lastError": null } ] }
```

The Expo token is **never** echoed back — only `tokenSuffix`, its last six
characters, so a person can tell two phones apart. `lastError` is the most
recent Expo receipt error for that phone, or `null`.

### `DELETE /api/push/registrations/:id`

`204`. Also called by the relay when Expo reports `DeviceNotRegistered`.

### `POST /api/push/registrations/:id/error`

```json
{ "error": "MessageRateExceeded" }
```

`204`. **Relay-only** — how the push relay records a non-fatal Expo receipt
error against a registration, since it never touches Postgres directly. The app
has no reason to call it; it reads the result as `lastError` above. See
`docs/push-relay.md`.

---

## Tokens — implemented

### `GET /api/tokens`

```json
{
  "tokens": [
    {
      "id": "b4a1c0de-0000-4000-8000-000000000000",
      "name": "marcus-iphone",
      "createdAt": "2026-09-01T11:02:44.881Z",
      "lastUsedAt": "2026-09-05T09:40:11.002Z"
    }
  ]
}
```

Digests are never echoed. `lastUsedAt` is written at most once a minute per
token, so it answers "is this phone still out there?", not "what did it do".

### `DELETE /api/tokens/:id`

`204`, and the token stops working on its next request. `404` for an unknown id.
Revocation is by **id** only, so a token *named* like another one's id cannot be
deleted by mistake. This is the "my phone was stolen" button; the desktop app
and the push relay keep their own tokens.

## Bootstrap — implemented

### `GET /api/mobile/bootstrap`

One round trip for cold start on a phone connection. Everything the Fleet and
Alerts tabs need before the first user interaction.

```json
{
  "serverTime": "2026-09-05T09:41:12.004Z",
  "release": { "version": "0.1.0-review.0", "sha": "a1b2c3d" },
  "plugins": [
    {
      "id": "com.git-agni.tiktok",
      "version": "0.4.1",
      "displayName": "TikTok",
      "tasks": [{ "type": "doomscroll", "version": 1, "displayName": "Doomscroll" }]
    }
  ],
  "fleet": {
    "counts": { "total": 12, "online": 10, "busy": 3, "offline": 1, "disabled": 1, "error": 1 },
    "devices": [
      {
        "udid": "00008030-001A2B3C0E88802E",
        "name": "iPhone 8 · slot 1",
        "platform": "ios",
        "tags": ["warm-up"],
        "state": "busy",
        "connection": { "connected": true },
        "currentExecution": {
          "id": "0b6d…",
          "taskType": "doomscroll",
          "status": "running",
          "startedAt": "2026-09-05T09:38:02.110Z",
          "summary": "Doomscroll for 12 minutes"
        },
        "nextRunAt": "2026-09-05T14:00:00.000Z",
        "lastError": null
      }
    ]
  },
  "recentEvents": [],
  "unacknowledgedCount": 0,
  "capabilities": {
    "push": false,
    "eventAck": false,
    "thumbnails": true,
    "contentQueue": true,
    "tokens": true,
    "rateLimits": true
  }
}
```

`capabilities` lets one app build talk to a Mac running an older farm without
crashing — the app hides a tab rather than 404-ing. Treat a missing key as
`false`.

Notes on the implemented shape, which differs from the first sketch of it:

- `release` is the `package.json` version plus the short git sha when the farm
  runs from a checkout (`{ "version": "…", "sha": null }` when it does not).
  `/health` still carries the `RELEASED` marker's `sha`/`subject`/`deployedAt`.
- `fleet` is `{ counts, devices }` — the same per-device badge the Fleet screen
  renders, derived server-side (`online | busy | offline | disabled | error`).
  `connection` here is only `{ connected }`; the full control-channel record is
  still `GET /api/devices/:udid/connection`.
- `recentEvents` is the newest 20 events in `/api/events` shape.
- `unacknowledgedCount` is `0` until event acknowledgement lands; the
  `eventAck` capability says so, so the app should not render an unread badge
  while it is `false`.
- `capabilities` keys are the six above. `push` flips to `true` with
  `POST /api/push/register`; `eventAck` with `POST /api/events/ack`.

## Event acknowledgement — gap

### `POST /api/events/ack`

```json
{ "upToId": 42 }
```

Marks everything at or below that id acknowledged for the calling **token**, so
the operator's phone and the team lead's phone keep separate unread state.
Returns `{ "acknowledged": 14, "unacknowledgedCount": 0 }` — `acknowledged` is
how many events this call newly covered. The mark is monotonic: an older
`upToId` is ignored rather than rewinding it.

Event ids are **numeric** on the wire (the `scheduler.events` identity column),
not the ULID strings the examples above show; `upToId` is a number.

Which token is calling comes from the request's token identity. A cookie
session, or a loopback request with authentication switched off, shares one
synthetic `local` identity.

### `GET /api/events/unacknowledged-count`

```json
{ "unacknowledgedCount": 2, "upToId": 40 }
```

The badge count, without pulling the events themselves. `upToId` is the caller's
current mark.

### `GET /api/events?acknowledged=false`

Returns only events above the caller's mark. Every other `/api/events` parameter
behaves exactly as before, and omitting `acknowledged` leaves the endpoint
unchanged.

---

## Content drip — queue implemented

### `GET /api/content/queue`

Planned posts from the drip queue, oldest first, from 24 hours ago onwards so a
just-posted item does not vanish off the screen. `?limit=` (default 50,
max 200).

```json
{
  "items": [
    {
      "id": "d31a…",
      "status": "planned",
      "deviceUdid": "00008030-001A2B3C0E88802E",
      "caption": "day 14 of building the farm",
      "assetId": "9f2c…",
      "thumbnailUrl": "/api/assets/9f2c…/thumbnail",
      "plannedFor": "2026-09-06T18:00:00.000Z",
      "scheduleId": "8c1f…"
    }
  ]
}
```

`status` is **derived** from the plan's schedule, which is the only approval
state the drip queue stores — there is no `approved` column and no migration:

| Schedule | `status` |
| --- | --- |
| none, or `paused` | `planned` |
| `active` | `approved` |
| `cancelled` | `skipped` |
| `completed`, or the plan is marked used | `posted` |

So the documented `scheduled` and `failed` values are not emitted today; a
client should treat any unknown status as `planned` and read `scheduleId`.

### `POST /api/content/queue/:id/approve`

No body. Resumes a held (`paused`) schedule and answers `{ "item": { … } }` with
the item at `status: "approved"`. Approving an already-approved or already-posted
item is a **no-op success** — the operator's thumb lands twice on a train.
`404` for an unknown id.

Re-timing (`{ "plannedFor": … }`) is **not implemented**; move the slot with
`PATCH /api/schedules/:id` for now.

### `POST /api/content/queue/:id/skip`

No body. Cancels the schedule (releasing its queued execution), closes the plan,
and leaves the media unspent so the next planning run can reuse it. Answers
`{ "item": { … } }` at `status: "skipped"`; `409` if the schedule cannot be
cancelled. A `reason` is not stored today.

### `GET /api/assets/:id/thumbnail`

**Implemented.** A JPEG no larger than 320 px on either side, cached on disk at
`SCHEDULER_DATA_DIR/thumbnails/<sha256>.jpg`:

- images are downscaled with `sharp`;
- videos use the poster frame the content pipeline already stored, and fall back
  to an ffmpeg first frame (`execFile`, never a shell);
- `cache-control: private, max-age=300`. `404` for an unknown or missing asset,
  `503` when no frame could be rendered.

## Assets

### `POST /api/assets`

`multipart/form-data`, up to 20 files, 2 GB each. Returns `201` with the stored
assets:

```json
[
  {
    "id": "9f2c…",
    "path": "uploads/9f2c…",
    "name": "clip-014.mp4",
    "mimeType": "video/mp4",
    "size": 18442131,
    "sha256": "3b1f…"
  }
]
```

The app does not upload in M1–M3. Listed for completeness.

### `DELETE /api/assets`

`{ "assetIds": ["9f2c…"] }` → `204`.

---

## Plugins & health

### `GET /api/plugins`

```json
[
  {
    "id": "com.git-agni.tiktok",
    "version": "0.4.1",
    "displayName": "TikTok",
    "tasks": [{ "type": "doomscroll", "version": 1, "displayName": "Doomscroll" }]
  }
]
```

The only legitimate source of `taskType`/`taskVersion` for schedule creation.

### `GET /health`

```json
{
  "ok": true,
  "plugins": [{ "id": "com.git-agni.tiktok", "version": "0.4.1" }],
  "release": { "sha": "a1b2c3d", "subject": "fleet summary endpoint", "deployedAt": "2026-09-04T22:10:00.000Z" }
}
```

`release` is present only when a `RELEASED` marker exists. Use `/health` for
the Settings screen's "can I reach the Mac" check — it is cheap and, unlike
`/api/devices`, does not touch USB.

## Not for the app

| Path | Why |
| --- | --- |
| `/api/devices/:udid/remote/stream` | MJPEG; holds a socket open per viewer and drains the phone battery. Poll thumbnails instead. |
| `/api/fragments/*`, `/api/devices/:udid/fragments/*` | HTMX HTML fragments for the dashboard. |
| `/api/device-registrations/*` | Registration needs the Mac, Xcode, and a cable. Desktop-only. |
| `/mcp` | Agent surface, not a client API. |
| `/`, `/tasks`, `/devices/:udid`, `/docs` | Server-rendered HTML. |
