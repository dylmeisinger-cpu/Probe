const socket = io();
const DISCORD_ACTIVITY_BOOT = location.pathname === '/discord' || location.pathname === '/activity' || new URLSearchParams(location.search).has('discord_activity');
let state = null;
let showOwn = false;
let countdownTimer = null;
let suppressReconnect = false;
let lastCardId = null;
let readyCenterTurnCardId = null;
let animatingTurnCardId = null;
let soundEnabled = localStorage.getItem('probe_sound') !== 'off';
let musicEnabled = localStorage.getItem('probe_music_loop') !== 'off';
let audioCtx = null;
let sfxVolume = clamp(Number.parseFloat(localStorage.getItem('probe_sfx_volume') || '0.62'), 0, 1);
let musicVolume = clamp(Number.parseFloat(localStorage.getItem('probe_music_volume') || '0.14'), 0, 1);
let musicSource = localStorage.getItem('probe_music_source') || 'local';
let localTrackIndex = Number.parseInt(localStorage.getItem('probe_music_track_index') || '0', 10) || 0;
let musicTimer = null;
let musicPlayers = [];
let activeMusicPlayer = null;
let standbyMusicPlayer = null;
let localMusicStarted = false;
let localCrossfadeStarted = false;
let localFadeTimer = null;
let musicDuckTimer = null;
let userAudioUnlocked = false;
let spotifyConfig = null;
let spotifySdkLoading = null;
let spotifyPlayer = null;
let spotifyDeviceId = null;
let spotifyReady = false;
let spotifyPlaylists = [];
let selectedSpotifyPlaylist = localStorage.getItem('probe_spotify_playlist') || '';
let spotifyStatus = 'Not connected';
let visualSkin = localStorage.getItem('probe_visual_skin') || 'wood';
let layoutMode = localStorage.getItem('probe_layout_mode') || 'stacked';
let selectedGuessTargetId = localStorage.getItem('probe_selected_target') || '';
let seenEffectIds = new Set();
let effectQueue = [];
let effectShowing = false;
let effectTimeouts = [];
let hasReceivedInitialState = false;
let effectQueueTimer = null;
const EFFECT_INITIAL_PAUSE_MS = 1050;
const EFFECT_BETWEEN_PAUSE_MS = 850;
const TURN_CARD_HOLD_MS = 3300;
const CPU_ACTION_HOLD_MS = 1850;

const LAYOUT_MODES = [
  { id: 'stacked', name: 'Stacked Trays', icon: '▤', note: 'Classic v3/v4 view. Biggest trays in the center.' },
  { id: 'round', name: 'Round Table', icon: '◎', note: 'UNO-style seating with angled racks around the board.' }
];

const VISUAL_SKINS = [
  { id: 'wood', name: 'Warm Wood', icon: '🪵', note: 'Classic brass and walnut table.' },
  { id: 'arcade', name: 'Color Arcade', icon: '🕹️', note: 'Bright game-show colors.' },
  { id: 'neon', name: 'Midnight Neon', icon: '🌃', note: 'Dark cyber vault glow.' },
  { id: 'forest', name: 'Forest Tavern', icon: '🌲', note: 'Green, moss, and candlelight.' },
  { id: 'candy', name: 'Candy Pop', icon: '🍬', note: 'Playful pastel party mode.' },
  { id: 'slate', name: 'Clean Slate', icon: '♟️', note: 'Sharper, quieter board look.' }
];

const SOUND_ASSETS = {
  click: 'assets/sounds/ui-click.wav',
  card: 'assets/sounds/card-draw.wav',
  error: 'assets/sounds/soft-error.wav',
  flip: 'assets/sounds/flip-card.mp3',
  angel: 'assets/sounds/angels-singing.mp3',
  chaching: 'assets/sounds/cha-ching.mp3',
  boowomp: 'assets/sounds/boo-womp.mp3'
};

const MUSIC_TRACKS = [
  { id: 'blue_martini_sky', title: 'Blue Martini Sky', src: 'assets/music/blue-martini-sky.mp3' },
  { id: 'calm_jazz_4', title: 'Calm Jazz 4', src: 'assets/music/calm-jazz-4.mp3' },
  { id: 'calm_jazz', title: 'Calm Jazz', src: 'assets/music/calm-jazz.mp3' },
  { id: 'wavering_piano', title: 'Wavering Slow Jazz Piano', src: 'assets/music/wavering-slow-jazz-piano.mp3' },
  { id: 'sunset_chill', title: 'Sunset Chill Jazz', src: 'assets/music/sunset-chill-jazz.mp3' }
];
const MUSIC_CROSSFADE_MS = 5200;
const MUSIC_DUCK_MS = 1250;
const MUSIC_DUCK_RATIO = 0.28;
const SPOTIFY_STORAGE = {
  access: 'probe_spotify_access_token',
  refresh: 'probe_spotify_refresh_token',
  expiry: 'probe_spotify_expiry'
};

function isPhoneLayout() {
  return !!window.matchMedia?.('(max-width: 760px)').matches;
}

function activeBoardLayoutMode() {
  return isPhoneLayout() ? 'stacked' : layoutMode;
}


const STORAGE = {
  name: 'probe_name',
  token: 'probe_token',
  room: 'probe_room'
};

const $ = (id) => document.getElementById(id);
const LETTERS = ['Q','W','E','R','T','Y','U','I','O','P','A','S','D','F','G','H','J','K','L','Z','X','C','V','B','N','M'];

