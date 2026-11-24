# AGENTS.md

## Project: Modern Web Music Player (Aurora)

A client-server music player built with React (Frontend) and Express + PostgreSQL (Backend). Features gapless local file playback, metadata extraction, AI-driven infinite playlist generation (hop costs), audio effects, offline support, dark/light themes, keyboard shortcuts, and PWA compatibility. Support for all major audio formats.

## Development Progress Tracker / implementation plan
Use [TASKS.md](./TASKS.md) for a detailed status of each milestone.
Update this file when changes are made, started and ended.
Be specific and thorough so progress can be picked up easily.

## Product Direction
See [PRODUCT.md](./PRODUCT.md) for what Aurora is, who it's for, and the principles and non-goals that decide which features ship. Consult before proposing new feature areas or scope expansions.

## Design Direction
See [DESIGN.md](./DESIGN.md) for the canonical design system — Aurora brand identity, color/typography/glass tokens, component rules, and authoring anti-patterns. Consult before adding new UI primitives or visual treatments.

## Versioning

Standard semver with pre-1.0 `-beta.N` / `-alpha.N` / `-rc.N` suffixes. Current version lives in `package.json` (`1.0.0-rc.6`); milestone history lives in [MEMORY.md](./MEMORY.md) and [CHANGELOG.md](./CHANGELOG.md).

When releasing: bump `package.json`, add a dated entry to `MEMORY.md`, and update `TASKS.md` if the release closes a milestone.

## Project Structure

Top-level layout — explore subdirectories with `ls` for current file inventories.

