# The desktop application

`apps/desktop` wraps the farm in a macOS Electron app that supervises every
long‑lived process the [README](../README.md) tells you to start by hand
(`appium`, `wda:service`, `worker`, `web`, plus the database and its migrations),
so an operator never opens a terminal and never needs Docker.

The Electron app is only a supervisor and a window. It does **not** re‑implement
any farm logic: it spawns the repository's own entry points, with an environment
it builds from its settings file.

```
   Phone Farm.app
   ├── main window ──────────▶ http://127.0.0.1:<WEB_PORT>   (the real dashboard)
   ├── Services window ──────▶ start/stop/restart/restart all, state, logs, jobs
   ├── Settings window ──────▶ userData/settings.json (0600)
   ├── Job window ───────────▶ a one-shot job's checklist and streamed output
   └── menu-bar item ────────▶ fleet summary, start / stop / restart all
            │
            └── supervises: postgres → migrations → adb, appium, wda → worker, web
```

## Run it in development

```sh
npm install                 # once, in the repository root
npm --prefix apps/desktop install
npm run desktop:dev
```

`desktop:dev` builds `apps/desktop/dist` with esbuild and launches Electron
against the checkout you are standing in (the app resolves the repository as
`apps/desktop/../..`), so in development every service still runs through `tsx`
straight from the TypeScript sources.

If `npm install` leaves `apps/desktop/node_modules/electron/dist` empty, the
Electron downloader has to be run once by hand:

```sh
node apps/desktop/node_modules/electron/install.js
```

Headless self‑check — starts the fleet, waits for `/health`, prints the service
table as JSON and exits 0 or 1:

```sh
npm --prefix apps/desktop run smoke
```

Unit tests (the supervisor state machine and its health sweep on a manual clock,
job running, settings, log rotation, diagnostics redaction and the Postgres
probe — all with fake child processes) and the type check:

```sh
npm --prefix apps/desktop run check
```

## Build the .app / .dmg

```sh
npm run desktop:build
```

The output lands in `apps/desktop/release/`:
`Phone Farm-<version>-arm64.dmg` and `release/mac-arm64/Phone Farm.app`.

