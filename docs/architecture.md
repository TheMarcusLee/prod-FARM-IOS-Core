# Architecture — what does what

Backline drives physical **iPhones and Android phones** from one local
dashboard. It is a set of cooperating processes over a single PostgreSQL
database and a few local state files. There is no client framework: the
dashboard is server-rendered HTML with HTMX, live video is MJPEG, and the event
feed is Server-Sent Events — no WebSockets anywhere.

Which processes are running depends on how you started it. The desktop app
(`apps/desktop`) supervises seven of them for you; started by hand it is one
terminal per process. Either way they are the same entry points — see
[Which way to run it](../README.md#which-way-to-run-it).

```
                       ┌──────────────────────────────────────────────────┐
                       │  Backline.app  (apps/desktop, Electron)          │
                       │  supervises, restarts, logs, exports diagnostics │
                       │  postgres → migrations → adb, appium, wda        │
                       │                        → worker, web             │
                       └──────────────────────────────────────────────────┘
                              (optional: the same processes run by hand)

  browser ─── HTTP ────┐                     ┌──── HTTPS ──── exp.host ──▶ phone
                       ▼                     │                (Expo push)
  companion app ──────▶┌─────────────────────┴──────────────┐
  (apps/mobile,        │  web   Fastify + HTMX        :3000 │◀── stdio ──┐
   over Tailscale)     │  Control Center, Schedule,         │            │
                       │  JSON API, SSE, POST /mcp,         │      ┌─────┴──────┐
                       │  drip planner tick (in-process)    │      │ MCP stdio  │
                       └──┬──────────────┬──────────────┬───┘      │ npm run mcp│
                          │ SQL          │ HTTP over    │          └────────────┘
                          │              │ Unix socket  │ driver
                          │              ▼              │  (WDA / adb / bridge)
                          │   ┌──────────────────────┐  │
                          │   │ wda-service   (iOS)  │  │
                          │   │ 1 WebDriverAgent per │  │
                          │   │ phone; forwards      │  │
                          │   │ :8100+ and :9100+    │  │
                          │   └───────────┬──────────┘  │
                          ▼               │ USB         │
        ┌────────────────────────────┐    │             │
        │ PostgreSQL                 │    │             │
        │  scheduler.*  pgboss.*     │    │             │
        │  drizzle.*                 │    │             │
        └───────▲──────────────▲─────┘    │             │
                │ SQL/pg-boss  │ SSE      │             │
        ┌───────┴────────────┐ │          │             │
        │ worker             │ │          │             │
        │ runs due tasks,    │ │          │             │
        │ one queue / device │ │          │             │
        └───────┬────────────┘ │          │             │
                │              │          │             │
   ┌────────────┴──────────────┴──┐       │             │
   │                              │       │             │
   ▼ iOS                          ▼ Android│            ▼
┌──────────────┐            ┌──────────────┴──┐   ┌──────────────────┐
│ Appium :4725 │            │ adb  (shared    │   │ a11y-bridge APK  │
│ + XCUITest   │            │ machine daemon) │   │ on the phone     │
└──────┬───────┘            └────────┬────────┘   │ HTTP :8080       │
       │ USB                         │ USB/Wi-Fi  └────────┬─────────┘
       ▼                             ▼                     │ Wi-Fi
   ┌────────┐                   ┌──────────┐               │
   │ iPhone │◀── WDA :8100 ─────│ Android  │◀──────────────┘
   └────────┘                   └──────────┘

        push relay (npm run push:relay) ── SSE ──▶ web ── HTTPS ──▶ exp.host
```

Two processes are **not** supervised by the desktop app and are started by hand
when you want them: the **push relay** (`npm run push:relay`, `docs/push-relay.md`)
and the **MCP stdio server** (`npm run mcp`, `docs/mcp.md`). The MCP tools are
also reachable over HTTP at `POST /mcp` inside `web`, so an agent on the same
machine needs no extra process at all.

The **drip planner** is not a process. It is a timer inside `web`
(`DRIP_PLANNER_INTERVAL_MINUTES`, default 60) that turns drip rules into ordinary
one-off schedules — see `docs/content-queue.md`.

## The processes

### `web` — `src/api/server.ts` → `startServer()` → `src/api/app.ts`
Fastify app on `WEB_PORT` (default 3000).

- Server-rendered dashboard, every page through the same shell
  (`src/ui/shell.ts`): **Control Center** (`/`, the wall of live phone screens),
  **Schedule** (`/schedule`, the timeline — one track per phone, one clip per
  post), **Content** (`/content`, the library and the drip rules), **Runbooks**
  (`/runbooks`), **Accounts**, **Alerts**, **Devices** (`/devices/:udid`,
  `/devices/register`), **Rig** and **Settings**. `/fleet` is the device list
  with filters and bulk actions; `/tasks` redirects to Schedule.
- JSON API under `/api/*` (devices, registrations, schedules, executions,
  assets, remote control), plus `GET /api/schedule/timeline?from=&to=`, which is
  the single read the Schedule page and its 30-second refresh both use.
- The event feed at `GET /api/events` / `GET /api/events/stream` (SSE).
- `POST /mcp` mounts the same MCP tool set the stdio server exposes.
- The **drip planner** timer, which turns drip rules into ordinary one-off
  schedules every `DRIP_PLANNER_INTERVAL_MINUTES` (default 60).
- Live device screen: `GET /api/devices/:udid/remote/stream` proxies the
  phone's MJPEG feed (iOS only; the device **grid**, and every Android device,
  use periodic `…/remote/screenshot` stills instead). The proxy aborts the
  upstream feed when the browser disconnects. `POST …/remote/action` goes
  through the device's driver — WDA on iOS, `adb`/the bridge on Android.
