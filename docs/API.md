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
10. [External Providers](#-external-providers)
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

---

## 🛠️ Admin

Endpoints in this section require the `admin` role.

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
    "invite": {
      "token": "abcdef...",
      "role": "user",
      "max_uses": 5,
      "uses": 0,
      "expires_at": 1712054400000
    },
    "inviteUrl": "http://localhost:3000/invite/abcdef..."
  }
  ```

### [GET] `/api/admin/db/status`
Check the status of the PostgreSQL container.
- **Example Response**:
  ```json
  {
    "running": true,
    "status": "up",
    "configuredData": {
      "user": "musicuser",
      "port": "5432",
      "host": "localhost",
      "database": "musicdb"
    }
  }
  ```

---

## 📚 Library

### [GET] `/api/library`
Get the entire library structure.
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
    "phase": "metadata",
    "currentFile": "artist - title.mp3",
    "scannedFiles": 150,
    "totalFiles": 1000,
    "activeWorkers": 8
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
        "tracks": [{ "id": "...", "title": "..." }]
      }
    ]
  }
  ```

### [POST] `/api/playlists/:id/tracks`
Add tracks to an existing playlist.
- **Example Request**:
  ```json
  {
    "trackIds": ["track-v4-id-1", "track-v4-id-2"]
  }
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
    "llmBaseUrl": "https://api.openai.com/v1"
  }
  ```

### [POST] `/api/settings`
Update settings. User-level keys are saved per-user; system-level keys require Admin role.
- **Valid System Keys**: `audioAnalysisCpu`, `scannerConcurrency`, `llmBaseUrl`, `llmApiKey`, `llmModelName`, `musicBrainzEnabled`, `geniusApiKey`.
- **Valid User Keys**: `discoveryLevel`, `genreStrictness`, `artistAmnesiaLimit`, `llmPlaylistDiversity`, `genreBlendWeight`, `llmTracksPerPlaylist`, `llmPlaylistCount`.

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
        "target_vector": [0.3, 0.6, 0.2, 0.8, 0.4, 0.9, 0.4]
      }
    ]
  }
  ```

### [POST] `/api/hub/generate-custom`
Generate a new playlist concept from a natural language prompt.
- **Example Request**:
  ```json
  {
    "prompt": "Synthwave for driving late at night in a neon city"
  }
  ```

---

## 📻 Media & Streaming

### [GET] `/api/stream`
Stream audio content. Supports HTTP Range for seeking.
- **Query Params**: `pathB64` or `path`.
- **Note**: WMA files auto-transcode to MP3 if FFmpeg is present.

### [GET] `/api/art`
Retrieve album art image.
- **Query Params**: `pathB64` or `path`.
- **Returns**: Binary image blob (JPG/PNG).

---

## 🌍 External Providers

Proxies for external APIs to avoid CORS issues and manage rate-limiting.

### [GET] `/api/providers/musicbrainz/artist/:mbid`
Proxy request to MusicBrainz artist endpoint.
- **Example**: `/api/providers/musicbrainz/artist/uuid-mbid`

### [POST] `/api/providers/genius/search`
Search for song details or lyrics metadata on Genius.
- **Example Request**:
  ```json
  {
    "query": "Bohemian Rhapsody"
  }
  ```

---

## ✨ Miscellaneous

### [POST] `/api/recommend`
Get the next track for Infinity Mode based on current session history.
- **Example Request**:
  ```json
  {
    "sessionHistoryTrackIds": ["track-v4-id-1", "track-v4-id-2"],
    "settings": { "discoveryLevel": 70 }
  }
  ```
- **Example Response**:
  ```json
  {
    "track": { "id": "next-track-id", "title": "Next Song", ... }
  }
  ```

### [GET] `/api/health`
General system health check.
- **Returns**: `{ "status": "ok", "dbConnected": true, "message": "..." }`
