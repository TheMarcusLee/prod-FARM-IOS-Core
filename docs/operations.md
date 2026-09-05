# Operating the farm

Day-to-day running, once devices are registered and something is scheduled.
Setup is [getting-started.md](getting-started.md); the first hardware session is
[device-testing-checklist.md](device-testing-checklist.md).

## The daily loop

1. Open the **Control Center** (`/`). Every phone should be **online**, and
   nothing should be asking for you.
2. Open **Schedule** (`/schedule`). Read tonight left to right: the playhead is
   now, a red clip needs you, a dashed clip is a retry already booked. The
   Planner line under the timeline says when the next planning run is and which
   rules will under-post.
3. Open **Content** (`/content`) if the Planner warned, and **Rig** (`/rig`) if a
   service is down.
4. Check the alert channel for anything overnight, and the `digest.daily`
   message for the 24-hour roll-up.

Everything below is the detail behind those four lines.

---

## How the drip queue fills the schedule

A **drip rule** is "N posts a day for `@handle` on this phone, between 09:00 and
21:00 local, at least M minutes apart, drawn from the `fitness` tag". The
planner turns rules into **ordinary one-off schedules**, so anything the
Schedule page can do to a schedule still works on a dripped post — a planned
post is a clip on the timeline like any other, and Pause, Skip and Stop reach
it. See
[content-queue.md](content-queue.md) for the library and the rule fields.

The planner is **not a process**. It is a timer, running every
`DRIP_PLANNER_INTERVAL_MINUTES` (default 60), started by **both `web` and
`worker`** — a farm deployed with a worker and no dashboard replica still plans
its queue. `0` disables the tick in both; `POST /api/drip/plan` still plans on
demand.

Ticking from several processes is safe: every planning run takes a Postgres
advisory lock for the whole pass, and a run that cannot take it plans nothing
and reports `Another planning run is already in progress` in `skipped`. So
however many web replicas and workers you run, a given moment is planned once.

Each tick, for every enabled rule and for **today and tomorrow in the rule's own
timezone**:

- If `drip_plans` already has rows for that rule and date, it plans nothing. A
  re-run and the hourly tick therefore converge instead of double-booking.
- It picks `posts_per_day` items not used within `avoid_reuse_days`, ordered
  `random` or `fifo` (never-used first, then least recently used).
- It chooses random times inside the window, at least `min_gap_minutes` apart
  and never in the past. Times are drawn, sorted, and spread across whatever
  slack the window has left once every mandatory gap is reserved — so a window
  too tight for `posts_per_day` plans **fewer posts**, not illegal ones.
- It renders the caption template and creates a `once` schedule through the
  normal `createTask`, which means plugin validation, the device-disabled check
  and the minimum-gap conflict rule all still apply.
- An unregistered or disabled device is reported in the run's `skipped` list.

`used_count` and `last_used_at` are credited only once an execution actually
**succeeded** — the planner polls the executions table, it does not hook the
worker. Disabling a rule cancels the schedules it planned that have not started.

**What to do when the queue looks wrong**

| Symptom | Cause | Fix |
| --- | --- | --- |
| Fewer posts than `posts_per_day` | The window is too tight for `min_gap_minutes`, or the library ran out of items outside `avoid_reuse_days` | Widen the window, shorten the gap, or ingest more media |
| Nothing planned at all | The rule is disabled, its device is disabled or unregistered, or `DRIP_PLANNER_INTERVAL_MINUTES=0` | Check the rule's `skipped` output from `POST /api/drip/plan` |
| The queue emptied right after an edit | Editing a field that decides *when* or *what* a rule posts cancels its unrun posts on purpose, so the change reaches today | Nothing — the next tick rebuilds it, or `POST /api/drip/plan` rebuilds it now |
| A slot is at the wrong time | Times are random inside the window by design | Move the individual schedule with `PATCH /api/schedules/:id` |
| A queued post should not go out | `POST /api/content/queue/:id/skip` — it cancels the schedule and leaves the media unspent for the next planning run | |

---

## Reading the fleet page

`/fleet` is one card per registered device. The card shows the name, a platform
and driver badge, connection state, the current or next execution, the most
recent event, tags, TikTok accounts and a screenshot thumbnail.

