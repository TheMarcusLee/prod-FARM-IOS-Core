# First hardware session — checklist

Everything in this repository up to now was written **without a phone
attached**. This is the running order for the first session with real hardware,
in the order that fails cheapest first: Android over `adb`, then the same
Android phone over the accessibility bridge, then an iPhone over WebDriverAgent.

Do them in that order even if iOS is what you care about. The adb path has no
signing, no provisioning and no Xcode in it, so it isolates "is the farm
working" from "is Apple's toolchain working".

Have ready: one Android phone with TikTok installed and logged in, one iPhone,
two USB cables, the farm running (`npm run web` + `npm run worker`, or the
desktop app), and a terminal in the repository root.

Throughout: **the guesses are marked**. Anything in a *Confirm* box is a value
this repository asserts but has never observed.

---

## Part 0 — before you touch a phone

- [ ] `npm run check` passes.
- [ ] `GET /health` answers and lists the TikTok and runbook plugins.
      ```sh
      curl -s http://127.0.0.1:3000/health | python3 -m json.tool
      ```
- [ ] The dashboard loads at <http://127.0.0.1:3000> and `/fleet` renders (empty
      is fine).
- [ ] `adb version` prints a version on the machine running `web`.
- [ ] Note where the logs are going. Started by hand, every process logs to its
      own terminal's stdout; under the desktop app they are one file per service
      under `~/Library/Application Support/Backline/logs/`. See
      [operations.md](operations.md#where-the-logs-are).

---

## Part 1 — Android over adb

The lowest-risk path: nothing is installed on the phone.

### 1.1 Put the phone into debugging mode

- [ ] Settings → About phone → tap **Build number** seven times.
- [ ] Settings → System → Developer options → **USB debugging** on.
- [ ] Developer options → **Stay awake** on, and remove the lock screen. The
      routines do not unlock Android phones — there is no unlock verb in the
      driver at all.
- [ ] Plug in over USB, run `adb devices -l`, accept the *Allow USB debugging?*
      prompt, tick **Always allow from this computer**.

```sh
adb devices -l
# R58N12ABCDE   device  product:... model:SM_G991B device:o1s
```

A serial reading `unauthorized` means the prompt was not accepted.

### 1.2 See it in the dashboard

- [ ] The device appears under **Register device** as an Android candidate.
      *Dashboard:* the candidate list shows the serial with an `android` badge.
      *Log to read:* the `web` process's stdout — discovery runs `adb devices -l`
      on each poll, and a missing `adb` shows up there as `command not found`.
- [ ] Step through the wizard with driver **`adb`**. Each check should pass:
      adb on PATH → adb sees the phone → USB debugging authorised → control
      channel → screen capture → input dispatch (one Home key) → TikTok
      installed.
- [ ] **Watch the phone during "input dispatch".** It should go to the home
      screen. That is the first end-to-end proof that the farm can touch it.
- [ ] Finish registration. `devices.json` now has an entry with
      `"platform": "android", "driver": "adb"`.

### 1.3 Screen and remote input

- [ ] Open the device page. A screenshot appears.
      *Confirm:* the screenshot is right-way-up and full-resolution.
- [ ] Tap somewhere on the still with remote input. The phone should react.

> **Confirm — the coordinate units.** `GET /api/devices/:udid/remote/info`
> reports `screen.screenSize`, and `POST …/remote/action` takes `x`/`y`. The
> client assumes both are in the same units with no `scale` applied. If taps
> land at half or a third of where you clicked, that assumption is wrong. This
> is the single most valuable thing to settle in this session.

### 1.4 A real routine

- [ ] From the device page, run TikTok **doomscroll** now, for 2 minutes.
- [ ] *Dashboard:* the execution goes `queued → running`; **Activity** streams
      log lines.
- [ ] *Log to read:* the `worker` process's stdout for the queue and executor,
      and `GET /api/executions/:id` for the durable per-attempt log.
- [ ] Expect it to fail somewhere in the feed. **That is the point of this
      step.** The failure message lists the selectors it tried and the texts
      that were on screen.

> **Confirm — the TikTok selector table.** Every row in
> [android-tiktok.md §4](android-tiktok.md#4-the-selector-table) was written
> with no phone attached; seven of them carry a `GUESS` marker in the source as
> well. Read the real values off the phone:
>
> ```sh
> adb -s <serial> shell uiautomator dump /dev/tty
> # if the device refuses /dev/tty:
> adb -s <serial> shell uiautomator dump /sdcard/dump.xml \
>   && adb -s <serial> shell cat /sdcard/dump.xml
> ```
>
> Correct `POST_SELECTORS` in `src/tiktok/android/post.ts` and `FEED_SELECTORS`
> in `src/tiktok/android/doomscroll.ts`, then update the table in
> `docs/android-tiktok.md`. The flow itself should not need to change.

### 1.5 A post

- [ ] Grant the gallery permission **by hand** first: open TikTok → **+** →
      **Upload** and accept the photos/media prompt. The routines never answer
      system dialogs; a phone that has never been through the picker stalls.
- [ ] Upload a short clip on the device page and run **post** now.
- [ ] *Confirm:* media is pushed with `adb push` into `/sdcard/DCIM/Camera`
      followed by a media-scanner broadcast, newest-last so the first file in
      the post is the first cell in the picker. Check the picker actually shows
      it in that order.

---

## Part 2 — the accessibility bridge APK

Only after Part 1 works. This is what lets a phone run with **nothing
attached**, on Wi-Fi, with the screen off.

The APK is the sim-use fork on branch `feat/bridge-wifi-bind` (sibling checkout
`sim-use/`, see its `FARM-NOTES.md`). Upstream reaches the bridge over
`adb forward`, which lands on the device's loopback and needs a cable; the fork
adds a bind-all flag plus a wake lock and a Wi-Fi lock so it stays reachable.

### 2.1 Build it

```sh
cd <sim-use>/bridge
export JAVA_HOME=/Library/Java/JavaVirtualMachines/openjdk-21.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
echo "sdk.dir=$ANDROID_HOME" > local.properties     # gitignored
./gradlew :app:assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest    # 66 JVM tests, no emulator
```

JDK 17–21 only; the bundled Gradle 8.7 rejects JDK 22+. The APK is
**debug-signed** — the signature carries no authenticity guarantee, so your own
`adb` is the trusted channel.

### 2.2 Provision the phone (once, over USB)

```sh
BRIDGE=com.linecorp.simuse.devicebridge
SERIAL=<adb serial>          # from `adb devices`

# 1. Install.
adb -s "$SERIAL" install -r bridge/app/build/outputs/apk/debug/app-debug.apk

# 2. Enable the accessibility service.
adb -s "$SERIAL" shell settings put secure enabled_accessibility_services \
  "$BRIDGE/$BRIDGE.service.SimuseAccessibilityService"
adb -s "$SERIAL" shell settings put secure accessibility_enabled 1

# 3. Mint / read the bearer token.
adb -s "$SERIAL" shell content query \
  --uri content://com.linecorp.simuse.devicebridge/auth_token
# → Row: 0 result={"status":"success","result":"1f0a...-...."}

# 4. Enable Wi-Fi mode (the listener restarts immediately).
adb -s "$SERIAL" shell content call \
  --uri content://com.linecorp.simuse.devicebridge \
  --method set_bind_all --arg true

# 5. Read the IP back.
adb -s "$SERIAL" shell content call \
  --uri content://com.linecorp.simuse.devicebridge --method status
# → {"bind_all":true,"bound_all":true,"server_running":true,
#    "accessibility_service_connected":true,"port":8080,"lan_ipv4":"192.168.1.42"}

# 6. Verify over the LAN — the cable can now come out.
curl http://192.168.1.42:8080/ping
```

A healthy device answers step 6 with:

```json
{"status":"success","result":"pong","protocol_version":2,
 "bridge_version":"0.14.0","bind_all":true}
```

Checklist for this part:

- [ ] Step 1 installs without a signature conflict. (`adb uninstall` first if an
      upstream build is already there.)
- [ ] **Step 2 sticks.** On many real devices Android's **Restricted Settings**
      blocks an adb-installed app from being granted accessibility, and the
      `settings put` silently does nothing. Verify with
      `adb shell settings get secure enabled_accessibility_services`; if it did
      not take, grant it by hand under *Settings → Accessibility → sim-use
      device bridge* and re-run.
- [ ] **Step 2 clobbers any other enabled accessibility service.** If the phone
      already has one you care about, append to the existing colon-separated
      value instead of overwriting it.
- [ ] Step 3 returns a UUID. The token is the value of the inner `result`
      field, **not** the surrounding JSON envelope.
- [ ] Step 5 reports `bind_all: true` **and**
      `accessibility_service_connected: true`. If `bind_all` comes back false,
      the listener is still on loopback — re-run step 4.
- [ ] Step 6 answers with the cable **unplugged**.
- [ ] Give the phone a **DHCP reservation**. Nothing in the bridge announces an
      address change; if the IP moves, the farm just sees connection refusals.

> **Confirm — the Wi-Fi keep-alive.** The fork holds a `PARTIAL_WAKE_LOCK` and a
> Wi-Fi lock (`WIFI_MODE_FULL_LOW_LATENCY`, or `WIFI_MODE_FULL_HIGH_PERF` below
> API 29) only while LAN mode is on. **Samsung devices are the known risk**:
> their aggressive Wi-Fi power saving and battery optimiser can still drop the
> socket with the screen off. Test it — leave the phone idle and screen-off for
> 30 minutes, then `curl …/ping` again. If it fails, exempt the app from battery
> optimisation (*Settings → Apps → sim-use device bridge → Battery →
> Unrestricted*) and re-test before blaming the farm.

### 2.3 Switch the farm to the bridge

The APK listens on **8080** on the phone (`SERVER_PORT`, not configurable).
Two ways to reach it:

| | `bridgeUrl` | Cable needed at run time |
| --- | --- | --- |
| Wi-Fi fork (what you just did) | `http://<phone-ip>:8080` | no |
| Upstream / loopback bind | `http://127.0.0.1:18300` after `adb -s <serial> forward tcp:18300 tcp:8080` | yes |

- [ ] Change the device in the dashboard, or edit `devices.json` directly. Note
      that the farm's `devices.json` is a **flat array**, not the
      `{"devices":[…]}` wrapper shown in `FARM-NOTES.md`, and the fields are
      `udid` / `android.serial`, not `id`:

      ```json
      [
        {
          "name": "pixel-07",
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

      `bridgeUrl` is scheme + host + port with **no trailing slash and no path**
      — the farm appends `/ping`, `/screenshot`, `/tap`.
- [ ] Re-run the registration wizard's driver check with `a11y-bridge`
      selected, or `POST /api/devices/:udid/checks`. It verifies, in order: the
      package is installed, the service is enabled, the token is readable, and
      `GET <bridgeUrl>/ping` answers.
- [ ] *Dashboard:* the device card shows an `a11y-bridge` driver badge and reads
      **online** with the cable out. Android readiness for this driver is the
      ping, not adb visibility.
- [ ] Re-run doomscroll over the bridge and compare against Part 1.4. Launch,
      terminate and media push still go over adb during the sync pass — the
      posting routine itself only needs the bridge.

**Security, before you leave it running:** traffic is plain HTTP with no TLS,
so the token crosses the network in cleartext on every request, and anyone who
can reach `<ip>:8080` **and** holds the token has accessibility-level control of
the phone — screen contents, input, clipboard. Put the farm on a dedicated
SSID/VLAN with no inbound route from the internet. Client isolation between
phones is fine; only the controller needs to reach them.

---

## Part 3 — iPhone over WebDriverAgent

Only after Parts 1 and 2. This is the part with Apple in it.

- [ ] Prerequisites from
      [getting-started.md §C1](getting-started.md#c1-xcode-and-first-device-pairing):
      full Xcode selected, Apple ID and team added, phone paired and trusted,
      **Developer Mode** on, `xcrun xctrace list devices` showing the phone
      under "Devices".
- [ ] `npm run wda:prepare` from **Terminal.app**, not SSH. It ends with
      `** TEST BUILD SUCCEEDED **`.
- [ ] On the phone: Settings → General → VPN & Device Management → your Apple
      Development certificate → **Trust**. Until this is done WDA is installed
      but iOS refuses to launch it — and nothing automates this step.
- [ ] `npm run appium` and `npm run wda:service` are both running.
- [ ] Register the device through the wizard. Unlock the phone when WDA first
      launches.
- [ ] *Dashboard:* the device page shows a **live MJPEG stream**, not just
      stills — that is the iOS-only path and the quickest signal that WDA is
      really up.
- [ ] *Log to read:* the `wda:service` process's stdout, plus its socket health:
      ```sh
      curl --unix-socket .wda/wda-service.sock http://localhost/health
      ```
      Per-device state is `{ physical, wda, appium, message }`; `ready`,
      `unlock-required` and `error` are the ones you will see.
- [ ] Set the device passcode in the wizard (or `PATCH /api/devices/:udid`) and
      confirm the farm wakes a locked phone before a run.
- [ ] Run doomscroll for 2 minutes and compare the behaviour against Android.

---

## Part 4 — alerts and the companion app

- [ ] Point `NOTIFY_NTFY_URL` at an unguessable ntfy topic and restart `web`.
- [ ] `POST /api/notifications/test` and check the phone gets it:
      ```sh
      curl -X POST http://127.0.0.1:3000/api/notifications/test \
        -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3000' -d '{}'
      ```
      It answers `409` when no channel is configured.
- [ ] Pull a cable mid-run and confirm a `device.disconnected` event lands in
      `/fleet` and in the alert channel.

> **Confirm — push needs a real build.** `expo-notifications` push tokens do not
> work in **Expo Go**. The companion app must be a **development build** (or a
> TestFlight/internal build) for `getExpoPushTokenAsync` to mint a token, and
> `extra.eas.projectId` must be present in `app.json` — it is not committed, so
> `eas init` has to have been run. Testing push in Expo Go will fail in a way
> that looks like a farm bug and is not.

- [ ] Only then: `npm run push:relay` with a token from
      `npm run token:create -- --name push-relay`, and confirm a notification
      arrives on the phone.

---

## Rollback and cleanup

Undo in reverse order. Nothing here touches the database.

**The bridge APK**

```sh
# Take the phone back off the network without uninstalling:
adb -s "$SERIAL" shell content call \
  --uri content://com.linecorp.simuse.devicebridge --method set_bind_all --arg false

# Full removal:
adb -s "$SERIAL" uninstall com.linecorp.simuse.devicebridge
adb -s "$SERIAL" shell settings put secure accessibility_enabled 0
adb -s "$SERIAL" shell settings delete secure enabled_accessibility_services
```

`pm clear com.linecorp.simuse.devicebridge` rotates the token **and** resets the
bind-all flag, so steps 3–5 of §2.2 have to be re-run after any wipe or
reinstall that clears app data. If you overwrote another accessibility service
in §2.2, restore it now.

**A registered device**

- Dashboard → device page → **Danger zone** → *Remove device*, or
  `DELETE /api/devices/:udid`. This cancels its schedules and forgets its
  configuration. **WebDriverAgent stays installed on the phone.**
- To keep the entry but stop supervising it, set `disabled: true`
  (`PATCH /api/devices/:udid`) instead — no WDA, no worker, no discovery
  polling.

**WebDriverAgent on an iPhone**

- Delete the `WebDriverAgentRunner` app from the phone.
- Settings → General → VPN & Device Management → remove the developer profile.
- Settings → Privacy & Security → **Developer Mode** off (needs a restart).
- On the Mac, if a build went bad:
  `rm -rf ~/Library/Developer/Xcode/DerivedData/WebDriverAgent-*`.

**Android debugging**

- Developer options → **Revoke USB debugging authorisations**.
- Turn **Stay awake** back off and restore the lock screen.

**The farm host**

```sh
adb kill-server                      # only if nothing else on the Mac uses adb
rm -rf .wda .appium2                 # sockets, locks, the isolated Appium home
```

Leave `devices.json`, `.auth.json` and `.scheduler-data/` alone unless you mean
to lose the fleet, the tokens and the content library. Backing those up is
[operations.md](operations.md#backups).

---

## What to write down

When the session is over, correct the docs rather than remembering:

| If you learned | Fix |
| --- | --- |
| Real TikTok selectors | `src/tiktok/android/{post,doomscroll}.ts` and the table in `docs/android-tiktok.md` |
| The coordinate units | `docs/mobile-api.md` (`/remote/info`, `/remote/action`) and `docs/mobile-app.md` "Still open" |
| Bridge behaviour on your phones | This file's §2.2 confirm boxes, and `sim-use/FARM-NOTES.md` |
| A step that is missing here | This file |
