# Word Vault v4.16 — Discord Activity Patch

This build keeps the v4.15 tray scoring and adds a Discord Activity entry point.

## Normal web play

Use the site normally at your Render/custom domain.

## Discord Activity play

Use this Activity URL in the Discord Developer Portal:

```text
https://wordvault.fyi/discord
```

Players who launch/join the same Discord Activity instance are automatically placed into the same Word Vault room. The game uses Discord display names and avatars when available.

## Required Render environment variables

Set these in Render → Environment:

```text
DISCORD_CLIENT_ID=your_discord_application_client_id
DISCORD_CLIENT_SECRET=your_discord_application_client_secret
```

Optional, only if your Discord app requires it:

```text
DISCORD_REDIRECT_URI=https://127.0.0.1
```

The Activity uses Discord OAuth through the Embedded App SDK. The server exchanges the short-lived authorization code at `/api/discord/token`; the secret never goes into browser code.

## Discord Developer Portal checklist

1. Create/open your Discord application.
2. Enable Activity / Embedded App support.
3. Add a placeholder OAuth redirect URI, commonly `https://127.0.0.1`.
4. Add Activity URL Mapping:
   - Prefix: `/`
   - Target: `wordvault.fyi`
5. Set the Activity launch URL/path to `/discord`.
6. Launch it from a Discord voice channel Activity shelf.

## Upload to GitHub

Upload/replace:

```text
server.js
package.json
README.md
public/index.html
public/client.js
public/discord-activity.js
public/style.css
```

Do not upload `node_modules/` or `package-lock.json`.


## v4.17 items 4-16 fix

This patch intentionally skips Spotify UI/backend work and focuses only on the requested items 4-16: readable front-facing turn-card animation, center deck/discard behavior, animation queue/cooldowns, board-first layout, safe round-table spacing, 12x1 trays, card/letter centering and scaling, setup tray stability, dot rules, normal-card/deck audit, AI timing, manual reveal, keyboard guessing, sound mapping preservation, ghost-event cleanup preservation, corrected tray scoring, and Discord Activity preservation.


## v4.18 Tray / Letter Centering Patch

This surgical patch keeps the v4.17 behavior and adds:

- Tray containers are centered inside the board before the word/cards are centered inside the tray.
- Stacked/default trays are forced into a safe vertical board-first layout instead of drifting offscreen.
- Letter and dot glyphs are centered on both the X and Y axis inside every card.
- Glyph scaling now uses a CSS custom property instead of fighting the centering transform.
- Card symbols remain centered as their own child layer.

No Spotify, Discord, scoring, deck, AI, or gameplay logic was changed.
