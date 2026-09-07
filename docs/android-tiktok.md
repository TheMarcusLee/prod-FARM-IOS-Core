# TikTok on Android

The TikTok plugin ships two routines per platform. iOS runs
`src/tiktok/post.ts` / `src/tiktok/doomscroll.ts` over WebDriverAgent; Android runs
`src/tiktok/android/post.ts` / `src/tiktok/android/doomscroll.ts` over the `DeviceDriver`
interface (`adb` or the accessibility bridge — see
[ADR 0001](adr/0001-multi-platform-device-drivers.md) and `src/drivers/README.md`).

The plugin picks the routine from the device's `platform`, so a task payload is identical on both
platforms and nothing above the plugin needs to know which phone it is going to.

## 1. Put the phone into debugging mode

1. Settings → About phone → tap **Build number** seven times to unlock Developer options.
2. Settings → System → Developer options → enable **USB debugging**.
3. Plug the phone into the Mac over USB and run `adb devices -l`. Accept the "Allow USB
   debugging?" prompt on the phone and tick "Always allow from this computer".

Wireless debugging (nothing attached at run time) needs the USB step once:

```sh
adb -s <serial> tcpip 5555
adb connect <phone-ip>:5555      # the serial becomes 192.168.1.40:5555
```

On Android 11+ you can skip `tcpip` and use Developer options → **Wireless debugging** →
*Pair device with pairing code*, then `adb pair <ip>:<pair-port>` and `adb connect <ip>:<port>`.
Either way the phone must keep the same IP; give it a DHCP reservation on the farm's router.

For the quiet path, install the accessibility bridge APK instead — the bootstrap steps are in
`src/drivers/README.md` ("Bootstrapping the bridge on a phone").

## 2. Register the phone

```sh
curl -X POST http://127.0.0.1:3000/api/devices \
  -H 'content-type: application/json' \
  -d '{
        "name": "pixel-03",
        "udid": "R58N12ABCDE",
        "platform": "android",
        "driver": "adb",
        "android": { "serial": "R58N12ABCDE" }
      }'
```

`udid` is the adb serial (`adb devices -l`); `android.serial` may be omitted when it equals the
udid. For the bridge, use `"driver": "a11y-bridge"` and add `android.bridgeUrl` and
`android.bridgeToken`. The token is a device credential: it is stored in `devices.json` (mode
0600, git-ignored), passed to routines as `A11Y_BRIDGE_TOKEN`, and never logged.

Register the TikTok handles the phone is allowed to post from:

```sh
curl -X PATCH http://127.0.0.1:3000/api/devices/R58N12ABCDE/accounts \
  -H 'content-type: application/json' -d '{"accounts": ["@farm.one", "@farm.two"]}'
```

## 3. What the routines expect on the phone

- **TikTok installed and already logged in**, with every account the schedule will use added to
  the in-app account switcher. The routines never type credentials.
- **Gallery permission granted once, by hand.** Open TikTok → **+** → **Upload** and accept the
  photos/media permission prompt. The routines do not answer system permission dialogs; a phone
  that has never been through the picker will stall on the first post.
- **Screen unlocked and staying awake.** There is no Android equivalent of the iOS passcode
  unlock in this layer yet: enable Developer options → **Stay awake** and remove the lock screen
  (or keep the phone unlocked on a charger).
- Anything that steals focus — an OS update banner, a TikTok "What's new" interstitial — will
  make a step fail with the list of texts that were on screen, which is the fastest way to see
  what appeared.
- Media is pushed with `adb push` into `/sdcard/DCIM/Camera` and a media-scanner broadcast, so the
  phone needs room for the clip. Files are pushed newest-last, which makes the first file in the
  post the first (newest) cell in the picker.

