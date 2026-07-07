const socket = io();
let state = null;
let showOwn = false;
let countdownTimer = null;
let suppressReconnect = false;
let lastCardId = null;
let soundEnabled = localStorage.getItem('probe_sound') !== 'off';
let musicEnabled = localStorage.getItem('probe_music_loop') === 'on';
let audioCtx = null;
let musicTimer = null;
let musicStep = 0;
let ambientAudio = null;
let useProceduralAmbient = false;
let visualSkin = localStorage.getItem('probe_visual_skin') || 'wood';
let layoutMode = localStorage.getItem('probe_layout_mode') || 'stacked';
let seenEffectIds = new Set();
let effectQueue = [];
let effectShowing = false;
let effectTimeouts = [];
let hasReceivedInitialState = false;

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
  ambience: 'assets/sounds/vault-ambience-loop.wav',
  flip: 'assets/sounds/flip-card.mp3',
  angel: 'assets/sounds/angels-singing.mp3',
  chaching: 'assets/sounds/cha-ching.mp3',
  boowomp: 'assets/sounds/boo-womp.mp3'
};

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
  if (!soundEnabled) stopAmbientMusic();
  updateChrome();
  if (soundEnabled) playTone([440, 660], 0.08, 0.045);
});
$('ambienceBtn').addEventListener('click', () => {
  musicEnabled = !musicEnabled;
  if (musicEnabled) soundEnabled = true;
  localStorage.setItem('probe_sound', soundEnabled ? 'on' : 'off');
  localStorage.setItem('probe_music_loop', musicEnabled ? 'on' : 'off');
  if (musicEnabled) startAmbientMusic();
  else stopAmbientMusic();
  updateChrome();
});
$('roomPlate').addEventListener('click', () => { if (state?.code) copyText(state.code, 'Room code copied.'); });

socket.on('connect', () => { if (!state && !suppressReconnect) attemptReconnect(); });
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
  $('musicBtn').classList.toggle('muted', !soundEnabled);
  $('ambienceBtn').textContent = musicEnabled ? '♫' : '♬';
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

