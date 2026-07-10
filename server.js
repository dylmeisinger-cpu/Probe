const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const TRAY_SIZE = 12;
const SLOT_VALUES = [5, 5, 10, 15, 15, 10, 10, 15, 15, 10, 5, 5];
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const RANDOM_COMPETITIVE_TURN_TIMER_SEC = 40;
const VALID_TIMERS = new Set([0, 30, 40, 45, 60, 90, 120]);
const CPU_DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'genius']);
const RANDOM_CPU_FALLBACK_MS = 20000;
const RANDOM_AWAY_GRACE_MS = 20000;
const RANDOM_AWAY_PENALTY = 20;
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNT_DB_PATH = path.join(DATA_DIR, 'word-vault-db.json');
const EMAIL_OUTBOX_PATH = path.join(DATA_DIR, 'email-outbox.jsonl');
const DAILY_LEADERBOARD_PATH = path.join(DATA_DIR, 'daily-leaderboard.json');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '');
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '');
const RESEND_FROM_EMAIL = String(process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM || '');
const DAILY_BASE_SCORE = 1200;
const DAILY_GUESS_PENALTY = 35;
const DAILY_TIME_PENALTY_PER_10_SEC = 5;
const DAILY_MIN_SCORE = 50;

// Server-side estimate of the client announcement queue. AI should not choose
// before the turn-card draw/reveal and other board announcements have cleared.
// Keep these in sync with public/client.js timing values, with a small safety pad.
const AI_ANNOUNCEMENT_INITIAL_PAUSE_MS = 1050;
const AI_ANNOUNCEMENT_BETWEEN_PAUSE_MS = 850;
const AI_ANNOUNCEMENT_SAFETY_MS = 450;
const AI_EFFECT_DURATIONS_MS = {
  card: 5040,
  cpu: 2280,
  result: 2580,
  normal: 2180
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultAccountDb() {
  return { users: {}, sessions: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

function loadAccountDb() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(ACCOUNT_DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaultAccountDb(),
      ...parsed,
      users: parsed.users || {},
      sessions: parsed.sessions || {}
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read account database; starting with an empty database.', err.message);
    return defaultAccountDb();
  }
}

function saveAccountDb(db) {
  ensureDataDir();
  db.updatedAt = new Date().toISOString();
  const tmp = `${ACCOUNT_DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, ACCOUNT_DB_PATH);
}

const accountDb = loadAccountDb();

function loadDailyLeaderboardDb() {
  ensureDataDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(DAILY_LEADERBOARD_PATH, 'utf8'));
    return { days: parsed.days || {} };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read daily leaderboard database; starting empty.', err.message);
    return { days: {} };
  }
}

function saveDailyLeaderboardDb(db) {
  ensureDataDir();
  const tmp = `${DAILY_LEADERBOARD_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DAILY_LEADERBOARD_PATH);
}

const dailyLeaderboardDb = loadDailyLeaderboardDb();
const dailyLeaderboardCache = dailyLeaderboardDb.days;
const userCacheByPlayerToken = new Map(Object.values(accountDb.users || {}).filter(u => u.playerToken).map(u => [u.playerToken, u]));

function supabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function resendConfigured() {
  return Boolean(RESEND_API_KEY && RESEND_FROM_EMAIL);
}

async function supabaseRequest(table, { method = 'GET', query = {}, body, single = false, maybeSingle = false } = {}) {
  if (!supabaseConfigured()) throw new Error('Supabase is not configured.');
  const url = new URL(`/rest/v1/${table}`, SUPABASE_URL);
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=representation'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const msg = data?.message || data?.hint || `Supabase request failed (${response.status})`;
    throw new Error(msg);
  }
  if (single) return Array.isArray(data) ? data[0] : data;
  if (maybeSingle) return Array.isArray(data) ? (data[0] || null) : data;
  return data || [];
}

function userRowToApp(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    verified: !!row.verified,
    verifyToken: row.verify_token || '',
    playerToken: row.player_token,
    avatar: row.avatar || '',
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null,
    verifiedAt: row.verified_at || null
  };
}

function userToRow(user, { includeAvatar = true } = {}) {
  const row = {
    id: user.id,
    name: user.name,
    email: user.email,
    password_hash: user.passwordHash,
    password_salt: user.passwordSalt,
    verified: !!user.verified,
    verify_token: user.verifyToken || null,
    player_token: user.playerToken,
    created_at: user.createdAt,
    last_login_at: user.lastLoginAt || null,
    verified_at: user.verifiedAt || null
  };
  if (includeAvatar) row.avatar = user.avatar || null;
  return row;
}

function cacheUser(user) {
  if (user?.playerToken) userCacheByPlayerToken.set(user.playerToken, user);
  return user;
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 120);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function makeToken(prefix = '') {
  return `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('base64url');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  const test = crypto.scryptSync(String(password || ''), user.passwordSalt, 64);
  const stored = Buffer.from(user.passwordHash, 'base64url');
  return stored.length === test.length && crypto.timingSafeEqual(stored, test);
}

function publicAccountUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    verified: !!user.verified,
    playerToken: user.playerToken,
    avatar: user.avatar || '',
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

function isMissingAvatarColumnError(err) {
  return /avatar/i.test(String(err?.message || '')) && /column|schema cache|could not find/i.test(String(err?.message || ''));
}

async function findUserByEmail(email) {
  if (supabaseConfigured()) {
    const row = await supabaseRequest('word_vault_users', { query: { email: `eq.${email}`, select: '*', limit: 1 }, maybeSingle: true });
    return cacheUser(userRowToApp(row));
  }
  return Object.values(accountDb.users).find(u => u.email === email);
}

async function findUserByVerifyToken(token) {
  if (supabaseConfigured()) {
    const row = await supabaseRequest('word_vault_users', { query: { verify_token: `eq.${token}`, select: '*', limit: 1 }, maybeSingle: true });
    return cacheUser(userRowToApp(row));
  }
  return Object.values(accountDb.users).find(u => u.verifyToken === token);
}

async function createUserRecord(user) {
  if (supabaseConfigured()) {
    try {
      await supabaseRequest('word_vault_users', { method: 'POST', body: userToRow(user), single: true });
    } catch (err) {
      if (!isMissingAvatarColumnError(err)) throw err;
      await supabaseRequest('word_vault_users', { method: 'POST', body: userToRow(user, { includeAvatar: false }), single: true });
    }
    return cacheUser(user);
  }
  accountDb.users[user.id] = user;
  saveAccountDb(accountDb);
  return cacheUser(user);
}

async function updateUserRecord(user) {
  if (supabaseConfigured()) {
    try {
      await supabaseRequest('word_vault_users', { method: 'PATCH', query: { id: `eq.${user.id}` }, body: userToRow(user) });
    } catch (err) {
      if (!isMissingAvatarColumnError(err)) throw err;
      await supabaseRequest('word_vault_users', { method: 'PATCH', query: { id: `eq.${user.id}` }, body: userToRow(user, { includeAvatar: false }) });
    }
    return cacheUser(user);
  }
  accountDb.users[user.id] = user;
  saveAccountDb(accountDb);
  return cacheUser(user);
}

async function createSessionRecord(sessionToken, userId) {
  const session = { userId, createdAt: new Date().toISOString() };
  if (supabaseConfigured()) {
    await supabaseRequest('word_vault_sessions', { method: 'POST', body: { token: sessionToken, user_id: userId, created_at: session.createdAt } });
    return session;
  }
  accountDb.sessions[sessionToken] = session;
  saveAccountDb(accountDb);
  return session;
}

async function sessionUser(sessionToken) {
  const token = String(sessionToken || '').trim();
  if (supabaseConfigured()) {
    const session = await supabaseRequest('word_vault_sessions', { query: { token: `eq.${token}`, select: 'user_id', limit: 1 }, maybeSingle: true });
    if (!session?.user_id) return null;
    const userRow = await supabaseRequest('word_vault_users', { query: { id: `eq.${session.user_id}`, select: '*', limit: 1 }, maybeSingle: true });
    return cacheUser(userRowToApp(userRow));
  }
  const session = token ? accountDb.sessions[token] : null;
  if (!session) return null;
  const user = accountDb.users[session.userId];
  return user || null;
}

async function deleteSessionRecord(sessionToken) {
  const token = String(sessionToken || '').trim();
  if (!token) return;
  if (supabaseConfigured()) {
    await supabaseRequest('word_vault_sessions', { method: 'DELETE', query: { token: `eq.${token}` } });
    return;
  }
  if (accountDb.sessions[token]) {
    delete accountDb.sessions[token];
    saveAccountDb(accountDb);
  }
}

function verificationLink(req, token) {
  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') || requestOrigin(req);
  return `${baseUrl}/api/account/verify?token=${encodeURIComponent(token)}`;
}

async function queueAccountEmail(kind, user, req) {
  ensureDataDir();
  const link = verificationLink(req, user.verifyToken);
  const item = {
    kind,
    to: user.email,
    name: user.name,
    subject: 'Verify your Word Vault account',
    body: `Hi ${user.name}, verify your Word Vault account here: ${link}`,
    verificationLink: link,
    createdAt: new Date().toISOString(),
    sent: false,
    note: 'Local outbox only. Wire SMTP/provider credentials later for real delivery.'
  };
  if (resendConfigured()) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: user.email,
          subject: item.subject,
          text: item.body,
          html: `<p>Hi ${escapeHtml(user.name)},</p><p>Verify your Word Vault account here:</p><p><a href="${link}">${link}</a></p>`
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `Resend email failed (${response.status})`);
      return { ...item, sent: true, provider: 'resend', providerId: data.id || null, note: 'Sent through Resend.' };
    } catch (err) {
      item.note = `Resend failed, queued locally instead: ${err.message}`;
      console.warn(item.note);
    }
  }
  fs.appendFileSync(EMAIL_OUTBOX_PATH, `${JSON.stringify(item)}\n`);
  console.log(`[Word Vault email] ${item.subject} -> ${user.email}: ${link}`);
  return item;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}


const DISCORD_SCOPES = ['identify'].join(' ');
const DISCORD_SDK_CDN = 'https://cdn.jsdelivr.net/npm/@discord/embedded-app-sdk@2.5.0/+esm';
const discordActivityRooms = new Map();
let cachedDiscordSdkBundle = null;
let cachedDiscordSdkAt = 0;

function discordConfigured() {
  return Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
}

function cleanDiscordKey(value) {
  const raw = String(value || '').trim();
  const clean = raw.replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 140);
  return clean || '';
}

async function exchangeDiscordCode(code) {
  if (!discordConfigured()) throw Object.assign(new Error('Discord Activity is not configured.'), { status: 503 });
  const body = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: String(code || '')
  });
  if (process.env.DISCORD_REDIRECT_URI) body.set('redirect_uri', process.env.DISCORD_REDIRECT_URI);
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data.error_description || data.error || `Discord token request failed (${response.status})`;
    throw Object.assign(new Error(msg), { status: response.status });
  }
  return data;
}

function discordAvatarUrl(user) {
  if (!user || !user.id || !user.avatar) return '';
  return `/api/discord/avatar/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}?size=128`;
}

function requestOrigin(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('host') || 'localhost:3000';
  return `${proto}://${host}`;
}

function sendIndexWithShareMeta(req, res) {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load Word Vault.');
    const origin = requestOrigin(req);
    const shareImage = `${origin}/assets/share-card.png?v=435`;
    const pageUrl = `${origin}${req.path || '/'}`;
    const withAbsoluteMeta = html
      .replace(/<meta property="og:url" content="[^"]*"\s*\/>/i, '')
      .replace('</title>', `</title>\n  <meta property="og:url" content="${pageUrl}" />`)
      .replace(/content="\/assets\/share-card\.png\?v=435"/g, `content="${shareImage}"`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(withAbsoluteMeta);
  });
}

const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative'
].join(' ');

function spotifyRedirectUri(req) {
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${req.get('host')}/auth/spotify/callback`;
}

function spotifyConfigured(req) {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET && spotifyRedirectUri(req));
}

async function exchangeSpotifyToken(params, req) {
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams(params);
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error_description || data.error || `Spotify token request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return data;
}


app.get('/', sendIndexWithShareMeta);
app.get('/discord', sendIndexWithShareMeta);
app.get('/activity', sendIndexWithShareMeta);

app.get('/api/discord/config', (_req, res) => {
  res.json({
    enabled: discordConfigured(),
    clientId: process.env.DISCORD_CLIENT_ID || '',
    scopes: DISCORD_SCOPES,
    sdkProxy: '/discord-sdk/embedded-app-sdk.js',
    activityPath: '/discord'
  });
});

app.use('/discord-sdk', express.static(path.join(__dirname, 'node_modules', '@discord', 'embedded-app-sdk', 'output'), { maxAge: '12h' }));

app.get('/discord-sdk/embedded-app-sdk.js', async (_req, res) => {
  try {
    const localSdk = path.join(__dirname, 'node_modules', '@discord', 'embedded-app-sdk', 'output', 'index.mjs');
    if (fs.existsSync(localSdk)) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=43200');
      return res.sendFile(localSdk);
    }
    const age = Date.now() - cachedDiscordSdkAt;
    if (!cachedDiscordSdkBundle || age > 1000 * 60 * 60 * 12) {
      const response = await fetch(DISCORD_SDK_CDN);
      if (!response.ok) throw new Error(`Could not download Discord SDK (${response.status})`);
      cachedDiscordSdkBundle = await response.text();
      cachedDiscordSdkAt = Date.now();
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=43200');
    res.send(cachedDiscordSdkBundle);
  } catch (err) {
    res.status(502).type('application/javascript').send(`throw new Error(${JSON.stringify(err.message || 'Discord SDK proxy failed')});`);
  }
});

app.post('/api/discord/token', async (req, res) => {
  const code = String(req.body?.code || '');
  if (!code) return res.status(400).json({ error: 'Missing Discord authorization code.' });
  try {
    const token = await exchangeDiscordCode(code);
    res.json({ access_token: token.access_token, token_type: token.token_type, expires_in: token.expires_in, scope: token.scope });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Discord token exchange failed.' });
  }
});


app.get('/api/discord/avatar/:userId/:hash', async (req, res) => {
  const userId = String(req.params.userId || '').replace(/[^0-9]/g, '');
  const hash = String(req.params.hash || '').replace(/[^a-zA-Z0-9_]/g, '');
  const size = ['64','128','256'].includes(String(req.query.size || '128')) ? String(req.query.size || '128') : '128';
  if (!userId || !hash) return res.status(400).send('Bad avatar request.');
  const ext = hash.startsWith('a_') ? 'gif' : 'png';
  try {
    const response = await fetch(`https://cdn.discordapp.com/avatars/${userId}/${hash}.${ext}?size=${size}`);
    if (!response.ok) return res.status(response.status).send('Avatar not found.');
    res.setHeader('Content-Type', response.headers.get('content-type') || (ext === 'gif' ? 'image/gif' : 'image/png'));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(502).send('Could not fetch avatar.');
  }
});

app.post('/api/discord/me', async (req, res) => {
  const accessToken = String(req.body?.access_token || '');
  if (!accessToken) return res.status(400).json({ error: 'Missing Discord access token.' });
  try {
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const user = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: user.message || 'Could not fetch Discord user.' });
    res.json({ ...user, avatar_url: discordAvatarUrl(user) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not fetch Discord user.' });
  }
});

app.get('/api/spotify/config', (req, res) => {
  res.json({
    enabled: spotifyConfigured(req),
    clientIdPresent: Boolean(process.env.SPOTIFY_CLIENT_ID),
    redirectUri: spotifyRedirectUri(req),
    scopes: SPOTIFY_SCOPES,
    premiumNote: 'Spotify Web Playback requires a Spotify Premium account.'
  });
});

app.get('/auth/spotify', (req, res) => {
  if (!spotifyConfigured(req)) {
    return res.status(503).send('Spotify is not configured. Add SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI in Render.');
  }
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES,
    redirect_uri: spotifyRedirectUri(req),
    state
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/auth/spotify/callback', async (req, res) => {
  if (!spotifyConfigured(req)) return res.status(503).send('Spotify is not configured.');
  const code = String(req.query.code || '');
  const error = String(req.query.error || '');
  if (error) {
    return res.send(`<script>window.opener&&window.opener.postMessage({type:'spotify-auth-error',error:${JSON.stringify(error)}}, location.origin); window.close();</script>Spotify authorization failed: ${error}`);
  }
  if (!code) return res.status(400).send('Missing Spotify authorization code.');
  try {
    const token = await exchangeSpotifyToken({ grant_type: 'authorization_code', code, redirect_uri: spotifyRedirectUri(req) }, req);
    const safe = JSON.stringify({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_in: token.expires_in,
      token_type: token.token_type,
      scope: token.scope
    }).replace(/</g, '\\u003c');
    res.send(`<!doctype html><html><head><title>Spotify connected</title></head><body><p>Spotify connected. You can close this window.</p><script>window.opener&&window.opener.postMessage({type:'spotify-auth',token:${safe}}, location.origin); window.close();</script></body></html>`);
  } catch (err) {
    const message = err.message || 'Spotify token exchange failed.';
    res.status(err.status || 500).send(`<script>window.opener&&window.opener.postMessage({type:'spotify-auth-error',error:${JSON.stringify(message)}}, location.origin); window.close();</script>${message}`);
  }
});

app.post('/api/spotify/refresh', async (req, res) => {
  if (!spotifyConfigured(req)) return res.status(503).json({ error: 'Spotify is not configured.' });
  const refreshToken = String(req.body?.refresh_token || '');
  if (!refreshToken) return res.status(400).json({ error: 'Missing refresh token.' });
  try {
    const token = await exchangeSpotifyToken({ grant_type: 'refresh_token', refresh_token: refreshToken }, req);
    res.json(token);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Spotify refresh failed.' });
  }
});

app.post('/api/account/register', async (req, res) => {
  const name = cleanName(req.body?.name || 'Player');
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Use at least 8 characters for your password.' });
  try {
    if (await findUserByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists.' });

    const id = makeToken('user_');
    const playerToken = makeToken('acct_').slice(0, 80);
    const verifyToken = makeToken('verify_');
    const passwordData = hashPassword(password);
    const user = {
      id,
      name,
      email,
      passwordHash: passwordData.hash,
      passwordSalt: passwordData.salt,
      verified: false,
      verifyToken,
      playerToken,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString()
    };
    await createUserRecord(user);
    const sessionToken = makeToken('sess_');
    await createSessionRecord(sessionToken, id);
    const emailItem = await queueAccountEmail('verify-account', user, req);
    res.json({ sessionToken, user: publicAccountUser(user), verificationLink: emailItem.verificationLink, message: emailItem.sent ? 'Account created. Verification email sent.' : 'Account created. Verification email queued locally.' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not create account.' });
  }
});

app.post('/api/account/login', async (req, res) => {
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const user = await findUserByEmail(email).catch(() => null);
  if (!user || !verifyPassword(password, user)) return res.status(401).json({ error: 'Email or password did not match.' });
  user.lastLoginAt = new Date().toISOString();
  const sessionToken = makeToken('sess_');
  await updateUserRecord(user);
  await createSessionRecord(sessionToken, user.id);
  res.json({ sessionToken, user: publicAccountUser(user) });
});

app.get('/api/account/me', async (req, res) => {
  const user = await sessionUser(req.get('x-word-vault-session') || req.query.session).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: publicAccountUser(user) });
});

app.post('/api/account/update', async (req, res) => {
  const user = await sessionUser(req.get('x-word-vault-session') || req.body?.session).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });

  const nextName = req.body?.name !== undefined ? cleanName(req.body.name) : user.name;
  const nextEmail = req.body?.email !== undefined ? cleanEmail(req.body.email) : user.email;
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  const emailChanged = nextEmail !== user.email;
  const passwordChanged = !!newPassword;
  const avatarProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'avatar');

  if (!validEmail(nextEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if ((emailChanged || passwordChanged) && !verifyPassword(currentPassword, user)) {
    return res.status(401).json({ error: 'Current password is required for email or password changes.' });
  }
  if (passwordChanged && newPassword.length < 8) return res.status(400).json({ error: 'Use at least 8 characters for your new password.' });

  try {
    if (emailChanged) {
      const existing = await findUserByEmail(nextEmail);
      if (existing && existing.id !== user.id) return res.status(409).json({ error: 'An account with that email already exists.' });
      user.email = nextEmail;
      user.verified = false;
      user.verifyToken = makeToken('verify_');
      user.verifiedAt = null;
    }

    user.name = nextName;
    if (passwordChanged) {
      const passwordData = hashPassword(newPassword);
      user.passwordHash = passwordData.hash;
      user.passwordSalt = passwordData.salt;
    }
    if (avatarProvided) {
      const cleanedAvatar = cleanAvatarData(req.body.avatar);
      if (cleanedAvatar === null) return res.status(400).json({ error: 'Avatar must be a small PNG, JPG, or WebP image.' });
      user.avatar = cleanedAvatar;
    }

    await updateUserRecord(user);
    let emailItem = null;
    if (emailChanged) emailItem = await queueAccountEmail('verify-account', user, req);
    const emailMessage = emailChanged
      ? (emailItem?.sent ? ' Verification email sent.' : ' Verification email queued locally.')
      : '';
    res.json({ user: publicAccountUser(user), message: `Account updated.${emailMessage}` });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not update account.' });
  }
});