Run-time environment given to the child process (from `pluginEnvironment` in
`src/scheduler/executor.ts`): `DEVICE_UDID`, `DEVICE_PLATFORM=android`, `DEVICE_DRIVER`,
`ANDROID_SERIAL`, and for the bridge `A11Y_BRIDGE_URL` / `A11Y_BRIDGE_TOKEN`.
`src/tiktok/android/driver-from-env.ts` turns those back into a driver. The plugin also sets
`TIKTOK_PACKAGE` (default `com.zhiliaoapp.musically`), and the doomscroll routine reads the same
variables as its iOS twin: `DOOMSCROLL_DURATION_MINUTES`, `DOOMSCROLL_PERSONALITY`,
`DOOMSCROLL_LIKE_ENABLED`, `DOOMSCROLL_SAVE_ENABLED`, `TIKTOK_SWITCH_ACCOUNT`.

## 4. The selector table

Targeting is tree-first (`resource-id`, text, `content-desc`) with an OCR fallback for screens
TikTok draws without accessibility nodes — never recorded coordinates. Every control is a list of
alternates tried in order, kept in one table per routine:

- posting: `POST_SELECTORS` at the top of `src/tiktok/android/post.ts`
- doomscroll feed: `FEED_SELECTORS` at the top of `src/tiktok/android/doomscroll.ts`

| Control | Selectors tried, in order | Marked GUESS in source? |
|---|---|---|
| Profile tab | `#profile_tab`, "Profile", "Me" | unmarked |
| Account switcher | `#account_switch`, `#title_container`, `#tv_nickname`, "Switch account", "Switch accounts" | **GUESS** |
| Create (+) | `#create_tab`, `#iv_create`, "Create", "Add" | unmarked |
| Upload | `#upload`, `#tv_upload`, "Upload", "Gallery" | unmarked |
| Select multiple | `#multi_select`, "Select multiple", "Multiple" | **GUESS** — optional, skipped when absent |
| Picker Photos tab | `#tab_photo`, `#photo_tab`, `#tv_photo`, "Photos", "Photo", "Images" | **GUESS** — photo mode only, optional |
| Photo mode toggle | `#photo_mode`, `#btn_photo_mode`, "Switch to photo mode", "Photo mode", "Switch to photo" | **GUESS** — photo mode only, optional |
| Photo template chooser | `#btn_skip`, `#tv_skip`, "Skip", "Not now", "Use original", "No template" | **GUESS** — photo mode only, optional |
| Next (picker, then editor) | `#btn_next`, `#next`, "Next" | unmarked |
| Caption field | `#caption_edit_view`, `#et_caption`, `#edit_text`, "Add a caption", "Describe your video", "Add description" | unmarked |
| Post | `#btn_post`, `#publish_button`, "Post" | unmarked |
| Drafts | `#btn_draft`, `#draft_button`, "Drafts", "Save draft" | unmarked |
| Upload confirmation | "Your video is being uploaded", "being uploaded", "Posted", "Uploading", "Your post is being uploaded" | **GUESS** |
| Draft confirmation | "Saved to Drafts", "Draft saved", "Drafts" | **GUESS** |
| Gallery cell | `resource-id` ending `iv_image`, `iv_cover`, `image_view`, `album_image`, `cover`; or a `content-desc` containing video/photo/image | **GUESS** |
| Home tab | `#home_tab`, "Home", "For You" | unmarked |
| Like | `#ivm_like`, `#like_button`, "Like", "Liked" | **GUESS** |
| Save / Favourites | `#ivm_collect`, `#favorite_button`, "Add to Favorites", "Favorites", "Save" | **GUESS** |

**No row above has been confirmed against a real device.** The rows marked
**GUESS** carry that marker in the source too (`POST_SELECTORS` in
`src/tiktok/android/post.ts`, `FEED_SELECTORS` in `.../doomscroll.ts`); the rows
marked *unmarked* are the more conventional ids and labels, but they were also
written with no phone attached. TikTok's Android labels and resource-ids differ
by build, region and A/B bucket. Confirm them once against a real device and
correct the tables — the flow itself does not need to change.

The fastest way to read the real values:

