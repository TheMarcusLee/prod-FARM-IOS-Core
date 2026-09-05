# Device drivers

One interface (`DeviceDriver` in `types.ts`), one file per control channel. Routines call the
interface; nothing above this directory knows which phone or channel is underneath.
Design rationale: `docs/adr/0001-multi-platform-device-drivers.md`.

| File | Platform | Channel |
|---|---|---|
| `wda.ts` | iOS | WebDriverAgent over HTTP (wraps `devices/wda-remote.ts`) |
| `adb.ts` | Android | `adb shell input` / `screencap` / `uiautomator dump` |
| `a11y-bridge.ts` | Android | sim-use device bridge APK (AccessibilityService + HTTP) |
| `select.ts` | — | `devices.json` entry → driver factory |
| `verify.ts` | — | tree-first, OCR-second element lookup; `waitForText`, `tapText` |
| `uiautomator-xml.ts` | Android | parser for `uiautomator dump` output |
| `common.ts` | — | `pause`, command runner, HTTP client with deadlines |

## Registering an Android phone

Add to `devices.json` (the `udid` is the adb serial):

```json
{
  "name": "pixel-03",
  "udid": "R58N12ABCDE",
  "platform": "android",
  "driver": "adb",
  "pluginData": {}
}
```

Switch the same phone to the bridge by changing one field and adding the bridge details (the APK
listens on 8080; see the bootstrap section below for where the address and the token come from):

```json
{
  "name": "pixel-03",
  "udid": "R58N12ABCDE",
  "platform": "android",
  "driver": "a11y-bridge",
  "android": {
    "serial": "R58N12ABCDE",
    "bridgeUrl": "http://192.168.1.42:8080",
    "bridgeToken": "<from adb shell content query --uri content://com.linecorp.simuse.devicebridge/auth_token>"
  },
  "pluginData": {}
}
```

Existing iOS entries need no changes: `platform` defaults to `ios` and `driver` to `wda`.

### `android.bridgeOnly` — the adb the bridge still needs

An `AccessibilityService` cannot start an app, stop one, or write a file to the gallery, so
`a11y-bridge` keeps an adb driver behind it (`select.ts`) and forwards `launchApp`,
`terminateApp` and `pushMedia` to it. A phone that answers on the bridge but is invisible to adb
is therefore only *partly* driveable: taps, swipes, typing, screenshots and the tree work, and the
first launch step of a routine fails.

Readiness reflects that. `scheduler/executor.ts` requires **both** the bridge ping and adb
visibility before it starts a run on an `a11y-bridge` device. Set `"bridgeOnly": true` under
`android` to trade that safety for reach:

```json
"android": {
  "serial": "R58N12ABCDE",
  "bridgeUrl": "http://192.168.1.40:8080",
  "bridgeToken": "<uuid>",
  "bridgeOnly": true
}
```

| | adb visible | `bridgeOnly: true`, adb gone |
|---|---|---|
| tap / swipe / type / key / screenshot / tree | yes | yes |
| `launchApp` / `terminateApp` / `pushMedia` | yes | **throws `UnsupportedOperationError` mid-run** |
| starts a run while off USB | no — held until adb sees it | yes |

So: leave it unset for a phone on a USB hub or on wireless adb, and set it only for a phone that
is deliberately unreachable by adb *and* runs routines that launch apps by tapping the home-screen
icon and never push media. `POST /api/devices` accepts the field; the dashboard does not set it.

## Bootstrapping the bridge on a phone (once, over USB)

**The running order lives in [docs/device-testing-checklist.md](../../docs/device-testing-checklist.md),
part 2** — build flags, the Restricted Settings trap that silently swallows the
accessibility grant, and what a healthy `/ping` looks like. Do not follow a
summary here instead; that is how this section went stale.

The facts a caller of this directory needs:

- The APK listens on **8080** on the phone. That is `SERVER_PORT` in the bridge
  and is not configurable — `18300` is only ever a *host-side* forwarded port.
- Build the fork with `./gradlew :app:assembleDebug` (`app-debug.apk`). Our
  Wi-Fi fork is debug-signed; there is no release build to install.
- Wi-Fi mode is a ContentProvider call, not a build flag:
  ```sh
  adb -s "$SERIAL" shell content call \
    --uri content://com.linecorp.simuse.devicebridge --method set_bind_all --arg true
  ```
- `--method status` prints the LAN address to put in `bridgeUrl`:
  ```sh
  adb -s "$SERIAL" shell content call \
    --uri content://com.linecorp.simuse.devicebridge --method status
  # → {"bind_all":true,"bound_all":true,"server_running":true,
  #    "accessibility_service_connected":true,"port":8080,"lan_ipv4":"192.168.1.42"}
  ```
- The token comes from the same provider:
  ```sh
  adb -s "$SERIAL" shell content query \
    --uri content://com.linecorp.simuse.devicebridge/auth_token
  # → Row: 0 result={"status":"success","result":"<uuid>"}
  ```

