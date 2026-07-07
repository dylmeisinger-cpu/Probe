# Word Vault v4.13 Music + Spotify Patch

This patch is built on top of v4.12. It adds the requested music system without changing the core game rules or board UI.

## Added in v4.13

- Built-in default jazz playlist using the uploaded MP3 tracks.
- Music defaults to a low volume.
- Music volume is configurable from the Visual Theme / Audio dialog.
- Sound-effect volume is configurable separately.
- Music automatically ducks/dips while sound effects play.
- Uploaded music fades between songs instead of hard-cutting.
- Added a Music on/off control that is separate from SFX on/off.
- Added Spotify Connect support hooks:
  - Connect Spotify button.
  - Spotify OAuth callback endpoints.
  - Spotify token refresh endpoint.
  - Playlist loading button.
  - Spotify Web Playback SDK player support.
- Spotify controls are optional. If Render is not configured with Spotify credentials, the normal built-in music still works.

## Uploaded music files included

```text
public/assets/music/blue-martini-sky.mp3
public/assets/music/calm-jazz-4.mp3
public/assets/music/calm-jazz.mp3
public/assets/music/wavering-slow-jazz-piano.mp3
public/assets/music/sunset-chill-jazz.mp3
```

## Spotify setup on Render

Create a Spotify Developer app, then add this Redirect URI in Spotify:

```text
https://wordvault.fyi/auth/spotify/callback
```

In Render, add these Environment Variables:

```text
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
SPOTIFY_REDIRECT_URI=https://wordvault.fyi/auth/spotify/callback
```

Then deploy again. Spotify Web Playback generally requires a Spotify Premium account.

## Upload/replace on GitHub

Replace these files/folders:

```text
server.js
package.json
README.md
public/index.html
public/client.js
public/style.css
public/assets/music/
```

The existing sounds in `public/assets/sounds/` should stay in place.

## Render settings

Keep using:

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
