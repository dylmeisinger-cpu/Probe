# Word Vault 4.24

Layout repair release after 4.23.

## What changed

- Restored the real Round Table orientation:
  - your tray is bottom-center and horizontal,
  - opponent trays sit upper-left / upper-right and angle inward,
  - deck, current turn card, and discard stay centered in the board oval,
  - the right-side control panel stays separate from the board.
- Made Stacked Trays a genuinely different layout again: straight horizontal trays in a clean vertical flow instead of the round-table seating map.
- Removed game-panel nested scrollbars. The page itself can scroll, but the Make a Guess panel, score panels, and log panels no longer trap their own scrollbars.
- Fixed tray spacing so nameplates have their own protected row and cannot cover point values or cards.
- Kept every tray as a 12x1 slot row with empty spaces reserved but no fake card shown.
- Kept click-to-select targeting on other players’ trays/nameplates.
- Kept selected-target tray glow, including dropdown and arrow-key target changes.
- Kept gameplay popups/announcements centered inside the board rectangle only.
- Kept faster result/player-action announcement timing from 4.23.
- Kept the turn card face-up in the middle after it is revealed.
- Kept the AI pending-reveal guard so CPUs wait while a human/local player chooses which matching card to flip.

## Tray scoring

The position scores are hard-coded as:

```text
5, 5, 10, 15, 15, 10, 10, 15, 15, 10, 5, 5
```

## Upload to GitHub

Upload/replace these files/folders from the ZIP:

```text
package.json
README.md
render.yaml
server.js
public/index.html
public/client.js
public/discord-activity.js
public/style.css
public/assets/
```

The ZIP intentionally does not include `node_modules` or `package-lock.json`.

## Render

After uploading to GitHub:

```text
Manual Deploy → Clear build cache & deploy
```
