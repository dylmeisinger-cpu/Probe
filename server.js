const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const TRAY_SIZE = 12;
const SLOT_VALUES = [5, 5, 5, 5, 10, 10, 10, 10, 15, 15, 15, 15];
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const VALID_TIMERS = new Set([0, 30, 45, 60, 90, 120]);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

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

function makeDeck() {
  const templates = [
    { code: 'NORMAL', count: 11, title: 'Take Your Normal Turn', text: 'Guess until an opponent says no.' },
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
    for (let i = 0; i < card.count; i++) {
      deck.push({ ...card, id: `${card.code}-${i + 1}` });
    }
  }
  return shuffle(deck);
}

function cleanName(name) {
  return String(name || 'Player').trim().replace(/\s+/g, ' ').slice(0, 24) || 'Player';
}

function cleanToken(token) {
  const raw = String(token || '').trim();
  if (/^[a-zA-Z0-9_-]{8,80}$/.test(raw)) return raw;
  return `guest_${Math.random().toString(36).slice(2, 14)}`;
}

function newPlayer(socketId, name, token, isHost = false) {
  return {
    id: token,
    token,
    socketId,
    name: cleanName(name),
    connected: true,
    isHost,
    score: 0,
    ready: false,
    slots: null,
    word: '',
    lastAction: ''
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
    settings: { turnTimerSec: 0 },
    turnEndsAt: null,
    players: [hostPlayer],
    deck: makeDeck(),
    discard: [],
    currentCard: null,
    turnIndex: 0,
    multiplier: 1,
    firstGuessAvailable: true,
    additionalTurnOnMiss: false,
    awaitingExpose: null,
    log: [`Room ${code} created.`],
    endedReason: ''
  };

  rooms.set(code, room);
  return room;
}

function getRoomOfSocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.socketId === socketId)) return room;
  }
  return null;
}

