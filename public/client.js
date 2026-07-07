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
  ambience: 'assets/sounds/vault-ambience-loop.wav'
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
  $('codeInput').value = code;
  if (token) localStorage.setItem(STORAGE.token, token);
  rememberRoom(code);
  suppressReconnect = false;
});
socket.on('state', (next) => {
  const oldCardId = state?.currentCard?.id || null;
  state = next;
  if (state?.code) rememberRoom(state.code);
  if (state?.currentCard?.id && state.currentCard.id !== oldCardId) playCardSound();
  render();
});
socket.on('errorMessage', (msg) => {
  showToast(msg);
  playErrorSound();
  if (/could not reconnect/i.test(msg)) clearSavedRoom();
});
socket.on('kicked', () => {
  state = null;
  clearSavedRoom();
  setVisible('home');
  updateChrome();
  showToast('You were removed from the room.');
});
socket.on('leftRoom', () => {
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
        <p>Choose a word up to 12 letters. Dots hide the true word length by filling spaces before or after your word.</p>
        <div class="notice">Your tray is private. Other players only see covered spaces until something is revealed.</div>
        ${me.ready ? `<p class="goodText bigReady">Your secret tray is locked in. Waiting for everyone else.</p>` : secretFormHtml('self')}
      </div>
      <div class="woodPanel readyPanel">
        <h2>Players</h2>
        <ul class="playerList">${state.players.map(p => `<li>${avatar(p)} <span><strong>${esc(p.name)}</strong> ${p.isCpu ? '<em class="cpuTag">CPU</em>' : ''}<br>${p.ready ? '<span class="goodText">ready</span>' : '<span class="hint">not ready</span>'}</span></li>`).join('')}</ul>
      </div>
    </div>`;
  if (!me.ready) wireSecretForm('self', (word, leftDots) => socket.emit('submitSecret', { word, leftDots }));
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
  nonCpu.filter(p => !p.ready).forEach(p => wireSecretForm(p.id, (word, leftDots) => socket.emit('submitSecretForPlayer', { playerId: p.id, word, leftDots })));
}

function secretFormHtml(id) {
  return `
    <div class="secretForm" data-secret-id="${esc(id)}">
      <label>Secret word</label>
      <input id="secretWord_${esc(id)}" maxlength="12" autocomplete="off" placeholder="Example: TREASURE" />
      <label>Dots before the word</label>
      <select id="leftDots_${esc(id)}"></select>
      <p class="hint">The remaining dots go after the word. Dots cannot go inside the word.</p>
      <div id="previewTray_${esc(id)}"></div>
      <div class="buttonRow"><button id="saveSecretBtn_${esc(id)}" class="primaryGameBtn hugeBtn">Lock In Secret Tray</button></div>
    </div>`;
}

function wireSecretForm(id, submitFn) {
  const wordInput = $(`secretWord_${id}`);
  const dotSelect = $(`leftDots_${id}`);
  const refreshDots = () => {
    const word = wordInput.value.trim().replace(/[^a-zA-Z]/g, '').toUpperCase();
    if (word !== wordInput.value) wordInput.value = word;
    const dotCount = 12 - Math.min(word.length || 1, 12);
    const old = Number.parseInt(dotSelect.value || '0', 10);
    dotSelect.innerHTML = '';
    for (let i = 0; i <= dotCount; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${i} left dot${i === 1 ? '' : 's'}`;
      dotSelect.appendChild(opt);
    }
    dotSelect.value = String(Math.min(old, dotCount));
    renderPreviewTray(id);
  };
  wordInput.addEventListener('input', refreshDots);
  dotSelect.addEventListener('change', () => renderPreviewTray(id));
  $(`saveSecretBtn_${id}`).onclick = () => { uiClick(); submitFn(wordInput.value, dotSelect.value); };
  refreshDots();
}

