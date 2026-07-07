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

## v4.11 Board Stability + Card Animation Fix

This patch focuses on stability and correctness only. It keeps the warm Word Vault UI while fixing the board/tray geometry, true face-up turn-card animation, center deck origin, event cooldowns, explicit dot rules, normal card visibility, AI timing, sounds, and stale reconnect/leave cleanup.

Key guarantees:
- Turn/activity cards animate from the center deck and flip to a readable front.
- The deck/discard stays in the center table area and does not crush layout.
- Board and trays never require horizontal scrolling.
- Every tray is always 12x1.
- Short words are centered in the 12-space tray and unused spaces remain empty.
- Letters, dots, and symbols are centered and scale inside their card boxes.
- Dots can only go before or after the word.
- Normal Turn cards are explicit and frequent enough to see.
- CPU turns wait 5 seconds; CPU action cards display for 3 seconds.
- Leaving, reconnecting, and closing tabs clear stale visual queues and server timers.
