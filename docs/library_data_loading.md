# Library Data Loading

How the client loads and renders library data. Aurora is designed to scale from
a few thousand to 100k+ tracks, so the browser **never loads the full track
list up front**. Views render from lightweight entity lists, tracks are fetched
per entity on demand, search and suggestions run server-side, and the play queue
is restored from persisted state — not from an in-memory library.

## Why

Earlier, `GET /api/library` returned a single object — `{ tracks, directories,
artists, albums, genres }` — that grew to tens of megabytes (≈26 MB at ~23k
tracks). The client held every track in a Zustand `library: TrackInfo[]` array
and derived/searched/queued from it. That had three problems that worsen
linearly with library size:

1. The server blocked its event loop serializing the payload (`res.json` of the
   whole array), stalling all other requests.
2. The response held an HTTP/1.1 connection for its entire download; under the
   browser's ~6-connections-per-origin cap, other requests queued behind it.
3. The client parsed the whole payload and built derived structures on the main
   thread before any view could render.

## Boot flow (entity-first)

`fetchLibraryFromServer` (in `src/store/index.ts`) runs on login / reconnect:

1. **Entity lists first** — fetches `/api/artists`, `/api/albums`,
   `/api/genres`, and `/api/library/directories` in parallel, sets them in the
   store, and clears `isLibraryLoading`. The library views are now interactive.
