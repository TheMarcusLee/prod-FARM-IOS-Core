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
   ├── Services window ──────▶ start/stop/restart, state, logs
   ├── Settings window ──────▶ userData/settings.json (0600)
   └── menu-bar item ────────▶ fleet summary, start all / stop all
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
`apps/desktop/../..`).

Headless self‑check — starts the fleet, waits for `/health`, prints the service
table as JSON and exits 0 or 1:

```sh
npm --prefix apps/desktop run smoke
```

Unit tests (supervisor state machine and settings handling, with fake child
processes) and the type check:

```sh
npm --prefix apps/desktop run check
```

## Build the .app / .dmg

```sh
npm run desktop:build
```

The output lands in `apps/desktop/release/`:
`Phone Farm-<version>-arm64.dmg` and `release/mac-arm64/Phone Farm.app`.

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

| Piece | Where it comes from |
|---|---|
| The farm itself | `extraResources` copies `src/`, `static/`, `drizzle/`, `Patches/`, the tsconfigs, `docs/` and the whole `node_modules` into `Contents/Resources/farm` |
| Node | none is installed — services run through the Electron binary with `ELECTRON_RUN_AS_NODE=1`, so `node --import tsx …` works with no system Node |
| PostgreSQL 17 | the `embedded-postgres` npm package, whose platform binaries are downloaded during `npm install` in `apps/desktop` |
| Appium | the repository's own `node_modules/appium`, started exactly as `npm run appium` does |
| adb, Xcode, WebDriverAgent | **not** bundled — they stay host tools, and their absence is reported, not fatal |

`asar` is deliberately disabled: the Postgres binaries are located from their own
package directory, and inside an archive that path cannot be executed.

## Where data lives

Everything is under `~/Library/Application Support/Phone Farm`:

| Path | Contents |
|---|---|
| `settings.json` | the settings below, written `0600` — it holds the generated database password |
| `postgres/` | the embedded PostgreSQL cluster |
| `logs/<service>.log` | one append‑only log per service, also `0600` |
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

An optional service that is not configured never blocks anything: an
Android‑only host with no Xcode still gets Postgres, the migrations, adb, the
worker and the dashboard. Each `not configured` row carries a one‑line reason
and a Help link into these docs. Shutdown stops everything in reverse dependency
order, including on `SIGINT`/`SIGTERM`.

## Known gaps

- **macOS only.** The packaging target, the WDA preflight and the tray assume
  macOS. Nothing else is wired up.
- **No crash detection for the bundled Postgres.** `embedded-postgres` gives no
  exit signal, so a postmaster that dies on its own is noticed the next time
  something queries it, not immediately. The other services are supervised
  properly.
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
- **`wda:prepare` is not wrapped.** The one‑off WebDriverAgent build still has to
  be run from a terminal (`npm run wda:prepare`) before the `wda` service can
  supervise real iPhones.
- **The app icon is a placeholder** and the build is unsigned, so Gatekeeper will
  quarantine the .dmg on another machine until it is signed and notarised.
- **The bundle is large** (~290 MB compressed) because the whole `node_modules`
  of the farm is shipped; nothing is tree‑shaken.