function getOrCreateToken() {
  let token = localStorage.getItem(STORAGE.token);
  if (token) return token;
  if (window.crypto?.randomUUID) token = window.crypto.randomUUID().replace(/-/g, '');
  else token = `guest_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  localStorage.setItem(STORAGE.token, token);
  return token;
}

function savedName() { return localStorage.getItem(STORAGE.name) || ''; }
function savedRoom() { return localStorage.getItem(STORAGE.room) || ''; }

function rememberRoom(code) {
  if (code) localStorage.setItem(STORAGE.room, code);
  const url = new URL(window.location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  history.replaceState({}, '', url.toString());
}

function clearSavedRoom() {
  localStorage.removeItem(STORAGE.room);
  rememberRoom('');
}

applyVisualSkin(visualSkin);
applyLayoutMode(layoutMode);

$('nameInput').value = savedName();
$('codeInput').value = new URLSearchParams(location.search).get('room') || savedRoom();
$('createBtn').addEventListener('click', () => { uiClick(); createRoom(); });
$('joinBtn').addEventListener('click', () => { uiClick(); joinRoom(); });
$('rulesBtn').addEventListener('click', () => { uiClick(); $('rulesDialog').showModal(); });
$('leaveBtn').addEventListener('click', () => { uiClick(); leaveRoom(); });
$('skinBtn').addEventListener('click', () => { uiClick(); renderSkinDialog(); $('skinDialog').showModal(); });
$('layoutBtn').addEventListener('click', () => { uiClick(); layoutMode = layoutMode === 'stacked' ? 'round' : 'stacked'; applyLayoutMode(layoutMode); if (state?.status === 'playing') renderGame(); updateChrome(); });
$('musicBtn').addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem('probe_sound', soundEnabled ? 'on' : 'off');
  updateChrome();
  if (soundEnabled) playTone([440, 660], 0.08, 0.045 * sfxVolume);
});
$('ambienceBtn').addEventListener('click', () => {
  uiClick();
  openAudioSettings();
});
$('roomPlate').addEventListener('click', () => { if (state?.code) copyText(state.code, 'Room code copied.'); });
document.addEventListener('keydown', handleGlobalGameKeys);
['pointerdown','keydown','touchstart'].forEach(evt => document.addEventListener(evt, unlockAudioFromGesture, { once: true, passive: true }));
window.addEventListener('message', handleSpotifyAuthMessage);
let phoneLayoutWasActive = isPhoneLayout();
window.addEventListener('resize', () => {
  const nowPhone = isPhoneLayout();
  if (nowPhone !== phoneLayoutWasActive) {
    phoneLayoutWasActive = nowPhone;
    if (state?.status === 'playing') renderGame();
  }
});
loadSpotifyConfig();

socket.on('connect', () => { if (!state && !suppressReconnect && !DISCORD_ACTIVITY_BOOT) attemptReconnect(); });
socket.on('disconnect', () => { if (state) showToast('Connection lost. Trying to reconnect...'); });
socket.on('joined', ({ code, token }) => {
  hasReceivedInitialState = false;
  $('codeInput').value = code;
  if (token) localStorage.setItem(STORAGE.token, token);
  rememberRoom(code);
  suppressReconnect = false;
});
socket.on('state', (next) => {
  // If the player intentionally left, ignore any late packets from the old room.
  if (suppressReconnect && (!next?.code || next.code !== savedRoom())) return;

  const oldCardId = state?.currentCard?.id || null;
  const firstStateForThisSession = !hasReceivedInitialState;
  state = next;
  hasReceivedInitialState = true;
  if (state?.code) rememberRoom(state.code);

  // On refresh/reconnect, do not replay every old animation/effect from room history.
  // Seed them as already seen and only animate new events after this point.
  if (firstStateForThisSession) {
    for (const e of (state.effects || [])) if (e?.id) seenEffectIds.add(e.id);
    if (state?.currentCard?.id) {
      lastCardId = state.currentCard.id;
      readyCenterTurnCardId = state.currentCard.id;
      animatingTurnCardId = null;
    }
  } else {
    processEffects(state.effects || []);
    if (state?.currentCard?.id && state.currentCard.id !== oldCardId && !(state.effects || []).some(e => e?.meta?.cardId === state.currentCard.id)) {
      queueEffect({ id: `fallback-${state.currentCard.id}`, type: state.currentCard.code === 'NORMAL' ? 'card-normal' : 'card-special', message: `${state.activePlayerName} drew ${state.currentCard.title}.`, meta: { cardCode: state.currentCard.code, cardId: state.currentCard.id, actorId: state.activePlayerId } });
    }
  }
  render();
});
socket.on('errorMessage', (msg) => {
  showToast(msg);
  playErrorSound();
  if (/could not reconnect/i.test(msg)) clearSavedRoom();
});
socket.on('kicked', () => {
  clearQueuedEffects();
  hasReceivedInitialState = false;
  state = null;
  clearSavedRoom();
  setVisible('home');
  updateChrome();
  showToast('You were removed from the room.');
});
socket.on('leftRoom', () => {
  clearQueuedEffects();
  hasReceivedInitialState = false;
  state = null;
  clearSavedRoom();
  setVisible('home');
  updateChrome();
});

function attemptReconnect() {
  const room = new URLSearchParams(location.search).get('room') || savedRoom();
  const name = getName(false);
  const token = getOrCreateToken();
  if (!room || !name) return;
  socket.emit('reconnectRoom', { code: room, name, token });
}

function createRoom() {
  const name = getName(true);
  socket.emit('createRoom', { name, token: getOrCreateToken() });
}

function joinRoom() {
  const name = getName(true);
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return showToast('Enter a room code.');
  socket.emit('joinRoom', { code, name, token: getOrCreateToken() });
}

function leaveRoom() {
  suppressReconnect = true;
  clearQueuedEffects();
  hasReceivedInitialState = false;
  socket.emit('leaveRoom');
  state = null;
  clearSavedRoom();
  setVisible('home');
  renderHomeHints();
  updateChrome();
}

function getName(requireValue = false) {
  const name = ($('nameInput').value || 'Player').trim().slice(0, 24);
  if (requireValue && !name) { showToast('Enter your name first.'); throw new Error('Name required'); }
  const finalName = name || 'Player';
  localStorage.setItem(STORAGE.name, finalName);
  return finalName;
}

function updateChrome() {
  $('topRoomCode').textContent = state?.code || '----';
  $('musicBtn').textContent = soundEnabled ? '♪' : '♩';
  $('musicBtn').title = `Sound effects: ${soundEnabled ? 'on' : 'off'}`;
  $('musicBtn').classList.toggle('muted', !soundEnabled);
  $('ambienceBtn').textContent = '🎧';
  $('ambienceBtn').title = `Music / Spotify settings · Music ${musicEnabled ? 'on' : 'off'}`;
  $('ambienceBtn').classList.toggle('muted', !musicEnabled);
  $('leaveBtn').style.visibility = state ? 'visible' : 'hidden';
  $('skinBtn').title = `Visual theme: ${VISUAL_SKINS.find(s => s.id === visualSkin)?.name || 'Warm Wood'}`;
  $('layoutBtn').textContent = layoutMode === 'round' ? '◎' : '▤';
  $('layoutBtn').title = `Board layout: ${LAYOUT_MODES.find(l => l.id === layoutMode)?.name || 'Stacked Trays'}`;
}

function applyLayoutMode(id) {
  layoutMode = LAYOUT_MODES.some(l => l.id === id) ? id : 'stacked';
  document.body.dataset.layout = layoutMode;
  localStorage.setItem('probe_layout_mode', layoutMode);
}

function applyVisualSkin(id) {
  const exists = VISUAL_SKINS.some(s => s.id === id);
  visualSkin = exists ? id : 'wood';
  document.body.dataset.skin = visualSkin;
  localStorage.setItem('probe_visual_skin', visualSkin);
}

function renderSkinDialog() {
  $('skinOptions').innerHTML = VISUAL_SKINS.map(skin => `
    <button class="skinChoice ${skin.id === visualSkin ? 'activeSkin' : ''}" data-skin-id="${esc(skin.id)}">
      <span class="skinSwatch skin_${esc(skin.id)}"><em>${esc(skin.icon)}</em></span>
      <strong>${esc(skin.name)}</strong>
      <small>${esc(skin.note)}</small>
    </button>`).join('');
  document.querySelectorAll('[data-skin-id]').forEach(btn => btn.onclick = () => {
    uiClick();
    applyVisualSkin(btn.dataset.skinId);
    renderSkinDialog();
    updateChrome();
  });
  $('layoutOptions').innerHTML = LAYOUT_MODES.map(mode => `
    <button class="layoutChoice ${mode.id === layoutMode ? 'activeSkin' : ''}" data-layout-id="${esc(mode.id)}">
      <span class="layoutSwatch">${esc(mode.icon)}</span>
      <strong>${esc(mode.name)}</strong>
      <small>${esc(mode.note)}</small>
    </button>`).join('');
  document.querySelectorAll('[data-layout-id]').forEach(btn => btn.onclick = () => {
    uiClick();
    applyLayoutMode(btn.dataset.layoutId);
    renderSkinDialog();
    if (state?.status === 'playing') renderGame();
    updateChrome();
  });
  renderAudioControls();
}

function openAudioSettings() {
  loadSpotifyConfig().catch?.(() => {});
  renderSkinDialog();
  const dialog = $('skinDialog');
  if (!dialog.open) dialog.showModal();
  setTimeout(() => $('audioOptions')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
}

function renderAudioControls() {
  const wrap = $('audioOptions');
  if (!wrap) return;
  const spotifyConnected = hasSpotifyTokens();
  const spotifyEnabled = spotifyConfig?.enabled;
  const playlistOptions = spotifyPlaylists.map(pl => `<option value="${esc(pl.uri)}" ${selectedSpotifyPlaylist === pl.uri ? 'selected' : ''}>${esc(pl.name)}</option>`).join('');
  wrap.innerHTML = `
    <div class="audioGrid">
      <label class="settingToggle"><input id="musicEnabledControl" type="checkbox" ${musicEnabled ? 'checked' : ''} /> Music on</label>
      <label class="settingToggle"><input id="soundEnabledControl" type="checkbox" ${soundEnabled ? 'checked' : ''} /> Sound effects on</label>
      <label>Music source</label>
      <select id="musicSourceSelect">
        <option value="local" ${musicSource === 'local' ? 'selected' : ''}>Built-in jazz playlist</option>
        <option value="spotify" ${musicSource === 'spotify' ? 'selected' : ''}>Spotify Connect</option>
      </select>
      <label>Built-in track</label>
      <select id="localTrackSelect">${MUSIC_TRACKS.map((track, i) => `<option value="${i}" ${i === localTrackIndex ? 'selected' : ''}>${esc(track.title)}</option>`).join('')}</select>
      <label>Music volume <strong>${Math.round(musicVolume * 100)}%</strong></label>
      <input id="musicVolumeRange" type="range" min="0" max="100" value="${Math.round(musicVolume * 100)}" />
      <label>SFX volume <strong>${Math.round(sfxVolume * 100)}%</strong></label>
      <input id="sfxVolumeRange" type="range" min="0" max="100" value="${Math.round(sfxVolume * 100)}" />
    </div>
    <div class="audioButtonRow">
      <button id="musicPlayPauseBtn" class="secondaryGameBtn" type="button">${musicEnabled ? 'Restart music' : 'Play music'}</button>
      <button id="musicNextBtn" class="ghostBtn" type="button">Next built-in song</button>
    </div>
    <div class="spotifyBox ${musicSource === 'spotify' ? '' : 'softDisabled'}">
      <h3>Spotify</h3>
      <p>${spotifyEnabled ? 'Connect Spotify, load your playlists, then choose one and press Play Spotify. Premium works with the in-browser player.' : 'Spotify is not configured on this Render service yet. Add SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI in Render.'}</p>
      <p class="spotifyStatus">Status: ${esc(spotifyStatus)}${spotifyConnected ? ' · token saved' : ''}</p>
      <div class="audioButtonRow">
        <button id="spotifyConnectBtn" class="secondaryGameBtn" type="button" ${spotifyEnabled ? '' : 'disabled'}>${spotifyConnected ? 'Reconnect Spotify' : 'Connect Spotify'}</button>
        <button id="spotifyDisconnectBtn" class="ghostBtn" type="button" ${spotifyConnected ? '' : 'disabled'}>Disconnect</button>
        <button id="spotifyLoadPlaylistsBtn" class="ghostBtn" type="button" ${spotifyConnected ? '' : 'disabled'}>Load playlists</button>
      </div>
      <div class="spotifyPlaylistRow">
        <select id="spotifyPlaylistSelect" ${spotifyPlaylists.length ? '' : 'disabled'}>
          <option value="">Choose Spotify playlist</option>${playlistOptions}
        </select>
        <button id="spotifyPlayBtn" class="secondaryGameBtn" type="button" ${spotifyConnected ? '' : 'disabled'}>Play Spotify</button>
      </div>
    </div>`;

  $('musicEnabledControl').onchange = (e) => { musicEnabled = e.target.checked; localStorage.setItem('probe_music_loop', musicEnabled ? 'on' : 'off'); if (musicEnabled) startAmbientMusic(); else stopAmbientMusic(); updateChrome(); renderAudioControls(); };
  $('soundEnabledControl').onchange = (e) => { soundEnabled = e.target.checked; localStorage.setItem('probe_sound', soundEnabled ? 'on' : 'off'); updateChrome(); renderAudioControls(); };
  $('musicSourceSelect').onchange = (e) => { musicSource = e.target.value; localStorage.setItem('probe_music_source', musicSource); if (musicEnabled) { stopAmbientMusic(); startAmbientMusic(); } renderAudioControls(); updateChrome(); };
  $('localTrackSelect').onchange = (e) => { localTrackIndex = Number.parseInt(e.target.value, 10) || 0; localStorage.setItem('probe_music_track_index', String(localTrackIndex)); if (musicEnabled && musicSource === 'local') { stopAmbientMusic(); startAmbientMusic(); } renderAudioControls(); };
  $('musicVolumeRange').oninput = (e) => { musicVolume = clamp(Number(e.target.value) / 100, 0, 1); localStorage.setItem('probe_music_volume', String(musicVolume)); applyMusicVolume(); renderAudioControls(); };
  $('sfxVolumeRange').oninput = (e) => { sfxVolume = clamp(Number(e.target.value) / 100, 0, 1); localStorage.setItem('probe_sfx_volume', String(sfxVolume)); renderAudioControls(); };
  $('musicPlayPauseBtn').onclick = () => { uiClick(); musicEnabled = true; localStorage.setItem('probe_music_loop', 'on'); stopAmbientMusic(); startAmbientMusic(); updateChrome(); renderAudioControls(); };
  $('musicNextBtn').onclick = () => { uiClick(); nextLocalTrack(true); renderAudioControls(); };
  $('spotifyConnectBtn').onclick = () => { uiClick(); connectSpotify(); };
  $('spotifyDisconnectBtn').onclick = () => { uiClick(); disconnectSpotify(); renderAudioControls(); };
  $('spotifyLoadPlaylistsBtn').onclick = async () => { uiClick(); await loadSpotifyPlaylists(); renderAudioControls(); };
  $('spotifyPlaylistSelect').onchange = (e) => { selectedSpotifyPlaylist = e.target.value; localStorage.setItem('probe_spotify_playlist', selectedSpotifyPlaylist); };
  $('spotifyPlayBtn').onclick = async () => { uiClick(); musicSource = 'spotify'; localStorage.setItem('probe_music_source', 'spotify'); musicEnabled = true; localStorage.setItem('probe_music_loop', 'on'); try { await startSpotifyPlayback(); } catch (err) { spotifyStatus = err.message || 'Spotify playback failed'; showToast(spotifyStatus); } updateChrome(); renderAudioControls(); };
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => t.classList.add('hidden'), 3600);
}

function setVisible(id) {
  ['home', 'lobby', 'setup', 'game', 'end'].forEach(x => $(x).classList.toggle('hidden', x !== id));
}

function render() {
  stopCountdown();
  updateChrome();
  if (!state) { renderHomeHints(); return setVisible('home'); }
  if (state.status === 'lobby') return renderLobby();
  if (state.status === 'setup') return renderSetup();
  if (state.status === 'playing') return renderGame();
  if (state.status === 'ended') return renderEnd();
}

function renderHomeHints() {
  const room = new URLSearchParams(location.search).get('room') || savedRoom();
  $('resumeWrap').innerHTML = room ? `
    <div class="notice resumeNotice">
      <strong>Saved room:</strong> ${esc(room)}
      <div class="buttonRow">
        <button id="resumeBtn" class="secondaryGameBtn">Reconnect</button>
        <button id="clearSavedBtn" class="ghostBtn">Clear</button>
      </div>
    </div>` : '';
  if ($('resumeBtn')) $('resumeBtn').onclick = () => { uiClick(); attemptReconnect(); };
  if ($('clearSavedBtn')) $('clearSavedBtn').onclick = () => { uiClick(); clearSavedRoom(); renderHomeHints(); };
}

function renderLobby() {
  setVisible('lobby');
  const inviteLink = `${location.origin}?room=${encodeURIComponent(state.code)}`;
  const themeOptions = (state.themes || []).map(t => `<option value="${esc(t.id)}" ${state.settings.themeId === t.id ? 'selected' : ''}>${esc(t.emoji)} ${esc(t.name)}</option>`).join('');
  $('lobby').innerHTML = `
    <div class="lobbyShell">
      <div class="lobbyHeader">
        <div>
          <div class="tinyCaps">Room Lobby</div>
          <h1>Gather Your Players</h1>
          <p>Invite friends, add CPU competitors, or turn on shared-device tabletop mode.</p>
        </div>
        <div class="bigRoomCode">${esc(state.code)}</div>
      </div>

      <div class="grid twoUp">
        <div class="woodPanel">
          <h2>Players</h2>
          <ul class="playerList">${state.players.map(p => `<li>
            <span>${avatar(p)} <strong>${esc(p.name)}</strong> ${p.isHost ? '<em class="hostTag">HOST</em>' : ''} ${p.isCpu ? '<em class="cpuTag">CPU</em>' : ''} ${p.isLocal ? '<em class="localTag">LOCAL</em>' : ''} ${p.connected ? '' : '<span class="dangerText">disconnected</span>'}</span>
            <span class="playerActions">${canEditAvatar(p) ? `<label class="avatarUpload smallBtn">Avatar<input type="file" accept="image/png,image/jpeg,image/webp" data-avatar-id="${esc(p.id)}" /></label>` : ''}${state.isHost && !p.isHost ? `<button class="ghostBtn smallBtn" data-kick-id="${esc(p.id)}">Remove</button>` : ''}</span>
          </li>`).join('')}</ul>

          ${state.isHost ? `
            <div class="lobbyToolBox">
              <button id="addCpuBtn" class="secondaryGameBtn">+ Add AI CPU</button>
              <div class="localAddRow">
                <input id="localNameInput" maxlength="24" placeholder="Local seat name" />
                <button id="addLocalBtn" class="secondaryGameBtn">+ Local Seat</button>
              </div>
            </div>` : ''}
        </div>

        <div class="woodPanel settingsPanel">
          <h2>Game Settings</h2>
          <div class="visualThemeMini">
            <span>Visual skin: <strong>${esc(VISUAL_SKINS.find(s => s.id === visualSkin)?.name || 'Warm Wood')}</strong></span>
            <button id="skinLobbyBtn" class="ghostBtn smallBtn">Change</button>
          </div>
          <label>Turn timer</label>
          <select id="timerSelect" ${state.isHost ? '' : 'disabled'}>
            ${[0, 30, 45, 60, 90, 120].map(v => `<option value="${v}" ${state.settings.turnTimerSec === v ? 'selected' : ''}>${v === 0 ? 'Off' : `${v} seconds`}</option>`).join('')}
          </select>

          <div class="settingToggle"><label><input id="themeToggle" type="checkbox" ${state.settings.useThemes ? 'checked' : ''} ${state.isHost ? '' : 'disabled'} /> Category theme each round</label></div>
          <div class="themeSettingGrid">
            <select id="themeModeSelect" ${state.isHost && state.settings.useThemes ? '' : 'disabled'}>
              <option value="random" ${state.settings.themeMode === 'random' ? 'selected' : ''}>Random theme</option>
              <option value="host" ${state.settings.themeMode === 'host' ? 'selected' : ''}>Host chooses</option>
            </select>
            <select id="themeSelect" ${state.isHost && state.settings.useThemes && state.settings.themeMode === 'host' ? '' : 'disabled'}>${themeOptions}</select>
          </div>
          <p class="hint">Themes are prompts, not strict validation. Example: Medical → vaccine, clinic, surgery. Genius CPU uses a public-info word solver and does not peek at hidden words.</p>

          <div class="settingToggle"><label><input id="sharedToggle" type="checkbox" ${state.settings.sharedDevice ? 'checked' : ''} ${state.isHost ? '' : 'disabled'} /> Shared-device tabletop mode</label></div>
          <div class="settingToggle"><label><input id="manualToggle" type="checkbox" ${state.settings.manualReveal ? 'checked' : ''} ${state.isHost ? '' : 'disabled'} /> Click-to-expose / no typing mode</label></div>

          <label>CPU difficulty</label>
          <select id="cpuDifficultySelect" ${state.isHost ? '' : 'disabled'}>
            ${['easy','medium','hard','genius'].map(v => `<option value="${v}" ${state.settings.cpuDifficulty === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}
          </select>

          <div class="buttonRow">
            <button id="copyCodeBtn" class="secondaryGameBtn">Copy Code</button>
            <button id="copyLinkBtn" class="secondaryGameBtn">Copy Invite Link</button>
          </div>
        </div>
      </div>

      <div class="lobbyStart">
        ${state.isHost ? '<button id="startSetupBtn" class="primaryGameBtn hugeBtn">Start Secret Word Setup</button>' : '<span class="hint">Waiting for host to start.</span>'}
      </div>
    </div>`;

  $('copyCodeBtn').onclick = () => { uiClick(); copyText(state.code, 'Room code copied.'); };
  $('copyLinkBtn').onclick = () => { uiClick(); copyText(inviteLink, 'Invite link copied.'); };
  $('skinLobbyBtn').onclick = () => { uiClick(); renderSkinDialog(); $('skinDialog').showModal(); };
  if (state.isHost) {
    $('startSetupBtn').onclick = () => { uiClick(); socket.emit('startSetup'); };
    $('addCpuBtn').onclick = () => { uiClick(); socket.emit('addCpu'); };
    $('addLocalBtn').onclick = () => { uiClick(); socket.emit('addLocalPlayer', { name: $('localNameInput').value }); $('localNameInput').value = ''; };
    const sendSettings = () => socket.emit('setSettings', {
      turnTimerSec: Number.parseInt($('timerSelect').value, 10),
      useThemes: $('themeToggle').checked,
      themeMode: $('themeModeSelect').value,
      themeId: $('themeSelect').value,
      sharedDevice: $('sharedToggle').checked,
      manualReveal: $('manualToggle').checked,
      cpuDifficulty: $('cpuDifficultySelect').value
    });
    ['timerSelect','themeToggle','themeModeSelect','themeSelect','sharedToggle','manualToggle','cpuDifficultySelect'].forEach(id => $(id).onchange = () => { uiClick(); sendSettings(); });
  }
  document.querySelectorAll('[data-kick-id]').forEach(btn => btn.onclick = () => { uiClick(); socket.emit('kickPlayer', { playerId: btn.dataset.kickId }); });
  wireAvatarUploads();
}

function renderSetup() {
  setVisible('setup');
  if (state.settings.sharedDevice && state.isHost) return renderSharedSetup();
  renderPersonalSetup();
}

function themeBanner() {
  if (!state.currentTheme) return '';
  return `<div class="themeBanner"><strong>${esc(state.currentTheme.emoji)} Theme: ${esc(state.currentTheme.name)}</strong><span>Examples: ${(state.currentTheme.examples || []).map(esc).join(', ')}</span></div>`;
}

function renderPersonalSetup() {
  const me = state.players.find(p => p.id === state.youId);
  $('setup').innerHTML = `
    <div class="setupShell">
      <div class="setupCard">
        <div class="tinyCaps">Room ${esc(state.code)}</div>
        <h1>Build Your Secret Tray</h1>
        ${themeBanner()}
        <p>Build up to a 12-space tray. Letters are word cards, periods are dot cards, and unused spaces stay empty.</p>
        <div class="notice">Your tray is private. Other players only see covered spaces until something is revealed.</div>
        ${me.ready ? `<p class="goodText bigReady">Your secret tray is locked in. Waiting for everyone else.</p>` : secretFormHtml('self')}
      </div>
      <div class="woodPanel readyPanel">
        <h2>Players</h2>
        <ul class="playerList">${state.players.map(p => `<li>${avatar(p)} <span><strong>${esc(p.name)}</strong> ${p.isCpu ? '<em class="cpuTag">CPU</em>' : ''}<br>${p.ready ? '<span class="goodText">ready</span>' : '<span class="hint">not ready</span>'}</span></li>`).join('')}</ul>
      </div>
    </div>`;
  if (!me.ready) wireSecretForm('self', (tray) => socket.emit('submitSecret', { tray }));
}

function renderSharedSetup() {
  const nonCpu = state.players.filter(p => !p.isCpu);
  $('setup').innerHTML = `
    <div class="setupShell setupShellWide">
      <div class="setupCard sharedSetupCard">
        <div class="tinyCaps">Room ${esc(state.code)} · Tabletop Setup</div>
        <h1>Pass the Device</h1>
        ${themeBanner()}
        <p>Each local player takes a turn privately entering their secret word. Hide the screen from the others, then lock it in.</p>
        <div class="sharedSetupGrid">
          ${nonCpu.map(p => `
            <div class="sharedPlayerSecret ${p.ready ? 'readySecret' : ''}">
              <h2>${avatar(p)} ${esc(p.name)} ${p.isHost ? '<em class="hostTag">HOST</em>' : ''}</h2>
              ${p.ready ? '<p class="goodText">Locked in.</p>' : secretFormHtml(p.id)}
            </div>`).join('')}
        </div>
      </div>
      <div class="woodPanel readyPanel">
        <h2>Ready Check</h2>
        <ul class="playerList">${state.players.map(p => `<li>${avatar(p)} <span><strong>${esc(p.name)}</strong> ${p.isCpu ? '<em class="cpuTag">CPU</em>' : ''}${p.isLocal ? '<em class="localTag">LOCAL</em>' : ''}<br>${p.ready ? '<span class="goodText">ready</span>' : '<span class="hint">not ready</span>'}</span></li>`).join('')}</ul>
      </div>
    </div>`;
  nonCpu.filter(p => !p.ready).forEach(p => wireSecretForm(p.id, (tray) => socket.emit('submitSecretForPlayer', { playerId: p.id, tray })));
}

function secretFormHtml(id) {
  return `
    <div class="secretForm" data-secret-id="${esc(id)}">
      <label>Secret tray</label>
      <input id="secretWord_${esc(id)}" maxlength="12" autocomplete="off" placeholder="Example: .TREASURE. or TREASURE" inputmode="text" />
      <div class="trayBuilderTools">
        <button id="addDotSecret_${esc(id)}" class="secondaryGameBtn miniToolBtn" type="button">Add dot card .</button>
        <button id="clearSecret_${esc(id)}" class="ghostBtn miniToolBtn" type="button">Clear</button>
      </div>
      <p class="hint">Type letters for word cards. Dots can only go before or after the word. Type <strong>.</strong> or click Add dot. Unused spaces stay empty.</p>
      <div id="previewTray_${esc(id)}"></div>
      <div class="buttonRow"><button id="saveSecretBtn_${esc(id)}" class="primaryGameBtn hugeBtn">Lock In Secret Tray</button></div>
    </div>`;
}

function wireSecretForm(id, submitFn) {
  const wordInput = $(`secretWord_${id}`);
  const cleanTrayInput = () => {
    const tray = wordInput.value.toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 12);
    if (tray !== wordInput.value) wordInput.value = tray;
    renderPreviewTray(id);
  };
  wordInput.addEventListener('input', cleanTrayInput);
  wordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
      e.preventDefault(); uiClick();
      if (hasInteriorDot(wordInput.value)) return showToast('Dots can only go before or after the word — not in the middle.');
      submitFn(wordInput.value);
    }
  });
  $(`addDotSecret_${id}`).onclick = () => {
    uiClick();
    const start = wordInput.selectionStart ?? wordInput.value.length;
    const end = wordInput.selectionEnd ?? wordInput.value.length;
    const next = `${wordInput.value.slice(0, start)}.${wordInput.value.slice(end)}`.toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 12);
    wordInput.value = next;
    const pos = Math.min(start + 1, wordInput.value.length);
    wordInput.focus();
    wordInput.setSelectionRange(pos, pos);
    renderPreviewTray(id);
  };
  $(`clearSecret_${id}`).onclick = () => { uiClick(); wordInput.value = ''; wordInput.focus(); renderPreviewTray(id); };
  $(`saveSecretBtn_${id}`).onclick = () => {
    uiClick();
    if (hasInteriorDot(wordInput.value)) return showToast('Dots can only go before or after the word — not in the middle.');
    submitFn(wordInput.value);
  };
  cleanTrayInput();
}

