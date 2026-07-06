const socket = io();
let state = null;
let savedName = localStorage.getItem('hwg_name') || '';
let showOwn = false;

const $ = (id) => document.getElementById(id);

$('nameInput').value = savedName;
$('createBtn').addEventListener('click', createRoom);
$('joinBtn').addEventListener('click', joinRoom);
$('rulesBtn').addEventListener('click', () => $('rulesDialog').showModal());

socket.on('joined', ({ code }) => {
  $('codeInput').value = code;
});

socket.on('state', (next) => {
  state = next;
  render();
});

socket.on('errorMessage', (msg) => showToast(msg));

function createRoom() {
  const name = getName();
  socket.emit('createRoom', { name });
}

function joinRoom() {
  const name = getName();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return showToast('Enter a room code.');
  socket.emit('joinRoom', { code, name });
}

function getName() {
  const name = ($('nameInput').value || 'Player').trim().slice(0, 24) || 'Player';
  localStorage.setItem('hwg_name', name);
  return name;
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function setVisible(id) {
  ['home', 'lobby', 'setup', 'game', 'end'].forEach(x => $(x).classList.toggle('hidden', x !== id));
}

function render() {
  if (!state) return setVisible('home');
  if (state.status === 'lobby') return renderLobby();
  if (state.status === 'setup') return renderSetup();
  if (state.status === 'playing') return renderGame();
  if (state.status === 'ended') return renderEnd();
}

function renderLobby() {
  setVisible('lobby');
  const el = $('lobby');
  el.innerHTML = `
    <h2>Lobby</h2>
    <p>Share this room code with the other players:</p>
    <div class="roomCode">${esc(state.code)}</div>
    <h3 style="margin-top:16px;">Players</h3>
    <ul>${state.players.map(p => `<li>${esc(p.name)} ${p.isHost ? '<strong>(host)</strong>' : ''} ${p.connected ? '' : '<span class="dangerText">disconnected</span>'}</li>`).join('')}</ul>
    <p class="hint">Need 2–4 players. Once setup starts, new people cannot join.</p>
    <div class="buttonRow">
      ${state.isHost ? '<button id="startSetupBtn">Start Secret Word Setup</button>' : '<span class="hint">Waiting for host to start.</span>'}
      ${state.isHost ? '<button class="secondary" id="copyBtn">Copy Room Code</button>' : ''}
    </div>
  `;
  if (state.isHost) {
    $('startSetupBtn').onclick = () => socket.emit('startSetup');
    $('copyBtn').onclick = () => navigator.clipboard?.writeText(state.code).then(() => showToast('Room code copied.')).catch(() => showToast('Copy failed.'));
  }
}

function renderSetup() {
  setVisible('setup');
  const me = state.players.find(p => p.id === state.youId);
  const maxDots = Math.max(0, 12 - 1);
  $('setup').innerHTML = `
    <h2>Secret Word Setup</h2>
    <p>Room <strong>${esc(state.code)}</strong>. Enter a word up to 12 letters. Dots will fill the rest of your 12-space tray.</p>
    <div class="notice">Your word stays on the server. Other players only see covered spaces until something is exposed.</div>
    ${me.ready ? `<p class="goodText">Your secret tray is locked in. Waiting for everyone else.</p>` : `
      <label>Secret word</label>
      <input id="secretWord" maxlength="12" autocomplete="off" placeholder="Example: TREASURE" />
      <label>Dots before the word</label>
      <select id="leftDots"></select>
      <p class="hint">The remaining dots go after the word. Dots cannot go inside the word.</p>
      <div id="previewTray"></div>
      <div class="buttonRow"><button id="saveSecretBtn">Lock In Secret Tray</button></div>
    `}
    <hr />
    <h3>Players</h3>
    <ul>${state.players.map(p => `<li>${esc(p.name)} — ${p.ready ? '<span class="goodText">ready</span>' : 'not ready'}</li>`).join('')}</ul>
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
    $('saveSecretBtn').onclick = () => socket.emit('submitSecret', { word: wordInput.value, leftDots: dotSelect.value });
    refreshDots();
  }
}

function renderPreviewTray() {
  const word = ($('secretWord')?.value || '').trim().replace(/[^a-zA-Z]/g, '').toUpperCase();
  const leftDots = Number.parseInt($('leftDots')?.value || '0', 10);
  const rightDots = Math.max(0, 12 - word.length - leftDots);
  const chars = [...Array(leftDots).fill('.'), ...word.split(''), ...Array(rightDots).fill('.')].slice(0, 12);
  $('previewTray').innerHTML = `<div class="tray">${chars.map((ch, i) => slotHtml(ch, i, false, true)).join('')}</div>`;
}

function renderGame() {
  setVisible('game');
  const me = state.players.find(p => p.id === state.youId);
  const isMyTurn = state.activePlayerId === state.youId;
  const pending = state.awaitingExpose;
  const waitingOnMe = pending && pending.playerId === state.youId;

  $('game').innerHTML = `
    <div class="statusBar">
      <span class="badge">Room ${esc(state.code)}</span>
      <span class="badge ${isMyTurn ? 'good' : ''}">Turn: ${esc(state.activePlayerName)}</span>
      <span class="badge">Deck: ${state.deckCount}</span>
      <span class="badge">Discard: ${state.discardCount}</span>
      ${state.multiplier > 1 && state.firstGuessAvailable ? `<span class="badge good">First guess x${state.multiplier}</span>` : ''}
      ${state.additionalTurnOnMiss ? `<span class="badge good">Additional turn active</span>` : ''}
    </div>

    ${pending ? `<div class="notice"><strong>Pending:</strong> ${esc(pending.message)}</div>` : ''}

    <div class="grid">
      <div class="card">
        <h2>Activity Card</h2>
        ${renderCard(state.currentCard)}
      </div>
      <div class="card">
        <h2>Action</h2>
        ${renderActionPanel(isMyTurn, waitingOnMe)}
      </div>
    </div>

    <div class="card">
      <h2>Scoreboard</h2>
      ${renderScoreTable()}
    </div>

    <div class="card">
      <div class="buttonRow" style="justify-content:space-between;align-items:center;">
        <h2>Trays</h2>
        <label style="font-weight:400;margin:0;"><input id="showOwnToggle" type="checkbox" ${showOwn ? 'checked' : ''} style="width:auto;" /> Show my secret tray on my screen</label>
      </div>
      <div class="grid">${state.players.map(renderPlayerTray).join('')}</div>
    </div>

    <div class="card">
      <h2>Game Log</h2>
      <ol class="log">${state.log.map(item => `<li>${esc(item)}</li>`).join('')}</ol>
    </div>
  `;

  $('showOwnToggle').onchange = (e) => { showOwn = e.target.checked; renderGame(); };
  attachActionHandlers();
  attachExposeHandlers();
}

function renderCard(card) {
  if (!card) return '<p>No card drawn yet.</p>';
  return `
    <div class="currentCard">
      <h3>${esc(card.title)}</h3>
      <p>${esc(card.text)}</p>
    </div>
  `;
}

function renderScoreTable() {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  return `
    <table class="scoreTable">
      <thead><tr><th>Player</th><th>Score</th><th>Hidden spaces</th><th>Status</th></tr></thead>
      <tbody>
        ${sorted.map(p => `<tr>
          <td>${esc(p.name)} ${p.id === state.youId ? '<strong>(you)</strong>' : ''}</td>
          <td>${p.score}</td>
          <td>${p.hiddenCount}</td>
          <td>${p.connected ? 'online' : '<span class="dangerText">disconnected</span>'}${p.allExposed ? ' / exposed' : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
}

function renderActionPanel(isMyTurn, waitingOnMe) {
  if (waitingOnMe) {
    return `<p>You must choose one highlighted slot from your tray to expose.</p>`;
  }

  if (state.awaitingExpose) {
    return `<p>Waiting for ${esc(state.players.find(p => p.id === state.awaitingExpose.playerId)?.name || 'a player')} to expose a slot.</p>`;
  }

  const opponents = state.players.filter(p => p.id !== state.youId && !p.allExposed);
  const allOpponents = state.players.filter(p => p.id !== state.youId);

  if (!isMyTurn) {
    return `
      <p>Waiting for your turn.</p>
      <h3>Interruptive Guess</h3>
      <p class="hint">Allowed only against a player with 5+ hidden spaces. Guess the word or exact 12-space tray pattern using dots.</p>
      <label>Target</label>
      <select id="interruptTarget">${allOpponents.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.hiddenCount} hidden)</option>`).join('')}</select>
      <label>Guess</label>
      <input id="interruptGuess" placeholder="WORD or ..WORD....." />
      <div class="buttonRow"><button id="interruptBtn" class="secondary">Make Interruptive Guess</button></div>
    `;
  }

  return `
    <p class="goodText">It is your turn. Ask one opponent for a letter or a dot.</p>
    <label>Opponent</label>
    <select id="targetSelect">${opponents.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.hiddenCount} hidden)</option>`).join('')}</select>
    <label>Letter or dot</label>
    <input id="symbolInput" maxlength="5" placeholder="A or dot" />
    <div class="buttonRow">
      <button id="askBtn">Ask</button>
    </div>
    <hr />
    <h3>Full Guess</h3>
    <p class="hint">Guess a word, or guess the exact 12-space tray pattern with dots.</p>
    <label>Target</label>
    <select id="fullTarget">${allOpponents.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
    <label>Full guess</label>
    <input id="fullGuess" placeholder="WORD or ..WORD....." />
    <div class="buttonRow"><button id="fullGuessBtn" class="secondary">Guess Full Word/Tray</button></div>
    ${state.isHost ? '<hr /><button id="forceNextBtn" class="danger">Host: Force Next Turn</button>' : ''}
  `;
}

function renderPlayerTray(player) {
  const pending = state.awaitingExpose;
  const isMe = player.id === state.youId;
  const slots = isMe && showOwn && player.privateSlots ? player.privateSlots : player.publicSlots;
  const clickable = pending && pending.playerId === state.youId && player.id === state.youId;

  return `
    <div class="panel">
      <h3>${esc(player.name)} ${isMe ? '(you)' : ''}</h3>
      <p class="small">Hidden: ${player.hiddenCount} / Score: ${player.score}</p>
      <div class="tray">
        ${slots.map(slot => {
          const canClick = clickable && pending.allowedIndices.includes(slot.index);
          const ch = slot.revealed || (isMe && showOwn) ? slot.ch : '';
          return slotHtml(ch, slot.index, canClick, slot.revealed || (isMe && showOwn), canClick ? `data-expose-index="${slot.index}"` : '');
        }).join('')}
      </div>
    </div>
  `;
}

function slotHtml(ch, i, clickable = false, revealed = false, attrs = '') {
  const display = ch === '.' ? '•' : (ch || '');
  const classes = ['slot'];
  if (!revealed) classes.push('hiddenSlot');
  if (revealed && ch === '.') classes.push('revealedDot');
  if (clickable) classes.push('clickable');
  return `
    <div class="slotWrap">
      <div class="slotValue">${[5,5,5,5,10,10,10,10,15,15,15,15][i]}</div>
      <div class="${classes.join(' ')}" ${attrs}>${esc(display)}</div>
    </div>
  `;
}

function attachActionHandlers() {
  const askBtn = $('askBtn');
  if (askBtn) askBtn.onclick = () => {
    const targetId = $('targetSelect').value;
    const symbol = $('symbolInput').value.trim();
    socket.emit('askSymbol', { targetId, symbol });
  };

  const fullBtn = $('fullGuessBtn');
  if (fullBtn) fullBtn.onclick = () => {
    socket.emit('guessFull', { targetId: $('fullTarget').value, guess: $('fullGuess').value, interruptive: false });
  };

  const intBtn = $('interruptBtn');
  if (intBtn) intBtn.onclick = () => {
    socket.emit('guessFull', { targetId: $('interruptTarget').value, guess: $('interruptGuess').value, interruptive: true });
  };

  const force = $('forceNextBtn');
  if (force) force.onclick = () => socket.emit('forceNextTurn');
}

function attachExposeHandlers() {
  document.querySelectorAll('[data-expose-index]').forEach(el => {
    el.addEventListener('click', () => {
      const index = Number.parseInt(el.getAttribute('data-expose-index'), 10);
      socket.emit('chooseExpose', { index });
    });
  });
}

function renderEnd() {
  setVisible('end');
  $('end').innerHTML = `
    <h2>Game Over</h2>
    <p class="goodText">${esc(state.endedReason || 'Game finished.')}</p>
    ${renderScoreTable()}
    <div class="buttonRow">
      ${state.isHost ? '<button id="restartBtn">Reset Room</button>' : '<span class="hint">Waiting for host to reset.</span>'}
    </div>
    <hr />
    <h3>Final Log</h3>
    <ol class="log">${state.log.map(item => `<li>${esc(item)}</li>`).join('')}</ol>
  `;
  if (state.isHost) $('restartBtn').onclick = () => socket.emit('restartRoom');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}
