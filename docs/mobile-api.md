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

Password login exists only for the browser dashboard. The app must never use it.

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
| `503` | Subsystem unavailable — device flapping (screenshot), registration not configured, stream down |

`503` from `/remote/screenshot` has an **empty body**, not JSON — it is
deliberately quiet so a 5 s poll does not fill the log. Treat it as "no frame
right now" and keep the previous image.

### Pagination

Two different styles, both intentional:

| Family | Style |
| --- | --- |
| `/api/schedules`, `/api/executions` | No pagination. Server-side cap of 200 rows, newest first, optional `?deviceUdid=`. |
| `/api/events` (planned) | Keyset. `?limit=` (default 50, max 200) plus `?before=<eventId>` to walk backwards, `?since=`/`?until=` for a time window. |

Event ids are monotonic, so `before` is a stable cursor across inserts. Do not
paginate schedules/executions with offsets; if the app needs deeper history,
ask for the keyset treatment on those two as well (listed as a gap below).

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

**gap** — `?width=<px>` for a thumbnail. Full-resolution PNGs from ~12 phones
are the single biggest thing standing between the app and a usable fleet grid
over a phone connection.

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

## Fleet — planned

### `GET /api/fleet/summary`

One request that backs the whole Fleet screen. Shape as agreed with the fleet
page work:

```json
{
  "generatedAt": "2026-09-05T09:41:12.004Z",
  "counts": { "total": 12, "online": 10, "busy": 3, "offline": 1, "disabled": 1, "error": 1 },
  "devices": [
    {
      "udid": "00008030-001A2B3C0E88802E",
      "name": "iPhone 8 · slot 1",
      "platform": "ios",
      "tags": ["warm-up"],
      "state": "busy",
      "connection": { "physical": "connected", "wda": "ready", "message": "WDA is ready" },
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
}
```

`state` is the single derived badge the app renders: `online | busy | offline |
disabled | error`.

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
partial failure is legible:

```json
{
  "created": [{ "deviceUdid": "00008030-…", "scheduleId": "8c1f…" }],
  "failed":  [{ "deviceUdid": "R58N12ABCDE", "error": "This device is disabled — activate it before scheduling automation" }]
}
```

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

## Events — planned

### `GET /api/events`

| Query | Meaning |
| --- | --- |
| `since` | ISO timestamp, inclusive lower bound |
| `until` | ISO timestamp, exclusive upper bound |
| `kind` | Repeatable; one of the kinds below |
| `deviceUdid` | Filter to one device |
| `severity` | `info \| warning \| error` |
| `limit` | Default 50, max 200 |
| `before` | Keyset cursor — return events with id < this |

```json
{
  "events": [
    {
      "id": "01J9Z3M8QF7B0C2S4T6V8XYZAB",
      "kind": "execution.failed",
      "severity": "error",
      "deviceUdid": "00008030-001A2B3C0E88802E",
      "executionId": "0b6d1c77-5e1a-4d33-9b8e-2f5a9c0f7e42",
      "scheduleId": "8c1f6b2e-9c0a-4a5f-9a1e-1f0f4b6d7c11",
      "title": "Doomscroll failed on iPhone 8 · slot 1",
      "message": "TikTok did not reach the feed after 3 attempts",
      "data": { "attempt": 3, "exitCode": 1 },
      "createdAt": "2026-09-05T13:44:02.118Z"
    }
  ],
  "nextBefore": "01J9Z3M8QF7B0C2S4T6V8XYZAB"
}
```

`nextBefore` is absent when the page is the last one.

**Kinds and their default severity**

| Kind | Severity | Carries |
| --- | --- | --- |
| `execution.started` | info | `deviceUdid`, `executionId`, `scheduleId` |
| `execution.succeeded` | info | as above |
| `execution.failed` | error | as above + `data.exitCode` |
| `execution.stopped` | warning | as above |
| `execution.stuck` | warning | as above + `data.stuckForSeconds` |
| `device.connected` | info | `deviceUdid` |
| `device.disconnected` | warning | `deviceUdid` |
| `device.error` | error | `deviceUdid` + `data.message` |
| `schedule.created` | info | `scheduleId`, `deviceUdid` |
| `schedule.paused` | info | `scheduleId` |
| `schedule.cancelled` | info | `scheduleId` |
| `digest.daily` | info | `data` = roll-up counters, no device |

