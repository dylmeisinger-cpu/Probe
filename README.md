# Word Vault 4.44

Start randomizer release.

## What changed

- Fixed the visual issue where the big turn-card animation could look mixed with tray media tiles.
- After all secret trays are locked, the game now shows a center overlay saying **Let the game begin!** for 2 seconds.
- Added a spinning starter wheel that runs for 5 seconds and randomly chooses who starts.
- The wheel displays the chosen starter, then disappears after 2.5 seconds.
- Added a tick sound while the wheel passes player names.
- Added a picked sound when the starter is selected.
- The first activity card is not drawn until after the starter randomizer finishes.

## What did not change

- No tray/card sizing changes.
- No board layout changes.
- No fullscreen layout changes.
- No mobile layout changes.
- No scoring changes.
- No video/mic feature changes beyond the existing 4.43 foundation.

## New sound files

- `public/assets/sounds/starter-wheel-tick.mp3`
- `public/assets/sounds/starter-picked.mp3`