function renderPreviewTray(id = 'self') {
  const tray = ($(`secretWord_${id}`)?.value || '').trim().toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 12);
  const chars = Array.from({ length: 12 }, (_, i) => tray[i] || '');
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
  const newCard = state.currentCard?.id && state.currentCard.id !== lastCardId;
  lastCardId = state.currentCard?.id || lastCardId;
  const themeChip = state.currentTheme ? `<div class="matchPill themePill">${esc(state.currentTheme.emoji)} ${esc(state.currentTheme.name)}</div>` : '';

  $('game').innerHTML = `
    <div class="gameHud">
      <aside class="leftCommand">${renderActionPanel(isMyTurn, waitingOnControl, controlled)}</aside>
      <section class="centerBoard">
        <div class="matchStrip">
          <div class="matchPill">Active Game</div>
          ${themeChip}
          <div class="timerPill ${isMyTurn ? 'hot' : ''}"><span>⏳</span><strong id="turnTimerBadge">${formatRemaining(state.turnEndsAt)}</strong></div>
          <div class="matchPill">Turn: <strong>${esc(state.activePlayerName)}</strong> ${isMyTurn ? '<span class="greenDot"></span>' : ''}</div>
        </div>
        ${pending ? `<div class="pendingBanner"><strong>Pending:</strong> ${esc(pending.message)}</div>` : ''}
        ${state.settings.manualReveal ? `<div class="manualBanner"><strong>Click-to-expose is ON.</strong> In person or voice chat, the asked player can click a hidden slot instead of typing.</div>` : ''}
        <div class="boardAndCard ${layoutMode === 'round' ? 'roundLayout' : 'stackedLayout'}">
          <div class="trayTheater ${layoutMode === 'round' ? `circleTheater seatCount${orderedPlayersForBoard().length}` : ''}">${orderedPlayersForBoard().map((p, i, arr) => renderPlayerTray(p, i, arr.length)).join('')}</div>
          <div class="cardDock">
            ${renderCard(state.currentCard, newCard)}
            <div class="deckRow">
              <div class="miniDeck blueDeck"><span>${state.deckCount}</span><strong>Deck</strong></div>
              <div class="miniDeck grayDeck"><span>${state.discardCount}</span><strong>Discard</strong></div>
            </div>
          </div>
        </div>
        <div class="hintRibbon"><span>💡</span><strong>Hint</strong><em>${state.settings.manualReveal ? 'For no-typing play, say the ask out loud, click a matching card, or use Verbal Miss.' : 'Track the exposed letters, protect your dots, and use full guesses when the pattern is worth the risk.'}</em></div>
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
  requestAnimationFrame(fitSlotGlyphs);
  startCountdown();
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
      <select id="interruptTarget">${allOpponents.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.hiddenCount} hidden)</option>`).join('')}</select>
      <label>Guess</label>
      <input id="interruptGuess" placeholder="WORD or ..WORD....." />
      <button id="interruptBtn" class="purpleBtn">Make Interruptive Guess</button>
      <div class="tipBox">Wrong interruptive guesses cost points. Use this when you are confident.</div>`;
  }

  return `
    <div class="commandTitle">${state.settings.sharedDevice && state.isHost ? `${esc(controlled.name)} Controls` : 'Make a Guess'}</div>
    <label>Choose opponent</label>
    <select id="targetSelect">${opponents.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.hiddenCount} hidden)</option>`).join('')}</select>
    <label>Enter a letter or dot</label>
    <div class="guessInputRow"><input id="symbolInput" maxlength="5" placeholder="A or ." /><button id="dotBtn" class="dotButton" title="Ask for a dot card">•</button></div>
    <div class="tinyCaps centerText">or select from keyboard</div>
    <div class="letterKeyboard">${LETTERS.map(l => `<button class="keyBtn" data-letter="${l}">${l}</button>`).join('')}<button class="keyBtn" data-letter=".">•</button><button class="keyBtn wideKey" data-letter="BACK">⌫</button></div>
    <button id="askBtn" class="blueBtn">Guess Letter</button>
    ${state.settings.manualReveal ? `
      <div class="divider smallDivider"><span>no typing</span></div>
      <div class="manualControls">
        <button id="verbalMissBtn" class="secondaryGameBtn">Verbal Miss / Next Turn</button>
        <button id="verbalDotMissBtn" class="dangerBtn">Dot Miss -50</button>
      </div>
      <p class="hint">Say the ask out loud. If they have it, they click the matching hidden card. If not, use a miss button.</p>` : ''}
    <div class="divider smallDivider"><span>or</span></div>
    <label>Full word / tray guess</label>
    <select id="fullTarget">${allOpponents.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
    <input id="fullGuess" placeholder="WORD or ..WORD....." />
    <button id="fullGuessBtn" class="purpleBtn">Guess The Word</button>
    ${state.isHost ? '<button id="forceNextBtn" class="dangerBtn">Host: Force Next Turn</button>' : ''}
    <div class="tipBox">Guess letters to reveal the hidden word, or go all-in with a full word guess.</div>`;
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
  if (layoutMode !== 'round' || !state?.players?.length) return state?.players || [];
  const anchor = currentControlId() || state.youId;
  const idx = state.players.findIndex(p => p.id === anchor);
  if (idx < 0) return state.players;
  return [...state.players.slice(idx), ...state.players.slice(0, idx)];
}

function canEditAvatar(player) {
  return player && !player.isCpu && (player.id === state?.youId || (state?.isHost && state?.settings?.sharedDevice && player.isLocal));
}

