# ADR 0001: Multi-platform device drivers behind one interface

Status: Proposed
Date: 2026-09-05

## Context

We are building a self-hosted phone farm for scheduled TikTok posting, replacing a $599/yr
subscription to Ghost Farm. Reading Ghost Farm's own site, the product is four things: a browser
console, a scheduler that fires each phone at a random time inside a daily window, a queue of
videos/slideshows with captions, and a pre-recorded "runbook" of taps and swipes replayed on the
device with per-step confirmation, retry and logging. Its differentiator ("no ADB, no simctl,
nothing attached while it runs") is a signed on-device companion app that synthesizes input
locally, which on stock iOS can only be XCUITest / WebDriverAgent.

The fleet is 2 iPhones and roughly 10 Android phones, all run from a single Mac. The Android
side therefore matters more than the iOS side, and this repository (forked from
`Git-Agni/prod-FARM-IOS-Core`) is iOS-only today:

- `src/devices/discovery.ts` enumerates devices through `appium-ios-device`.
- `src/scheduler/executor.ts` builds a `DeviceAutomation` directly from `WdaRemoteControl` and
  injects `WDA_URL` / `IOS_UDID` into the plugin child process.
- `src/tiktok/post.ts` drives the phone through Appium's XCUITest driver via `webdriverio`, with
  OCR (`src/tiktok/ocr.ts`, `node-native-ocr`) for confirmation.

We evaluated five open-source projects for parts:

| Project | What it is | What we take |
|---|---|---|
| `Git-Agni/prod-FARM-IOS-Core` (Apache-2.0) | The only real farm: Postgres scheduler, worker, run log, dashboard, plugin contract, TikTok routine over WDA | The spine. Everything else becomes a driver or helper beneath it. |
| `pranshuchittora/simvyn` (MIT) | TS/Fastify/React mobile devtool; modular; `adb` and `devicectl` wrappers; Linux support for Android | Its `adb` device discovery and command patterns (`packages/core/src/adapters/android.ts`), and its per-feature module shape. |
| `lycorp-jp/sim-use` (Apache-2.0) | Swift CLI for agents; ships a Kotlin **bridge APK** exposing `AccessibilityService` over HTTP; compact a11y tree with element aliases | The bridge APK (`bridge/`) as our Android "companion app", and the observe → act → verify loop with tree-based targeting instead of raw coordinates. |
| `ShawnPana/phone-harness` (MIT) | Python; iPhone via macOS iPhone Mirroring + Vision OCR + HID; Android via adb | OCR-as-fallback verification (the fork already has this on iOS); the mirroring driver stays an experiment. |
| `Katzca/AutoSocial` (MIT) | Node/Playwright browser poster for TikTok/IG/YouTube; FFmpeg/yt-dlp pipeline | Content pipeline ideas and a future "browser target" plugin. Not part of the device layer. |

One finding that shaped the design: sim-use's bridge binds its HTTP server to `127.0.0.1` and
is reached through `adb forward`, and its bearer token is minted via an adb-shell-gated
ContentProvider. Out of the box it still needs ADB attached at runtime. To get the Ghost-Farm
property on Android we will carry a small fork of the APK that also listens on the Wi-Fi
interface, keeps the bearer token, and is bootstrapped once over USB. The driver below is written
so both modes work unchanged (it only needs a base URL and a token).

## Decision

1. **Introduce `src/drivers/`, a `DeviceDriver` interface with one implementation per control
   channel.** Each implementation is a factory returning an object of small single-purpose async
   functions; no class hierarchies, no shared base class.

   | Driver | Platform | Channel | Runtime attachment |
   |---|---|---|---|
   | `wda` | iOS | WebDriverAgent HTTP (existing `WdaRemoteControl`) | none (Wi-Fi) |
   | `adb` | Android | `adb shell input/screencap/uiautomator` | USB or wireless debugging |
   | `a11y-bridge` | Android | sim-use bridge APK over HTTP | `adb forward` today; Wi-Fi with our APK fork |

   The interface surface is deliberately small: `launchApp`, `terminateApp`, `tap`, `swipe`,
   `type`, `pressKey`, `screenshot`, `uiTree`, `screen`, `pushMedia`, `pause`. Everything a
   TikTok routine needs is expressible in those verbs; anything platform-specific lives inside
   a driver, not in the routine.

2. **The device record gains `platform`, `driver` and `android` fields** (all optional so
   existing `devices.json` files keep loading). iOS devices default to `platform: 'ios'`,
   `driver: 'wda'`. `src/drivers/select.ts` maps a registered device to a driver factory; the
   executor will call that instead of constructing `WdaRemoteControl` inline.

3. **Verification goes through `src/drivers/verify.ts`**, which tries the accessibility tree
   first (`findByText`, `findById`, `waitForText`) and falls back to OCR via an injected
   `recognize` function so the driver layer never imports `node-native-ocr` itself. Routines
   should prefer `tapText('Post')` over `tap(x, y)` because tree-based targeting survives UI
   updates that break coordinate packs.

4. **Media transfer is a driver concern.** `pushMedia` on Android does `adb push` into
   `DCIM/Camera` and broadcasts a media-scanner intent so TikTok's picker sees the file. On
   iOS this fork's patched WebDriverAgent exposes `/wda/import-media`, which writes straight
   into the Photos library, so the `wda` driver posts the file there (as `tiktok/post.ts`
   already does) and nothing else needs to be attached.

5. **Both Android drivers are set up from day one.** `adb` is the fast path (ships in
   configuration + a new gesture pack); `a11y-bridge` is the quiet path. Because they sit
   behind the same interface, an account can be switched between them with a one-field change
   in `devices.json`, and routines do not know which one is underneath.

6. **Everything runs from the one Mac.** Android phones connect to the same host over a
   powered USB hub for bootstrap, then over wireless debugging or the bridge on Wi-Fi at
   runtime. simvyn's Linux support is noted as an option for later, not adopted now.

## Consequences

- The scheduler, queue, run log, retry policy and dashboard are untouched; they already model
  devices by UDID and tasks by plugin/type/version, and an Android serial is just another UDID.
- `discovery.ts` needs an Android branch (`adb devices -l`), and the registration UI needs a
  platform picker. Both are follow-ups, tracked separately from this ADR.
- The TikTok plugin needs an Android routine: different upload flow, resource IDs and layout.
  Tree-based targeting reduces, but does not remove, the per-platform maintenance when TikTok
  ships UI changes.
- `adb`-driven devices expose `Settings.Global.adb_enabled` and developer options to apps;
  the `a11y-bridge` path exposes an enabled accessibility service instead. Neither is invisible,
  the second is quieter. The design lets us measure rather than guess.
- We take on maintaining a small fork of the sim-use bridge APK (Wi-Fi bind + keep-alive). It is
  Kotlin; the change is a few lines in `HttpServer.start`.
- Licences involved are Apache-2.0 and MIT only. Attributions go in `NOTICE`.

## Alternatives considered

- **Appium UiAutomator2 for Android instead of raw `adb`.** Rejected for now: it adds a
  server, a driver install and a session lifecycle for verbs `adb shell input` already covers,
  and the iOS side of this fork already bypasses Appium for actions (see `wda-remote.ts`).
  Revisit if we need reliable text entry into fields `input text` cannot reach.
- **iPhone Mirroring + HID (phone-harness) as the iOS driver.** Zero install on the phone, but
  one mirrored phone per Mac, pauses on screen lock, OCR-only targeting. Kept as an experiment
  behind the same interface, not the default.
- **Browser posting (AutoSocial) for everything.** Simplest to run, but it is exactly the kind
  of signal real hardware is meant to avoid, and TikTok's web upload is a different surface
  from the app. Reserved for platforms where phone automation is not worth it.
