# Fleet operations and alerting

Everything in this document is served by the `web` process. Three pieces:

- **`/fleet`** — one card per registered device, filters, and bulk actions.
- **`scheduler.events`** — an append-only timeline of what happened to devices,
  executions and schedules, readable over JSON and Server-Sent Events.
- **Notification channels** — webhook, Slack, Discord and ntfy deliveries plus a
  daily digest, driven entirely from environment variables.
- **Push registrations** — the companion app's Expo tokens and per-token event
  acknowledgement; the relay that feeds them is `docs/push-relay.md`.

Source map:

| Path | Responsibility |
| --- | --- |
| `src/fleet/events.ts` | Event vocabulary, query rules, SQL and in-memory stores |
| `src/fleet/recorder.ts` | Record-then-deliver; never throws at its caller |
| `src/fleet/scheduler-events.ts` | Maps scheduler lifecycle signals onto events |
| `src/fleet/device-monitor.ts` | Turns wda-service connection polls into events |
| `src/fleet/summary.ts` | `/api/fleet/summary`, device state, stuck detection |
| `src/fleet/bulk.ts` | Stagger maths and bulk schedule creation |
| `src/fleet/page.ts` | The `/fleet` page renderer |
| `src/notifications/*` | Channel config, payload shapes, retrying delivery, digest |
| `src/api/routes/fleet.ts` | `registerFleetRoutes(app, options)` — every route below |
| `src/database/schema-events.ts` | The `scheduler.events` table (migration `0003_events.sql`) |
| `src/database/schema-push.ts` | `scheduler.push_registrations` and `scheduler.event_acks` (migration `0004_push.sql`) |
| `src/push/*` | Expo registrations, per-token ack marks, and the push relay |
| `src/api/routes/push.ts` | `registerPushRoutes(app, options)` — `/api/push/*` and `/api/events/ack` |

## The `/fleet` page

Every registered device is a card in a responsive grid showing its name, a
platform and driver badge, connection state (`online` / `offline` / `disabled`),
the current or next execution, its most recent event, its tags, its TikTok
accounts, and a screenshot thumbnail.

Thumbnails reuse `GET /api/devices/:udid/remote/screenshot`. They are **lazy**:
the image carries `data-shot` rather than `src`, an `IntersectionObserver` loads
it when the card scrolls into view, and a 30 s timer refreshes only the cards
that are currently visible. Offline and disabled devices are never given a
thumbnail at all, so a disconnected phone is never polled.

**Filters** narrow the grid by tag, platform and state; they hide cards rather
than reloading, so a selection survives a filter change.

**Bulk actions** apply to every selected, visible card:

| Action | What it does |
| --- | --- |
| Run doomscroll now | `POST /api/schedules/bulk` with `timing: {kind:'now'}` and the form's duration, personality and engagement flags |
| Schedule a TikTok post | Uploads the media to `POST /api/assets`, then one schedule per device, each using the account picked on that device's own card |
| Pause / resume schedules | `POST /api/schedules/:id/pause` / `/resume` for each of the device's matching schedules |
| Disable / enable | `PATCH /api/devices/:udid { disabled }` |
| Reconnect | `POST /api/devices/:udid/reconnect` |

Per-device results (including failures) are printed under the toolbar; one
device failing never stops the rest.

## Tags

Tags are free-form labels stored on the device record in `devices.json`.

```sh
curl -X PATCH http://127.0.0.1:3000/api/devices/<udid> \
  -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3000' \
  -d '{"tags":["warm","uk"]}'
```

Values are trimmed, de-duplicated and capped at 20 per device. The card's tag
editor sends the same request.

## Bulk scheduling

`POST /api/schedules/bulk`

```jsonc
{
  "deviceUdids": ["udid-a", "udid-b"],
  "task": { "pluginId": "com.git-agni.tiktok", "taskType": "post", "taskVersion": 1, "payload": { … } },
  "timing": { "kind": "once", "runAt": "2026-03-01T18:00:00.000Z" },
  "stagger": { "kind": "fixed", "minutes": 10 },   // or { "kind": "random", "windowMinutes": 45 }
  "runWindowMinutes": 30,                          // optional
  "overrides": { "udid-a": { "account": "@one" } } // optional per-device payload patch
}
```

- `fixed` gives device *i* an offset of `i × minutes`; `random` gives each device
  a whole minute drawn from `[0, windowMinutes)`.
- An offset shifts `once` and `now` timings forward in time (a staggered `now`
  becomes a `once`), and shifts the `localTime` of `daily` / `weekly` timings,
  wrapping past midnight.
- `overrides` is how each device gets its own TikTok account; the patch is merged
  over `task.payload` for that device only. Everything else in the body is
  ignored — the parser is an explicit whitelist.
