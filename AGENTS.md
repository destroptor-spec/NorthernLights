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

- `src/components/` — UI components. Subfolders: `library/` (detail views + shared library primitives like `AlbumCard`, `FadedHeroImage`), `settings/` (modular settings tabs), `cast/` (`CastButton` wraps `<google-cast-launcher>`).
- `src/hooks/` — Custom React hooks (data fetching, gestures, dominant-color extraction, toasts).
- `src/store/` — Zustand state with persistence middleware.
- `src/utils/` — Pure utilities. Notable singletons: `PlaybackManager`, `CastManager`, `PreloadManager`.
- `src/App.tsx` / `main.tsx` — Layout orchestration / entry point.
- `server/` — Express backend.
  - `routes/` — Route modules per resource (auth, library, playback, hub, playlists, etc.).
  - `services/` — Business logic (recommendation, llm, audio extraction, genre matrix, mbdb, modular `metadata/`).
  - `workers/` — `audioAnalysis.worker.ts` spawns persistent `tsx` child processes (`analyzeTrack.ts`) for CPU-intensive Essentia analysis. Concurrency controlled by `audioAnalysisCpu` (Background=1, Balanced=4, Maximum=6). Handles non-ASCII filenames via temp symlinks in `/tmp/am-*/`.
  - `middleware/` — JWT `requireAuth` / `requireAdmin`.
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

2. **Metadata Phase**: Parallel ID3/Vorbis/ASF tag extraction via `music-metadata`. Stores track metadata (title, artist, album, genre, duration) in PostgreSQL. Creates artist/album/genre entity records. Tracks visible immediately after this phase.

3. **Analysis Phase**: Audio feature extraction via worker threads:
   - **Smart Seeking**: ffmpeg seeks to ~35% into track (past intro) for representative chorus/verse analysis
   - **15-Second Decode**: Captures enough audio for accurate features while minimizing memory
   - **Symlink Workaround**: Non-ASCII filenames handled via temp symlinks in `/tmp/am-*/`
   - **Safe Essentia**: Individual algorithm error handling with graceful fallbacks
   - **Results**: 21-dimensional feature vectors (**8D acoustic semantic** + 13D MFCC) stored in `track_features` table. Supports slicing for legacy 7D compatibility. Uses native SQL aggregation (`AVG`/`STDDEV`) for ultra-fast library-wide vector normalization.

4. **Taxonomic Categorization Phase**: After analysis, the system runs a 3-step pipeline to map local tags to the MusicBrainz hierarchical taxonomy:
   - **Step 1: Direct SQL Match** — 6 UNION ALL branches against `genre_tree_paths`: tree path, alias, standalone genre with parent fallback, standalone alias, fuzzy tree (GIN indexed via `%` operator, threshold 0.7), fuzzy alias.
   - **Step 2: Vocabulary-Guided LLM Batch** — Unmapped tags batched with a 300-genre vocabulary constraint. Library-scoped: if library < 300 genres, returns actual library genres; if ≥ 300, returns top 300 from MBDB hierarchy.
   - **Step 3: KNN Fallback** — Full 21D KNN (8D + 13D MFCC) when vectors available; 8D-only fallback when MFCC missing. NaN guards on all vector operations.

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
- `parseArtists(raw)` — Parses artist strings from metadata (handles JSON arrays, separators).
- `fetchGenreImage(genre)`, `fetchArtistData(artist)`, `fetchAlbumImage(album, artist)` — External image lookup from `externalImagery.ts`.
- `streaming.ts` — Runtime HLS URL rewriting based on `streamingQuality`; used at actual playback/cast time so browser playback honors current settings instead of stale queued URLs. Cast uses a separate compatibility resolver that maps `auto`/`source` to a known-safe AAC bitrate.
- `queue.ts` — Sender-side queue identity helpers. Generates stable `queueEntryId` values for the active play queue so local queue actions can be mirrored onto an active Cast session without full reloads.
- `PreloadManager.ts` — Lightweight next-track HLS prewarm manager. Watches store-driven queue changes and POSTs to the backend prewarm endpoint for the next queued item only; deduplicates in-flight/completed prewarms to avoid waste.
- `CastManager` — Singleton Google Cast (Chromecast) manager. Handles cast context init, media loading, `LoadRequest + queueData` queue bootstrap, play/pause/seek/volume routing, runtime queue mutation (`Play Next`, append, remove, reorder, repeat sync), custom receiver routing, mobile foreground/session watchdog reconciliation, stored-session rejoin, stale `PresentationConnection` recovery/retry, sender Media Session metadata sync during Cast hydration/auto-advance, and sender diagnostics into `logs/cast-receiver.log`. Cast diagnostics include checklist markers such as `cast-button-state`, receiver state markers, and `stale-transport-recovered`. Used by `PlaybackManager` to delegate controls when cast-connected.
- `CastHealthToasts` — Headless sender surface for actionable Cast health states emitted by `CastManager`. Recovered/warning/error states use the global toast system; warning/error toasts include Retry via `CastManager.retryConnectionFromUi()`. Do not add separate Cast status banners. Connecting/rejoining/recovering should be reflected in the Cast icon/launcher location with an animated icon.
- Cast sender UI is consolidated into existing playback surfaces. Desktop uses `PlayerControls` plus `ProgressBar` and the official `CastButton` connected device label/Stop action. Mobile uses `MobileMiniPlayer` and `MobileNowPlaying`, including Cast device context and Cast volume. Do not reintroduce separate Cast mini players or Cast-only controller modals unless explicitly approved.
- Queue safety: `PlaylistSidebar` provides Clear with undo and per-track removal undo. User-triggered Play Next/Add to Queue actions show undoable queue toasts, while internal system additions stay quiet. Undo restores the previous queue snapshot and asks `CastManager` to rehydrate the active Cast queue if still connected.
- `PlaybackManager` — Singleton audio playback manager. Routes play/pause/seek to local `HTMLAudioElement` or `CastManager` depending on connection state. Owns browser Media Session metadata/actions for local and Cast playback, using Cast time/duration while casting. Local HLS playback has a secondary prepared audio/hls.js pipeline for the next queued track and logs track-end to next-audible transition latency in the browser console.

