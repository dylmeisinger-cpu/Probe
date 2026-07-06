const socket = io();
let state = null;
let showOwn = false;
let countdownTimer = null;
let suppressReconnect = false;
let lastCardId = null;
let soundEnabled = localStorage.getItem('probe_sound') !== 'off';
let audioCtx = null;

const STORAGE = {
  name: 'probe_name',
  token: 'probe_token',
  room: 'probe_room'
};

const $ = (id) => document.getElementById(id);

function getOrCreateToken() {
  let token = localStorage.getItem(STORAGE.token);
  if (token) return token;
  if (window.crypto?.randomUUID) token = window.crypto.randomUUID().replace(/-/g, '');
  else token = `guest_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  localStorage.setItem(STORAGE.token, token);
  return token;
}

function savedName() {
  return localStorage.getItem(STORAGE.name) || '';
}

function savedRoom() {
  return localStorage.getItem(STORAGE.room) || '';
}

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

$('nameInput').value = savedName();
$('codeInput').value = new URLSearchParams(location.search).get('room') || savedRoom();
$('createBtn').addEventListener('click', () => { uiClick(); createRoom(); });
$('joinBtn').addEventListener('click', () => { uiClick(); joinRoom(); });
$('rulesBtn').addEventListener('click', () => { uiClick(); $('rulesDialog').showModal(); });
$('leaveBtn').addEventListener('click', () => { uiClick(); leaveRoom(); });
$('musicBtn').addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem('probe_sound', soundEnabled ? 'on' : 'off');
  updateChrome();
  if (soundEnabled) playTone([440, 660], 0.08, 0.045);
});
$('roomPlate').addEventListener('click', () => {
  if (state?.code) copyText(state.code, 'Room code copied.');
});

socket.on('connect', () => {
  if (!state && !suppressReconnect) attemptReconnect();
});

socket.on('disconnect', () => {
  if (state) showToast('Connection lost. Trying to reconnect...');
});

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
  if (state?.currentCard?.id && state.currentCard.id !== oldCardId) {
    playCardSound();
  }
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
  if (requireValue && !name) {
    showToast('Enter your name first.');
    throw new Error('Name required');
  }
  const finalName = name || 'Player';
  localStorage.setItem(STORAGE.name, finalName);
  return finalName;
}

function updateChrome() {
  $('topRoomCode').textContent = state?.code || '----';
  $('musicBtn').textContent = soundEnabled ? '♪' : '♩';
  $('musicBtn').classList.toggle('muted', !soundEnabled);
  $('leaveBtn').style.visibility = state ? 'visible' : 'hidden';
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
  if (!state) {
    renderHomeHints();
    return setVisible('home');
  }
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
    </div>
  ` : '';
  if ($('resumeBtn')) $('resumeBtn').onclick = () => { uiClick(); attemptReconnect(); };
  if ($('clearSavedBtn')) $('clearSavedBtn').onclick = () => { uiClick(); clearSavedRoom(); renderHomeHints(); };
}

function renderLobby() {
  setVisible('lobby');
  const inviteLink = `${location.origin}?room=${encodeURIComponent(state.code)}`;
  $('lobby').innerHTML = `
    <div class="lobbyShell">
      <div class="lobbyHeader">
        <div>
          <div class="tinyCaps">Room Lobby</div>
          <h1>Gather Your Players</h1>
          <p>Share the code or invite link. Once setup starts, the vault locks and no new players can join.</p>
        </div>
        <div class="bigRoomCode">${esc(state.code)}</div>
      </div>

      <div class="grid twoUp">
        <div class="woodPanel">
          <h2>Players</h2>
          <ul class="playerList">${state.players.map(p => `<li>
            <span>${avatar(p.name)} <strong>${esc(p.name)}</strong> ${p.isHost ? '<em class="hostTag">HOST</em>' : ''} ${p.connected ? '' : '<span class="dangerText">disconnected</span>'}</span>
            ${state.isHost && !p.isHost ? `<button class="ghostBtn smallBtn" data-kick-id="${esc(p.id)}">Remove</button>` : ''}
          </li>`).join('')}</ul>
        </div>

        <div class="woodPanel">
          <h2>Game Settings</h2>
          <label>Turn timer</label>
          <select id="timerSelect" ${state.isHost ? '' : 'disabled'}>
            ${[0, 30, 45, 60, 90, 120].map(v => `<option value="${v}" ${state.settings.turnTimerSec === v ? 'selected' : ''}>${v === 0 ? 'Off' : `${v} seconds`}</option>`).join('')}
          </select>
          <p class="hint">If time runs out, the turn counts as a miss and advances.</p>

          <div class="buttonRow">
            <button id="copyCodeBtn" class="secondaryGameBtn">Copy Code</button>
            <button id="copyLinkBtn" class="secondaryGameBtn">Copy Invite Link</button>
          </div>
        </div>
      </div>

      <div class="lobbyStart">
        ${state.isHost ? '<button id="startSetupBtn" class="primaryGameBtn hugeBtn">Start Secret Word Setup</button>' : '<span class="hint">Waiting for host to start.</span>'}
      </div>
    </div>
  `;

  $('copyCodeBtn').onclick = () => { uiClick(); copyText(state.code, 'Room code copied.'); };
  $('copyLinkBtn').onclick = () => { uiClick(); copyText(inviteLink, 'Invite link copied.'); };
  if (state.isHost) {
    $('startSetupBtn').onclick = () => { uiClick(); socket.emit('startSetup'); };
    $('timerSelect').onchange = (e) => socket.emit('setSettings', { turnTimerSec: Number.parseInt(e.target.value, 10) });
  }
  document.querySelectorAll('[data-kick-id]').forEach(btn => btn.onclick = () => { uiClick(); socket.emit('kickPlayer', { playerId: btn.dataset.kickId }); });
}

