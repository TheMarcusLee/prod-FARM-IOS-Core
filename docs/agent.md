# The calibration agent

Backline's Android routines drive TikTok, Instagram, YouTube and Threads by looking for named
controls in the accessibility tree. Each control is a *list of alternates* — a `resource-id`
fragment, some visible text — tried in order, because these apps relabel and re-id things between
builds, regions and A/B buckets. Most of those lists were written without a phone in hand and are
marked `GUESS` in the routine's table.

The only way to fix a guess is to look at a real phone. This is the thing that does the looking:
a cheap agent (Gemini Flash, through Google's Antigravity CLI) that walks a flow on one device and
writes down what actually matched.

## What it can and cannot do

The agent reaches the farm through Backline's own MCP server and nothing else. Its whole world is:

| Tool | What it does |
| --- | --- |
| `read_screen` | The accessibility tree, flattened, plus a screenshot |
| `find_on_screen` | Nodes matching a string, and where a tap on each would land |
| `tap`, `swipe`, `press_key`, `type_text`, `launch_app` | One input each |
| `list_selectors`, `list_unverified_selectors` | What the routine looks for, and what is still a guess |
| `record_selector`, `forget_selector`, `list_selector_overrides` | Write down (or withdraw) a confirmed selector |

There is no shell, no filesystem, no network. It cannot schedule a task, upload media, or change a
device's settings. The input tools are rate-limited per device at the same ceiling as the
dashboard's remote control (`RATE_LIMIT_ACTION`, ten per second), because a retry loop hammering
tap is a real way to wedge a driver session.

The prompt tells it, in as many words, to take the draft path and never press Post, Share or
Upload; to never like, follow or comment on anyone's content; and to record a selector only when
it watched that selector match. It is still an agent on a phone that is signed in to a real
account — run it on a device you are willing to have poked at, and read the execution log.

## Installing the CLI

```
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Then run `agy` once and sign in with a Google account that has an AI Pro or Ultra subscription.
Backline never sees that credential: the CLI keeps it in the OS keyring, and Backline only spawns
the binary. `GEMINI_API_KEY` and `GOOGLE_API_KEY` are stripped from the child environment on
purpose, so a stray variable cannot quietly move the work onto metered billing.

If `agy` is not on the path, the calibrate task fails immediately with the install command rather
than tying up a phone.

## Running a calibration

Three ways in, all of which book the same task:

- **A device page → Selectors.** Every Android routine that applies to the phone, with each
  control's alternates and whether anybody has confirmed it. "Calibrate with agent" per routine.
- **A failure card.** When a run dies because a control was not on screen, the alert carries the
  plugin, the flow, the phone, the selector name and the screenshot taken at that moment, and
  offers "Ask the agent to calibrate".
- **The API.** `POST /api/agent/calibrate` with `{ udid, plugin, flow }`, `flow` being `post` or
  `warmup`. Or `create_schedule` over MCP with the `com.backline.agent` / `calibrate` task.

The payload is `{ plugin, flow, udid, model?, maxMinutes? }`. `model` defaults to
`gemini-3.8-flash-medium` and `maxMinutes` to 20.

The run itself:

1. Reads the selector table for that flow and the override store, and takes the intersection —
   the selectors still marked `GUESS` with nothing confirmed. If there are none, it says so.
2. Builds a prompt from the flow's description, the selector section of the flow's doc page, that
   list, and the tool notes above. The prompt is written to the execution's workspace as
   `prompt.md`, next to the `mcp-servers.json` it was pointed at.
3. Registers Backline's stdio MCP server with the CLI and runs `agy` headlessly, streaming every
   frame of its output into the execution log.
4. Reads the override store again. **What the agent achieved is measured, not reported**: the
   difference between the two reads is the result, whatever the agent said about itself.

A pass that leaves selectors unverified finishes the execution with an error, which is how
Backline raises an alert — with the log and the device already attached. A pass that confirms
everything it was asked about succeeds. The task never retries: whatever stopped the agent (no
CLI, a locked phone, a screen it could not read) is still true a minute later.

## Where confirmed selectors live

`<SCHEDULER_DATA_DIR>/selector-overrides.json` — one JSON array, next to `devices.json` and the
rest of the scheduler's state. No database: a routine runs as a short-lived child process with no
connection to one.

```json
[
  {
    "plugin": "com.git-agni.tiktok",
    "udid": "R58N12ABCDE",
    "name": "captionField",
    "entry": { "id": "caption_edit_view" },
    "note": "TikTok 39.4.4, en-GB",
    "confirmedBy": "agent",
    "confirmedAt": "2026-09-07T11:04:12.881Z"
  }
]
```

One row per `(plugin, udid, name)`. A `udid` of `*` means the whole fleet, and a row for a
specific phone beats it. The routines put the confirmed entry **in front of** their built-in
alternates rather than replacing them, so an override that has itself gone stale still falls
through to the guesses instead of failing the run.

Nothing about this file is required. Delete it and every routine is back to its shipped table.

## Correcting the routine itself

An override is data; the table in the routine is the shipped default. When a confirmed selector
has held on several phones and several builds, move it into the routine's table (and drop the
`GUESS` marker from its comment) and withdraw the override with `forget_selector`. The dashboard's
Selectors block is the list of what is worth promoting.