function renderPlayerTray(player, seatIndex = 0, seatTotal = 1) {
  const pending = state.awaitingExpose;
  const isMe = player.id === state.youId;
  const slots = isMe && showOwn && player.privateSlots ? player.privateSlots : player.publicSlots;
  const active = player.id === state.activePlayerId;
  return `
    <div class="playerRack ${active ? 'activeRack' : ''} ${player.isCpu ? 'cpuRack' : ''} seat${seatIndex}" style="--seat:${seatIndex};--seats:${seatTotal}">
      <div class="rackNameplate">${avatar(player)} <span class="rackNameText">${esc(player.name)} ${isMe ? '<span>You</span>' : ''} ${player.isCpu ? '<span>CPU</span>' : ''} ${player.isLocal ? '<span>Local</span>' : ''}</span></div>
      <div class="wordRack">
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
  return `<div class="slotShell" data-slot-index="${slot.index}"><div class="slotValue">${[5,5,5,5,10,10,10,10,15,15,15,15][slot.index]}</div><button class="${classes.join(' ')}" ${attrs}><span class="tileGlyph">${esc(display)}</span></button></div>`;
}

function attachActionHandlers(controlId) {
  const sendSymbolGuess = () => {
    const target = $('targetSelect');
    const input = $('symbolInput');
    if (!target || !input) return;
    uiClick();
    socket.emit('askSymbol', { targetId: target.value, symbol: input.value.trim(), actorId: controlId });
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
  if (symbolInput) symbolInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendSymbolGuess(); }
  });
  const dotBtn = $('dotBtn');
  if (dotBtn) dotBtn.onclick = () => { uiClick(); $('symbolInput').value = '.'; $('symbolInput').focus(); };
  document.querySelectorAll('[data-letter]').forEach(btn => btn.onclick = () => { uiClick(); const input = $('symbolInput'); if (!input) return; input.value = btn.dataset.letter === 'BACK' ? '' : btn.dataset.letter; input.focus(); });
  const fullBtn = $('fullGuessBtn');
  if (fullBtn) fullBtn.onclick = sendFullGuess;
  const fullGuess = $('fullGuess');
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
  effectTimeouts.forEach(id => clearTimeout(id));
  effectTimeouts = [];
  document.getElementById('effectLayer')?.remove();
}

function fitSlotGlyphs() {
  document.querySelectorAll('.slotTile .tileGlyph').forEach(glyph => {
    const tile = glyph.closest('.slotTile');
    if (!tile) return;
    glyph.style.transform = 'translate(-50%, -50%) scale(1)';
    const maxW = tile.clientWidth * 0.74;
    const maxH = tile.clientHeight * 0.70;
    const w = Math.max(1, glyph.scrollWidth);
    const h = Math.max(1, glyph.scrollHeight);
    const scale = Math.min(1, maxW / w, maxH / h);
    glyph.style.transform = `translate(-50%, -50%) scale(${Math.max(0.38, scale)})`;
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
  if (!effectShowing) showNextEffect();
}

function showNextEffect() {
  if (!state || suppressReconnect) { clearQueuedEffects(); return; }
  const effect = effectQueue.shift();
  if (!effect) { effectShowing = false; return; }
  effectShowing = true;

  const cardCode = effect?.meta?.cardCode || '';
  const isCardEvent = !!cardCode || /^card-/.test(effect?.type || '');
  const cpuAction = isCpuActionEffect(effect);

  if (isCardEvent) {
    showTurnCardEffect(effect, 5000, () => showNextEffect());
    return;
  }

  if (cpuAction) {
    showCpuActionCard(effect, 3000, () => showNextEffect());
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
  let hold = 2600;
  if (/correct|miss|bad/i.test(effect.type || '')) hold = 3200;
  const t1 = setTimeout(() => el.classList.add('effectLeaving'), hold);
  const t2 = setTimeout(() => { el.remove(); showNextEffect(); }, hold + 720);
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
  const deck = document.querySelector('.blueDeck') || document.querySelector('.miniDeck');
  if (!deck) return { x: '0px', y: '210px' };
  const r = deck.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return { x: `${Math.round(cx - window.innerWidth / 2)}px`, y: `${Math.round(cy - window.innerHeight / 2)}px` };
}

function turnCardInner(effect, label = 'Activity Card') {
  const code = effect?.meta?.cardCode || '';
  const title = code ? cardLabelForCode(code) : (effect?.title || 'CPU Action');
  const icon = code ? cardIcon(code) : effectIcon(effect, effectSentiment(effect));
  const sentiment = effectSentiment(effect);
  const sub = effect?.message || 'Game event';
  return `
    <div class="turnCard3d effect_${sentiment} ${code ? cardClass(code) : ''}">
      <div class="turnCardBack"><div class="backMark">✥</div><strong>WORD<br>VAULT</strong></div>
      <div class="turnCardFace">
        <div class="tinyCaps">${esc(label)}</div>
        <div class="turnCardIcon">${icon}</div>
        <h2>${esc(title)}</h2>
        <p>${esc(sub)}</p>
      </div>
    </div>`;
}

function showTurnCardEffect(effect, holdMs, done) {
  const layer = ensureEffectLayer();
  const sentiment = effectSentiment(effect);
  const origin = deckOriginVars();
  const el = document.createElement('div');
  el.className = `turnCardOverlay turnCard_${sentiment}`;
  el.style.setProperty('--from-x', origin.x);
  el.style.setProperty('--from-y', origin.y);
  el.innerHTML = `<div class="deckFlash">Deck</div>${turnCardInner(effect, 'Turn Card')}`;
  layer.appendChild(el);
  playEffectSound(effect, sentiment);

  const leaveAt = 1050 + holdMs;
  const t1 = setTimeout(() => el.classList.add('turnCardReturning'), leaveAt);
  const t2 = setTimeout(() => { el.remove(); done(); }, leaveAt + 900);
  effectTimeouts.push(t1, t2);
}

function showCpuActionCard(effect, holdMs, done) {
  const layer = ensureEffectLayer();
  const sentiment = effectSentiment(effect);
  const el = document.createElement('div');
  el.className = `cpuActionOverlay turnCard_${sentiment}`;
  el.innerHTML = turnCardInner(effect, 'CPU Action');
  layer.appendChild(el);
  playEffectSound(effect, sentiment);
  const t1 = setTimeout(() => el.classList.add('cpuActionLeaving'), holdMs);
  const t2 = setTimeout(() => { el.remove(); done(); }, holdMs + 650);
  effectTimeouts.push(t1, t2);
}

function ensureEffectLayer() {
  let layer = document.getElementById('effectLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'effectLayer';
    document.body.appendChild(layer);
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
    NORMAL: 'Normal turn', ADDITIONAL: 'Additional turn', LEFT_EXPOSE: 'Left expose', RIGHT_EXPOSE: 'Right expose', SELF_DOT: 'Expose your dot',
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

  // User-supplied card-flip sound: plays on turn/card draw and on letter flips.
  if (isCardDraw || isLetterReveal) {
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

function uiClick() { playSoundAsset('click', [220, 330], 0.045, 0.022, 0.36); }
function playCardSound() { playSoundAsset('card', [330, 440, 660], 0.22, 0.035, 0.38); }
function playErrorSound() { playSoundAsset('error', [170, 120], 0.12, 0.04, 0.38); }
function playSoundAsset(name, fallbackFreqs, duration, toneVolume, assetVolume = 0.4) {
  if (!soundEnabled) return;
  const src = SOUND_ASSETS[name];
  if (src) {
    try {
      const audio = new Audio(src);
      audio.volume = assetVolume;
      const played = audio.play();
      if (played?.catch) played.catch(() => playTone(fallbackFreqs, duration, toneVolume));
      return;
    } catch (_) {}
  }
  playTone(fallbackFreqs, duration, toneVolume);
}
function ensureAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return audioCtx; }
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
  if (!soundEnabled || !musicEnabled) return;
  if (ambientAudio || musicTimer) return;
  try {
    ambientAudio = new Audio(SOUND_ASSETS.ambience);
    ambientAudio.loop = true;
    ambientAudio.volume = 0.22;
    const started = ambientAudio.play();
    if (started?.catch) started.catch(() => { ambientAudio = null; startProceduralAmbient(); });
    return;
  } catch (_) {
    ambientAudio = null;
    startProceduralAmbient();
  }
}

function startProceduralAmbient() {
  if (!soundEnabled || !musicEnabled || musicTimer) return;
  try { ensureAudio(); } catch (_) { return; }
  useProceduralAmbient = true;
  const chords = [[196, 246.94, 293.66], [174.61, 220, 261.63], [164.81, 207.65, 246.94], [146.83, 196, 246.94]];
  const playChord = () => {
    if (!soundEnabled || !musicEnabled) return stopAmbientMusic();
    const ctx = ensureAudio();
    const now = ctx.currentTime;
    const chord = chords[musicStep++ % chords.length];
    chord.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(i === 0 ? 0.018 : 0.011, now + 0.6);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.2);
      osc.connect(gain); gain.connect(ctx.destination); osc.start(now); osc.stop(now + 3.3);
    });
  };
  playChord();
  musicTimer = setInterval(playChord, 3400);
}
function stopAmbientMusic() {
  if (musicTimer) clearInterval(musicTimer);
  musicTimer = null;
  useProceduralAmbient = false;
  if (ambientAudio) {
    try { ambientAudio.pause(); ambientAudio.currentTime = 0; } catch (_) {}
    ambientAudio = null;
  }
}

function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }

renderHomeHints();
updateChrome();

window.addEventListener('resize', () => requestAnimationFrame(fitSlotGlyphs));