- `src/components/` — UI components. Subfolders: `library/` (detail views + shared library primitives like `AlbumCard`, `FadedHeroImage`; the artist page's header is only name + Play/Radio/Links, the "About {artist}" and "About {album}" cards are built from `AboutCard.tsx` (card lit by the picture's colour, small-headed blocks, `CollapsibleText` Read more, `TagPills`; classes `.about-card*`) in `ArtistAboutSections.tsx` / `AlbumAboutSection.tsx`; artist and album pages end with `browse/StyleProfileSection` "Genres and styles"; on the album page both sit inside the track list's scroller, after the last track), `settings/` (modular settings tabs), `cast/` (`CastHealthToasts`). Cast has no button of its own: it lives in the Connect menu (`ConnectMenu.tsx`), which opens Chrome's device picker through `castManager.openCastPicker()`; Cast state comes from `useCastStatus`.
- `src/hooks/` — Custom React hooks (data fetching, gestures, dominant-color extraction, toasts).
- `src/store/` — Zustand state with persistence middleware.
- `src/utils/` — Pure utilities. Notable singletons: `PlaybackManager`, `CastManager`, `PreloadManager`.
- `src/App.tsx` / `main.tsx` — Layout orchestration / entry point.
- `server/` — Express backend.
  - `routes/` — Route modules per resource (auth, library, playback, hub, playlists, etc.).
  - `services/` — Business logic (recommendation, llm, audio extraction, `genreTaxonomy/` genres and styles, modular `metadata/`).
  - `workers/` — `audioAnalysis.worker.ts` spawns persistent `tsx` child processes (`analyzeTrack.ts`) for CPU-intensive Essentia analysis. Concurrency controlled by `audioAnalysisCpu` (Background=1, Balanced=4, Maximum=6). Handles non-ASCII filenames via temp symlinks in `/tmp/am-*/`.
  - `middleware/` — JWT `requireAuth` / `requireAdmin`; `createRateLimiter` (the one limiter factory: counts every request per user/IP, or with `count: 'failures'` only 401s, in-flight requests included; the latter sits in front of API v1 sign-in, 120 a minute per IP, #260). Give a route its own limiter only for a reason the router-wide `listenerLimiter` can't cover (media streaming's own bucket, invite guessing, pairing), not to satisfy CodeQL; `deprecatedRoute` marks the legacy listener routes the web app no longer calls (logs each call as `[Deprecated API]`, see `docs/legacy-listener-routes.md`). Don't add listener features to those routes: use `/api/v1`.
  - `state.ts` — Shared mutable state (DB status, scan status, session history).
- `docs/` — Detailed feature specs and plans.

## Button System (`src/index.css`)
Use the global button classes — do NOT write inline Tailwind button strings. Combine a base `.btn` with a variant and optional size:

| Class | Purpose |
|-------|---------|
| `.btn` | Base — compact inline-flex, `8px 16px`, `0.875rem` |
| `.btn-primary` | Filled purple action |
| `.btn-danger` | Outlined red warning |
| `.btn-danger-fill` | Filled red destructive |
| `.btn-ghost` | Glass/neutral outlined |
| `.btn-lg` | Size modifier for CTAs |
| `.btn-sm` | Size modifier for inline actions |
| `.btn-tab` | Sub-tab toggle (use `.active` modifier) |
| `.btn-dashed` | Full-width dashed add/create |
| `.btn-icon` | Icon-only (combine with `.btn-danger` for red icons) |

Example: `<button className="btn btn-primary btn-sm">Rescan</button>`

## CSS Utilities (`src/index.css`)
| Class | Purpose |
|-------|---------|
| `.safe-area-bottom` | `padding-bottom: env(safe-area-inset-bottom)` — notched device support |
| `.safe-area-top` | `padding-top: env(safe-area-inset-top)` — notched device support |
| `.hub-discover-cover` | Responsive cover art size (100px mobile, 120px desktop) with right shadow |
| `--safe-area-*` | CSS custom properties wrapping `env(safe-area-inset-*)` |
| `.header-pill` | A pill on the header row (inactive tabs, Search at rest, the user menu, Settings): 38 px, the same fill, border and hover. Use it for anything new on that row |
| `.card-hover` + `.card-play` | The one card hover (the Hub's "Uniquely yours" cards): card rises 2px, Play (`btn-fab card-play`) rises in at the cover's bottom-left; title gets `group-hover:text-[var(--color-primary)]`. No cover zoom or dark overlay. Play is hidden on touch |

Mobile-specific rules (in `@media (max-width: 767px)` block):
- Larger touch targets: `.player-control-btn` 48px, `.play-btn-main` 64px
- `.volume-control` and `.keyboard-hint` hidden on mobile

## Coding Standards
- **State:** Use **Zustand**. Keep playback state (currentTrack, progress) in the store.
- **Audio:** Wrap `HTMLAudioElement` and `AudioContext` in a singleton or custom hook to prevent duplicate instances. `PlaybackManager` and `CastManager` handle routing.
- **Storage:** Frontend uses `idb-keyval` for configs. Backend uses **PostgreSQL** (`pg` driver) for library management and vector embeddings.
- **I/O:** Use Node.js `fs` streams and `music-metadata` for safe raw-byte extraction directly. Handle encoding explicitly.
- **Types:** Interfaces for `Track`, `Metadata`, and `StoreState`. Avoid `any`.
- **Icons:** Use `lucide-react` for all icons. Do not add new inline SVGs unless no lucide equivalent exists.
- **Styling:** Use Tailwind CSS classes. Use global `.btn` variant classes (see Button System below). Extract repeated class strings to CSS classes in `index.css`. Use CSS custom properties for shared design tokens (colors, gradients, shadows).
- **Custom Hooks:** Extract repeated `useState` + `useEffect` patterns into hooks under `src/hooks/`.
- **Utility Functions:** Extract pure logic (formatting, encoding) to `src/utils/` and import rather than duplicating.
- **Worker Threads:** CPU-intensive tasks (audio analysis) must run in worker threads to prevent blocking the main event loop. Use `server/workers/` pattern with child processes.

## Three-Phase Scanner Architecture
Library scanning operates in three distinct phases:

1. **Walk Phase**: Recursive directory traversal collecting audio file paths (MP3, FLAC, OGG, M4A, AAC, WMA). No database writes.

   **Moves and renames (#78):** before the walk removes tracks it didn't find, `services/moveDetection.ts` pairs them with new files one-to-one (same size and modified time; else same size, title, artist, album and length ±1.5 s) and `moveTrackPaths` moves the row in place, so its id, playlist entries, likes, history and analysis stay. A track's id is therefore not always base64(path): look rows up by path (`resolveTrackIdForPath`, used by `addTrack` / `recordUnparsedTrack`), and the stream route resolves a file by id first.

2. **Metadata Phase**: Parallel ID3/Vorbis/ASF tag extraction via `music-metadata`. Stores track metadata (title, artist, album, genre, duration) in PostgreSQL. Creates artist/album/genre entity records. Tracks visible immediately after this phase.

3. **Analysis Phase**: Audio feature extraction via worker threads:
   - **Three windows**: 15 s each at 20/50/80 % of the track, decoded by one ffmpeg call at 44.1 kHz (DSP) and 16 kHz (models); duration comes from the DB, no per-track ffprobe
   - **One network**: Discogs-EffNet once per track (three windows share one 64-patch batch), plus small classifiers on its embeddings for 400 style scores, danceability, acousticness and instrumentalness. Inference sits behind `EssentiaCpuBackend` in `extractor.py` so a CUDA/ROCm backend can replace it; see `docs/audio_management.md`
   - **Style scores**: stored in `track_style_scores` (400 values, own `genre_version`) in the same transaction as `track_features`
   - **Moods**: five mood classifiers (happy, sad, relaxed, aggressive, party) and the 56-tag MTG-Jamendo mood/theme head on the same embeddings, stored in `track_moods` (`shared/audioMoods.ts`); tracks analysed earlier are scored from their stored embedding by `moodScores.service.ts`
   - **Symlink Workaround**: Non-ASCII filenames handled via temp symlinks in `/tmp/am-*/`
   - **Safe Essentia**: Individual algorithm error handling with graceful fallbacks
   - **Results**: 21-dimensional feature vectors (**8D acoustic semantic** + 13D MFCC) stored in `track_features` table. Supports slicing for legacy 7D compatibility. Uses native SQL aggregation (`AVG`/`STDDEV`) for ultra-fast library-wide vector normalization.

4. **Genres and styles** (`server/services/genreTaxonomy/`, see `docs/Aurora genre and style redesign.md`): tags map to the 400-style Discogs taxonomy through `tag_map` (exact → aliases → spelling groups → MusicBrainz aliases and parents from the shipped snapshot); fusion combines tags, the sound (style scores) and corrections into `track_styles`, album and artist profiles, style centroids, and the derived `track_genres` / `tracks.genre_id` that Subsonic, the API and filters show. The old Genre Matrix (MBDB import, `genre_tree_paths`, `subgenre_mappings`, LLM/KNN categorizer, hop cost) was retired in phase 4.

**API Endpoints:**
- `POST /api/library/scan` — Full three-phase scan
- `POST /api/library/analyze` — Analysis phase only (tracks without features)
- `POST /api/library/remove` — Removes a directory and all associated tracks. Also triggers `purgeOrphanedTracks` (safety net) and `purgeOrphanedEntities` to prevent ghost albums/artists.
- `GET /api/library/stats` — Per-directory coverage statistics
- `GET /api/library/status` — SSE stream for real-time scan progress.
- `GET /api/library/scan/status` — SSE stream for real-time scan progress (aliased).

**Scanner UI Reactivity**:
The scanner indicator in `App.tsx` must use reactive Zustand subscriptions for `scanPhaseGlobal`, `scannedFilesGlobal`, `totalFilesGlobal`, etc., rather than `getState()` snapshots. This ensures the UI accurately reflects transition between walk, metadata, and analysis phases. Updated `server/index.ts` and `library.routes.ts` now track a `libraryChanged` flag to eliminate redundant frontend re-fetches during no-op auto-walk ticks.

## Shared Utilities (src/utils/)
- `formatTime(seconds, fallback?)` — Formats seconds as `M:SS`. Returns fallback for invalid input (default `'0:00'`).
- `parseArtists(raw)` — Splits an artist-credit string into individual names (`feat.`/`ft.`, comma-lists; preserves group names like "Nick & Jay"). Thin alias over the canonical splitter in `shared/artistCredit.ts`, shared verbatim with the server (`splitArtistNames`) so client and server can't drift. NB: the scan worker's `splitNames` is a deliberately more aggressive splitter and is intentionally not shared.
- `fetchGenreImage(genre)`, `fetchArtistData(artist)`, `fetchAlbumImage(album, artist)` — External image lookup from `externalImagery.ts`.
- `streaming.ts` — Runtime HLS URL rewriting based on `streamingQuality`; used at actual playback/cast time so browser playback honors current settings instead of stale queued URLs. Cast uses a separate compatibility resolver that maps `auto`/`source` to a known-safe AAC bitrate.
- `queue.ts` — Sender-side queue identity helpers. Generates stable `queueEntryId` values for the active play queue so local queue actions can be mirrored onto an active Cast session without full reloads.
- `SessionMirror.ts` — "Sync playback across devices": an admin server setting (`playbackSyncMode`: off/on/user, Settings → System → Service); with `user`, each user's own `playbackSyncEnabled` (server-side per user, Settings → Playback). Rule in `shared/playbackSync.ts`; the store derives `syncPlaybackAcrossDevices`. The server enforces it for every API v1 client alike: `/api/v1/playback-sessions*` answers `403 PLAYBACK_SYNC_DISABLED` while off (`server/services/playbackSync.service.ts`). Settings stay out of v1; v1 clients get `playbackSync.changed` (`{enabled}`) on `/events`, and the web app also re-reads on returning to the foreground. While this device plays it holds the playback session's output: mirrors queue/repeat/shuffle as anchored patches planned by `sessionQueueDiff.ts`, and reports what it plays. See `docs/playback_sessions.md` (Phase 2).
- `SessionFollower.ts` — the other half of that setting. Listens to `/api/v1/events` (scoped `sse` token only, never the session JWT). An idle device (not playing, not casting, not holding the output) takes over the session's queue silently and shows live progress and "Playing/Paused on <device>" (`sessionFollow` in the store, `useFollowedDeviceLabel`); that line is a chip that reopens "Play where?". A newer claim by another device makes the mirror stop this one (`noteReplaced` → `onDisplaced` → pause). Any playback action on an idle device (Play, Pause, Next, Previous, seek, queue tap, a new song/album via `setPlaylist`) is routed by the store's `routeToPlayingDevice`: to the playing device when chosen (`remoteControlOutputId`, persisted, forgotten when that device stops playing; sent by `sessionRemote.ts`), else "Play where?" (`playWherePrompt`, `PlayWherePrompt`). Play/Pause buttons read `useDisplayedPlaying`/`selectDisplayedPlaying`. Pure helpers in `sessionFollow.ts`. Remote commands (`POST /api/v1/playback-sessions/:id/commands` → `playbackSession.command`) for the grant this device holds are carried out by `sessionCommands.ts` through the normal player actions (so they reach a Cast device while casting).
- `listenTogether.ts` — Listen together in the web app (`docs/listen-together.md`, 6c): the owner's gig (`GigSection` at the foot of the Connect card: discoverable, link, level, End), "Available gigs" nearby, invitations (`InvitePrompt`; `/listen/<token>` via `ListenLink`), and the session this user is a guest in. State in `store/listenTogether.ts`, fed by `SessionFollower` (`onOwnSession`, `onSharedSession`, `onTogetherEvent`). `SessionMirror` claims only the user's own sessions (`isOwnSession` in `sessionFollow.ts`). A device that shows a shared session (`openedSessionId`, 6d) has `SessionFollower` follow it (`followShared`) and the store route every action to its playing device; it never plays or claims it.
- `PreloadManager.ts` — Lightweight next-track HLS prewarm manager. Watches store-driven queue changes and POSTs to the backend prewarm endpoint for the next queued item only; deduplicates in-flight/completed prewarms to avoid waste.
- `CastManager` — Singleton Google Cast (Chromecast) manager. Handles cast context init, media loading, `LoadRequest + queueData` queue bootstrap, play/pause/seek/volume routing, runtime queue mutation (`Play Next`, append, remove, reorder, repeat sync), custom receiver routing, mobile foreground/session watchdog reconciliation, stored-session rejoin, stale `PresentationConnection` recovery/retry, sender Media Session metadata sync during Cast hydration/auto-advance, and sender diagnostics into `logs/cast-receiver.log`. Cast diagnostics include checklist markers such as `cast-button-state`, receiver state markers, and `stale-transport-recovered`. Used by `PlaybackManager` to delegate controls when cast-connected.
- `CastHealthToasts` — Headless sender surface for actionable Cast health states emitted by `CastManager`. Recovered/warning/error states use the global toast system; warning/error toasts include Retry via `CastManager.retryConnectionFromUi()`. Do not add separate Cast status banners. Connecting/rejoining/recovering show as a spinner on the Connect button (and on the Connect menu's Cast row).
- Cast sender UI is consolidated into existing playback surfaces. Desktop uses `PlayerControls` plus `ProgressBar`; casting, connecting and stopping go through the Connect button and its card ("Cast to a device", and while casting "This device · Stop casting"). Mobile uses `MobileMiniPlayer` and `MobileNowPlaying`, including Cast device context and Cast volume. Do not reintroduce separate Cast mini players or Cast-only controller modals unless explicitly approved.
- Queue sections: tracks queued by hand carry `queued` (Play next → top of that run, Add to queue → its end, dragging in/out sets it); the desktop `PlaylistSidebar` shows the upcoming queue in sections via `QueueList sections` (`utils/queueSections.ts`: Current track, Next in Queue, "Next from: <QueueSource.name>", Infinity). On phones, `MobileNowPlaying` uses `QueueList upcoming` (one list from the playing track down, queued tracks marked with `SquareLetterQ`, `.queue-mark`) and the same tabs, sticky at the queue panel's foot. Tabs at the sidebar's foot: Queue and Recently played (`RecentlyPlayedList`, `useRecentlyPlayed`: `GET /api/v1/me/recently-played`, 30 a page, keyset over `user_playback_stats.last_played_at`, index `ups_user_last_played_idx`). Its header (`QueueSidebarHeader`) holds Save/Clear/Collapse and, on desktop with the sidebar expanded, Listen together (`useQueueSidebarShowsGig`; Connect leaves out its `GigSection`, Available gigs and Open then): the owner's gig, `GigJoinButton` ("Join Bo's Gig", `.gig-join` turning border) for gigs nearby and for one the user is a guest in on another device, and the guest's Leave.
- Queue safety: `PlaylistSidebar` provides Clear with undo and per-track removal undo. User-triggered Play Next/Add to Queue actions show undoable queue toasts, while internal system additions stay quiet. Undo restores the previous queue snapshot and asks `CastManager` to rehydrate the active Cast queue if still connected.
- `PlaybackManager` — Singleton audio playback manager. Routes play/pause/seek to local `HTMLAudioElement` or `CastManager` depending on connection state. Owns browser Media Session metadata/actions for local and Cast playback, using Cast time/duration while casting. Local HLS playback has a secondary prepared audio/hls.js pipeline for the next queued track and logs track-end to next-audible transition latency in the browser console.

## Chromecast / HLS Architecture
- `public/receiver.html` — Custom CAF receiver. Uses `PlaybackConfig` request handlers for manifest/segment auth, persistent receiver debug logging, Aurora-branded TV overlay UI, explicit app-loading/loading/delayed-buffering/seeking/paused/error/idle state affordances, queue-aware `Up Next` rendering, idle/paused burn-in protection, receiver checklist markers (`receiver-state`, `receiver-idle-timeout`, `receiver-paused-timeout`), and forced AAC HLS playback for deterministic Chromecast compatibility.
- `server/routes/media.routes.ts` — HLS entrypoints. Serves a master playlist at `/api/stream/:trackId/playlist.m3u8`, a media playlist at `/api/stream/:trackId/media.m3u8`, exact-session MPEG-TS segments, `POST /api/stream/:trackId/prewarm` for next-track session preparation, and the `/api/cast/log` receiver log ingestion endpoint with server-side JWT/query-token/Bearer redaction.
- `server/services/hlsStream.service.ts` — FFmpeg-backed HLS session generation with per-session temp dirs, playlist readiness thresholds, playlist validation, first-segment probing, and session logging. `planHlsOutput` decides copy vs transcode, bitrate and sample rate; HLS never carries more than 48 kHz (`sourceAudio.service.ts`: 88.2/176.4 → 44.1, 96/192 → 48), since Beoplay Cast speakers stutter on 96 kHz AAC. `GET /api/v1/tracks/:id/stream-format` returns the same plan plus the probed source for the player's signal-chain chip.
- `server/services/debugLogger.service.ts` — File-backed diagnostics writer for `logs/hls-server.log`, `logs/cast-receiver.log`, and `logs/hls-sessions/*.log`.
- Current Cast constraint: Chromecast custom receiver path is intentionally pinned to AAC-in-HLS for reliability, and `source` quality maps to a Cast-safe AAC bitrate rather than source/lossless. Browser HLS may use higher/source qualities; true lossless Cast remains future fMP4 work and should not replace the stable AAC Cast path casually.

## Server Services (server/services/)
- `audioExtraction.service.ts` — persistent Python worker (`server/workers/extractor.py`, Essentia TensorFlow) for feature version 3: three 15 s windows at 20/50/80 %, EffNet + classifiers, style scores. Legacy notes: non-ASCII filename symlink workaround, safe Essentia with individual algorithm error handling.
- `recommendation.service.ts` — Infinity Mode and Hub playlist generation using **21-dimensional** pgvector HNSW similarity search (8D acoustic + 13D MFCC) and style overlap from the fused genres and styles (`styleOverlap.service.ts`: d − β·cos of style vectors, β from "Style match"; no genre penalty). AI playlists use one score over a bounded candidate set (`aiPlaylistScore.service.ts`: sound distance in spreads − β · style match − novelty; the sound target blends the target styles' centroids with the AI's imputed sound; mood-led requests — the AI's `focus` and `sound_moods` against `track_moods` — are behind `moodTerm`, off until their blind comparison); evaluation set and blind A/B builder in `scripts/ai-playlist-eval/`. Genre paths (`electronic.house`) for artist radio, the daylist and the veto come from `genreTaxonomy/paths.ts`. Timbre-weighted MFCC (3× for electronic/synthetic). SQL-level acousticness dealbreaker. Hard vector clamping (energy/danceability bounds). `banned_genres` veto on fused genre/style paths (a family word like "metal" bans every style ending in it). MFCC imputation safeguard (threshold < 0.25, min 5 seeds). All `<->` parameters use explicit `::vector` casts. Hardened with `NaN` guards and cross-dimension compatibility (7D/8D).
- `specialLists.service.ts` — Special lists for the Hub: the menu of themes a library can carry (style, genre × country, style × decade; activity themes on `track_moods` built but off behind `activities`; ≥ 2L songs from ⌈L/2⌉ artists; `assembleMenu` ranks, caps and rotates), `conceptForTheme` (concept with `special`, built only from the theme's tracks after a dry run in `recommendation.service.ts`). `hubRefresh.service.ts` asks the AI for picks (`generateSpecialPicks`) plus spares, mixes them with general concepts in one rail, rotates themes via user setting `specialListHistory` (14 days, but recent themes stay off only while as many themes remain as special lists are wanted), and deletes old Hub playlists only after new ones are made. Count rule (2/3/6/9 → 1/1/2/3 special) in `shared/hubPlaylists.ts`.
- `scoredMix.service.ts` — artist radio (always; won its blind A/B 3–2–1) and the daylist (behind system setting `daylistEngine`, `pools` until its A/B) on the AI playlists' score: candidates nearest a target sound + the target styles' strong members (+ favourites), music only (`candidatePool.MUSIC_ONLY_SQL` + length window), ranked d̂ − β·match − ν·novelty − φ·favourite − mood fit + jitter, one version per song (`versionKey`), artist cap by credit lead name (`leadArtistKey`). Also `imputeEffNetCentroid` (8D target → embedding centroid, simulated tracks excluded). A/B builder: `scripts/ai-playlist-eval/make-mix-ab.ts`.
- Scale test: `scripts/library-scale/make-library.ts` (a test library in its own database: `--tracks=500` whole albums, or `--copies=3`; runs the genre pipeline) and `run-scale.ts` (times AI playlists, special lists, radio, Discover rail; `DB_NAME=<db>`). Fusion's temp tables need an index + `ANALYZE`; fusion's transaction has its own 15 min statement timeout.
- Logging (`logger.ts`, `logFiles.ts`, installed by `server/logging.install.ts` right after `.env`): the console stays as it is, and Aurora also records it in its own rotating files under `LOG_DIR` (`production.log` everything recorded; `scanner.log`, `analyzer.log`, `loudness.log` each area's errors and warnings always, its detail when its switch is on; `hls-server.log`, `cast-receiver.log`, `auth.log`, `subsonic-api.log`). Levels: errors and warnings always, then the system setting `logLevel` (warn | info | debug; `LOG_LEVEL`). Rotation at `LOG_MAX_FILE_MB` (50) × `LOG_KEEP_FILES` (5), expiry after `LOG_RETENTION_DAYS` (30), hourly, only on Aurora's own files. Use `logChannel`/`logChannelDetail` (or the `logScanner`/`logAnalyzer`/`logLoudness` helpers) for area lines; write files through `logFile(name)`, never `fs.appendFileSync`.
- `aiPlaylistSupport.ts` — the support check for custom AI playlists: a request with target styles and a hard filter (country, language, years, vocals) needs L songs of it, and one that names a style (focus ≥ `STYLE_REQUEST_FOCUS` 0.5) needs L strong members of its styles, else the engine drops it as 'too-thin' and `generateCustomHubPlaylist` throws `ThinRequestError` (v1 `POST /hub/custom` → 422 `CUSTOM_PLAYLIST_TOO_THIN`, message "Your library has …").
- `llm.service.ts` — LLM integration for natural language playlist generation. Supports local providers (LM Studio, Ollama) and cloud (OpenAI). Vocabulary = the library's own genres and styles (`getStyleVocabulary`, up to 300) and `banned_genres` in prompt schemas. 120-second timeout for local LLMs.
- `genreTaxonomy/` — genres and styles: tag mapping, fusion, profiles, centroids, Browse data, genre paths for recommendations (`paths.ts`) and the derived track genres (`trackGenres.ts`).
- File tags beyond the basics: `utils/releaseTags.ts` (label, release date, original date, medium, catalog number, barcode, release status, ℗ line, disc subtitle, explicit → tracks.label/release_date/original_date/media/catalog_number/barcode/release_status/copyright/disc_subtitle/explicit; music-metadata's "list" tags can arrive as plain strings, take either) and `utils/fileLinks.ts` (links into raw_urls: the URL_* names plus any tag holding just a link, e.g. Picard's DISCOGS.COM). The scanner and the background re-read (`trackOrigin.service`, `ORIGIN_READ_VERSION` 5) share them; bump the version when a scan starts reading a new tag so existing files are re-read once. The album endpoint returns them per album as `details.release` (most common value across its tracks, `getAlbumReleaseFacts`); `utils/albumSummary.ts` writes the album card's At a glance and `discKind` picks the rolling disc's CD look. Link labels and which page a link belongs on: `src/utils/linkLabels.ts`. The rolling disc: Cover Art Archive scan, else `getAlbumDiscArt` (fanart.tv `cdart` for that disc / TheAudioDB `strAlbumCDart`, Album art providers in order, cached a day in memory). Recording studios: `getAlbumRecordingPlaces` (MusicBrainz "recorded at" over the release's recordings, one call the first time an album page is opened via `GET /api/v1/albums/:id/recording-places`, kept in albums.recording_places for 90 days; never a background sweep).
- `metadata/` — Modularized external metadata service:
  - `errors.ts` — `RateLimitError`, `ProviderError` classes for typed error handling
  - `cache.ts` — Database caching with conditional `updateLastUpdated` flag
  - `rateLimiter.ts` — Semaphore class for concurrency limiting + retry logic
  - `providers/lastfm.ts` — Last.fm API client with rate limit detection
  - `providers/genius.ts` — Genius API client
  - `providers/musicbrainz.ts` — MusicBrainz API client
  - `providers/theaudiodb.ts` — TheAudioDB v1 client (key in the path; free key `123`, 30 req/min → `theAudioDbThrottle` 2.1 s; live fields differ from the docs: `strBiography`). Always asked when keyed, for its facts (`theAudioDbFacts.ts`: area/country/years/links fill what MusicBrainz lacks; genre/style/mood are display-only tags, never artist_tags/fusion). A name-search hit counts only with the same name, and its MBID is used within the lookup (for fanart.tv) but never stored
  - `providers/fanarttv.ts` — fanart.tv v3 music client (MBID only; the admin's project `api_key` only — no personal `client_key`: it belongs to one fanart.tv user, not a server; most-liked image). Albums by release group: the files' own (`tracks.mb_release_group_id` via the art routes' `ArtworkInfo`, else `albums.mb_release_group_id` off the cached row), else `mbReleaseGroupOfRelease` for the files' release, else TheAudioDB's album match. The Cover Art Archive also tries the tagged release group (release → group → search only when neither id is known). Response shapes checked live 2026-11-24 (fanart.tv's docs refuse automated fetches): `artistthumb`/`artistbackground` and `albums[rgid].albumcover` are lists of `{id, url, likes (string)}` on assets.fanart.tv, no `lang` on music images
  - `index.ts` — Unified API (getArtistData, getAlbumImage, getGenreImage, getLyrics)
  - `providerPriority.ts` + `shared/metadataProviders.ts` — the admin's provider order per item (artist images, artist banners, artist bios, album art), system setting `metadataProviderPriority` (`{item: provider[]}`), edited in Settings → Metadata → Overview (`settings/ProviderOrderEditor.tsx`, dnd-kit). `getArtistData`/`getAlbumImage` ask in that order and keep the first hit; a provider off the list is never asked for that item (Last.fm is still asked last for its tags). Until saved it follows the old single-choice keys `providerArtistImage` etc., which the server still accepts from older cached apps but no longer reads once the new key is set

## Shared Hooks (src/hooks/)
- `useDominantColor(tracks)` — Extracts art URLs and dominant color from a track list. Returns `{ artUrls, primaryArt, bgColor }`.
- `useExternalImage(fetcher, deps)` — Generic image fetching with mounted guard. Returns `{ imageUrl, isLoading, error }`. Supports optional `debounceMs` parameter.
- `useArtistData(name, mbArtistId, options?)` — Fetches artist image/bio/metadata. Returns `{ imageUrl, bio, disambiguation, area, type, lifeSpan, links, genres, isLoading, error }`. Supports `enabled` and `debounceMs` (default 200ms) options.
- `useLlmConnectionTest({ getAuthHeader, onModelsReceived })` — LLM connection testing state + logic.
- `useSwipe(ref, { onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown, threshold })` — Reusable touch swipe gesture detection hook. Returns a ref to attach to the target element.
- `useReviewQueue(base)` — A review queue in Settings → Library Entities (artists, genres): entries, 30-day decisions, signature-cached previews, `decide`/`undo`. Rendered by `settings/ReviewQueue.tsx` (kind filters, one entry open, Skip, Undo toast, Decided list) and `settings/ReviewPanel.tsx` (outcome cards, Skip/Apply, keys 1–9/S/Enter); classes `.entity-review-*`. Use these for any new review queue.
- `useContextMenuTrigger(open)` — right-click, the keyboard menu key and a 500 ms long press on touch screens (iOS too) open an item's context menu, the same one its ⋯ button opens. Spread it on the row or card; for rows inside a `.map` use `<ContextMenuTarget onOpenMenu>` (`src/components/ContextMenuTarget.tsx`). Mark drag handles `data-no-long-press`. Right-click on a link keeps the browser's menu, except a card's own covering link marked `data-card-link` (AlbumCard). Every row or card with a ⋯ menu should have it. Albums: `AlbumCard albumId` gives a card `AlbumContextMenu` (Play, Add to Queue via the store's `addTracksToQueue`, Add to Playlist); tracks from `fetchAlbumTracks` (`utils/albumTracks.ts`, album order via `compareAlbumOrder`). Menus paint `--menu-bg` (dark: the glass 10% brighter).
- `usePresenceList(items, keyOf, { maxAnimated?, enabled? })` — items fold open as they appear and shut as they go (the Connect card's device rows): returns entries with `entering`/`leaving`; a gone item keeps its place and data until folded. Render each with `.presence-fold` (+ `.is-entering`/`.is-leaving`) around one `.presence-fold-inner`, spacing inside the inner. Used by the queue sidebar's rows/headings (`QueueList sections`, over 12 changes just switch) and header blocks.
- `useArtistImageLookup(name)` (`src/utils/artistImageLookups.ts`) — the picture for an artist shown without one. `ArtistInitial` (every initials fallback; `lookup={false}` on the artist's own page) and the Hub's artist tile use it: names on screen go in one batched `POST /api/v1/artists/image-lookups` (≤100), queued ones are asked again every 5 s while still on screen (3 min at most), and the picture is swapped in. Server side, `requestArtistImages` in `artistImageEnrichment.service.ts` puts them at the front of the background backfill (newest first, 500 max, 5 min restart cooldown after a rate limit/outage), so provider calls stay at the backfill pace. Auth comes from `setArtistImageLookupAuth` in `main.tsx`, not the store. Never add per-card provider lookups.
- `useToast()` — Global toast access. Returns `{ toasts, addToast, removeToast }`. Toast items rendered via `ToastContainer` in App.tsx.

## Workflow
- Always check `package.json` before installing new dependencies.
- Use `npm` for package management.
- Ensure `.env` is used for any non-public configuration.
- Use `npx vite build` to build.
- Use `npx tsc --noEmit` to typecheck.
- Use `npm run verify:cast` after completing the manual Cast checklist in `docs/cast-design-checklist.md`; it audits `logs/cast-receiver.log` for required markers and token redaction.
- Run typecheck after every code change.
- For worker threads: Test with various filename encodings (Danish, em-dashes, apostrophes).
- Monitor memory usage during batch analysis (target < 600MB RSS).

## Key Dependencies
- **Frontend:** React, Zustand, lucide-react, idb-keyval
- **Backend:** Express, pg (PostgreSQL), music-metadata, jsonwebtoken, bcrypt
- **Audio Analysis:** Python Essentia TensorFlow (`essentia-tensorflow` in `.venv`, see `install.sh`), ffmpeg (system binary), ffprobe
- **Build:** Vite, TypeScript, Tailwind CSS, tsx (TypeScript execution)