app.post('/api/account/logout', async (req, res) => {
  const token = String(req.get('x-word-vault-session') || req.body?.session || '').trim();
  await deleteSessionRecord(token).catch(() => {});
  res.json({ ok: true });
});

app.post('/api/account/resend-verification', async (req, res) => {
  const user = await sessionUser(req.get('x-word-vault-session') || req.body?.session).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });
  if (user.verified) return res.json({ ok: true, message: 'Account is already verified.' });
  if (!user.verifyToken) user.verifyToken = makeToken('verify_');
  try {
    await updateUserRecord(user);
    const emailItem = await queueAccountEmail('verify-account', user, req);
    res.json({ ok: true, verificationLink: emailItem.verificationLink, message: emailItem.sent ? 'Verification email sent.' : 'Verification email queued locally.' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not send verification email.' });
  }
});

app.get('/api/account/verify', async (req, res) => {
  const token = String(req.query.token || '').trim();
  const user = await findUserByVerifyToken(token).catch(() => null);
  if (!user) return res.status(400).send('Verification link is invalid or expired.');
  user.verified = true;
  user.verifyToken = '';
  user.verifiedAt = new Date().toISOString();
  await updateUserRecord(user);
  res.send('<!doctype html><title>Word Vault account verified</title><body style="font-family:system-ui;background:#1d130c;color:#fff6dc;padding:32px"><h1>Word Vault account verified</h1><p>You can close this tab and return to the game.</p></body>');
});

app.get('/api/daily-puzzle', (req, res) => {
  res.json(publicDailyPuzzle(dailyPuzzleFor(req.query.date)));
});

app.get('/api/daily-leaderboard', async (req, res) => {
  const key = dayKey(req.query.date);
  try {
    res.json({ key, entries: await readDailyLeaderboard(key) });
  } catch (err) {
    res.json({ key, entries: dailyLeaderboardFor(key), warning: err.message || 'Using cached leaderboard.' });
  }
});


app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const CORE_THEMES = [
  { id: 'medical', name: 'Medical', emoji: '⚕️', examples: ['DOCTOR', 'VACCINE', 'SURGERY', 'HOSPITAL', 'FEVER', 'BANDAGE'], words: ['DOCTOR','NURSE','VACCINE','SURGERY','HOSPITAL','MEDICINE','BANDAGE','THERAPY','FEVER','CLINIC','SYRINGE','PATIENT','DENTIST','PHARMACY','BLOOD','VIRUS','HEART','BRAIN','X RAY'.replace(' ',''),'SCALPEL','PULSE','ALLERGY','ASTHMA','CAST'] },
  { id: 'animals', name: 'Animals', emoji: '🐾', examples: ['TIGER', 'DOLPHIN', 'RABBIT', 'FALCON', 'LIZARD'], words: ['TIGER','DOLPHIN','RABBIT','FALCON','LIZARD','PENGUIN','ELEPHANT','GIRAFFE','WOLF','EAGLE','SHARK','TURTLE','BEAVER','COYOTE','HORSE','BADGER','OTTER','MOOSE','PANDA','GORILLA','OCTOPUS','LOBSTER'] },
  { id: 'tools', name: 'Tools', emoji: '🧰', examples: ['HAMMER', 'WRENCH', 'DRILL', 'LADDER', 'PLIERS'], words: ['HAMMER','WRENCH','DRILL','LADDER','PLIERS','SAW','RATCHET','SCREWDRIVER','CHISEL','SANDER','GRINDER','LEVEL','CLAMP','ANVIL','TORCH','SHOVEL','ROUTER','TAPE','MALLET','AUGER'] },
  { id: 'sports', name: 'Sports', emoji: '🏆', examples: ['HOCKEY', 'SOCCER', 'BASEBALL', 'TENNIS', 'SKIING'], words: ['HOCKEY','SOCCER','BASEBALL','TENNIS','SKIING','FOOTBALL','BASKETBALL','GOLF','BOXING','RUGBY','LACROSSE','WRESTLING','SWIMMING','RUNNING','CYCLING','SKATING','ARCHERY','BOWLING','VOLLEYBALL'] },
  { id: 'food', name: 'Food', emoji: '🍕', examples: ['PIZZA', 'BURGER', 'PANCAKE', 'TACO', 'NOODLES'], words: ['PIZZA','BURGER','PANCAKE','TACO','NOODLES','SPAGHETTI','CHEESE','CHICKEN','WAFFLE','SALMON','COOKIE','BROWNIE','AVOCADO','BANANA','STRAWBERRY','SANDWICH','BACON','PASTA','RAMEN','OMELET'] },
  { id: 'movies', name: 'Movies & TV', emoji: '🎬', examples: ['WESTERN', 'VILLAIN', 'COMEDY', 'ALIEN', 'CASTLE'], words: ['WESTERN','VILLAIN','COMEDY','ALIEN','CASTLE','ROBOT','DRAGON','SPY','PIRATE','ZOMBIE','MYSTERY','CARTOON','SEQUEL','CAMERA','ACTOR','DIRECTOR','MONSTER','HERO','SCRIPT','CINEMA'] },
  { id: 'science', name: 'Science', emoji: '🔬', examples: ['PLANET', 'ATOM', 'ROCKET', 'FOSSIL', 'LASER'], words: ['PLANET','ATOM','ROCKET','FOSSIL','LASER','GALAXY','QUANTUM','MINERAL','CHEMISTRY','BIOLOGY','GRAVITY','ORBIT','PLASMA','NEUTRON','ECLIPSE','MAMMOTH','VOLCANO','CRYSTAL','OXYGEN','MAGNET'] },
  { id: 'places', name: 'Places', emoji: '🗺️', examples: ['CASTLE', 'FOREST', 'AIRPORT', 'ISLAND', 'MUSEUM'], words: ['CASTLE','FOREST','AIRPORT','ISLAND','MUSEUM','LIBRARY','STADIUM','HARBOR','DESERT','CANYON','VILLAGE','MARKET','THEATER','BRIDGE','TEMPLE','HOTEL','PARK','SCHOOL','FARM','DUNGEON'] },
  { id: 'video_games', name: 'Video Games', emoji: '🎮', examples: ['BOSS', 'QUEST', 'ARCADE', 'PORTAL', 'HEALER'], words: ['BOSS','QUEST','ARCADE','PORTAL','HEALER','MAGE','CASTLE','LOOT','SHIELD','DUNGEON','AVATAR','PIXEL','COMBO','RESPAWN','LEVEL','COIN','DRAGON','ROBOT','SNIPER','RACING'] },
  { id: 'random_hard', name: 'Random Hard Mode', emoji: '🧩', examples: ['CRYPTIC', 'JIGSAW', 'QUARTZ', 'ZEPHYR', 'JINX'], words: ['CRYPTIC','JIGSAW','QUARTZ','ZEPHYR','JINX','OXYGEN','VORTEX','GALAXY','PUZZLE','MYSTERY','COBALT','WIZARD','JAZZ','ZODIAC','FJORD','PIXEL','GLYPH','ONYX','NYMPH','KAYAK'] }
];

const BROAD_THEME_NAMES = [
  'Science','Technology','Nature','Space','Mythology','History','Transportation','Sports','Biology','Music',
  'Geography','Literature','Architecture','Chemistry','Government','Household Objects','Weather','Entertainment','Art','Food',
  'Animals','Plants','Ocean','Mountains','Cities','Travel','Education','Medicine','Energy','Engineering',
  'Mathematics','Language','Writing','Theater','Dance','Fashion','Photography','Film','Television','Radio',
  'Internet Culture','Games','Video Games','Board Games','Card Games','Puzzles','Mystery','Adventure','Exploration','Discovery',
  'Invention','Industry','Farming','Gardening','Cooking','Baking','Restaurants','Markets','Shopping','Money',
  'Business','Work','Careers','Tools','Machines','Robotics','Computers','Phones','Communication','Social Life',
  'Family','Friendship','School','College','Books','Libraries','Museums','Parks','Forests','Deserts',
  'Rivers','Lakes','Islands','Beaches','Caves','Volcanoes','Earth','Climate','Seasons','Winter',
  'Spring','Summer','Autumn','Holidays','Festivals','Celebrations','Traditions','Myths and Legends','Ancient World','Medieval Life',
  'Modern Life','Future','Time','Memory','Dreams','Emotions','Senses','Color','Light','Sound',
  'Motion','Speed','Strength','Balance','Shape','Patterns','Numbers','Maps','Navigation','Survival',
  'Safety','Health','Fitness','Outdoors','Camping','Hiking','Boating','Aviation','Railways','Roads',
  'Vehicles','Buildings','Bridges','Towers','Homes','Furniture','Kitchen','Bathroom','Office','Workshop',
  'Clothing','Jewelry','Toys','Pets','Wildlife','Insects','Birds','Reptiles','Fish','Marine Life',
  'Trees','Flowers','Seeds','Fruit','Vegetables','Desserts','Drinks','Breakfast','Dinner','Snacks',
  'Spices','Restaurants and Cafes','Sports Equipment','Team Sports','Individual Sports','Winter Sports','Water Sports','Racing','Olympics','Competition',
  'Performance','Stage','Concerts','Instruments','Songs','Genres','Artists','Stories','Heroes','Villains',
  'Creatures','Magic','Fantasy','Science Fiction','Superheroes','Crime','Comedy','Drama','Animation','Documentaries',
  'News','Journalism','Politics','Law','Courts','Public Service','Military','Emergency Services','Fire and Rescue','Police Work',
  'Medicine and Care','Hospitals','Pharmacy','Dentistry','Vision','Nutrition','Sleep','Mind','Brain','Heart',
  'Genetics','Evolution','Ecosystems','Conservation','Recycling','Pollution','Oceans and Weather','Astronomy','Planets','Stars',
  'Galaxies','Rockets','Satellites','Laboratories','Experiments','Minerals','Metals','Electricity','Magnetism','Forces',
  'Materials','Textiles','Wood','Stone','Glass','Plastic','Paper','Printing','Design','Crafts',
  'Painting','Sculpture','Drawing','Ceramics','Architecture and Design','Interior Design','Gardens','Landscapes','City Life','Country Life',
  'Night','Morning','Storms','Sunshine','Rain','Snow','Wind','Fire','Water','Ice',
  'Destruction','Creation','Repair','Building','Hidden Things','Secrets','Codes','Signals','Symbols','Riddles',
  'Luck','Strategy','Risk','Treasure','Trade','Voyages','Pirates','Knights','Royalty','Religion',
  'Philosophy','Ideas','Beliefs','Customs','World Cultures','Ancient Egypt','Ancient Greece','Ancient Rome','Asia','Africa',
  'Europe','North America','South America','Australia','Arctic','Tropics','Language Arts','Grammar','Poetry','Comics',
  'Magazines','Newspapers','Advertising','Brands','Logos','Packages','Collections','Hobbies','DIY','Repairs',
  'Cleaning','Storage','Organization','Measurement','Cooking Tools','Garden Tools','Office Supplies','School Supplies','Electronics','Appliances',
  'Cameras','Audio','Video','Streaming','Online Communities','Memes','Challenges','Trends','Famous People','Celebrities',
  'Athletes','Scientists','Explorers','Inventors','Leaders','Artists and Makers','Writers','Musicians','Actors','Directors',
  'Workers','Builders','Drivers','Pilots','Sailors','Farmers','Chefs','Teachers','Doctors and Nurses','Scientists and Engineers',
  'Banking','Investing','Real Estate','Travel Places','Hotels','Airports','Stations','Harbors','Stadiums','Theaters',
  'Factories','Farms','Mines','Warehouses','Courtyards','Castles','Temples','Schools and Campuses','Playgrounds','Neighborhoods',
  'Tools and Hardware','Locks and Keys','Doors and Windows','Containers','Bags','Boxes','Bottles','Shelves','Chairs and Tables','Beds',
  'Breakfast Foods','Street Food','Fruit and Candy','Breads','Cheese and Dairy','Meat and Seafood','Soups','Sauces','Picnics','Feasts',
  'Animal Habitats','Animal Sounds','Animal Movement','Plant Parts','Natural Materials','Natural Disasters','World Records','Fast Things','Slow Things','Tiny Things',
  'Giant Things','Round Things','Sharp Things','Soft Things','Heavy Things','Fragile Things','Bright Things','Dark Things','Old Things','New Things'
];

const THEME_EXAMPLE_BANK = [
  ['PLANET','ROCKET','ORBIT','LASER','COMET'],
  ['FOREST','RIVER','FLOWER','STONE','STORM'],
  ['MUSIC','PIANO','GUITAR','SONG','STAGE'],
  ['BRIDGE','TOWER','HOUSE','MARKET','HOTEL'],
  ['PLAYER','TROPHY','RACING','TENNIS','SOCCER'],
  ['BOOK','SCRIPT','POEM','WRITER','STORY'],
  ['HAMMER','WRENCH','CABLE','ENGINE','ROBOT'],
  ['PIZZA','BREAD','CHEESE','SALMON','COOKIE']
];

function themeIdFromName(name) {
  return String(name || 'theme').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'theme';
}

function makeBroadTheme(name, index) {
  const id = themeIdFromName(name);
  const wordsFromName = String(name || '').toUpperCase().replace(/&/g, ' ').split(/[^A-Z]+/).filter(w => w.length >= 3 && w.length <= 12);
  const bank = THEME_EXAMPLE_BANK[index % THEME_EXAMPLE_BANK.length];
  return { id, name, emoji: '*', examples: [...new Set([...wordsFromName, ...bank])].slice(0, 5), words: [] };
}

const CORE_THEME_IDS = new Set(CORE_THEMES.map(t => t.id));
const THEMES = [
  ...CORE_THEMES,
  ...BROAD_THEME_NAMES.map(makeBroadTheme).filter(t => !CORE_THEME_IDS.has(t.id))
].slice(0, 300);

const THEME_MAP = new Map(THEMES.map(t => [t.id, t]));
const GENERAL_CPU_WORDS = ['ABOUT','ABOVE','ABROAD','ABSENT','ACCEPT','ACCESS','ACCIDENT','ACCOUNT','ACID','ACORN','ACRYLIC','ACTION','ACTIVE','ACTOR','ACUTE','ADAPT','ADDED','ADDRESS','ADJUST','ADMIT','ADULT','ADVICE','AFFAIR','AFTER','AGAIN','AGENT','AGREE','AHEAD','ALARM','ALBUM','ALERT','ALIEN','ALIVE','ALLOW','ALMOST','ALONE','ALONG','ALTER','AMBER','ANCHOR','ANCIENT','ANGLE','ANIMAL','ANSWER','ANXIETY','APPLE','APRON','AREA','ARGUE','ARROW','ASHES','ASPECT','ATOM','ATTIC','AUDIO','AUTUMN','AVOID','AWARD','AWARE','AWFUL','BACK','BACON','BADGE','BAGEL','BAKER','BALCONY','BALLOON','BANANA','BANK','BARREL','BASIC','BASKET','BATTERY','BEACH','BEACON','BEAN','BEAUTY','BEFORE','BEGIN','BEHIND','BELIEF','BELL','BELT','BERRY','BETTER','BEYOND','BICYCLE','BIRD','BIRTH','BLANKET','BLAST','BLAZER','BLEND','BLIZZARD','BLOOM','BOARD','BOAT','BODY','BOLT','BONE','BONUS','BOOK','BORDER','BOTTLE','BOTTOM','BRAIN','BRANCH','BRAVE','BREAD','BRIDGE','BRIGHT','BROKEN','BRONZE','BROTHER','BRUSH','BUBBLE','BUCKET','BUDGET','BUILDER','BULLET','BUNDLE','BURGER','BUTTON','CABIN','CABLE','CAMERA','CANDLE','CANDY','CANVAS','CARBON','CARD','CAREFUL','CARPET','CASTLE','CASUAL','CATTLE','CAUSE','CEDAR','CENTER','CEREAL','CHAIN','CHAIR','CHANGE','CHARGE','CHEESE','CHERRY','CHEST','CHICKEN','CHOICE','CHURCH','CIRCLE','CITY','CLINIC','CLOCK','CLOSET','CLOUD','COACH','COAST','COBALT','COFFEE','COLLAR','COMEDY','COMMON','COMPASS','COPPER','CORNER','COTTON','COUNTY','COUPON','COYOTE','CRADLE','CRAFT','CRANE','CRASH','CRAYON','CREAM','CREDIT','CREEK','CRICKET','CRISP','CRYSTAL','CYCLE','DAMAGE','DANGER','DEALER','DECADE','DECENT','DECIDE','DEEPER','DEFEND','DEGREE','DELIGHT','DESERT','DESIGN','DESK','DETAIL','DEVICE','DIAMOND','DINNER','DIRECT','DOCTOR','DOLLAR','DONKEY','DOOR','DOUBLE','DRAGON','DRAWER','DREAM','DRESS','DRIFT','DRIVER','DUST','EAGLE','EARLY','EARTH','ECHO','EDITOR','EFFECT','EFFORT','ELBOW','ELECTRIC','EMBER','ENGINE','ENOUGH','ESCAPE','EVENT','EVERY','EXACT','EXCITE','EXHIBIT','FABRIC','FACTOR','FAMILY','FANCY','FARMER','FATHER','FAUCET','FAVOR','FEATHER','FEATURE','FENCE','FEVER','FIELD','FIGURE','FILTER','FINAL','FINGER','FINISH','FIRE','FISHING','FLAME','FLAVOR','FLEECE','FLIGHT','FLOAT','FLOWER','FOLDER','FOREST','FORK','FORMAT','FOSSIL','FOUNTAIN','FRAME','FREEDOM','FREEZER','FRIEND','FROST','FRUIT','FUTURE','GALAXY','GARAGE','GARDEN','GARLIC','GATHER','GENTLE','GHOST','GIANT','GIFT','GINGER','GLASS','GLOBE','GLORY','GOLDEN','GRAPE','GRAPH','GRASS','GRAVITY','GREEN','GRILL','GROUND','GUITAR','HAMMER','HANDLE','HARBOR','HARVEST','HAZEL','HEALTH','HEART','HEATER','HEIGHT','HELMET','HERO','HIDDEN','HIGHER','HOCKEY','HONEY','HORSE','HOSPITAL','HOTEL','HOUSE','HUNTER','ICEBERG','IDEA','IMAGE','IMPACT','INCOME','INDEX','INSECT','ISLAND','JACKET','JELLY','JEWEL','JOB','JOIN','JUDGE','JUICE','JUNGLE','KAYAK','KETTLE','KEYBOARD','KITCHEN','KNIGHT','LABEL','LADDER','LAGOON','LANTERN','LASER','LAUNCH','LAWYER','LEADER','LEAF','LEGEND','LEMON','LETTER','LIBRARY','LIGHT','LION','LIQUID','LITTLE','LIZARD','LOCKER','LOGIC','LOTION','LUMBER','LUNCH','MACHINE','MAGNET','MARBLE','MARKET','MASTER','MATRIX','MEDAL','MEDICINE','MEMORY','METAL','METHOD','MIDDLE','MINERAL','MIRROR','MOBILE','MODEL','MONKEY','MOON','MORNING','MOTHER','MOTION','MOUNTAIN','MOVIE','MUSEUM','MUSIC','MYSTERY','NATION','NEBULA','NEEDLE','NEON','NERVE','NEST','NEWSPAPER','NICKEL','NIGHT','NOBLE','NOODLE','NORTH','NUMBER','OBJECT','OCEAN','OFFICE','ORANGE','ORBIT','OXYGEN','PAINT','PALACE','PANCAKE','PAPER','PARADE','PARK','PARTNER','PASTA','PATIENT','PEACH','PEANUT','PENCIL','PEOPLE','PEPPER','PETAL','PHANTOM','PHONE','PHOTO','PIANO','PICNIC','PICTURE','PILLOW','PIRATE','PITCH','PIZZA','PLANET','PLASTIC','PLATE','PLAYER','POCKET','POINT','POLAR','POND','PORTAL','POWDER','PRAIRIE','PRESENT','PRINTER','PRISON','PROJECT','PULSE','PUZZLE','QUARTZ','QUEEN','QUICK','QUIET','RABBIT','RADIO','RAINBOW','RANCH','RANDOM','READER','REASON','RECORD','REFLEX','REGION','REMOTE','REPAIR','RESCUE','RESORT','RIBBON','RIVER','ROCKET','ROLLER','ROOF','ROOM','ROUTER','RUBBER','SADDLE','SALAD','SALMON','SANDWICH','SATURN','SAUCE','SCHOOL','SCIENCE','SCREEN','SCRIPT','SEASON','SECRET','SHADOW','SHELTER','SHIELD','SHOE','SIGNAL','SILVER','SINGER','SKETCH','SKIING','SLEEP','SLEEVES','SLIDER','SMOKE','SNACK','SNOW','SOCCER','SODIUM','SOLAR','SPARK','SPIDER','SPIRIT','SPLASH','SPRING','SQUARE','STADIUM','STAPLE','STAR','STATION','STEAM','STEEL','STONE','STORM','STORY','STREET','STRING','STUDENT','SUGAR','SUMMER','SUNSET','SURGERY','SWITCH','TABLE','TABLET','TARGET','TEMPLE','TENNIS','THEORY','THUNDER','TIGER','TIMBER','TOAST','TOKEN','TOMATO','TONGUE','TORCH','TOWER','TRACK','TRAIL','TRAIN','TREASURE','TROPHY','TUNNEL','TURTLE','UMBRELLA','UPDATE','VALLEY','VELVET','VIDEO','VILLAGE','VIOLET','VISION','VOYAGE','WALLET','WALNUT','WATER','WEALTH','WEATHER','WINDOW','WINTER','WIZARD','WOOD','WORKER','WORLD','WRENCH','WRITER','YELLOW','ZEBRA','ZEPHYR','ZODIAC'];