- Loads plugins (`PHONE_FARM_PLUGINS`) and the auth provider
  (`PHONE_FARM_AUTH_PLUGIN`); mounts each plugin's **panels** on the device
  page and its **routes** under `/plugins/<pluginId>`.
- `assertSafeBind(host, authProvider)` refuses a non‑loopback bind with no
  auth provider.
- Owns device **registration** (`DeviceRegistrationService`) and creates the
  scheduler runtime used to enqueue work.

### `worker` — `src/scheduler/worker.ts` → `startWorker()`
Headless. Owns task execution.

- One pg-boss worker per **active** registered device, queue
  `ios-device-<hash(udid)>` (the name predates Android support and is now just
  an opaque queue key; it is used for both platforms). A device with
  `disabled: true` in `devices.json` is skipped here and by `wda-service` — the
  entry stays but nothing supervises it.
- Every 5 s, `materializeDue()` turns due schedules into `executions` rows and
  enqueues jobs; every 30 s it picks up newly registered devices; every 60 s it
  reconciles queue state; hourly it runs the history cleanup and the
  orphaned-asset sweep.
- For each job: `executeAutomation()` (`src/scheduler/executor.ts`) waits for
  the device to be ready — **WDA plus Appium on iOS, adb visibility for the
  `adb` driver, a `/ping` for `a11y-bridge`** — builds a `TaskExecutionContext`
  with `context.driver` from `driverForDevice()`, and calls the task's
  `execute()`. Handles attempts, retry policy, stop requests, and the
  run-window deadline.
- Must load the **same plugin versions** as `web`.

### `wda-service` — `src/devices/wda-service.ts`
Persistent WebDriverAgent supervisor, controlled over a Unix socket
(`.wda/wda-service.sock`).

- Keeps one WDA session alive per registered device, (re)launching
  `xcodebuild test-without-building` as needed and USB‑forwarding WDA
  (`8100`, `8101`, …) and MJPEG (`9100`, `9101`, …).
- `GET /health` on the socket reports per‑device `{ physical, wda, appium,
  message }`. States: `ready`, `unlock-required`, `error`, …
- Single‑supervisor by design; a lock prevents duplicates.

### `appium` — `npm run appium` (iOS only)
Appium 3 with the XCUITest driver, isolated in `APPIUM_HOME=.appium2`, on
`127.0.0.1:4725` (`--base-path /`). iOS task subprocesses (e.g.
`src/tiktok/doomscroll.ts`) connect to it with `webdriverio`. The dashboard's
remote control does **not** go through Appium — it talks to WDA directly.
Android never touches Appium at all. Binds loopback only.

### `adb` — the Android channel
Not a farm process: `adb` is a machine-wide daemon that the farm shells out to.
`devices/discovery.ts` runs `adb devices -l` alongside the usbmuxd scan, and the
`adb` driver runs `adb shell input` / `exec-out screencap` / `uiautomator dump`.
The desktop app runs `adb start-server` once as a one-shot service and
deliberately never kills it. `ANDROID_DISCOVERY=off` skips adb entirely on an
iOS-only host.

The alternative Android channel is the **sim-use accessibility bridge APK**
(`driver: "a11y-bridge"`): an `AccessibilityService` plus an HTTP server
listening on the phone's port `8080`. With the Wi-Fi build of the APK the phone
needs no cable at run time — the farm reaches
`http://<phone-ip>:8080` with a bearer token from `devices.json`. See
`src/drivers/README.md` and `docs/device-testing-checklist.md`.

### `push relay` — `npm run push:relay` (optional)
A pure API client: it follows `GET /api/events/stream` over HTTP and turns
events into Expo push notifications for the companion app. It never opens a
Postgres connection. Not supervised by the desktop app. See
`docs/push-relay.md`.

