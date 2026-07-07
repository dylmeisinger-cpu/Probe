# Word Vault v4.9

Patch notes:

- Adds a large visual turn-card animation.
- Turn cards visually fly out from the deck area, flip onto the screen, remain visible for 5 seconds, then return toward the deck.
- CPU/AI actions are shown as on-screen cards for 3 seconds.
- CPU/AI timing is sped back up: normal AI turns and AI exposure choices now wait 5 seconds.
- Human exposure choices are still manual when there is more than one matching letter/dot. The game does not auto-pick for human players.
- Keeps existing no-horizontal-scroll and 12x1 tray rules from prior patches.

## Render settings

Build command:

```bash
corepack enable && corepack prepare yarn@1.22.22 --activate && yarn install --ignore-engines --production=false --no-progress
```

Start command:

```bash
node server.js
```

Upload/replace these files in GitHub:

- `server.js`
- `package.json`
- `README.md`
- `public/client.js`
- `public/style.css`

The existing assets folder from v4.8 can stay as-is unless you are doing a full replacement upload.