function renderSetup() {
  setVisible('setup');
  const me = state.players.find(p => p.id === state.youId);
  $('setup').innerHTML = `
    <div class="setupShell">
      <div class="setupCard">
        <div class="tinyCaps">Room ${esc(state.code)}</div>
        <h1>Build Your Secret Tray</h1>
        <p>Choose a word up to 12 letters. Dots hide the true word length by filling spaces before or after your word.</p>
        <div class="notice">Your tray is private. Other players only see covered spaces until something is revealed.</div>

        ${me.ready ? `<p class="goodText bigReady">Your secret tray is locked in. Waiting for everyone else.</p>` : `
          <label>Secret word</label>
          <input id="secretWord" maxlength="12" autocomplete="off" placeholder="Example: TREASURE" />
          <label>Dots before the word</label>
          <select id="leftDots"></select>
          <p class="hint">The remaining dots go after the word. Dots cannot go inside the word.</p>
          <div id="previewTray"></div>
          <div class="buttonRow"><button id="saveSecretBtn" class="primaryGameBtn hugeBtn">Lock In Secret Tray</button></div>
        `}
      </div>

      <div class="woodPanel readyPanel">
        <h2>Players</h2>
        <ul class="playerList">${state.players.map(p => `<li>${avatar(p.name)} <span><strong>${esc(p.name)}</strong><br>${p.ready ? '<span class="goodText">ready</span>' : '<span class="hint">not ready</span>'}</span></li>`).join('')}</ul>
      </div>
    </div>
  `;

  if (!me.ready) {
    const wordInput = $('secretWord');
    const dotSelect = $('leftDots');
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
      renderPreviewTray();
    };
    wordInput.addEventListener('input', refreshDots);
    dotSelect.addEventListener('change', renderPreviewTray);
    $('saveSecretBtn').onclick = () => { uiClick(); socket.emit('submitSecret', { word: wordInput.value, leftDots: dotSelect.value }); };
    refreshDots();
  }
}

function renderPreviewTray() {
  const word = ($('secretWord')?.value || '').trim().replace(/[^a-zA-Z]/g, '').toUpperCase();
  const leftDots = Number.parseInt($('leftDots')?.value || '0', 10);
  const rightDots = Math.max(0, 12 - word.length - leftDots);
  const chars = [...Array(leftDots).fill('.'), ...word.split(''), ...Array(rightDots).fill('.')].slice(0, 12);
  $('previewTray').innerHTML = `<div class="wordRack previewRack">${chars.map((ch, i) => slotHtml({ ch, index: i, revealed: true }, false, true)).join('')}</div>`;
}