function trayPatternToSlots(pattern) {
  const clean = String(pattern || '').toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 12);
  return Array.from({ length: 12 }, (_, i) => clean[i] || '');
}

function renderPreviewTray(id = 'self') {
  const tray = ($(`secretWord_${id}`)?.value || '').trim().toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 12);
  const chars = trayPatternToSlots(tray);
  const warning = hasInteriorDot(tray) ? '<div class="trayWarning">Dots can only go before or after the word.</div>' : '';
  $(`previewTray_${id}`).innerHTML = `<div class="wordRack previewRack">${chars.map((ch, i) => slotHtml({ ch, index: i, revealed: true, empty: ch === '' }, false, ch !== '')).join('')}</div>${warning}`;
}

function hasInteriorDot(value) {
  const chars = String(value || '').toUpperCase().replace(/[^A-Z.]/g, '').split('');
  const first = chars.findIndex(ch => /[A-Z]/.test(ch));
  let last = -1;
  chars.forEach((ch, i) => { if (/[A-Z]/.test(ch)) last = i; });
  if (first < 0 || last < 0) return false;
  return chars.slice(first + 1, last).includes('.');
}

function renderGame() {
  setVisible('game');
  const controlId = currentControlId();
  const controlled = state.players.find(p => p.id === controlId);
  const isMyTurn = state.activePlayerId === controlId && !controlled?.isCpu;
  const pending = state.awaitingExpose;
  const waitingOnControl = pending && canControlTray(pending.playerId);
  const phoneLayout = isPhoneLayout();
  const boardLayout = activeBoardLayoutMode();
  const currentCardId = state.currentCard?.id || '';
  const newCard = !!(currentCardId && currentCardId !== lastCardId);
  if (newCard) {
    readyCenterTurnCardId = null;
    animatingTurnCardId = currentCardId;
  }
  lastCardId = currentCardId || lastCardId;
  const themeChip = state.currentTheme ? `<div class="matchPill themePill">${esc(state.currentTheme.emoji)} ${esc(state.currentTheme.name)}</div>` : '';

  $('game').innerHTML = `
    <div class="gameHud ${phoneLayout ? 'phoneGameHud' : ''} ${isMyTurn ? 'phoneYourTurn' : 'phoneOtherTurn'} ${waitingOnControl ? 'phoneWaitingReveal' : ''}">
      <aside class="leftCommand ${isMyTurn || waitingOnControl ? 'mobileCommandVisible' : 'mobileCommandHidden'}">${renderActionPanel(isMyTurn, waitingOnControl, controlled)}</aside>
      <section class="centerBoard ${phoneLayout ? 'mobilePhoneBoard' : ''}">
        <div class="matchStrip">
          <div class="matchPill">Active Game</div>
          ${themeChip}
          <div class="timerPill ${isMyTurn ? 'hot' : ''}"><span>⏳</span><strong id="turnTimerBadge">${formatRemaining(state.turnEndsAt)}</strong></div>
          <div class="matchPill">Turn: <strong>${esc(state.activePlayerName)}</strong> ${isMyTurn ? '<span class="greenDot"></span>' : ''}</div>
        </div>
        <button id="boardFullscreenBtn" class="boardFullscreenFab" title="Fullscreen board" aria-label="Fullscreen board">⛶</button>
        ${pending ? `<div class="pendingBanner"><strong>Pending:</strong> ${esc(pending.message)}</div>` : ''}
        ${state.settings.manualReveal ? `<div class="manualBanner"><strong>Click-to-expose is ON.</strong> In person or voice chat, the asked player can click a hidden slot instead of typing.</div>` : ''}
        <div class="boardAndCard ${boardLayout === 'round' ? 'roundLayout' : 'stackedLayout'} ${phoneLayout ? 'mobileStackBoard' : ''}">
          <div class="trayTheater ${boardLayout === 'round' ? `circleTheater seatCount${orderedPlayersForBoard().length}` : ''}">${renderBoardPlayersAndDeck()}</div>
          <div class="cardDock">
            ${renderCard(state.currentCard, newCard)}
            <div class="deckRow">
              <div class="miniDeck blueDeck"><span>${state.deckCount}</span><strong>Deck</strong></div>
              <div class="miniDeck grayDeck"><span>${state.discardCount}</span><strong>Discard</strong></div>
            </div>
          </div>
        </div>
        <div class="hintRibbon"><span>💡</span><strong>Hint</strong><em>${state.settings.manualReveal ? 'For no-typing play, say the ask out loud, click a matching card, or use Verbal Miss.' : 'Track the exposed letters, protect your dots, and use full guesses when the pattern is worth the risk.'}</em></div>
        ${renderBoardFullscreenTools(isMyTurn, waitingOnControl, controlled)}
      </section>
      <aside class="rightRail">
        <div class="railPanel"><h2>Scoreboard</h2>${renderScoreCards()}</div>
        <div class="railPanel"><h2>Activity Log</h2><ol class="activityLog">${state.log.slice(0, 8).map(item => `<li>${colorizeLog(item)}</li>`).join('')}</ol></div>
        <div class="turnPanel ${isMyTurn ? 'yourTurn' : ''}">
          <div><h2>${isMyTurn ? `${esc(controlled?.name || 'Your')} Turn` : 'Stand By'}</h2><p>${turnPanelText(isMyTurn, controlled)}</p></div><span>⌛</span>
        </div>
      </aside>
    </div>`;

  attachActionHandlers(controlId);
  attachExposeHandlers();
  attachTargetSelectionHandlers();
  attachBoardFullscreenHandlers(controlId);
  syncTargetSelectionGlow();
  requestAnimationFrame(fitSlotGlyphs);
  startCountdown();
}