So `bridgeUrl` is `http://<lan_ipv4>:8080` on the Wi-Fi fork, with no `adb
forward` at all. Only an upstream (loopback-bound) build needs
`adb -s "$SERIAL" forward tcp:18300 tcp:8080` and `http://127.0.0.1:18300`.

Anyone who can reach `<ip>:8080` and holds the token has accessibility-level
control of that phone, so keep the phones on a network you trust.

## What `adb` cannot do

The adb driver shells out, so its arguments are re-parsed by the *device's* shell. Every argument
that can contain user data is single-quoted (`shellQuote`); do the same for anything new.

- **`type()` is ASCII-only.** `adb shell input text` looks characters up in the KeyCharacterMap and
  silently drops what it cannot find, so emoji, accented letters, newlines and tabs would post as
  gibberish. The driver throws a `DriverError` naming the offending character instead. There is no
  general workaround over adb (the clipboard route needs a helper app of its own), so the answer for
  a phone that has to type non-ASCII captions is the **`a11y-bridge` driver**, which sends the text
  base64-encoded as UTF-8 to the on-device keyboard route.
- **`uiautomator dump` writes to a file.** `/dev/tty` only works when adb allocated a pty, and OEM
  builds print a `UI hierchary dumped to` banner around the output, so the driver dumps to
  `/sdcard/window_dump.xml` and `cat`s it back, accepting inline XML when a build provides it.
- **`launchApp` does not trust monkey.** monkey reports failure on stdout rather than through its
  exit code, so the driver checks for `Events injected: 1` and otherwise resolves the launcher
  activity (`cmd package resolve-activity --brief`) and `am start`s it.
- **Media scanning.** Android 10 removed the `MEDIA_SCANNER_SCAN_FILE` receiver and rejects
  `file://` URIs, so pushed media is registered through MediaStore's `scan_file` provider method
  first, with the old broadcast kept as the pre-10 fallback. Pushes land in `/sdcard/DCIM/Camera`,
  which MediaStore indexes.

## Writing a routine against the interface

```ts
import { driverForDevice, tapText, waitForText } from '../drivers/index.js';

const driver = driverForDevice(device, { passcode });
await driver.launchApp('com.zhiliaoapp.musically');
await driver.pause(2_000, signal);
await tapText(driver, { text: 'Post' }, recognizeWords);   // tree first, OCR fallback
await waitForText(driver, { text: 'Posted' }, { timeoutMs: 60_000, signal });
```

## How the farm uses this layer

- `devices/discovery.ts` lists iPhones (usbmuxd) and Android phones (`adb devices -l`) together;
  set `ANDROID_DISCOVERY=off` on an iOS-only host to skip adb entirely.
- `devices/connection-manager.ts` supervises WDA for iOS devices only. Android devices report
  `ready` when adb sees them, or, for `a11y-bridge`, when `GET <bridgeUrl>/ping` answers, so a
  phone on Wi-Fi with nothing attached still shows as connected.
- `scheduler/executor.ts` builds the driver with `driverForDevice` and hands it to plugins as
  `context.driver`; the older `context.automation` is served by the same driver. Readiness before
  a run follows the driver: WDA plus Appium on iOS, adb visibility for `adb`, and for `a11y-bridge`
  the ping **plus** adb visibility unless `android.bridgeOnly` is set — see above.
- Plugin child processes receive `DEVICE_UDID`, `DEVICE_PLATFORM` and `DEVICE_DRIVER` on every
  platform; `IOS_UDID`, `WDA_URL` and `IOS_PASSCODE` on iOS; `ANDROID_SERIAL` (which adb honours
  natively) plus `A11Y_BRIDGE_URL` / `A11Y_BRIDGE_TOKEN` on Android. Everything such a process
  prints is appended to the stored run log, so the executor runs each line through a redactor
  seeded with that device's token and passcode first — a routine that echoes its environment
  cannot put a live credential in the database.
- `POST /api/devices` accepts `platform`, `driver` and `android` so an Android phone can be
  registered without the iOS registration wizard.
- The registration wizard (`devices/registration.ts`) runs an Android check set — adb on PATH, the
  serial's adb state, USB-debugging authorisation, the chosen driver, screencap, one Home key, the
  TikTok package — and writes `platform`, `driver` and `android` straight into `devices.json`.
  See `docs/android-dashboard.md`.
- The device page and the devices grid show platform and driver badges, and for an Android device the
  screen size, screenshot and remote input all go through `driverForDevice` instead of WDA.

The Android TikTok routines live in `src/tiktok/android/` and drive this interface directly;
see `docs/android-tiktok.md` for the phone-side prerequisites and the selector table. Registering
an Android phone from the dashboard is covered in `docs/android-dashboard.md`. The Wi-Fi build of
the bridge APK (bind-all, keep-alive, richer `/ping`) lives in the sibling `sim-use` fork on branch
`feat/bridge-wifi-bind`; its `FARM-NOTES.md` has the exact bootstrap commands.