function dayKey(value) {
  const date = value ? new Date(String(value)) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return safe.toISOString().slice(0, 10);
}

function seededNumber(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
}

const DAILY_VAGUE_HINTS = [
  'Often misunderstood','Connected to exploration','Associated with winter','Used throughout history','Famous for its colors',
  'Lives near water','Known for incredible speed','Connected to mythology','Found in many homes','Tied to celebration',
  'Linked with discovery','Seen during big events','Part of everyday life','A symbol of change','Connected to teamwork',
  'Remembered from childhood','Useful in a crisis','Known for its shape','Often found outdoors','Connected to creativity',
  'Appears in old stories','Part of modern culture','Follows a pattern','Can travel far','Built to last',
  'Often shared','Harder than it looks','Connected to the sky','Associated with summer','Known for a strong sound',
  'Often collected','Can be surprisingly valuable','Connected to movement','Found near crowds','A clue from history'
];

function dailyHintForKey(key) {
  const month = Number(String(key).slice(5, 7));
  const seasonal = month === 12 || month <= 2
    ? ['Associated with winter', 'Found in cold places', 'Known for quiet nights']
    : month >= 3 && month <= 5
      ? ['Connected to renewal', 'Often seen in spring', 'Famous for its colors']
      : month >= 6 && month <= 8
        ? ['Associated with summer', 'Lives near water', 'Often found outdoors']
        : ['Connected to change', 'Used throughout history', 'Known for its colors'];
  const pool = [...seasonal, ...DAILY_VAGUE_HINTS];
  return pool[seededNumber(`daily-hint:${key}`) % pool.length];
}

function dailyPuzzleFor(dateValue) {
  const key = dayKey(dateValue);
  const dailyPool = [...new Set([...CORE_THEMES.flatMap(t => t.words || []), ...GENERAL_CPU_WORDS])].filter(w => /^[A-Z]{3,12}$/.test(w));
  const word = dailyPool[seededNumber(`daily-word:${key}`) % dailyPool.length] || 'PLANET';
  const hint = dailyHintForKey(key);
  const difficulty = ['hard', 'genius'][seededNumber(`difficulty:${key}`) % 2];
  return {
    key,
    title: 'Daily Puzzle',
    theme: { id: 'daily', name: 'Daily Puzzle', emoji: '*', examples: [] },
    hint,
    clue: `${hint}, ${word.length} letters`,
    difficulty,
    cpuName: 'Wolt',
    word
  };
}

function publicDailyPuzzle(puzzle) {
  if (!puzzle) return null;
  return {
    key: puzzle.key,
    title: puzzle.title,
    theme: puzzle.theme,
    hint: puzzle.hint,
    clue: puzzle.clue,
    difficulty: puzzle.difficulty,
    cpuName: puzzle.cpuName,
    baseScore: DAILY_BASE_SCORE,
    guessPenalty: DAILY_GUESS_PENALTY,
    timePenaltyPer10Sec: DAILY_TIME_PENALTY_PER_10_SEC,
    minScore: DAILY_MIN_SCORE
  };
}

function calculateDailyScore(guesses, elapsedMs) {
  const guessPenalty = Math.max(0, Number(guesses || 0)) * DAILY_GUESS_PENALTY;
  const timePenalty = Math.floor(Math.max(0, Number(elapsedMs || 0)) / 10000) * DAILY_TIME_PENALTY_PER_10_SEC;
  return Math.max(DAILY_MIN_SCORE, DAILY_BASE_SCORE - guessPenalty - timePenalty);
}

function dailyLeaderboardFor(dayKeyValue) {
  const day = String(dayKeyValue || dayKey());
  const entries = [...(dailyLeaderboardCache[day] || [])];
  entries.sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs || a.guesses - b.guesses || String(a.name).localeCompare(String(b.name)));
  return entries.slice(0, 25).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function dailyEntryRowToApp(row) {
  if (!row) return null;
  return {
    id: row.id,
    day: row.day,
    name: row.name,
    accountId: row.account_id || null,
    verified: !!row.verified,
    score: Number(row.score || 0),
    elapsedMs: Number(row.elapsed_ms || 0),
    guesses: Number(row.guesses || 0),
    completedAt: row.completed_at
  };
}

async function readDailyLeaderboard(dayKeyValue) {
  const day = String(dayKeyValue || dayKey());
  if (supabaseConfigured()) {
    const rows = await supabaseRequest('word_vault_daily_leaderboard', {
      query: {
        day: `eq.${day}`,
        select: '*',
        order: 'score.desc,elapsed_ms.asc,guesses.asc,name.asc',
        limit: 25
      }
    });
    dailyLeaderboardCache[day] = rows.map(dailyEntryRowToApp).filter(Boolean);
  }
  return dailyLeaderboardFor(day);
}

async function persistDailyLeaderboardEntry(entry) {
  if (supabaseConfigured()) {
    await supabaseRequest('word_vault_daily_leaderboard', {
      method: 'POST',
      body: {
        id: entry.id,
        day: entry.day,
        name: entry.name,
        account_id: entry.accountId,
        verified: !!entry.verified,
        score: entry.score,
        elapsed_ms: entry.elapsedMs,
        guesses: entry.guesses,
        completed_at: entry.completedAt
      }
    });
    await readDailyLeaderboard(entry.day);
    return;
  }
  dailyLeaderboardDb.days[entry.day] = dailyLeaderboardCache[entry.day];
  saveDailyLeaderboardDb(dailyLeaderboardDb);
}

function saveDailyLeaderboardEntry(room) {
  if (!room?.dailyPuzzle || room.dailyLeaderboardSubmitted) return null;
  const human = room.players.find(p => !p.isCpu && !p.isLocal);
  if (!human) return null;
  const key = room.dailyPuzzleKey || dayKey();
  const elapsedMs = Math.max(0, (room.dailyFinishedAt || Date.now()) - (room.dailyStartedAt || room.createdAt));
  const guesses = room.dailyGuessCount || 0;
  const score = calculateDailyScore(guesses, elapsedMs);
  const user = userCacheByPlayerToken.get(human.token) || Object.values(accountDb.users).find(u => u.playerToken === human.token);
  const entry = {
    id: makeToken('daily_'),
    day: key,
    name: cleanName(user?.name || human.name),
    accountId: user?.id || null,
    verified: !!user?.verified,
    score,
    elapsedMs,
    guesses,
    completedAt: new Date().toISOString()
  };
  dailyLeaderboardCache[key] = [...(dailyLeaderboardCache[key] || []), entry]
    .sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs || a.guesses - b.guesses)
    .slice(0, 100);
  persistDailyLeaderboardEntry(entry).catch(err => console.warn('Could not persist daily leaderboard entry:', err.message));
  room.dailyLeaderboardSubmitted = true;
  room.dailyScore = score;
  room.dailyElapsedMs = elapsedMs;
  addLog(room, `Daily Puzzle complete: ${entry.name} scored ${score} in ${Math.round(elapsedMs / 1000)} seconds with ${guesses} guesses.`);
  return entry;
}
function loadEnglishCpuWords() {
  const curated = [...new Set([...THEMES.flatMap(t => t.words), ...GENERAL_CPU_WORDS])].filter(w => /^[A-Z]{1,12}$/.test(w));
  try {
    const imported = require('word-list');
    const wordListPath = imported.default || imported;
    const text = fs.readFileSync(wordListPath, 'utf8');
    const broad = text
      .split(/\r?\n/)
      .map(w => w.trim().toUpperCase())
      .filter(w => /^[A-Z]{1,12}$/.test(w))
      .sort(() => Math.random() - 0.5);
    return [...new Set([...curated, ...broad])];
  } catch (err) {
    console.warn('Word list package was not available; CPU players are using the curated fallback dictionary.');
    return curated;
  }
}

const ALL_CPU_WORDS = loadEnglishCpuWords();
function loadCompetitiveDictionary() {
  const curated = [...new Set([...THEMES.flatMap(t => t.words), ...GENERAL_CPU_WORDS])]
    .filter(w => /^[A-Z]{1,12}$/.test(w));
  try {
    const text = fs.readFileSync(path.join(__dirname, 'dictionary.txt'), 'utf8');
    const words = text
      .split(/\r?\n/)
      .map(w => w.trim().toUpperCase())
      .filter(w => /^[A-Z]{1,12}$/.test(w));
    return new Set([...curated, ...words]);
  } catch (err) {
    console.warn('Competitive dictionary was not available; using the built-in curated word list.');
    return new Set(curated);
  }
}

const COMPETITIVE_DICTIONARY = loadCompetitiveDictionary();
const CPU_NAMES = ['Copper Bot', 'Brass Bot', 'Hazel CPU', 'Ivy CPU', 'Gearmind', 'Oak Bot'];
const CPU_AVATARS = {
  'Copper Bot': 'assets/bots/copper.svg',
  'Brass Bot': 'assets/bots/brass.svg',
  'Hazel CPU': 'assets/bots/hazel.svg',
  'Ivy CPU': 'assets/bots/ivy.svg',
  Gearmind: 'assets/bots/gearmind.svg',
  'Oak Bot': 'assets/bots/oak.svg',
  Wolt: 'assets/bots/wolt.svg'
};

function cpuAvatarForName(name) {
  return CPU_AVATARS[name] || 'assets/bots/gearmind.svg';
}

function competitiveDictionaryRequired(room) {
  return !!(room?.dailyPuzzle || room?.randomOnline || room?.competitive || room?.ranked || room?.publicMatchmaking);
}

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function hashStringToHue(value) {
  let h = 0;
  for (const ch of String(value || '')) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeDeck() {
  const templates = [
    { code: 'NORMAL', count: 43, title: 'Normal Turn', text: 'Make a normal letter, dot, or word guess.' },
    { code: 'ADDITIONAL', count: 5, title: 'Take an Additional Turn', text: 'After your next miss, draw another activity card and keep playing.' },
    { code: 'LEFT_EXPOSE', count: 4, title: 'Opponent on Your Left Exposes a Letter or Dot', text: 'The opponent to your left chooses one hidden space to expose. You score its value.' },
    { code: 'RIGHT_EXPOSE', count: 4, title: 'Opponent on Your Right Exposes a Letter or Dot', text: 'The opponent to your right chooses one hidden space to expose. You score its value.' },
    { code: 'SELF_DOT', count: 5, title: 'If You Have a Dot, Expose It', text: 'Before guessing, expose one of your hidden dots. No one scores.' },
    { code: 'MULT_3', count: 1, title: 'Triple the Value of Your First Guess', text: 'Only the first successful guess this turn is tripled.' },
    { code: 'MULT_4', count: 1, title: 'Quadruple the Value of Your First Guess', text: 'Only the first successful guess this turn is quadrupled.' },
    { code: 'MULT_5', count: 1, title: 'Quintuple the Value of Your First Guess', text: 'Only the first successful guess this turn is quintupled.' },
    { code: 'SCORE_MINUS_10', count: 1, title: 'Deduct 10 From Your Score', text: 'Lose 10 points immediately.', points: -10 },
    { code: 'SCORE_PLUS_15', count: 1, title: 'Add 15 To Your Score', text: 'Gain 15 points immediately.', points: 15 },
    { code: 'SCORE_PLUS_20', count: 1, title: 'Add 20 To Your Score', text: 'Gain 20 points immediately.', points: 20 },
    { code: 'SCORE_PLUS_25', count: 1, title: 'Add 25 To Your Score', text: 'Gain 25 points immediately.', points: 25 }
  ];

  const deck = [];
  for (const card of templates) {
    for (let i = 0; i < card.count; i++) deck.push({ ...card, id: `${card.code}-${i + 1}` });
  }
  return shuffle(deck);
}

function cleanName(name) {
  return String(name || 'Player').trim().replace(/\s+/g, ' ').slice(0, 24) || 'Player';
}

function cleanThemeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').replace(/[<>]/g, '').slice(0, 42);
}

function makeCustomTheme(name) {
  const clean = cleanThemeName(name) || 'Custom Theme';
  const idHash = crypto.createHash('sha1').update(clean.toLowerCase()).digest('hex').slice(0, 10);
  const examples = clean.toUpperCase().split(/[^A-Z]+/).filter(w => w.length >= 3 && w.length <= 12).slice(0, 3);
  return { id: `custom_${idHash}`, name: clean, emoji: '*', examples: examples.length ? examples : ['CUSTOM', 'PLAYER', 'IDEA'], words: [], custom: true };
}

function normalizeThemeMode(mode, useThemes = true) {
  if (mode === 'host') return 'database';
  if (['none', 'random', 'database', 'custom'].includes(String(mode || ''))) return String(mode);
  return useThemes ? 'random' : 'none';
}

function normalizeThemeSelectionMethod(method) {
  return ['host', 'vote', 'random'].includes(String(method || '')) ? String(method) : 'host';
}

function suggestionIdForThemeSuggestion(suggestion) {
  if (!suggestion) return '';
  if (suggestion.type === 'database') return `db:${suggestion.themeId}`;
  return `custom:${themeIdFromName(suggestion.name || 'custom')}`;
}

function publicThemeSuggestion(room, suggestion) {
  if (!suggestion) return null;
  const player = getPlayer(room, suggestion.playerId);
  const theme = suggestion.type === 'database' ? THEME_MAP.get(suggestion.themeId) : makeCustomTheme(suggestion.name);
  if (!theme) return null;
  return {
    id: suggestion.id || suggestionIdForThemeSuggestion(suggestion),
    playerId: suggestion.playerId,
    playerName: player?.name || 'Player',
    type: suggestion.type,
    themeId: theme.id,
    name: theme.name,
    emoji: theme.emoji,
    examples: theme.examples || []
  };
}

function roomThemeSuggestions(room) {
  return Object.values(room?.themeSuggestions || {}).map(s => publicThemeSuggestion(room, s)).filter(Boolean);
}

function cleanAvatarData(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 180000) return null;
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,[a-z0-9+/=]+$/i.test(raw)) return null;
  return raw;
}

function cleanToken(token) {
  const raw = String(token || '').trim();
  if (/^[a-zA-Z0-9_-]{8,80}$/.test(raw)) return raw;
  return `guest_${Math.random().toString(36).slice(2, 14)}`;
}

function newPlayer(socketId, name, token, isHost = false, flags = {}) {
  return {
    id: token,
    token,
    socketId,
    name: cleanName(name),
    connected: flags.isCpu || flags.isLocal ? true : true,
    isHost,
    isCpu: !!flags.isCpu,
    isLocal: !!flags.isLocal,
    cpuDifficulty: flags.cpuDifficulty || 'medium',
    score: 0,
    ready: false,
    slots: null,
    word: '',
    lastAction: '',
    memory: {},
    avatar: flags.avatar || '',
    media: { cameraOn: false, micOn: false },
    randomAway: false,
    randomTurnForfeit: false
  };
}

function defaultSettings() {
  return {
    turnTimerSec: 0,
    useThemes: false,
    themeMode: 'none',
    themeSelectionMethod: 'host',
    themeId: 'medical',
    customThemeName: '',
    sharedDevice: false,
    manualReveal: false,
    aiEnabled: false,
    cpuDifficulty: 'medium'
  };
}

function newRoom(hostSocketId, hostName, hostToken) {
  const code = randomCode();
  const hostPlayer = newPlayer(hostSocketId, hostName, hostToken, true);
  const room = {
    code,
    createdAt: Date.now(),
    hostId: hostPlayer.id,
    status: 'lobby',
    settings: defaultSettings(),
    currentTheme: null,
    turnEndsAt: null,
    players: [hostPlayer],
    spectators: [],
    deck: makeDeck(),
    discard: [],
    currentCard: null,
    turnIndex: 0,
    multiplier: 1,
    firstGuessAvailable: true,
    additionalTurnOnMiss: false,
    additionalTurnOwnerId: null,
    awaitingExpose: null,
    log: [`Room ${code} created.`],
    effects: [],
    endedReason: '',
    endedAt: null,
    aiTimer: null,
    disconnectTimers: new Map(),
    aiSerial: 0,
    fxSerial: 0,
    effectsQuietUntil: 0,
    nonNormalStreak: 0,
    startingIntro: false,
    rulesIntroPending: false,
    rulesIntroAcknowledged: false,
    startIntroTimer: null,
    randomOnline: false,
    randomQueueOpen: false,
    randomWaitingSince: null,
    randomMatchedAt: null,
    randomCpuFallbackUsed: false,
    randomFallbackTimer: null,
    randomAwayTimers: new Map(),
    randomForfeitTimers: new Map(),
    themeSuggestions: {},
    themeVotes: {},
    themeReveal: null,
    challengeOffer: null,
    challengeMode: null,
    dailyPuzzle: false,
    dailyPuzzleKey: '',
    dailyPuzzleInfo: null,
    dailyStartedAt: null,
    dailyFinishedAt: null,
    dailyGuessCount: 0,
    dailyScore: null,
    dailyElapsedMs: null,
    dailyLeaderboardSubmitted: false
  };
  rooms.set(code, room);
  return room;
}


function deleteRoom(roomOrCode) {
  const room = typeof roomOrCode === 'string' ? rooms.get(roomOrCode) : roomOrCode;
  if (!room) return;
  if (room.aiTimer) clearTimeout(room.aiTimer);
  if (room.startIntroTimer) clearTimeout(room.startIntroTimer);
  if (room.randomFallbackTimer) clearTimeout(room.randomFallbackTimer);
  if (room.disconnectTimers) for (const t of room.disconnectTimers.values()) clearTimeout(t);
  if (room.randomAwayTimers) for (const t of room.randomAwayTimers.values()) clearTimeout(t);
  if (room.randomForfeitTimers) for (const t of room.randomForfeitTimers.values()) clearTimeout(t);
  if (room.discordKey) discordActivityRooms.delete(room.discordKey);
  rooms.delete(room.code);
}