Only `execution.failed`, `device.disconnected`, `device.error` and
`execution.stuck` should be push-worthy by default.

### `GET /api/events/stream`

Server-Sent Events. `Accept: text/event-stream`, same bearer token.

```
id: 01J9Z3M8QF7B0C2S4T6V8XYZAB
event: execution.failed
data: {"id":"01J9Z3M8QF7B0C2S4T6V8XYZAB","kind":"execution.failed","severity":"error","deviceUdid":"00008030-…","title":"Doomscroll failed on iPhone 8 · slot 1","message":"TikTok did not reach the feed after 3 attempts","createdAt":"2026-09-05T13:44:02.118Z"}

: heartbeat

```

- `event:` is the event `kind`, so a client can subscribe selectively.
- `data:` is one JSON object, identical to an `/api/events` element.
- A comment line (`: heartbeat`) every **15 s** keeps intermediaries and
  Tailscale's idle handling from dropping the socket. Treat >40 s of silence as
  a dead connection and reconnect.
- Reconnect with `Last-Event-ID: <id>` to replay everything after that id.
  Persist the last id the app *rendered*, not the last it received.

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
  "minSeverity": "warning",
  "kinds": ["execution.failed", "device.disconnected", "device.error", "execution.stuck"],
  "createdAt": "2026-09-05T09:12:00.000Z",
  "lastSeenAt": "2026-09-05T09:12:00.000Z"
}
```

### `GET /api/push/registrations`

Array of the above, no tokens echoed back beyond a `tokenSuffix` for display.

### `DELETE /api/push/registrations/:id`

`204`. Also called by the relay when Expo reports `DeviceNotRegistered`.

---

## Bootstrap — gap

### `GET /api/mobile/bootstrap`

One round trip for cold start on a phone connection. Everything the Fleet and
Alerts tabs need before the first user interaction.

```json
{
  "serverTime": "2026-09-05T09:41:12.004Z",
  "release": { "sha": "a1b2c3d", "subject": "fleet summary endpoint", "deployedAt": "2026-09-04T22:10:00.000Z" },
  "plugins": [
    {
      "id": "com.git-agni.tiktok",
      "version": "0.4.1",
      "displayName": "TikTok",
      "tasks": [{ "type": "doomscroll", "version": 1, "displayName": "Doomscroll" }]
    }
  ],
  "fleet": { "counts": { "total": 12, "online": 10, "busy": 3, "offline": 1, "disabled": 1, "error": 1 }, "devices": [] },
  "recentEvents": [],
  "unacknowledgedCount": 2,
  "capabilities": {
    "events": true,
    "sse": true,
    "push": true,
    "drip": true,
    "screenshotThumbnails": true,
    "eventAck": true
  }
}
```

`capabilities` lets one app build talk to a Mac running an older farm without
crashing — the app hides a tab rather than 404-ing. Treat a missing key as
`false`.

---

## Event acknowledgement — gap

### `POST /api/events/ack`

```json
{ "upToId": "01J9Z3M8QF7B0C2S4T6V8XYZAB" }
```

Marks everything at or below that id acknowledged for the calling **token**, so
the operator's phone and the team lead's phone keep separate unread state.
Returns `{ "acknowledged": 14, "unacknowledgedCount": 0 }`.

`GET /api/events` gains `?acknowledged=false` once this lands.

---

## Content drip — planned

### `GET /api/content/queue`

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
      "scheduleId": null
    }
  ]
}
```

`status`: `planned | approved | skipped | scheduled | posted | failed`.

### `POST /api/content/queue/:id/approve`

Optional `{ "plannedFor": "2026-09-06T18:00:00.000Z" }` to move the slot.
Returns the item with `status: "approved"` and, once materialised,
`scheduleId`.

### `POST /api/content/queue/:id/skip`

Optional `{ "reason": "wrong account" }`. Returns the item with
`status: "skipped"`.

**gap** — `GET /api/assets/:id/thumbnail` returning a small JPEG. The Content
screen is unusable if approving a post means downloading the source video.

---

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