### `mcp` — `npm run mcp` (optional)
The MCP server over stdio, for an agent that cannot speak HTTP. The identical
tool set is already mounted at `POST /mcp` inside `web`, so this process is only
needed for stdio clients. See `docs/mcp.md`.

### `Backline.app` — `apps/desktop` (optional)
An Electron supervisor around all of the above except the push relay and the
MCP stdio server. It starts `postgres` (bundled or external) → `migrations` →
`adb`, `appium`, `wda` → `worker`, `web`, restarts crashes with backoff,
re-probes health every 15 s, and keeps a rotating log per service. It
re-implements no farm logic — it spawns the repository's own entry points. See
`docs/desktop.md`.

## Xcode, signing, and device pairing

The farm never talks to a device directly at the USB level for *control* — it
delegates the whole pair/trust/sign/launch chain to Xcode's toolchain:

- **Pairing & trust** are the OS's job. An iPhone must be paired (USB + "Trust
  This Computer") and, on iOS 16+, have **Developer Mode** enabled before any
  of this works. `xcrun xctrace list devices` / `discoverConnectedDevices()`
  (`appium-ios-device`, over `usbmuxd`) is how the app learns a device is
  attached; it does not initiate pairing.
- **The Developer Disk Image** for the device's iOS version is mounted by
  Xcode on first pair. `xcodebuild` needs it present to launch a test bundle.
- **Signing.** `src/devices/wda/prepare.ts` runs `xcodebuild build-for-testing`
  with `CODE_SIGN_STYLE=Automatic` and `DEVELOPMENT_TEAM=$XCODE_ORG_ID`. Xcode
  automatic signing creates/refreshes a development provisioning profile that
  lists the connected UDIDs and embeds it in `WebDriverAgentRunner-Runner.app`.
  This is why a new device must be plugged in (and the Apple ID have a free
  slot — the 100-UDID limit) when `wda:prepare` runs. Signing reads a
  certificate from the **login keychain**, which is only unlocked in a
  graphical session — hence the "run from Terminal.app, not SSH" rule.
- **Launch.** `wda-service` runs `xcodebuild test-without-building
  -destination id=<udid>` per active device: it installs the pre-signed
  `WebDriverAgentRunner` and starts it as a UI test. WDA then serves HTTP on
  the device's `:8100` and MJPEG on `:9100`, which `wda-service` USB-forwards
  to the host's `:81xx` / `:91xx`.

The **registration wizard** (`src/devices/registration.ts`) is a UI over this
chain: its `host` / `connection` / `signing` / `developer` / `wda` checks each
probe one link (Xcode selected, device visible over usbmux, a signing identity
present, the DDI mounted, WDA reachable) and surface a specific fix before the
device is written to `devices.json`. `wda:prepare` is the same signing step
without the UI, for scripted or bulk (`--all`) setup.

## Data & state

| Store | Contents |
| --- | --- |
| PostgreSQL `scheduler.*` | `schedules`, `executions`, `execution_attempts`, `execution_logs`, `assets`. Drizzle ORM; migrations in `drizzle/`. |
| PostgreSQL `pgboss.*` | Job queue (one partitioned queue per device). |
| PostgreSQL `drizzle.*` | Applied‑migration ledger. |
| PostgreSQL `scheduler.*` (content) | `content_items`, `content_sets`, `content_set_items`, `caption_templates`, `drip_rules`, `drip_plans` — `drizzle/0002_content.sql`. |
| PostgreSQL `scheduler.events` | The fleet event timeline — `drizzle/0003_events.sql`. |
| PostgreSQL `scheduler.push_registrations` / `event_acks` | Companion-app Expo tokens and per-token read marks — `drizzle/0004_push.sql`. |
| `devices.json` | Registered devices: `udid` (adb serial on Android), `name`, `platform`, `driver`, `android.{serial,bridgeUrl,bridgeToken}`, ports, `coordinateProfile`, per-device `coordinates` overrides, `passcode`, `tags`, `disabled`, `pluginData`. Git-ignored, `0600`. |
| `.auth.json` | Dashboard password hash, session signing key and API-token digests. Beside `devices.json` unless `AUTH_STATE_PATH` says otherwise. `0600`. |
| `.env` | Configuration and secrets (DB URL, signing IDs, auth keys). Git‑ignored. Device passcodes live in `devices.json`, not here. |
| `.scheduler-data/assets/` | Uploaded media for `post`‑style tasks, content‑addressed. |
| `.wda/` | wda-service socket and locks. |
| `.appium2/` | Isolated Appium home with the pinned XCUITest driver. |
| `.scheduler-data/content/` | Content library: `originals/`, `normalized/`, `posters/`. Overridable with `CONTENT_DIR`. |
| `.scheduler-data/runbooks/` | Runbook definitions for the built-in runbook plugin. |
| `.scheduler-data/push-relay.json` | The push relay's `Last-Event-ID` cursor. |

