// backend/server.js
// Sentinel dashboard backend — Discord OAuth2 + settings API
// Requires: npm install express express-session pg dotenv node-fetch@2
//
// Connects to the SAME Postgres database the bot uses (via DATABASE_URL).
// Bot and backend are deployed on separate hosts, so they share state over
// the network through this DB — not a local file.

const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config();

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_TOKEN,
  SESSION_SECRET,
  DATABASE_URL,
  PORT,
  FRONTEND_ORIGIN,
} = process.env;

// DISCORD_TOKEN (the bot's own token, same value as the bot's .env) is
// required here for one reason: listing a guild's channels and roles so the
// dashboard can show real dropdowns. The OAuth token from a logged-in user's
// "identify guilds" scope only proves who they are and which guilds they can
// manage — it grants no access to a guild's channel or role list. Only the
// bot's own credential can fetch that.
const REQUIRED_ENV = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'DISCORD_TOKEN', 'SESSION_SECRET', 'DATABASE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required env var: ${key}`);
    process.exit(1);
  }
}

const MANAGE_GUILD_BIT = 0x20;
const DISCORD_API = 'https://discord.com/api/v10';

// ---------------------------------------------------------------------------
// Database — same Postgres instance the bot writes to
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => console.error('[pg] unexpected idle client error:', err.message));

const SETTINGS_COLUMNS = new Set([
  'prefix', 'mod_log_channel_id', 'mute_role_id', 'warn_threshold',
  'spam_filter_enabled', 'spam_msg_limit', 'spam_window_ms',
  'link_filter_enabled', 'invite_block_enabled',
  'anti_mention_enabled', 'anti_mention_limit', 'anti_vanity_enabled',
  'anti_server_rename_enabled', 'anti_server_icon_enabled',
  'anti_role_rename_enabled', 'anti_channel_rename_enabled',
  'anti_emoji_delete_enabled', 'anti_emoji_rename_enabled',
  'anti_invite_delete_enabled', 'anti_ghost_ping_enabled',
  'anti_raid_enabled', 'anti_raid_join_limit', 'anti_raid_join_window_ms',
  'verification_enabled', 'verification_message',
]);

async function getGuildSettings(guildId) {
  await pool.query('INSERT INTO guild_settings (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [guildId]);
  const { rows } = await pool.query('SELECT * FROM guild_settings WHERE guild_id = $1', [guildId]);
  return rows[0];
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // requires HTTPS in prod — true cross-host deployment needs this on
    maxAge: 1000 * 60 * 60 * 24 * 7,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // cross-origin cookies (separate hosts) need SameSite=None + Secure
  },
}));

if (FRONTEND_ORIGIN) {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
} else {
  console.warn('[startup] FRONTEND_ORIGIN not set. With bot and dashboard on separate hosts, the frontend is a different origin from this API — CORS will block it without this set correctly.');
}

// Serves index.html, dashboard.html, style.css, dashboard.js from ../frontend.
// This is what makes "website" a single deployable: one process serves the
// marketing page, the dashboard UI, and the API it talks to. The bot is the
// separate deployable — it never serves HTTP, it only connects outward to
// this same Postgres database.
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------------------------------------------------------------------------
// OAuth2 flow
// ---------------------------------------------------------------------------

app.get('/auth/login', (req, res) => {
  const state = cryptoRandomState();
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) return res.status(400).send('Missing authorization code.');
  if (!state || state !== req.session.oauthState) {
    return res.status(400).send('State mismatch — possible CSRF attempt. Login again.');
  }
  delete req.session.oauthState;

  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[oauth] token exchange failed:', tokenRes.status, errText);
      return res.status(502).send('Discord token exchange failed. Try logging in again.');
    }

    const tokenData = await tokenRes.json();

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) return res.status(502).send('Failed to fetch Discord user profile.');
    const user = await userRes.json();

    req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
    req.session.accessToken = tokenData.access_token;
    req.session.tokenExpiresAt = Date.now() + tokenData.expires_in * 1000;
    req.session.refreshToken = tokenData.refresh_token;

    const redirectTarget = FRONTEND_ORIGIN || '/';
    res.redirect(redirectTarget);
  } catch (err) {
    console.error('[oauth] callback error:', err);
    res.status(500).send('Login failed unexpectedly. Try again.');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('[auth] logout session destroy failed:', err);
      return res.status(500).json({ error: 'Logout failed.' });
    }
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ user: req.session.user });
});

// ---------------------------------------------------------------------------
// Guild access
// ---------------------------------------------------------------------------

async function ensureFreshToken(req) {
  if (!req.session.accessToken) return false;
  if (Date.now() < req.session.tokenExpiresAt - 30000) return true;
  if (!req.session.refreshToken) return false;

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: req.session.refreshToken,
    }),
  });

  if (!res.ok) return false;
  const data = await res.json();
  req.session.accessToken = data.access_token;
  req.session.refreshToken = data.refresh_token;
  req.session.tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return true;
}

