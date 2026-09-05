# Getting started

Phone Farm drives physical **iPhones and Android phones** from a local
dashboard: guided device registration, a live screen with remote tap/swipe, and
a PostgreSQL-backed scheduler that runs versioned automation tasks (a TikTok
plugin ships built in, with an iOS routine and an Android routine).

There are three paths through this document. Read the one that matches what you
have, then go to [device-testing-checklist.md](device-testing-checklist.md) for
the first session with real hardware.

| You have | Go to |
| --- | --- |
| A Mac and you want the least setup | [A. The desktop app](#a-the-desktop-app) |
| Android phones and no Xcode | [B. Android only, by hand](#b-android-only-by-hand) |
| iPhones | [C. iPhones](#c-iphones) |

Common to all three: **Node.js 22+** (`engines.node >= 22`; the server runs
TypeScript directly through `tsx`, there is no build step) and **PostgreSQL 14+**.

---

## A. The desktop app

`Phone Farm.app` supervises PostgreSQL, the migrations, `adb`, Appium, the WDA
service, the worker and the web server, and opens the dashboard in its own
window. It bundles PostgreSQL 17, so you need neither Docker nor a database.

```sh
git clone <this-repo> phone-farm
cd phone-farm
npm install
npm --prefix apps/desktop install
npm run desktop:dev
```

Then:

1. **⌘, → Settings.** For Android, leave everything alone; `Android discovery`
   is on by default. For iOS, fill in `XCODE_ORG_ID` (your Apple Developer Team
   ID) and a `WDA_BUNDLE_ID` you control.
2. **Services panel.** `postgres`, `migrations`, `worker` and `web` must reach
   *healthy*. `adb`, `appium` and `wda` are **optional** — an Android-only Mac
   with no Xcode shows `wda` and `appium` as *not configured* with a one-line
   reason, and nothing is blocked.
3. **Farm → Prepare WebDriverAgent…** (iOS only). This is the signing build; it
   streams `xcodebuild` output into a job window and tells you the one step it
   cannot do for you (trusting the certificate on each iPhone).
4. The main window is the dashboard. Go to **Register device**.

The app does not read `.env`. Its configuration is
`~/Library/Application Support/Phone Farm/settings.json`, and its data —
`devices.json`, the scheduler data directory, the Postgres cluster and one
rotating log per service — lives beside it. Everything else about it, including
packaging and diagnostics export, is in [desktop.md](desktop.md).

Skip to [Register your first device](#register-your-first-device).

---

## B. Android only, by hand

Android needs **no Xcode, no Apple ID, no signing and no provisioning profile**.
The only device tool is `adb`.

### B1. Install adb

```sh
brew install --cask android-platform-tools    # macOS
# or: apt install android-tools-adb           # Debian/Ubuntu
adb version
```

`adb` must be on the `PATH` of the process that runs the web server.

### B2. Install and configure the farm

```sh
git clone <this-repo> phone-farm
cd phone-farm
npm install
cp .env.example .env
```

For an Android-only farm the only value you must set is the database:

| Key | What it is |
| --- | --- |
| `DATABASE_URL` | `postgresql://phone_farm:PASSWORD@127.0.0.1:5432/phone_farm` |
| `POSTGRES_PASSWORD` | Only needed by `docker compose` if you use the bundled database |

Everything else in `.env.example` has a working default. You can ignore the
whole iOS/WebDriverAgent block.

```sh
npm run db:up        # bundled Postgres (skip if you run your own)
npm run db:migrate
```

### B3. Put the phone into debugging mode

1. Settings → About phone → tap **Build number** seven times.
2. Settings → System → Developer options → enable **USB debugging**.
3. Plug the phone in, run `adb devices -l`, and accept the *Allow USB debugging?*
   prompt on the phone, ticking **Always allow from this computer**. Until you
   do, the serial reads `unauthorized`.

Also worth doing now, because the routines do not answer system dialogs:
Developer options → **Stay awake**, and remove the lock screen.

### B4. Run it

```sh
npm run web       # dashboard + API on :3000
npm run worker    # in a second terminal
```

That is the whole fleet for Android. `appium` and `wda:service` are iOS-only and
should not be started.

Skip to [Register your first device](#register-your-first-device).

---

## C. iPhones

Everything downstream — signing WebDriverAgent, launching it as a UI test, the
registration wizard's checks — assumes Xcode can already **see and sign for** the
iPhone.

### C1. Xcode and first device pairing

1. **Install the full Xcode** from the App Store (not just the Command Line
   Tools), open it once, and accept the licence:
   ```sh
   sudo xcodebuild -license accept
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   xcodebuild -runFirstLaunch
   ```
   `xcode-select -p` must now print `…/Xcode.app/Contents/Developer`. If your
   Xcode lives elsewhere, set `XCODE_DEVELOPER_DIR` — the default the code
   assumes is `/Applications/Xcode_26.2.app/Contents/Developer`.

2. **Add your Apple ID** in Xcode → Settings → Accounts. Select the team and
   note its **Team ID** (the 10-character string) — that is `XCODE_ORG_ID`. A
   free personal team works for a single device; a paid team is needed for more
   than one, and for the device list not to expire weekly.

3. **Pair the iPhone.** Connect it by USB, unlock it, tap **Trust This
   Computer**, enter the passcode. In Xcode → Window → **Devices and
   Simulators**, the device should appear and, after a minute, read
   **"Connected"** (not "Preparing" or "Unavailable") — Xcode is downloading the
   matching Developer Disk Image in the background.

4. **Enable Developer Mode** (iOS 16+): on the phone, Settings → Privacy &
   Security → **Developer Mode** → on → restart → confirm. If the toggle is not
   there yet, it appears after the first pair with Xcode.

5. **Login keychain** — `wda:prepare` signs with a certificate in your login
   keychain, which is only unlocked in a graphical session. Run it from
   Terminal.app or a remote desktop, not a bare SSH shell.

```sh
xcrun xctrace list devices      # your iPhone must be under "Devices", not "Devices Offline"
```

### C2. Install

```sh
git clone <this-repo> phone-farm
cd phone-farm
npm install
npm run appium:install-driver     # installs the XCUITest driver into ./.appium2
```

### C3. Configure

```sh
cp .env.example .env
```

Fill in at least:

| Key | What it is |
| --- | --- |
| `XCODE_ORG_ID` | Apple Development **Team ID** (Xcode → Settings → Accounts) |
| `WDA_BUNDLE_ID` | A bundle id you control, e.g. `com.yourorg.WebDriverAgentRunner` |
| `IOS_PLATFORM_VERSION` | `IPHONEOS_DEPLOYMENT_TARGET` for the WebDriverAgent build; `16.7` is a safe floor |
| `DATABASE_URL` | `postgresql://phone_farm:PASSWORD@127.0.0.1:5432/phone_farm` |
| `POSTGRES_PASSWORD` | Needed by `docker compose` if you use the bundled database |

You do not need a device UDID in `.env`. The CLI scripts and the registration
wizard resolve the target device on their own; pass `--udid <udid>` (or set
`IOS_UDID`) only to pin a specific one. Device passcodes stay out of `.env` too
— see [devices and secrets](#devices-and-secrets).

### C4. Database

```sh
npm run db:up        # start the bundled Postgres (skip if you run your own)
npm run db:migrate   # apply scheduler + pg-boss schema
```

### C5. Build WebDriverAgent

```sh
npm run wda:prepare                  # the connected / sole registered device
npm run wda:prepare -- --udid <udid> # a specific device
npm run wda:prepare -- --all         # every device in devices.json
```

This patches the Appium-bundled `appium-webdriveragent`, then runs `xcodebuild
build-for-testing` signed with your team, once per target device. It ends with
`** TEST BUILD SUCCEEDED **`.

> **Run this from a graphical login session** (Terminal.app, or a remote
> desktop), not a bare SSH shell. Code signing needs the login keychain
> unlocked; over SSH it fails with `errSecInternalComponent`. If you must run it
> over SSH: `security unlock-keychain ~/Library/Keychains/login.keychain-db` and
> `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <pw>
> ~/Library/Keychains/login.keychain-db` first.

Then, on **each iPhone**: Settings → General → VPN & Device Management → your
Apple Development certificate → **Trust**. Until that is done WebDriverAgent is
installed but iOS refuses to launch it.

### C6. Run the four iOS processes

Each is long-lived. In development that is four terminals; for an always-on host,
wrap each in a `launchd` agent (macOS) or systemd unit — they need no arguments,
just the repo as the working directory.

```sh
npm run appium         # Appium 3 + XCUITest on :4725
npm run wda:service    # per-device WebDriverAgent supervisor (Unix socket + :8100+/:9100+)
npm run worker         # scheduler worker — runs due tasks
npm run web            # dashboard + API on :3000
```

---

## Register your first device

Open <http://127.0.0.1:3000> and go to **Register device**. The wizard reads the
candidate's platform from discovery and runs a different check set per platform.

- **Android** — adb on PATH, the serial's adb state, USB-debugging
  authorisation, the chosen driver, a screenshot, one Home key, and the TikTok
  package. No signing, no ports, no coordinate profile. See
  [android-dashboard.md](android-dashboard.md).
- **iOS** — Xcode selected, the device visible over usbmux, a signing identity,
  the Developer Disk Image, and WDA reachable. Unlock the phone when WDA first
  launches.

Registering by hand instead of through the wizard is one `POST`:

```sh
curl -X POST http://127.0.0.1:3000/api/devices \
  -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3000' \
  -d '{"name":"pixel-03","udid":"R58N12ABCDE","platform":"android","driver":"adb",
       "android":{"serial":"R58N12ABCDE"}}'
```

## Schedule something

From a device page you can run the built-in TikTok tasks (`doomscroll`, `post`)
now or on a `daily`/`weekly`/`once` schedule. Watch progress in **Activity**;
full logs are under `GET /api/executions/:id`. Day-to-day operation — the drip
queue, the fleet page, alerts, backups — is [operations.md](operations.md).

## Authentication

On a loopback bind (`WEB_HOST=127.0.0.1`) auth is optional. Before binding to
anything else, set `PHONE_FARM_AUTH_PLUGIN`; startup **deliberately fails**
otherwise (`assertSafeBind`). The built-in provider is `local`:

```sh
npm run auth:set-password                       # prompts, writes .auth.json
npm run token:create -- --name my-iphone        # prints the token once
```

Or write your own against the `AuthProvider` interface in `src/plugin.ts` — it
hands you the Fastify instance to register login routes on, an
`authenticate(request)` hook, and `isPublicPath()` for the unauthenticated
allow-list. See [auth.md](auth.md).

## Devices and secrets

Registered devices live in `devices.json` (git-ignored, `0600`). It is a flat
JSON array:

```json
[
  {
    "name": "Phone A",
    "udid": "00008030-000000000000000E",
    "platform": "ios",
    "wdaLocalPort": 8100,
    "mjpegLocalPort": 9100,
    "coordinateProfile": "iphone8",
    "passcode": "123456",
    "tags": ["warm", "uk"],
    "pluginData": { "com.git-agni.tiktok": { "accounts": ["@handle"] } }
  },
  {
    "name": "pixel-03",
    "udid": "R58N12ABCDE",
    "platform": "android",
    "driver": "a11y-bridge",
    "android": {
      "serial": "R58N12ABCDE",
      "bridgeUrl": "http://192.168.1.42:8080",
      "bridgeToken": "1f0a3c2e-9b41-4d77-8a10-6c5e2f0b9d84"
    },
    "pluginData": {}
  }
]
```

- `platform` defaults to `ios`; `driver` defaults to `wda` on iOS and `adb` on
  Android. On Android the `udid` **is** the adb serial.
- `coordinateProfile` selects a compiled iOS tap layout — see
  [coordinates.md](coordinates.md).
- `tags` are free-form fleet labels, capped at 20 per device.
- `pluginData[<pluginId>]` is per-device plugin config (never secrets).
- `disabled: true` keeps the entry but stops the farm supervising it — no
  WebDriverAgent, no scheduler worker, no discovery polling. Toggle it from the
  dashboard ("Disconnect" on a device card, "Reconnect" under **Disconnected
  devices**) or with `PATCH /api/devices/:udid` (`{"disabled":true}` /
  `{"disabled":false}`). Scheduling is rejected while a device is disabled.
- `passcode` is the iOS unlock code, used to wake a locked phone before
  automation. It lives here because `devices.json` is git-ignored and written
  `0600`. It is **never** returned by the API — `GET /api/devices` reports
  `hasPasscode: true/false` instead. Set it in the registration wizard, with
  `PATCH /api/devices/:udid` (`{"passcode":"…"}`, `""` clears it), or by editing
  the file. `IOS_PASSCODE` / `IOS_PASSCODE_<UDID>` in the environment still work
  as a deprecated fallback. There is no Android equivalent — keep Android phones
  unlocked with **Stay awake**.
- `android.bridgeToken` is a device credential. It is passed to routines as
  `A11Y_BRIDGE_TOKEN` and never logged or returned by the API.

## Health and troubleshooting

| Symptom | Check |
| --- | --- |
| `wda: error … stale or corrupted` | Re-run `npm run wda:prepare`; delete `~/Library/Developer/Xcode/DerivedData/WebDriverAgent-*` if it keeps producing an empty `.app`. |
| `wda: unlock-required` | Physically unlock the iPhone once. |
| `Appium is unavailable on port 4725` | `npm run appium` not running, or a stale process on the port. |
| An Android serial reads `unauthorized` | The *Allow USB debugging?* prompt was not accepted on the phone. |
| `adb: command not found` in the web log | Android platform-tools are not on the web server's `PATH`. Set `ANDROID_DISCOVERY=off` if the host has no Android phones. |
| The bridge driver check fails on `/ping` | The APK is on loopback, or the phone's IP moved. See [device-testing-checklist.md](device-testing-checklist.md). |
| web returns 401 everywhere | An auth provider is configured — sign in, or unset `PHONE_FARM_AUTH_PLUGIN` on loopback. |
| Writes fail with 403 and reads work | The CSRF guard. Send `Authorization: Bearer …`, or a matching `Origin`. |
| `sh: appium: command not found` in an agent | Invoke via `node node_modules/appium/index.js …` if npm did not link the bin. |

`GET /health` lists the loaded plugins and versions. `wda:service`'s socket has
`/health` with per-device state. Under the desktop app, use the Services panel
and **Export diagnostics…** instead.
