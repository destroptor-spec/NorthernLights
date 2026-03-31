# Aurora Media Server API Documentation

All API endpoints are prefixed with `/api`.
Most endpoints require authentication via a JWT token.

## Authentication
Authentication is handled via JSON Web Tokens (JWT). 
Include the token in the `Authorization` header:
`Authorization: Bearer <your_token>`

---

## 🔐 Auth & Setup

### [GET] `/api/setup/status`
Check if the server requires initial setup (first admin creation).
- **Public**: Yes
- **Returns**: `{ needsSetup: boolean, dbConnected: boolean }`

### [POST] `/api/setup/complete`
Complete initial setup by creating the first admin account.
- **Public**: Yes (only if `needsSetup` is true)
- **Body**: `{ username, password }`
- **Returns**: `{ status: 'completed', token, user: { id, username, role: 'admin' } }`

### [POST] `/api/auth/login`
Authenticate a user.
- **Public**: Yes
- **Body**: `{ username, password }`
- **Returns**: `{ token, user: { id, username, role } }`

### [POST] `/api/auth/register`
Register a new user using an invite token.
- **Public**: Yes
- **Body**: `{ inviteToken, username, password }`
- **Returns**: `{ token, user: { id, username, role } }`

### [GET] `/api/auth/me`
Get current authenticated user information.
- **Returns**: `{ user: { userId, username, role } }`

### [POST] `/api/auth/change-password`
Change the password for the current user.
- **Body**: `{ currentPassword, newPassword }`
- **Returns**: `{ status: 'changed' }`

### [DELETE] `/api/auth/delete-account`
Delete the current user's account.
- **Body**: `{ password }`
- **Returns**: `{ status: 'deleted' }`

### [GET] `/api/auth/invites/:token/validate`
Check if an invite token is valid.
- **Public**: Yes
- **Returns**: `{ valid: boolean }`

---

## 🛠️ Admin

### [GET] `/api/admin/users`
List all users.
- **Role**: Admin
- **Returns**: `{ users: [{ id, username, role, last_login }] }`

### [POST] `/api/admin/users`
Create a new user manually.
- **Role**: Admin
- **Body**: `{ username, password, role }`
- **Returns**: `{ user: { id, username, role } }`

### [PUT] `/api/admin/users/:id`
Update a user's details.
- **Role**: Admin
- **Body**: `{ username?, password?, role? }`
- **Returns**: `{ status: 'updated' }`

### [DELETE] `/api/admin/users/:id`
Delete a user.
- **Role**: Admin
- **Returns**: `{ status: 'deleted' }`

### [GET] `/api/admin/invites`
List all active/expired invites.
- **Role**: Admin
- **Returns**: `{ invites: [{ token, role, max_uses, current_uses, expires_at, created_by }] }`

### [POST] `/api/admin/invites`
Create a new invitation token.
- **Role**: Admin
- **Body**: `{ role?, maxUses?, expiresIn? (seconds) }`
- **Returns**: `{ invite, inviteUrl }`

### [DELETE] `/api/admin/invites/:token`
Revoke an invitation.
- **Role**: Admin
- **Returns**: `{ status: 'revoked' }`

### [POST] `/api/admin/cleanup-playlists`
Remove playlists that are no longer associated with a valid user.
- **Role**: Admin
- **Returns**: `{ status: 'ok', deletedCount: number }`

### [GET] `/api/admin/db/status`
Check the status of the PostgreSQL container.
- **Role**: Admin (or public if DB is down)
- **Returns**: `{ running: boolean, status: string, configuredData: { user, port, host, database } }`

### [GET] `/api/admin/db/stats`
Get database size and row counts for tables.
- **Role**: Admin
- **Returns**: `{ dbSize: string, tables: [{ name, count, size }] }`

### [POST] `/api/admin/db/start` / `/api/admin/db/stop`
Control the database container.
- **Role**: Admin
- **Returns**: `{ status: 'starting' | 'stopping' }`

---

## 📚 Library

### [GET] `/api/library`
Get the entire library structure.
- **Returns**: `{ tracks, directories, artists, albums, genres }`

### [GET] `/api/library/stats`
Get per-directory track counts and analysis progress.
- **Returns**: `{ directories: [{ path, totalTracks, withMetadata, analyzed }] }`

### [POST] `/api/library/add`
Add a directory to the library.
- **Body**: `{ path }`
- **Returns**: `{ status: 'added' }`

### [POST] `/api/library/remove`
Remove a directory and all its tracks from the library.
- **Body**: `{ path }`
- **Returns**: `{ status: 'removed' }`

### [POST] `/api/library/scan`
Trigger a recursive directory scan, metadata extraction, and audio analysis.
- **Body**: `{ path }`
- **Returns**: `{ status: 'completed', message }`