function renderGame() {
  setVisible('game');

  const isMyTurn = state.activePlayerId === state.youId;
  const pending = state.awaitingExpose;
  const waitingOnMe = pending && pending.playerId === state.youId;
  const newCard = state.currentCard?.id && state.currentCard.id !== lastCardId;
  lastCardId = state.currentCard?.id || lastCardId;

  $('game').innerHTML = `
    <div class="gameHud">
      <aside class="leftCommand">
        ${renderActionPanel(isMyTurn, waitingOnMe)}
      </aside>

      <section class="centerBoard">
        <div class="matchStrip">
          <div class="matchPill">Active Game</div>
          <div class="timerPill ${isMyTurn ? 'hot' : ''}">
            <span>⏳</span>
            <strong id="turnTimerBadge">${formatRemaining(state.turnEndsAt)}</strong>
          </div>
          <div class="matchPill">Turn: <strong>${esc(state.activePlayerName)}</strong> ${isMyTurn ? '<span class="greenDot"></span>' : ''}</div>
        </div>

        ${pending ? `<div class="pendingBanner"><strong>Pending:</strong> ${esc(pending.message)}</div>` : ''}

        <div class="boardAndCard">
          <div class="trayTheater">
            ${state.players.map(renderPlayerTray).join('')}
          </div>

          <div class="cardDock">
            ${renderCard(state.currentCard, newCard)}
            <div class="deckRow">
              <div class="miniDeck blueDeck"><span>${state.deckCount}</span><strong>Deck</strong></div>
              <div class="miniDeck grayDeck"><span>${state.discardCount}</span><strong>Discard</strong></div>
            </div>
          </div>
        </div>

        <div class="hintRibbon">
          <span>💡</span>
          <strong>Hint</strong>
          <em>Track the exposed letters, protect your dots, and use full guesses when the pattern is worth the risk.</em>
        </div>
      </section>

      <aside class="rightRail">
        <div class="railPanel">
          <h2>Scoreboard</h2>
          ${renderScoreCards()}
        </div>

        <div class="railPanel">
          <h2>Activity Log</h2>
          <ol class="activityLog">${state.log.slice(0, 8).map(item => `<li>${colorizeLog(item)}</li>`).join('')}</ol>
        </div>

        <div class="turnPanel ${isMyTurn ? 'yourTurn' : ''}">
          <div>
            <h2>${isMyTurn ? 'Your Turn' : 'Stand By'}</h2>
            <p>${isMyTurn ? 'Make a guess or attempt the full word.' : `Waiting for ${esc(state.activePlayerName)}.`}</p>
          </div>
          <span>⌛</span>
        </div>
      </aside>
    </div>
  `;

  attachActionHandlers();
  attachExposeHandlers();
  startCountdown();
}

function renderActionPanel(isMyTurn, waitingOnMe) {
  if (waitingOnMe) {
    return `
      <div class="commandTitle">Reveal Choice</div>
      <div class="notice">Choose one highlighted slot on your tray to expose.</div>
      <p class="hint">Only the allowed matching spaces are clickable.</p>
    `;
  }

  if (state.awaitingExpose) {
    return `
      <div class="commandTitle">Waiting</div>
      <p>Waiting for ${esc(state.players.find(p => p.id === state.awaitingExpose.playerId)?.name || 'a player')} to expose a slot.</p>
    `;
  }

  const opponents = state.players.filter(p => p.id !== state.youId && !p.allExposed);
  const allOpponents = state.players.filter(p => p.id !== state.youId);
  const letters = ['Q','W','E','R','T','Y','U','I','O','P','A','S','D','F','G','H','J','K','L','Z','X','C','V','B','N','M'];

  if (!isMyTurn) {
    return `
      <div class="commandTitle">Interruptive Guess</div>
      <p class="hint">You can guess an opponent’s word/tray when they still have 5+ hidden spaces.</p>
      <label>Target</label>
      <select id="interruptTarget">${allOpponents.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.hiddenCount} hidden)</option>`).join('')}</select>
      <label>Guess</label>
      <input id="interruptGuess" placeholder="WORD or ..WORD....." />
      <button id="interruptBtn" class="purpleBtn">Make Interruptive Guess</button>
      <div class="tipBox">Wrong interruptive guesses cost points. Use this when you are confident.</div>
    `;
  }

  return `
    <div class="commandTitle">Make a Guess</div>
    <label>Choose opponent</label>
    <select id="targetSelect">${opponents.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.hiddenCount} hidden)</option>`).join('')}</select>

    <label>Enter a letter or dot</label>
    <div class="guessInputRow">
      <input id="symbolInput" maxlength="5" placeholder="A" />
      <button id="dotBtn" class="dotButton">•</button>
    </div>

    <div class="tinyCaps centerText">or select from keyboard</div>
    <div class="letterKeyboard">
      ${letters.map(l => `<button class="keyBtn" data-letter="${l}">${l}</button>`).join('')}
      <button class="keyBtn wideKey" data-letter="BACK">⌫</button>
    </div>

    <button id="askBtn" class="blueBtn">Guess Letter</button>

    <div class="divider smallDivider"><span>or</span></div>

    <label>Full word / tray guess</label>
    <select id="fullTarget">${allOpponents.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
    <input id="fullGuess" placeholder="WORD or ..WORD....." />
    <button id="fullGuessBtn" class="purpleBtn">Guess The Word</button>

    ${state.isHost ? '<button id="forceNextBtn" class="dangerBtn">Host: Force Next Turn</button>' : ''}

    <div class="tipBox">Guess letters to reveal the hidden word, or go all-in with a full word guess.</div>
  `;
}

