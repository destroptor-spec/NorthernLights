# Aurora Media Server API Documentation

All API endpoints are prefixed with `/api`.
Most endpoints require authentication via a JWT token.

## Table of Contents
1. [Authentication & Setup](#-authentication--setup)
2. [Admin](#-admin)
3. [Library](#-library)
4. [Playlists](#-playlists)
5. [Playback & History](#-playback--history)
6. [Settings](#-settings)
7. [Hub & AI Features](#-hub--ai-features)
8. [Entities](#-entities)
9. [Media & Streaming](#-media--streaming)
10. [Providers](#-providers)
11. [Miscellaneous](#-miscellaneous)

---

## 🔒 Authentication & Setup

All authenticated requests must include the following header:
`Authorization: Bearer <your_jwt_token>`

### [GET] `/api/setup/status`
Check if the server requires initial setup (first admin creation).
- **How to use**: Call this upon first launch to determine if you need to redirect to the setup wizard.
- **Example Response**:
  ```json
  {
    "needsSetup": false,
    "dbConnected": true
  }
  ```

### [POST] `/api/setup/complete`
Complete initial setup by creating the first admin account.
- **How to use**: Submit the admin credentials. Only works if `needsSetup` is true.
- **Example Request**:
  ```json
  {
    "username": "admin",
    "password": "supersecurepassword123"
  }
  ```
- **Example Response**:
  ```json
  {
    "status": "completed",
    "token": "eyJh...",
    "user": { "id": "uuid-v4", "username": "admin", "role": "admin" }
  }
  ```

### [POST] `/api/auth/login`
Authenticate a user.
- **Example Request**:
  ```json
  {
    "username": "johndoe",
    "password": "mypassword"
  }
  ```
- **Example Response**:
  ```json
  {
    "token": "eyJh...",
    "user": { "id": "uuid-v4", "username": "johndoe", "role": "user" }
  }
  ```

### [POST] `/api/auth/register`
Register a new user using an invite token.
- **Example Request**:
  ```json
  {
    "inviteToken": "a1b2c3d4...",
    "username": "newuser",
    "password": "securepassword"
  }
  ```

### [GET] `/api/auth/me`
Get the currently authenticated user.
- **Example Response**:
  ```json
  {
    "user": { "id": "uuid-v4", "username": "johndoe", "role": "user" }
  }
  ```

### [POST] `/api/auth/change-password`
Change the current user's password.
- **Example Request**:
  ```json
  {
    "currentPassword": "oldpassword",
    "newPassword": "newpassword"
  }
  ```

### [DELETE] `/api/auth/delete-account`
Delete the currently authenticated user's account.
- **Example Request**:
  ```json
  { "password": "currentpassword" }
  ```

### [GET] `/api/auth/invites/:token/validate`
Validate an invite token.
- **Example Response**:
  ```json
  { "valid": true }
  ```

---

## 🛠️ Admin

Endpoints in this section require the `admin` role unless otherwise noted.

### User Management

### [GET] `/api/admin/users`
List all users in the system.
- **Example Response**:
  ```json
  {
    "users": [
      {
        "id": "uuid-v4",
        "username": "admin",
        "role": "admin",
        "created_at": 1711968000000,
        "last_login_at": 1711968500000
      }
    ]
  }
  ```

### [POST] `/api/admin/users`
Create a new user directly (bypasses invite system).
- **Example Request**:
  ```json
  {
    "username": "newuser",
    "password": "password123",
    "role": "user"
  }
  ```

### [PUT] `/api/admin/users/:id`
Update a user's details.
- **Example Request**:
  ```json
  {
    "username": "updatedname",
    "role": "admin"
  }
  ```

### [DELETE] `/api/admin/users/:id`
Delete a user.
- **Note**: Cannot delete your own account.

### Invite Management

### [GET] `/api/admin/invites`
List all active invites.
- **Example Response**:
  ```json
  { "invites": [...] }
  ```

### [POST] `/api/admin/invites`
Create a new registration invitation.
- **Example Request**:
  ```json
  {
    "role": "user",
    "maxUses": 5,
    "expiresIn": 86400
  }
  ```
- **Example Response**:
  ```json
  {
    "invite": { "token": "abcdef...", "role": "user", "max_uses": 5, "uses": 0, "expires_at": 1712054400000 },
    "inviteUrl": "http://localhost:3000/invite/abcdef..."
  }
  ```

### [DELETE] `/api/admin/invites/:token`
Revoke an invitation.

### Cleanup

### [POST] `/api/admin/cleanup-playlists`
Clean up orphaned playlists (playlists belonging to deleted users).

### Database Container Control

### [GET] `/api/admin/db/status`
Check the status of the PostgreSQL container.
- **Example Response**:
  ```json
  {
    "running": true,
    "status": "up",
    "configuredData": { "user": "musicuser", "port": "5432", "host": "localhost", "database": "musicdb" }
  }
  ```

### [GET] `/api/admin/db/stats`
Get database statistics (table counts, connection pool status).

### [POST] `/api/admin/db/start` (or `stop`, `create`, `recreate`)
Control the PostgreSQL container.
- **Example Response**:
  ```json
  { "status": "started" }
  ```

### MusicBrainz Taxonomy

### [GET] `/api/admin/mbdb/status` (SSE)
Receive real-time import progress.
- **How to use**: Connect via `new EventSource('/api/admin/mbdb/status?token=<jwt>')`.
- **Example Message**:
  ```json
  {
    "isImporting": true,
    "phase": "downloading",
    "message": "Downloading and extracting MusicBrainz dump...",
    "progress": 45
  }
  ```

### [POST] `/api/admin/mbdb/import`
Trigger the MusicBrainz hierarchical taxonomy import.
- **How to use**: Downloads the latest MusicBrainz dump, extracts (~5GB needed), and populates the genre hierarchy tables.
- **Example Response**:
  ```json
  { "message": "MBDB Import started" }
  ```

### [POST] `/api/admin/mbdb/cancel`
Cancel an in-progress import.

### [GET] `/api/admin/mbdb/check-update`
Check if a newer MusicBrainz dump is available.
- **Example Response**:
  ```json
  {
    "latestTag": "2024-04-01",
    "lastImportTag": "2024-03-01",
    "updateAvailable": true,
    "lastImport": { "tag": "2024-03-01", "timestamp": 1711968000000 }
  }
  ```

### [GET] `/api/admin/health`
Unified admin health check (SSE, DB, container, scanner, MBDB status).

---

## 📚 Library

### [GET] `/api/library`
Get the entire library structure (tracks, directories, artists, albums, genres).
- **Example Track Object**:
  ```json
  {
    "id": "QmFzZTY0...",
    "title": "Stairway to Heaven",
    "artist": "Led Zeppelin",
    "album": "Led Zeppelin IV",
    "genre": "Rock",
    "duration": 482,
    "trackNumber": 4,
    "year": 1971,
    "playCount": 42,
    "rating": 5,
    "bitrate": 320000,
    "format": "flac",
    "artistId": "uuid-v4",
    "albumId": "uuid-v4",
    "genreId": "uuid-v4"
  }
  ```

### [POST] `/api/library/add`
Add a mapped folder.
- **Example Request**:
  ```json
  { "path": "/home/user/music" }
  ```

### [POST] `/api/library/remove`
Remove a mapped folder and its tracks.

### [POST] `/api/library/scan`
Trigger a recursive directory scan.
- **How to use**: Pass an absolute path. The server will walk the directory, extract metadata, and run audio analysis.
- **Example Request**:
  ```json
  { "path": "/home/user/music" }
  ```

### [GET] `/api/library/scan/status` (SSE)
Receive real-time scan progress.
- **How to use**: Connect via `new EventSource('/api/library/scan/status')`.
- **Example Message**:
  ```json
  {
    "isScanning": true,
    "phase": "taxonomy",
    "currentFile": "artist - title.mp3",
    "scannedFiles": 850,
    "totalFiles": 1000,
    "activeWorkers": 8
  }
  ```

### [POST] `/api/library/analyze`
Run audio analysis on tracks without features.
- **Query Params**: `force` (optional, analyze all tracks if true)
- **Example Response**:
  ```json
  { "status": "completed", "message": "Analyzed 150 tracks", "count": 150 }
  ```

### [GET] `/api/library/analyze/status`
Get analysis coverage statistics.
- **Example Response**:
  ```json
  { "totalTracks": 1000, "analyzedTracks": 850, "pendingTracks": 150 }
  ```

### [GET] `/api/library/stats`
Get per-directory statistics.
- **Example Response**:
  ```json
  {
    "directories": [
      { "path": "/home/user/music", "totalTracks": 500, "withMetadata": 480, "analyzed": 450 }
    ]
  }
  ```

---

## 🎵 Playlists

### [GET] `/api/playlists`
List all playlists owned by or pinned by the current user.
- **Example Response**:
  ```json
  {
    "playlists": [
      {
        "id": "user_1711968000000",
        "title": "My Chill Mix",
        "description": "Chill vibes for coding",
        "isLlmGenerated": false,
        "isPinned": false,
        "tracks": [{ "id": "...", "title": "..." }]
      }
    ]
  }
  ```

### [POST] `/api/playlists`
Create a new playlist.
- **Example Request**:
  ```json
  { "title": "My Summer Hits", "description": "Upbeat tracks for summer" }
  ```

### [POST] `/api/playlists/:id/tracks`
Add tracks to an existing playlist.
- **Example Request**:
  ```json
  { "trackIds": ["track-v4-id-1", "track-v4-id-2"] }
  ```

### [DELETE] `/api/playlists/:id`
Delete a playlist (owner or admin).

### [PATCH] `/api/playlists/:id/pin`
Pin or unpin a playlist.
- **Example Request**:
  ```json
  { "pinned": true }
  ```

---

## ⚙️ Settings

### [GET] `/api/settings`
Get all server and user configuration settings.
- **Example Response**:
  ```json
  {
    "audioAnalysisCpu": "Balanced",
    "scannerConcurrency": "SSD",
    "discoveryLevel": 50,
    "llmModelName": "gpt-4",
    "llmBaseUrl": "https://api.openai.com/v1",
    "genreStrictness": 50,
    "artistAmnesiaLimit": 200,
    "llmPlaylistDiversity": 50,
    "genreBlendWeight": 50,
Get all configuration settings. System keys require **Admin** role for modification.

**Valid System Keys**:
- `audioAnalysisCpu`: `Background`, `Balanced`, `Performance`, `Intensive`, `Maximum`.
- `scannerConcurrency`: `HDD`, `SSD`, `NVMe`.
- `autoFolderWalk`: `true` or `false` (recursive scan every 30 mins).
- `llmBaseUrl`, `llmApiKey`, `llmModelName`: Core AI configuration.
- `hubGenerationSchedule`: `Manual Only`, `Daily`, `Weekly`.
- `geniusApiKey`, `lastFmApiKey`: Provider credentials.

**Valid User Keys**:
- `discoveryLevel`: `0-100` (Pool A vs Pool B balance).
- `genreStrictness`: `0-100` (Penalty curve for genre distance).
- `artistAmnesiaLimit`: Number of recent tracks to avoid repeating.

### [POST] `/api/settings/health/llm`
Test LLM connection.
- **Example Request**:
  ```json
  { "llmBaseUrl": "https://api.openai.com/v1", "llmApiKey": "sk-..." }
  ```

### Genre Matrix

### [GET] `/api/settings/genre-matrix/mappings`
Get genre-to-subgenre mappings.

### [POST] `/api/settings/genre-matrix/remap-all`
Trigger full remapping of all genres (admin only).

### [POST] `/api/settings/genre-matrix/regenerate`
Manually trigger genre matrix regeneration (admin only).

---

## 🤖 Hub & AI Features

### [GET] `/api/hub`
Get the user's AI-generated hub collections.
- **Example Response**:
  ```json
  {
    "collections": [
      {
        "section": "Time-of-Day",
        "title": "Morning Coffee",
        "description": "Warm acoustic tracks for your morning.",
        "target_vector": [0.3, 0.6, 0.2, 0.8, 0.4, 0.9, 0.4, 0.5]
      }
    ]
  }
  ```

### [POST] `/api/hub/regenerate`
Trigger regeneration of LLM playlists for the user.
- **Query Params**: `force` (optional, regenerate even if recent)
- **Example Response**:
  ```json
  { "generated": 3 }
  ```

### [POST] `/api/hub/generate-custom`
Generate a new playlist concept from a natural language prompt.
- **Example Request**:
  ```json
  { "prompt": "Synthwave for driving late at night in a neon city" }
  ```

---

## 👤 Entities

### Artists

### [GET] `/api/artists`
List all artists.
- **Example Response**:
  ```json
  [{ "id": "uuid", "name": "Led Zeppelin", "trackCount": 42 }]
  ```

### [GET] `/api/artists/:id`
Get artist details with tracks.
- **Example Response**:
  ```json
  { "id": "uuid", "name": "Led Zeppelin", "tracks": [...] }
  ```

### Albums

### [GET] `/api/albums`
List all albums.

### [GET] `/api/albums/:id`
Get album details with tracks.

### Genres

### [GET] `/api/genres`
List all genres.

### [GET] `/api/genres/:id`
Get genre details with tracks.

---

## 🎵 Media & Streaming

### [GET] `/api/media/stream/:trackId/playlist.m3u8`
The primary streaming endpoint using **HLS (HTTP Live Streaming)**.
- **How to use**: Returns an M3U8 playlist. The backend slices the file into 10s segments on-the-fly.
- **Query Params**: `quality` (`source`, `320k`, `160k`, `128k`, `64k`). Default: `128k`.
- **Note**: Requires FFmpeg on the host machine.

### [GET] `/api/media/stream/:trackId/:segment.ts`
Retrieve a specific HLS transport stream segment.
- **Cache Policy**: Segments are cached indefinitely (`max-age=31536000, immutable`) as they are immutable for a given track/quality session.

### [GET] `/api/media/stream` (Legacy)
Classic HTTP streaming for non-HLS clients or direct downloads.
- **Query Params**: `pathB64` or `path` (Base64-encoded file path).
- **Features**: Full HTTP `Range` support. WMA files auto-transcode to MP3.

### [GET] `/api/media/art`
Retrieve embedded album artwork.
- **Query Params**: `pathB64` or `path`.
- **Note**: Proxies the binary data from the file's metadata directly.

---

## 🔌 Providers

### MusicBrainz (proxy + OAuth)

### [GET] `/api/providers/musicbrainz/artist/:mbid`
Proxy request to MusicBrainz artist endpoint.

### [GET] `/api/providers/musicbrainz/release-group/:mbid`
Proxy request to MusicBrainz release-group endpoint.

### [GET] `/api/providers/musicbrainz/recording/:mbid`
Proxy request to MusicBrainz recording endpoint.

### [GET] `/api/providers/musicbrainz/isrc/:isrc`
Lookup recording by ISRC.

### [GET] `/api/providers/musicbrainz/search/artist`
Search for artists.
- **Query Params**: `q` (search query), `limit`

### [GET] `/api/providers/musicbrainz/search/release-group`
Search for release groups.

### [GET] `/api/providers/musicbrainz/test`
Test MusicBrainz connection.

### [GET] `/api/providers/musicbrainz/authorize`
Get OAuth2 authorization URL.

### [GET] `/api/providers/musicbrainz/callback`
OAuth2 callback handler.

### [POST] `/api/providers/musicbrainz/refresh`
Refresh OAuth token.

### [POST] `/api/providers/musicbrainz/disconnect`
Disconnect OAuth.

### [GET] `/api/providers/musicbrainz/status`
Get connection status.

### Last.fm (per-user)

### [GET] `/api/providers/lastfm/authorize`
Get Last.fm authorization URL.

### [GET] `/api/providers/lastfm/callback`
OAuth callback handler.

### [POST] `/api/providers/lastfm/disconnect`
Disconnect Last.fm.

### [GET] `/api/providers/lastfm/status`
Get connection status.

### [POST] `/api/providers/lastfm/scrobble`
Scrobble tracks.
- **Example Request**:
  ```json
  { "tracks": [{ "artist": "Radiohead", "track": "Creep", "timestamp": 1711968000 }] }
  ```

### [POST] `/api/providers/lastfm/now-playing`
Update now playing status.

### [POST] `/api/providers/lastfm/love`
Love a track.

### [POST] `/api/providers/lastfm/unlove`
Unlove a track.

### [GET] `/api/providers/lastfm/test`
Test Last.fm connection.

### Genius

### [POST] `/api/providers/genius/search`
Search for song details or lyrics metadata on Genius.
- **Example Request**:
  ```json
  { "query": "Bohemian Rhapsody" }
  ```

### [POST] `/api/providers/genius/artist/:id`
Get artist details from Genius.

### [POST] `/api/providers/genius/test`
Test Genius API key.

### External Metadata (cached, server-side)

### [GET] `/api/providers/external/artist`
Fetch artist data (image, bio, metadata).
- **Query Params**: `name`, `mbid` (optional)
- **Note**: Requires authentication.

### [GET] `/api/providers/external/album-art`
Fetch album artwork.
- **Query Params**: `album`, `artist`, `mbid` (optional)

### [GET] `/api/providers/external/genre-image`
Fetch genre artwork.

### [GET] `/api/providers/external/genre-info`
Fetch genre information.

### [GET] `/api/providers/external/lyrics`
Fetch lyrics.
- **Query Params**: `track`, `artist`

### [GET] `/api/providers/external/proxy-image`
Proxy external images server-side to avoid CORS.
- **Query Params**: `url`
- **Note**: Only allows known domains (last.fm, genius, coverartarchive.org, iTunes).

### [POST] `/api/providers/external/refresh`
Clear external metadata cache (admin only).

---

## ✨ Playback & History

### [POST] `/api/playback/history`
Record a track as "Played" for the current session.
- **Payload**: `{ "trackId": "uuid" }`
- **Role**: Influences the the Infinity Mode decay centroid.

### [POST] `/api/playback/record`
Record a successful playback (increments play count).
- **Example Request**:
  ```json
  { "trackId": "track-v4-id" }
  ```

### [POST] `/api/playback/skip`
Record a track skip.

### [POST] `/api/recommend`
Request the next track for Infinity Mode.
- **Payload**: 
  ```json
  {
    "sessionHistoryTrackIds": ["id1", "id2"],
    "settings": { "genreStrictness": 50 }
  }
  ```
- **Returns**: `{ "track": { ...track metadata... } }`

---

## 🌍 Miscellaneous

### [GET] `/api/health`
General system health check.
- **Example Response**:
  ```json
  {
    "status": "ok",
    "dbConnected": true,
    "dbLiveness": true,
    "dbLatency": "5ms",
    "container": { "status": "running", "runtime": "docker", "image": "pgvector/pgvector:pg16" },
    "message": "Aurora Media Server is running!"
  }
  ```