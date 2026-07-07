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
