# Built-in local authentication

`PHONE_FARM_AUTH_PLUGIN=local` selects the provider in `src/auth/local.ts`. It is
built in — there is no package to install — and it satisfies the startup rule in
`src/security.ts`: `assertSafeBind()` refuses a non-loopback `WEB_HOST` unless an
auth provider is configured.

It gives you two ways in:

- a **password login** at `/login` for the browser, backed by a signed HttpOnly
  session cookie;
- **API tokens** as `Authorization: Bearer <token>` for agents, scripts, and the
  MCP server at `/mcp`.

## State file

Everything lives in one JSON file written `0600`:

| | |
|---|---|
| Path | `AUTH_STATE_PATH`, else `.auth.json` next to `devices.json` |
| Contents | scrypt password hash, the session-cookie HMAC secret, one sha256 digest per API token |
| Never contains | the password, or any token in plain text |

Add it to your backups the way you already do `devices.json`, and keep it out of
git — losing it logs everyone out and invalidates every token.

## Set it up

```sh
npm run auth:set-password            # prompts, echo off
npm run auth:set-password -- --password "$(openssl rand -base64 24)"
PHONE_FARM_PASSWORD="$(openssl rand -base64 24)" npm run auth:set-password
```

The password must be at least 12 characters. Then:

```sh
echo 'PHONE_FARM_AUTH_PLUGIN=local' >> .env
npm run web
```

Visit `/` and you are redirected to `/login`. "Log out" appears in the dashboard
nav automatically (the provider sets `logoutPath: '/auth/logout'`).

## Sessions and logging out

The session cookie is a self-contained HMAC: `base64url({ exp, sid }).signature`,
signed with `sessionSecret` from the state file. `exp` is the expiry
(`AUTH_SESSION_HOURS`, 12 by default) and `sid` is 16 random bytes naming *this*
session.

That `sid` is what makes logging out mean something. Clearing the browser's copy
of a self-contained cookie is not sign-out — a copy captured beforehand keeps
verifying until it expires. So `/auth/logout` records the `sid` server-side, in
`revokedSessions` in the state file, and every later request checks the list:

| | |
|---|---|
| Where | `revokedSessions: [{ sid, exp }]` in `.auth.json` |
| Pruned | entries are dropped once `exp` passes — the cookie was dead anyway |
| Capped | 500 entries (`MAX_REVOKED_SESSIONS`); a farm with one operator never approaches it |
| Scope | one session. Other browsers stay signed in; that is the point of the id |

Two consequences worth knowing:

- **Cookies minted before this change are rejected, once.** They carry no `sid`,
  so they cannot be revoked, so they are not honoured. Everyone signs in one
  more time and gets a cookie that can be.
- **Losing `.auth.json` signs everyone out**, because `sessionSecret` goes with
  it — as does every token digest.

Revoking an API token is separate and immediate: `npm run token:revoke` or
`DELETE /api/tokens/:id`. Requests fail on the next call, and a connection that
is already open — an `/api/events/stream` SSE tail — is re-checked about once a
minute and ended when its token is gone, rather than streaming until the client
happens to disconnect.

## API tokens

```sh
npm run token:create -- --name agent-1      # prints the token once
npm run token:revoke -- --name agent-1      # matches the name *or* the id
node --import tsx src/auth/cli.ts token-list   # name, id, createdAt
```

The token is shown exactly once; only its sha256 is stored, so a lost token is
replaced, not recovered. It looks like `pf_<43 base64url characters>`. Names may
contain letters, numbers, `.`, `-`, and `_`, are at most 64 characters, and must
be unique. Note the asymmetry: the CLI's `--name` removes every token whose
**name or id** matches, while the HTTP delete below matches on id only. Every mutating request made with a token logs its **name**:

```
{"level":30,"apiToken":"agent-1","method":"POST","url":"/api/schedules","msg":"authenticated API token request"}
```

Use one:

```sh
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/devices
```

### Token identity on the request

Every authenticated request carries who made it, as `request.apiToken`
(`{ id, name }`, declared in `src/auth/types.ts`). A cookie session is
`{ id: 'session', name: 'local' }`. Rate limits key on it, and anything that
needs per-caller state — per-token event acknowledgement, for one — can address
a token instead of guessing.

The state file also records `lastUsedAt` per token, written at most **once a
minute** per token so a phone polling the fleet every few seconds does not
rewrite `.auth.json` on every request.

### Listing and revoking over HTTP

```sh
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/tokens
curl -X DELETE -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/tokens/<id>
```

`GET /api/tokens` returns `{ tokens: [{ id, name, createdAt, lastUsedAt }] }` —
never the digest. `DELETE /api/tokens/:id` answers `204` and the token stops
working on its next request; it matches on **id only**, so a token named like
another one's id cannot be revoked by mistake. Give every phone, agent and
relay its own named token: one lost phone is then one `DELETE`, not a rotation
that logs out everything at once.

## Public paths

Exactly four things are reachable with no cookie and no token
(`isPublicPath` in `src/auth/local.ts`):

| Path | Why |
|---|---|
| `/login` | the form itself, and the `POST` that submits it |
| `/auth/logout` | must work even with a cookie the farm no longer honours |
| `/health` | liveness for the desktop app, launchd and any monitor |
| `/assets/*` | the dashboard's static CSS and JS, no data in them |