function getPlayer(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

function getPlayerByToken(room, token) {
  return room.players.find(p => p.token === token);
}

function activePlayer(room) {
  return room.players[room.turnIndex];
}

function addLog(room, message) {
  room.log.unshift(message);
  room.log = room.log.slice(0, 100);
}

function hiddenCount(player) {
  if (!player.slots) return TRAY_SIZE;
  return player.slots.filter(s => !s.revealed).length;
}

function allExposed(player) {
  return player.slots && player.slots.every(s => s.revealed);
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
  if (room.deck.length === 0) {
    room.deck = shuffle(room.discard);
    room.discard = [];
    addLog(room, 'The activity deck was reshuffled.');
  }
  const card = room.deck.pop();
  room.currentCard = card || null;
  if (card) room.discard.push(card);
  return card;
}

function setTurnTimer(room) {
  const seconds = room.settings?.turnTimerSec || 0;
  room.turnEndsAt = seconds > 0 ? Date.now() + seconds * 1000 : null;
}

function startTurn(room, samePlayer = false) {
  if (!samePlayer) {
    room.turnIndex = room.turnIndex % room.players.length;
  }

  room.multiplier = 1;
  room.firstGuessAvailable = true;
  room.additionalTurnOnMiss = false;
  room.awaitingExpose = null;

  const player = activePlayer(room);
  const card = drawCard(room);
  if (!card) {
    addLog(room, 'No activity card was available.');
    return;
  }

  addLog(room, `${player.name} drew: ${card.title}.`);
  applyCard(room, player, card);
  setTurnTimer(room);
}

function applyCard(room, player, card) {
  if (card.code === 'ADDITIONAL') {
    room.additionalTurnOnMiss = true;
    return;
  }

  if (card.code === 'SELF_DOT') {
    const choices = hiddenIndices(player, '.', true);
    if (choices.length === 0) {
      addLog(room, `${player.name} has no hidden dot to expose, so the card is ignored.`);
      return;
    }
    room.awaitingExpose = {
      type: 'card',
      playerId: player.id,
      byPlayerId: null,
      scoringPlayerId: null,
      onlyDot: true,
      symbol: '.',
      allowedIndices: choices,
      message: 'Expose one of your hidden dots. No one scores.'
    };
    return;
  }

  if (card.code === 'LEFT_EXPOSE' || card.code === 'RIGHT_EXPOSE') {
    const target = card.code === 'LEFT_EXPOSE' ? findLeftPlayer(room, player.id) : findRightPlayer(room, player.id);
    const choices = hiddenIndices(target, null, false);
    if (choices.length === 0) {
      addLog(room, `${target.name} has nothing hidden to expose, so the card is ignored.`);
      return;
    }
    room.awaitingExpose = {
      type: 'card',
      playerId: target.id,
      byPlayerId: player.id,
      scoringPlayerId: player.id,
      onlyDot: false,
      symbol: null,
      allowedIndices: choices,
      message: `${target.name} must expose one hidden letter or dot. ${player.name} scores its value.`
    };
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
  if (!player.slots) return [];
  const normalized = normalizeSymbol(symbol);
  const result = [];
  for (let i = 0; i < player.slots.length; i++) {
    const slot = player.slots[i];
    if (slot.revealed) continue;
    if (onlyDot && slot.ch !== '.') continue;
    if (normalized && slot.ch !== normalized) continue;
    result.push(i);
  }
  return result;
}

function normalizeSymbol(input) {
  const value = String(input || '').trim().toUpperCase();
  if (value === '.' || value === 'DOT' || value === 'BLANK') return '.';
  if (/^[A-Z]$/.test(value)) return value;
  return '';
}

function slotValue(index) {
  return SLOT_VALUES[index] || 0;
}

function revealSlot(room, target, index, scoringPlayerId, reason, multiplier = 1) {
  const slot = target.slots[index];
  if (!slot || slot.revealed) return { ok: false, points: 0 };

  slot.revealed = true;
  const base = slotValue(index);
  let points = 0;

  if (scoringPlayerId) {
    points = base * multiplier;
    const scorer = getPlayer(room, scoringPlayerId);
    if (scorer) scorer.score += points;
  }

  const visible = slot.ch === '.' ? 'dot' : slot.ch;
  const scorerName = scoringPlayerId ? getPlayer(room, scoringPlayerId)?.name : null;
  if (scorerName) {
    const multText = multiplier > 1 ? ` x${multiplier}` : '';
    addLog(room, `${target.name} exposed ${visible} in slot ${index + 1}. ${scorerName} scored ${base}${multText} = ${points}.`);
  } else {
    addLog(room, `${target.name} exposed ${visible} in slot ${index + 1}. No points scored.`);
  }

  if (reason === 'guess' && allExposed(target) && scoringPlayerId) {
    const scorer = getPlayer(room, scoringPlayerId);
    if (scorer) scorer.score += 50;
    addLog(room, `${scorerName} earned a 50 point bonus for exposing ${target.name}'s final hidden space.`);
  }

  checkGameEnd(room);
  return { ok: true, points };
}

function checkGameEnd(room) {
  if (room.status !== 'playing') return;
  const done = room.players.every(p => p.slots && p.slots.every(s => s.revealed));
  if (!done) return;

  room.status = 'ended';
  room.turnEndsAt = null;
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const high = sorted[0]?.score || 0;
  const winners = sorted.filter(p => p.score === high).map(p => p.name);
  room.endedReason = `Game over. Winner: ${winners.join(', ')} with ${high} points.`;
  addLog(room, room.endedReason);
}

function advanceTurnAfterMiss(room) {
  const player = activePlayer(room);
  if (room.additionalTurnOnMiss) {
    addLog(room, `${player.name}'s additional-turn card activates. They draw another card and continue.`);
    startTurn(room, true);
    return;
  }

  room.turnIndex = nextConnectedTurnIndex(room, room.turnIndex);
  startTurn(room, false);
}

function nextConnectedTurnIndex(room, fromIndex) {
  if (room.players.length === 0) return 0;
  for (let step = 1; step <= room.players.length; step++) {
    const idx = (fromIndex + step) % room.players.length;
    if (room.players[idx].connected) return idx;
  }
  return (fromIndex + 1) % room.players.length;
}

function makePublicSlots(player) {
  if (!player.slots) return [];
  return player.slots.map((slot, index) => ({
    index,
    value: slotValue(index),
    revealed: !!slot.revealed,
    ch: slot.revealed ? slot.ch : '',
    hidden: !slot.revealed
  }));
}

function makePrivateSlots(player) {
  if (!player.slots) return [];
  return player.slots.map((slot, index) => ({
    index,
    value: slotValue(index),
    revealed: !!slot.revealed,
    ch: slot.ch
  }));
}

function publicState(room, viewerId) {
  const active = room.status === 'playing' ? activePlayer(room) : null;
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
    settings: room.settings,
    turnEndsAt: room.turnEndsAt,
    awaitingExpose: room.awaitingExpose ? {
      ...room.awaitingExpose,
      allowedIndices: room.awaitingExpose.playerId === viewerId ? room.awaitingExpose.allowedIndices : []
    } : null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.isHost,
      ready: p.ready,
      score: p.score,
      hiddenCount: hiddenCount(p),
      allExposed: p.slots ? allExposed(p) : false,
      publicSlots: makePublicSlots(p),
      privateSlots: p.id === viewerId ? makePrivateSlots(p) : null,
      wordLength: p.word ? p.word.length : 0
    })),
    log: room.log,
    endedReason: room.endedReason
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('state', publicState(room, p.id));
    }
  }
}