function renderCard(card, isNew) {
  if (!card) return '<div class="activityCard emptyCard"><p>No card drawn yet.</p></div>';
  return `
    <div class="activityCard ${isNew ? 'cardDrawn' : ''} ${cardClass(card.code)}">
      <div class="cardAura"></div>
      <div class="tinyCaps">Activity Card</div>
      <div class="cardIcon">${cardIcon(card.code)}</div>
      <h2>${esc(shortCardTitle(card.title))}</h2>
      <p>${esc(card.text)}</p>
    </div>
  `;
}

function renderScoreCards() {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  return `<div class="scoreCards">${sorted.map((p, idx) => `
    <div class="scoreCard ${p.id === state.activePlayerId ? 'activeScore' : ''}">
      <div class="avatarWrap">${idx === 0 ? '<span class="crown">♛</span>' : ''}${avatar(p.name)}</div>
      <div class="scoreInfo">
        <strong>${esc(p.name)} ${p.id === state.youId ? '<em>You</em>' : ''}</strong>
        <div class="gemRow">${progressGems(p)}</div>
      </div>
      <div class="scoreValue">${p.score}</div>
    </div>
  `).join('')}</div>`;
}

function renderPlayerTray(player) {
  const pending = state.awaitingExpose;
  const isMe = player.id === state.youId;
  const slots = isMe && showOwn && player.privateSlots ? player.privateSlots : player.publicSlots;
  const clickable = pending && pending.playerId === state.youId && player.id === state.youId;
  const active = player.id === state.activePlayerId;

  return `
    <div class="playerRack ${active ? 'activeRack' : ''}">
      <div class="rackNameplate">${esc(player.name)} ${isMe ? '<span>You</span>' : ''}</div>
      <div class="wordRack">
        ${slots.map(slot => {
          const canClick = clickable && pending.allowedIndices.includes(slot.index);
          const ch = slot.revealed || (isMe && showOwn) ? slot.ch : '';
          return slotHtml({ ...slot, ch }, canClick, slot.revealed || (isMe && showOwn));
        }).join('')}
      </div>
      <div class="rackFooter">
        <div class="gemRow">${progressGems(player)}</div>
        <label class="showOwnLabel">${isMe ? `<input id="showOwnToggle" type="checkbox" ${showOwn ? 'checked' : ''} /> show mine` : ''}</label>
      </div>
    </div>
  `;
}

function slotHtml(slot, clickable = false, revealed = false) {
  const display = slot.ch === '.' ? '•' : (slot.ch || '');
  const classes = ['slotTile'];
  if (!revealed) classes.push('coveredTile');
  if (revealed) classes.push('revealedTile');
  if (revealed && slot.ch === '.') classes.push('dotTile');
  if (clickable) classes.push('clickableTile');
  const attrs = clickable ? `data-expose-index="${slot.index}"` : '';
  return `
    <div class="slotShell">
      <div class="slotValue">${[5,5,5,5,10,10,10,10,15,15,15,15][slot.index]}</div>
      <button class="${classes.join(' ')}" ${attrs}>${esc(display)}</button>
    </div>
  `;
}

function attachActionHandlers() {
  const askBtn = $('askBtn');
  if (askBtn) askBtn.onclick = () => {
    uiClick();
    const targetId = $('targetSelect').value;
    const symbol = $('symbolInput').value.trim();
    socket.emit('askSymbol', { targetId, symbol });
  };

  const dotBtn = $('dotBtn');
  if (dotBtn) dotBtn.onclick = () => {
    uiClick();
    $('symbolInput').value = 'dot';
    $('symbolInput').focus();
  };

  document.querySelectorAll('[data-letter]').forEach(btn => {
    btn.onclick = () => {
      uiClick();
      const letter = btn.dataset.letter;
      const input = $('symbolInput');
      if (!input) return;
      if (letter === 'BACK') input.value = '';
      else input.value = letter;
      input.focus();
    };
  });

  const fullBtn = $('fullGuessBtn');
  if (fullBtn) fullBtn.onclick = () => {
    uiClick();
    socket.emit('guessFull', { targetId: $('fullTarget').value, guess: $('fullGuess').value, interruptive: false });
  };

  const intBtn = $('interruptBtn');
  if (intBtn) intBtn.onclick = () => {
    uiClick();
    socket.emit('guessFull', { targetId: $('interruptTarget').value, guess: $('interruptGuess').value, interruptive: true });
  };

  const force = $('forceNextBtn');
  if (force) force.onclick = () => { uiClick(); socket.emit('forceNextTurn'); };

  const ownToggle = $('showOwnToggle');
  if (ownToggle) ownToggle.onchange = (e) => { uiClick(); showOwn = e.target.checked; renderGame(); };
}

