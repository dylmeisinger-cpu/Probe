# Multiplayer Hidden Word Card Game

A small online multiplayer hidden-word deduction game inspired by classic tray-and-card word games.

## What it does

- 2–4 players
- Private secret-word setup
- 12-space trays with dots before/after the word
- 5 / 10 / 15 point slot values
- Live online rooms with room codes
- Scoreboard
- Activity-card deck
- Card effects:
  - Take your normal turn
  - Take an additional turn
  - Opponent on your left exposes a letter or dot
  - Opponent on your right exposes a letter or dot
  - If you have a dot, expose it
  - Triple / quadruple / quintuple the value of your first guess
  - Add / deduct from your score
- Correct guesses keep the turn going
- Misses end the turn unless an additional-turn card applies
- Dot miss penalty
- Full-word / full-tray guess option
- Interruptive guess option when an opponent has 5+ hidden spaces

## Run locally

1. Install Node.js 18 or newer.
2. Open a terminal in this folder.
3. Run:

```bash
npm install
npm start
```

4. Open:

```text
http://localhost:3000
```

## Let people on your home Wi-Fi join

Start the server on your computer, then find your computer's local IP address.
Other people on the same Wi-Fi can open something like:

```text
http://192.168.1.25:3000
```

Replace that IP with your real local IP.

## Put it online

This is a Node/Express/Socket.IO app. Deploy it as a web service, not a static site.

Example Render settings:

- Build command: `npm install`
- Start command: `npm start`
- The app automatically uses `process.env.PORT || 3000`

## Important limitation

Rooms are stored in memory. If the server restarts, active games disappear. For a serious public version, add a database.
