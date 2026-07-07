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