Under the desktop app all of these live in
`~/Library/Application Support/Backline` instead — see `docs/desktop.md`.

## The task model

Every schedule and execution row carries a **task envelope**:

```
pluginId : string        e.g. "com.git-agni.tiktok"
taskType : string        e.g. "doomscroll"
taskVersion : integer     e.g. 1
payload : jsonb          validated, version-specific shape
```

`PluginRegistry.task({pluginId, taskType, taskVersion})` resolves the envelope
to a `TaskDefinition`. Because the version is stored, **an old schedule can
never silently run a new contract** — if `taskVersion` 1 is no longer
installed, that schedule fails loudly instead of executing v2 logic.

## Scheduling

`ScheduleTiming` (`src/types.ts`):

| kind | fields |
| --- | --- |
| `now` | — |
| `once` | `runAt` (ISO) |
| `daily` | `localTime` `"HH:MM"`, `timezone` (IANA) |
| `weekly` | `localTime`, `timezone`, `weekdays` (0–6) |

`run_window_minutes` (default 30) is the grace period after the scheduled time;
past it, the execution is abandoned as "window expired". Recurrence is computed
in `src/scheduler/recurrence.ts`; the next occurrence is written to
`schedules.next_run_at`.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/api/` | Fastify app factory, controllers, middleware, HTTP routes |
| `src/scheduler/` | runtime, repository, pg-boss queue, recurrence, worker, executor |
| `src/database/` | Drizzle client, schema, migrate/setup entrypoints |
| `src/devices/` | discovery (usbmuxd + adb), registry (`devices.json`), registration flow (iOS and Android), WDA remote, wda-service, coordinate profiles, passcode lookup |
| `src/drivers/` | The `DeviceDriver` interface and one file per control channel: `wda.ts` (iOS), `adb.ts` and `a11y-bridge.ts` (Android), `select.ts` (entry → driver). See `src/drivers/README.md` and ADR 0001. |
| `src/fleet/` | Event vocabulary and stores, the `/fleet` page, fleet summary, bulk scheduling, device monitor |
| `src/schedule/` | The Schedule timeline: account colours (`accounts.ts`), the pure timeline model (`timeline.ts`), the page renderer |
| `src/ui/` | `renderShell` — sidebar, toolbar, nav — and the icon set every page draws from |
| `src/notifications/` | Webhook / Slack / Discord / ntfy channels and the daily digest |
| `src/push/` | Expo push registrations, acks, and the relay process |
| `src/content/` | Content library ingest, FFmpeg normalisation, caption templates, drip planner |
| `src/mcp/` | MCP server, tool definitions, stdio transport |
| `src/runbook/`, `src/runbook-plugin.ts` | The built-in runbook plugin |
| `src/runtime/farm-entry.ts` | How the farm re-spawns its own entry points (`.ts` + tsx, or compiled `.js`) |
| `src/devices/wda/` | `prepare.ts` (patch + build + sign WDA), `start.ts` (single-device WDA supervisor), `target-device.ts` (resolve which device a CLI command targets), diagnostics |
| `src/tiktok/` | iOS TikTok entry points (`doomscroll.ts`, `post.ts`), OCR, coordinates |
| `src/tiktok/android/` | The Android twins of the same routines, written against `DeviceDriver` |
| `src/tiktok-plugin.ts` | The built‑in plugin: task definitions, device panel, routes |
| `src/plugin.ts` | **Stable plugin & auth interfaces** |
| `src/registry.ts` | `PluginRegistry` — task resolution and validation |
| `src/loader.ts` | Dynamic import of `PHONE_FARM_PLUGINS` / `PHONE_FARM_AUTH_PLUGIN` |
| `src/motion/` | The human motion model: swipe arcs, pauses, per-device handedness (`docs/motion.md`) |
| `src/live/` | Live video: scrcpy's stream parsed (`scrcpy.ts`) and one session per watched phone (`sessions.ts`), served over `/api/devices/:udid/live` (`docs/live-video.md`) |
| `src/example-plugin.ts` | Minimal reference plugin |
| `static/dashboard/` | HTML templates, browser TS (`tsconfig.web.json` → `static/dashboard/assets/*.js`) |
| `Patches/` | WDA source patches applied by `wda:prepare` |
| `drizzle/` | SQL migrations + journal |
| `apps/desktop/` | The Electron supervisor (`docs/desktop.md`) |
| `apps/mobile/` | The Expo companion app (`docs/mobile-app.md`) |
| `packages/farm-client/` | Typed farm API client, SSE reader and a mock farm, shared by the companion app |
