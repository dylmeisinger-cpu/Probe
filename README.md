# Word Vault v4.4 Tray + Dot + Enter Patch

This patch fixes stacked-view nameplate overlap, forces every player tray to stay 12×1, adds explicit period/dot-card setup, supports empty no-card tray spaces instead of auto-filled dots, and lets players press Enter to submit letter/dot/full-word guesses.

Upload/replace `server.js`, `public/client.js`, `public/style.css`, `package.json`, and `README.md`.

# Word Vault v4 Final

Online multiplayer hidden-word deduction game inspired by classic word-tray games.

## Final v4 feature set

- Optional AI CPU competitors for solo play or filling a room.
- CPU difficulty levels: Easy, Medium, Hard, and Genius.
- Genius/Hard CPU uses public information only: revealed letters/dots, known misses, category prompts, and a large English word-list dependency. It does **not** read a player’s hidden word/tray from the server state.
- Optional round category themes: Medical, Animals, Tools, Sports, Food, Movies & TV, Science, Places, Video Games, and Random Hard Mode.
- Shared-device tabletop mode so one computer can host an in-person/pass-and-play game.
- Click-to-expose / no-typing mode for in-person games or voice chat. Players can verbally ask and click a hidden card to expose it; the active player scores automatically. Miss buttons handle verbal misses.
- Configurable visual skins: Warm Wood, Color Arcade, Midnight Neon, Forest Tavern, Candy Pop, and Clean Slate.
- Configurable board layouts: classic stacked trays or round-table/UNO-style seating.
- Avatar uploads for human/local players, resized in-browser before upload.
- Desktop-first UI while still being usable on phones.
- Responsive safeguards for zoom/window-size changes: wrapping text, scrollable racks, mobile breakpoints, and reduced overlap risk.
- Ambient music toggle and expanded sound effects.
- Original SVG and WAV assets in `public/assets/`.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Render settings

Because npm was unstable in your Render deploy, use Yarn in Render settings:

Build Command:

```bash
corepack enable && corepack prepare yarn@1.22.22 --activate && yarn install --ignore-engines --production=false --no-progress
```

Start Command:

```bash
node server.js
```

Node version is pinned to `20.x` in `package.json`.

## Assets / licensing

No third-party audio files are bundled. The included SVG art and WAV audio loops/effects were generated for this project and are covered by `public/assets/LICENSE.txt`.

The AI dictionary uses the `word-list` npm dependency at install time. The app also includes curated category/common-word lists so it can still run if that package is unavailable, but the broad dictionary is recommended for Genius CPU mode.

## Quick deploy checklist

1. Upload or commit these files to GitHub.
2. Keep the `public` folder exactly named `public`.
3. On Render, keep Build Command and Start Command as listed above.
4. Deploy latest commit.
5. Test: create room, add CPU, enable themes, try stacked/round layout, upload avatar, and test on phone.


## v4.1 Round-table overlap fix
- Round-table / UNO layout now uses grid seats instead of absolute rack positioning.
- Racks cannot overlap when zooming or resizing.
- Round-table trays use one long 12-space row, with a mobile-safe horizontal scroll fallback.
- Two-opponent round-table layout spaces the top-left and top-right racks evenly.


## v4.2 spacing fix

- Round-table racks now keep true 12-card rows with fixed-ratio letter boxes.
- The two-opponent UNO layout uses left/right racks with a flexible center gap instead of squishing trays.
- If the viewport is too small, the layout scrolls or falls back to stacked racks instead of overlapping.
- Slot glyphs are now layered and centered so covered-card symbols stay centered inside each letter box.


## v4.4 Enter-key patch

- Press Enter in the letter/dot box to submit the letter/dot guess.
- Press Enter in the full-word guess box to submit the full-word guess.
- Press Enter in the interruptive guess box to submit the interruptive guess.
- Press Enter while entering a secret tray to lock it in.


## v4.5 animation / deck / logo patch
- Added the uploaded Word Vault logo as a real UI asset.
- Slowed AI thinking and CPU exposure timing so turns are readable.
- Added a balanced-deck guard so normal turn cards cannot disappear behind long action-card streaks.
- Added visible wrong-guess / miss animations and separate sounds for good, bad, normal, and special events.
- Slowed card draw animations so action cards feel deliberate instead of instant.
- Enforced dot placement: dots can only be before or after the word, never between letters.