function joinExistingOrNewDiscordRoom(socket, payload = {}) {
  if (!discordConfigured()) return { ok: false, message: 'Discord Activity is not configured on the server yet.' };
  const instanceId = cleanDiscordKey(payload.instanceId);
  if (!instanceId) return { ok: false, message: 'Discord did not provide an Activity instance ID yet.' };
  const key = `discord:${instanceId}`;
  let room = rooms.get(discordActivityRooms.get(key));
  const token = cleanToken(payload.token || (payload.discordUserId ? `discord_${payload.discordUserId}` : ''));
  const name = cleanName(payload.name || 'Discord Player');
  const avatar = String(payload.avatar || '').slice(0, 300);

  if (!room) {
    room = newRoom(socket.id, name, token);
    room.discordKey = key;
    room.discord = {
      instanceId,
      guildId: cleanDiscordKey(payload.guildId),
      channelId: cleanDiscordKey(payload.channelId)
    };
    if (avatar) room.players[0].avatar = avatar;
    room.log.unshift('Discord Activity room linked. Everyone joining this Activity shares this Word Vault room.');
    discordActivityRooms.set(key, room.code);
    return { ok: true, room, player: room.players[0], created: true, token };
  }

  const existing = getPlayerByToken(room, token);
  if (existing && !existing.isCpu && !existing.isLocal) {
    attachSocketToPlayer(room, existing, socket, name, avatar);
    return { ok: true, room, player: existing, created: false, token };
  }

  if (room.status !== 'lobby') return { ok: false, message: 'This Discord Activity game already started. Wait for the next round or use the web link.' };
  if (room.players.length >= MAX_PLAYERS) return { ok: false, message: 'That Discord Activity room is full.' };
  const player = newPlayer(socket.id, name, token, false, { avatar });
  room.players.push(player);
  socket.join(room.code);
  addLog(room, `${player.name} joined from Discord.`);
  return { ok: true, room, player, created: false, token };
}

function getRoomOfSocket(socketId) {
  for (const room of rooms.values()) if (room.players.some(p => p.socketId === socketId)) return room;
  return null;
}
function getSpectatorRoomOfSocket(socketId) {
  for (const room of rooms.values()) if ((room.spectators || []).some(s => s.socketId === socketId)) return room;
  return null;
}

function getPlayer(room, playerId) { return room.players.find(p => p.id === playerId); }
function getPlayerByToken(room, token) { return room.players.find(p => p.token === token); }
function socketPlayer(room, socket) { return room.players.find(p => p.socketId === socket.id); }
function activePlayer(room) { return room.players[room.turnIndex]; }
function humanOnlinePlayers(room) { return (room?.players || []).filter(p => !p.isCpu && !p.isLocal); }
function connectedHumanOnlinePlayers(room) { return humanOnlinePlayers(room).filter(p => p.connected && p.socketId); }

function addLog(room, message) {
  room.log.unshift(message);
  room.log = room.log.slice(0, 120);
}

function effectDurationForAiDelay(type, meta = {}) {
  if (meta?.cardCode || /^card/.test(String(type || ''))) return AI_EFFECT_DURATIONS_MS.card;
  if (type === 'cpu-action') return AI_EFFECT_DURATIONS_MS.cpu;
  if (type === 'word-solved') return 3900;
  if (type === 'starter-sequence') return 10400;
  if (/correct|miss|bad/i.test(String(type || ''))) return AI_EFFECT_DURATIONS_MS.result;
  return AI_EFFECT_DURATIONS_MS.normal;
}

function addEffect(room, type, message, meta = {}) {
  if (!room) return;
  room.fxSerial = (room.fxSerial || 0) + 1;
  const now = Date.now();
  const effect = { id: `${now}-${room.fxSerial}`, type, message, meta, t: now };
  room.effects = [...(room.effects || []), effect].slice(-16);

  // CPU turns are server-driven, but announcements/card draws are client-side.
  // Stack an estimated quiet time so CPUs do not make a guess until the visible
  // queue is done: previous result cards, the new turn-card draw, and settle.
  const queueStart = Math.max(room.effectsQuietUntil || 0, now + AI_ANNOUNCEMENT_INITIAL_PAUSE_MS);
  room.effectsQuietUntil = queueStart + effectDurationForAiDelay(type, meta) + AI_ANNOUNCEMENT_BETWEEN_PAUSE_MS;
}

function cardEffectType(card) {
  if (!card) return 'card-normal';
  if (card.code === 'NORMAL') return 'card-normal';
  if (card.code === 'SCORE_MINUS_10' || card.code === 'SELF_DOT') return 'card-bad';
  if (/SCORE_PLUS|MULT|ADDITIONAL/.test(card.code)) return 'card-good';
  return 'card-special';
}

function slotHasCard(slot) { return !!slot && (slot.ch === '.' || /^[A-Z]$/.test(slot.ch)); }
function hiddenCount(player) {
  if (!player.slots) return TRAY_SIZE;
  return player.slots.filter(s => slotHasCard(s) && !s.revealed).length;
}
function allExposed(player) { return player.slots && player.slots.every(s => !slotHasCard(s) || s.revealed); }
function playablePlayers(room) { return room.players.filter(p => p.slots && !allExposed(p)); }
function isConnectedForTurn(player) { return !!(player && (player.connected || player.isCpu || player.isLocal)); }
function hasValidGuessTarget(room, player) {
  if (room?.challengeMode) return !!(player && player.id === room.challengeMode.playerId && getPlayer(room, room.challengeMode.targetId)?.slots && !allExposed(getPlayer(room, room.challengeMode.targetId)));
  return !!(player && player.slots && room.players.some(p => p.id !== player.id && p.slots && !allExposed(p)));
}
function canTakeTurn(room, player) {
  return isConnectedForTurn(player) && hasValidGuessTarget(room, player);
}
function turnEligiblePlayers(room) { return room.players.filter(p => canTakeTurn(room, p)); }
function gameIntroActive(room) { return !!(room && room.status === 'playing' && (room.startingIntro || room.rulesIntroPending)); }
function roomAnnouncementsReady(room) { return !room?.effectsQuietUntil || room.effectsQuietUntil <= Date.now(); }
function gameActionsReady(room) { return !!(room && room.status === 'playing' && !room.startingIntro && !room.rulesIntroPending && !room.challengeOffer && roomAnnouncementsReady(room)); }
function starterSpinPlayers(room) {
  return room.players
    .filter(p => p.slots && isConnectedForTurn(p))
    .map(p => ({ id: p.id, name: p.name, hue: hashStringToHue(p.name + p.id), isLocal: !!p.isLocal, isCpu: !!p.isCpu }));
}

function randomOnlineWaitingRoom(excludeToken = '') {
  for (const room of rooms.values()) {
    if (!room.randomOnline || !room.randomQueueOpen || room.status !== 'lobby') continue;
    const humans = connectedHumanOnlinePlayers(room);
    if (humans.length !== 1 || humans[0].token === excludeToken) continue;
    if (room.players.length >= MAX_PLAYERS) continue;
    return room;
  }
  return null;
}

function markRandomRoomMatched(room) {
  clearRandomFallbackTimer(room);
  room.randomQueueOpen = false;
  room.randomWaitingSince = null;
  room.randomMatchedAt = Date.now();
  enforceRandomCompetitiveSettings(room);
  assignRandomOnlineTheme(room);
}

function enforceRandomCompetitiveSettings(room) {
  if (!room?.randomOnline) return;
  room.settings.turnTimerSec = RANDOM_COMPETITIVE_TURN_TIMER_SEC;
}

function assignRandomOnlineTheme(room) {
  if (!room?.randomOnline) return;
  const useTheme = Math.random() < 0.5;
  room.settings.themeMode = useTheme ? 'random' : 'none';
  room.settings.useThemes = useTheme;
  room.settings.themeSelectionMethod = 'random';
  room.settings.customThemeName = '';
  room.currentTheme = useTheme ? rand(THEMES) : null;
}

function clearRandomFallbackTimer(room) {
  if (!room?.randomFallbackTimer) return;
  clearTimeout(room.randomFallbackTimer);
  room.randomFallbackTimer = null;
}

function scheduleRandomFallbackOffer(room) {
  clearRandomFallbackTimer(room);
  if (!room?.randomOnline || !room.randomQueueOpen || room.status !== 'lobby') return;
  const waitingSince = room.randomWaitingSince || Date.now();
  const delay = Math.max(0, RANDOM_CPU_FALLBACK_MS - (Date.now() - waitingSince));
  room.randomFallbackTimer = setTimeout(() => {
    room.randomFallbackTimer = null;
    if (!randomCpuFallbackAvailable(room)) return;
    broadcast(room);
  }, delay + 50);
}

function addCpuPlayer(room, difficulty = 'medium') {
  if (!room) return { ok: false, message: 'Room not found.' };
  if (room.players.length >= MAX_PLAYERS) return { ok: false, message: 'That room is full.' };
  const cpuName = nextCpuName(room);
  const cpu = newPlayer(null, cpuName, makeCpuToken(room), false, {
    isCpu: true,
    cpuDifficulty: CPU_DIFFICULTIES.has(difficulty) ? difficulty : room.settings.cpuDifficulty || 'medium',
    avatar: cpuAvatarForName(cpuName)
  });
  room.players.push(cpu);
  room.settings.aiEnabled = true;
  addLog(room, `${cpu.name} joined as an Experimental CPU player.`);
  if (room.status === 'setup' && !cpu.ready) {
    autoAssignCpuSecret(room, cpu);
    startIfReady(room);
  }
  return { ok: true, cpu };
}

function randomCpuFallbackAvailable(room) {
  if (!room?.randomOnline || !room.randomQueueOpen || room.status !== 'lobby') return false;
  if (connectedHumanOnlinePlayers(room).length !== 1) return false;
  return Date.now() - (room.randomWaitingSince || room.createdAt) >= RANDOM_CPU_FALLBACK_MS;
}

function randomOnlinePenaltyActive(room) {
  return !!(room?.randomOnline && room.status === 'playing' && humanOnlinePlayers(room).length >= 2);
}

function clearRandomAwayTimer(room, playerId) {
  const timer = room?.randomAwayTimers?.get(playerId);
  if (timer) clearTimeout(timer);
  room?.randomAwayTimers?.delete(playerId);
}

function clearRandomForfeitTimer(room, playerId) {
  const timer = room?.randomForfeitTimers?.get(playerId);
  if (timer) clearTimeout(timer);
  room?.randomForfeitTimers?.delete(playerId);
}

function scheduleRandomForfeitWhenReady(room, playerId) {
  if (!room?.randomOnline || !playerId) return;
  if (room.randomForfeitTimers?.has(playerId)) return;
  const delay = Math.max(50, (room.effectsQuietUntil || 0) - Date.now() + 75);
  const timer = setTimeout(() => {
    room.randomForfeitTimers?.delete(playerId);
    const player = getPlayer(room, playerId);
    if (!player || room.status !== 'playing') return;
    applyRandomAwayTurnForfeit(room, player);
    broadcast(room);
  }, delay);
  room.randomForfeitTimers?.set(playerId, timer);
}

function consumeRandomTurnForfeit(room, player) {
  if (!room?.randomOnline || !player?.randomTurnForfeit) return false;
  player.randomTurnForfeit = false;
  addLog(room, `${player.name} forfeits this turn for being away in Random Online.`);
  addEffect(room, 'turn-forfeit', `${player.name} loses this turn for being away.`, { actorId: player.id });
  return true;
}

function advanceTurnWithoutAdditional(room) {
  room.additionalTurnOnMiss = false;
  room.additionalTurnOwnerId = null;
  const nextIdx = nextConnectedTurnIndex(room, room.turnIndex);
  if (nextIdx >= 0) room.turnIndex = nextIdx;
  startTurn(room, false);
}

function applyRandomAwayTurnForfeit(room, player) {
  if (!randomOnlinePenaltyActive(room) || !player || player.isCpu || player.isLocal) return false;
  if (gameIntroActive(room)) {
    player.randomTurnForfeit = true;
    return true;
  }
  if (!roomAnnouncementsReady(room)) {
    scheduleRandomForfeitWhenReady(room, player.id);
    return true;
  }
  if (room.awaitingExpose?.playerId === player.id) {
    addLog(room, `${player.name} was away during an exposure choice, so the pending choice is cancelled and the turn is forfeited.`);
    room.awaitingExpose = null;
    addEffect(room, 'turn-forfeit', `${player.name} loses this turn for being away.`, { actorId: player.id });
    advanceTurnWithoutAdditional(room);
    return true;
  }
  if (activePlayer(room)?.id === player.id) {
    addLog(room, `${player.name} forfeits the turn for being away in Random Online.`);
    addEffect(room, 'turn-forfeit', `${player.name} loses this turn for being away.`, { actorId: player.id });
    advanceTurnWithoutAdditional(room);
    return true;
  }
  player.randomTurnForfeit = true;
  addLog(room, `${player.name} will forfeit their next turn for being away in Random Online.`);
  return true;
}

function startRandomAwayTimer(room, player) {
  if (!randomOnlinePenaltyActive(room) || !player || player.isCpu || player.isLocal) return;
  if (room.randomAwayTimers?.has(player.id)) return;
  player.randomAway = true;
  const timer = setTimeout(() => {
    room.randomAwayTimers?.delete(player.id);
    const current = getPlayer(room, player.id);
    if (!current || !current.randomAway || !randomOnlinePenaltyActive(room)) return;
    current.score -= RANDOM_AWAY_PENALTY;
    current.randomAway = false;
    addLog(room, `${current.name} was away for 20 seconds in Random Online. -${RANDOM_AWAY_PENALTY} points and turn forfeited.`);
    addEffect(room, 'random-away-penalty', `${current.name} looked away too long. -${RANDOM_AWAY_PENALTY} and turn forfeited.`, { actorId: current.id, points: -RANDOM_AWAY_PENALTY });
    applyRandomAwayTurnForfeit(room, current);
    broadcast(room);
  }, RANDOM_AWAY_GRACE_MS);
  room.randomAwayTimers.set(player.id, timer);
}

function chooseStarter(room) {
  const eligible = turnEligiblePlayers(room);
  const fallback = room.players.filter(p => p.slots && (p.connected || p.isCpu || p.isLocal));
  const starterPool = eligible.length ? eligible : fallback;
  const starter = starterPool[Math.floor(Math.random() * starterPool.length)] || room.players[0];
  room.turnIndex = Math.max(0, room.players.findIndex(p => p.id === starter?.id));
  return starter;
}

function beginStarterIntro(room) {
  if (!room || room.status !== 'playing' || room.startingIntro) return false;
  let starter = activePlayer(room);
  if (!starter || !starter.slots || (!starter.connected && !starter.isCpu && !starter.isLocal)) starter = chooseStarter(room);
  if (!starter) return false;
  room.rulesIntroPending = false;
  room.rulesIntroAcknowledged = true;
  room.startingIntro = true;
  room.turnEndsAt = null;
  room.currentCard = null;
  room.awaitingExpose = null;
  if (room.dailyPuzzle && !room.dailyStartedAt) room.dailyStartedAt = Date.now();
  addLog(room, 'Rules confirmed. Randomizing who starts.');
  addEffect(room, 'starter-sequence', `${starter.name} starts!`, { players: starterSpinPlayers(room), starterId: starter.id, starterName: starter.name, spinMs: 5000, beginMs: 2000, resultMs: 2500 });
  if (room.startIntroTimer) clearTimeout(room.startIntroTimer);
  room.startIntroTimer = setTimeout(() => {
    if (!rooms.has(room.code) || room.status !== 'playing' || !room.startingIntro) return;
    room.startingIntro = false;
    room.startIntroTimer = null;
    startTurn(room, false);
    broadcast(room);
  }, 10000);
  return true;
}

function findLeftPlayer(room, playerId) {
  const idx = room.players.findIndex(p => p.id === playerId);
  return room.players[(idx + 1) % room.players.length];
}
function findRightPlayer(room, playerId) {
  const idx = room.players.findIndex(p => p.id === playerId);
  return room.players[(idx - 1 + room.players.length) % room.players.length];
}

function drawCard(room) {
  // Move the previous current card to discard only when the next card is drawn.
  // This keeps deck/discard counts honest while the visible current-turn card stays
  // in the middle of the board until the turn changes.
  if (room.currentCard) {
    room.discard.push(room.currentCard);
    room.currentCard = null;
  }

  if (room.deck.length === 0) {
    room.deck = shuffle(room.discard);
    room.discard = [];
    room.nonNormalStreak = 0;
    addLog(room, 'The activity deck was reshuffled.');
  }

  let card = null;
  const normalIndex = room.deck.findIndex(c => c.code === 'NORMAL');
  const streak = room.nonNormalStreak || 0;
  if (normalIndex >= 0 && (streak >= 2 || (streak >= 1 && Math.random() < 0.65))) {
    card = room.deck.splice(normalIndex, 1)[0];
  }
  if (!card) card = room.deck.pop();

  if (card && card.code !== 'NORMAL' && streak >= 2) {
    const fallbackNormalIndex = room.deck.findIndex(c => c.code === 'NORMAL');
    if (fallbackNormalIndex >= 0) {
      room.deck.push(card);
      card = room.deck.splice(fallbackNormalIndex, 1)[0];
    }
  }

  room.currentCard = card || null;
  if (card) room.nonNormalStreak = card.code === 'NORMAL' ? 0 : (room.nonNormalStreak || 0) + 1;
  return card;
}

function setTurnTimer(room) {
  enforceRandomCompetitiveSettings(room);
  const seconds = room.settings?.turnTimerSec || 0;
  const timerStart = Math.max(Date.now(), room.effectsQuietUntil || 0);
  room.turnEndsAt = seconds > 0 ? timerStart + seconds * 1000 : null;
}

function startTurn(room, samePlayer = false) {
  if (!samePlayer) room.turnIndex = room.turnIndex % room.players.length;
  room.multiplier = 1;
  room.firstGuessAvailable = true;
  room.additionalTurnOnMiss = false;
  room.additionalTurnOwnerId = null;
  room.awaitingExpose = null;

  if (!ensureTurnEligible(room)) {
    setTurnTimer(room);
    return;
  }

  const player = activePlayer(room);
  if (consumeRandomTurnForfeit(room, player)) {
    advanceTurnWithoutAdditional(room);
    return;
  }
  if (room.challengeMode && player?.id === room.challengeMode.playerId) {
    room.currentCard = null;
    addLog(room, `${player.name} is continuing the 1v1 challenge at ${challengeMultiplier(room).toFixed(1)}x.`);
    setChallengeTimer(room);
    return;
  }
  const card = drawCard(room);
  if (!card || !player) {
    addLog(room, 'No activity card was available.');
    return;
  }

  addLog(room, `${player.name} drew: ${card.title}.`);
  addEffect(room, cardEffectType(card), `${player.name} drew ${card.title}.`, { cardCode: card.code, cardId: card.id, actorId: player.id });
  applyCard(room, player, card);
  setTurnTimer(room);
}

function applyCard(room, player, card) {
  if (card.code === 'ADDITIONAL') {
    room.additionalTurnOnMiss = true;
    room.additionalTurnOwnerId = player.id;
    addEffect(room, 'additional-armed', `${player.name} is protected by an additional-turn card until their next miss.`, { actorId: player.id, cardCode: card.code, cardId: card.id });
    return;
  }

  if (card.code === 'SELF_DOT') {
    const choices = hiddenIndices(player, '.', true);
    if (choices.length === 0) return addLog(room, `${player.name} has no hidden dot to expose, so the card is ignored.`);
    room.awaitingExpose = { type: 'card', playerId: player.id, byPlayerId: null, scoringPlayerId: null, onlyDot: true, symbol: '.', allowedIndices: choices, message: 'Expose one of your hidden dots. No one scores.' };
    return;
  }

  if (card.code === 'LEFT_EXPOSE' || card.code === 'RIGHT_EXPOSE') {
    const target = card.code === 'LEFT_EXPOSE' ? findLeftPlayer(room, player.id) : findRightPlayer(room, player.id);
    const choices = hiddenIndices(target, null, false);
    if (choices.length === 0) return addLog(room, `${target.name} has nothing hidden to expose, so the card is ignored.`);
    room.awaitingExpose = { type: 'card', playerId: target.id, byPlayerId: player.id, scoringPlayerId: player.id, onlyDot: false, symbol: null, allowedIndices: choices, message: `${target.name} must expose one hidden letter or dot. ${player.name} scores its value.` };
    return;
  }

  if (card.code === 'MULT_3') room.multiplier = 3;
  if (card.code === 'MULT_4') room.multiplier = 4;
  if (card.code === 'MULT_5') room.multiplier = 5;

  if (typeof card.points === 'number') {
    player.score += card.points;
    addLog(room, `${player.name}'s score changed by ${card.points}.`);
  }
}