```sh
adb -s <serial> shell uiautomator dump /dev/tty        # straight to your terminal
adb -s <serial> shell uiautomator dump /sdcard/dump.xml \
  && adb -s <serial> shell cat /sdcard/dump.xml         # if /dev/tty is refused
```

The full first-hardware-session procedure is
[device-testing-checklist.md](device-testing-checklist.md).

Each failure message already lists the alternates that were tried and the texts that were on
screen, so a wrong guess tells you what to put in its place.

## 5. Photo posts and slideshows

A manifest with `"format": "photo"` (one image) or `"format": "slideshow"` (2–35 images) drives
TikTok's photo composer instead of the video one. No `format` means `video`, so every manifest
written before photo mode existed still means exactly what it meant.

The flow is the video flow with three optional screens spliced in:

1. **Validate first.** `src/tiktok/post-format.ts` runs before anything is pushed or opened:
   mixed video + image manifests are refused, `photo` needs exactly one image, `slideshow` needs
   2 to 35, and every image must be `image/jpeg`, `image/png`, `image/webp` or `image/heic`. A bad
   manifest fails as a sentence rather than as a phone parked in a half-filled editor.
2. **Push.** Unchanged: files go to `/sdcard/DCIM/Camera` newest-last, so file 1 is the newest
   (first) picker cell. The picker is tapped in that order, and TikTok orders a slideshow by tap
   order — **manifest order is slide order**.
3. **Create → Upload**, then the picker's **Photos** tab if the build has one.
4. **Select multiple** when there is more than one image, then each cell in order.
5. **Next**, then the photo editor: a **"Switch to photo mode"** toggle and a **template chooser**
   both appear on some builds and neither on others.
6. Caption and **Post** / **Drafts** exactly as a video post — the publish screen is the same one.

Every step in 3, 5 is tolerant: a control that is not on screen is logged as
`Skipped <control>: not on screen` and the run carries on. That is deliberate — nobody has seen
these screens on a real phone yet, and a photo post that walks the video screens end to end is a
better failure mode than one that stops at a toggle that this build does not have.

`cover` is accepted and validated (an index into `files`) but is not driven yet: neither routine
picks a cover slide.

**What to confirm on a phone** (all three rows are **GUESS**): whether the picker has a
Photos/Images tab and what it is labelled; whether a set of stills opens in photo mode by itself
or needs the toggle, and what that toggle says; and whether a template chooser appears and what
its dismiss control is called. `adb shell uiautomator dump /dev/tty` on each screen, then correct
`POST_SELECTORS` and the table above.

## 6. Running one by hand

```sh
ANDROID_SERIAL=R58N12ABCDE DEVICE_PLATFORM=android DEVICE_DRIVER=adb \
  node --import tsx src/tiktok/android/post.ts /path/to/manifest.json

ANDROID_SERIAL=R58N12ABCDE DEVICE_DRIVER=adb DOOMSCROLL_DURATION_MINUTES=3 \
  DOOMSCROLL_PERSONALITY=casual DOOMSCROLL_LIKE_ENABLED=true DOOMSCROLL_SAVE_ENABLED=false \
  node --import tsx src/tiktok/android/doomscroll.ts
```

The manifest is the same shape the plugin writes (`src/tiktok/post-manifest.ts`): `device`,
`files`, `destination`, optional `account`, `caption`, `format` (`video` | `photo` | `slideshow`,
default `video`) and `cover`. `musicUrl` is iOS-only and is ignored with a log line on Android.

```jsonc
{
  "device": { "udid": "R58N12ABCDE", "name": "pixel-03", "platform": "android" },
  "format": "slideshow",
  "files": [
    { "path": "/tmp/1.jpg", "name": "1.jpg", "mimeType": "image/jpeg" },
    { "path": "/tmp/2.jpg", "name": "2.jpg", "mimeType": "image/jpeg" }
  ],
  "destination": "draft",
  "caption": "two of them"
}
```