function renderBoardFullscreenTools(isMyTurn, waitingOnMe, controlled) {
  const controlId = controlled?.id || state?.youId;
  const opponents = (state?.players || []).filter(p => p.id !== controlId && !p.allExposed);
  const allOpponents = (state?.players || []).filter(p => p.id !== controlId);
  let drawerBody = '';
  if (waitingOnMe) {
    drawerBody = `<div class="notice">Choose one highlighted tray slot to expose.</div>`;
  } else if (state?.awaitingExpose) {
    drawerBody = `<div class="notice">Waiting for ${esc(state.players.find(p => p.id === state.awaitingExpose.playerId)?.name || 'a player')} to expose a slot.</div>`;
  } else if (controlled?.isCpu) {
    drawerBody = `<div class="notice">${esc(controlled.name)} is choosing.</div>`;
  } else if (!isMyTurn) {
    drawerBody = `<div class="notice">Waiting for ${esc(state?.activePlayerName || 'the active player')}.</div>`;
  } else {
    drawerBody = `
      <label>Choose opponent</label>
      <select id="fsTargetSelect">${opponents.map(p => `<option value="${esc(p.id)}" ${selectedGuessTargetId === p.id ? 'selected' : ''}>${esc(p.name)} (${p.hiddenCount} hidden)</option>`).join('')}</select>
      <label>Letter or dot</label>
      <div class="guessInputRow"><input id="fsSymbolInput" maxlength="5" placeholder="A or ." /><button id="fsDotBtn" class="dotButton" title="Ask for a dot card">•</button></div>
      <button id="fsAskBtn" class="blueBtn">Guess Letter</button>
      <div class="divider smallDivider"><span>or</span></div>
      <label>Full word / tray guess</label>
      <select id="fsFullTarget">${allOpponents.map(p => `<option value="${esc(p.id)}" ${selectedGuessTargetId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <input id="fsFullGuess" placeholder="WORD or ..WORD....." />
      <button id="fsFullGuessBtn" class="purpleBtn">Guess The Word</button>`;
  }
  return `
    <div class="boardFullscreenTools" aria-label="Fullscreen board controls">
      <button id="boardExitFullscreenBtn" class="boardExitFullscreenBtn" title="Exit fullscreen" aria-label="Exit fullscreen">×</button>
      <button id="fsGuessToggle" class="fsGuessToggle" aria-expanded="false">Guess</button>
      <div id="boardFullscreenGuess" class="boardFullscreenGuess">
        <div class="commandTitle">Board Controls</div>
        ${drawerBody}
      </div>
    </div>`;
}

function attachBoardFullscreenHandlers(controlId) {
  const board = $('game') || document.querySelector('.centerBoard');
  const openBtn = $('boardFullscreenBtn');
  if (openBtn && board) {
    openBtn.onclick = async () => {
      uiClick();
      try {
        if (!document.fullscreenElement && board.requestFullscreen) await board.requestFullscreen();
      } catch (err) {
        showToast('Fullscreen was blocked by the browser.');
      }
    };
  }

  const exitBtn = $('boardExitFullscreenBtn');
  if (exitBtn) exitBtn.onclick = () => { uiClick(); if (document.fullscreenElement) document.exitFullscreen?.(); };

  const toggle = $('fsGuessToggle');
  const drawer = $('boardFullscreenGuess');
  if (toggle && drawer) {
    toggle.onclick = () => {
      uiClick();
      drawer.classList.toggle('open');
      toggle.setAttribute('aria-expanded', drawer.classList.contains('open') ? 'true' : 'false');
    };
  }

  const fsSymbol = $('fsSymbolInput');
  if (fsSymbol) {
    fsSymbol.addEventListener('input', () => {
      const raw = fsSymbol.value.toUpperCase();
      const match = raw.match(/[A-Z.]/);
      fsSymbol.value = match ? match[0] : '';
    });
    fsSymbol.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('fsAskBtn')?.click(); }
    });
  }
  const fsDot = $('fsDotBtn');
  if (fsDot) fsDot.onclick = () => { uiClick(); if (!fsSymbol) return; fsSymbol.value = '.'; fsSymbol.dispatchEvent(new Event('input', { bubbles: true })); };

  const sendFsSymbolGuess = () => {
    const target = $('fsTargetSelect');
    const input = $('fsSymbolInput');
    if (!target || !input) return;
    const symbol = input.value.trim();
    if (!symbol) { input.focus(); return; }
    uiClick();
    setSelectedGuessTarget(target.value, false);
    socket.emit('askSymbol', { targetId: target.value, symbol, actorId: controlId });
    input.value = '';
  };
  const fsAsk = $('fsAskBtn');
  if (fsAsk) fsAsk.onclick = sendFsSymbolGuess;

  const sendFsFullGuess = () => {
    const target = $('fsFullTarget');
    const input = $('fsFullGuess');
    if (!target || !input) return;
    uiClick();
    setSelectedGuessTarget(target.value, false);
    socket.emit('guessFull', { targetId: target.value, guess: input.value, interruptive: false, actorId: controlId });
  };
  const fsFullBtn = $('fsFullGuessBtn');
  if (fsFullBtn) fsFullBtn.onclick = sendFsFullGuess;
  const fsFullGuess = $('fsFullGuess');
  if (fsFullGuess) fsFullGuess.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendFsFullGuess(); }
  });

  ['fsTargetSelect', 'fsFullTarget'].forEach(id => {
    const select = $(id);
    if (select) select.onchange = () => setSelectedGuessTarget(select.value, false);
  });
}

function turnPanelText(isMyTurn, controlled) {
  if (controlled?.isCpu) return `${controlled.name} is thinking...`;
  if (isMyTurn) return 'Make a guess, use no-typing controls, or attempt the full word.';
  return `Waiting for ${esc(state.activePlayerName)}.`;
}

function currentControlId() {
  if (state?.settings?.sharedDevice && state?.isHost) return state.activePlayerId || state.youId;
  return state?.youId;
}

function canControlTray(playerId) {
  if (!state) return false;
  if (playerId === state.youId) return true;
  const p = state.players.find(x => x.id === playerId);
  return !!(state.isHost && state.settings.sharedDevice && p && !p.isCpu);
}

function renderActionPanel(isMyTurn, waitingOnMe, controlled) {
  if (waitingOnMe) return `<div class="commandTitle">Reveal Choice</div><div class="notice">Choose one highlighted slot to expose.</div><p class="hint">Only the allowed matching spaces are clickable.</p>`;
  if (state.awaitingExpose) return `<div class="commandTitle">Waiting</div><p>Waiting for ${esc(state.players.find(p => p.id === state.awaitingExpose.playerId)?.name || 'a player')} to expose a slot.</p>`;
  if (controlled?.isCpu) return `<div class="commandTitle">AI Turn</div><p>${esc(controlled.name)} is choosing a target.</p><div class="aiOrb">🤖</div>`;

  const controlId = controlled?.id || state.youId;
  const opponents = state.players.filter(p => p.id !== controlId && !p.allExposed);
  const allOpponents = state.players.filter(p => p.id !== controlId);

  if (!isMyTurn) {
    return `
      <div class="commandTitle">Interruptive Guess</div>
      <p class="hint">You can guess an opponent’s word/tray when they still have 5+ hidden spaces.</p>
      <label>Target</label>
      <select id="interruptTarget">${allOpponents.map(p => `<option value="${esc(p.id)}" ${selectedGuessTargetId === p.id ? 'selected' : ''}>${esc(p.name)} (${p.hiddenCount} hidden)</option>`).join('')}</select>
      <label>Guess</label>
      <input id="interruptGuess" placeholder="WORD or ..WORD....." />
      <button id="interruptBtn" class="purpleBtn">Make Interruptive Guess</button>
      <div class="tipBox">Wrong interruptive guesses cost points. Use this when you are confident.</div>`;
  }

  return `
    <div class="commandTitle">${state.settings.sharedDevice && state.isHost ? `${esc(controlled.name)} Controls` : 'Make a Guess'}</div>
    <div class="letterGuessBlock">
      <label>Choose opponent</label>
      <select id="targetSelect">${opponents.map(p => `<option value="${esc(p.id)}" ${selectedGuessTargetId === p.id ? 'selected' : ''}>${esc(p.name)} (${p.hiddenCount} hidden)</option>`).join('')}</select>
      <label>Enter a letter or dot</label>
      <div class="guessInputRow phoneNativeInputRow"><input id="symbolInput" maxlength="5" placeholder="A or ." /><button id="dotBtn" class="dotButton" title="Ask for a dot card">•</button></div>
      <div class="tinyCaps centerText keyboardCaption">or select from keyboard</div>
      <div class="letterKeyboard">${LETTERS.map(l => `<button class="keyBtn" data-letter="${l}">${l}</button>`).join('')}<button class="keyBtn" data-letter=".">•</button><button class="keyBtn wideKey" data-letter="BACK">⌫</button></div>
      <button id="askBtn" class="blueBtn">Guess Letter</button>
    </div>
    ${state.settings.manualReveal ? `
      <div class="manualRevealBlock">
        <div class="divider smallDivider"><span>no typing</span></div>
        <div class="manualControls">
          <button id="verbalMissBtn" class="secondaryGameBtn">Verbal Miss / Next Turn</button>
          <button id="verbalDotMissBtn" class="dangerBtn">Dot Miss -50</button>
        </div>
        <p class="hint">Say the ask out loud. If they have it, they click the matching hidden card. If not, use a miss button.</p>
      </div>` : ''}
    <div class="fullGuessBlock">
      <div class="divider smallDivider"><span>or</span></div>
      <label>Full word / tray guess</label>
      <select id="fullTarget">${allOpponents.map(p => `<option value="${esc(p.id)}" ${selectedGuessTargetId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <input id="fullGuess" placeholder="WORD or ..WORD....." />
      <button id="fullGuessBtn" class="purpleBtn">Guess The Word</button>
    </div>
    ${state.isHost ? '<button id="forceNextBtn" class="dangerBtn hostForceBtn">Host: Force Next Turn</button>' : ''}
    <div class="tipBox">Guess letters to reveal the hidden word, or go all-in with a full word guess.</div>`;
}

function renderBoardDeckSource() {
  const deckCount = Number.isFinite(state?.deckCount) ? state.deckCount : 0;
  const discardCount = Number.isFinite(state?.discardCount) ? state.discardCount : 0;
  return `
    <div class="boardDeckSource" aria-label="Activity deck in the middle of the board">
      <div class="miniDeck blueDeck boardBlueDeck" title="Activity deck"><span>${deckCount}</span><strong>Deck</strong></div>
      ${state?.currentCard ? centerTurnCardMini(state.currentCard) : '<div class="centerTurnCardMini emptyMiniTurnCard" aria-hidden="true"></div>'}
      <div class="miniDeck grayDeck boardGrayDeck" title="Discard pile"><span>${discardCount}</span><strong>Discard</strong></div>
    </div>`;
}

function centerTurnCardMini(card) {
  if (!card) return '<div class="centerTurnCardMini emptyMiniTurnCard" aria-hidden="true"></div>';

  // The center board slot must not reveal the next turn card before the
  // draw/flip overlay finishes. During the animation, keep the small center
  // card as the Word Vault back. It is swapped face-up only when
  // showTurnCardEffect() completes.
  const cardId = card.id || '';
  const isReady = !cardId || readyCenterTurnCardId === cardId;
  if (!isReady) {
    return `<div class="centerTurnCardMini cardBackMini centerTurnCardPending" data-center-card-id="${esc(cardId)}" title="Drawing turn card">
      <div class="miniCardTiny">Drawing</div>
      <strong>WORD<br>VAULT</strong>
      <span>✥</span>
    </div>`;
  }

  return `<div class="centerTurnCardMini currentCardReady ${cardClass(card.code)}" data-center-card-id="${esc(cardId)}" title="Current turn card: ${esc(card.title)}">
    <div class="miniCardTiny">Activity</div>
    <strong>${esc(shortCardTitle(card.title))}</strong>
    <span>${cardIcon(card.code)}</span>
  </div>`;
}

function refreshCenterTurnCardMini(cardId) {
  const card = state?.currentCard;
  if (!card || (cardId && card.id !== cardId)) return;
  // Refresh every center-slot copy directly. This avoids a rare selector/race issue
  // where the draw overlay finishes but the persistent center card is not swapped
  // back to the face-up card.
  document.querySelectorAll('.boardDeckSource .centerTurnCardMini, .centerTurnCardMini').forEach(mini => {
    mini.outerHTML = centerTurnCardMini(card);
  });
}

function renderCard(card, isNew) {
  if (!card) return '<div class="activityCard emptyCard"><p>No card drawn yet.</p></div>';
  const special = card.code !== 'NORMAL' ? 'specialCardDrawn' : 'normalCardDrawn';
  return `<div class="activityCard ${isNew ? `cardDrawn ${special}` : ''} ${cardClass(card.code)}"><div class="cardAura"></div><div class="tinyCaps">Activity Card</div><div class="cardIcon">${cardIcon(card.code)}</div><h2>${esc(shortCardTitle(card.title))}</h2><p>${esc(card.text)}</p></div>`;
}

function renderScoreCards() {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  return `<div class="scoreCards">${sorted.map((p, idx) => `
    <div class="scoreCard ${p.id === state.activePlayerId ? 'activeScore' : ''}">
      <div class="avatarWrap">${idx === 0 ? '<span class="crown">♛</span>' : ''}${avatar(p)}</div>
      <div class="scoreInfo"><strong>${esc(p.name)} ${p.id === state.youId ? '<em>You</em>' : ''} ${p.isCpu ? '<em>CPU</em>' : ''} ${p.isLocal ? '<em>Local</em>' : ''}</strong><div class="gemRow">${progressGems(p)}</div></div>
      <div class="scoreValue">${p.score}</div>
    </div>`).join('')}</div>`;
}

function orderedPlayersForBoard() {
  if (activeBoardLayoutMode() !== 'round' || !state?.players?.length) return state?.players || [];
  const anchor = currentControlId() || state.youId;
  const idx = state.players.findIndex(p => p.id === anchor);
  if (idx < 0) return state.players;
  return [...state.players.slice(idx), ...state.players.slice(0, idx)];
}

function stackedBoardParts() {
  const players = state?.players || [];
  const controlId = currentControlId() || state?.youId;
  const self = players.find(p => p.id === controlId) || players.find(p => p.id === state?.youId);
  const opponents = players.filter(p => !self || p.id !== self.id);
  const hideSelfForPhoneTurn = isPhoneLayout() && state?.activePlayerId === controlId && !state?.awaitingExpose;
  return { top: opponents, bottom: self && !hideSelfForPhoneTurn ? [self] : [] };
}

function renderBoardPlayersAndDeck() {
  if (activeBoardLayoutMode() === 'round') {
    const players = orderedPlayersForBoard();
    return `${players.map((p, i, arr) => renderPlayerTray(p, i, arr.length)).join('')}${renderBoardDeckSource()}`;
  }
  const parts = stackedBoardParts();
  const total = (state?.players || []).length;
  const topRacks = parts.top.map((p, i, arr) => renderPlayerTray(p, i + 1, arr.length + 1)).join('');
  const bottomRacks = parts.bottom.map(p => renderPlayerTray(p, 0, total)).join('');
  return `<div class="stackedRackColumn">${topRacks}${bottomRacks}</div>${renderBoardDeckSource()}`;
}

function canEditAvatar(player) {
  return player && !player.isCpu && (player.id === state?.youId || (state?.isHost && state?.settings?.sharedDevice && player.isLocal));
}

function canSelectAsGuessTarget(player) {
  if (!state || state.status !== 'playing' || state.awaitingExpose) return false;
  const controlId = currentControlId();
  const controlled = state.players?.find(p => p.id === controlId);
  if (!controlled || controlled.isCpu || state.activePlayerId !== controlId) return false;
  return !!player && player.id !== controlId && !player.allExposed;
}

function boardSeatStyle(seatIndex = 0, seatTotal = 1) {
  if (activeBoardLayoutMode() === 'round') {
    const maps = {
      1: [{ left: 50, top: 84, rot: 0 }],
      2: [{ left: 50, top: 82, rot: 0 }, { left: 50, top: 22, rot: 0 }],
      3: [{ left: 50, top: 82, rot: 0 }, { left: 25, top: 24, rot: -7 }, { left: 75, top: 24, rot: 7 }],
      4: [{ left: 50, top: 83, rot: 0 }, { left: 20, top: 54, rot: -8 }, { left: 50, top: 20, rot: 0 }, { left: 80, top: 54, rot: 8 }],
      5: [{ left: 50, top: 83, rot: 0 }, { left: 18, top: 62, rot: -8 }, { left: 25, top: 23, rot: -7 }, { left: 75, top: 23, rot: 7 }, { left: 82, top: 62, rot: 8 }],
      6: [{ left: 50, top: 83, rot: 0 }, { left: 17, top: 64, rot: -8 }, { left: 25, top: 24, rot: -7 }, { left: 50, top: 19, rot: 0 }, { left: 75, top: 24, rot: 7 }, { left: 83, top: 64, rot: 8 }]
    };
    const arr = maps[Math.max(1, Math.min(6, seatTotal))] || maps[4];
    const pos = arr[seatIndex] || arr[seatIndex % arr.length] || arr[0];
    return `--rack-left:${pos.left}%;--rack-top:${pos.top}%;--rack-rot:${pos.rot}deg;`;
  }

  // Stacked layout is handled by CSS flow instead of round-table absolute seats.
  // These variables remain as a safe fallback only.
  if (seatIndex === 0) return '--rack-left:50%;--rack-top:84%;--rack-rot:0deg;';
  const opponentCount = Math.max(1, seatTotal - 1);
  const left = opponentCount === 1 ? 50 : (seatIndex / (opponentCount + 1)) * 100;
  return `--rack-left:${left.toFixed(2)}%;--rack-top:13%;--rack-rot:0deg;`;
}

function renderPlayerTray(player, seatIndex = 0, seatTotal = 1) {
  const pending = state.awaitingExpose;
  const isMe = player.id === state.youId;
  const slots = isMe && showOwn && player.privateSlots ? player.privateSlots : player.publicSlots;
  const active = player.id === state.activePlayerId;
  const selectable = canSelectAsGuessTarget(player);
  const selected = selectable && selectedGuessTargetId && selectedGuessTargetId === player.id;
  const selectAttrs = selectable ? `data-target-select="${esc(player.id)}" role="button" tabindex="0" aria-label="Select ${esc(player.name)} as guess target"` : '';
  return `
    <div class="playerRack ${active ? 'activeRack' : ''} ${player.isCpu ? 'cpuRack' : ''} ${selectable ? 'targetSelectableRack' : ''} ${selected ? 'selectedTargetRack' : ''} seat${seatIndex}" ${selectAttrs} style="--seat:${seatIndex};--seats:${seatTotal};${boardSeatStyle(seatIndex, seatTotal)}">
      <div class="rackNameplate" ${selectable ? `data-target-select="${esc(player.id)}"` : ''}>${avatar(player)} <span class="rackNameText">${esc(player.name)} ${isMe ? '<span>You</span>' : ''} ${player.isCpu ? '<span>CPU</span>' : ''} ${player.isLocal ? '<span>Local</span>' : ''}</span></div>
      <div class="wordRack" ${selectable ? `data-target-select="${esc(player.id)}"` : ''}>
        ${slots.map(slot => {
          const canPendingClick = pending && pending.playerId === player.id && canControlTray(player.id) && (pending.allowedIndices || []).includes(slot.index);
          const canManualClick = !pending && state.settings.manualReveal && canControlTray(player.id) && !slot.revealed && !slot.empty;
          const ch = slot.revealed || (isMe && showOwn) ? slot.ch : '';
          return slotHtml({ ...slot, ch, playerId: player.id }, canPendingClick || canManualClick, slot.revealed || (isMe && showOwn), canManualClick && !canPendingClick);
        }).join('')}
      </div>
      <div class="rackFooter"><div class="gemRow">${progressGems(player)}</div><label class="showOwnLabel">${isMe ? `<input id="showOwnToggle" type="checkbox" ${showOwn ? 'checked' : ''} /> show mine` : ''}</label></div>
    </div>`;
}

function slotHtml(slot, clickable = false, revealed = false, manual = false) {
  if (slot.empty || (!slot.ch && slot.value === null)) {
    return `<div class="slotShell emptySlotShell" data-slot-index="${slot.index}"><div class="slotValue emptySlotValue"></div><div class="emptySlot" aria-hidden="true"></div></div>`;
  }
  const display = slot.ch === '.' ? '•' : (slot.ch || '');
  const classes = ['slotTile'];
  if (!revealed) classes.push('coveredTile');
  if (revealed) classes.push('revealedTile');
  if (revealed && slot.ch === '.') classes.push('dotTile');
  if (clickable) classes.push(manual ? 'manualClickableTile' : 'clickableTile');
  const attrs = clickable ? (manual ? `data-manual-target="${esc(slot.playerId)}" data-manual-index="${slot.index}"` : `data-expose-index="${slot.index}"`) : '';
  return `<div class="slotShell" data-slot-index="${slot.index}"><div class="slotValue">${[5,5,10,15,15,10,10,15,15,10,5,5][slot.index]}</div><button class="${classes.join(' ')}" ${attrs}><span class="tileSymbol" aria-hidden="true">✥</span><span class="tileGlyph"><span class="tileGlyphInner">${esc(display)}</span></span></button></div>`;
}


function setSelectedGuessTarget(playerId, showMessage = false) {
  if (!playerId) return false;
  const player = state?.players?.find(p => p.id === playerId);
  if (!player) return false;
  selectedGuessTargetId = playerId;
  localStorage.setItem('probe_selected_target', playerId);
  ['targetSelect', 'fullTarget', 'interruptTarget'].forEach(id => {
    const select = $(id);
    if (select && Array.from(select.options).some(o => o.value === playerId)) select.value = playerId;
  });
  syncTargetSelectionGlow();
  if (showMessage) showToast(`Target: ${player.name}`);
  return true;
}

function syncTargetSelectionGlow() {
  const select = $('targetSelect');
  if (select && (!selectedGuessTargetId || !Array.from(select.options).some(o => o.value === selectedGuessTargetId))) {
    selectedGuessTargetId = select.value || '';
    if (selectedGuessTargetId) localStorage.setItem('probe_selected_target', selectedGuessTargetId);
  }
  document.querySelectorAll('.playerRack').forEach(rack => {
    const id = rack.getAttribute('data-target-select');
    rack.classList.toggle('selectedTargetRack', !!id && !!selectedGuessTargetId && id === selectedGuessTargetId);
  });
}

function cycleGuessTarget(delta) {
  const select = $('targetSelect');
  if (!select || select.options.length < 2) return false;
  let idx = select.selectedIndex;
  if (idx < 0) idx = 0;
  idx = (idx + delta + select.options.length) % select.options.length;
  select.selectedIndex = idx;
  const playerId = select.options[idx]?.value || '';
  const label = select.options[idx]?.textContent || 'target';
  setSelectedGuessTarget(playerId, false);
  showToast(`Target: ${label}`);
  return true;
}

function handleGlobalGameKeys(e) {
  if (!state || state.status !== 'playing' || state.awaitingExpose) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const controlId = currentControlId();
  const controlled = state.players?.find(p => p.id === controlId);
  if (!controlled || controlled.isCpu || state.activePlayerId !== controlId) return;

  const input = $('symbolInput');
  const askBtn = $('askBtn');
  if (!input || !askBtn) return;

  const activeEl = document.activeElement;
  const tag = (activeEl?.tagName || '').toLowerCase();
  const activeId = activeEl?.id || '';
  const isTypingField = activeEl?.isContentEditable || tag === 'textarea' || tag === 'select' || (tag === 'input' && activeId !== 'symbolInput');

  if (!isTypingField && ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(e.key)) {
    const delta = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
    if (cycleGuessTarget(delta)) e.preventDefault();
    return;
  }

  if (e.key === 'Enter') {
    if ((!isTypingField || activeId === 'symbolInput') && input.value.trim()) {
      e.preventDefault();
      askBtn.click();
    }
    return;
  }

  if (isTypingField) return;
  const key = e.key === '.' ? '.' : String(e.key || '').toUpperCase();
  if (/^[A-Z]$/.test(key) || key === '.') {
    e.preventDefault();
    input.value = key;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.classList.add('keyboardFilled');
    clearTimeout(handleGlobalGameKeys.flashTimer);
    handleGlobalGameKeys.flashTimer = setTimeout(() => input.classList.remove('keyboardFilled'), 380);
  }
}

function attachActionHandlers(controlId) {
  const sendSymbolGuess = () => {
    const target = $('targetSelect');
    const input = $('symbolInput');
    if (!target || !input) return;
    const symbol = input.value.trim();
    if (!symbol) { input.focus(); return; }
    uiClick();
    setSelectedGuessTarget(target.value, false);
    socket.emit('askSymbol', { targetId: target.value, symbol, actorId: controlId });
    input.value = '';
  };
  const sendFullGuess = () => {
    const target = $('fullTarget');
    const input = $('fullGuess');
    if (!target || !input) return;
    uiClick();
    socket.emit('guessFull', { targetId: target.value, guess: input.value, interruptive: false, actorId: controlId });
  };
  const sendInterruptGuess = () => {
    const target = $('interruptTarget');
    const input = $('interruptGuess');
    if (!target || !input) return;
    uiClick();
    socket.emit('guessFull', { targetId: target.value, guess: input.value, interruptive: true, actorId: state.youId });
  };

  const askBtn = $('askBtn');
  if (askBtn) askBtn.onclick = sendSymbolGuess;
  const symbolInput = $('symbolInput');
  if (symbolInput) {
    if (isPhoneLayout()) {
      symbolInput.setAttribute('readonly', 'readonly');
      symbolInput.setAttribute('inputmode', 'none');
      symbolInput.setAttribute('aria-readonly', 'true');
    }
    symbolInput.addEventListener('input', () => {
      const raw = symbolInput.value.toUpperCase();
      const match = raw.match(/[A-Z.]/);
      symbolInput.value = match ? match[0] : '';
    });
    symbolInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendSymbolGuess(); }
    });
  }
  const dotBtn = $('dotBtn');
  if (dotBtn) dotBtn.onclick = () => { uiClick(); const input = $('symbolInput'); input.value = '.'; input.dispatchEvent(new Event('input', { bubbles: true })); };
  document.querySelectorAll('[data-letter]').forEach(btn => btn.onclick = () => { uiClick(); const input = $('symbolInput'); if (!input) return; input.value = btn.dataset.letter === 'BACK' ? '' : btn.dataset.letter; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const fullBtn = $('fullGuessBtn');
  if (fullBtn) fullBtn.onclick = sendFullGuess;
  const fullGuess = $('fullGuess');
  if (fullGuess && isPhoneLayout()) {
    fullGuess.setAttribute('readonly', 'readonly');
    fullGuess.setAttribute('inputmode', 'none');
    fullGuess.setAttribute('aria-readonly', 'true');
  }
  if (fullGuess) fullGuess.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendFullGuess(); }
  });
  const intBtn = $('interruptBtn');
  if (intBtn) intBtn.onclick = sendInterruptGuess;
  const interruptGuess = $('interruptGuess');
  if (interruptGuess) interruptGuess.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendInterruptGuess(); }
  });
  const force = $('forceNextBtn');
  if (force) force.onclick = () => { uiClick(); socket.emit('forceNextTurn'); };
  const ownToggle = $('showOwnToggle');
  if (ownToggle) ownToggle.onchange = (e) => { uiClick(); showOwn = e.target.checked; renderGame(); };
  const verbalMiss = $('verbalMissBtn');
  if (verbalMiss) verbalMiss.onclick = () => { uiClick(); socket.emit('verbalMiss', { actorId: controlId, dotPenalty: false }); };
  const verbalDotMiss = $('verbalDotMissBtn');
  if (verbalDotMiss) verbalDotMiss.onclick = () => { uiClick(); socket.emit('verbalMiss', { actorId: controlId, dotPenalty: true }); };
  ['targetSelect', 'fullTarget', 'interruptTarget'].forEach(id => {
    const select = $(id);
    if (select) select.onchange = () => setSelectedGuessTarget(select.value, false);
  });
}

