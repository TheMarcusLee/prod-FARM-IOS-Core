# Registering an Android phone from the dashboard

The registration wizard at `/devices/register` handles both platforms. It reads the candidate's
`platform` (set by `adb devices -l` discovery) and runs a different set of checks; nothing about the
iOS path changes. Design rationale: [adr/0001-multi-platform-device-drivers.md](adr/0001-multi-platform-device-drivers.md).

## Before you start

- `adb` (Android platform-tools) must be on the `PATH` of the process running the web server.
- On the phone: Settings → About phone → tap **Build number** seven times, then Developer options →
  **USB debugging**.
- Plug the phone in and tap **Allow** on the *Allow USB debugging?* prompt, ticking *Always allow from
  this computer*. Until you do, `adb devices` reports the serial as `unauthorized` and the wizard's
  **USB debugging authorised** check stays blocked with that hint.
- Set `ANDROID_DISCOVERY=off` on an iOS-only host to skip adb entirely.

## The Android checks

| Check | What it runs |
|---|---|
| adb on PATH | `adb version` |
| adb sees the phone | `adb devices -l`, and the serial must be in the `device` state |
| USB debugging authorised | derived from the same listing; `unauthorized` surfaces the phone-prompt hint |
| Control channel | the chosen driver (below) |
| Screen capture | a screenshot through the driver (`adb exec-out screencap -p`) |
| Input dispatch | one **Home** key through the driver — deliberately the most harmless input there is |
| TikTok installed | `adb shell pm list packages com.zhiliaoapp.musically` (override with `TIKTOK_PACKAGE`, the same variable the routines read) |
| TikTok accounts | records the handles you entered; the Android routine verifies sign-in at run time |

There is no WebDriverAgent, no Xcode signing, no Developer Mode build and no coordinate profile on
this path, so those checks are not shown and no host ports are reserved.

## Choosing a driver

The **Android driver** picker chooses how the phone is controlled. It is one field in `devices.json`
and can be changed later without re-registering.

- **`adb`** — `adb shell input` / `screencap` / `uiautomator dump`. Nothing is installed on the phone;
  the wizard passes the driver check immediately.
- **`a11y-bridge`** — the sim-use bridge APK: an `AccessibilityService` plus a local HTTP server, so
  nothing is attached while a routine runs. The driver check then verifies, in order:
  1. `adb shell pm list packages com.linecorp.simuse.devicebridge` — the APK is installed;
  2. `adb shell settings get secure enabled_accessibility_services` — the service is enabled;
  3. `adb shell content query --uri content://com.linecorp.simuse.devicebridge/auth_token` — the
     bearer token is readable;
  4. `GET <bridgeUrl>/ping` answers.

  Press **Set up the driver** to read the token and run `adb forward tcp:18300 tcp:8080` (the APK listens on 8080). With the
  Wi-Fi build of the APK, put `http://<phone-ip>:8080` in the **Bridge URL** field instead and the
  port forward is skipped. Bootstrap steps for the APK itself are in
  [../src/drivers/README.md](../src/drivers/README.md).

## What finishing writes

**Finish registration** writes an explicit whitelist into `devices.json` and returns immediately —
there is no WDA service to hand ownership to:

```json
{
  "name": "pixel-03",
  "udid": "R58N12ABCDE",
  "platform": "android",
  "driver": "a11y-bridge",
  "android": {
    "serial": "R58N12ABCDE",
    "bridgeUrl": "http://127.0.0.1:18300",
    "bridgeToken": "<read during setup>"
  },
  "pluginData": { "com.git-agni.tiktok": { "accounts": [] } }
}
```

## The device page afterwards

The devices grid and the device page carry **platform** and **driver** badges, and status lines read
`Android 14` rather than `iOS 16.7`. For an Android device the dashboard talks to the device's driver
instead of WebDriverAgent: the summary reads the screen size with `driver.screen()`, the still preview
and `/api/devices/:udid/remote/screenshot` come from `driver.screenshot()`, and
`/api/devices/:udid/remote/action` maps tap, swipe, home, back and text onto `tap` / `swipe` /
`pressKey` / `type`. Lock, wake, unlock and the volume keys are WebDriverAgent verbs with no adb
equivalent: those buttons are hidden on Android and the endpoint answers `400`.

The connection endpoint reports adb visibility (or the bridge ping) and never probes a WDA port.
