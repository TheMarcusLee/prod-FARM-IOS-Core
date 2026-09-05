# MCP server

The farm exposes its own tools over the [Model Context Protocol](https://modelcontextprotocol.io)
so an agent can list phones, take screenshots, schedule TikTok posts, and follow
executions without going through the dashboard.

The tools call the same in-process TypeScript functions the dashboard routes
call — `SchedulerRepository`, the device registry, discovery, the WDA remote —
so there is no second copy of the business rules and no HTTP hop back into the
server.

Two transports, one tool set (`src/mcp/server.ts`):

| Transport | Entry point | Auth |
|---|---|---|
| stdio | `npm run mcp` (`src/mcp/stdio.ts`) | none — the client owns the process |
| Streamable HTTP | `POST/GET/DELETE /mcp` on the `web` server | `Authorization: Bearer <token>` |

Both need PostgreSQL reachable (`DATABASE_URL`); the stdio server opens its own
scheduler runtime.

## stdio

Create the config once and point your client at it. Use absolute paths — the
client will not run in your shell's working directory.

Claude Code:

```sh
claude mcp add phone-farm \
  --env DATABASE_URL=postgresql://phone_farm:CHANGE_ME@127.0.0.1:5432/phone_farm \
  --env DEVICES_CONFIG_PATH=/Users/you/phone-farm/devices.json \
  --env SCHEDULER_DATA_DIR=/Users/you/phone-farm/.scheduler-data \
  -- npm --prefix /Users/you/phone-farm run --silent mcp
```

Claude Desktop — `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "phone-farm": {
      "command": "npm",
      "args": ["--prefix", "/Users/you/phone-farm", "run", "--silent", "mcp"],
      "env": {
        "DATABASE_URL": "postgresql://phone_farm:CHANGE_ME@127.0.0.1:5432/phone_farm",
        "DEVICES_CONFIG_PATH": "/Users/you/phone-farm/devices.json",
        "SCHEDULER_DATA_DIR": "/Users/you/phone-farm/.scheduler-data"
      }
    }
  }
}
```

`--silent` matters: stdout is the JSON-RPC channel, and npm's banner would
corrupt it.

The stdio server still needs `worker`, `wda-service`, and `appium` running to
execute anything it schedules — it only writes to the database.

## HTTP

`/mcp` is mounted by `src/api/routes/mcp.ts` whenever the `web` server runs. It
is **always** token-protected, even on a loopback bind with no auth provider,
because it is an agent endpoint and never a browser one — a session cookie will
not open it.

```sh
npm run token:create -- --name agent-1
```

```sh
claude mcp add --transport http phone-farm http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer pf_…"
```

A missing or unknown token gets `401` with `WWW-Authenticate: Bearer`. Sessions
are per-client: the first `initialize` allocates one, the `Mcp-Session-Id`
response header names it, and `DELETE /mcp` tears it down. Revoke a token and
its next request fails; see `docs/auth.md`.

## Tools

| Tool | Arguments | Notes |
|---|---|---|
| `list_devices` | — | Registered phones with `status` (`connected` / `offline` / `disabled`) |
| `get_device` | `udid` | One device, same shape |
| `discover_devices` | — | What the host can see over USB right now, registered or not |
| `screenshot` | `udid` | Returns PNG image content |
| `list_schedules` | `deviceUdid?`, `limit?` (≤200, default 50) | Newest first |
| `create_schedule` | `deviceUdid`, `task {pluginId, taskType, taskVersion, payload}`, `timing`, `runWindowMinutes?`, `assetIds?` | Any plugin task; the plugin validates the payload |
| `create_tiktok_post` | `deviceUdid`, `account`, `assetIds` (1–3), `caption?`, `musicUrl?`, `destination`, `timing`, `runWindowMinutes?` | Friendly wrapper over `create_schedule` |
| `create_doomscroll` | `deviceUdid`, `durationMinutes` (1–180), `personality` (`skimmer`\|`casual`\|`engaged`), `likeEnabled`, `saveEnabled`, `account?`, `timing`, `runWindowMinutes?` | |
| `set_schedule_status` | `id`, `status` (`active`\|`paused`\|`cancelled`) | Mirrors `POST /api/schedules/:id/status`; a completed or cancelled schedule can only be cancelled |
| `list_executions` | `deviceUdid?`, `limit?` (1–200, default 50) | |
| `get_execution` | `id` | Includes the durable `logs` |
| `stop_execution` | `id` | Cancels a queued run; asks a running one to stop if its task supports it |
| `retry_execution` | `id` | Failed or stopped runs only |
| `list_assets` | `limit?` (≤500, default 100) | Uploaded media, newest first |
| `upload_asset` | `name`, `mimeType`, and exactly one of `path` (inside an allowed directory — see below) or `base64` | Returns the asset id to pass to `create_tiktok_post` |
| `list_upload_dirs` | — | The directories `upload_asset`'s `path` may read from |
| `list_plugins` | — | Loaded plugins and their task types/versions |

`timing` is one of:

```jsonc
{ "kind": "now" }
{ "kind": "once",   "runAt": "2026-09-06T09:00:00Z" }
{ "kind": "daily",  "localTime": "09:00", "timezone": "Europe/London" }
{ "kind": "weekly", "localTime": "09:00", "timezone": "Europe/London", "weekdays": [1, 3, 5] }
```

Resource `farm://status` returns a JSON fleet summary (device, schedule, and
execution counts plus loaded plugins). Prompt `plan_posting_day` returns the
guidance an agent should follow before booking a day of activity.

## Publishing is not gated

`create_tiktok_post` with `destination: "publish"` posts to the live account.
There is no `confirm` argument and no second step — this is deliberate, so that
an agent can run a posting schedule unattended. Recurring publishes are
confirmed on the agent's behalf too (the dashboard asks a human for that
confirmation; the MCP path does not).