Thumbnails are lazy: an `IntersectionObserver` loads them when a card scrolls
into view, a 30 s timer refreshes only the visible ones, and **offline and
disabled devices are never given a thumbnail at all** — a disconnected phone is
never polled.

The per-device badge comes from one pure function (`derivedDeviceState`) with a
fixed precedence:

| Badge | Means |
| --- | --- |
| `disabled` | `disabled: true` in `devices.json`. Nothing supervises it — no WDA, no worker, no discovery. Scheduling is refused. |
| `offline` | Not visible to discovery. On iOS the cable or WDA; on Android adb, or a bridge whose `/ping` does not answer. |
| `error` | Visible but the control channel is unhealthy. |
| `busy` | An execution is running. |
| `online` | Ready and idle. |

Precedence is `disabled → offline → error → busy → online`, so a disabled device
never reads `offline` and a busy device never reads `error`.

The header counters come from `GET /api/fleet/summary`: device totals by state,
totals by platform, `running`, `queued`, `stuck`, `failedLast24h`,
`succeededLast24h`, `plannedNext24h`. Note that this endpoint carries **no
per-device array** — the companion app gets that from `/api/mobile/bootstrap`.

**Filters** hide cards rather than reloading, so a selection survives a filter
change. **Bulk actions** apply to every selected, visible card: run doomscroll
now, schedule a post, pause/resume, disable/enable, reconnect. Per-device
results — including failures — are printed under the toolbar, and one device
failing never stops the rest. `deviceUdids` is capped at 200 per bulk request.

Use **stagger** on any bulk run: `fixed` gives device *i* an offset of
`i × minutes`, `random` draws a whole minute from `[0, windowMinutes)`. Firing
twelve phones at the same second is the fastest way to make a farm look like a
farm.

---

## Alerts: what each one means and what to do

Alerts are the `scheduler.events` timeline, delivered to whichever channels are
configured. Kinds, their severity, and the response:

| Kind | Severity | What it means | What to do |
| --- | --- | --- | --- |
| `execution.started` | info | A task began | Nothing |
| `execution.retried` | info | pg-boss started a later attempt of the same task (`detail.attempt`) | Nothing on its own. Several in a row on one device is a device or selector problem worth reading the logs for |
| `execution.succeeded` | info | A task finished cleanly | Nothing |
| `execution.failed` | error | A task exhausted its retries | Read `GET /api/executions/:id`. A TikTok routine's failure lists the selectors it tried and the texts on screen — usually a UI change or an interstitial |
| `execution.stopped` | warning | Someone pressed stop, or the run-window deadline passed | If it was the deadline, the device was busy or slow; check whether `SCHEDULER_RUN_WINDOW_MINUTES` is too tight |
| `execution.cancelled` | info | A queued run was cancelled before it started — an operator stopped it, or its schedule was cancelled | Nothing. The queue job is gone and the media has been reclaimed |
| `execution.stuck` | **error** | Still running **five minutes past** its deadline | The device is probably wedged. `POST /api/executions/:id/stop`, then reconnect the device. On iOS this is usually a dead WDA session |
| `device.connected` | info | Discovery sees it again | Nothing |
| `device.disconnected` | warning | Discovery lost it | Check the cable (iOS/adb) or the phone's Wi-Fi (bridge). One flap is noise; a repeating flap is a cable or a power-saving setting |
| `device.error` | error | Visible but the control channel is unhealthy | Read the `wda:service` health socket on iOS, or `curl <bridgeUrl>/ping` on Android |
| `schedule.created` / `paused` / `cancelled` | info | Someone or the planner changed a schedule | Nothing |
| `digest.daily` | info | The 24-hour roll-up | This is the one to actually read each morning |

Only `execution.failed`, `device.disconnected`, `device.error` and
`execution.stuck` are push-worthy by default.

**Stuck runs are given up on, not just reported.** `execution.stuck` is a
warning shot from `web`: the run is five minutes past its run-window deadline
and still `running`. The `worker` sweeps the same threshold every minute, and
anything it finds is marked **failed** with `Timed out past its execution
window` — which is what raises `execution.failed`. If the worker doing the
sweeping is the one running that execution, it also kills the plugin process, so
the device queue is released rather than held by a wedged phone. The two events
therefore arrive in that order, warning then failure, and an execution can no
longer sit at `running` for ever because the worker that owned it died.