function hiddenIndices(player, symbol = null, onlyDot = false) {
  if (!player?.slots) return [];
  const normalized = normalizeSymbol(symbol);
  const result = [];
  for (let i = 0; i < player.slots.length; i++) {
    const slot = player.slots[i];
    if (!slotHasCard(slot) || slot.revealed) continue;
    if (onlyDot && slot.ch !== '.') continue;
    if (normalized && slot.ch !== normalized) continue;
    result.push(i);
  }
  return result;
}

function normalizeSymbol(input) {
  const value = String(input || '').trim().toUpperCase();
  if (value === '.' || value === 'DOT' || value === 'BLANK' || value === '•') return '.';
  if (/^[A-Z]$/.test(value)) return value;
  return '';
}

function slotValue(index) { return SLOT_VALUES[index] || 0; }

function solvedWordText(player) {
  return String(player?.word || '').toUpperCase();
}

function hiddenGuessSlotValue(target, includeDots = false) {
  if (!target?.slots) return { points: 0, indices: [] };
  const indices = [];
  let points = 0;
  for (let i = 0; i < target.slots.length; i++) {
    const slot = target.slots[i];
    if (!slotHasCard(slot) || slot.revealed) continue;
    if (slot.ch === '.' && !includeDots) continue;
    indices.push(i);
    points += slotValue(i);
  }
  return { points, indices };
}

function addWordSolvedEffect(room, target, actorId = null) {
  const word = solvedWordText(target);
  if (!word) return;
  addEffect(room, 'word-solved', `${target.name}'s word was solved: ${word}`, {
    actorId,
    targetId: target.id,
    targetName: target.name,
    solvedWord: word
  });
}

function challengeMultiplier(room) {
  return Math.max(0.2, Number(room?.challengeMode?.multiplier || 1));
}

function setChallengeTimer(room) {
  room.turnEndsAt = Date.now() + 10000;
}

function afterChallengeGuess(room) {
  if (!room?.challengeMode || room.status !== 'playing') return;
  room.challengeMode.guesses = (room.challengeMode.guesses || 0) + 1;
  room.challengeMode.multiplier = Math.max(0.2, Number((challengeMultiplier(room) - 0.2).toFixed(2)));
  setChallengeTimer(room);
}

function finishRoom(room, reason) {
  if (!room || room.status === 'ended') return;
  room.status = 'ended';
  room.turnEndsAt = null;
  room.challengeOffer = null;
  room.challengeMode = null;
  room.endedAt = Date.now();
  for (const p of room.players) {
    p.randomAway = false;
    p.randomTurnForfeit = false;
    clearRandomAwayTimer(room, p.id);
    clearRandomForfeitTimer(room, p.id);
  }
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const high = sorted[0]?.score || 0;
  const winners = sorted.filter(p => p.score === high).map(p => p.name);
  room.endedReason = reason || (room.dailyPuzzle
    ? 'Daily Puzzle complete. The CPU word was solved.'
    : `Game over. Winner: ${winners.join(', ')} with ${high} points.`);
  addLog(room, room.endedReason);
  if (room.dailyPuzzle) {
    room.dailyFinishedAt = room.endedAt;
    saveDailyLeaderboardEntry(room);
  }
}

function maybeCreateChallengeOffer(room, solvedTarget, scorerId) {
  if (!room || room.dailyPuzzle || room.challengeMode || room.challengeOffer) return false;
  const scorer = getPlayer(room, scorerId);
  if (!solvedTarget || !scorer || solvedTarget.id === scorer.id || solvedTarget.isCpu || scorer.isCpu) return false;
  const humans = room.players.filter(p => !p.isCpu);
  if (humans.length !== 2 || allExposed(scorer)) return false;
  room.challengeOffer = { playerId: solvedTarget.id, targetId: scorer.id, offeredAt: Date.now() };
  room.turnEndsAt = null;
  addLog(room, `${solvedTarget.name} can accept defeat or continue challenging ${scorer.name}'s word.`);
  addEffect(room, 'challenge-offer', `${solvedTarget.name}: accept defeat or continue the challenge.`, { actorId: solvedTarget.id, targetId: scorer.id });
  return true;
}

function revealSlot(room, target, index, scoringPlayerId, reason, multiplier = 1) {
  if (!target?.slots) return { ok: false, points: 0 };
  const slot = target.slots[index];
  if (!slot || !slotHasCard(slot) || slot.revealed) return { ok: false, points: 0 };

  slot.revealed = true;
  const base = slotValue(index);
  let points = 0;
  let scorerName = null;

  if (scoringPlayerId) {
    points = Math.round(base * multiplier);
    const scorer = getPlayer(room, scoringPlayerId);
    if (scorer) {
      scorer.score += points;
      scorerName = scorer.name;
    }
  }

  const visible = slot.ch === '.' ? 'dot' : slot.ch;
  if (scorerName) {
    const multText = multiplier > 1 ? ` x${multiplier}` : '';
    addLog(room, `${target.name} exposed ${visible} in slot ${index + 1}. ${scorerName} scored ${base}${multText} = ${points}.`);
  } else {
    addLog(room, `${target.name} exposed ${visible} in slot ${index + 1}. No points scored.`);
  }

  const solvedNow = allExposed(target);
  if ((reason === 'guess' || reason === 'manual') && solvedNow && scoringPlayerId && !room.challengeMode) {
    const scorer = getPlayer(room, scoringPlayerId);
    if (scorer) scorer.score += 50;
    addLog(room, `${scorerName} earned a 50 point bonus for exposing ${target.name}'s final hidden space.`);
  }

  addEffect(room, 'correct', `${scorerName || 'A player'} revealed ${target.name}'s ${visible}.`, { targetId: target.id, scorerId: scoringPlayerId, slotIndex: index, symbol: slot.ch, points });
  if (solvedNow) addWordSolvedEffect(room, target, scoringPlayerId || null);
  if (solvedNow && scoringPlayerId) maybeCreateChallengeOffer(room, target, scoringPlayerId);
  checkGameEnd(room);
  return { ok: true, points };
}

function checkGameEnd(room) {
  if (room.status !== 'playing') return;
  if (room.challengeOffer) return;
  const done = room.dailyPuzzle
    ? room.players.some(p => p.isCpu && p.slots && p.slots.every(s => !slotHasCard(s) || s.revealed))
    : room.players.every(p => p.slots && p.slots.every(s => !slotHasCard(s) || s.revealed));
  if (!done) return;
  finishRoom(room);
}

function nextConnectedTurnIndex(room, fromIndex) {
  if (room.players.length === 0) return 0;
  for (let step = 1; step <= room.players.length; step++) {
    const idx = (fromIndex + step + room.players.length) % room.players.length;
    const p = room.players[idx];
    if (canTakeTurn(room, p)) return idx;
  }
  return -1;
}

function ensureTurnEligible(room) {
  if (room.status !== 'playing') return false;
  const current = activePlayer(room);
  if (canTakeTurn(room, current)) return true;
  const nextIdx = nextConnectedTurnIndex(room, Math.max(-1, room.turnIndex - 1));
  if (nextIdx >= 0) {
    const skipped = current?.name ? `${current.name} has no valid opponent left to guess.` : 'The current player has no valid opponent left to guess.';
    addLog(room, skipped);
    room.turnIndex = nextIdx;
    return true;
  }
  addLog(room, 'No eligible player can take a turn right now. Waiting for the game to finish.');
  return false;
}

function skipActiveIfNoValidTarget(room) {
  if (room.challengeOffer) return true;
  if (room.status !== 'playing' || room.awaitingExpose) return false;
  const current = activePlayer(room);
  if (canTakeTurn(room, current)) return false;
  if (current?.name) addLog(room, `${current.name} has no valid opponent left to guess, so their turn is skipped.`);
  const nextIdx = nextConnectedTurnIndex(room, room.turnIndex);
  if (nextIdx >= 0) {
    room.additionalTurnOnMiss = false;
    room.additionalTurnOwnerId = null;
    room.turnIndex = nextIdx;
    startTurn(room, false);
  } else {
    setTurnTimer(room);
  }
  return true;
}


function advanceTurnAfterMiss(room) {
  const player = activePlayer(room);
  if (room.additionalTurnOnMiss && (!room.additionalTurnOwnerId || room.additionalTurnOwnerId === player?.id)) {
    room.additionalTurnOnMiss = false;
    room.additionalTurnOwnerId = null;
    addLog(room, `${player?.name || 'The player'}'s additional-turn card activates after the miss. They draw another activity card and keep the turn.`);
    addEffect(room, 'additional-activate', `${player?.name || 'The player'} keeps the turn from an Additional Turn card.`, { actorId: player?.id || null });
    startTurn(room, true);
    return;
  }
  room.additionalTurnOnMiss = false;
  room.additionalTurnOwnerId = null;
  const nextIdx = nextConnectedTurnIndex(room, room.turnIndex);
  if (nextIdx >= 0) room.turnIndex = nextIdx;
  startTurn(room, false);
}

function giveUpTurn(room, player) {
  if (!room || room.status !== 'playing') return { ok: false, message: 'No active game.' };
  if (!gameActionsReady(room)) return { ok: false, message: 'Wait for the intro or animation to finish.' };
  if (room.awaitingExpose) return { ok: false, message: 'Resolve the pending exposure first.' };
  if (!player || activePlayer(room)?.id !== player.id) return { ok: false, message: 'It is not your turn.' };
  room.additionalTurnOnMiss = false;
  room.additionalTurnOwnerId = null;
  addLog(room, `${player.name} used /giveup and passed the turn.`);
  addEffect(room, 'give-up', `${player.name} gave up guessing. Turn passes.`, { actorId: player.id });
  const nextIdx = nextConnectedTurnIndex(room, room.turnIndex);
  if (nextIdx >= 0) room.turnIndex = nextIdx;
  startTurn(room, false);
  return { ok: true };
}

function makePublicSlots(player) {
  if (!player.slots) return [];
  return player.slots.map((slot, index) => {
    const empty = !slotHasCard(slot);
    return { index, value: empty ? null : slotValue(index), revealed: empty || !!slot.revealed, ch: !empty && slot.revealed ? slot.ch : '', hidden: !empty && !slot.revealed, empty };
  });
}
function makePrivateSlots(player) {
  if (!player.slots) return [];
  return player.slots.map((slot, index) => {
    const empty = !slotHasCard(slot);
    return { index, value: empty ? null : slotValue(index), revealed: empty || !!slot.revealed, ch: empty ? '' : slot.ch, empty };
  });
}

function publicTheme(room) {
  return room.currentTheme ? { id: room.currentTheme.id, name: room.currentTheme.name, emoji: room.currentTheme.emoji, examples: room.currentTheme.examples } : null;
}

function finalResults(room) {
  if (!room || room.status !== 'ended') return null;
  const sorted = [...room.players]
    .map(p => ({ id: p.id, name: p.name, score: p.score || 0, hiddenCount: hiddenCount(p), isCpu: !!p.isCpu, isLocal: !!p.isLocal }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let lastScore = null;
  let lastPlace = 0;
  return sorted.map((p, idx) => {
    if (lastScore === null || p.score !== lastScore) lastPlace = idx + 1;
    lastScore = p.score;
    return { ...p, place: lastPlace };
  });
}

function publicState(room, viewerId, flags = {}) {
  const active = room.status === 'playing' ? activePlayer(room) : null;
  const viewer = getPlayer(room, viewerId);
  const spectator = !!flags.spectator || !viewer;
  return {
    code: room.code,
    status: room.status,
    isHost: !spectator && room.hostId === viewerId,
    spectator,
    youId: viewerId,
    activePlayerId: active?.id || null,
    activePlayerName: active?.name || '',
    currentCard: room.currentCard,
    deckCount: room.deck.length,
    discardCount: room.discard.length,
    multiplier: room.multiplier,
    firstGuessAvailable: room.firstGuessAvailable,
    additionalTurnOnMiss: room.additionalTurnOnMiss,
    additionalTurnOwnerId: room.additionalTurnOwnerId,
    settings: room.settings,
    themes: THEMES.map(t => ({ id: t.id, name: t.name, emoji: t.emoji, examples: t.examples })),
    currentTheme: publicTheme(room),
    themeSuggestions: roomThemeSuggestions(room),
    themeVotes: room.themeVotes || {},
    myThemeVote: !spectator ? (room.themeVotes || {})[viewerId] || '' : '',
    myThemeSuggestion: !spectator ? publicThemeSuggestion(room, (room.themeSuggestions || {})[viewerId]) : null,
    challengeOffer: room.challengeOffer ? {
      ...room.challengeOffer,
      playerName: getPlayer(room, room.challengeOffer.playerId)?.name || 'Player',
      targetName: getPlayer(room, room.challengeOffer.targetId)?.name || 'opponent'
    } : null,
    challengeMode: room.challengeMode ? {
      ...room.challengeMode,
      multiplier: challengeMultiplier(room),
      playerName: getPlayer(room, room.challengeMode.playerId)?.name || 'Player',
      targetName: getPlayer(room, room.challengeMode.targetId)?.name || 'opponent'
    } : null,
    turnEndsAt: room.turnEndsAt,
    awaitingExpose: room.awaitingExpose ? { ...room.awaitingExpose, allowedIndices: canControlPlayer(room, viewer, room.awaitingExpose.playerId) ? room.awaitingExpose.allowedIndices : [] } : null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected || p.isCpu || p.isLocal,
      isHost: p.isHost,
      isCpu: p.isCpu,
      isLocal: p.isLocal,
      cpuDifficulty: p.cpuDifficulty,
      avatar: p.avatar || '',
      media: p.media || { cameraOn: false, micOn: false },
      ready: p.ready,
      score: p.score,
      randomAway: !!p.randomAway,
      hiddenCount: hiddenCount(p),
      allExposed: p.slots ? allExposed(p) : false,
      publicSlots: makePublicSlots(p),
      privateSlots: !spectator && p.id === viewerId ? makePrivateSlots(p) : null,
    })),
    spectators: (room.spectators || []).map(s => ({ id: s.id, name: s.name, connected: true })),
    log: room.log,
    effects: room.effects || [],
    endedReason: room.endedReason,
    endedAt: room.endedAt,
    startingIntro: !!room.startingIntro,
    rulesIntroPending: !!room.rulesIntroPending,
    rulesIntroAcknowledged: !!room.rulesIntroAcknowledged,
    randomOnline: !!room.randomOnline,
    randomQueueOpen: !!room.randomQueueOpen,
    randomWaitingSince: room.randomWaitingSince || null,
    randomMatchedAt: room.randomMatchedAt || null,
    randomCpuFallbackAvailable: room.hostId === viewerId && randomCpuFallbackAvailable(room),
    randomCpuFallbackSeconds: Math.max(0, Math.ceil((RANDOM_CPU_FALLBACK_MS - (Date.now() - (room.randomWaitingSince || room.createdAt))) / 1000)),
    randomRealPlayers: humanOnlinePlayers(room).length,
    dailyPuzzle: !!room.dailyPuzzle,
    dailyPuzzleKey: room.dailyPuzzleKey || '',
    dailyPuzzleInfo: publicDailyPuzzle(room.dailyPuzzleInfo),
    dailyStartedAt: room.dailyStartedAt || null,
    dailyFinishedAt: room.dailyFinishedAt || null,
    dailyGuessCount: room.dailyGuessCount || 0,
    dailyScore: room.dailyScore,
    dailyElapsedMs: room.dailyElapsedMs,
    dailyLeaderboard: room.dailyPuzzle ? dailyLeaderboardFor(room.dailyPuzzleKey) : [],
    endResults: finalResults(room)
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', publicState(room, p.id));
  }
  for (const spectator of (room.spectators || [])) {
    if (spectator.socketId) io.to(spectator.socketId).emit('state', publicState(room, spectator.id, { spectator: true }));
  }
  maybeScheduleAi(room);
}

function emitError(socket, message) { socket.emit('errorMessage', message); }

function hasInteriorDot(pattern) {
  const chars = String(pattern || '').split('');
  const firstLetter = chars.findIndex(ch => /[A-Z]/.test(ch));
  const lastLetter = chars.map((ch, i) => /[A-Z]/.test(ch) ? i : -1).filter(i => i >= 0).pop();
  if (firstLetter < 0 || lastLetter < 0) return false;
  for (let i = firstLetter + 1; i < lastLetter; i++) {
    if (chars[i] === '.') return true;
  }
  return false;
}


function leftAlignTrayPattern(pattern) {
  const clean = String(pattern || '').replace(/[^A-Z.]/g, '').slice(0, TRAY_SIZE);
  if (!clean) return ''.padEnd(TRAY_SIZE, ' ');
  return clean.padEnd(TRAY_SIZE, ' ').slice(0, TRAY_SIZE);
}

function emptyRevealedSlots() {
  return Array.from({ length: TRAY_SIZE }, () => ({ ch: '', revealed: true }));
}

function validateTray(trayRaw, leftDotsRaw) {
  const rawInput = String(trayRaw || '').trim().toUpperCase();

  // v4.3 tray rules:
  // - Letters are secret word cards.
  // - Periods are explicit dot cards.
  // - Missing/unused positions stay empty and are not cards.
  // - Nothing is auto-filled with dots anymore.
  // Legacy clients that still pass a leftDots value are accepted, but new clients
  // should send the full tray pattern in trayRaw/word.
  let pattern = rawInput.replace(/[^A-Z.]/g, '').slice(0, TRAY_SIZE);

  if (leftDotsRaw !== undefined && leftDotsRaw !== null && String(leftDotsRaw).trim() !== '' && !rawInput.includes('.')) {
    const letters = rawInput.replace(/[^A-Z]/g, '').slice(0, TRAY_SIZE);
    let leftDots = Number.parseInt(leftDotsRaw, 10);
    if (Number.isNaN(leftDots)) leftDots = 0;
    leftDots = Math.max(0, Math.min(leftDots, TRAY_SIZE - letters.length));
    pattern = `${'.'.repeat(leftDots)}${letters}`.slice(0, TRAY_SIZE);
  }

  const word = pattern.replace(/[^A-Z]/g, '');
  if (!/^[A-Z]{1,12}$/.test(word)) {
    return { ok: false, message: 'Use at least one letter. Type letters for word cards and periods for dot cards.' };
  }
  if (hasInteriorDot(pattern)) {
    return { ok: false, message: 'Dots can only go before or after the word. Do not put dots between letters.' };
  }

  const centeredPattern = leftAlignTrayPattern(pattern);
  const slots = [];
  for (let i = 0; i < TRAY_SIZE; i++) {
    const rawCh = centeredPattern[i] || '';
    const ch = rawCh === ' ' ? '' : rawCh;
    slots.push({ ch, revealed: ch === '' });
  }
  return { ok: true, word, tray: pattern, slots };
}

function applySecret(room, player, tray, leftDots, sourceName = player.name) {
  const result = validateTray(tray, leftDots);
  if (!result.ok) return result;
  if (!player?.isCpu && competitiveDictionaryRequired(room) && !COMPETITIVE_DICTIONARY.has(result.word)) {
    return {
      ok: false,
      message: 'please use a valid word'
    };
  }
  player.word = result.word;
  player.trayPattern = result.tray;
  player.slots = result.slots;
  player.ready = true;
  addLog(room, `${sourceName} locked in ${player.name}'s secret tray.`);
  return { ok: true };
}

function themeFromSuggestion(suggestion) {
  if (!suggestion) return null;
  if (suggestion.type === 'database') return THEME_MAP.get(suggestion.themeId) || null;
  if (suggestion.type === 'custom') return makeCustomTheme(suggestion.name);
  return null;
}

