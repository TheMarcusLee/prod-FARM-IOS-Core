# Runbooks — record once, replay on the fleet

A **runbook** is a recorded sequence of taps, swipes and typing on one phone that replays on any
registered device, with per-step verification, waits and retries. It is scheduled like any other
task, through the same scheduler, on the same device queues.

Where the commercial farms replay pixels, this one replays **intent**: every recorded tap keeps the
accessibility identity of the control it hit, and replay looks that control up again on the target
device. The recorded screen position is only the last resort.

## Concepts

A runbook is a JSON document under `SCHEDULER_DATA_DIR/runbooks/<id>.json` — no database, no
migration. Copy one between farms with `scp`.

```jsonc
{
  "id": "rb-8fj2k1a9x0z1",
  "name": "Warm up feed",
  "description": "Open the app and scroll a little",
  "platform": "android",          // "ios" | "android" | "any"
  "appId": "com.zhiliaoapp.musically",
  "createdFor": { "udid": "R58N12ABCDE", "screen": { "width": 1080, "height": 2400, "scale": 1 } },
  "version": 1,
  "steps": [ /* … */ ]
}
```

### Steps

| Step | Fields | Notes |
| --- | --- | --- |
| `launchApp` | `appId` | Bundle id on iOS, package name on Android |
| `tap` | `target` | See *Targets* below |
| `swipe` | `from`, `to`, `durationMs` | Points are fractions (0–1) of the screen |
| `type` | `text` | Supports `{{variable}}` placeholders |
| `key` | `key` | `home`, `back`, `enter`, `delete` |
| `wait` | `ms` | Plain sleep; aborts promptly when the execution is stopped |
| `waitForText` | `text` or `id`, `timeoutMs` | Polls the accessibility tree |
| `assert` | `text` or `id`, `expect: present\|absent` | Fails the run when the screen disagrees |
| `screenshot` | `label` | Captured into the execution log |

Every step also takes `retries` (0–10), `retryDelayMs`, and `optional`. An **optional** step that
keeps failing is logged and skipped instead of failing the run — the right setting for cookie
banners, "rate this app" prompts and other things that only sometimes appear.

### Targets

A tap target is `{ id?, text?, description?, fraction: { x, y } }`, resolved **in this order**:

1. `id` — the Android `resource-id` / iOS accessibility identifier, looked up in the tree.
2. `text` then `description` — visible label or content-desc, looked up in the tree.
3. OCR, when a recognizer is available, for screens that draw their own controls.
4. `fraction` — the recorded position, scaled to the target device's screen.

The tap lands on the nearest *clickable* ancestor of the match, not on the label inside it.

## Recording

1. Create a runbook on **/runbooks** (name, platform, app id, and the device you will record on).
2. Open that device's page. In the **Runbooks** panel pick the runbook and press
   **Start recording**.
3. Drive the phone with the normal remote control — click to tap, drag to swipe, type into the
   text box. Each action appears in the panel's step list as it is recorded.
4. Press **Stop recording**, then open the runbook to tidy the steps: add `waitForText` where the
   app is slow, mark flaky steps `optional`, add retries.

While recording, the server enriches every action with the accessibility tree it captured
**before** that action landed, which is what lets it name the control you tapped. An empty runbook
adopts the recording phone's udid, screen and platform.

### Recording tips

- **Record on the smallest screen you own.** Fractions scale up more forgivingly than down, and a
  control that fits a small screen is on every larger one.
- **Prefer taps on labelled controls.** A button with a `resource-id` or a visible label replays
  everywhere; a tap on a blank area of a custom canvas only replays on that screen ratio.
- **Insert `waitForText` instead of `wait`** wherever you are waiting for the app rather than for
  an animation. It is faster on a fast phone and safer on a slow one.
- **End with an `assert`.** A run that "succeeded" without reaching the screen you wanted is worse
  than a failure.
- Recording captures input only. Lock, wake, unlock and the volume keys are device-state actions
  and are refused as steps.

## Variables

Any `type` step may contain `{{name}}` placeholders. Supply the values when the task is created:

```jsonc
{ "pluginId": "com.farm.runbook", "taskType": "run", "taskVersion": 1,
  "payload": { "runbookId": "rb-8fj2k1a9x0z1", "vars": { "caption": "hello from the farm" } } }
```

The **Run** form on a runbook's page renders one input per variable it finds. A run whose variables
are not all supplied fails immediately with the names it is missing — it never substitutes an empty
string.

## Scheduling a run

The plugin registers `com.farm.runbook / run @ 1`. Create it like any task
(`POST /api/schedules`), or press **Run** on the /runbooks page for an immediate run on a device.
The task validates that the runbook exists and that the variables are well-formed; the
**platform** check happens at execute time, because the validation context has no device, and a
mismatch fails the execution with a message naming both platforms.

Stopping an execution stops the replay between steps (and interrupts a `wait`), and the execution
is reported as stopped rather than failed.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/runbooks` | List |
| `POST` | `/api/runbooks` | Create `{ name, description?, platform?, appId?, udid? }` |
| `GET` | `/api/runbooks/:id` | Detail |
| `PUT` | `/api/runbooks/:id` | Full replace, fully validated |
| `DELETE` | `/api/runbooks/:id` | Delete (refused while recording) |
| `POST` | `/api/runbooks/:id/duplicate` | Copy, for a variant flow |
| `POST` | `/api/runbooks/:id/record/start` | `{ udid }` |
| `POST` | `/api/runbooks/:id/record/stop` | — |
| `POST` | `/api/runbooks/:id/steps` | `{ action }` — called by the device page while recording |
| `GET` | `/api/devices/:udid/runbook-recording` | Whether this device is recording |

## Limits

- **The OCR fallback needs the native OCR binding.** Without `node-native-ocr` working on the host,
  a text target that the accessibility tree cannot see falls straight through to the fraction.
- **The fraction fallback is approximate across screen ratios.** A tap recorded at (0.5, 0.82) on a
  20:9 phone is not the same control on a 16:9 tablet. Targets with an id or a label are the ones
  that travel; check any fraction-only step when you add a new phone model.
- **Recording is in-process.** Restarting `web` ends any open recording; the steps already recorded
  are on disk.
- Steps are appended in the order the browser's requests arrive. Very fast taps (faster than the
  round trip) can in principle land out of order — record at a human pace.
- A runbook holds at most 200 steps. Long flows read better, and fail more usefully, as several
  runbooks scheduled in sequence.
- Runbooks are not sandboxed from each other: anyone who can reach the dashboard can record, edit
  and run them on any registered device.
