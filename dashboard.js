// dashboard.js
// Talks to the backend that serves this same page (relative URLs — works
// with the recommended single-host deployment). If you split frontend and
// backend onto different hosts, change API_BASE below to the backend's
// full URL and see README.md for the cross-origin cookie notes.
const API_BASE = '';

const BOOLEAN_FIELDS = [
  'spam_filter_enabled', 'link_filter_enabled', 'invite_block_enabled',
  'anti_mention_enabled', 'anti_vanity_enabled', 'anti_server_rename_enabled',
  'anti_server_icon_enabled', 'anti_role_rename_enabled', 'anti_channel_rename_enabled',
  'anti_emoji_delete_enabled', 'anti_emoji_rename_enabled', 'anti_invite_delete_enabled',
  'anti_ghost_ping_enabled', 'anti_raid_enabled', 'verification_enabled',
];
const NUMBER_FIELDS = [
  'warn_threshold', 'spam_msg_limit', 'spam_window_ms', 'anti_mention_limit',
  'anti_raid_join_limit', 'anti_raid_join_window_ms',
];
const TEXT_FIELDS = ['prefix', 'verification_message'];
const SELECT_FIELDS = ['mod_log_channel_id', 'mute_role_id'];

let currentGuilds = [];
let currentGuildId = null;

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...options });
  if (res.status === 401) {
    showLoggedOut();
    throw new Error('Session expired');
  }
  return res;
}

function el(id) { return document.getElementById(id); }

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------

async function checkAuth() {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' });
    if (!res.ok) return showLoggedOut();
    const data = await res.json();
    showLoggedIn(data.user);
  } catch {
    showLoggedOut();
  }
}

function showLoggedOut() {
  el('loggedOutView').classList.remove('hidden');
  el('loggedInView').classList.add('hidden');
  el('userArea').innerHTML = '';
}

function showLoggedIn(user) {
  el('loggedOutView').classList.add('hidden');
  el('loggedInView').classList.remove('hidden');
  el('userArea').innerHTML = `
    <span style="font-size:13px; color:var(--text-dim); margin-right:12px;">${escapeHtml(user.username)}</span>
    <button id="logoutBtn" class="btn btn-outline btn-sm">Log out</button>
  `;
  el('logoutBtn').addEventListener('click', logout);
  loadGuilds();
}

