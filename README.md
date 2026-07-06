# Word Vault Multiplayer

A polished online multiplayer hidden-word deduction game with a warm wood/brass desktop-first UI.

## What changed in this version

- Full warm brown wood/brass UI overhaul
- Desktop-first layout:
  - guessing controls on the left
  - huge word trays in the center
  - activity card/deck beside the trays
  - scoreboard and activity log on the right
- Animated card draw effect
- Glowing covered/revealed letter tiles
- Optional sound effects using browser audio
- Copyable room code / invite link
- Reconnect support after refresh
- Optional turn timer
- Host lobby controls
- Mobile fallback layout, but desktop is the priority

## Run locally

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

## Deploy on Render

Use this as a Node web service, not a static site.

```text
Build Command: npm install
Start Command: npm start
```

## Notes

This version does not depend on AI-generated image files. The look is built mostly with CSS gradients, shadows, borders, and browser-rendered UI. Later, you can replace or enhance pieces with public-domain or properly licensed assets.