Consequences worth accepting before you hand out a token:

- a token is enough to post publicly from any registered account;
- an agent that misreads an instruction posts, it does not ask;
- use `destination: "draft"` for anything you want to review first.

Scope tokens by trust, revoke them freely, and keep an eye on the `apiToken`
lines in the `web` log.

## Upload directories

`upload_asset` can read a file from the farm host, which without a boundary
would mean "a token reads any file the `web` process can" — including
`devices.json`, which holds device passcodes, and `.auth.json`, which holds
every token digest. So `path` must resolve inside an allowlist:

| | |
|---|---|
| Default | the content directory (`CONTENT_DIR`, else `SCHEDULER_DATA_DIR/content`) and `SCHEDULER_DATA_DIR/inbox` |
| Override | `MCP_UPLOAD_DIRS`, comma- or colon-separated absolute paths |
| Tool | `list_upload_dirs` reports the live list |

Both the candidate and each allowed directory are resolved with `realpath`, so a
symlink planted inside an allowed directory cannot point out of it. A rejected
path is a tool error naming the allowed directories, not a silent failure.
`base64` uploads are unaffected — they carry their own bytes and read nothing.

## Security

- **Put the Mac behind Tailscale or a VPN before binding beyond loopback.** The
  default `WEB_HOST=127.0.0.1` is the safe configuration; a token on an
  internet-exposed port is one leak away from control of the fleet.
- Setting `PHONE_FARM_AUTH_PLUGIN=local` satisfies the startup rule in
  `src/security.ts` that a non-loopback bind requires an auth provider. That
  check is about having *an* authentication story, not about the network being
  safe — a private network is still the first control.
- Terminate TLS in front of `web` if it is reachable from anything but the host
  itself; the session cookie is only marked `Secure` over HTTPS.
- `upload_asset`'s `path` is restricted to an **allowlist** of directories, so a
  token is not filesystem read access to the operator's home directory. See
  below.
- The tokens for `/mcp` are the same ones `/api` accepts. There is no way to
  issue a read-only or MCP-only token today.

See `SECURITY.md` and `docs/auth.md`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` on every `/mcp` call | No `.auth.json`, or the token was revoked — `npm run token:create` |
| `400 No MCP session` | A non-`initialize` request without `Mcp-Session-Id`; reconnect |
| stdio client shows a parse error at startup | Something wrote to stdout — check for a missing `--silent` |
| `Asset … does not exist` | `create_tiktok_post` takes ids from `upload_asset` / `list_assets`, not file paths |
| `This device is disabled` | Re-enable the device in the dashboard first |
| Scheduling fails with "within N minutes of another schedule" | `SCHEDULER_MIN_TASK_GAP_MINUTES`; call `list_schedules` first |
