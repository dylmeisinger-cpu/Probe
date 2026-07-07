# Word Vault v4.10 — Center Deck + Face-Up Card Animation Fix

This patch addresses the visual/card-animation issues found after v4.9.

## Fixed in v4.10

- The activity deck/discard pile now appears in the middle of the board.
- Turn-card animation now starts from the center deck.
- Cards flip face-up correctly so the text is readable, not backwards.
- Added a cooldown before card/effect overlays so the card does not pop instantly at game start.
- Added a small gap between queued animations/effects so events do not stack unnaturally.
- The uploaded flip-card sound is explicitly triggered at the flip moment.
- Reward/penalty sounds still play after the card is revealed.
- Main board gets layout priority: side panels move below on constrained screens.
- The card dock no longer squeezes the board horizontally.
- Letter trays remain 12 x 1.
- Letter boxes keep rectangular card proportions and do not become circles.
- AI timing remains at the requested faster pacing: normal AI actions and expose choices are 5 seconds.

## Upload/replace on GitHub

Replace these files:

```text
server.js
package.json
README.md
public/client.js
public/style.css
```

The v4.8 sound assets are still included in this ZIP. If your GitHub assets folder is already correct, you do not need to re-upload sounds.

## Render

Use your existing Render settings:

```text
Build Command:
corepack enable && corepack prepare yarn@1.22.22 --activate && yarn install --ignore-engines --production=false --no-progress

Start Command:
node server.js
```

Then run:

```text
Manual Deploy → Clear build cache & deploy
```