function renderPreviewTray(id = 'self') {
  const word = ($(`secretWord_${id}`)?.value || '').trim().replace(/[^a-zA-Z]/g, '').toUpperCase();
  const leftDots = Number.parseInt($(`leftDots_${id}`)?.value || '0', 10);
  const rightDots = Math.max(0, 12 - word.length - leftDots);
  const chars = [...Array(leftDots).fill('.'), ...word.split(''), ...Array(rightDots).fill('.')].slice(0, 12);
  $(`previewTray_${id}`).innerHTML = `<div class="wordRack previewRack">${chars.map((ch, i) => slotHtml({ ch, index: i, revealed: true }, false, true)).join('')}</div>`;
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
    <div class="guessInputRow"><input id="symbolInput" maxlength="5" placeholder="A" /><button id="dotBtn" class="dotButton">•</button></div>
    <div class="tinyCaps centerText">or select from keyboard</div>
    <div class="letterKeyboard">${LETTERS.map(l => `<button class="keyBtn" data-letter="${l}">${l}</button>`).join('')}<button class="keyBtn wideKey" data-letter="BACK">⌫</button></div>
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
  return `<div class="activityCard ${isNew ? 'cardDrawn' : ''} ${cardClass(card.code)}"><div class="cardAura"></div><div class="tinyCaps">Activity Card</div><div class="cardIcon">${cardIcon(card.code)}</div><h2>${esc(shortCardTitle(card.title))}</h2><p>${esc(card.text)}</p></div>`;
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
          const canManualClick = !pending && state.settings.manualReveal && canControlTray(player.id) && !slot.revealed;
          const ch = slot.revealed || (isMe && showOwn) ? slot.ch : '';
          return slotHtml({ ...slot, ch, playerId: player.id }, canPendingClick || canManualClick, slot.revealed || (isMe && showOwn), canManualClick && !canPendingClick);
        }).join('')}
      </div>
      <div class="rackFooter"><div class="gemRow">${progressGems(player)}</div><label class="showOwnLabel">${isMe ? `<input id="showOwnToggle" type="checkbox" ${showOwn ? 'checked' : ''} /> show mine` : ''}</label></div>
    </div>`;
}

function slotHtml(slot, clickable = false, revealed = false, manual = false) {
  const display = slot.ch === '.' ? '•' : (slot.ch || '');
  const classes = ['slotTile'];
  if (!revealed) classes.push('coveredTile');
  if (revealed) classes.push('revealedTile');
  if (revealed && slot.ch === '.') classes.push('dotTile');
  if (clickable) classes.push(manual ? 'manualClickableTile' : 'clickableTile');
  const attrs = clickable ? (manual ? `data-manual-target="${esc(slot.playerId)}" data-manual-index="${slot.index}"` : `data-expose-index="${slot.index}"`) : '';
  return `<div class="slotShell"><div class="slotValue">${[5,5,5,5,10,10,10,10,15,15,15,15][slot.index]}</div><button class="${classes.join(' ')}" ${attrs}>${esc(display)}</button></div>`;
}

function attachActionHandlers(controlId) {
  const askBtn = $('askBtn');
  if (askBtn) askBtn.onclick = () => { uiClick(); socket.emit('askSymbol', { targetId: $('targetSelect').value, symbol: $('symbolInput').value.trim(), actorId: controlId }); };
  const dotBtn = $('dotBtn');
  if (dotBtn) dotBtn.onclick = () => { uiClick(); $('symbolInput').value = 'dot'; $('symbolInput').focus(); };
  document.querySelectorAll('[data-letter]').forEach(btn => btn.onclick = () => { uiClick(); const input = $('symbolInput'); if (!input) return; input.value = btn.dataset.letter === 'BACK' ? '' : btn.dataset.letter; input.focus(); });
  const fullBtn = $('fullGuessBtn');
  if (fullBtn) fullBtn.onclick = () => { uiClick(); socket.emit('guessFull', { targetId: $('fullTarget').value, guess: $('fullGuess').value, interruptive: false, actorId: controlId }); };
  const intBtn = $('interruptBtn');
  if (intBtn) intBtn.onclick = () => { uiClick(); socket.emit('guessFull', { targetId: $('interruptTarget').value, guess: $('interruptGuess').value, interruptive: true, actorId: state.youId }); };
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
function hashCode(value) { return String(value || '').split('').reduce((acc, ch) => ((acc << 5) - acc) + ch.charCodeAt(0), 0); }
function progressGems(player) { const revealed = 12 - (player.hiddenCount || 0); return Array.from({ length: 12 }, (_, i) => `<span class="${i < revealed ? 'lit' : ''}"></span>`).join(''); }
function cardIcon(code) { const map = { NORMAL: '🎯', ADDITIONAL: '↻', LEFT_EXPOSE: '⇠', RIGHT_EXPOSE: '⇢', SELF_DOT: '•', MULT_3: '×3', MULT_4: '×4', MULT_5: '×5', SCORE_MINUS_10: '−10', SCORE_PLUS_15: '+15', SCORE_PLUS_20: '+20', SCORE_PLUS_25: '+25' }; return map[code] || '✦'; }
function shortCardTitle(title) { return String(title || '').replace('Opponent on Your ', '').replace(' the Value of Your First Guess', ' First Guess'); }
function cardClass(code) { if (/MULT/.test(code)) return 'multCard'; if (/SCORE_PLUS/.test(code)) return 'scoreCardType'; if (/SCORE_MINUS/.test(code)) return 'badCardType'; if (/EXPOSE|SELF_DOT/.test(code)) return 'exposeCard'; if (/ADDITIONAL/.test(code)) return 'extraCard'; return 'normalCard'; }
function colorizeLog(item) { return esc(item).replace(/\b([A-Z])\b/g, '<strong class="logLetter">$1</strong>'); }

function uiClick() { playSoundAsset('click', [220, 330], 0.045, 0.022, 0.36); }
function playCardSound() { playSoundAsset('card', [330, 440, 660], 0.12, 0.035, 0.46); }
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