function attachTargetSelectionHandlers() {
  document.querySelectorAll('[data-target-select]').forEach(el => {
    const choose = (event) => {
      const exposureClick = event.target.closest?.('[data-expose-index],[data-manual-target]');
      if (exposureClick) return;
      const formClick = event.target.closest?.('input,select,label,a');
      if (formClick && formClick !== el) return;
      const id = el.getAttribute('data-target-select');
      if (!id) return;
      event.stopPropagation();
      uiClick();
      setSelectedGuessTarget(id, true);
      const symbol = $('symbolInput');
      if (symbol && !isPhoneLayout()) symbol.focus();
    };
    el.addEventListener('click', choose);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(event); }
    });
  });
}

function attachExposeHandlers() {
  document.querySelectorAll('[data-expose-index]').forEach(el => el.addEventListener('click', () => { uiClick(); socket.emit('chooseExpose', { index: Number.parseInt(el.getAttribute('data-expose-index'), 10), actorId: currentControlId() }); }));
  document.querySelectorAll('[data-manual-target]').forEach(el => el.addEventListener('click', () => { uiClick(); socket.emit('manualExpose', { targetId: el.getAttribute('data-manual-target'), index: Number.parseInt(el.getAttribute('data-manual-index'), 10) }); }));
}

function renderEnd() {
  setVisible('end');
  $('end').innerHTML = `
    <div class="endCard">
      <div class="tinyCaps">Vault Closed</div><h1>Game Over</h1><p class="goodText">${esc(state.endedReason || 'Game finished.')}</p>
      <div class="woodPanel">${renderScoreCards()}</div>
      <div class="buttonRow">${state.isHost ? '<button id="restartBtn" class="primaryGameBtn">Reset Room</button>' : '<span class="hint">Waiting for host to reset.</span>'}</div>
      <div class="woodPanel"><h2>Final Log</h2><ol class="activityLog">${state.log.map(item => `<li>${colorizeLog(item)}</li>`).join('')}</ol></div>
    </div>`;
  if (state.isHost) $('restartBtn').onclick = () => { uiClick(); socket.emit('restartRoom'); };
}

