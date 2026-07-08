# Word Vault 4.51

Hosted-account update: Supabase/Resend support for cross-device accounts, sessions, verification email, and daily leaderboard storage.

## What changed

- Added a host-controlled "How to Play Word Vault" overlay after all secret trays are locked.
- The existing "Let the game begin!" and starter wheel flow still starts after the host clicks "Got it."
- Fixed starter wheel name labels so names no longer crop off the wheel.
- Added Random Online matchmaking with a waiting-room flow.
- If a random match is not found, the host can choose an Experimental CPU fallback.
- In Random Online games with two or more real online players, leaving the tab or screen for 20 seconds applies a -20 point penalty.
- Added Daily Puzzle on the homepage.
- Added Daily Puzzle vs smart CPU with a stopwatch.
- Daily score starts at 1200, loses points per guess, and loses points as time passes.
- Added a public daily leaderboard for best scores, times, guesses, and player names.
- Added account creation/login with hosted Supabase storage when configured.
- Added persistent sessions so players can stay signed in across devices.
- Added Resend verification email sending when configured.
- Local JSON database and local email outbox remain as fallback for local testing.
- Added `/giveup` as an in-game command to pass the active player's turn.
- Re-enabled the lobby Experimental CPU button.
- Added extra CPU timing guards so CPU players do not act during rules, starter intro, queued announcements, or turn-card animations.

## What did not change

- No tray/card sizing changes.
- No board layout changes.
- No fullscreen layout changes.
- No mobile layout changes.
- No scoring-pattern changes.
- No video/mic layout changes.

## Hosted account setup

1. Create a Supabase project.
2. Open Supabase SQL Editor and run `supabase-word-vault.sql`.
3. Add these environment variables to Render/local hosting:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
RESEND_API_KEY=your-resend-api-key
RESEND_FROM_EMAIL=Word Vault <verify@yourdomain.com>
PUBLIC_BASE_URL=https://your-word-vault-site.onrender.com
```

Never put `SUPABASE_SERVICE_ROLE_KEY` in browser/client code. It belongs on the server only.
