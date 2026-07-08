const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '128kb' }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const TRAY_SIZE = 12;
const SLOT_VALUES = [5, 5, 10, 15, 15, 10, 10, 15, 15, 10, 5, 5];
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const VALID_TIMERS = new Set([0, 30, 45, 60, 90, 120]);
const CPU_DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'genius']);

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


app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const THEMES = [
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

const THEME_MAP = new Map(THEMES.map(t => [t.id, t]));
const GENERAL_CPU_WORDS = ['ABOUT','ABOVE','ABROAD','ABSENT','ACCEPT','ACCESS','ACCIDENT','ACCOUNT','ACID','ACORN','ACRYLIC','ACTION','ACTIVE','ACTOR','ACUTE','ADAPT','ADDED','ADDRESS','ADJUST','ADMIT','ADULT','ADVICE','AFFAIR','AFTER','AGAIN','AGENT','AGREE','AHEAD','ALARM','ALBUM','ALERT','ALIEN','ALIVE','ALLOW','ALMOST','ALONE','ALONG','ALTER','AMBER','ANCHOR','ANCIENT','ANGLE','ANIMAL','ANSWER','ANXIETY','APPLE','APRON','AREA','ARGUE','ARROW','ASHES','ASPECT','ATOM','ATTIC','AUDIO','AUTUMN','AVOID','AWARD','AWARE','AWFUL','BACK','BACON','BADGE','BAGEL','BAKER','BALCONY','BALLOON','BANANA','BANK','BARREL','BASIC','BASKET','BATTERY','BEACH','BEACON','BEAN','BEAUTY','BEFORE','BEGIN','BEHIND','BELIEF','BELL','BELT','BERRY','BETTER','BEYOND','BICYCLE','BIRD','BIRTH','BLANKET','BLAST','BLAZER','BLEND','BLIZZARD','BLOOM','BOARD','BOAT','BODY','BOLT','BONE','BONUS','BOOK','BORDER','BOTTLE','BOTTOM','BRAIN','BRANCH','BRAVE','BREAD','BRIDGE','BRIGHT','BROKEN','BRONZE','BROTHER','BRUSH','BUBBLE','BUCKET','BUDGET','BUILDER','BULLET','BUNDLE','BURGER','BUTTON','CABIN','CABLE','CAMERA','CANDLE','CANDY','CANVAS','CARBON','CARD','CAREFUL','CARPET','CASTLE','CASUAL','CATTLE','CAUSE','CEDAR','CENTER','CEREAL','CHAIN','CHAIR','CHANGE','CHARGE','CHEESE','CHERRY','CHEST','CHICKEN','CHOICE','CHURCH','CIRCLE','CITY','CLINIC','CLOCK','CLOSET','CLOUD','COACH','COAST','COBALT','COFFEE','COLLAR','COMEDY','COMMON','COMPASS','COPPER','CORNER','COTTON','COUNTY','COUPON','COYOTE','CRADLE','CRAFT','CRANE','CRASH','CRAYON','CREAM','CREDIT','CREEK','CRICKET','CRISP','CRYSTAL','CYCLE','DAMAGE','DANGER','DEALER','DECADE','DECENT','DECIDE','DEEPER','DEFEND','DEGREE','DELIGHT','DESERT','DESIGN','DESK','DETAIL','DEVICE','DIAMOND','DINNER','DIRECT','DOCTOR','DOLLAR','DONKEY','DOOR','DOUBLE','DRAGON','DRAWER','DREAM','DRESS','DRIFT','DRIVER','DUST','EAGLE','EARLY','EARTH','ECHO','EDITOR','EFFECT','EFFORT','ELBOW','ELECTRIC','EMBER','ENGINE','ENOUGH','ESCAPE','EVENT','EVERY','EXACT','EXCITE','EXHIBIT','FABRIC','FACTOR','FAMILY','FANCY','FARMER','FATHER','FAUCET','FAVOR','FEATHER','FEATURE','FENCE','FEVER','FIELD','FIGURE','FILTER','FINAL','FINGER','FINISH','FIRE','FISHING','FLAME','FLAVOR','FLEECE','FLIGHT','FLOAT','FLOWER','FOLDER','FOREST','FORK','FORMAT','FOSSIL','FOUNTAIN','FRAME','FREEDOM','FREEZER','FRIEND','FROST','FRUIT','FUTURE','GALAXY','GARAGE','GARDEN','GARLIC','GATHER','GENTLE','GHOST','GIANT','GIFT','GINGER','GLASS','GLOBE','GLORY','GOLDEN','GRAPE','GRAPH','GRASS','GRAVITY','GREEN','GRILL','GROUND','GUITAR','HAMMER','HANDLE','HARBOR','HARVEST','HAZEL','HEALTH','HEART','HEATER','HEIGHT','HELMET','HERO','HIDDEN','HIGHER','HOCKEY','HONEY','HORSE','HOSPITAL','HOTEL','HOUSE','HUNTER','ICEBERG','IDEA','IMAGE','IMPACT','INCOME','INDEX','INSECT','ISLAND','JACKET','JELLY','JEWEL','JOB','JOIN','JUDGE','JUICE','JUNGLE','KAYAK','KETTLE','KEYBOARD','KITCHEN','KNIGHT','LABEL','LADDER','LAGOON','LANTERN','LASER','LAUNCH','LAWYER','LEADER','LEAF','LEGEND','LEMON','LETTER','LIBRARY','LIGHT','LION','LIQUID','LITTLE','LIZARD','LOCKER','LOGIC','LOTION','LUMBER','LUNCH','MACHINE','MAGNET','MARBLE','MARKET','MASTER','MATRIX','MEDAL','MEDICINE','MEMORY','METAL','METHOD','MIDDLE','MINERAL','MIRROR','MOBILE','MODEL','MONKEY','MOON','MORNING','MOTHER','MOTION','MOUNTAIN','MOVIE','MUSEUM','MUSIC','MYSTERY','NATION','NEBULA','NEEDLE','NEON','NERVE','NEST','NEWSPAPER','NICKEL','NIGHT','NOBLE','NOODLE','NORTH','NUMBER','OBJECT','OCEAN','OFFICE','ORANGE','ORBIT','OXYGEN','PAINT','PALACE','PANCAKE','PAPER','PARADE','PARK','PARTNER','PASTA','PATIENT','PEACH','PEANUT','PENCIL','PEOPLE','PEPPER','PETAL','PHANTOM','PHONE','PHOTO','PIANO','PICNIC','PICTURE','PILLOW','PIRATE','PITCH','PIZZA','PLANET','PLASTIC','PLATE','PLAYER','POCKET','POINT','POLAR','POND','PORTAL','POWDER','PRAIRIE','PRESENT','PRINTER','PRISON','PROJECT','PULSE','PUZZLE','QUARTZ','QUEEN','QUICK','QUIET','RABBIT','RADIO','RAINBOW','RANCH','RANDOM','READER','REASON','RECORD','REFLEX','REGION','REMOTE','REPAIR','RESCUE','RESORT','RIBBON','RIVER','ROCKET','ROLLER','ROOF','ROOM','ROUTER','RUBBER','SADDLE','SALAD','SALMON','SANDWICH','SATURN','SAUCE','SCHOOL','SCIENCE','SCREEN','SCRIPT','SEASON','SECRET','SHADOW','SHELTER','SHIELD','SHOE','SIGNAL','SILVER','SINGER','SKETCH','SKIING','SLEEP','SLEEVES','SLIDER','SMOKE','SNACK','SNOW','SOCCER','SODIUM','SOLAR','SPARK','SPIDER','SPIRIT','SPLASH','SPRING','SQUARE','STADIUM','STAPLE','STAR','STATION','STEAM','STEEL','STONE','STORM','STORY','STREET','STRING','STUDENT','SUGAR','SUMMER','SUNSET','SURGERY','SWITCH','TABLE','TABLET','TARGET','TEMPLE','TENNIS','THEORY','THUNDER','TIGER','TIMBER','TOAST','TOKEN','TOMATO','TONGUE','TORCH','TOWER','TRACK','TRAIL','TRAIN','TREASURE','TROPHY','TUNNEL','TURTLE','UMBRELLA','UPDATE','VALLEY','VELVET','VIDEO','VILLAGE','VIOLET','VISION','VOYAGE','WALLET','WALNUT','WATER','WEALTH','WEATHER','WINDOW','WINTER','WIZARD','WOOD','WORKER','WORLD','WRENCH','WRITER','YELLOW','ZEBRA','ZEPHYR','ZODIAC'];
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
const CPU_NAMES = ['Copper Bot', 'Brass Bot', 'Hazel CPU', 'Ivy CPU', 'Gearmind', 'Oak Bot'];

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
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
    avatar: flags.avatar || ''
  };
}