function hostSelectedTheme(room) {
  const mode = normalizeThemeMode(room.settings.themeMode, room.settings.useThemes);
  if (mode === 'database') return THEME_MAP.get(room.settings.themeId) || rand(THEMES);
  if (mode === 'custom') return makeCustomTheme(room.settings.customThemeName || 'Custom Theme');
  if (mode === 'random') return rand(THEMES);
  return null;
}

function selectCurrentTheme(room) {
  const mode = normalizeThemeMode(room.settings.themeMode, room.settings.useThemes);
  room.settings.themeMode = mode;
  room.settings.useThemes = mode !== 'none';
  if (!room.settings.useThemes) return null;
  if (mode === 'random') return rand(THEMES);

  const method = normalizeThemeSelectionMethod(room.settings.themeSelectionMethod);
  room.settings.themeSelectionMethod = method;
  if (method === 'host') return hostSelectedTheme(room);

  const suggestions = Object.values(room.themeSuggestions || {})
    .filter(s => s && s.type === mode)
    .map(s => ({ ...s, id: s.id || suggestionIdForThemeSuggestion(s), theme: themeFromSuggestion(s) }))
    .filter(s => s.theme);
  if (!suggestions.length) return hostSelectedTheme(room);

  if (method === 'random') return rand(suggestions).theme;

  const counts = new Map(suggestions.map(s => [s.id, 0]));
  for (const voteId of Object.values(room.themeVotes || {})) {
    if (counts.has(voteId)) counts.set(voteId, counts.get(voteId) + 1);
  }
  const high = Math.max(...counts.values());
  const tied = suggestions.filter(s => counts.get(s.id) === high);
  return rand(tied.length ? tied : suggestions).theme;
}

function pickCpuWord(room) {
  // CPU secret words stay playable/fair. The broad word-list is used for guessing/solving,
  // but CPU players pick their own hidden words from the round theme or the curated common list.
  const pool = room.currentTheme?.words?.length ? room.currentTheme.words : GENERAL_CPU_WORDS;
  const available = pool.filter(w => /^[A-Z]{3,12}$/.test(w));
  return rand(available.length ? available : GENERAL_CPU_WORDS);
}

function autoAssignCpuSecret(room, cpu) {
  const daily = room.dailyPuzzle ? (room.dailyPuzzleInfo || dailyPuzzleFor(room.dailyPuzzleKey)) : null;
  const word = daily?.word || pickCpuWord(room);
  const maxDots = Math.min(3, TRAY_SIZE - word.length);
  const dotCount = maxDots > 0 ? Math.floor(Math.random() * (maxDots + 1)) : 0;
  const leftDots = dotCount > 0 ? Math.floor(Math.random() * (dotCount + 1)) : 0;
  const rightDots = dotCount - leftDots;
  const tray = `${'.'.repeat(leftDots)}${word}${'.'.repeat(rightDots)}`.slice(0, TRAY_SIZE);
  applySecret(room, cpu, tray, null, cpu.name);
}

function startIfReady(room) {
  if (room.status !== 'setup') return;
  room.players.filter(p => p.isCpu && !p.ready).forEach(cpu => autoAssignCpuSecret(room, cpu));
  if (room.players.length >= MIN_PLAYERS && room.players.every(p => p.ready && p.slots)) {
    room.status = 'playing';
    chooseStarter(room);
    room.startingIntro = false;
    room.rulesIntroPending = true;
    room.rulesIntroAcknowledged = false;
    room.turnEndsAt = null;
    room.currentCard = null;
    room.awaitingExpose = null;
    addLog(room, 'All secret trays are ready. Review the rules before the starter randomizer.');
    if (room.currentTheme) addLog(room, `Round theme: ${room.currentTheme.emoji} ${room.currentTheme.name}.`);
  }
}

function attachSocketToPlayer(room, player, socket, name, avatar) {
  player.socketId = socket.id;
  player.connected = true;
  player.name = cleanName(name || player.name);
  if (avatar) player.avatar = String(avatar).slice(0, 300);
  if (room.disconnectTimers?.has(player.id)) {
    clearTimeout(room.disconnectTimers.get(player.id));
    room.disconnectTimers.delete(player.id);
  }
  socket.join(room.code);
}

function transferHostIfNeeded(room) {
  const host = getPlayer(room, room.hostId);
  if (host) return;
  const nextHost = room.players.find(p => !p.isCpu && !p.isLocal) || room.players[0];
  if (!nextHost) return;
  nextHost.isHost = true;
  room.hostId = nextHost.id;
  addLog(room, `${nextHost.name} is now the host.`);
}

function removePlayer(room, playerId, reason = 'removed') {
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx === -1) return null;
  const wasPlaying = room.status === 'playing';
  const wasActive = wasPlaying && room.players[room.turnIndex]?.id === playerId;
  const [removed] = room.players.splice(idx, 1);
  if (removed) {
    if (removed.socketId) {
      const oldSocket = io.sockets.sockets.get(removed.socketId);
      if (oldSocket) oldSocket.leave(room.code);
      io.to(removed.socketId).emit(reason === 'kicked' ? 'kicked' : 'leftRoom');
    }
    if (room.awaitingExpose?.playerId === removed.id) room.awaitingExpose = null;
    if (idx < room.turnIndex) room.turnIndex = Math.max(0, room.turnIndex - 1);
    if (room.turnIndex >= room.players.length) room.turnIndex = 0;
    if (room.hostId === removed.id) transferHostIfNeeded(room);

    if (room.disconnectTimers?.has(removed.id)) {
      clearTimeout(room.disconnectTimers.get(removed.id));
      room.disconnectTimers.delete(removed.id);
    }
    clearRandomAwayTimer(room, removed.id);
    clearRandomForfeitTimer(room, removed.id);
    removed.randomTurnForfeit = false;

    // Leaving should not leave stale AI timeouts or ghost turns behind.
    room.aiSerial++;
    if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
    if (room.disconnectTimers) { for (const t of room.disconnectTimers.values()) clearTimeout(t); room.disconnectTimers.clear(); }

    if (wasPlaying && room.players.length) {
      if (room.rulesIntroPending) {
        // Stay on the room-level rules overlay until the current host continues.
      } else if (wasActive) {
        const from = Math.max(-1, idx - 1);
        const nextIdx = nextConnectedTurnIndex(room, from);
        if (nextIdx >= 0) room.turnIndex = nextIdx;
        startTurn(room, false);
      } else {
        setTurnTimer(room);
      }
    }
  }
  return removed;
}

function canControlPlayer(room, self, playerId) {
  if (!self) return false;
  if (self.id === playerId) return true;
  return !!(room.settings.sharedDevice && self.id === room.hostId && getPlayer(room, playerId) && !getPlayer(room, playerId).isCpu);
}

function resolveActor(room, socket, requestedPlayerId) {
  const self = socketPlayer(room, socket);
  if (!self) return null;
  if (requestedPlayerId && canControlPlayer(room, self, requestedPlayerId)) return getPlayer(room, requestedPlayerId);
  return self;
}

function rememberCpuMiss(cpu, targetId, symbol) {
  if (!cpu?.isCpu) return;
  cpu.memory[targetId] = cpu.memory[targetId] || { misses: [] };
  if (!cpu.memory[targetId].misses.includes(symbol)) cpu.memory[targetId].misses.push(symbol);
}

function askSymbolInternal(room, asker, target, symbol) {
  if (!gameActionsReady(room)) return { ok: false, message: 'Wait for the card or result animation to finish.' };
  if (room.awaitingExpose) return { ok: false, message: 'Wait for the pending exposure choice first.' };
  if (!asker || activePlayer(room)?.id !== asker.id) return { ok: false, message: 'It is not your turn.' };
  if (!target || target.id === asker.id) return { ok: false, message: 'Choose a valid opponent.' };
  if (!target.slots) return { ok: false, message: 'That opponent has no tray.' };
  if (allExposed(target)) return { ok: false, message: 'That opponent has no hidden spaces left.' };
  if (room.challengeMode && (asker.id !== room.challengeMode.playerId || target.id !== room.challengeMode.targetId)) {
    return { ok: false, message: 'Challenge mode can only target the remaining opponent word.' };
  }
  if (room.dailyPuzzle && !asker.isCpu && !asker.isLocal) room.dailyGuessCount = (room.dailyGuessCount || 0) + 1;

  const normalized = normalizeSymbol(symbol);
  if (!normalized) return { ok: false, message: 'Ask for one letter, or ask for a dot.' };

  if (asker.isCpu) {
    addEffect(room, 'cpu-action', `${asker.name} asks ${target.name} for ${normalized === '.' ? 'a dot' : normalized}.`, { actorId: asker.id, targetId: target.id, symbol: normalized });
  }

  const matches = hiddenIndices(target, normalized, false);
  if (matches.length === 0) {
    addLog(room, `${asker.name} asked ${target.name} for ${normalized === '.' ? 'a dot' : normalized}. No match.`);
    rememberCpuMiss(asker, target.id, normalized);
    room.firstGuessAvailable = false;
    if (normalized === '.' && !room.challengeMode) {
      asker.score -= 50;
      addLog(room, `${asker.name} loses 50 points for asking for a dot from a player with no hidden dot.`);
      addEffect(room, 'dot-miss', `${asker.name} asked for a dot and missed. -50`, { actorId: asker.id, targetId: target.id, symbol: normalized });
    } else {
      addEffect(room, 'miss', `${asker.name} asked ${target.name} for ${normalized}. No match.`, { actorId: asker.id, targetId: target.id, symbol: normalized });
    }
    if (room.challengeMode) afterChallengeGuess(room);
    else advanceTurnAfterMiss(room);
    return { ok: true };
  }

  // v4.12: human targets always choose the card to flip, even if there is only one match.
  // This preserves the table-game feel and prevents the app from auto-revealing a player's own tray.
  // CPU targets can still resolve a single match automatically so CPU games do not feel stalled.
  if (matches.length === 1 && target.isCpu) {
    addEffect(room, 'correct-pending', `${asker.name} guessed correctly. ${target.name} has ${normalized === '.' ? 'a dot' : normalized}.`, { actorId: asker.id, targetId: target.id, symbol: normalized });
    const mult = room.challengeMode ? challengeMultiplier(room) : (room.firstGuessAvailable ? room.multiplier : 1);
    revealSlot(room, target, matches[0], asker.id, 'guess', mult);
    room.firstGuessAvailable = false;
    if (room.status === 'playing') {
      if (room.challengeMode) {
        afterChallengeGuess(room);
      } else if (!skipActiveIfNoValidTarget(room)) {
        addLog(room, `${asker.name} guessed correctly and continues.`);
        setTurnTimer(room);
      }
    }
    return { ok: true };
  }

  addEffect(room, 'correct-pending', `${asker.name} guessed correctly. ${target.name} has ${normalized === '.' ? 'a dot' : normalized}.`, { actorId: asker.id, targetId: target.id, symbol: normalized });

  room.awaitingExpose = {
    type: 'guess',
    playerId: target.id,
    byPlayerId: asker.id,
    scoringPlayerId: asker.id,
    onlyDot: normalized === '.',
    symbol: normalized,
    allowedIndices: matches,
    message: `${target.name}, click one hidden ${normalized === '.' ? 'dot' : normalized} card to flip.`
  };
  addLog(room, `${asker.name} asked ${target.name} for ${normalized === '.' ? 'a dot' : normalized}. ${target.name} must click one matching hidden card.`);
  if (room.challengeMode) room.turnEndsAt = null;
  else setTurnTimer(room);
  return { ok: true };
}

function chooseExposeInternal(room, target, idx) {
  if (!gameActionsReady(room)) return { ok: false, message: 'Wait for the card or result animation to finish.' };
  const pending = room.awaitingExpose;
  if (!pending) return { ok: false, message: 'There is no exposure choice pending.' };
  if (!target || pending.playerId !== target.id) return { ok: false, message: 'This exposure choice is not yours.' };
  if (!pending.allowedIndices.includes(idx)) return { ok: false, message: 'That slot is not allowed for this exposure.' };

  const mult = room.challengeMode && pending.type === 'guess' ? challengeMultiplier(room) : (pending.type === 'guess' && room.firstGuessAvailable ? room.multiplier : 1);
  revealSlot(room, target, idx, pending.scoringPlayerId, pending.type === 'guess' ? 'guess' : 'card', mult);

  let continuingAskerName = '';
  if (pending.type === 'guess') {
    room.firstGuessAvailable = false;
    continuingAskerName = getPlayer(room, pending.byPlayerId)?.name || 'The guesser';
  }

  room.awaitingExpose = null;
  if (room.status === 'playing' && room.challengeMode && pending.type === 'guess') {
    afterChallengeGuess(room);
  } else if (room.status === 'playing' && !skipActiveIfNoValidTarget(room)) {
    if (continuingAskerName) addLog(room, `${continuingAskerName} guessed correctly and continues.`);
    setTurnTimer(room);
  }
  return { ok: true };
}

function manualExposeInternal(room, target, idx, scorerId) {
  if (!gameActionsReady(room)) return { ok: false, message: 'Wait for the card or result animation to finish.' };
  if (!room.settings.manualReveal) return { ok: false, message: 'Click-to-expose mode is turned off.' };
  if (!target?.slots) return { ok: false, message: 'That player has no tray.' };
  const slot = target.slots[idx];
  if (!slot || !slotHasCard(slot) || slot.revealed) return { ok: false, message: 'Choose a hidden card slot.' };
  const scorer = scorerId && scorerId !== target.id ? scorerId : null;
  revealSlot(room, target, idx, scorer, 'manual', 1);
  if (room.status === 'playing' && !skipActiveIfNoValidTarget(room)) setTurnTimer(room);
  return { ok: true };
}

function visiblePattern(player) {
  return (player.slots || []).map(s => !slotHasCard(s) ? ' ' : (s.revealed ? s.ch : '_')).join('');
}


function cpuDifficulty(cpu, room) {
  return cpu.cpuDifficulty || room.settings.cpuDifficulty || 'medium';
}

function cpuWordPool(room, diff) {
  const themed = room.currentTheme?.words || [];
  if (diff === 'easy') return themed.length ? themed : GENERAL_CPU_WORDS.slice(0, 120);
  if (diff === 'medium') return [...new Set([...themed, ...GENERAL_CPU_WORDS])];
  if (diff === 'hard') return [...new Set([...themed, ...GENERAL_CPU_WORDS, ...ALL_CPU_WORDS.slice(0, 900)])];
  return [...new Set([...themed, ...GENERAL_CPU_WORDS, ...ALL_CPU_WORDS])];
}

function revealedPattern(target) {
  return (target.slots || []).map(s => !slotHasCard(s) ? ' ' : (s.revealed ? s.ch : '_')).join('');
}

function cpuCandidatePlacements(cpu, target, word) {
  if (!target?.slots || !/^[A-Z]{1,12}$/.test(word)) return [];
  const misses = new Set(cpu.memory[target.id]?.misses || []);
  const cardIndices = [];
  for (let i = 0; i < TRAY_SIZE; i++) {
    if (slotHasCard(target.slots[i])) cardIndices.push(i);
  }
  if (word.length > cardIndices.length) return [];

  const placements = [];
  const chosen = [];
  const maxPlacements = 90;

  function buildAndCheck() {
    const letterPositions = new Set(chosen);
    const tray = target.slots.map(s => slotHasCard(s) ? '.' : '');
    chosen.forEach((slotIndex, letterIndex) => { tray[slotIndex] = word[letterIndex]; });

    const hiddenLetters = new Set();
    let hiddenDots = 0;
    for (let i = 0; i < TRAY_SIZE; i++) {
      const publicSlot = target.slots[i];
      const ch = tray[i];
      if (!slotHasCard(publicSlot)) continue;
      if (publicSlot.revealed && publicSlot.ch !== ch) return;
      if (!publicSlot.revealed) {
        if (ch === '.') hiddenDots++;
        else hiddenLetters.add(ch);
      }
    }
    for (const miss of misses) {
      if (miss === '.' && hiddenDots > 0) return;
      if (miss !== '.' && hiddenLetters.has(miss)) return;
    }
    placements.push({ start: chosen[0] ?? 0, tray });
  }

  function dfs(letterIndex, cardStart) {
    if (placements.length >= maxPlacements) return;
    if (letterIndex === word.length) { buildAndCheck(); return; }
    const remainingLetters = word.length - letterIndex;
    for (let j = cardStart; j <= cardIndices.length - remainingLetters; j++) {
      chosen.push(cardIndices[j]);
      dfs(letterIndex + 1, j + 1);
      chosen.pop();
      if (placements.length >= maxPlacements) return;
    }
  }

  dfs(0, 0);
  return placements;
}

function cpuCandidates(room, cpu, target, cap = 9999) {
  const diff = cpuDifficulty(cpu, room);
  const pool = cpuWordPool(room, diff);
  const out = [];
  for (const word of pool) {
    const placements = cpuCandidatePlacements(cpu, target, word);
    if (placements.length) out.push({ word, placements });
    if (out.length >= cap) break;
  }
  return out;
}