function attachExposeHandlers() {
  document.querySelectorAll('[data-expose-index]').forEach(el => {
    el.addEventListener('click', () => {
      uiClick();
      const index = Number.parseInt(el.getAttribute('data-expose-index'), 10);
      socket.emit('chooseExpose', { index });
    });
  });
}

function renderEnd() {
  setVisible('end');
  $('end').innerHTML = `
    <div class="endCard">
      <div class="tinyCaps">Vault Closed</div>
      <h1>Game Over</h1>
      <p class="goodText">${esc(state.endedReason || 'Game finished.')}</p>
      <div class="woodPanel">${renderScoreCards()}</div>
      <div class="buttonRow">
        ${state.isHost ? '<button id="restartBtn" class="primaryGameBtn">Reset Room</button>' : '<span class="hint">Waiting for host to reset.</span>'}
      </div>
      <div class="woodPanel">
        <h2>Final Log</h2>
        <ol class="activityLog">${state.log.map(item => `<li>${colorizeLog(item)}</li>`).join('')}</ol>
      </div>
    </div>
  `;
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

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

function formatRemaining(endsAt) {
  if (!endsAt) return '∞';
  const ms = Math.max(0, endsAt - Date.now());
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function copyText(text, okMessage) {
  navigator.clipboard?.writeText(text).then(() => {
    uiClick();
    showToast(okMessage);
  }).catch(() => showToast('Copy failed.'));
}

function avatar(name) {
  const initials = String(name || '?').trim().split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase() || '?';
  const hue = Math.abs(hashCode(name)) % 360;
  return `<span class="avatar" style="--h:${hue}">${esc(initials)}</span>`;
}

function hashCode(value) {
  return String(value || '').split('').reduce((acc, ch) => ((acc << 5) - acc) + ch.charCodeAt(0), 0);
}

function progressGems(player) {
  const revealed = 12 - (player.hiddenCount || 0);
  return Array.from({ length: 12 }, (_, i) => `<span class="${i < revealed ? 'lit' : ''}"></span>`).join('');
}

function cardIcon(code) {
  const map = {
    NORMAL: '🎯',
    ADDITIONAL: '↻',
    LEFT_EXPOSE: '⇠',
    RIGHT_EXPOSE: '⇢',
    SELF_DOT: '•',
    MULT_3: '×3',
    MULT_4: '×4',
    MULT_5: '×5',
    SCORE_MINUS_10: '−10',
    SCORE_PLUS_15: '+15',
    SCORE_PLUS_20: '+20',
    SCORE_PLUS_25: '+25'
  };
  return map[code] || '✦';
}

function shortCardTitle(title) {
  return String(title || '').replace('Opponent on Your ', '').replace(' the Value of Your First Guess', ' First Guess');
}

function cardClass(code) {
  if (/MULT/.test(code)) return 'multCard';
  if (/SCORE_PLUS/.test(code)) return 'scoreCardType';
  if (/SCORE_MINUS/.test(code)) return 'badCardType';
  if (/EXPOSE|SELF_DOT/.test(code)) return 'exposeCard';
  if (/ADDITIONAL/.test(code)) return 'extraCard';
  return 'normalCard';
}

function colorizeLog(item) {
  return esc(item).replace(/\b([A-Z])\b/g, '<strong class="logLetter">$1</strong>');
}

function uiClick() {
  playTone([220, 330], 0.045, 0.022);
}

function playCardSound() {
  playTone([330, 440, 660], 0.12, 0.035);
}

function playErrorSound() {
  playTone([170, 120], 0.12, 0.04);
}

function playTone(freqs, duration = 0.1, volume = 0.04) {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    freqs.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.035);
      gain.gain.setValueAtTime(0, now + i * 0.035);
      gain.gain.linearRampToValueAtTime(volume, now + i * 0.035 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.035 + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + i * 0.035);
      osc.stop(now + i * 0.035 + duration + 0.03);
    });
  } catch (_) {
    // Browser blocked audio. Ignore silently.
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}

renderHomeHints();
updateChrome();