### [GET] `/api/library/scan/status` (SSE)
Server-Sent Events endpoint for real-time scan progress.
- **Event data**: `{ isScanning, phase, currentFile, scannedFiles, totalFiles, activeWorkers }`

### [POST] `/api/library/analyze`
Trigger audio feature analysis for tracks that are missing it.
- **Body**: `{ force?: boolean }`
- **Returns**: `{ status: 'completed', message, count }`

### [GET] `/api/library/analyze/status`
Get current audio analysis coverage stats.
- **Returns**: `{ analyzedTracks: number, totalTracks: number }`

---

## 🎵 Playlists

### [GET] `/api/playlists`
List all playlists owned by or pinned by the current user.
- **Returns**: `{ playlists: [{ id, title, description, isLlmGenerated, tracks: [...] }] }`

### [POST] `/api/playlists`
Create a new manual playlist.
- **Body**: `{ title, description? }`
- **Returns**: `{ id, title, description, tracks: [] }`

### [POST] `/api/playlists/:id/tracks`
Add tracks to a playlist.
- **Body**: `{ trackIds: string[] }`
- **Returns**: `{ status: 'success' }`

### [DELETE] `/api/playlists/:id`
Delete a playlist.
- **Returns**: `{ status: 'deleted' }`

### [PATCH] `/api/playlists/:id/pin`
Toggle the pinned status of a playlist for the current user.
- **Body**: `{ pinned: boolean }`
- **Returns**: `{ status: 'ok', pinned }`

---

## 🎧 Playback & History

### [POST] `/api/playback/record`
Record a successful playback event and add to session history.
- **Body**: `{ trackId }`
- **Returns**: `{ status: 'recorded' }`

### [POST] `/api/playback/skip`
Record a track skip event.
- **Body**: `{ trackId }`
- **Returns**: `{ status: 'recorded' }`

### [POST] `/api/playback/history`
Manually add a track to the current session's history (for Infinity Mode).
- **Body**: `{ trackId }`
- **Returns**: `{ status: 'recorded' }`

---

## ⚙️ Settings

### [GET] `/api/settings`
Get merged system and user-specific settings.
- **Returns**: JSON object with all configuration keys.

### [POST] `/api/settings`
Update system or user-specific settings.
- **Body**: Object containing setting keys and values.
- **Note**: Modifying system-wide keys (e.g., `llmBaseUrl`) requires Administrative role.

### [POST] `/api/health/llm`
Test connection to the configured LLM provider and fetch available models.
- **Body**: `{ llmBaseUrl?, llmApiKey? }`
- **Returns**: `{ status: 'ok', models: string[] }`

### [GET] `/api/genre-matrix/mappings`
Get current genre-to-macro-genre mappings.
- **Returns**: JSON object of mappings.

### [POST] `/api/genre-matrix/remap-all`
Trigger a full re-mapping of all genres in the database.
- **Role**: Admin
- **Returns**: `{ status: 'started' }`

### [POST] `/api/genre-matrix/regenerate`
Manually trigger genre matrix regeneration (calculates distances).
- **Role**: Admin
- **Returns**: `{ status: 'ok', lastRun, lastResult }`

---

## 🤖 Hub (AI Features)

### [GET] `/api/hub`
Get the user's hub collections (Daily playlists, Moods, etc.).
- **Returns**: `{ collections: [...] }`

### [POST] `/api/hub/regenerate`
Explicitly trigger LLM-powered hub regeneration for the user.
- **Body**: `{ force?: boolean }`
- **Returns**: `{ generated: number }` or `{ skipped: true, reason: string }`

### [POST] `/api/hub/generate-custom`
Generate a one-off playlist based on a user prompt.
- **Body**: `{ prompt }`
- **Returns**: `{ playlist: { id, title, tracks: [...] } }`

---

## 🔍 Entities

### [GET] `/api/artists` / `/api/albums` / `/api/genres`
List all artists, albums, or genres respectively.

### [GET] `/api/artists/:id` / `/api/albums/:id` / `/api/genres/:id`
Get detailed information for a specific entity including its tracks.

---

## 📻 Media & Streaming

### [GET] `/api/stream`
Stream audio content. Supports Range requests for seeking.
- **Query Params**: `pathB64` or `path`
- **Transcoding**: WMA files are automatically transcoded to MP3 (192k) if FFmpeg is installed.

### [GET] `/api/art`
Retrieve embedded album art for a track.
- **Query Params**: `pathB64` or `path`
- **Returns**: Binary image data with appropriate `Content-Type`.

---

## ✨ Miscellaneous

### [POST] `/api/recommend`
Get the next recommended track for Infinity Mode.
- **Body**: `{ sessionHistoryTrackIds: string[], settings?: object }`
- **Returns**: `{ track: TrackObject }`

### [GET] `/api/health`
Basic health connectivity check.
- **Returns**: `{ status: 'ok', dbConnected, message }`