async function logout() {
  await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
  currentGuilds = [];
  currentGuildId = null;
  showLoggedOut();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Guild picker
// ---------------------------------------------------------------------------

async function loadGuilds() {
  const picker = el('guildPicker');
  picker.innerHTML = '<option value="">Loading servers…</option>';

  try {
    const res = await api('/api/guilds');
    const data = await res.json();
    currentGuilds = data.guilds || [];

    if (currentGuilds.length === 0) {
      picker.innerHTML = '<option value="">No servers available</option>';
      el('noGuildsMsg').classList.remove('hidden');
      el('settingsArea').classList.add('hidden');
      return;
    }

    el('noGuildsMsg').classList.add('hidden');
    picker.innerHTML = '<option value="">Select a server…</option>' +
      currentGuilds.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
  } catch (err) {
    if (err.message !== 'Session expired') {
      picker.innerHTML = '<option value="">Failed to load servers</option>';
      console.error('[loadGuilds]', err);
    }
  }
}

el('guildPicker')?.addEventListener('change', (e) => {
  const guildId = e.target.value;
  if (!guildId) {
    el('settingsArea').classList.add('hidden');
    return;
  }
  currentGuildId = guildId;
  loadGuildDashboard(guildId);
});

// ---------------------------------------------------------------------------
// Settings + channel/role lookups for the selected guild
// ---------------------------------------------------------------------------

async function loadGuildDashboard(guildId) {
  setSaveStatus('', '');
  try {
    const [settingsRes, channelsRes, rolesRes] = await Promise.all([
      api(`/api/guilds/${guildId}/settings`),
      api(`/api/guilds/${guildId}/channels`),
      api(`/api/guilds/${guildId}/roles`),
    ]);

    const settingsData = await settingsRes.json();
    const channelsData = channelsRes.ok ? await channelsRes.json() : { channels: [] };
    const rolesData = rolesRes.ok ? await rolesRes.json() : { roles: [] };

    populateChannelSelect(channelsData.channels || []);
    populateRoleSelect(rolesData.roles || []);
    populateForm(settingsData.settings);
    populateServerInfo(guildId);

    el('settingsArea').classList.remove('hidden');
  } catch (err) {
    if (err.message !== 'Session expired') {
      console.error('[loadGuildDashboard]', err);
      setSaveStatus('Failed to load this server\u2019s data.', 'err');
    }
  }
}

function populateChannelSelect(channels) {
  const sel = el('s-mod_log_channel_id');
  sel.innerHTML = '<option value="">Not set</option>' +
    channels.map((c) => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
}

function populateRoleSelect(roles) {
  const sel = el('s-mute_role_id');
  sel.innerHTML = '<option value="">Not set</option>' +
    roles.map((r) => `<option value="${r.id}">@${escapeHtml(r.name)}</option>`).join('');
}

function populateForm(settings) {
  for (const key of BOOLEAN_FIELDS) {
    const input = el(`s-${key}`);
    if (input) input.checked = Boolean(settings[key]);
  }
  for (const key of NUMBER_FIELDS) {
    const input = el(`s-${key}`);
    if (input) input.value = settings[key] ?? '';
  }
  for (const key of TEXT_FIELDS) {
    const input = el(`s-${key}`);
    if (input) input.value = settings[key] ?? '';
  }
  for (const key of SELECT_FIELDS) {
    const input = el(`s-${key}`);
    if (input && settings[key]) input.value = settings[key];
  }
}

function populateServerInfo(guildId) {
  const guild = currentGuilds.find((g) => g.id === guildId);
  const body = el('serverInfoBody');
  if (!guild) { body.textContent = '—'; return; }

  body.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
      ${guild.icon ? `<img src="${guild.icon}" alt="" style="width:32px;height:32px;border-radius:8px;">` : ''}
      <div>
        <div style="color:var(--text); font-weight:500;">${escapeHtml(guild.name)}</div>
        <div style="font-size:11.5px;">${guild.owner ? 'You own this server' : 'Manage Server permission'}</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function collectFormValues() {
  const out = {};
  for (const key of BOOLEAN_FIELDS) {
    const input = el(`s-${key}`);
    if (input) out[key] = input.checked;
  }
  for (const key of NUMBER_FIELDS) {
    const input = el(`s-${key}`);
    if (input && input.value !== '') out[key] = parseInt(input.value, 10);
  }
  for (const key of TEXT_FIELDS) {
    const input = el(`s-${key}`);
    if (input) out[key] = input.value;
  }
  for (const key of SELECT_FIELDS) {
    const input = el(`s-${key}`);
    if (input) out[key] = input.value || null;
  }
  return out;
}

function setSaveStatus(text, cls) {
  const s = el('saveStatus');
  s.textContent = text;
  s.className = `save-status ${cls}`;
}

el('saveBtn')?.addEventListener('click', async () => {
  if (!currentGuildId) return;
  const btn = el('saveBtn');
  btn.disabled = true;
  setSaveStatus('Saving…', '');

  try {
    const body = collectFormValues();
    const res = await api(`/api/guilds/${currentGuildId}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (res.ok) {
      setSaveStatus('Saved.', 'ok');
    } else if (res.status === 207) {
      setSaveStatus(`Saved with errors: ${Object.keys(data.errors || {}).join(', ')}`, 'err');
    } else {
      setSaveStatus(data.error || 'Save failed.', 'err');
    }
  } catch (err) {
    if (err.message !== 'Session expired') setSaveStatus('Save failed.', 'err');
  } finally {
    btn.disabled = false;
    setTimeout(() => setSaveStatus('', ''), 4000);
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

checkAuth();