`dist` runs `npm run build:farm` first (`apps/desktop/scripts/build-farm.mjs`),
which produces `apps/desktop/farm-dist` — see [What is bundled](#what-is-bundled).
That step re-installs the farm's production dependencies, so it needs the network
the first time; afterwards a stamp file keeps `node_modules` if the lockfile has
not moved (`npm run build:farm -- --force` rebuilds it anyway, `--no-modules`
recompiles only the sources).

The build is **unsigned and un‑notarised**. To sign it, set `CSC_LINK` and
`CSC_KEY_PASSWORD` (plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID` for notarisation) in the environment, then in
`apps/desktop/electron-builder.yml` replace `identity: null` with your
`Developer ID Application: …` name, set `notarize: true` and
`hardenedRuntime: true`. Everything else in that file already works.

`apps/desktop/build/icon.png` is a generated placeholder
(`node scripts/make-icon.mjs` regenerates it). Drop real artwork at that path
before shipping.

## What is bundled

The packaged app does **not** ship the checkout. `npm run build:farm` builds
`apps/desktop/farm-dist`, and that is what `extraResources` copies to
`Contents/Resources/farm`:

| Piece | Where it comes from |
|---|---|
| The farm | `tsc -p apps/desktop/tsconfig.farm.json` compiles `src/**` to `farm-dist/src/**` — plain ESM JavaScript, no TypeScript sources and no `tsx` |
| `static/`, `drizzle/`, `Patches/`, `docs/` | copied verbatim: entry points resolve them relative to `import.meta.url`, and the migrations, the dashboard assets and the WebDriverAgent patches are read from disk at runtime |
| `node_modules` | `npm ci --omit=dev` from the repository lockfile into a staging directory, then pruned (below) |
| Node | none is installed — services run through the Electron binary with `ELECTRON_RUN_AS_NODE=1`, now as `node <entry>.js` with no loader |
| PostgreSQL 17 | the `embedded-postgres` npm package, whose platform binaries are downloaded during `npm install` in `apps/desktop` |
| Appium | copied back out of the checkout with its dependency closure: it is a `devDependency`, but the app supervises it as a service |
| adb, Xcode, WebDriverAgent | **not** bundled — they stay host tools, and their absence is reported, not fatal |

Three prunes account for most of the saving, all of them things the app can
never use:

- `ffprobe-static/bin/{linux,win32}` — the .dmg is arm64 macOS only (203 MB);
- `node-native-ocr/prebuilds/{linux-x64,win32-x64}`;
- tesseract language data other than `eng`, `osd` and `equ` — `src/tiktok/ocr.ts`
  never passes `lang`, so nothing else is ever loaded (44 MB).

`ffmpeg-static` keeps its binary: the staging install runs with
`--ignore-scripts`, so the binary its postinstall would fetch is copied from the
checkout instead of downloaded again.

The result, measured on this machine:

| | before | after |
|---|---|---|
| `Phone Farm-0.1.0-arm64.dmg` | 443,165,411 B (423 MiB) | 303,018,046 B (289 MiB) |
| `Phone Farm.app` | 1.2 GB | 877 MB |
| `Contents/Resources/farm` | 823 MB | 449 MB |

`asar` is deliberately disabled: the Postgres binaries are located from their own
package directory, and inside an archive that path cannot be executed.

### Which shape is running

`src/main/paths.ts` decides by looking for `src/api/server.js` (compiled) or
`src/api/server.ts` (a checkout) in the tree it found, and
`src/main/services/context.ts` builds the child arguments from that: `--import
tsx src/api/server.ts` in development, `src/api/server.js` in the packaged app.

The farm re-spawns some of its own entry points — the WDA supervisor, the WDA
service, and plugin task entry points such as `src/tiktok/post.ts`. Those go
through `src/runtime/farm-entry.ts`, which makes the same decision from its own
`import.meta.url`, so a compiled farm never looks for a `.ts` file or for `tsx`.

## Where data lives

Everything is under `~/Library/Application Support/Phone Farm`:

| Path | Contents |
|---|---|
| `settings.json` | the settings below, written `0600` — it holds the generated database password |
| `postgres/` | the embedded PostgreSQL cluster |
| `logs/<service>.log` | one log per service, `0600`, rotated at 10 MB keeping five generations (`web.log.1` … `web.log.5`) |
| `scheduler-data/` | `SCHEDULER_DATA_DIR` |
| `devices.json` | `DEVICES_CONFIG_PATH` — the registered fleet, including unlock passcodes |
| `wda.sock` | `WDA_SERVICE_SOCKET` |

Nothing is written into the repository checkout except Appium's own
`.appium2` home.

## Settings

The Settings window (⌘,) writes `settings.json` and nothing else. Each field maps
to one environment variable given to the children:

`WEB_PORT`, `APPIUM_PORT`, `PHONE_FARM_PLUGINS`, `PHONE_FARM_AUTH_PLUGIN`,
`TIKTOK_BUNDLE_ID`, `IOS_PLATFORM_VERSION`, `XCODE_ORG_ID`, `XCODE_SIGNING_ID`,
`WDA_BUNDLE_ID`, `ANDROID_DISCOVERY`, plus the database fields below.

`WEB_HOST` is always `127.0.0.1`. The app never offers a non‑loopback bind,
because `assertSafeBind()` refuses one without an auth provider — see
[SECURITY.md](../SECURITY.md).

"Launch at login" uses `app.setLoginItemSettings`. It only takes effect for a
signed build; an unsigned development build logs `Unable to set login item` and
carries on.

"Reset the embedded database" stops the fleet, asks for confirmation in a native
dialog and deletes the cluster directory. It refuses to run when an external
`DATABASE_URL` is configured.

## Database

By default the app runs the bundled PostgreSQL 17 on port `55432`, creating the
`phone_farm` role and database on first launch with a random URL‑safe password
kept only in `settings.json`. Then it runs `src/database/migrate.ts` as a
one‑shot step before the worker and the web server start — the same migrations
`npm run db:migrate` runs.

### Pointing it at your own PostgreSQL

Put a connection string in **Settings → External DATABASE_URL**. The app then
stops managing a cluster entirely: the `postgres` service becomes a TCP health
probe against your server, the bundled cluster is left untouched, and the
migrations still run against your database. Clear the field to go back to the
bundled one.

## Services

| Service | What it is | Health check | Optional |
|---|---|---|---|
| `postgres` | bundled cluster, or your `DATABASE_URL` | TCP connect | no |
| `migrations` | `src/database/migrate.ts`, one‑shot | exit code 0 | no |
| `adb` | `adb start-server`, one‑shot | the command succeeds | yes |
| `appium` | `node_modules/appium/index.js` | `GET /status` | yes |
| `wda` | `src/devices/wda-service.ts` | `GET /health` on the Unix socket | yes |
| `worker` | `src/scheduler/worker.ts` | running | no |
| `web` | `src/api/server.ts` | `GET /health` | no |

States are `stopped`, `starting`, `healthy`, `stopping`, `failed` and
`not configured`. A crash is restarted with exponential backoff (1s, 2s, 4s …
capped at 30s) up to five times, then the service is parked in `failed`.

Every 15 seconds the supervisor re‑probes the services it believes are healthy
(`SupervisorOptions.reprobeIntervalMs`; `0` switches the sweep off). A service
that stops answering is stopped and restarted through that same backoff. This is
what covers the bundled Postgres: `embedded-postgres` never reports an exit, so
a postmaster that dies on its own can only be noticed by asking it something.
The `postgres` probe is a `pg_isready` equivalent — it opens a socket, sends the
8‑byte SSLRequest a client sends first, and requires the single‑byte answer only
a live postmaster gives — rather than a bare TCP connect.

An optional service that is not configured never blocks anything: an
Android‑only host with no Xcode still gets Postgres, the migrations, adb, the
worker and the dashboard. Each `not configured` row carries a one‑line reason
and a Help link into these docs. Shutdown stops everything in reverse dependency
order, including on `SIGINT`/`SIGTERM`.

## Jobs

Some work is a one‑shot with an interesting log rather than a service. The
Services panel shows those as job cards above the service list; a card stays
after the job ends, with its result, until it is dismissed, and every job is
re‑runnable.

### Prepare WebDriverAgent

The one‑off WebDriverAgent build, previously a terminal‑only step. It is on the
`wda` service card, in **Settings → Devices** (where a single `--udid` can be
typed instead of building for every registered device) and under **Farm → Prepare
WebDriverAgent…**. It runs the repository's own `src/devices/wda/prepare.ts`,
the same code `npm run wda:prepare -- --all` runs, with the environment the app
already builds from Settings — a packaged app has no npm, and the signing values
live in `settings.json` rather than in a `.env`.

Before anything is spawned it reports every precondition, passing or not:

| Check | What it means |
|---|---|
| Xcode | `xcode-select -p` points at a full `Xcode.app`, not `CommandLineTools` |
| xcodebuild | `xcodebuild -version` runs (Xcode's licence has been accepted) |
| `XCODE_ORG_ID` / `XCODE_SIGNING_ID` / `WDA_BUNDLE_ID` | set in Settings |
| XCUITest driver | `.appium2/node_modules/appium-xcuitest-driver` exists, or `XCUITEST_DRIVER_PATH` is set — `prepare.ts` patches and builds WebDriverAgent out of that checkout |
| Registered devices | `devices.json` has at least one device, for `--all` |

Output streams into the job window while `xcodebuild` runs. **The last step is
not automatable**, and the job window says so: on each iPhone, Settings → General
→ VPN & Device Management → your Apple Development certificate → *Trust*, plus
Settings → Privacy & Security → Developer Mode on iOS 16+. Until that is done
WebDriverAgent is installed but iOS refuses to launch it.

## Operator actions

| Action | Where |
|---|---|
| Start all / Stop all / **Restart all** | Services panel, the Farm menu, the menu‑bar item |
| **Open data folder** | Services panel, the Farm menu, the menu‑bar item — opens `~/Library/Application Support/Phone Farm` |
| **Export diagnostics…** | Services panel and the Farm menu |

"Export diagnostics" writes a zip: `settings.json` with the database password and
any password inside `DATABASE_URL` replaced by `«redacted»`, the service table as
text and as JSON, the job list, and the last 2 MB of every service log including
its rotated generations. It is the thing to attach to a bug report.

## Known gaps

- **macOS only.** The packaging target, the WDA preflight and the tray assume
  macOS. Nothing else is wired up.
- **The bundled Postgres is noticed by polling, not by an exit.**
  `embedded-postgres` gives no exit signal, so a postmaster that dies on its own
  is caught by the 15‑second re‑probe rather than instantly. The other services
  are supervised properly.
- **A leftover postmaster blocks startup.** If the app is `kill -9`'d, the
  Postgres process can survive and hold the data directory; the next launch
  fails with a message naming the stale PID. Kill it and start again.
- **`embedded-postgres` prints `TypeError: done is not a function`** from its own
  exit hook when the app exits. It is cosmetic and does not affect shutdown.
- **The main process is CommonJS on purpose.** Electron 44's ESM main entry did
  not start reliably during development (the process hung before the first line
  of the entry point ran). If that is fixed upstream, `scripts/build.mjs` can go
  back to `format: 'esm'`.
- **The dashboard runs unauthenticated on loopback**, exactly as it does when you
  start it by hand. The app does not add authentication; set
  `PHONE_FARM_AUTH_PLUGIN` in Settings if you need one.
- **The packaged app has no XCUITest driver.** `.appium2` is not bundled, so both
  the `wda` service and the "Prepare WebDriverAgent" job need
  `npm run appium:install-driver` to have been run in a checkout, or
  `XCUITEST_DRIVER_PATH` pointed at one. The job reports this as a failed
  precondition instead of a stack trace.
- **The app icon is a placeholder** and the build is unsigned, so Gatekeeper will
  quarantine the .dmg on another machine until it is signed and notarised.
- **The bundle is still large** (~289 MiB compressed). The farm is compiled and
  the module tree is production‑only and platform‑pruned, but nothing is
  tree‑shaken: `ffprobe-static` (140 MB of macOS ffprobe), `node-native-ocr`
  (50 MB) and `ffmpeg-static` (44 MB) are most of what is left, and all three are
  real runtime dependencies.
- **`build:farm` needs the network** the first time, because it installs the
  farm's production dependencies from the lockfile. Later builds reuse
  `farm-dist/node_modules` unless the lockfile changes.
