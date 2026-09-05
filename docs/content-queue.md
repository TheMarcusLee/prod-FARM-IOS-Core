# Content library and drip queue

The `/content` page turns a folder of raw clips into a queue of scheduled TikTok
posts. It does three things:

1. **Ingest and normalise** — every upload is probed, and video is transcoded to
   a TikTok-safe copy (9:16, H.264 + AAC, ≤ 1080×1920, ≤ 180 s, metadata
   stripped, `faststart`). The original is kept untouched.
2. **Organise** — items carry tags, a title/caption seed and hashtags. Sets group
   items; caption templates render the text each post uses.
3. **Drip** — a rule says "two posts a day for `@handle` on this phone, between
   09:00 and 21:00 local, at least two hours apart, from the `fitness` tag". A
   planner turns that into ordinary one-off schedules through the existing
   scheduler, so everything the Tasks page can do to a schedule still works.

## Requirements

FFmpeg. `ffmpeg` and `ffprobe` are used from `PATH` when present; otherwise the
bundled `ffmpeg-static` / `ffprobe-static` binaries are used. Point at specific
binaries with `FFMPEG_PATH` and `FFPROBE_PATH`. Ingest fails with a clear message
when neither is available — nothing else in the app is affected.

`yt-dlp` is optional. `POST /api/content/ingest-url` answers `501` with an
explanation when it is not on `PATH` (or at `YT_DLP_PATH`).

Every external tool is executed with `execFile` and an argument array. No path,
filename or URL is ever passed through a shell.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTENT_DIR` | `$SCHEDULER_DATA_DIR/content` | Originals, normalised copies, posters, and per-post links. |
| `DRIP_PLANNER_INTERVAL_MINUTES` | `60` | How often the web process plans. `0` disables the tick; `POST /api/drip/plan` still works. |
| `CONTENT_CONCURRENCY` | `2` | Concurrent FFmpeg jobs. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | — | Explicit binaries instead of `PATH`. |
| `YT_DLP_PATH` | — | Explicit `yt-dlp` binary. |

Keep `CONTENT_DIR` inside `SCHEDULER_DATA_DIR` unless you have a reason not to:
the scheduler's own asset purge only reaches paths under the data root.

## How ingest works

`POST /api/content/items` (multipart, field `media`) or
`POST /api/content/ingest { directory }` writes the source into
`CONTENT_DIR/originals`, registers it as an asset, and creates a
`content_items` row with status `processing`. The FFmpeg work then runs
in-process behind a two-slot limiter:

- **video** → `CONTENT_DIR/normalized/<uuid>.mp4`, registered as a second asset;
  the item points at that copy while `original_asset_id` keeps the source.
  9:16 is reached by padding; pass `crop: true` to fill and lose the edges.
- **image** → used as-is.
- both get a poster frame in `CONTENT_DIR/posters/<item id>.jpg`, served from
  `GET /api/content/items/:id/poster`.

The row ends at `ready`, or at `failed` with the FFmpeg message in `error`.

## Caption templates

Deliberately tiny, and fully covered by tests:

```
{title} {random:🔥|✨|💪} {hashtags}
```

`{title}`, `{hashtags}`, `{account}` and `{date}` substitute; `{random:a|b|c}`
picks one branch. An unknown `{token}` is left in place so a typo is visible
rather than silently blank. `POST /api/content/templates/preview` renders one
without saving it.

## The drip planner

Every tick (and on `POST /api/drip/plan`), for each enabled rule and for today
and tomorrow **in the rule's own timezone**:

- skip the date if `drip_plans` already has rows for it — a re-run plans nothing
  twice, so the hourly tick and a manual run converge;
- pick `posts_per_day` items that have not been used within `avoid_reuse_days`,
  ordered `random` or `fifo` (never-used first, then least recently used);
- choose random times inside the window, at least `min_gap_minutes` apart, never
  in the past — times are drawn, sorted, and spread across whatever slack the
  window has left once every mandatory gap is reserved, so a tight window plans
  fewer posts rather than illegal ones;
- render the caption and create a `once` schedule via the normal
  `repository.createTask` with the TikTok `post` payload;
- record each `(rule, date, schedule, item)` in `drip_plans`.

A set of one to three images is planned as a single slideshow post; a larger set
is a pool of individual posts.

Disabling a rule cancels the schedules it planned that have not started yet.

`used_count` and `last_used_at` are only credited once an execution actually
**succeeded** — the planner polls the executions table rather than hooking the
worker.

### Notes on the post payload

- The timing is always `once`, so `recurringPublishConfirmed` is never needed:
  the plugin only demands it for `daily`/`weekly` publish schedules.
- The scheduler deletes a one-off schedule's assets when it succeeds. A planned
  post therefore gets its **own** assets row backed by a hard link to the same
  bytes; the purge unlinks that copy and the library master survives. For the
  same reason the orphan-asset sweep skips assets a `content_items` row
  references.
- Rules validate the device and account at plan time: an unregistered or
  disabled device is reported in the run's `skipped` list, not scheduled.

## API

| Route | Purpose |
| --- | --- |
| `GET /content` | The dashboard page. |
| `GET/POST /api/content/items` | List, or upload multipart media. |
| `PATCH/DELETE /api/content/items/:id` | Edit tags/caption/hashtags/status, or delete with its files. |
| `GET /api/content/items/:id/poster` | Poster frame. |
| `POST /api/content/ingest` | `{ directory, tags?, crop? }`. |
| `POST /api/content/ingest-url` | `{ url, tags?, crop? }` — needs `yt-dlp`. |
| `GET/POST /api/content/sets`, `DELETE /api/content/sets/:id`, `PUT /api/content/sets/:id/items` | Sets and membership. |
| `GET/POST /api/content/templates`, `DELETE …/:id`, `POST …/preview` | Caption templates. |
| `GET/POST /api/drip/rules`, `PATCH/DELETE /api/drip/rules/:id` | Drip rules. |
| `GET /api/drip/plans`, `POST /api/drip/plan` | What is planned, and plan now. |

Every request body is read through an explicit whitelist; anything not named is
dropped rather than persisted.

## Tables

`content_items`, `content_sets`, `content_set_items`, `caption_templates`,
`drip_rules`, `drip_plans` — all in the `scheduler` Postgres schema, defined in
`src/database/schema-content.ts` and created by `drizzle/0002_content.sql`.