## Chromecast / HLS Architecture
- `public/receiver.html` — Custom CAF receiver. Uses `PlaybackConfig` request handlers for manifest/segment auth, persistent receiver debug logging, Aurora-branded TV overlay UI, explicit app-loading/loading/delayed-buffering/seeking/paused/error/idle state affordances, queue-aware `Up Next` rendering, idle/paused burn-in protection, receiver checklist markers (`receiver-state`, `receiver-idle-timeout`, `receiver-paused-timeout`), and forced AAC HLS playback for deterministic Chromecast compatibility.
- `server/routes/media.routes.ts` — HLS entrypoints. Serves a master playlist at `/api/stream/:trackId/playlist.m3u8`, a media playlist at `/api/stream/:trackId/media.m3u8`, exact-session MPEG-TS segments, `POST /api/stream/:trackId/prewarm` for next-track session preparation, and the `/api/cast/log` receiver log ingestion endpoint with server-side JWT/query-token/Bearer redaction.
- `server/services/hlsStream.service.ts` — FFmpeg-backed HLS session generation with per-session temp dirs, playlist readiness thresholds, playlist validation, first-segment probing, and session logging.
- `server/services/debugLogger.service.ts` — File-backed diagnostics writer for `logs/hls-server.log`, `logs/cast-receiver.log`, and `logs/hls-sessions/*.log`.
- Current Cast constraint: Chromecast custom receiver path is intentionally pinned to AAC-in-HLS for reliability, and `source` quality maps to a Cast-safe AAC bitrate rather than source/lossless. Browser HLS may use higher/source qualities; true lossless Cast remains future fMP4 work and should not replace the stable AAC Cast path casually.

## Server Services (server/services/)
- `audioExtraction.service.ts` — ffmpeg subprocess decoding + Essentia.js WASM analysis. Smart seeking (35% into track), 15-second decode, non-ASCII filename symlink workaround, safe Essentia with individual algorithm error handling. Feature extraction optimized with **Hanning Window pre-computation** and **WASM buffer reuse**.
- `recommendation.service.ts` — Infinity Mode and Hub playlist generation using **21-dimensional** pgvector HNSW similarity search (8D acoustic + 13D MFCC) and genre hop-cost adjacency logic on MBDB. Exponential penalty formula: `distance * Math.pow(1 + hopCost, weight * curve)`. Timbre-weighted MFCC (3× for electronic/synthetic). SQL-level acousticness dealbreaker. Hard vector clamping (energy/danceability bounds). `banned_genres` full-path veto. MFCC imputation safeguard (threshold < 0.25, min 5 seeds). All `<->` parameters use explicit `::vector` casts. Hardened with `NaN` guards and cross-dimension compatibility (7D/8D).
- `llm.service.ts` — LLM integration for natural language playlist generation. Supports local providers (LM Studio, Ollama) and cloud (OpenAI). 300-genre vocabulary injection and `banned_genres` in prompt schemas. Library-scoped vocabulary logic. 120-second timeout for local LLMs.
- `genreMatrix.service.ts` — MusicBrainz hierarchical taxonomy classification using tree-path LCA (Lowest Common Ancestor) hop-cost math. 3-step pipeline: direct SQL (6 UNION ALL branches), vocabulary-guided LLM batch, KNN fallback (21D/8D). Standalone `getGenreVocabulary()` export for library-scoped vocabulary.
- `mbdb.service.ts` — High-performance streaming importer for MusicBrainz database dumps. Handles downloading, TSV extraction, and bulk PostgreSQL insertion.
- `metadata/` — Modularized external metadata service:
  - `errors.ts` — `RateLimitError`, `ProviderError` classes for typed error handling
  - `cache.ts` — Database caching with conditional `updateLastUpdated` flag
  - `rateLimiter.ts` — Semaphore class for concurrency limiting + retry logic
  - `providers/lastfm.ts` — Last.fm API client with rate limit detection
  - `providers/genius.ts` — Genius API client
  - `providers/musicbrainz.ts` — MusicBrainz API client
  - `index.ts` — Unified API (getArtistData, getAlbumImage, getGenreImage, getLyrics)

## Shared Hooks (src/hooks/)
- `useDominantColor(tracks)` — Extracts art URLs and dominant color from a track list. Returns `{ artUrls, primaryArt, bgColor }`.
- `useExternalImage(fetcher, deps)` — Generic image fetching with mounted guard. Returns `{ imageUrl, isLoading, error }`. Supports optional `debounceMs` parameter.
- `useArtistData(name, mbArtistId, options?)` — Fetches artist image/bio/metadata. Returns `{ imageUrl, bio, disambiguation, area, type, lifeSpan, links, genres, isLoading, error }`. Supports `enabled` and `debounceMs` (default 200ms) options.
- `useLlmConnectionTest({ getAuthHeader, onModelsReceived })` — LLM connection testing state + logic.
- `useSwipe(ref, { onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown, threshold })` — Reusable touch swipe gesture detection hook. Returns a ref to attach to the target element.
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
- **Audio Analysis:** essentia.js (WASM), ffmpeg (system binary), ffprobe
- **Build:** Vite, TypeScript, Tailwind CSS, tsx (TypeScript execution)