Everything else needs a cookie or a token — including `/`, `/fleet`, every
`/api/*` route, and `/mcp`, which takes a token only. A browser navigation (a
`GET` that accepts `text/html`) is redirected to `/login?next=…`; anything else
gets a JSON `401`.

## CSRF

`src/api/app.ts` guards every state-changing request with an `Origin` check, and
that guard stays on for cookie sessions: a `POST` with a session cookie and a
foreign (or missing) `Origin` is rejected with `403`. Requests carrying
`Authorization: Bearer …` are exempt — a browser form cannot set that header, so
a bearer request is by definition not browser-originated.

With neither `PUBLIC_ORIGIN` nor `PHONE_FARM_TRUSTED_ORIGINS` set, the guard
compares the `Origin`'s host against the request's `Host` (ignoring scheme, so a
TLS-terminating proxy that drops `x-forwarded-proto` still passes). Setting
**either** variable switches it to strict allow-list matching against the union
of both — so setting `PUBLIC_ORIGIN` alone can start rejecting writes that used
to pass. Set them when a proxy rewrites `Host`.

## Rate limiting

Failed logins are counted per client IP. After `AUTH_LOGIN_MAX_ATTEMPTS`
failures inside `AUTH_LOGIN_WINDOW_MINUTES` the form answers `429` until the
window rolls over — including for the correct password. The counter is
in-process, so it resets when `web` restarts.

API requests under `/api/*` are rate limited too, keyed on the **token id**
(falling back to the client IP), because over Tailscale every request arrives
from the same address. The budgets protect the *phones* more than the server: a
retry loop hammering `remote/action` is a real way to wedge a WDA session.

| Route | Bucket | Default | Variable |
|---|---|---|---|
| `/api/devices/:udid/remote/action` | `action` | 10/s per device and token | `RATE_LIMIT_ACTION` |
| `/api/devices/:udid/remote/screenshot` | `screenshot` | 5/s per device and token | `RATE_LIMIT_SCREENSHOT` |
| `/mcp` (all methods) | `mcp` | 600/min per token | `RATE_LIMIT_MCP` |
| Other writes | `write` | 60/min per token | `RATE_LIMIT_WRITE` |
| Reads | `read` | 300/min per token | `RATE_LIMIT_READ` |

`/mcp` has a bucket of its own because every MCP call — `initialize`, each tool
call, the session teardown — is one `POST` to the same path, so an agent's
ordinary tool loop would spend the 60/min write budget in under a minute and
stall. 600/min is ten calls a second: a ceiling on a runaway agent rather than a
throttle on a working one. It is the only counted path outside `/api/*`.

A refusal is a `429` with `x-ratelimit-limit`, `x-ratelimit-remaining`,
`x-ratelimit-reset` and `retry-after`, and the usual `{ "error": … }` body. The
counters are in-process and reset with `web`. The two per-second buckets are
matched on the **path**, not the method, so a `GET` on `…/remote/action` also
lands in the action bucket. `RATE_LIMITS=off` disables the whole layer — that is what the test suite uses; do not set it in production.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PHONE_FARM_AUTH_PLUGIN` | unset | Set to `local` for this provider, or an ESM package name for your own |
| `AUTH_STATE_PATH` | `.auth.json` beside `devices.json` | Password hash, session secret, token digests |
| `AUTH_SESSION_HOURS` | `12` | Session cookie lifetime |
| `AUTH_LOGIN_MAX_ATTEMPTS` | `5` | Failed logins per window, per IP |
| `AUTH_LOGIN_WINDOW_MINUTES` | `15` | Length of that window |
| `PHONE_FARM_PASSWORD` | unset | Non-interactive password for `auth:set-password` |
| `PUBLIC_ORIGIN` | unset | An origin allowed to write. Setting it switches the CSRF guard to allow-list mode |
| `PHONE_FARM_TRUSTED_ORIGINS` | unset | Comma-separated origins allowed to write, unioned with `PUBLIC_ORIGIN` |
| `RATE_LIMITS` | on | Set to `off` to disable API rate limiting entirely |
| `RATE_LIMIT_ACTION` | `10` | `remote/action` requests per second, per device and token |
| `RATE_LIMIT_SCREENSHOT` | `5` | `remote/screenshot` requests per second, per device and token |
| `RATE_LIMIT_WRITE` | `60` | Other writes per minute, per token |
| `RATE_LIMIT_READ` | `300` | Reads per minute, per token |
| `RATE_LIMIT_MCP` | `600` | `/mcp` requests per minute, per token |

## What this is not

The local provider is a single shared operator account plus named machine
tokens. There are no per-user accounts, roles, or audit trail beyond the log
line above. If you need those, write an `AuthProvider` (`src/plugin.ts`) and
point `PHONE_FARM_AUTH_PLUGIN` at your package instead — the contract is the
same one this provider implements.

## Before you expose it

The cookie is `Secure` only when the request arrives over HTTPS (directly, or
with `X-Forwarded-Proto: https` from your proxy). Terminate TLS, or keep the
farm on a private network. See `docs/mcp.md` and `SECURITY.md`.