function emitError(socket, message) {
  socket.emit('errorMessage', message);
}

function validateTray(wordRaw, leftDotsRaw) {
  const word = String(wordRaw || '').trim().toUpperCase();
  if (!/^[A-Z]{1,12}$/.test(word)) {
    return { ok: false, message: 'Use a secret word from 1 to 12 letters, letters only.' };
  }
  const dotCount = TRAY_SIZE - word.length;
  let leftDots = Number.parseInt(leftDotsRaw, 10);
  if (Number.isNaN(leftDots)) leftDots = 0;
  if (leftDots < 0 || leftDots > dotCount) {
    return { ok: false, message: `Left dots must be between 0 and ${dotCount}.` };
  }
  const rightDots = dotCount - leftDots;
  const slots = [];
  for (let i = 0; i < leftDots; i++) slots.push({ ch: '.', revealed: false });
  for (const ch of word) slots.push({ ch, revealed: false });
  for (let i = 0; i < rightDots; i++) slots.push({ ch: '.', revealed: false });
  return { ok: true, word, slots, leftDots, rightDots };
}

function startIfReady(room) {
  if (room.status !== 'setup') return;
  if (room.players.length >= MIN_PLAYERS && room.players.every(p => p.ready && p.slots)) {
    room.status = 'playing';
    room.turnIndex = room.players.findIndex(p => p.connected);
    if (room.turnIndex < 0) room.turnIndex = 0;
    addLog(room, 'All secret trays are ready. The game begins.');
    startTurn(room, false);
  }
}

function attachSocketToPlayer(room, player, socket, name) {
  player.socketId = socket.id;
  player.connected = true;
  player.name = cleanName(name || player.name);
  socket.join(room.code);
}

function transferHostIfNeeded(room) {
  const host = getPlayer(room, room.hostId);
  if (host) return;
  const nextHost = room.players[0];
  if (!nextHost) return;
  nextHost.isHost = true;
  room.hostId = nextHost.id;
  addLog(room, `${nextHost.name} is now the host.`);
}

function removePlayer(room, playerId, reason = 'removed') {
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx === -1) return null;
  const [removed] = room.players.splice(idx, 1);
  if (removed) {
    if (removed.socketId) io.to(removed.socketId).emit(reason === 'kicked' ? 'kicked' : 'leftRoom');
    if (room.turnIndex >= room.players.length) room.turnIndex = 0;
    if (room.hostId === removed.id) transferHostIfNeeded(room);
  }
  return removed;
}