function defaultSettings() {
  return {
    turnTimerSec: 0,
    useThemes: false,
    themeMode: 'random',
    themeId: 'medical',
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
    nonNormalStreak: 0
  };
  rooms.set(code, room);
  return room;
}


function deleteRoom(roomOrCode) {
  const room = typeof roomOrCode === 'string' ? rooms.get(roomOrCode) : roomOrCode;
  if (!room) return;
  if (room.aiTimer) clearTimeout(room.aiTimer);
  if (room.disconnectTimers) for (const t of room.disconnectTimers.values()) clearTimeout(t);
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

function getPlayer(room, playerId) { return room.players.find(p => p.id === playerId); }
function getPlayerByToken(room, token) { return room.players.find(p => p.token === token); }
function socketPlayer(room, socket) { return room.players.find(p => p.socketId === socket.id); }
function activePlayer(room) { return room.players[room.turnIndex]; }

function addLog(room, message) {
  room.log.unshift(message);
  room.log = room.log.slice(0, 120);
}

function effectDurationForAiDelay(type, meta = {}) {
  if (meta?.cardCode || /^card/.test(String(type || ''))) return AI_EFFECT_DURATIONS_MS.card;
  if (type === 'cpu-action') return AI_EFFECT_DURATIONS_MS.cpu;
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
  return !!(player && player.slots && room.players.some(p => p.id !== player.id && p.slots && !allExposed(p)));
}
function canTakeTurn(room, player) {
  return isConnectedForTurn(player) && hasValidGuessTarget(room, player);
}
function turnEligiblePlayers(room) { return room.players.filter(p => canTakeTurn(room, p)); }

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
  const seconds = room.settings?.turnTimerSec || 0;
  room.turnEndsAt = seconds > 0 ? Date.now() + seconds * 1000 : null;
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

function revealSlot(room, target, index, scoringPlayerId, reason, multiplier = 1) {
  if (!target?.slots) return { ok: false, points: 0 };
  const slot = target.slots[index];
  if (!slot || !slotHasCard(slot) || slot.revealed) return { ok: false, points: 0 };

  slot.revealed = true;
  const base = slotValue(index);
  let points = 0;
  let scorerName = null;

  if (scoringPlayerId) {
    points = base * multiplier;
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

  if ((reason === 'guess' || reason === 'manual') && allExposed(target) && scoringPlayerId) {
    const scorer = getPlayer(room, scoringPlayerId);
    if (scorer) scorer.score += 50;
    addLog(room, `${scorerName} earned a 50 point bonus for exposing ${target.name}'s final hidden space.`);
  }

  addEffect(room, 'correct', `${scorerName || 'A player'} revealed ${target.name}'s ${visible}.`, { targetId: target.id, scorerId: scoringPlayerId, slotIndex: index, symbol: slot.ch, points });
  checkGameEnd(room);
  return { ok: true, points };
}

function checkGameEnd(room) {
  if (room.status !== 'playing') return;
  const done = room.players.every(p => p.slots && p.slots.every(s => !slotHasCard(s) || s.revealed));
  if (!done) return;
  room.status = 'ended';
  room.turnEndsAt = null;
  room.endedAt = Date.now();
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const high = sorted[0]?.score || 0;
  const winners = sorted.filter(p => p.score === high).map(p => p.name);
  room.endedReason = `Game over. Winner: ${winners.join(', ')} with ${high} points.`;
  addLog(room, room.endedReason);
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

function publicState(room, viewerId) {
  const active = room.status === 'playing' ? activePlayer(room) : null;
  const viewer = getPlayer(room, viewerId);
  return {
    code: room.code,
    status: room.status,
    isHost: room.hostId === viewerId,
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
      ready: p.ready,
      score: p.score,
      hiddenCount: hiddenCount(p),
      allExposed: p.slots ? allExposed(p) : false,
      publicSlots: makePublicSlots(p),
      privateSlots: p.id === viewerId ? makePrivateSlots(p) : null,
    })),
    log: room.log,
    effects: room.effects || [],
    endedReason: room.endedReason,
    endedAt: room.endedAt,
    endResults: finalResults(room)
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', publicState(room, p.id));
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
  player.word = result.word;
  player.trayPattern = result.tray;
  player.slots = result.slots;
  player.ready = true;
  addLog(room, `${sourceName} locked in ${player.name}'s secret tray.`);
  return { ok: true };
}

function selectCurrentTheme(room) {
  if (!room.settings.useThemes) return null;
  if (room.settings.themeMode === 'host' && THEME_MAP.has(room.settings.themeId)) return THEME_MAP.get(room.settings.themeId);
  return rand(THEMES);
}

function pickCpuWord(room) {
  // CPU secret words stay playable/fair. The broad word-list is used for guessing/solving,
  // but CPU players pick their own hidden words from the round theme or the curated common list.
  const pool = room.currentTheme?.words?.length ? room.currentTheme.words : GENERAL_CPU_WORDS;
  const available = pool.filter(w => /^[A-Z]{3,12}$/.test(w));
  return rand(available.length ? available : GENERAL_CPU_WORDS);
}

function autoAssignCpuSecret(room, cpu) {
  const word = pickCpuWord(room);
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
    room.turnIndex = room.players.findIndex(p => canTakeTurn(room, p));
    if (room.turnIndex < 0) room.turnIndex = room.players.findIndex(p => p.connected || p.isCpu || p.isLocal);
    if (room.turnIndex < 0) room.turnIndex = 0;
    addLog(room, 'All secret trays are ready. The game begins.');
    if (room.currentTheme) addLog(room, `Round theme: ${room.currentTheme.emoji} ${room.currentTheme.name}.`);
    startTurn(room, false);
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

    // Leaving should not leave stale AI timeouts or ghost turns behind.
    room.aiSerial++;
    if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
    if (room.disconnectTimers) { for (const t of room.disconnectTimers.values()) clearTimeout(t); room.disconnectTimers.clear(); }

    if (wasPlaying && room.players.length) {
      if (wasActive) {
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
  if (room.awaitingExpose) return { ok: false, message: 'Wait for the pending exposure choice first.' };
  if (!asker || activePlayer(room)?.id !== asker.id) return { ok: false, message: 'It is not your turn.' };
  if (!target || target.id === asker.id) return { ok: false, message: 'Choose a valid opponent.' };
  if (!target.slots) return { ok: false, message: 'That opponent has no tray.' };
  if (allExposed(target)) return { ok: false, message: 'That opponent has no hidden spaces left.' };

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
    if (normalized === '.') {
      asker.score -= 50;
      addLog(room, `${asker.name} loses 50 points for asking for a dot from a player with no hidden dot.`);
      addEffect(room, 'dot-miss', `${asker.name} asked for a dot and missed. -50`, { actorId: asker.id, targetId: target.id, symbol: normalized });
    } else {
      addEffect(room, 'miss', `${asker.name} asked ${target.name} for ${normalized}. No match.`, { actorId: asker.id, targetId: target.id, symbol: normalized });
    }
    advanceTurnAfterMiss(room);
    return { ok: true };
  }

  // v4.12: human targets always choose the card to flip, even if there is only one match.
  // This preserves the table-game feel and prevents the app from auto-revealing a player's own tray.
  // CPU targets can still resolve a single match automatically so CPU games do not feel stalled.
  if (matches.length === 1 && target.isCpu) {
    const mult = room.firstGuessAvailable ? room.multiplier : 1;
    revealSlot(room, target, matches[0], asker.id, 'guess', mult);
    room.firstGuessAvailable = false;
    if (room.status === 'playing') {
      if (!skipActiveIfNoValidTarget(room)) {
        addLog(room, `${asker.name} guessed correctly and continues.`);
        setTurnTimer(room);
      }
    }
    return { ok: true };
  }

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
  setTurnTimer(room);
  return { ok: true };
}

function chooseExposeInternal(room, target, idx) {
  const pending = room.awaitingExpose;
  if (!pending) return { ok: false, message: 'There is no exposure choice pending.' };
  if (!target || pending.playerId !== target.id) return { ok: false, message: 'This exposure choice is not yours.' };
  if (!pending.allowedIndices.includes(idx)) return { ok: false, message: 'That slot is not allowed for this exposure.' };

  const mult = pending.type === 'guess' && room.firstGuessAvailable ? room.multiplier : 1;
  revealSlot(room, target, idx, pending.scoringPlayerId, pending.type === 'guess' ? 'guess' : 'card', mult);

  let continuingAskerName = '';
  if (pending.type === 'guess') {
    room.firstGuessAvailable = false;
    continuingAskerName = getPlayer(room, pending.byPlayerId)?.name || 'The guesser';
  }

  room.awaitingExpose = null;
  if (room.status === 'playing' && !skipActiveIfNoValidTarget(room)) {
    if (continuingAskerName) addLog(room, `${continuingAskerName} guessed correctly and continues.`);
    setTurnTimer(room);
  }
  return { ok: true };
}

function manualExposeInternal(room, target, idx, scorerId) {
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
  if (!guesser || !target || target.id === guesser.id) return { ok: false, message: 'Choose a valid opponent.' };
  const isInterrupt = !!interruptive;
  const active = activePlayer(room);
  if (!isInterrupt && active?.id !== guesser.id) return { ok: false, message: 'Full guesses on your turn only, unless using interruptive guess.' };
  if (isInterrupt && hiddenCount(target) < 5) return { ok: false, message: 'Interruptive guesses are only allowed when that opponent has 5 or more hidden spaces.' };
  const raw = String(guess || '').trim().toUpperCase();
  if (!raw) return { ok: false, message: 'Enter a full word or full tray pattern.' };
  const normalizedFull = raw.replace(/DOT/g, '.').replace(/[^A-Z.]/g, '');
  const fullPattern = target.slots.map(s => slotHasCard(s) ? s.ch : '').join('');
  const wordOnly = target.word;
  const correct = normalizedFull === fullPattern || normalizedFull === wordOnly;

  if (correct) {
    target.slots.forEach(s => { s.revealed = true; });
    guesser.score += isInterrupt ? 100 : 50;
    addLog(room, `${guesser.name} correctly guessed ${target.name}'s ${normalizedFull === fullPattern ? 'full tray' : 'word'} and revealed it. +${isInterrupt ? 100 : 50} points.`);
    addEffect(room, 'correct-full', `${guesser.name} solved ${target.name}'s tray. +${isInterrupt ? 100 : 50}`, { actorId: guesser.id, targetId: target.id });
    checkGameEnd(room);
    if (!isInterrupt && room.status === 'playing') {
      if (!skipActiveIfNoValidTarget(room)) {
        addLog(room, `${guesser.name} continues after a correct full guess.`);
        setTurnTimer(room);
      }
    }
  } else {
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

  socket.on('createRoom', ({ name, token }) => {
    const safeToken = cleanToken(token);
    const room = newRoom(socket.id, name, safeToken);
    socket.join(room.code);
    socket.emit('joined', { code: room.code, playerId: room.players[0].id, token: safeToken });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, name, token }) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return emitError(socket, 'Room not found. Check the room code.');
    const safeToken = cleanToken(token);
    const existing = getPlayerByToken(room, safeToken);
    if (existing && !existing.isCpu && !existing.isLocal) {
      attachSocketToPlayer(room, existing, socket, name);
      addLog(room, `${existing.name} rejoined the room.`);
      socket.emit('joined', { code: room.code, playerId: existing.id, token: safeToken });
      broadcast(room);
      return;
    }

    if (room.status !== 'lobby') return emitError(socket, 'That game already started.');
    if (room.players.length >= MAX_PLAYERS) return emitError(socket, 'That room is full.');

    const player = newPlayer(socket.id, name, safeToken, false);
    room.players.push(player);
    socket.join(room.code);
    socket.emit('joined', { code: room.code, playerId: player.id, token: safeToken });
    addLog(room, `${player.name} joined the room.`);
    broadcast(room);
  });

  socket.on('reconnectRoom', ({ code, name, token }) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return emitError(socket, 'Could not reconnect: room not found.');
    const safeToken = cleanToken(token);
    const player = getPlayerByToken(room, safeToken);
    if (!player || player.isCpu || player.isLocal) return emitError(socket, 'Could not reconnect: player not found in that room.');
    attachSocketToPlayer(room, player, socket, name);
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
    if ('useThemes' in incoming) room.settings.useThemes = !!incoming.useThemes;
    if ('themeMode' in incoming && ['random', 'host'].includes(incoming.themeMode)) room.settings.themeMode = incoming.themeMode;
    if ('themeId' in incoming && THEME_MAP.has(incoming.themeId)) room.settings.themeId = incoming.themeId;
    if ('sharedDevice' in incoming) room.settings.sharedDevice = !!incoming.sharedDevice;
    if ('manualReveal' in incoming) room.settings.manualReveal = !!incoming.manualReveal;
    if ('aiEnabled' in incoming) room.settings.aiEnabled = !!incoming.aiEnabled;
    if ('cpuDifficulty' in incoming && CPU_DIFFICULTIES.has(incoming.cpuDifficulty)) room.settings.cpuDifficulty = incoming.cpuDifficulty;

    addLog(room, 'Host updated game settings.');
    broadcast(room);
  });

  socket.on('addCpu', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    const self = socketPlayer(room, socket);
    if (room.hostId !== self?.id) return emitError(socket, 'Only the host can add CPU players.');
    return emitError(socket, 'CPU players are under construction right now.');
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
    room.currentTheme = selectCurrentTheme(room);
    room.players.forEach(p => { p.ready = false; p.slots = null; p.word = ''; p.trayPattern = ''; p.score = 0; p.memory = {}; });
    room.players.filter(p => p.isCpu).forEach(cpu => autoAssignCpuSecret(room, cpu));
    addLog(room, 'Secret word setup started.');
    if (room.currentTheme) addLog(room, `Round theme selected: ${room.currentTheme.emoji} ${room.currentTheme.name}.`);
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

  socket.on('askSymbol', ({ targetId, symbol, actorId }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    const asker = resolveActor(room, socket, actorId);
    const target = getPlayer(room, targetId);
    const result = askSymbolInternal(room, asker, target, symbol);
    if (!result.ok) return emitError(socket, result.message);
    broadcast(room);
  });

  socket.on('chooseExpose', ({ index, actorId }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
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

  socket.on('guessFull', ({ targetId, guess, interruptive, actorId }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    if (room.awaitingExpose) return emitError(socket, 'Wait for the pending exposure choice first.');
    const guesser = resolveActor(room, socket, actorId);
    const target = getPlayer(room, targetId);
    const result = guessFullInternal(room, guesser, target, guess, interruptive);
    if (!result.ok) return emitError(socket, result.message);
    broadcast(room);
  });

  socket.on('forceNextTurn', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
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
    for (const p of room.players) { p.score = 0; p.ready = false; p.slots = null; p.word = ''; p.trayPattern = ''; p.memory = {}; }
    room.log = ['Room reset.'];
    broadcast(room);
  });

  socket.on('leaveRoom', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return;
    const player = socketPlayer(room, socket);
    if (!player) return;
    removePlayer(room, player.id, 'left');
    socket.leave(room.code);
    addLog(room, `${player.name} left the room.`);
    if (room.players.length === 0) deleteRoom(room);
    else broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return;
    const player = socketPlayer(room, socket);
    if (player) {
      player.connected = false;
      player.socketId = null;
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
      if (room.disconnectTimers) for (const t of room.disconnectTimers.values()) clearTimeout(t);
      deleteRoom(room);
      continue;
    }

    if (room.status === 'playing' && room.turnEndsAt && now >= room.turnEndsAt) {
      const player = activePlayer(room);
      if (room.awaitingExpose) {
        addLog(room, `Time ran out while waiting for ${getPlayer(room, room.awaitingExpose.playerId)?.name || 'a player'} to expose a slot.`);
        room.awaitingExpose = null;
      } else if (player) addLog(room, `${player.name} ran out of time.`);
      advanceTurnAfterMiss(room);
      broadcast(room);
    }
  }
}, 1000);

server.listen(PORT, () => console.log(`Hidden Word Card Game server listening on port ${PORT}`));
