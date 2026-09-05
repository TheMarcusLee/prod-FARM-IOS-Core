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
```

The password must be at least 12 characters. Then:

```sh
echo 'PHONE_FARM_AUTH_PLUGIN=local' >> .env
npm run web
```

Visit `/` and you are redirected to `/login`. "Log out" appears in the dashboard
nav automatically (the provider sets `logoutPath: '/auth/logout'`).

## API tokens

```sh
npm run token:create -- --name agent-1      # prints the token once
npm run token:revoke -- --name agent-1
```

The token is shown exactly once; only its sha256 is stored, so a lost token is
replaced, not recovered. Names may contain letters, numbers, `.`, `-`, and `_`,
and must be unique. Every mutating request made with a token logs its **name**:

```
{"level":30,"apiToken":"agent-1","method":"POST","url":"/api/schedules","msg":"authenticated API token request"}
```

Use one:

```sh
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/devices
```

## Public paths

`/login`, `/auth/logout`, `/health`, and `/assets/*` are reachable without a
session. Everything else needs a cookie or a token. A browser navigation (a `GET`
that accepts `text/html`) is redirected to `/login?next=…`; anything else gets a
JSON `401`.

## CSRF

`src/api/app.ts` guards every state-changing request with an `Origin` check, and
that guard stays on for cookie sessions: a `POST` with a session cookie and a
foreign (or missing) `Origin` is rejected with `403`. Requests carrying
`Authorization: Bearer …` are exempt — a browser form cannot set that header, so
a bearer request is by definition not browser-originated. Set
`PHONE_FARM_TRUSTED_ORIGINS` if a proxy rewrites `Host`.

## Rate limiting

Failed logins are counted per client IP. After `AUTH_LOGIN_MAX_ATTEMPTS`
failures inside `AUTH_LOGIN_WINDOW_MINUTES` the form answers `429` until the
window rolls over — including for the correct password. The counter is
in-process, so it resets when `web` restarts. Tokens are not rate limited; revoke
one instead.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PHONE_FARM_AUTH_PLUGIN` | unset | Set to `local` for this provider, or an ESM package name for your own |
| `AUTH_STATE_PATH` | `.auth.json` beside `devices.json` | Password hash, session secret, token digests |
| `AUTH_SESSION_HOURS` | `12` | Session cookie lifetime |
| `AUTH_LOGIN_MAX_ATTEMPTS` | `5` | Failed logins per window, per IP |
| `AUTH_LOGIN_WINDOW_MINUTES` | `15` | Length of that window |
| `PHONE_FARM_TRUSTED_ORIGINS` | unset | Comma-separated origins allowed to write |

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
