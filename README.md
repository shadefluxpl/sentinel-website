# Sentinel — website

Landing page + settings dashboard for the Sentinel bot. This is one process
(`backend/server.js`) that does two jobs: serves the static frontend files
in `frontend/`, and exposes the OAuth2 + settings API those pages call. One
deployable, one host.

The **bot** (`sentinel-bot/`) is the other deployable — a separate process
on a separate host. They share state through the same Postgres database
over the network, not through any local file.

## Setup

1. `cd backend && npm install`
2. Copy `backend/.env.example` to `backend/.env`, fill in:
   - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` — Developer Portal > OAuth2
   - `DISCORD_TOKEN` — the bot's own token, same value as `sentinel-bot/.env`.
     Needed only to look up a server's real channels/roles for the
     dashboard's dropdowns — a logged-in user's OAuth token can't do that.
   - `DISCORD_REDIRECT_URI` — must exactly match a redirect URI registered
     in Developer Portal > OAuth2 > Redirects
   - `SESSION_SECRET` — any long random string (command to generate one is
     in the `.env.example` comments)
   - `DATABASE_URL` — same Postgres connection string as the bot's `.env`
3. `npm start` (from inside `backend/`)
4. Open `http://localhost:3001` — this serves the landing page directly;
   `/dashboard.html` is the settings dashboard.

## Before it's actually usable

- **`frontend/index.html`**: near the bottom, set `DISCORD_CLIENT_ID` to
  your bot's application ID. Until you do, the "Add to Discord" button
  tells the visitor it isn't configured instead of silently going nowhere.
  If you change which permissions the bot requests, regenerate
  `BOT_PERMISSIONS` via Developer Portal > OAuth2 > URL Generator rather
  than hand-editing the number.
- **Discord OAuth2 redirect URI**: register the exact URL from
  `DISCORD_REDIRECT_URI` in the Developer Portal, or login will fail at
  the callback step.

## Deploying to separate hosts for real

This is what you asked for, so it's worth being explicit about the one
setting that changes:

Set `NODE_ENV=production` in the backend's `.env` on the real deployment.
This flips session cookies to `Secure; SameSite=None`, which browsers
require for a login cookie to survive a cross-origin redirect — relevant
if you ever split the frontend off to a different origin than this
backend (e.g., a separate static host). It requires the backend to be
served over HTTPS, which any real host (Render, Railway, Fly, a VPS with
a reverse proxy) gives you by default. If you leave `NODE_ENV` unset for
local development, cookies use the more standard `Lax` setting instead —
correct for `localhost`, wrong for a real cross-origin deployment.

If you keep frontend and backend together on one host (the setup this
README assumes, and the simpler one), the requests are same-origin and
none of this matters either way — `SameSite=None` vs `Lax` both work.

Also set `FRONTEND_ORIGIN` to wherever the frontend is actually served
from, so the login redirect lands in the right place and CORS headers are
correct if you do split them apart.

## API surface

`GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`, `GET /auth/me`
`GET /api/guilds` — servers the logged-in user can manage and Sentinel has joined
`GET /api/guilds/:id/settings`, `PATCH /api/guilds/:id/settings`
`GET /api/guilds/:id/channels`, `GET /api/guilds/:id/roles` — real data, bot-token-authenticated
`GET /health`

Every `/api/guilds/:id/*` route re-checks that the logged-in user actually
has Manage Server on that guild **on every request**, against a fresh call
to Discord — not just once at login. A request for a guild ID the user
doesn't have permission on is rejected regardless of what the client sends.

## What's real vs. what's deliberately left out

The dashboard's settings panels are fully wired — channel and role
dropdowns show your server's actual channels and roles (via the bot's
token), not example data, and Save writes straight to the same row the
bot reads from.

Left out on purpose, not by oversight: a "recent activity" feed. An
earlier mockup of this dashboard showed one with invented example
entries (fake usernames, fake ban reasons) — carrying that into the real
build would mean shipping fabricated data as if it were real, which
isn't something to ship quietly. Real activity logging is a legitimate
next feature — one new table, an insert at each bot action, one read
endpoint — but it's additional scope beyond "make the settings work,"
which is what this pass covers. Discord's own Server Settings → Audit
Log already covers this in the meantime; the dashboard links there.

## Testing status

No outbound network access was available while building this, so nothing
here has been run against real Discord or Postgres endpoints — only
syntax-checked. Test the full login → pick server → change setting → see
it reflected in the bot flow yourself before trusting it in production.