- Each device goes through the normal `SchedulerRepository.createTask`, so plugin
  validation, device-disabled checks and the minimum-gap conflict rule all still
  apply.

The response reports every device:

```json
{ "created": 1, "failed": 1, "results": [
  { "deviceUdid": "udid-a", "ok": true, "scheduleId": "…", "offsetMinutes": 0, "nextRunAt": "…" },
  { "deviceUdid": "udid-b", "ok": false, "offsetMinutes": 10, "error": "Device is disabled — …" }
] }
```

`201` when at least one schedule was created, `400` when none were.

## Fleet summary

`GET /api/fleet/summary` — used by the page header and by the tray/mobile app.

```json
{
  "generatedAt": "2026-03-01T12:00:00.000Z",
  "devices": { "total": 3, "online": 1, "offline": 1, "disabled": 1 },
  "byPlatform": { "ios": 2, "android": 1 },
  "running": 2, "queued": 1, "stuck": 1,
  "failedLast24h": 1, "succeededLast24h": 1, "plannedNext24h": 2
}
```

`plannedNext24h` counts queued executions plus active schedules whose
`nextRunAt` falls inside the next 24 hours.

## Events

Table `scheduler.events`:

| Column | Type |
| --- | --- |
| `id` | `bigint` primary key, generated always as identity |
| `kind` | `text` |
| `severity` | `text` — `info` \| `warning` \| `error` |
| `device_udid` | `text` null |
| `execution_id` | `uuid` null |
| `schedule_id` | `uuid` null |
| `title` | `text` |
| `detail` | `jsonb` |
| `created_at` | `timestamptz` default `now()` |

Indexed on `created_at` and on `device_udid`. Migration: `drizzle/0002_events.sql`.

### Kinds

`execution.started`, `execution.succeeded`, `execution.failed`,
`execution.stopped`, `execution.stuck` (still running five minutes past its
run-window deadline), `device.connected`, `device.disconnected`, `device.error`,
`schedule.created`, `schedule.paused`, `schedule.cancelled`, `digest.daily`.

Execution and schedule events come from the optional `onEvent` hook on
`SchedulerRepository` (wired in `src/scheduler/runtime.ts` and
`src/scheduler/worker.ts`); device events come from polling wda-service's
`/devices`; stuck executions are swept on the same timer.

### `GET /api/events`

Query parameters: `since` and `until` (ISO timestamps), `kind`, `deviceUdid`,
`severity`, `limit` (default 100, max 500), and `before=<id>` as the cursor.
Newest first.

```sh
curl 'http://127.0.0.1:3000/api/events?severity=error&limit=50'
curl 'http://127.0.0.1:3000/api/events?deviceUdid=<udid>&before=1200'
```

```json
{ "events": [ { "id": 42, "kind": "execution.failed", "severity": "error",
  "deviceUdid": "udid-a", "executionId": "…", "scheduleId": null,
  "title": "…", "detail": { "error": "…" }, "createdAt": "2026-03-01T09:30:00.000Z" } ],
  "nextBefore": 42 }
```

`nextBefore` is non-null only when the page was full; pass it back as `before`.

### `GET /api/events/stream`

Server-Sent Events. Each message is

```
id: 42
event: execution.failed
data: {"id":42,"kind":"execution.failed", … }
```

- `Last-Event-ID` (or `?lastEventId=`) replays everything with a larger id, so a
  reconnecting client misses nothing.
- A `: heartbeat` comment every 15 s keeps proxies from closing the connection.
- The stream is polled from the table, so events written by the **worker**
  process reach a browser attached to the **web** process.
- Closing the connection stops the timers immediately.

```sh
curl -N -H 'Last-Event-ID: 42' http://127.0.0.1:3000/api/events/stream
```

## Notification channels

Deliveries are asynchronous — the scheduler is never blocked and a channel
failure is logged, never thrown. Each post is retried three times after the
first attempt with exponential backoff (500 ms, 1 s, 2 s).

| Variable | Meaning |
| --- | --- |
| `NOTIFY_WEBHOOK_URL` | Generic endpoint; receives `POST {"event": … }` |
| `NOTIFY_SLACK_WEBHOOK_URL` | Slack incoming webhook; Block Kit header, device/kind/time/severity fields, the error in a code block, and a button linking to the execution |
| `NOTIFY_DISCORD_WEBHOOK_URL` | Discord webhook; one embed coloured by severity (info blue, warning amber, error red) |
| `NOTIFY_NTFY_URL` | An ntfy topic URL — `https://ntfy.sh/<topic>` or a self-hosted `http://farm-mac.tailnet:8080/<topic>` |
| `NOTIFY_NTFY_TOKEN` | Optional; sent as `Authorization: Bearer …` for a protected topic |
| `NOTIFY_MIN_SEVERITY` | `info` \| `warning` \| `error`; default `warning` |
| `NOTIFY_KINDS` | Optional comma-separated kinds; when set it replaces the severity floor entirely |
| `DIGEST_LOCAL_TIME` | `HH:MM`, default `08:00` |
| `DIGEST_TIMEZONE` | IANA zone for the digest time, default `UTC` |
| `PUBLIC_BASE_URL` | Base URL used for the links inside Slack and Discord messages |