function startCountdown() {
  stopCountdown();
  if (!state?.turnEndsAt) return;
  const update = () => {
    const badge = $('turnTimerBadge');
    if (!badge) return;
    badge.textContent = formatRemaining(state.turnEndsAt);
    badge.closest('.timerPill')?.classList.toggle('danger', state.turnEndsAt - Date.now() <= 10000);
  };
  update();
  countdownTimer = setInterval(update, 250);
}
function stopCountdown() { if (countdownTimer) clearInterval(countdownTimer); countdownTimer = null; }
function formatRemaining(endsAt) { if (!endsAt) return '∞'; const ms = Math.max(0, endsAt - Date.now()); return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`; }

function copyText(text, okMessage) { navigator.clipboard?.writeText(text).then(() => { uiClick(); showToast(okMessage); }).catch(() => showToast('Copy failed.')); }
function avatar(playerOrName) {
  const player = typeof playerOrName === 'object' && playerOrName ? playerOrName : { name: playerOrName };
  const name = player.name || '?';
  const initials = String(name || '?').trim().split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase() || '?';
  const hue = Math.abs(hashCode(name)) % 360;
  if (player.avatar) return `<span class="avatar avatarPhoto" style="--h:${hue}"><img src="${esc(player.avatar)}" alt="" /></span>`;
  return `<span class="avatar" style="--h:${hue}">${esc(initials)}</span>`;
}

function wireAvatarUploads() {
  document.querySelectorAll('[data-avatar-id]').forEach(input => {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = await resizeAvatar(file);
        socket.emit('setAvatar', { playerId: input.getAttribute('data-avatar-id'), avatar: data });
        showToast('Avatar uploaded.');
      } catch (err) { showToast(err.message || 'Avatar upload failed.'); }
      input.value = '';
    });
  });
}

function resizeAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type)) return reject(new Error('Use a PNG, JPG, or WebP image.'));
    if (file.size > 5 * 1024 * 1024) return reject(new Error('Avatar image is too large.'));
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128; canvas.height = 128;
        const ctx = canvas.getContext('2d');
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, 128, 128);
        resolve(canvas.toDataURL('image/jpeg', 0.78));
      };
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}


function clearQueuedEffects() {
  effectQueue = [];
  effectShowing = false;
  if (effectQueueTimer) { clearTimeout(effectQueueTimer); effectQueueTimer = null; }
  effectTimeouts.forEach(id => clearTimeout(id));
  effectTimeouts = [];
  document.getElementById('effectLayer')?.remove();
}

function fitSlotGlyphs() {
  document.querySelectorAll('.slotTile .tileGlyphInner').forEach(inner => {
    const tile = inner.closest('.slotTile');
    if (!tile) return;
    inner.style.removeProperty('transform');
    inner.style.setProperty('--wv-glyph-scale', '1');
    const maxW = tile.clientWidth * 0.82;
    const maxH = tile.clientHeight * 0.82;
    const w = Math.max(1, inner.scrollWidth);
    const h = Math.max(1, inner.scrollHeight);
    const scale = Math.min(1, maxW / w, maxH / h);
    inner.style.setProperty('--wv-glyph-scale', String(Math.max(0.34, scale)));
  });
}

function processEffects(effects) {
  const fresh = (effects || [])
    .filter(e => e && e.id && !seenEffectIds.has(e.id))
    .sort((a, b) => (a.t || 0) - (b.t || 0));
  for (const e of fresh) {
    seenEffectIds.add(e.id);
    queueEffect(e);
  }
  if (seenEffectIds.size > 120) seenEffectIds = new Set(Array.from(seenEffectIds).slice(-80));
}

function queueEffect(effect) {
  effectQueue.push(effect);
  if (!effectShowing && !effectQueueTimer) scheduleNextEffect(EFFECT_INITIAL_PAUSE_MS);
}

function scheduleNextEffect(delay = EFFECT_BETWEEN_PAUSE_MS) {
  if (effectQueueTimer) clearTimeout(effectQueueTimer);
  effectQueueTimer = setTimeout(() => {
    effectQueueTimer = null;
    showNextEffect();
  }, Math.max(0, delay));
}

function finishEffect() {
  effectShowing = false;
  if (effectQueue.length) scheduleNextEffect(EFFECT_BETWEEN_PAUSE_MS);
}

function showNextEffect() {
  if (!state || suppressReconnect) { clearQueuedEffects(); return; }
  if (effectShowing) return;
  const effect = effectQueue.shift();
  if (!effect) { effectShowing = false; return; }
  effectShowing = true;

  const cardCode = effect?.meta?.cardCode || '';
  const isCardEvent = !!cardCode || /^card-/.test(effect?.type || '');
  const cpuAction = isCpuActionEffect(effect);

  if (isCardEvent) {
    showTurnCardEffect(effect, TURN_CARD_HOLD_MS, finishEffect);
    return;
  }

  if (cpuAction) {
    showCpuActionCard(effect, CPU_ACTION_HOLD_MS, finishEffect);
    return;
  }

  const layer = ensureEffectLayer();
  const sentiment = effectSentiment(effect);
  const icon = effectIcon(effect, sentiment);
  const cardLabel = cardCode ? `<small>${esc(cardLabelForCode(cardCode))}</small>` : '';
  const el = document.createElement('div');
  el.className = `effectBurst effect_${sentiment} effect_${safeClass(effect.type)}`;
  el.innerHTML = `<div class="effectRing"></div><div class="effectIcon">${icon}</div><strong>${esc(effect.message || 'Game event')}</strong>${cardLabel}`;
  layer.appendChild(el);
  playEffectSound(effect, sentiment);
  let hold = 1700;
  if (/correct|miss|bad/i.test(effect.type || '')) hold = 2100;
  const t1 = setTimeout(() => el.classList.add('effectLeaving'), hold);
  const t2 = setTimeout(() => { el.remove(); finishEffect(); }, hold + 480);
  effectTimeouts.push(t1, t2);
}

function isCpuActionEffect(effect) {
  const actorId = effect?.meta?.actorId || effect?.meta?.scorerId || '';
  if (!actorId || !state?.players) return false;
  const actor = state.players.find(p => p.id === actorId);
  if (!actor?.isCpu) return false;
  return !effect?.meta?.cardCode;
}

function deckOriginVars() {
  const deck = document.querySelector('.boardDeckSource .blueDeck') || document.querySelector('.blueDeck') || document.querySelector('.miniDeck');
  const layer = document.getElementById('effectLayer') || document.querySelector('.centerBoard') || document.body;
  if (!deck) return { x: '0px', y: '0px' };
  const r = deck.getBoundingClientRect();
  const lr = layer.getBoundingClientRect ? layer.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const lx = lr.left + lr.width / 2;
  const ly = lr.top + lr.height / 2;
  return { x: `${Math.round(cx - lx)}px`, y: `${Math.round(cy - ly)}px` };
}

function turnCardInner(effect, label = 'Activity Card') {
  const code = effect?.meta?.cardCode || '';
  const title = code ? cardLabelForCode(code) : (effect?.title || 'CPU Action');
  const icon = code ? cardIcon(code) : effectIcon(effect, effectSentiment(effect));
  const sentiment = effectSentiment(effect);
  const sub = code === 'NORMAL' ? 'Make a normal guess.' : (effect?.message || 'Game event');
  return `
    <div class="wv417TurnCard effect_${sentiment} ${code ? cardClass(code) : ''}" aria-live="polite">
      <div class="wv417TurnCardStage">
        <div class="wv417TurnCardFace wv417TurnCardBack" aria-hidden="true"><div class="backMark">✥</div><strong>WORD<br>VAULT</strong></div>
        <div class="wv417TurnCardFace wv417TurnCardFront">
          <div class="tinyCaps">${esc(label)}</div>
          <div class="turnCardIcon">${icon}</div>
          <h2>${esc(title)}</h2>
          <p>${esc(sub)}</p>
        </div>
      </div>
    </div>`;
}

function showTurnCardEffect(effect, holdMs, done) {
  const layer = ensureEffectLayer();
  const sentiment = effectSentiment(effect);
  const origin = deckOriginVars();
  const cardId = effect?.meta?.cardId || state?.currentCard?.id || '';
  if (cardId) {
    animatingTurnCardId = cardId;
    readyCenterTurnCardId = null;
    document.querySelectorAll('.centerTurnCardMini.currentCardReady').forEach(el => el.classList.remove('currentCardReady'));
  }
  const el = document.createElement('div');
  el.className = `wv417TurnCardOverlay turnCard_${sentiment}`;
  el.style.setProperty('--from-x', origin.x);
  el.style.setProperty('--from-y', origin.y);
  el.innerHTML = `<div class="wv417DeckFlash">Deck</div>${turnCardInner(effect, 'Turn Card')}`;
  layer.appendChild(el);

  const liftDelay = setTimeout(() => el.classList.add('wv417Lifted'), 80);
  const flipDelay = setTimeout(() => {
    el.classList.add('wv417FaceUp');
    playSoundAsset('flip', [260, 390, 520], 0.24, 0.04, 0.72);
  }, 520);
  const soundDelay = setTimeout(() => {
    const withoutSecondFlip = { ...effect, meta: { ...(effect.meta || {}), skipFlip: true } };
    playEffectSound(withoutSecondFlip, sentiment);
  }, 1050);

  // Hold the readable front, then shrink it back to the center deck. Only after
  // this animation finishes does the small current-card marker appear on the board.
  const shrinkAt = 1180 + Math.max(900, holdMs);
  const t1 = setTimeout(() => el.classList.add('wv417ShrinkToCenter'), shrinkAt);
  const t2 = setTimeout(() => {
    el.remove();
    const currentId = state?.currentCard?.id || '';
    const settledId = currentId || cardId;
    if (settledId && (!cardId || currentId === cardId)) {
      readyCenterTurnCardId = settledId;
      animatingTurnCardId = null;
      refreshCenterTurnCardMini(settledId);
      requestAnimationFrame(() => refreshCenterTurnCardMini(settledId));
    }
    done();
  }, shrinkAt + 560);
  effectTimeouts.push(liftDelay, flipDelay, soundDelay, t1, t2);
}

function showCpuActionCard(effect, holdMs, done) {
  const layer = ensureEffectLayer();
  const sentiment = effectSentiment(effect);
  const el = document.createElement('div');
  el.className = `wv417CpuActionOverlay turnCard_${sentiment} wv417FaceUp`;
  el.innerHTML = turnCardInner(effect, 'CPU Action');
  layer.appendChild(el);
  playEffectSound(effect, sentiment);
  const t1 = setTimeout(() => el.classList.add('wv417CpuActionLeaving'), holdMs);
  const t2 = setTimeout(() => { el.remove(); done(); }, holdMs + 430);
  effectTimeouts.push(t1, t2);
}

function ensureEffectLayer() {
  let layer = document.getElementById('effectLayer');
  const host = document.querySelector('.trayTheater') || document.querySelector('.centerBoard') || document.body;
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'effectLayer';
    host.appendChild(layer);
  } else if (layer.parentElement !== host && host !== document.body) {
    host.appendChild(layer);
  }
  return layer;
}

function effectSentiment(effect) {
  const code = effect?.meta?.cardCode || '';
  const type = effect?.type || '';
  const mine = effect?.meta?.actorId && state?.youId && effect.meta.actorId === state.youId;
  if (/miss|bad|minus/i.test(type) || code === 'SCORE_MINUS_10') return 'bad';
  if (/correct|plus|good/i.test(type) || /SCORE_PLUS|MULT|ADDITIONAL/.test(code)) return mine ? 'good' : 'special';
  if (code === 'NORMAL') return 'normal';
  if (code === 'SELF_DOT') return mine ? 'bad' : 'special';
  return code ? 'special' : 'normal';
}

function effectIcon(effect, sentiment) {
  const code = effect?.meta?.cardCode || '';
  if (code) return cardIcon(code);
  if (sentiment === 'good') return '✓';
  if (sentiment === 'bad') return '✕';
  if (effect?.type === 'correct-full') return '★';
  return '✦';
}

function cardLabelForCode(code) {
  const map = {
    NORMAL: 'Normal Turn', ADDITIONAL: 'Additional turn', LEFT_EXPOSE: 'Left expose', RIGHT_EXPOSE: 'Right expose', SELF_DOT: 'Expose your dot',
    MULT_3: 'Triple first guess', MULT_4: 'Quadruple first guess', MULT_5: 'Quintuple first guess', SCORE_MINUS_10: '-10 points',
    SCORE_PLUS_15: '+15 points', SCORE_PLUS_20: '+20 points', SCORE_PLUS_25: '+25 points'
  };
  return map[code] || code;
}

function safeClass(value) { return String(value || 'event').replace(/[^a-z0-9_-]/gi, '_'); }

function playEffectSound(effect, sentiment) {
  if (!soundEnabled) return;
  const code = effect?.meta?.cardCode || '';
  const type = effect?.type || '';
  const isCardDraw = !!code || /^card/.test(type);
  const isLetterReveal = /^correct$/.test(type) || type === 'correct-full';
  const isBad = sentiment === 'bad' || /miss|bad|minus/i.test(type) || code === 'SCORE_MINUS_10' || code === 'SELF_DOT';
  const isMultiplier = /MULT_[345]/.test(code);
  const isGood = sentiment === 'good' || /correct|plus|good/i.test(type) || /SCORE_PLUS/.test(code);
  const skipFlip = !!effect?.meta?.skipFlip;

  // User-supplied card-flip sound: plays on turn/card draw and on letter flips.
  if ((isCardDraw && !skipFlip) || isLetterReveal) {
    playSoundAsset('flip', [260, 390, 520], 0.22, 0.04, 0.56);
  }

  if (isMultiplier) {
    return setTimeout(() => playSoundAsset('angel', [523.25, 659.25, 783.99, 1046.5], 0.9, 0.045, 0.72), 420);
  }
  if (isBad) {
    return setTimeout(() => playSoundAsset('boowomp', [180, 140, 95], 0.36, 0.06, 0.74), isCardDraw ? 360 : 120);
  }
  if (isGood) {
    return setTimeout(() => playSoundAsset('chaching', [392, 523.25, 659.25, 783.99], 0.32, 0.055, 0.72), isCardDraw || isLetterReveal ? 280 : 80);
  }
  if (code && code !== 'NORMAL') {
    return setTimeout(() => playTone([246.94, 329.63, 493.88, 659.25], 0.28, 0.045), 340);
  }
  if (!isCardDraw) playTone([293.66, 392, 523.25], 0.18, 0.038);
}

function hashCode(value) { return String(value || '').split('').reduce((acc, ch) => ((acc << 5) - acc) + ch.charCodeAt(0), 0); }
function progressGems(player) { const revealed = 12 - (player.hiddenCount || 0); return Array.from({ length: 12 }, (_, i) => `<span class="${i < revealed ? 'lit' : ''}"></span>`).join(''); }
function cardIcon(code) { const map = { NORMAL: '🎯', ADDITIONAL: '↻', LEFT_EXPOSE: '⇠', RIGHT_EXPOSE: '⇢', SELF_DOT: '•', MULT_3: '×3', MULT_4: '×4', MULT_5: '×5', SCORE_MINUS_10: '−10', SCORE_PLUS_15: '+15', SCORE_PLUS_20: '+20', SCORE_PLUS_25: '+25' }; return map[code] || '✦'; }
function shortCardTitle(title) { return String(title || '').replace('Opponent on Your ', '').replace(' the Value of Your First Guess', ' First Guess'); }
function cardClass(code) { if (/MULT/.test(code)) return 'multCard'; if (/SCORE_PLUS/.test(code)) return 'scoreCardType'; if (/SCORE_MINUS/.test(code)) return 'badCardType'; if (/EXPOSE|SELF_DOT/.test(code)) return 'exposeCard'; if (/ADDITIONAL/.test(code)) return 'extraCard'; return 'normalCard'; }
function colorizeLog(item) { return esc(item).replace(/\b([A-Z])\b/g, '<strong class="logLetter">$1</strong>'); }

function uiClick() { unlockAudioFromGesture(); playSoundAsset('click', [220, 330], 0.045, 0.022, 0.36); }
function playCardSound() { playSoundAsset('card', [330, 440, 660], 0.22, 0.035, 0.38); }
function playErrorSound() { playSoundAsset('error', [170, 120], 0.12, 0.04, 0.38); }
function playSoundAsset(name, fallbackFreqs, duration, toneVolume, assetVolume = 0.4) {
  if (!soundEnabled) return;
  unlockAudioFromGesture();
  if (name !== 'click') duckMusicForSfx();
  const src = SOUND_ASSETS[name];
  if (src) {
    try {
      const audio = new Audio(src);
      audio.volume = clamp(assetVolume * sfxVolume, 0, 1);
      const played = audio.play();
      if (played?.catch) played.catch(() => playTone(fallbackFreqs, duration, toneVolume * sfxVolume));
      return;
    } catch (_) {}
  }
  playTone(fallbackFreqs, duration, toneVolume * sfxVolume);
}
function ensureAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return audioCtx; }
function unlockAudioFromGesture() {
  userAudioUnlocked = true;
  try {
    if (audioCtx?.state === 'suspended') audioCtx.resume();
  } catch (_) {}
  if (musicEnabled && !localMusicStarted && musicSource === 'local') startAmbientMusic();
}
function playTone(freqs, duration = 0.1, volume = 0.04) {
  if (!soundEnabled) return;
  try {
    const ctx = ensureAudio();
    const now = ctx.currentTime;
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.035);
      gain.gain.setValueAtTime(0, now + i * 0.035);
      gain.gain.linearRampToValueAtTime(volume, now + i * 0.035 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.035 + duration);
      osc.connect(gain); gain.connect(ctx.destination); osc.start(now + i * 0.035); osc.stop(now + i * 0.035 + duration + 0.03);
    });
  } catch (_) {}
}

function startAmbientMusic() {
  if (!musicEnabled) return;
  if (musicSource === 'spotify') return startSpotifyPlayback().catch(err => { spotifyStatus = err.message || 'Spotify playback failed'; showToast(spotifyStatus); renderAudioControls(); });
  startLocalMusic();
}

function startLocalMusic() {
  if (!musicEnabled || musicSource !== 'local' || localMusicStarted) return;
  stopSpotifyPlayback();
  clearLocalFade();
  const a = new Audio();
  const b = new Audio();
  [a, b].forEach(audio => {
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    audio.volume = 0;
    audio.addEventListener('timeupdate', maybeCrossfadeLocalTrack);
    audio.addEventListener('ended', () => nextLocalTrack(false));
  });
  musicPlayers = [a, b];
  activeMusicPlayer = a;
  standbyMusicPlayer = b;
  localMusicStarted = true;
  localCrossfadeStarted = false;
  loadAudioTrack(activeMusicPlayer, localTrackIndex);
  activeMusicPlayer.volume = 0;
  activeMusicPlayer.play().then(() => fadeAudio(activeMusicPlayer, 0, musicVolume, 1600)).catch(() => {
    localMusicStarted = false;
    showToast('Click once to allow music playback.');
  });
}

function loadAudioTrack(audio, index) {
  const track = MUSIC_TRACKS[((index % MUSIC_TRACKS.length) + MUSIC_TRACKS.length) % MUSIC_TRACKS.length];
  audio.src = track.src;
  audio.dataset.trackIndex = String(index);
  audio.dataset.title = track.title;
}

function maybeCrossfadeLocalTrack() {
  if (!localMusicStarted || localCrossfadeStarted || !activeMusicPlayer?.duration || !Number.isFinite(activeMusicPlayer.duration)) return;
  if (activeMusicPlayer.duration - activeMusicPlayer.currentTime <= MUSIC_CROSSFADE_MS / 1000) {
    nextLocalTrack(false);
  }
}

function nextLocalTrack(manual = false) {
  if (musicSource !== 'local') return;
  if (!musicEnabled) { musicEnabled = true; localStorage.setItem('probe_music_loop', 'on'); }
  if (!localMusicStarted) return startLocalMusic();
  if (localCrossfadeStarted && !manual) return;
  localCrossfadeStarted = true;
  const nextIndex = (localTrackIndex + 1) % MUSIC_TRACKS.length;
  localTrackIndex = nextIndex;
  localStorage.setItem('probe_music_track_index', String(localTrackIndex));
  const outgoing = activeMusicPlayer;
  const incoming = standbyMusicPlayer || new Audio();
  loadAudioTrack(incoming, nextIndex);
  incoming.volume = 0;
  incoming.currentTime = 0;
  incoming.play().then(() => {
    crossfade(outgoing, incoming, MUSIC_CROSSFADE_MS, () => {
      try { outgoing.pause(); outgoing.currentTime = 0; } catch (_) {}
      activeMusicPlayer = incoming;
      standbyMusicPlayer = outgoing;
      localCrossfadeStarted = false;
      applyMusicVolume();
      renderAudioControls();
    });
  }).catch(() => { localCrossfadeStarted = false; });
}

function crossfade(outgoing, incoming, ms, done) {
  clearLocalFade();
  const start = performance.now();
  const base = musicVolume;
  localFadeTimer = setInterval(() => {
    const t = clamp((performance.now() - start) / ms, 0, 1);
    if (outgoing) outgoing.volume = base * (1 - t);
    if (incoming) incoming.volume = base * t;
    if (t >= 1) {
      clearLocalFade();
      done?.();
    }
  }, 60);
}

function fadeAudio(audio, from, to, ms, done) {
  clearLocalFade();
  const start = performance.now();
  audio.volume = clamp(from, 0, 1);
  localFadeTimer = setInterval(() => {
    const t = clamp((performance.now() - start) / ms, 0, 1);
    audio.volume = clamp(from + (to - from) * t, 0, 1);
    if (t >= 1) { clearLocalFade(); done?.(); }
  }, 60);
}
function clearLocalFade() { if (localFadeTimer) clearInterval(localFadeTimer); localFadeTimer = null; }

function applyMusicVolume() {
  const target = getDuckedMusicVolume();
  musicPlayers.forEach(audio => { if (audio && !audio.paused) audio.volume = clamp(target, 0, 1); });
  if (spotifyPlayer?.setVolume) spotifyPlayer.setVolume(clamp(musicVolume, 0, 1)).catch?.(() => {});
}
function getDuckedMusicVolume() { return musicDuckTimer ? musicVolume * MUSIC_DUCK_RATIO : musicVolume; }
function duckMusicForSfx() {
  if (!musicEnabled) return;
  if (musicDuckTimer) clearTimeout(musicDuckTimer);
  musicDuckTimer = setTimeout(() => { musicDuckTimer = null; applyMusicVolume(); }, MUSIC_DUCK_MS);
  musicPlayers.forEach(audio => { if (audio && !audio.paused) audio.volume = clamp(musicVolume * MUSIC_DUCK_RATIO, 0, 1); });
  if (spotifyPlayer?.setVolume) spotifyPlayer.setVolume(clamp(musicVolume * MUSIC_DUCK_RATIO, 0, 1)).catch?.(() => {});
}

function stopAmbientMusic() {
  stopLocalMusic();
  stopSpotifyPlayback();
}
function stopLocalMusic() {
  if (musicTimer) clearInterval(musicTimer);
  musicTimer = null;
  clearLocalFade();
  musicPlayers.forEach(audio => { try { audio.pause(); audio.currentTime = 0; } catch (_) {} });
  musicPlayers = [];
  activeMusicPlayer = null;
  standbyMusicPlayer = null;
  localMusicStarted = false;
  localCrossfadeStarted = false;
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }

async function loadSpotifyConfig() {
  try {
    const res = await fetch('/api/spotify/config');
    spotifyConfig = await res.json();
    spotifyStatus = spotifyConfig.enabled ? (hasSpotifyTokens() ? 'Connected, player not started' : 'Ready to connect') : 'Not configured';
  } catch (_) {
    spotifyConfig = { enabled: false };
    spotifyStatus = 'Spotify config unavailable';
  }
  renderAudioControls();
}
function hasSpotifyTokens() { return Boolean(localStorage.getItem(SPOTIFY_STORAGE.access) && localStorage.getItem(SPOTIFY_STORAGE.refresh)); }
function saveSpotifyToken(token) {
  if (!token?.access_token) return;
  localStorage.setItem(SPOTIFY_STORAGE.access, token.access_token);
  if (token.refresh_token) localStorage.setItem(SPOTIFY_STORAGE.refresh, token.refresh_token);
  const expiresAt = Date.now() + Math.max(30, Number(token.expires_in || 3600) - 45) * 1000;
  localStorage.setItem(SPOTIFY_STORAGE.expiry, String(expiresAt));
}
function connectSpotify() {
  if (!spotifyConfig?.enabled) return showToast('Spotify is not configured on Render yet.');
  const popup = window.open('/auth/spotify', 'spotifyAuth', 'width=520,height=720');
  if (!popup) showToast('Allow popups to connect Spotify.');
}
function handleSpotifyAuthMessage(event) {
  if (event.origin !== location.origin) return;
  if (event.data?.type === 'spotify-auth') {
    saveSpotifyToken(event.data.token);
    spotifyStatus = 'Connected';
    showToast('Spotify connected.');
    renderAudioControls();
    if (musicSource === 'spotify' && musicEnabled) startSpotifyPlayback();
    loadSpotifyPlaylists().then(renderAudioControls).catch(() => {});
  }
  if (event.data?.type === 'spotify-auth-error') {
    spotifyStatus = `Spotify error: ${event.data.error || 'authorization failed'}`;
    showToast(spotifyStatus);
    renderAudioControls();
  }
}
function disconnectSpotify() {
  Object.values(SPOTIFY_STORAGE).forEach(key => localStorage.removeItem(key));
  selectedSpotifyPlaylist = '';
  localStorage.removeItem('probe_spotify_playlist');
  spotifyPlaylists = [];
  spotifyStatus = 'Disconnected';
  stopSpotifyPlayback();
}
async function getSpotifyAccessToken() {
  let access = localStorage.getItem(SPOTIFY_STORAGE.access);
  const refresh = localStorage.getItem(SPOTIFY_STORAGE.refresh);
  const expiry = Number(localStorage.getItem(SPOTIFY_STORAGE.expiry) || '0');
  if (access && Date.now() < expiry) return access;
  if (!refresh) throw new Error('Connect Spotify first.');
  const res = await fetch('/api/spotify/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refresh }) });
  const token = await res.json();
  if (!res.ok) throw new Error(token.error || 'Spotify refresh failed.');
  saveSpotifyToken({ ...token, refresh_token: token.refresh_token || refresh });
  return token.access_token;
}
async function spotifyApi(path, opts = {}) {
  const token = await getSpotifyAccessToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.error || `Spotify request failed (${res.status})`);
  return data;
}
async function loadSpotifyPlaylists() {
  try {
    const data = await spotifyApi('/me/playlists?limit=30');
    spotifyPlaylists = (data.items || []).map(pl => ({ name: pl.name, uri: pl.uri, id: pl.id }));
    spotifyStatus = spotifyPlaylists.length ? 'Playlists loaded' : 'No playlists found';
  } catch (err) {
    spotifyStatus = err.message || 'Could not load playlists';
    showToast(spotifyStatus);
  }
}
function loadSpotifySdk() {
  if (window.Spotify?.Player) return Promise.resolve();
  if (spotifySdkLoading) return spotifySdkLoading;
  spotifySdkLoading = new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    script.onerror = () => reject(new Error('Could not load Spotify player SDK.'));
    document.body.appendChild(script);
  });
  return spotifySdkLoading;
}
function waitForSpotifyDevice(timeoutMs = 8000) {
  if (spotifyDeviceId) return Promise.resolve(spotifyDeviceId);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (spotifyDeviceId) { clearInterval(timer); resolve(spotifyDeviceId); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('Spotify player is still connecting. Try Play Spotify again in a few seconds.')); }
    }, 200);
  });
}

async function transferSpotifyPlayback(deviceId) {
  if (!deviceId) return;
  await spotifyApi('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play: false }) });
}

async function startSpotifyPlayback() {
  if (musicSource !== 'spotify') return;
  if (!hasSpotifyTokens()) throw new Error('Connect Spotify first.');
  stopLocalMusic();
  await loadSpotifySdk();
  const token = await getSpotifyAccessToken();
  if (!spotifyPlayer) {
    spotifyPlayer = new Spotify.Player({
      name: 'Word Vault Game Music',
      getOAuthToken: async cb => cb(await getSpotifyAccessToken()),
      volume: clamp(musicVolume, 0, 1)
    });
    spotifyPlayer.addListener('ready', ({ device_id }) => { spotifyDeviceId = device_id; spotifyReady = true; spotifyStatus = 'Spotify player ready'; renderAudioControls(); });
    spotifyPlayer.addListener('not_ready', () => { spotifyReady = false; spotifyStatus = 'Spotify player went offline'; renderAudioControls(); });
    spotifyPlayer.addListener('initialization_error', ({ message }) => { spotifyStatus = message; renderAudioControls(); });
    spotifyPlayer.addListener('authentication_error', ({ message }) => { spotifyStatus = message; renderAudioControls(); });
    spotifyPlayer.addListener('account_error', ({ message }) => { spotifyStatus = `${message} — Spotify Premium is required for the in-browser player.`; renderAudioControls(); });
    spotifyPlayer.addListener('playback_error', ({ message }) => { spotifyStatus = message; renderAudioControls(); });
  }
  await spotifyPlayer.connect();
  await spotifyPlayer.setVolume(clamp(musicVolume, 0, 1)).catch?.(() => {});
  spotifyStatus = spotifyReady ? 'Spotify player ready' : 'Connecting Spotify player...';
  renderAudioControls();
  const deviceId = await waitForSpotifyDevice();
  if (selectedSpotifyPlaylist) await playSpotifyContext(selectedSpotifyPlaylist, deviceId);
  else showToast('Load/select a Spotify playlist in the audio settings.');
  return token;
}
async function playSpotifyContext(uri, knownDeviceId = null) {
  if (!uri) return showToast('Choose a Spotify playlist first.');
  selectedSpotifyPlaylist = uri;
  localStorage.setItem('probe_spotify_playlist', uri);
  const deviceId = knownDeviceId || await waitForSpotifyDevice();
  await transferSpotifyPlayback(deviceId);
  await new Promise(resolve => setTimeout(resolve, 350));
  await spotifyApi(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT', body: JSON.stringify({ context_uri: uri }) });
  spotifyStatus = 'Playing Spotify playlist';
  renderAudioControls();
}
function stopSpotifyPlayback() {
  if (spotifyPlayer?.pause) spotifyPlayer.pause().catch?.(() => {});
}

function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }


window.WordVaultApi = {
  joinDiscordActivityRoom(payload = {}) {
    const name = String(payload.name || 'Discord Player').trim().slice(0, 24) || 'Discord Player';
    const token = String(payload.token || getOrCreateToken()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || getOrCreateToken();
    localStorage.setItem(STORAGE.name, name);
    localStorage.setItem(STORAGE.token, token);
    if ($('nameInput')) $('nameInput').value = name;
    suppressReconnect = false;
    socket.emit('joinDiscordActivityRoom', { ...payload, name, token });
  },
  setDiscordStatus(message, mode = 'info') {
    const text = String(message || '').slice(0, 180);
    document.body.classList.add('discordActivityMode');
    let badge = document.getElementById('discordActivityBadge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'discordActivityBadge';
      badge.className = 'discordActivityBadge';
      document.body.appendChild(badge);
    }
    badge.className = `discordActivityBadge ${mode}`;
    badge.textContent = text;
  },
  clearDiscordStatusSoon() {
    const badge = document.getElementById('discordActivityBadge');
    if (badge) setTimeout(() => badge.classList.add('softHidden'), 4200);
  },
  showToast,
  get state() { return state; }
};

renderHomeHints();
updateChrome();

window.addEventListener('resize', () => requestAnimationFrame(fitSlotGlyphs));