2. **Queue reconciliation** — `reconcileQueue()` prunes the restored play queue
   (see [Play queue](#play-queue)). No track list is loaded.

The store's `library` array stays **empty** for the entire main app. It is only
populated lazily for two admin tools (see [On-demand cache](#on-demand-full-library-cache)).

## Per-view data sources

| View | Renders from | Tracks |
| --- | --- | --- |
| Artists / Albums / Genres grids (`LibraryHome`) | entity lists (`artists`/`albums`/`genres`) | none |
| Album detail (`AlbumDetail`) | `GET /api/albums/:id` | per-album |
| Artist detail (`ArtistDetail`) | `GET /api/artists/:id` + `GET /api/artists/:id/appears-on` | per-artist + collaborations |
| Genre detail (`GenreDetail`) | `GET /api/genres/:id` | per-genre |
| Live search (`GlobalSearch`) | `GET /api/library/search?q=` | grouped matches only |
| Search results page (`SearchResultsPage`) | `GET /api/library/search?mode=ranked&q=` | cursor-paged mixed matches |
| Hub (`Hub`) | `GET /api/hub`, `/api/hub/smart` (tracks embedded) | embedded |
| Playlists / detail | `GET /api/playlists`, `/api/playlists/:id` | embedded |
| Playlist suggestions | `GET /api/playlists/:id/suggestions` (candidate pool) | pooled |

Detail views fetch + hydrate tracks via the shared `useEntityTracks` hook
(`src/hooks/useEntityTracks.ts`), which calls the endpoint, builds stream/art
URLs through the store's `hydrateTracks` action, and applies the
[liked-state overlay](#likedloved-state).

## Server-precomputed album metadata

The Albums and Genres views previously derived per-album genres, year, release
type, and track count from the full track list. `getAllAlbums`
(`server/database/index.ts`) now computes these server-side via a `LATERAL`
aggregate over `tracks` grouped by `album_id`, returning on each album row:

- `track_count`, `derived_year` (`MIN(year)`)
- `derived_genres` (distinct), `derived_release_type` (one → that, many →
  `Various`, none → `Album`)
- `art_hash` — a representative track's embedded-cover hash, so cards build a
  **local** `/api/art?hash=…` URL instead of hitting the external art proxy.

The client's `deriveAlbumMetadata` (`src/utils/filterState.ts`) prefers these
fields and only falls back to track derivation if they're absent.

## Server-side search

`GET /api/library/search?q=` (`searchLibrary` in `server/database/index.ts`)
runs three trigram-indexed `ILIKE` queries for tracks, artists, and albums. It
returns `{ artists, albums, tracks }` with per-user `is_loved`. Exact names are
ranked before prefixes, word prefixes, and substring matches, including the
canonical `artists.normalized_key` identity. `GlobalSearch` debounces input and
aborts the prior request per keystroke. Empty queries return empty arrays and
each grouped result type is capped.

Submitting the live search opens `/search?q=`. That page requests
`mode=ranked`, which returns a single mixed list as
`{ results: [{ type, relevance, item }], nextCursor }`. Results use a
deterministic 50–100 relevance scale and stop below 50. The opaque cursor is
bound to the normalized query and carries the complete sort tuple, so infinite
loading uses keyset pagination instead of a deep `OFFSET`. The default batch is
30 and the server clamps requests to 50.

## Liked/loved state

Track "like" (heart) is stored in `user_loved_tracks`. The per-entity and search
endpoints all join it per user, so detail/search tracks carry `is_loved`.
Because those tracks live in component state (not the store), `toggleTrackLove`
also writes a `lovedOverlay: Record<string, boolean>` in the store; views apply
it (via `useEntityTracks`) so a toggle reflects immediately without a refetch.

Note: the UI label is "Like / Liked", but the internal field, table, and the
Last.fm / ListenBrainz scrobble integration all remain "love" (that is those
external APIs' term).

## Per-entity / supporting endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /api/artists` `/api/albums` `/api/genres` | entity rows (albums include derived metadata + `art_hash`) |
| `GET /api/albums/:id` | `{ ...album, tracks }` |
| `GET /api/artists/:id` | `{ ...artist, tracks, rolesInLibrary }` |
| `GET /api/artists/:id/appears-on` | `{ tracks }` — collaborations (artist in `artists[]`, not primary) |
| `GET /api/genres/:id` | `{ ...genre, tracks }` (matches `genre_id` + the genre name in multi-genre tags) |
| `GET /api/library/search?q=` | `{ artists, albums, tracks }` |
| `GET /api/library/search?mode=ranked&q=&limit=&cursor=` | `{ results, nextCursor }` |
| `GET /api/playlists/:id/suggestions` | `{ tracks }` — bounded candidate pool |
| `GET /api/library/tracks` | `{ tracks }` — full list, used only by the on-demand cache |
| `GET /api/library/directories` | `{ directories }` |
| `POST /api/library/tracks/exists` | `{ ids }` — which of the supplied ids still exist (queue pruning) |

## Playlist suggestions

`GET /api/playlists/:id/suggestions` (`getPlaylistSuggestionPool`) returns a
**bounded** pool (≤500) of tracks sharing the playlist's artists, genres, or
album-artists, ordered so shared-artist matches survive the cap. The existing
client overlap-scoring (`src/utils/playlistSuggestions.ts`) then ranks the pool —
the algorithm is unchanged, it just operates on the pool instead of the whole
library.

## On-demand full-library cache

Two admin tools genuinely need per-track data: the Genre Matrix
(`GenreMatrixTab`) and Library Entities review (`LibraryEntitiesTab`).
They call `ensureFullLibraryLoaded()` on mount, which fetches
`/api/library/tracks` once and populates `state.library`. The main app never
triggers this, so the heavy payload only loads when an admin opens those tabs.

## Play queue

The queue (`playlist` + `currentIndex` + `playbackState`) is persisted by
Zustand and restored on reload — it does **not** depend on the library.

- **`reconcileQueue()`** (boot): pulls the restored queue's ids through `POST
  /api/library/tracks/exists`, drops any that no longer exist (stopping playback
  if the current track was removed), and rebuilds each track's stream/art URLs
  from its `path` with the current token. Lightweight — no full list.
- **Stream URLs** are also rebuilt at play time in `playAtIndex`, so a rotated
  media token never breaks playback.
- **Resume on reload**: `onRehydrateStorage` coerces a persisted
  `playbackState: 'playing'` to `'paused'` (a fresh page has no audio playing),
  which avoids a "playing but silent" UI and lets
  `PlaybackManager.restoreFromContinuitySnapshot()` load the current track and
  seek to the saved position. If the browser blocks autoplay, `playUrl` treats
  the `NotAllowedError` as paused (no `nextTrack()` cascade); the next user
  gesture resumes from that position.

## Performance & deployment notes

- **Compression**: `compression` middleware gzips JSON responses
  (`server/index.ts`), with `text/event-stream` excluded so SSE isn't buffered.
- **Settings caches**: `system_settings` / `user_settings` are read through
  in-memory write-through caches in `server/database/index.ts` (volatile
  progress keys excluded).
- **Multiplexing**: enabling HTTP/2 or HTTP/3 at the reverse proxy removes the
  browser's 6-connection-per-origin queueing — see
  [production_guide.md](production_guide.md#reverse-proxy).

## Key files

- `src/store/index.ts` — `fetchLibraryFromServer`, `reconcileQueue`,
  `ensureFullLibraryLoaded`, `hydrateTracks`, `lovedOverlay`, `toggleTrackLove`
- `src/hooks/useEntityTracks.ts` — per-entity fetch + hydrate + overlay
- `src/components/library/{LibraryHome,AlbumDetail,ArtistDetail,GenreDetail,PlaylistDetail}.tsx`, `src/components/{GlobalSearch,Hub}.tsx`
- `server/database/index.ts` — `getAllAlbums`, `getTracksBy{Album,Artist,Genre}`,
  `getArtistAppearsOnTracks`, `searchLibrary`, `getPlaylistSuggestionPool`,
  `getExistingTrackIds`
- `server/routes/{library,albums,artists,genres,playlists}.routes.ts`
