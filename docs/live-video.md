# Live video on the wall

The Control Center used to show Android phones as a slideshow: one screenshot at a time, four a
second at the very best, each one a full PNG over the wire. This is what replaced it — real video,
about ten frames a second on a tile and twenty-four in the viewer, at a fraction of the bytes.

Nothing is required for the farm to keep working. Without scrcpy installed, every surface says
"stills only" and polls screenshots exactly as before.

## What you install

```
brew install scrcpy
```

That is the whole setup. Backline never runs the `scrcpy` desktop app; it only wants the small
server jar Homebrew installs alongside it, at `$(brew --prefix)/share/scrcpy/scrcpy-server`, and
the version number `scrcpy --version` prints. Set `SCRCPY_SERVER` if your jar lives somewhere
else, and `SCRCPY_VERSION` if `scrcpy` itself is not on the `PATH`.

The Rig page's **Android bridge** row says which of the two worlds you are in: "live video:
scrcpy 3.1", or "stills only: install scrcpy (brew install scrcpy)". So does the line under the
wall inspector's screen.

## How a phone starts streaming

The first time somebody watches a phone, the farm:

1. pushes the jar to `/data/local/tmp/scrcpy-server.jar` with `adb push`,
2. opens a tunnel with `adb forward tcp:0 localabstract:scrcpy_<id>`,
3. starts the server with `adb shell CLASSPATH=… app_process / com.genymobile.scrcpy.Server <version> …`,
   video only — no audio, no control channel; remote taps keep going through adb as they always did,
4. connects to the forwarded port and reads the stream.

The stream itself is small and rigid: one dummy byte, a 64-byte device name, a twelve-byte codec
header (codec id, width, height), then one H.264 access unit after another, each behind a
twelve-byte header of presentation timestamp, two flags and a length. `src/live/scrcpy.ts` parses
exactly that, and nothing else.

When the last watcher goes away the stream stays up for a few seconds — a tile scrolled past and
back should not restart an encoder — and then everything above is undone in reverse, including the
adb forward.

## Who is watching what

`src/live/sessions.ts` is the bookkeeping: one stream per phone however many people are watching
it, at most `LIVE_MAX_STREAMS` (12) phones at once, encoded for the most demanding watcher. A tile
on the wall asks for 400 pixels at 10 fps; the inspector and the device page ask for 720 at 24. If
a viewer opens on a phone that a tile is already streaming, the stream restarts at the larger size,
and shrinks back when the viewer closes.

There is no "please send a keyframe" message in scrcpy's protocol, so when a browser cannot decode
what it is being sent, the farm restarts that phone's stream — a stream always begins with one.

## Over the wire

`GET /api/devices/:udid/live` is a WebSocket, authenticated by the same bearer token or session
cookie as every other route. It opens with a JSON `config` message — codec, size, and the SPS/PPS
in base64 — and then sends one binary message per frame: a flags byte (keyframe, codec config),
three reserved bytes, a four-byte millisecond timestamp, then the access unit in Annex B framing.

The browser can send `{"type":"keyframe"}` and nothing else.

A slow browser is never allowed to become a queue in the farm. Each socket has a budget of unsent
bytes; picture frames are dropped as soon as it is over, keyframes get four times the room because
without one the decoder cannot start again, and past that they go too.

`GET /api/live/status` answers whether any of this is available, which is what the wall asks once
before it opens a dozen sockets.

## In the browser

`static/dashboard/ts/live.ts` opens the socket, feeds the frames to a `VideoDecoder` (WebCodecs)
and paints each picture onto a `<canvas>` over the tile's still image. The still image stays
visible until the first picture is actually decoded, so nothing ever blinks.

It gives up, quietly and for good, and lets the old screenshot pump take over when:

- the browser has no `VideoDecoder`,
- the farm answered "not available",
- the socket has failed twice,
- or the phone is an iPhone.

The wall's old **Refresh** slider is now a **Quality** slider with three notches — Off, Stills,
Live — remembered per browser exactly as the old one was. Only tiles actually on screen subscribe,
and a hidden tab drops every subscription it has.

The decisions above live in `static/dashboard/ts/live-modes.ts`, apart from the DOM, which is why
they are tested.

## Why iPhones stay on MJPEG

An iPhone's screen already arrives as a video stream: WebDriverAgent's MJPEG server is running for
every registered iPhone, the browser paints it with a plain `<img src>`, and it costs the farm one
proxied connection. scrcpy is an Android thing — there is no equivalent to push onto an iPhone, and
nothing on the device side that would answer. So iPhones keep the stream they have, and the wall's
Live notch simply means "stills" for them.

## Tapping on a moving picture

A tap on the viewer is mapped through the size the *stream* reports, not the size of the last
screenshot. They differ the moment a phone is turned on its side: the stream says 800×360 while the
cached screen size still says 1080×2400, and a tap mapped through the wrong one lands in the wrong
corner.
