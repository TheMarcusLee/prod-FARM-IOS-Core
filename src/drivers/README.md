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

Switch the same phone to the bridge by changing one field and adding the bridge details:

```json
{
  "name": "pixel-03",
  "udid": "R58N12ABCDE",
  "platform": "android",
  "driver": "a11y-bridge",
  "android": {
    "serial": "R58N12ABCDE",
    "bridgeUrl": "http://127.0.0.1:18300",
    "bridgeToken": "<from adb shell content query --uri content://com.linecorp.simuse.devicebridge/auth_token>"
  },
  "pluginData": {}
}
```

Existing iOS entries need no changes: `platform` defaults to `ios` and `driver` to `wda`.

## Bootstrapping the bridge on a phone (once, over USB)

1. Build the APK: `cd <sim-use>/bridge && ./gradlew :app:assembleRelease`.
2. `adb -s <serial> install app/build/outputs/apk/release/app-release.apk`
3. Enable the accessibility service on the phone (Settings → Accessibility → sim-use bridge).
4. Read the token: `adb -s <serial> shell content query --uri content://com.linecorp.simuse.devicebridge/auth_token`
5. Forward the port: `adb -s <serial> forward tcp:18300 tcp:<bridge port>` — or, with our Wi-Fi
   fork of the APK, use `http://<phone-ip>:<port>` as `bridgeUrl` and skip the forward.

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
  a run follows the driver: WDA plus Appium on iOS, adb visibility for `adb`, the ping for the bridge.
- Plugin child processes receive `DEVICE_UDID`, `DEVICE_PLATFORM` and `DEVICE_DRIVER` on every
  platform; `IOS_UDID`, `WDA_URL` and `IOS_PASSCODE` on iOS; `ANDROID_SERIAL` (which adb honours
  natively) plus `A11Y_BRIDGE_URL` / `A11Y_BRIDGE_TOKEN` on Android.
- `POST /api/devices` accepts `platform`, `driver` and `android` so an Android phone can be
  registered without the iOS registration wizard.

The Android TikTok routines live in `src/tiktok/android/` and drive this interface directly;
see `docs/android-tiktok.md` for the phone-side prerequisites and the selector table.

Still open: a platform-aware registration wizard and device page in the dashboard.
