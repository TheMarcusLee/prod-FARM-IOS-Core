# The push relay

`npm run push:relay` is a separate long-lived process, supervised beside
`npm run worker`. It subscribes to the farm's own event stream and turns events
into Expo push notifications for the companion app.

```
farm web  ──SSE──▶  push relay  ──HTTPS──▶  exp.host/--/api/v2/push/send  ──▶  APNs / FCM  ──▶  phone
   ▲                    │
   └── POST /api/push/register ◀── the app, after the permission grant
```

It is an **API client**: it never opens a Postgres connection and never imports
scheduler internals, so it can move off the Mac later without changing anything.
There is no Expo SDK in the dependency tree — it is plain `fetch`.

Source: `src/push/relay.ts`, with `src/push/sse.ts` for the stream and
`src/push/expo.ts` for the Expo HTTP API.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FARM_BASE_URL` | `http://127.0.0.1:3000` | The farm to follow |
| `FARM_API_TOKEN` | *(none)* | Bearer token, minted with `npm run token:create -- --name push-relay`. Loopback with auth disabled needs none. |
| `SCHEDULER_DATA_DIR` | `.scheduler-data` | Holds `push-relay.json`, the cursor file |
| `PUSH_RELAY_STATE_PATH` | `$SCHEDULER_DATA_DIR/push-relay.json` | Overrides the cursor file's location |
| `PUSH_QUIET_HOURS` | *(none)* | `HH:MM-HH:MM`, e.g. `22:00-07:00`; wraps past midnight |
| `PUSH_TIMEZONE` | `DIGEST_TIMEZONE`, else `UTC` | IANA zone the quiet window is read in |
| `PUSH_COALESCE_WINDOW_MS` | `30000` | At most one push per registered phone per window |
| `PUSH_RECEIPT_DELAY_MS` | `900000` | How long a ticket waits before its receipt is read |
| `EXPO_ACCESS_TOKEN` | *(none)* | Only needed when the Expo project has push security enabled |
| `PUBLIC_BASE_URL` | *(none)* | Put into `data.url` as `<base>/fleet`, so tapping a notification opens the fleet page |

Anything malformed falls back to the default rather than failing at boot — a
typo in `PUSH_QUIET_HOURS` disables quiet hours, it does not stop the relay.

## The loop

1. **Subscribe.** `GET /api/events/stream` with `Last-Event-ID` read from
   `push-relay.json`, and the bearer token when one is configured. More than
   40 s with no traffic at all — not even the 15 s heartbeat — counts as a dead
   connection.
2. **Refresh registrations** from `GET /api/push/registrations`, at most once
   every 30 s. That interval is fixed in code; there is no variable for it.
3. **Filter** each event per registration: `kinds` when the phone set one,
   otherwise `severity >= minSeverity`.
4. **Quiet hours.** Inside the window only `severity: error` goes out; anything
   quieter is skipped. It is still in `/api/events`, so nothing is lost — the
   app shows it the next time it opens. The window is read in `PUSH_TIMEZONE`
   through `Intl`, so it wraps past midnight and follows a DST change rather
   than sliding an hour.
5. **Coalesce.** The first event for a quiet registration is pushed
   immediately; anything arriving inside the next 30 s is held and folded into
   one message — `"3 farm alerts"`, with `data.count` — so a half-out USB cable
   flapping all night is one notification, not two hundred. The flush timer
   ticks every `min(PUSH_COALESCE_WINDOW_MS, 1000)` ms.
6. **Send** in batches of at most 100 to `https://exp.host/--/api/v2/push/send`.
   A `429` or a `5xx` is retried with backoff (1 s, 2 s, 4 s); a `4xx` is not.
   Each message is trimmed to Expo's 4 KiB ceiling before it goes — body first,
   then title — so a long title plus a stack trace comes back as a notification
   rather than `MessageTooBig`.
7. **Persist the cursor** only past events that can no longer need sending.
   An event that went out, that nobody was subscribed to, or that quiet hours
   dropped is settled; anything still held in the coalescing window, or that
   Expo refused (`MessageRateExceeded`, a wedged Expo, a transport error), pins
   the cursor below it so the next start replays it. A crash therefore replays
   rather than drops, and the app dedupes on `data.eventId`.
   `DeviceNotRegistered` is deliberately not a blocker: that phone is gone, and
   replaying at a dead token achieves nothing.
8. **Read receipts** 15 minutes later. `DeviceNotRegistered` calls
   `DELETE /api/push/registrations/:id` — that phone is gone. Any other error is
   recorded with `POST /api/push/registrations/:id/error` and shows up as
   `lastError` in `GET /api/push/registrations`.
9. **Reconnect** with jittered backoff, 1 s → 30 s.
10. **Shut down** on `SIGINT`/`SIGTERM` by force-draining the coalescing window
    — whatever it was holding goes out — and persisting the cursor, so a restart
    neither loses a notification nor replays the night.

## The message

```json
{
  "to": "ExponentPushToken[…]",
  "title": "Doomscroll failed on iPhone 8 · slot 1",
  "body": "TikTok did not reach the feed after 3 attempts",
  "sound": "default",
  "priority": "high",
  "data": { "eventId": 42, "kind": "execution.failed", "severity": "error",
            "deviceUdid": "00008030-…", "executionId": "0b6d1c77-…", "count": 1,
            "url": "https://farm-mac.tailnet-1234.ts.net/fleet" }
}
```

`priority` is `high` when any folded event is an error, `default` otherwise.
`data` is what the app deep-links on.

## Running it

```sh
npm run token:create -- --name push-relay      # prints the token once
FARM_API_TOKEN=<token> npm run push:relay
```

On the farm Mac, supervise it with launchd. Copy
`docs/launchd/co.agniverse.phone-farm.push-relay.plist` to
`~/Library/LaunchAgents/`, edit the paths and the token, then:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/co.agniverse.phone-farm.push-relay.plist
launchctl kickstart -k gui/$(id -u)/co.agniverse.phone-farm.push-relay
tail -f ~/Library/Logs/phone-farm/push-relay.log
```

`launchctl bootout gui/$(id -u)/co.agniverse.phone-farm.push-relay` stops it.
Keep the token out of the plist if you can — point `.env` at it instead, since
`npm run push:relay` already loads `.env` when one is present.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Event stream dropped: … responded 401` | The token was revoked, or `FARM_API_TOKEN` is unset while auth is on |
| Nothing arrives, no errors | No registration matches — check `minSeverity` and `kinds` in `GET /api/push/registrations` |
| `lastError: "DeviceNotRegistered"` never appears, the row just vanishes | Working as intended; that phone uninstalled or reinstalled the app |
| A burst arrives as one notification | Working as intended — that is the 30 s coalescing window |
| Notifications stop overnight | `PUSH_QUIET_HOURS`. Errors still break through; warnings do not. |