function chooseCpuTarget(room, cpu) {
  const candidates = room.players.filter(p => p.id !== cpu.id && p.slots && !allExposed(p));
  if (!candidates.length) return null;
  const diff = cpuDifficulty(cpu, room);
  if (diff === 'easy') return rand(candidates);
  if (diff === 'medium') return [...candidates].sort((a, b) => hiddenCount(b) - hiddenCount(a))[0];

  const scored = candidates.map(target => {
    const possible = cpuCandidates(room, cpu, target, diff === 'genius' ? 700 : 260).length;
    const revealed = TRAY_SIZE - hiddenCount(target);
    const scarcity = possible ? Math.max(0, 90 - Math.min(possible, 90)) / 9 : 0;
    return { target, score: revealed * 1.8 + scarcity + hiddenCount(target) * 0.35 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.target || rand(candidates);
}

function chooseCpuSymbol(room, cpu, target) {
  const diff = cpuDifficulty(cpu, room);
  const misses = cpu.memory[target.id]?.misses || [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  if (diff === 'easy') {
    const pool = letters.filter(l => !misses.includes(l));
    return Math.random() < 0.06 ? '.' : rand(pool.length ? pool : letters);
  }

  const revealedLetters = new Set((target.slots || []).filter(s => s.revealed && /^[A-Z]$/.test(s.ch)).map(s => s.ch));
  const avoidBasic = new Set([...misses, ...revealedLetters]);

  if (diff === 'medium') {
    const frequency = 'ETAOINSHRDLUCMFYWGPBVKXQJZ'.split('');
    return frequency.find(l => !avoidBasic.has(l)) || letters.find(l => !misses.includes(l)) || rand(letters);
  }

  const candidates = cpuCandidates(room, cpu, target, diff === 'genius' ? 900 : 320);
  if (candidates.length) {
    const counts = Object.fromEntries(letters.map(l => [l, 0]));
    let dotCount = 0;
    for (const cand of candidates) {
      const possibleHiddenLetters = new Set();
      let hasHiddenDot = false;
      for (const placement of cand.placements) {
        placement.tray.forEach((ch, idx) => {
          if (target.slots[idx]?.revealed) return;
          if (ch === '.') hasHiddenDot = true;
          else possibleHiddenLetters.add(ch);
        });
      }
      for (const l of possibleHiddenLetters) counts[l] += 1;
      if (hasHiddenDot) dotCount += 1;
    }
    const total = Math.max(1, candidates.length);
    const ranked = Object.entries(counts)
      .filter(([l, count]) => count > 0 && !misses.includes(l))
      .map(([l, count]) => {
        const hitRate = count / total;
        const infoBonus = diff === 'genius' ? (1 - Math.abs(hitRate - 0.62)) : 1;
        return [l, count * infoBonus];
      })
      .sort((a, b) => b[1] - a[1]);
    const dotRate = dotCount / total;
    if (diff === 'genius' && !misses.includes('.') && dotRate > 0.92 && hiddenCount(target) <= 5) return '.';
    if (ranked[0]) return ranked[0][0];
  }

  const frequency = 'ETAOINSHRDLUCMFYWGPBVKXQJZ'.split('');
  return frequency.find(l => !avoidBasic.has(l)) || letters.find(l => !misses.includes(l)) || rand(letters);
}

function cpuMaybeFullGuess(room, cpu, target) {
  const diff = cpuDifficulty(cpu, room);
  if (diff === 'easy' || diff === 'medium') return false;
  const revealedLetters = revealedPattern(target).replace(/[^A-Z]/g, '');
  if (revealedLetters.length < (diff === 'genius' ? 2 : 3)) return false;
  const candidates = cpuCandidates(room, cpu, target, diff === 'genius' ? 900 : 320);
  if (!candidates.length) return false;

  if (candidates.length === 1 && hiddenCount(target) <= (diff === 'genius' ? 5 : 3)) {
    const chance = diff === 'genius' ? 0.92 : 0.62;
    if (Math.random() < chance) {
      guessFullInternal(room, cpu, target, candidates[0].word, false);
      return true;
    }
  }
  if (diff === 'genius' && candidates.length <= 3 && hiddenCount(target) <= 2 && Math.random() < 0.55) {
    guessFullInternal(room, cpu, target, candidates[0].word, false);
    return true;
  }
  return false;
}
function cpuTakeAction(room) {
  if (room.status !== 'playing') return;
  if (!gameActionsReady(room)) return;
  const cpu = activePlayer(room);
  if (!cpu?.isCpu || room.awaitingExpose) return;
  const target = chooseCpuTarget(room, cpu);
  if (!target) return advanceTurnAfterMiss(room);
  if (cpuMaybeFullGuess(room, cpu, target)) return;
  const symbol = chooseCpuSymbol(room, cpu, target);
  askSymbolInternal(room, cpu, target, symbol);
}

function autoResolveCpuExpose(room) {
  const pending = room.awaitingExpose;
  if (!pending) return;
  const target = getPlayer(room, pending.playerId);
  if (!target?.isCpu) return;
  const diff = cpuDifficulty(target, room);
  let idx = rand(pending.allowedIndices);
  if (diff === 'hard' || diff === 'genius') {
    idx = [...pending.allowedIndices].sort((a, b) => SLOT_VALUES[a] - SLOT_VALUES[b])[0];
  }
  chooseExposeInternal(room, target, idx);
}

function maybeScheduleAi(room) {
  if (room.status !== 'playing') return;
  if (!room.settings?.aiEnabled) return;
  if (gameIntroActive(room)) return;
  if (room.aiTimer) return;

  // v4.23: an active CPU may be waiting on a human player to flip the correct card.
  // Do not keep re-scheduling CPU turns while a human/manual exposure is pending.
  // The CPU only auto-acts during a pending exposure when the pending target is also a CPU.
  if (room.awaitingExpose) {
    const pendingTarget = getPlayer(room, room.awaitingExpose.playerId);
    if (!pendingTarget?.isCpu) return;
  } else if (!activePlayer(room)?.isCpu) {
    return;
  }

  const serial = ++room.aiSerial;
  const baseDelay = room.awaitingExpose ? 1800 : 2600;
  const announcementDelay = Math.max(0, (room.effectsQuietUntil || 0) - Date.now() + AI_ANNOUNCEMENT_SAFETY_MS);
  const delay = Math.max(baseDelay, announcementDelay);
  room.aiTimer = setTimeout(() => {
    room.aiTimer = null;
    if (serial !== room.aiSerial) return;
    if (room.status !== 'playing') return;
    if (gameIntroActive(room)) return;
    if ((room.effectsQuietUntil || 0) > Date.now()) {
      maybeScheduleAi(room);
      return;
    }
    if (!gameActionsReady(room)) {
      maybeScheduleAi(room);
      return;
    }

    if (room.awaitingExpose) {
      if (getPlayer(room, room.awaitingExpose.playerId)?.isCpu) {
        autoResolveCpuExpose(room);
        broadcast(room);
      }
      return;
    }

    if (activePlayer(room)?.isCpu) {
      cpuTakeAction(room);
      broadcast(room);
    }
  }, delay);
}

function guessFullInternal(room, guesser, target, guess, interruptive) {
  if (!gameActionsReady(room)) return { ok: false, message: 'Wait for the card or result animation to finish.' };
  if (!guesser || !target || target.id === guesser.id) return { ok: false, message: 'Choose a valid opponent.' };
  const isInterrupt = !!interruptive;
  const active = activePlayer(room);
  if (!isInterrupt && active?.id !== guesser.id) return { ok: false, message: 'Full guesses on your turn only, unless using interruptive guess.' };
  if (isInterrupt && hiddenCount(target) < 5) return { ok: false, message: 'Interruptive guesses are only allowed when that opponent has 5 or more hidden spaces.' };
  if (room.challengeMode && (guesser.id !== room.challengeMode.playerId || target.id !== room.challengeMode.targetId || isInterrupt)) {
    return { ok: false, message: 'Challenge mode can only target the remaining opponent word.' };
  }
  const raw = String(guess || '').trim().toUpperCase();
  if (!raw) return { ok: false, message: 'Enter a full word or full tray pattern.' };
  if (room.dailyPuzzle && !guesser.isCpu && !guesser.isLocal) room.dailyGuessCount = (room.dailyGuessCount || 0) + 1;
  const normalizedFull = raw.replace(/DOT/g, '.').replace(/[^A-Z.]/g, '');
  const fullPattern = target.slots.map(s => slotHasCard(s) ? s.ch : '').join('');
  const wordOnly = target.word;
  const correct = normalizedFull === fullPattern || normalizedFull === wordOnly;

  if (correct) {
    if (room.challengeMode) {
      const hiddenAward = hiddenGuessSlotValue(target, normalizedFull === fullPattern);
      const totalAward = Math.round(hiddenAward.points * challengeMultiplier(room));
      target.slots.forEach(s => { s.revealed = true; });
      guesser.score += totalAward;
      addLog(room, `${guesser.name} completed the 1v1 challenge and solved ${target.name}'s word. +${totalAward} scaled hidden points.`);
      addEffect(room, 'correct-full', `${guesser.name} solved the challenge word. +${totalAward}`, { actorId: guesser.id, targetId: target.id, points: totalAward, hiddenPoints: hiddenAward.points, solvedWord: solvedWordText(target) });
      addWordSolvedEffect(room, target, guesser.id);
      room.challengeMode = null;
      checkGameEnd(room);
      return { ok: true };
    }
    const baseAward = isInterrupt ? 100 : 50;
    const hiddenAward = hiddenGuessSlotValue(target, normalizedFull === fullPattern);
    const totalAward = baseAward + hiddenAward.points;
    target.slots.forEach(s => { s.revealed = true; });
    guesser.score += totalAward;
    const hiddenText = hiddenAward.points > 0 ? ` + ${hiddenAward.points} hidden slot points` : '';
    addLog(room, `${guesser.name} correctly guessed ${target.name}'s ${normalizedFull === fullPattern ? 'full tray' : 'word'} and revealed it. +${totalAward} points (${baseAward} solve bonus${hiddenText}).`);
    addEffect(room, 'correct-full', `${guesser.name} solved ${target.name}'s tray. +${totalAward}`, { actorId: guesser.id, targetId: target.id, points: totalAward, hiddenPoints: hiddenAward.points, solvedWord: solvedWordText(target) });
    addWordSolvedEffect(room, target, guesser.id);
    maybeCreateChallengeOffer(room, target, guesser.id);
    checkGameEnd(room);
    if (!isInterrupt && room.status === 'playing') {
      if (!skipActiveIfNoValidTarget(room)) {
        addLog(room, `${guesser.name} continues after a correct full guess.`);
        setTurnTimer(room);
      }
    }
  } else {
    if (room.challengeMode) {
      addLog(room, `${guesser.name} made a wrong challenge guess. Multiplier drops.`);
      addEffect(room, 'bad-guess', `${guesser.name} made a wrong challenge guess.`, { actorId: guesser.id, targetId: target.id });
      afterChallengeGuess(room);
      return { ok: true };
    }
    guesser.score -= isInterrupt ? 50 : 100;
    addLog(room, `${guesser.name} guessed ${target.name}'s word/tray incorrectly. -${isInterrupt ? 50 : 100} points.`);
    addEffect(room, 'bad-guess', `${guesser.name} made a wrong full guess. -${isInterrupt ? 50 : 100}`, { actorId: guesser.id, targetId: target.id });
    if (!isInterrupt && active?.id === guesser.id) advanceTurnAfterMiss(room);
  }
  return { ok: true };
}

function makeCpuToken(room) {
  let token;
  do token = `cpu_${Math.random().toString(36).slice(2, 12)}`; while (getPlayer(room, token));
  return token;
}

function nextCpuName(room) {
  const used = new Set(room.players.map(p => p.name));
  return CPU_NAMES.find(n => !used.has(n)) || `CPU ${room.players.filter(p => p.isCpu).length + 1}`;
}

function makeLocalToken(room) {
  let token;
  do token = `local_${Math.random().toString(36).slice(2, 12)}`; while (getPlayer(room, token));
  return token;
}

io.on('connection', (socket) => {

  socket.on('joinDiscordActivityRoom', (payload = {}) => {
    const result = joinExistingOrNewDiscordRoom(socket, payload);
    if (!result.ok) return emitError(socket, result.message);
    socket.emit('joined', { code: result.room.code, playerId: result.player.id, token: result.token, discordActivity: true });
    if (result.created) addLog(result.room, `${result.player.name} started the Discord Activity room.`);
    else addLog(result.room, `${result.player.name} connected through Discord Activity.`);
    broadcast(result.room);
  });

  socket.on('createRoom', ({ name, token, avatar } = {}) => {
    const safeToken = cleanToken(token);
    const room = newRoom(socket.id, name, safeToken);
    const cleanedAvatar = cleanAvatarData(avatar) || String(avatar || '').slice(0, 300);
    if (cleanedAvatar) room.players[0].avatar = cleanedAvatar;
    socket.join(room.code);
    socket.emit('joined', { code: room.code, playerId: room.players[0].id, token: safeToken });
    broadcast(room);
  });

  socket.on('startDailyPuzzle', ({ name, token, avatar, date } = {}) => {
    if (getRoomOfSocket(socket.id)) return emitError(socket, 'Leave your current room before starting the Daily Puzzle.');
    const safeToken = cleanToken(token);
    const puzzle = dailyPuzzleFor(date);
    const room = newRoom(socket.id, name, safeToken);
    const cleanedAvatar = cleanAvatarData(avatar) || String(avatar || '').slice(0, 300);
    if (cleanedAvatar) room.players[0].avatar = cleanedAvatar;
    room.dailyPuzzle = true;
    room.dailyPuzzleKey = puzzle.key;
    room.dailyPuzzleInfo = puzzle;
    room.dailyStartedAt = null;
    room.dailyFinishedAt = null;
    room.dailyGuessCount = 0;
    room.dailyScore = null;
    room.dailyElapsedMs = null;
    room.dailyLeaderboardSubmitted = false;
    room.settings.aiEnabled = false;
    room.settings.cpuDifficulty = puzzle.difficulty || 'genius';
    room.settings.useThemes = false;
    room.settings.themeMode = 'none';
    room.settings.themeSelectionMethod = 'host';
    room.currentTheme = null;
    room.players[0].ready = true;
    room.players[0].word = '';
    room.players[0].trayPattern = '';
    room.players[0].slots = emptyRevealedSlots();
    const cpuResult = addCpuPlayer(room, puzzle.difficulty || 'genius');
    if (cpuResult.ok) {
      cpuResult.cpu.name = puzzle.cpuName || 'Wolt';
      cpuResult.cpu.cpuDifficulty = puzzle.difficulty || 'genius';
      cpuResult.cpu.avatar = cpuAvatarForName(cpuResult.cpu.name);
      if (!cpuResult.cpu.ready) autoAssignCpuSecret(room, cpuResult.cpu);
    }
    room.settings.aiEnabled = false;
    room.status = 'playing';
    room.turnIndex = 0;
    room.rulesIntroPending = false;
    room.rulesIntroAcknowledged = true;
    room.startingIntro = false;
    room.dailyStartedAt = Date.now();
    addLog(room, `Daily Puzzle ${puzzle.key}: ${puzzle.clue}.`);
    addLog(room, 'Daily Puzzle mode: solve Wolt\'s word. Your tray is not in play.');
    startTurn(room, true);
    socket.join(room.code);
    socket.emit('joined', { code: room.code, playerId: room.players[0].id, token: safeToken, dailyPuzzle: true });
    broadcast(room);
  });

  socket.on('findRandomMatch', ({ name, token, avatar } = {}) => {
    if (getRoomOfSocket(socket.id)) return emitError(socket, 'Leave your current room before joining Random Online.');
    const safeToken = cleanToken(token);
    const cleanedAvatar = cleanAvatarData(avatar) || String(avatar || '').slice(0, 300);
    const waiting = randomOnlineWaitingRoom(safeToken);
    if (waiting) {
      const player = newPlayer(socket.id, name, safeToken, false, { avatar: cleanedAvatar });
      waiting.players.push(player);
      socket.join(waiting.code);
      markRandomRoomMatched(waiting);
      addLog(waiting, `${player.name} joined from Random Online.`);
      socket.emit('joined', { code: waiting.code, playerId: player.id, token: safeToken, randomOnline: true });
      io.to(waiting.players[0].socketId).emit('randomMatchStatus', 'Matched! A random opponent joined.');
      socket.emit('randomMatchStatus', 'Matched! You joined a Random Online room.');
      broadcast(waiting);
      return;
    }

    const room = newRoom(socket.id, name, safeToken);
    if (cleanedAvatar) room.players[0].avatar = cleanedAvatar;
    room.randomOnline = true;
    enforceRandomCompetitiveSettings(room);
    room.randomQueueOpen = true;
    room.randomWaitingSince = Date.now();
    room.randomCpuFallbackUsed = false;
    scheduleRandomFallbackOffer(room);
    socket.join(room.code);
    addLog(room, 'Random Online waiting room created. Waiting for another player.');
    socket.emit('joined', { code: room.code, playerId: room.players[0].id, token: safeToken, randomOnline: true });
    socket.emit('randomMatchStatus', 'Waiting for a random online player...');
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, name, token, avatar } = {}) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return emitError(socket, 'Room not found. Check the room code.');
    const safeToken = cleanToken(token);
    const cleanedAvatar = cleanAvatarData(avatar) || String(avatar || '').slice(0, 300);
    const existing = getPlayerByToken(room, safeToken);
    if (existing && !existing.isCpu && !existing.isLocal) {
      attachSocketToPlayer(room, existing, socket, name, cleanedAvatar);
      addLog(room, `${existing.name} rejoined the room.`);
      socket.emit('joined', { code: room.code, playerId: existing.id, token: safeToken });
      broadcast(room);
      return;
    }

    if (room.status !== 'lobby') return emitError(socket, 'That game already started.');
    if (room.players.length >= MAX_PLAYERS) return emitError(socket, 'That room is full.');

    const player = newPlayer(socket.id, name, safeToken, false, { avatar: cleanedAvatar });
    room.players.push(player);
    socket.join(room.code);
    if (room.randomOnline && room.randomQueueOpen && connectedHumanOnlinePlayers(room).length >= 2) markRandomRoomMatched(room);
    socket.emit('joined', { code: room.code, playerId: player.id, token: safeToken });
    addLog(room, `${player.name} joined the room.`);
    broadcast(room);
  });

  socket.on('spectateRoom', ({ code, name, token } = {}) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return emitError(socket, 'Room not found. Check the room code.');
    const safeToken = cleanToken(token || makeToken('spec_'));
    room.spectators = (room.spectators || []).filter(s => s.token !== safeToken && s.socketId !== socket.id);
    const spectator = {
      id: `spec_${safeToken.slice(0, 18)}`,
      token: safeToken,
      name: cleanName(name || 'Spectator'),
      socketId: socket.id,
      joinedAt: Date.now()
    };
    room.spectators.push(spectator);
    socket.join(room.code);
    socket.emit('joined', { code: room.code, playerId: spectator.id, token: safeToken, spectator: true });
    addLog(room, `${spectator.name} is spectating.`);
    broadcast(room);
  });

  socket.on('reconnectRoom', ({ code, name, token, avatar } = {}) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return emitError(socket, 'Could not reconnect: room not found.');
    const safeToken = cleanToken(token);
    const cleanedAvatar = cleanAvatarData(avatar) || String(avatar || '').slice(0, 300);
    const player = getPlayerByToken(room, safeToken);
    if (!player || player.isCpu || player.isLocal) return emitError(socket, 'Could not reconnect: player not found in that room.');
    attachSocketToPlayer(room, player, socket, name, cleanedAvatar);
    addLog(room, `${player.name} reconnected.`);
    socket.emit('joined', { code: room.code, playerId: player.id, token: safeToken });
    broadcast(room);
  });



  socket.on('setAvatar', ({ playerId, avatar }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    const self = socketPlayer(room, socket);
    const targetId = playerId || self?.id;
    if (!self || !canControlPlayer(room, self, targetId)) return emitError(socket, 'You cannot change that avatar.');
    const target = getPlayer(room, targetId);
    if (!target || target.isCpu) return emitError(socket, 'Choose a human/local player.');
    const cleaned = cleanAvatarData(avatar);
    if (cleaned === null) return emitError(socket, 'Avatar must be a small PNG, JPG, or WebP image.');
    target.avatar = cleaned;
    addLog(room, `${target.name} updated an avatar.`);
    broadcast(room);
  });

  socket.on('submitThemeSuggestion', ({ themeId, customThemeName } = {}) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    if (room.randomOnline) return emitError(socket, 'Random Online chooses themes automatically.');
    if (room.status !== 'lobby') return emitError(socket, 'Theme suggestions are only open in the lobby.');
    const self = socketPlayer(room, socket);
    if (!self || self.isCpu) return emitError(socket, 'Only players can suggest themes.');
    const mode = normalizeThemeMode(room.settings.themeMode, room.settings.useThemes);
    if (!['database', 'custom'].includes(mode)) return emitError(socket, 'This theme mode does not use player suggestions.');
    let suggestion = null;
    if (mode === 'database') {
      if (!THEME_MAP.has(themeId)) return emitError(socket, 'Choose a theme from the database.');
      suggestion = { playerId: self.id, type: 'database', themeId };
    } else {
      const clean = cleanThemeName(customThemeName);
      if (!clean) return emitError(socket, 'Type a custom theme.');
      suggestion = { playerId: self.id, type: 'custom', name: clean };
    }
    suggestion.id = suggestionIdForThemeSuggestion(suggestion);
    room.themeSuggestions[self.id] = suggestion;
    room.themeVotes = {};
    addLog(room, `${self.name} submitted a theme suggestion.`);
    broadcast(room);
  });

  socket.on('voteThemeSuggestion', ({ suggestionId } = {}) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    if (room.randomOnline) return emitError(socket, 'Random Online chooses themes automatically.');
    if (room.status !== 'lobby') return emitError(socket, 'Theme voting is only open in the lobby.');
    const self = socketPlayer(room, socket);
    if (!self || self.isCpu) return emitError(socket, 'Only players can vote on themes.');
    if (normalizeThemeSelectionMethod(room.settings.themeSelectionMethod) !== 'vote') return emitError(socket, 'Theme voting is not enabled.');
    const valid = roomThemeSuggestions(room).some(s => s.id === suggestionId);
    if (!valid) return emitError(socket, 'Choose a submitted theme.');
    room.themeVotes[self.id] = String(suggestionId);
    broadcast(room);
  });

  socket.on('setSettings', (incoming = {}) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    const self = socketPlayer(room, socket);
    if (room.hostId !== self?.id) return emitError(socket, 'Only the host can change settings.');
    if (room.status !== 'lobby' && room.status !== 'setup') return emitError(socket, 'Settings can only be changed before or during setup.');

    if ('turnTimerSec' in incoming) {
      const value = Number.parseInt(incoming.turnTimerSec, 10);
      if (!VALID_TIMERS.has(value)) return emitError(socket, 'Invalid timer value.');
      room.settings.turnTimerSec = value;
    }
    if (!room.randomOnline) {
      if ('themeMode' in incoming || 'useThemes' in incoming) {
        const nextMode = normalizeThemeMode(incoming.themeMode, incoming.useThemes !== undefined ? !!incoming.useThemes : room.settings.useThemes);
        room.settings.themeMode = nextMode;
        room.settings.useThemes = nextMode !== 'none';
        room.themeVotes = {};
      }
      if ('themeSelectionMethod' in incoming) {
        room.settings.themeSelectionMethod = normalizeThemeSelectionMethod(incoming.themeSelectionMethod);
        room.themeVotes = {};
      }
      if ('themeId' in incoming && THEME_MAP.has(incoming.themeId)) room.settings.themeId = incoming.themeId;
      if ('customThemeName' in incoming) room.settings.customThemeName = cleanThemeName(incoming.customThemeName);
    }
    if ('sharedDevice' in incoming) room.settings.sharedDevice = !!incoming.sharedDevice;
    if ('manualReveal' in incoming) room.settings.manualReveal = !!incoming.manualReveal;
    if ('aiEnabled' in incoming) room.settings.aiEnabled = !!incoming.aiEnabled;
    if ('cpuDifficulty' in incoming && CPU_DIFFICULTIES.has(incoming.cpuDifficulty)) room.settings.cpuDifficulty = incoming.cpuDifficulty;
    enforceRandomCompetitiveSettings(room);

    addLog(room, 'Host updated game settings.');
    broadcast(room);
  });

  socket.on('addCpu', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    const self = socketPlayer(room, socket);
    if (room.hostId !== self?.id) return emitError(socket, 'Only the host can add CPU players.');
    if (room.status !== 'lobby' && room.status !== 'setup') return emitError(socket, 'CPU players can only be added before the game starts.');
    const result = addCpuPlayer(room, room.settings.cpuDifficulty || 'medium');
    if (!result.ok) return emitError(socket, result.message);
    if (room.randomOnline) {
      clearRandomFallbackTimer(room);
      room.randomQueueOpen = false;
      room.randomWaitingSince = null;
      room.randomCpuFallbackUsed = true;
      enforceRandomCompetitiveSettings(room);
      assignRandomOnlineTheme(room);
    }
    broadcast(room);
  });

  socket.on('randomCpuFallback', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    const self = socketPlayer(room, socket);
    if (room.hostId !== self?.id) return emitError(socket, 'Only the host can choose CPU fallback.');
    if (!randomCpuFallbackAvailable(room)) return emitError(socket, 'Keep waiting a little longer for a random player.');
    const result = addCpuPlayer(room, 'medium');
    if (!result.ok) return emitError(socket, result.message);
    clearRandomFallbackTimer(room);
    room.randomQueueOpen = false;
    room.randomWaitingSince = null;
    room.randomCpuFallbackUsed = true;
    enforceRandomCompetitiveSettings(room);
    assignRandomOnlineTheme(room);
    addLog(room, 'Random Online fallback selected: playing against an Experimental CPU.');
    broadcast(room);
  });


  socket.on('addLocalPlayer', ({ name }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    const self = socketPlayer(room, socket);
    if (room.hostId !== self?.id) return emitError(socket, 'Only the host can add local seats.');
    if (room.status !== 'lobby' && room.status !== 'setup') return emitError(socket, 'Local seats can only be added before the game starts.');
    if (room.players.length >= MAX_PLAYERS) return emitError(socket, 'That room is full.');
    room.settings.sharedDevice = true;
    const safeName = cleanName(name || `Seat ${room.players.filter(p => p.isLocal).length + 2}`);
    const local = newPlayer(null, safeName, makeLocalToken(room), false, { isLocal: true });
    room.players.push(local);
    addLog(room, `${local.name} was added as a local shared-device seat.`);
    broadcast(room);
  });

  socket.on('kickPlayer', ({ playerId }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    const self = socketPlayer(room, socket);
    if (!self || room.hostId !== self.id) return emitError(socket, 'Only the host can remove players.');
    if (room.status !== 'lobby' && room.status !== 'setup') return emitError(socket, 'Players can only be removed before the game starts.');
    if (playerId === self.id) return emitError(socket, 'The host cannot remove themselves.');
    const removed = removePlayer(room, playerId, 'kicked');
    if (!removed) return emitError(socket, 'Player not found.');
    addLog(room, `${removed.name} was removed by the host.`);
    broadcast(room);
  });

  socket.on('startSetup', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    const self = socketPlayer(room, socket);
    if (room.hostId !== self?.id) return emitError(socket, 'Only the host can start setup.');
    if (room.players.length < MIN_PLAYERS) return emitError(socket, 'You need at least 2 players or one AI/local seat.');
    room.status = 'setup';
    if (room.randomOnline) {
      if (!room.randomMatchedAt && !room.randomCpuFallbackUsed) assignRandomOnlineTheme(room);
    } else {
      room.currentTheme = selectCurrentTheme(room);
    }
    room.rulesIntroPending = false;
    room.rulesIntroAcknowledged = false;
    room.challengeOffer = null;
    room.challengeMode = null;
    room.players.forEach(p => {
      p.ready = false;
      p.slots = null;
      p.word = '';
      p.trayPattern = '';
      p.score = 0;
      p.memory = {};
      p.randomAway = false;
      clearRandomAwayTimer(room, p.id);
    });
    room.players.filter(p => p.isCpu).forEach(cpu => autoAssignCpuSecret(room, cpu));
    addLog(room, 'Secret word setup started.');
    if (room.currentTheme) {
      addLog(room, `Round theme selected: ${room.currentTheme.emoji} ${room.currentTheme.name}.`);
      addEffect(room, 'theme-reveal', `Theme revealed: ${room.currentTheme.name}`, { theme: publicTheme(room) });
    } else if (room.randomOnline) {
      addLog(room, 'Random Online theme result: No Theme.');
      addEffect(room, 'theme-reveal', 'Theme revealed: No Theme', { theme: null, noTheme: true });
    }
    startIfReady(room);
    broadcast(room);
  });

  socket.on('submitSecret', ({ word, tray, leftDots } = {}) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    if (room.status !== 'setup') return emitError(socket, 'Secret words can only be entered during setup.');
    const player = socketPlayer(room, socket);
    if (!player) return emitError(socket, 'Player not found.');
    const result = applySecret(room, player, tray ?? word, leftDots, player.name);
    if (!result.ok) return emitError(socket, result.message);
    startIfReady(room);
    broadcast(room);
  });

  socket.on('submitSecretForPlayer', ({ playerId, word, tray, leftDots } = {}) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    if (room.status !== 'setup') return emitError(socket, 'Secret words can only be entered during setup.');
    const self = socketPlayer(room, socket);
    if (!self || !canControlPlayer(room, self, playerId)) return emitError(socket, 'You cannot set that player’s tray.');
    const player = getPlayer(room, playerId);
    if (!player || player.isCpu) return emitError(socket, 'Choose a local/non-CPU player.');
    const result = applySecret(room, player, tray ?? word, leftDots, self.id === player.id ? player.name : `${self.name} (host)`);
    if (!result.ok) return emitError(socket, result.message);
    startIfReady(room);
    broadcast(room);
  });

  socket.on('rulesIntroGotIt', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing' || !room.rulesIntroPending) return;
    const self = socketPlayer(room, socket);
    if (!self || room.hostId !== self.id) return emitError(socket, 'Waiting for the host to continue.');
    beginStarterIntro(room);
    broadcast(room);
  });

  socket.on('challengeDecision', ({ continueChallenge } = {}) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing' || !room.challengeOffer) return emitError(socket, 'No challenge decision is pending.');
    const self = socketPlayer(room, socket);
    const offer = room.challengeOffer;
    if (!self || !canControlPlayer(room, self, offer.playerId)) return emitError(socket, 'Only the challenged player can choose.');
    const chooser = getPlayer(room, offer.playerId) || self;
    if (!continueChallenge) {
      const winner = getPlayer(room, offer.targetId);
      finishRoom(room, `${chooser.name} accepted defeat. Winner: ${winner?.name || 'Opponent'}.`);
      broadcast(room);
      return;
    }
    room.challengeMode = { playerId: chooser.id, targetId: offer.targetId, multiplier: 1, guesses: 0, startedAt: Date.now() };
    room.challengeOffer = null;
    room.awaitingExpose = null;
    room.currentCard = null;
    room.additionalTurnOnMiss = false;
    room.additionalTurnOwnerId = null;
    const idx = room.players.findIndex(p => p.id === chooser.id);
    if (idx >= 0) room.turnIndex = idx;
    addLog(room, `${chooser.name} continues the 1v1 challenge. Every guess has 10 seconds.`);
    addEffect(room, 'challenge-start', `${chooser.name} continues the challenge. 10 seconds per guess.`, { actorId: chooser.id, targetId: offer.targetId });
    setChallengeTimer(room);
    broadcast(room);
  });

  socket.on('askSymbol', ({ targetId, symbol, actorId }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    if (gameIntroActive(room)) return emitError(socket, 'Wait for the starting randomizer to finish.');
    const asker = resolveActor(room, socket, actorId);
    const target = getPlayer(room, targetId);
    const result = askSymbolInternal(room, asker, target, symbol);
    if (!result.ok) return emitError(socket, result.message);
    broadcast(room);
  });

  socket.on('chooseExpose', ({ index, actorId }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    if (gameIntroActive(room)) return emitError(socket, 'Wait for the starting randomizer to finish.');
    const self = socketPlayer(room, socket);
    const pending = room.awaitingExpose;
    if (!pending) return emitError(socket, 'There is no exposure choice pending.');
    const target = getPlayer(room, pending.playerId);
    if (!canControlPlayer(room, self, target?.id)) return emitError(socket, 'This exposure choice is not yours.');
    const idx = Number.parseInt(index, 10);
    const result = chooseExposeInternal(room, target, idx);
    if (!result.ok) return emitError(socket, result.message);
    broadcast(room);
  });

  socket.on('manualExpose', ({ targetId, index }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    if (gameIntroActive(room)) return emitError(socket, 'Wait for the starting randomizer to finish.');
    const self = socketPlayer(room, socket);
    const target = getPlayer(room, targetId);
    if (!target) return emitError(socket, 'Choose a valid target.');

    if (room.awaitingExpose && room.awaitingExpose.playerId === target.id && canControlPlayer(room, self, target.id)) {
      const idx = Number.parseInt(index, 10);
      const result = chooseExposeInternal(room, target, idx);
      if (!result.ok) return emitError(socket, result.message);
      broadcast(room);
      return;
    }

    if (!room.settings.manualReveal) return emitError(socket, 'Click-to-expose mode is turned off.');
    if (!canControlPlayer(room, self, target.id)) return emitError(socket, 'You can only click-expose your own/local tray.');
    const active = activePlayer(room);
    const scorerId = active?.id !== target.id ? active?.id : null;
    const result = manualExposeInternal(room, target, Number.parseInt(index, 10), scorerId);
    if (!result.ok) return emitError(socket, result.message);
    broadcast(room);
  });

  socket.on('verbalMiss', ({ dotPenalty, actorId }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    if (!gameActionsReady(room)) return emitError(socket, 'Wait for the card or result animation to finish.');
    if (room.awaitingExpose) return emitError(socket, 'Resolve the pending exposure first.');
    const actor = resolveActor(room, socket, actorId);
    if (!actor || activePlayer(room)?.id !== actor.id) return emitError(socket, 'It is not your turn.');
    if (dotPenalty) {
      actor.score -= 50;
      addLog(room, `${actor.name} had a verbal dot miss and loses 50 points.`);
      addEffect(room, 'dot-miss', `${actor.name} had a verbal dot miss. -50`, { actorId: actor.id });
    } else {
      addLog(room, `${actor.name} had a verbal miss.`);
      addEffect(room, 'miss', `${actor.name} missed. Turn passes.`, { actorId: actor.id });
    }
    advanceTurnAfterMiss(room);
    broadcast(room);
  });

  socket.on('giveUpTurn', ({ actorId } = {}) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    const actor = resolveActor(room, socket, actorId);
    const result = giveUpTurn(room, actor);
    if (!result.ok) return emitError(socket, result.message);
    broadcast(room);
  });

  socket.on('guessFull', ({ targetId, guess, interruptive, actorId }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    if (gameIntroActive(room)) return emitError(socket, 'Wait for the starting randomizer to finish.');
    if (room.awaitingExpose) return emitError(socket, 'Wait for the pending exposure choice first.');
    const guesser = resolveActor(room, socket, actorId);
    const target = getPlayer(room, targetId);
    const result = guessFullInternal(room, guesser, target, guess, interruptive);
    if (!result.ok) return emitError(socket, result.message);
    broadcast(room);
  });


  socket.on('mediaState', ({ cameraOn, micOn } = {}) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return;
    const self = socketPlayer(room, socket);
    if (!self || self.isCpu || self.isLocal) return;
    self.media = { cameraOn: !!cameraOn, micOn: !!micOn };
    socket.to(room.code).emit('mediaStateUpdated', { playerId: self.id, media: self.media });
    socket.emit('mediaStateUpdated', { playerId: self.id, media: self.media });
    broadcast(room);
  });

  socket.on('mediaSignal', ({ to, type, payload } = {}) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return;
    const fromPlayer = socketPlayer(room, socket);
    const toPlayer = getPlayer(room, String(to || ''));
    if (!fromPlayer || fromPlayer.isCpu || fromPlayer.isLocal) return;
    if (!toPlayer || toPlayer.isCpu || toPlayer.isLocal || !toPlayer.connected || !toPlayer.socketId) return;
    if (!['offer','answer','ice'].includes(String(type || ''))) return;
    io.to(toPlayer.socketId).emit('mediaSignal', { from: fromPlayer.id, type, payload });
  });

  socket.on('randomPresence', ({ away } = {}) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return;
    const self = socketPlayer(room, socket);
    if (!self || self.isCpu || self.isLocal || !room.randomOnline) return;
    if (!randomOnlinePenaltyActive(room)) return;
    if (away) {
      startRandomAwayTimer(room, self);
    } else {
      self.randomAway = false;
      clearRandomAwayTimer(room, self.id);
    }
    broadcast(room);
  });

  socket.on('forceNextTurn', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    if (!gameActionsReady(room)) return emitError(socket, 'Wait for the card or result animation to finish.');
    const self = socketPlayer(room, socket);
    if (!self || room.hostId !== self.id) return emitError(socket, 'Only the host can force the next turn.');
    room.awaitingExpose = null;
    const nextIdx = nextConnectedTurnIndex(room, room.turnIndex);
    if (nextIdx >= 0) room.turnIndex = nextIdx;
    addLog(room, 'Host forced the next turn.');
    startTurn(room, false);
    broadcast(room);
  });

  socket.on('restartRoom', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    const self = socketPlayer(room, socket);
    if (!self || room.hostId !== self.id) return emitError(socket, 'Only the host can reset the room.');
    room.status = 'lobby';
    room.currentTheme = null;
    room.turnEndsAt = null;
    room.startingIntro = false;
    room.rulesIntroPending = false;
    room.rulesIntroAcknowledged = false;
    if (room.startIntroTimer) { clearTimeout(room.startIntroTimer); room.startIntroTimer = null; }
    room.dailyStartedAt = null;
    room.dailyFinishedAt = null;
    room.dailyGuessCount = 0;
    room.dailyScore = null;
    room.dailyElapsedMs = null;
    room.dailyLeaderboardSubmitted = false;
    room.deck = makeDeck();
    room.discard = [];
    room.currentCard = null;
    room.turnIndex = 0;
    room.multiplier = 1;
    room.firstGuessAvailable = true;
    room.additionalTurnOnMiss = false;
    room.additionalTurnOwnerId = null;
    room.awaitingExpose = null;
    room.endedReason = '';
    room.endedAt = null;
    room.aiSerial++;
    room.effectsQuietUntil = 0;
    if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
    for (const p of room.players) {
      p.score = 0;
      p.ready = false;
      p.slots = null;
      p.word = '';
      p.trayPattern = '';
      p.memory = {};
      p.randomAway = false;
      p.randomTurnForfeit = false;
      clearRandomAwayTimer(room, p.id);
      clearRandomForfeitTimer(room, p.id);
    }
    if (room.dailyPuzzle) {
      room.status = 'playing';
      room.currentTheme = null;
      room.settings.aiEnabled = false;
      room.players.filter(p => !p.isCpu).forEach(p => {
        p.ready = true;
        p.slots = emptyRevealedSlots();
      });
      room.players.filter(p => p.isCpu).forEach(cpu => autoAssignCpuSecret(room, cpu));
      room.log = [`Daily Puzzle ${room.dailyPuzzleKey} restarted.`];
      room.dailyStartedAt = Date.now();
      startTurn(room, true);
    } else {
      room.log = ['Room reset.'];
    }
    broadcast(room);
  });

  socket.on('leaveRoom', () => {
    let room = getRoomOfSocket(socket.id);
    const spectatorRoom = room ? null : getSpectatorRoomOfSocket(socket.id);
    if (spectatorRoom) {
      spectatorRoom.spectators = (spectatorRoom.spectators || []).filter(s => s.socketId !== socket.id);
      socket.leave(spectatorRoom.code);
      broadcast(spectatorRoom);
      return;
    }
    if (!room) return;
    const player = socketPlayer(room, socket);
    if (!player) return;
    if (player.media) player.media = { cameraOn: false, micOn: false };
    socket.to(room.code).emit('mediaStateUpdated', { playerId: player.id, media: player.media || { cameraOn: false, micOn: false } });
    removePlayer(room, player.id, 'left');
    socket.leave(room.code);
    addLog(room, `${player.name} left the room.`);
    if (room.players.length === 0) deleteRoom(room);
    else broadcast(room);
  });

  socket.on('disconnect', () => {
    const spectatorRoom = getSpectatorRoomOfSocket(socket.id);
    if (spectatorRoom) {
      spectatorRoom.spectators = (spectatorRoom.spectators || []).filter(s => s.socketId !== socket.id);
      broadcast(spectatorRoom);
      return;
    }
    const room = getRoomOfSocket(socket.id);
    if (!room) return;
    const player = socketPlayer(room, socket);
    if (player) {
      player.connected = false;
      player.socketId = null;
      player.media = { cameraOn: false, micOn: false };
      socket.to(room.code).emit('mediaStateUpdated', { playerId: player.id, media: player.media });
      addLog(room, `${player.name} disconnected.`);
      // Invalidate pending bot actions so reconnecting/closing tabs cannot leave
      // an old AI timeout firing against stale turn state.
      room.aiSerial++;
      if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
      if (room.status === 'playing' && activePlayer(room)?.id === player.id) {
        if (room.disconnectTimers?.has(player.id)) clearTimeout(room.disconnectTimers.get(player.id));
        const timer = setTimeout(() => {
          room.disconnectTimers?.delete(player.id);
          if (room.status !== 'playing') return;
          const stillGone = getPlayer(room, player.id);
          if (!stillGone || stillGone.connected || activePlayer(room)?.id !== player.id) return;
          room.awaitingExpose = room.awaitingExpose?.playerId === player.id ? null : room.awaitingExpose;
          const nextIdx = nextConnectedTurnIndex(room, room.turnIndex);
          if (nextIdx >= 0) room.turnIndex = nextIdx;
          addLog(room, `${player.name}'s stale turn was skipped after disconnect.`);
          if (room.players.length) startTurn(room, false);
          broadcast(room);
        }, 10000);
        room.disconnectTimers?.set(player.id, timer);
      }
    }
    broadcast(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const anyConnected = room.players.some(p => p.connected && p.socketId);
    if (!anyConnected || now - room.createdAt > ROOM_TTL_MS) {
      if (room.aiTimer) clearTimeout(room.aiTimer);
  if (room.startIntroTimer) clearTimeout(room.startIntroTimer);
      if (room.disconnectTimers) for (const t of room.disconnectTimers.values()) clearTimeout(t);
      deleteRoom(room);
      continue;
    }

    if (room.status === 'playing' && room.challengeMode && room.turnEndsAt && now >= room.turnEndsAt) {
      const challenger = getPlayer(room, room.challengeMode.playerId);
      finishRoom(room, `${challenger?.name || 'The challenger'} ran out of time in Challenge Mode.`);
      broadcast(room);
      continue;
    }

    if (room.status === 'playing' && room.turnEndsAt && now >= room.turnEndsAt && roomAnnouncementsReady(room)) {
      const player = activePlayer(room);
      if (room.awaitingExpose) {
        addLog(room, `Time ran out while waiting for ${getPlayer(room, room.awaitingExpose.playerId)?.name || 'a player'} to expose a slot.`);
        room.awaitingExpose = null;
      } else if (player) addLog(room, `${player.name} ran out of time.`);
      advanceTurnWithoutAdditional(room);
      broadcast(room);
    }
  }
}, 1000);

server.listen(PORT, () => console.log(`Hidden Word Card Game server listening on port ${PORT}`));