io.on('connection', (socket) => {
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
    if (existing) {
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
    if (!player) return emitError(socket, 'Could not reconnect: player not found in that room.');
    attachSocketToPlayer(room, player, socket, name);
    addLog(room, `${player.name} reconnected.`);
    socket.emit('joined', { code: room.code, playerId: player.id, token: safeToken });
    broadcast(room);
  });

  socket.on('setSettings', ({ turnTimerSec }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    if (room.hostId !== room.players.find(p => p.socketId === socket.id)?.id) return emitError(socket, 'Only the host can change settings.');
    if (room.status !== 'lobby' && room.status !== 'setup') return emitError(socket, 'Settings can only be changed before or during setup.');
    const value = Number.parseInt(turnTimerSec, 10);
    if (!VALID_TIMERS.has(value)) return emitError(socket, 'Invalid timer value.');
    room.settings.turnTimerSec = value;
    addLog(room, `Turn timer set to ${value ? value + ' seconds' : 'off'}.`);
    broadcast(room);
  });

  socket.on('kickPlayer', ({ playerId }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    const self = room.players.find(p => p.socketId === socket.id);
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
    const self = room.players.find(p => p.socketId === socket.id);
    if (room.hostId !== self?.id) return emitError(socket, 'Only the host can start setup.');
    if (room.players.length < MIN_PLAYERS) return emitError(socket, 'You need at least 2 players.');
    room.status = 'setup';
    addLog(room, 'Secret word setup started.');
    broadcast(room);
  });

  socket.on('submitSecret', ({ word, leftDots }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    if (room.status !== 'setup') return emitError(socket, 'Secret words can only be entered during setup.');
    const player = room.players.find(p => p.socketId === socket.id);
    const result = validateTray(word, leftDots);
    if (!result.ok) return emitError(socket, result.message);

    player.word = result.word;
    player.slots = result.slots;
    player.ready = true;
    addLog(room, `${player.name} locked in a secret tray.`);
    startIfReady(room);
    broadcast(room);
  });

  socket.on('askSymbol', ({ targetId, symbol }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    if (room.awaitingExpose) return emitError(socket, 'Wait for the pending exposure choice first.');
    const asker = room.players.find(p => p.socketId === socket.id);
    if (!asker || activePlayer(room)?.id !== asker.id) return emitError(socket, 'It is not your turn.');

    const target = getPlayer(room, targetId);
    if (!target || target.id === asker.id) return emitError(socket, 'Choose a valid opponent.');
    if (!target.slots) return emitError(socket, 'That opponent has no tray.');

    const normalized = normalizeSymbol(symbol);
    if (!normalized) return emitError(socket, 'Ask for one letter, or ask for a dot.');

    const matches = hiddenIndices(target, normalized, false);
    if (matches.length === 0) {
      addLog(room, `${asker.name} asked ${target.name} for ${normalized === '.' ? 'a dot' : normalized}. No match.`);
      room.firstGuessAvailable = false;
      if (normalized === '.') {
        asker.score -= 50;
        addLog(room, `${asker.name} loses 50 points for asking for a dot from a player with no hidden dot.`);
      }
      advanceTurnAfterMiss(room);
      broadcast(room);
      return;
    }

    if (matches.length === 1) {
      const mult = room.firstGuessAvailable ? room.multiplier : 1;
      revealSlot(room, target, matches[0], asker.id, 'guess', mult);
      room.firstGuessAvailable = false;
      if (room.status === 'playing') addLog(room, `${asker.name} guessed correctly and continues.`);
      setTurnTimer(room);
      broadcast(room);
      return;
    }

    room.awaitingExpose = {
      type: 'guess',
      playerId: target.id,
      byPlayerId: asker.id,
      scoringPlayerId: asker.id,
      onlyDot: normalized === '.',
      symbol: normalized,
      allowedIndices: matches,
      message: `${target.name}, choose one hidden ${normalized === '.' ? 'dot' : normalized} to expose.`
    };
    addLog(room, `${asker.name} asked ${target.name} for ${normalized === '.' ? 'a dot' : normalized}. ${target.name} must choose one to expose.`);
    setTurnTimer(room);
    broadcast(room);
  });

  socket.on('chooseExpose', ({ index }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    const pending = room.awaitingExpose;
    if (!pending) return emitError(socket, 'There is no exposure choice pending.');
    const target = room.players.find(p => p.socketId === socket.id);
    if (!target || pending.playerId !== target.id) return emitError(socket, 'This exposure choice is not yours.');

    const idx = Number.parseInt(index, 10);
    if (!pending.allowedIndices.includes(idx)) return emitError(socket, 'That slot is not allowed for this exposure.');
    const mult = pending.type === 'guess' && room.firstGuessAvailable ? room.multiplier : 1;
    revealSlot(room, target, idx, pending.scoringPlayerId, pending.type === 'guess' ? 'guess' : 'card', mult);

    if (pending.type === 'guess') {
      room.firstGuessAvailable = false;
      if (room.status === 'playing') {
        const asker = getPlayer(room, pending.byPlayerId);
        addLog(room, `${asker?.name || 'The guesser'} guessed correctly and continues.`);
      }
    }

    room.awaitingExpose = null;
    setTurnTimer(room);
    broadcast(room);
  });

  socket.on('guessFull', ({ targetId, guess, interruptive }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    if (room.awaitingExpose) return emitError(socket, 'Wait for the pending exposure choice first.');

    const guesser = room.players.find(p => p.socketId === socket.id);
    const active = activePlayer(room);
    const target = getPlayer(room, targetId);
    if (!guesser || !target || target.id === guesser.id) return emitError(socket, 'Choose a valid opponent.');

    const isInterrupt = !!interruptive;
    if (!isInterrupt && active.id !== guesser.id) return emitError(socket, 'Full guesses on your turn only, unless using interruptive guess.');
    if (isInterrupt && hiddenCount(target) < 5) return emitError(socket, 'Interruptive guesses are only allowed when that opponent has 5 or more hidden spaces.');

    const raw = String(guess || '').trim().toUpperCase();
    if (!raw) return emitError(socket, 'Enter a full word or full tray pattern.');
    const normalizedFull = raw.replace(/DOT/g, '.').replace(/[^A-Z.]/g, '');
    const fullPattern = target.slots.map(s => s.ch).join('');
    const wordOnly = target.word;
    const correct = normalizedFull === fullPattern || normalizedFull === wordOnly;

    if (correct) {
      target.slots.forEach(s => { s.revealed = true; });
      guesser.score += isInterrupt ? 100 : 50;
      addLog(room, `${guesser.name} correctly guessed ${target.name}'s ${normalizedFull === fullPattern ? 'full tray' : 'word'} and revealed it. +${isInterrupt ? 100 : 50} points.`);
      checkGameEnd(room);
      if (!isInterrupt && room.status === 'playing') {
        addLog(room, `${guesser.name} continues after a correct full guess.`);
        setTurnTimer(room);
      }
    } else {
      guesser.score -= isInterrupt ? 50 : 100;
      addLog(room, `${guesser.name} guessed ${target.name}'s word/tray incorrectly. -${isInterrupt ? 50 : 100} points.`);
      if (!isInterrupt && active.id === guesser.id) advanceTurnAfterMiss(room);
    }

    broadcast(room);
  });

  socket.on('forceNextTurn', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.status !== 'playing') return emitError(socket, 'No active game.');
    const self = room.players.find(p => p.socketId === socket.id);
    if (!self || room.hostId !== self.id) return emitError(socket, 'Only the host can force the next turn.');
    room.awaitingExpose = null;
    room.turnIndex = nextConnectedTurnIndex(room, room.turnIndex);
    addLog(room, 'Host forced the next turn.');
    startTurn(room, false);
    broadcast(room);
  });

  socket.on('restartRoom', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return emitError(socket, 'You are not in a room.');
    const self = room.players.find(p => p.socketId === socket.id);
    if (!self || room.hostId !== self.id) return emitError(socket, 'Only the host can reset the room.');
    room.status = 'lobby';
    room.settings = { ...room.settings };
    room.turnEndsAt = null;
    room.deck = makeDeck();
    room.discard = [];
    room.currentCard = null;
    room.turnIndex = 0;
    room.multiplier = 1;
    room.firstGuessAvailable = true;
    room.additionalTurnOnMiss = false;
    room.awaitingExpose = null;
    room.endedReason = '';
    for (const p of room.players) {
      p.score = 0;
      p.ready = false;
      p.slots = null;
      p.word = '';
    }
    room.log = ['Room reset.'];
    broadcast(room);
  });

  socket.on('leaveRoom', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    removePlayer(room, player.id, 'left');
    addLog(room, `${player.name} left the room.`);
    if (room.players.length === 0) rooms.delete(room.code);
    else broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (player) {
      player.connected = false;
      player.socketId = null;
      addLog(room, `${player.name} disconnected.`);
    }
    broadcast(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const anyConnected = room.players.some(p => p.connected);
    if (!anyConnected || now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(code);
      continue;
    }

    if (room.status === 'playing' && room.turnEndsAt && now >= room.turnEndsAt) {
      const player = activePlayer(room);
      if (room.awaitingExpose) {
        addLog(room, `Time ran out while waiting for ${getPlayer(room, room.awaitingExpose.playerId)?.name || 'a player'} to expose a slot.`);
        room.awaitingExpose = null;
      } else if (player) {
        addLog(room, `${player.name} ran out of time.`);
      }
      advanceTurnAfterMiss(room);
      broadcast(room);
    }
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`Hidden Word Card Game server listening on port ${PORT}`);
});