async function getManageableGuilds(req) {
  const fresh = await ensureFreshToken(req);
  if (!fresh) return null;

  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${req.session.accessToken}` },
  });
  if (!res.ok) return null;

  const guilds = await res.json();
  return guilds.filter((g) => {
    const perms = BigInt(g.permissions);
    return g.owner === true || (perms & BigInt(MANAGE_GUILD_BIT)) === BigInt(MANAGE_GUILD_BIT);
  });
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in.' });
  next();
}

async function requireManageGuild(req, res, next) {
  const guildId = req.params.guildId;
  if (!guildId) return res.status(400).json({ error: 'Missing guild ID.' });

  const manageable = await getManageableGuilds(req);
  if (manageable === null) return res.status(401).json({ error: 'Session expired. Log in again.' });

  const match = manageable.find((g) => g.id === guildId);
  if (!match) return res.status(403).json({ error: "You don't have permission to manage this server." });

  req.guild = match;
  next();
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.get('/api/guilds', requireAuth, async (req, res) => {
  const manageable = await getManageableGuilds(req);
  if (manageable === null) return res.status(401).json({ error: 'Session expired. Log in again.' });

  res.json({
    guilds: manageable.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
      owner: g.owner,
    })),
  });
});

app.get('/api/guilds/:guildId/settings', requireAuth, requireManageGuild, async (req, res) => {
  const settings = await getGuildSettings(req.params.guildId);
  res.json({ settings });
});

// Bot-authenticated request — uses the bot's own token, not the logged-in
// user's OAuth token. Only for read-only metadata lookups (channels, roles).
async function botFetch(endpoint) {
  const res = await fetch(`${DISCORD_API}${endpoint}`, {
    headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Discord API ${endpoint} returned ${res.status}`);
  return res.json();
}

const TEXT_CHANNEL_TYPE = 0; // Discord channel type enum: 0 = GUILD_TEXT

app.get('/api/guilds/:guildId/channels', requireAuth, requireManageGuild, async (req, res) => {
  try {
    const channels = await botFetch(`/guilds/${req.params.guildId}/channels`);
    const textChannels = channels
      .filter((c) => c.type === TEXT_CHANNEL_TYPE)
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ id: c.id, name: c.name }));
    res.json({ channels: textChannels });
  } catch (err) {
    console.error('[api/channels] error:', err.message);
    res.status(502).json({ error: "Could not load this server's channels. Is Sentinel actually a member of it?" });
  }
});

app.get('/api/guilds/:guildId/roles', requireAuth, requireManageGuild, async (req, res) => {
  try {
    const roles = await botFetch(`/guilds/${req.params.guildId}/roles`);
    const assignable = roles
      .filter((r) => r.id !== req.params.guildId && !r.managed) // drop @everyone and integration-managed roles
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name }));
    res.json({ roles: assignable });
  } catch (err) {
    console.error('[api/roles] error:', err.message);
    res.status(502).json({ error: "Could not load this server's roles. Is Sentinel actually a member of it?" });
  }
});

app.patch('/api/guilds/:guildId/settings', requireAuth, requireManageGuild, async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'Request body must be an object of column: value pairs.' });
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) return res.status(400).json({ error: 'No settings provided.' });

  const invalidKeys = keys.filter((k) => !SETTINGS_COLUMNS.has(k));
  if (invalidKeys.length > 0) {
    return res.status(400).json({ error: `Unknown setting(s): ${invalidKeys.join(', ')}` });
  }

  const guildId = req.params.guildId;
  await getGuildSettings(guildId); // ensures row exists

  const applied = {};
  const errors = {};
  for (const key of keys) {
    try {
      await pool.query(`UPDATE guild_settings SET ${key} = $1 WHERE guild_id = $2`, [updates[key], guildId]);
      applied[key] = updates[key];
    } catch (err) {
      errors[key] = err.message;
    }
  }

  const { rows } = await pool.query('SELECT * FROM guild_settings WHERE guild_id = $1', [guildId]);
  const status = Object.keys(errors).length > 0 ? 207 : 200;
  res.status(status).json({ settings: rows[0], applied, errors: Object.keys(errors).length ? errors : undefined });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function cryptoRandomState() {
  return require('crypto').randomBytes(16).toString('hex');
}

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const port = PORT || 3001;
app.listen(port, () => {
  console.log(`[startup] Sentinel dashboard backend listening on port ${port}`);
});

process.on('SIGINT', async () => {
  console.log('\n[shutdown] closing database pool and exiting');
  await pool.end();
  process.exit(0);
});
