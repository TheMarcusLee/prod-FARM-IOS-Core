# Motion: making a phone move like a person

Every swipe the farm used to make was a straight line between two fixed points, lasting exactly
300 ms, after a pause of exactly 1.5 seconds. A thousand phones doing that are a thousand copies
of the same phone. This is the model that replaced it.

Everything lives in `src/motion`, is pure, and draws every random number from an injected
generator — never `Math.random`. One seed per run means a run can be replayed exactly for
debugging while still being different from every other run.

## A swipe

A person's thumb is hinged at the base, so the finger travels on an arc rather than a line, and
it accelerates, coasts, and eases off rather than moving at a constant speed. `thumbSwipe`
returns that as a list of `{x, y, t}` samples:

```
      ↑ end (0.42–0.60 of the screen away)
      |
   ╭──╯          right thumb: the path bows LEFT of the
   │             straight line, by 2–7% of its length
   │
   ╰─ ● start — jittered inside the thumb zone:
        lower third of the screen, biased to the
        thumb's own side of it

   time:  |·  ·   ·    ·     ·    ·   · ·|
          slow start   fast middle   ease-out
          (12–24 samples over 180–420 ms)
```

* **Start** — anywhere in the thumb zone (`y` between 0.62 and 0.90 of the height; `x` in the
  right-hand half for a right thumb, the left half for a left one). A swipe that would run off
  the glass slides its whole path back inside rather than being cut short.
* **Arc** — a quadratic Bézier whose control point sits off the midpoint, perpendicular to the
  travel, bowing left for a right thumb and right for a left one. The bow is 2–7% of the swipe's
  length, drawn per swipe. A sideways swipe bows downwards instead, towards the thumb's pivot.
* **Speed** — samples are spaced evenly in *time* and unevenly in *distance*, following a cubic
  ease whose two control values are drawn per swipe. That is what stops every flick from sharing
  one acceleration fingerprint. About one flick in eight ends with an **early lift**: the finger
  leaves the glass at 82–94% of the travel, which the phone still reads as a flick because what
  it measures is velocity.
* **Duration** — 180–420 ms for a feed swipe, then multiplied by the device's pace (slow 1.28,
  fast 0.78).
* **Repeats** — a `MotionSource` holds the generator between calls and will not hand out a path
  identical to the one before it.

## A tap and a pause

`humanTap` moves the point by up to 6 px in each axis and holds for 40–120 ms.

`pauseMs(kind, seed)` is log-normal: bounded below by reaction time, unbounded above by
attention, which is the shape human gaps actually have. Each kind — `betweenVideos`,
`beforeLike`, `afterLike`, `afterOpenApp`, `beforeSwipe`, `reaction` — has its own median and
spread, and a small chance (1–3%) of a **distracted** pause several times longer: the phone went
face-down for a moment. The distraction draw is taken whether or not it fires, so the generator
advances identically either way and a run stays reproducible.

## One seed per run

The executor derives a seed from the execution id (`seedForExecution`), logs it as the first line
of the run, hands it to the driver, and exports it to the plugin child process as `MOTION_SEED`.
The doomscroll routines print it again in their opening line:

```
Starting doomscroll: seed=2118743204 hand=right speed=normal profile=casual ...
```

Give a failed run's seed back to the routine and every arc and every pause repeats exactly.

Two other things vary per run: the **session length** is the requested minutes ±15%, and the
**start jitter** delays the run by 0–4 minutes (`RUN_START_JITTER_MINUTES`, either `4` or a
`1-6` range). The jitter is seeded from the execution id, and capped at half the time left in the
run window so it can never eat the deadline it was supposed to start inside.

## Handedness, per device

A device may carry an optional `motion` block in `devices.json` (and through the API):

```json
{ "udid": "R58N12ABCDE", "motion": { "hand": "left", "speed": "fast" } }
```

With nothing set, both come from a stable hash of the udid: roughly one phone in ten is
left-handed, and pace splits about 25/50/25 slow/normal/fast. So a fleet is varied without being
configured, and each phone is the same person every time it runs.

## How a path reaches each phone

`DeviceDriver.gesture(path)` is the new primitive; `swipe()` now generates a path and delegates to
it, unless `straight: true` is passed — which runbook replay does, because a recorded drag along a
slider means the straight line it was drawn as.

| Driver | How | What survives |
| --- | --- | --- |
| `wda` (iOS) | W3C pointer actions: `pointerMove` per sample, each carrying the gap before it, through the fork's session-less `/wda/absolute-actions` | Arc and per-segment timing, exactly |
| `a11y-bridge` (Android) | `POST /gesture` with `points=[{x,y,t}]`; the bridge dispatches one `StrokeDescription` along an Android `Path` | Arc and total duration, exactly; see below |
| `adb` (Android) | One `adb shell` chaining `input motionevent DOWN/MOVE/…/UP`, with `sleep` where the phone would otherwise run ahead | Arc, and timing within a point budget |

Three honest limitations:

* **WDA** uses `/wda/absolute-actions` rather than `POST /session/:id/actions` because
  `WdaRemoteControl` deliberately holds no WebDriver session — the dashboard, the worker and the
  routines share one WebDriverAgent. Appium-driven routines that *do* own a session send the same
  action list through `performActions`. Both are the same W3C payload, built by `gestureActions`.
* **The bridge** flattens the velocity profile. `StrokeDescription` walks its path at a constant
  speed, so the shape and the total duration arrive intact but the fast middle does not.
  Preserving it would mean one continued stroke per segment, and `dispatchGesture` caps a gesture
  at ten strokes and requires a callback between continuations, which the fire-and-forget handler
  is not built for.
* **adb** pays a process start per `input motionevent` — roughly 25–60 ms on real hardware — so
  the number of points is a budget, not a wish: the driver measures what an event costs on this
  device and spends the gesture's duration on as many points as fit (never fewer than 3, never
  more than 24). The arc is faithful, the timing is approximate. On a build without
  `input motionevent` (pre-Android 8, or a trimmed OEM `input`), it falls back once and thereafter
  to a plain `input swipe` between the first and last point — a straight line, and there is no way
  around that through adb alone. Use the bridge driver on those phones.