**Channels** are configured entirely from the environment — `NOTIFY_WEBHOOK_URL`,
`NOTIFY_SLACK_WEBHOOK_URL`, `NOTIFY_DISCORD_WEBHOOK_URL`, `NOTIFY_NTFY_URL`
(+ `NOTIFY_NTFY_TOKEN`), filtered by `NOTIFY_MIN_SEVERITY` (default `warning`)
or, if set, the explicit `NOTIFY_KINDS` list. Set `PUBLIC_BASE_URL` so the
messages carry a working link. Full detail:
[fleet-and-alerts.md](fleet-and-alerts.md).

ntfy is the recommended day-one pager: subscribe to an unguessable topic and
alerts arrive with no companion-app code. Its iOS delivery goes through ntfy's
own APNs relay, so **keep titles free of account handles, passcodes and UDIDs**.

Check a channel end to end without waiting for a failure:

```sh
curl -X POST http://127.0.0.1:3000/api/notifications/test \
  -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3000' -d '{}'
```

It reports each channel's status and answers `409` when none is configured.

**The daily digest** goes out once a day at `DIGEST_LOCAL_TIME` in
`DIGEST_TIMEZONE` (defaults `08:00` UTC), to every channel, *regardless of*
`NOTIFY_MIN_SEVERITY`. It carries succeeded/failed totals, a per-device and
per-account breakdown, devices offline for more than an hour, stuck executions,
and what is planned for the next 24 hours.

---

## Token rotation

Every phone, agent and relay should hold its **own named token**, so one lost
phone is one `DELETE` instead of a rotation that logs out everything.

```sh
npm run token:create -- --name marcus-iphone   # printed once; only its sha256 is stored
npm run token:revoke -- --name marcus-iphone   # matches the name OR the id
node --import tsx src/auth/cli.ts token-list   # name, id, createdAt
```

Over HTTP: `GET /api/tokens` lists `{ id, name, createdAt, lastUsedAt }` — never
a digest — and `DELETE /api/tokens/:id` answers `204`. The HTTP delete matches
on **id only**; the CLI matches name or id.

Rotating one consumer:

1. `npm run token:create -- --name <consumer>-2`.
2. Put the new token into that consumer (`FARM_API_TOKEN` for the relay, the
   Settings screen for the companion app) and restart it.
3. Confirm `lastUsedAt` on the new token moves, then
   `npm run token:revoke -- --name <consumer>`.

`lastUsedAt` is throttled to one write a minute, so give it a minute before
concluding a token is unused.

Rotating the **dashboard password** is `npm run auth:set-password`; it does not
invalidate API tokens. Deleting `.auth.json` invalidates *everything* —
password, session key and every token — so treat it as the nuclear option.

---

## Backups

Three things matter. Losing any one of them loses something you cannot rebuild.

| What | Why |
| --- | --- |
| The PostgreSQL database | Schedules, executions and their logs, assets, the content library rows, drip rules and plans, the event timeline, push registrations |
| `devices.json` | The registered fleet, including iOS unlock passcodes, coordinate calibration, tags and per-plugin data. `0600`, git-ignored |
| `.auth.json` | The dashboard password hash, the session signing key and every API token digest. `0600`, beside `devices.json` unless `AUTH_STATE_PATH` says otherwise |
| The content directory | The media itself — originals, normalised copies and posters. The database rows point at these files |

A nightly script, for a farm started by hand:

```sh
set -euo pipefail
STAMP=$(date +%F)
DEST=~/farm-backups/$STAMP
mkdir -p "$DEST"

pg_dump "$DATABASE_URL" --format=custom --file="$DEST/backline.dump"
cp devices.json "$DEST/"
cp .auth.json   "$DEST/"          # secrets — encrypt or keep it off shared storage
tar -czf "$DEST/content.tar.gz" -C .scheduler-data content

chmod -R go-rwx "$DEST"
```

With the bundled `docker compose` database, `pg_dump` still works against
`DATABASE_URL` because the container publishes on `127.0.0.1:5432`.

Under the **desktop app** the paths differ. Everything is under
`~/Library/Application Support/Backline`:

```sh
APP=~/Library/Application\ Support/Phone\ Farm
cp "$APP/devices.json" "$APP/settings.json" "$DEST/"
tar -czf "$DEST/scheduler-data.tar.gz" -C "$APP" scheduler-data
```