Anything that is not an `http(s)` URL, a known severity or a valid `HH:MM` is
ignored in favour of the default rather than failing at boot.

### ntfy

ntfy is the recommended day-one pager: install the app, subscribe to an
unguessable topic, and alerts arrive without any companion-app code. Publishing
is a plain `POST` to the topic URL — the body is the message, everything else is
a header:

| Header | Value |
| --- | --- |
| `Title` | The event title, flattened to one line of printable ASCII |
| `Priority` | `3` for info, `4` for warning, `5` for error |
| `Tags` | An emoji shortcode per kind — `x` for `execution.failed`, `rotating_light` for `device.error`, `warning` for `device.disconnected`, `hourglass` for `execution.stuck`, and so on |
| `Click` | `PUBLIC_BASE_URL` + the execution or device page, when `PUBLIC_BASE_URL` is set |
| `Authorization` | `Bearer $NOTIFY_NTFY_TOKEN`, when the topic is protected |

The body is the title followed by a short detail line: the event's `detail.error`
when it has one, otherwise `kind · deviceUdid`.

```sh
NOTIFY_NTFY_URL=https://ntfy.sh/farm-alerts-9f2a7c npm run web
```

ntfy's iOS app receives through ntfy's own APNs relay, so a self-hosted server
still leans on it for iOS delivery: **keep titles free of account handles,
passcodes and UDIDs you would not want relayed.** A device name and a task name
is enough to act on.

`POST /api/notifications/test` sends a probe to every configured channel and
reports each one:

```sh
curl -X POST http://127.0.0.1:3000/api/notifications/test \
  -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3000' -d '{}'
```

```json
{ "ok": false, "channels": [
  { "channel": "webhook", "ok": true, "status": 200, "attempts": 1 },
  { "channel": "slack", "ok": false, "status": 500, "attempts": 4, "error": "Channel responded 500" } ] }
```

It returns `409` when no channel is configured.

## Daily digest

Once a day at `DIGEST_LOCAL_TIME` in `DIGEST_TIMEZONE`, the last 24 hours are
summarised into a `digest.daily` event and delivered to every channel —
regardless of `NOTIFY_MIN_SEVERITY`. The clock is checked once a minute rather
than slept through, so a host that suspends past the slot still produces one.

`detail` carries:

- `totals` — `{ succeeded, failed }`
- `byDeviceAccount` — succeeded/failed per device **and** TikTok account
- `offlineOverAnHour` — devices offline for more than an hour, with `since`
- `stuckExecutions` — running past the deadline, with `deadlineAt`
- `plannedNext24h` — schedules due in the next 24 hours

## Push registrations and acknowledgement

The companion app's Expo push tokens live in `scheduler.push_registrations`, and
each API token's read mark lives in `scheduler.event_acks`. The endpoints are
documented in `docs/mobile-api.md`; the process that turns events into pushes is
`docs/push-relay.md`.

| Route | Purpose |
| --- | --- |
| `POST /api/push/register` | Idempotent on the Expo token; `201` on create, `200` on update |
| `GET /api/push/registrations` | `{ registrations: [...] }` — a `tokenSuffix`, never the token |
| `DELETE /api/push/registrations/:id` | `204`; also called by the relay on `DeviceNotRegistered` |
| `POST /api/push/registrations/:id/error` | Relay-only: records the last Expo receipt error |
| `POST /api/events/ack` | `{ upToId }` per token identity |
| `GET /api/events/unacknowledged-count` | `{ unacknowledgedCount, upToId }` |
| `GET /api/events?acknowledged=false` | Only events above the caller's mark |

The caller's identity comes from `request.apiToken` when the named-token work has
decorated it; a cookie session or an unauthenticated loopback request falls back
to the shared `local` identity. A push token is never logged or returned in full
— only its last six characters.

## Tests

`test/events.test.ts`, `test/notifications.test.ts`, `test/push.test.ts` and `test/fleet.test.ts`
cover the event vocabulary and query rules, the SSE stream (against a real
listening server, including `Last-Event-ID` replay), the Slack/Discord/webhook
payload shapes, retry and backoff, severity and kind filtering, digest
aggregation with fixed data, the stagger maths, bulk partial failures, device
state diffing, the rendered fleet page, the ntfy headers and body, registration
upsert/validation/revocation, the relay's filtering, coalescing, quiet hours,
Expo batching and receipt handling, and per-token acknowledgement.