`settings.json` holds the generated embedded-database password, so it is a
secret. To dump the bundled cluster, read the connection details out of
`settings.json` (`embeddedPostgresPort`, default `55432`, user and database
`phone_farm`) and point `pg_dump` at it while the app is running.

**Restoring**: stop the worker and web, `pg_restore` into an empty database,
put `devices.json`, `.auth.json` and the content directory back with `0600` /
`0700`, then start again. Schedules resume from `next_run_at`; anything whose
run window has expired is abandoned rather than fired late.

**What is not worth backing up**: `.wda/` (sockets and locks), `.appium2/`
(reinstall with `npm run appium:install-driver`), `.scheduler-data/thumbnails/`
(a cache), and the desktop app's `logs/`.

---

## Upgrading

Started by hand:

```sh
git pull
npm install                 # the lockfile may have moved
npm run db:migrate          # always; migrations are forward-only
npm run check               # typecheck + tests before you restart anything
# restart web, worker, and (iOS) appium and wda:service
```

Restart order matters in one respect: **`web` and `worker` must load the same
plugin versions.** A task envelope stores its `taskVersion`, so a schedule
written by a newer `web` against an older `worker` fails loudly rather than
running the wrong contract — which is the intended behaviour, but it means you
should restart both together.

**After upgrading, every dashboard user signs in again once.** Session cookies
now carry a session id, so cookies issued by the previous release are not
recognised and are rejected on the first request. There is nothing to do about
it: sign in again, once, per browser. API tokens (`pf_…`) are unaffected, so the
companion app, the MCP server and any scripts keep working across the upgrade.

Take a backup before a migration. Migrations are forward-only; there is no down
path.

The desktop app runs `src/database/migrate.ts` as a one-shot service before the
worker and web start, so a new build migrates itself on launch. `npm run
desktop:build` needs the network the first time because it installs the farm's
production dependencies from the lockfile.

iOS only: after an Xcode or iOS update, re-run `npm run wda:prepare` (the
signing build) before expecting `wda:service` to work.

---

## Where the logs are

### Started by hand

Every process logs to **stdout**. There are no log files — that is the process
manager's job.

| Process | What is in it |
| --- | --- |
| `npm run web` | Fastify request log, plugin loading, registration checks, the drip planner tick, alert delivery |
| `npm run worker` | Queue registration per device, `materializeDue`, the executor, per-task subprocess output |
| `npm run wda:service` | `xcodebuild` output per device, port forwarding, WDA health |
| `npm run appium` | Appium session log |
| `npm run push:relay` | SSE connect/reconnect, filtering, Expo batches and receipts |
| `npm run mcp` | stdio — do not log to stdout here; the transport owns it |

Under `launchd`, point `StandardOutPath` / `StandardErrorPath` at
`~/Library/Logs/backline/<service>.log` — that is what the bundled
`docs/launchd/co.backline.push-relay.plist` does:

```sh
tail -f ~/Library/Logs/backline/push-relay.log
```

Durable, per-execution logs are **not** in stdout: they are in the database,
readable with `GET /api/executions/:id` or on the device page's Activity panel.
`SCHEDULER_HISTORY_DAYS` (default 30) is how long the worker keeps them.

### Under the desktop app

One rotating file per service, `0600`, under
`~/Library/Application Support/Backline/logs/`:

```
web.log  worker.log  wda.log  appium.log  postgres.log  migrations.log  adb.log
```

They rotate at 10 MB keeping five generations (`web.log.1` … `web.log.5`). The
Services panel shows the live tail of each. **Export diagnostics…** writes a zip
with the service table, the job list and the last 2 MB of every log including
rotated generations, with the database password and any password inside
`DATABASE_URL` replaced by `«redacted»` — that is the thing to attach to a bug
report.

**Open data folder** (Services panel, Farm menu, or the menu-bar item) opens
that directory.

---

## Health checks worth scripting

```sh
# The farm is up, and which plugins it loaded
curl -s http://127.0.0.1:3000/health

# Fleet counters — alert on stuck > 0 or online < expected
curl -s http://127.0.0.1:3000/api/fleet/summary

# iOS control channel, per device
curl --unix-socket .wda/wda-service.sock http://localhost/health

# Android bridge, per device
curl -s http://<phone-ip>:8080/ping
```

`/health` is deliberately cheap and does not touch USB, which is why it is what
the companion app's **Test** button uses.
