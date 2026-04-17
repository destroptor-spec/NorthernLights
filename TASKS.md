# Development Progress Tracker

## Current Status
The core music player architecture has transitioned to a client-server model using Node.js and PostgreSQL. The UI has been polished with a premium "Matte Glass" aesthetic and responsive library views.

## Milestone Completion History
- [x] **v0.0.2: Core Player**: Basic playback, volume, and progress bar with persistence.
- [x] **v0.0.3: Architecture Pivot**: Node.js backend integration, SQLite persistence, and HTTP streaming.
- [x] **v0.0.7: PostgreSQL Engine**: Migrated from PGlite/SQLite to containerized PostgreSQL for crash-free reliability.
- [x] **v0.0.4: Library Management**: Artist/Album/Genre grouping and deep directory scanning.
- [x] **v0.0.5: Visual Polish**: Glassmorphism Light/Dark themes and Matte Glass background.
- [x] **v0.0.6: Deep Metadata**: Multi-artist extraction, Release Type grouping (Albums, EPs, Singles, Compilations), Universal ID3/Vorbis parsing.
- [x] **v0.0.8: AI & Playlists**: Native LLM integration, custom playlist generation, vector recommendations, drag-and-drop queues, and global context menus.
- [x] **v0.0.9: React Router Navigation**: UUID-based entity tables (artists, albums, genres), react-router-dom integration, browser history support, meaningful URLs (`/library/artist/:id`, `/library/album/:id`, `/library/genre/:id`), back/forward navigation within app.
- [x] **v0.1.0: Multi-User System**: JWT authentication, invite-based registration, admin panel, user roles (admin/user), per-user playback telemetry (`user_playback_stats`), per-user playlists, per-user Hub/Infinity Mode recommendations, per-user settings (`user_settings`).
- [x] **v0.2.0: PWA & Chromecast**: Progressive Web App support via vite-plugin-pwa, service worker registration, manifest generation. Google Cast (Chromecast) audio streaming via CastManager, integrated into PlaybackManager and PlayerControls.
- [x] **v0.3.0: Playlist Pinning & Hub Improvements**: Pin/unpin LLM playlists to protect them from Hub regeneration auto-cleanup. Pinned playlists stay visible in Hub beyond 4h and survive `deleteOldLlmPlaylists`. Database maintenance tab with orphaned playlist cleanup (respects pinned status). Disc3 fallback icon for missing artwork in Discover section.
- [x] **v0.4.0: LLM Deduplication Bug Fix & Tunable Engine Settings**: Fixed cross-playlist deduplication in `getHubCollections()` — accumulated exclusion set prevents duplicate songs across LLM playlists. Added 4 new user-tunable settings: Playlist Diversity (wander factor), Genre Blend Weight (hop cost multiplier), Tracks per Playlist, Number of LLM Playlists. Unified button styling system in `index.css` with global variant classes (`.btn-primary`, `.btn-danger`, `.btn-tab`, etc.). Fixed nav button padding asymmetry in App.tsx.
- [x] **v0.5.0: Mobile Optimization**: Complete mobile-first redesign across 8 phases. **Phase 1-2:** Player bar visibility tied to queue state (hides when queue empty). New `MobileMiniPlayer` component — edge-to-edge fixed bar with album art, artist/title, play/pause, next. Desktop floating pill preserved for `md:`+. **Phase 3:** Bottom tab navigation on mobile (Hub, Playlists, Artists, Albums, Genres + Queue/Settings buttons). Simplified mobile header (AudioWaveform icon + search/user). **Phase 4:** Safe area insets for notched devices (`viewport-fit=cover`, `env(safe-area-inset-*)`). iOS PWA meta tags. **Phase 5:** Hub card widths responsive (`w-[80vw] sm:w-[28rem]`). Keyboard hint and volume controls hidden on mobile. Touch targets enlarged (48px buttons, 64px play). **Phase 6:** Single-click to play in playlist sidebar (was double-click). Mobile reorder arrows instead of drag-and-drop. `touch-action: manipulation` globally. **Phase 7:** `useSwipe` hook — swipe left/right on mini player for next/prev with visual feedback. **Phase 8:** Full-screen `MobileNowPlaying` overlay — large album art, progress bar, full transport controls (shuffle, repeat, infinity), cast button, playlist access. Tap mini player to expand, swipe down to dismiss. **Hub fixes:** LLM playlist "Start Listening" button hidden on mobile (card tap plays). Discover cards responsive with overlapping cover art (same-size, right shadow). **Playlists fix:** Play/Pin/Delete actions moved behind three-dot context menu.
- [x] **v0.6.0: Server Refactor & Real Audio Decoding (Phase 0-1)**:
  - **Phase 0 — Server Modularization**: Split `server/index.ts` (1625 lines) into 12 route modules under `server/routes/`. Created `server/state.ts` for shared mutable state (dbConnected, scanStatus, session history, path utilities). New file structure: `auth.routes.ts`, `admin.routes.ts`, `library.routes.ts`, `playback.routes.ts`, `settings.routes.ts`, `hub.routes.ts`, `playlists.routes.ts`, `artists.routes.ts`, `albums.routes.ts`, `genres.routes.ts`, `media.routes.ts`. Slimmed `server/index.ts` to ~130 lines (app setup + router mounting).
  - **Phase 1 — Real Audio Decoding**: Replaced simulated sine-wave PCM extraction in `audioExtraction.service.ts` with real ffmpeg subprocess decoding. `ffmpeg -i <file> -t 30 -f f32le -ac 1 -ar 44100 pipe:1` decodes first 30 seconds to raw float32 PCM, which feeds into Essentia WASM for genuine audio feature extraction. Falls back gracefully to simulated data if ffmpeg unavailable or decoding fails. ffmpeg 7.1.3 confirmed installed on host.
- [x] **v0.7.0: Antigravity Context — Three-Phase Scanner & Worker Thread Analysis**:
  - **Three-Phase Scanner**: Separated library scan into distinct phases: (1) `walk` — recursive file discovery, (2) `metadata` — ID3/Vorbis tag extraction and DB storage, (3) `analysis` — ffmpeg + Essentia audio feature extraction. Analysis runs independently with `POST /api/library/analyze` endpoint and `getTracksWithoutFeatures()` to find tracks needing features.
  - **Worker Thread Architecture**: Created `server/workers/audioAnalysis.worker.ts` and `server/workers/analyzeTrack.ts` to offload CPU-intensive Essentia WASM processing from the main Node.js event loop. Worker threads spawn persistent child processes running `tsx`, communicating via newline-delimited JSON over stdin/stdout. This prevents the server from becoming unresponsive during batch analysis of thousands of tracks.
  - **Per-Directory Library Stats**: Added `GET /api/library/stats` endpoint returning `{ totalTracks, withMetadata, analyzed }` per mapped folder. Updated SettingsModal Library tab to display coverage progress bars and individual folder statistics. Stats refresh automatically after folder add/remove/rescan/analysis operations.
  - **Enhanced Audio Analysis**: Implemented smart seeking — ffmpeg now seeks to ~35% into each track (past the intro) and decodes 15 seconds for better feature accuracy in the chorus/verse section. Added `ffprobe` duration detection with fallback to file start for short tracks. Minimum buffer size validation (4096 samples) before Essentia processing to prevent WASM crashes on silent/short tracks.
  - **Safe Essentia Processing**: Wrapped each Essentia algorithm (Energy, Spectrum, DynamicComplexity, PitchSalience, Flux, ZeroCrossingRate, Danceability) in individual try-catch blocks with graceful fallback to 0. This prevents a single algorithm crash from killing the entire track analysis.
  - **Non-ASCII Filename Support**: Implemented temp symlink workaround for files with special characters (Danish `øæ`, em-dashes, apostrophes) that don't survive UTF-8 encoding in Node.js spawn args. Raw Buffer paths create symlinks in `/tmp/am-*/`, which are passed to ffmpeg and cleaned up after processing.
  - **Concurrency Control**: Connected `audioAnalysisCpu` setting (Background/Balanced/Maximum) to analysis worker pool size: 1/4/6 workers respectively. Added per-file 90-second timeout to prevent hung files from blocking the entire batch.
  - **Analysis Transparency**: Scan indicator now shows `"Artist - Title"` format instead of just filename during both metadata and analysis phases. New "Audio Analysis" section in Settings → Library with "Analyze Missing" and "Re-analyze All" buttons, plus library-wide coverage progress bar (green when 100%, amber when partial).
- [x] **v0.8.0: 20D Audio Recommendation Architecture**:
   - **Schema Update**: Extended `track_features` with `mfcc_vector VECTOR(13)` and an independent HNSW pgvector index (`track_features_mfcc_idx`).
   - **Engine Upgrades**: Modified the Recommendation Engine (`getHubCollections`, Infinity Mode, Vault, UpNext) to deploy `(tf.acoustic_vector <-> $1) + (tf.mfcc_vector <-> $2) AS distance` math uniformly.
   - **Timbre Imputation Pipeline**: Integrated LLM generated concepts (7D) with physical hardware mapping (20D) dynamically across subsets of library items.
   - **Auto-Migrator**: Added a boot-time checker inside `server/index.ts` to seamlessly identify and append older tracks lacking 13D MFCC profiles directly into the background analysis queue.
- [x] **v0.9.0: Provider Reliability & Integration Overhaul (Phase 2)**:
  - **Artist Library Lazy Loading**: Implemented IntersectionObserver-based lazy loading in `useInView` hook (200px rootMargin). Artist images load when scrolled into view.
  - **Backend Metadata Modularization**: Split `externalMetadata.service.ts` into `server/services/metadata/` with separate modules for errors, caching, rate limiting, and per-provider APIs. Fixed Semaphore bug where queued tasks never executed.
  - **Rate Limit Detection & Handling**: Last.fm error code 29 now detected and thrown as `RateLimitError`. Cache updates skipped on rate limit to allow retry later.
  - **Global Toast System**: Added toast state to Zustand store (`toasts`, `addToast`, `removeToast`). Created `useToast()` hook and `ToastContainer` rendered in `App.tsx`. SettingsModal converted to global toast.
  - **Configurable Debounce**: Added `debounceMs` option to `useArtistData` (default 200ms) and `useExternalImage` (default 0ms).
- [x] **v1.0.0-beta.1: Hierarchical Genre Taxonomy & Dynamic Hop-Cost Engine**:
  - **MusicBrainz Integration**: Implemented `mbdb.service.ts` for streaming download, extraction, and bulk insertion of MusicBrainz TSV data (genre, genre_alias, l_genre_genre).
  - **Dynamic Hop-Cost Engine**: Replaced static 39-macro-genre matrix with a path-based LCA (Lowest Common Ancestor) calculation on a `genre_tree_paths` materialized view.
  - **3-Step Categorization Pipeline**: Implemented (1) Direct SQL match, (2) LLM batch categorization with strict JSON schema, and (3) KNN/Artist fallback.
  - **Resilience & UX**: Added disk space pre-checks (statfs), LLM request timeouts (45s), backoff retry loops, and SetupWizard progress persistence (localStorage). Improved MBDB UI with skip option and real-time SSE progress.
  - **Hierarchy Optimization & Bug Fixes**: Fixed infinite loop in status tracker. Optimized recursive CTE for **Root-to-Leaf** traversal, reducing build time from hours to seconds. Added version tagging to prevent "Update available" UI stuckness.
  - **8D Vector Migration**: Upgraded recommendation engine from 7D to **8D acoustic vectors**. Implemented vector slicing in the DB layer for backward compatibility. Recommendation ranking now operates on **21 dimensions** (8D acoustic + 13D MFCC).
  - **Infrastructure Hardening**: Fixed health-check 500 errors when DB is missing. Forced IPv4 (127.0.0.1) for container stability.
  - **Settings Monolith Deconstruction**: Refactored the 1,800+ line `SettingsModal.tsx` into a modular architecture under `src/components/settings/`. Encapsulated high-frequency polling hooks to minimize re-render scope and improve overall UI responsiveness.
  - **Reactive Scanner UI Implementation**: Migrated the global scanning indicator to use reactive Zustand subscriptions, enabling real-time phase and progress updates without root-level re-render dependencies.
  - **Audio Analysis Consistency & Optimization**: Finalized the v1.0.0 audio stack with SQL-side vector stats, MFCC Hanning pre-computation, and robust NaN/dimension handling for the 21D recommendation engine.
  - **Library Removal & Orphan Cleanup Stability**: Hardened folder removal logic by implementing `purgeOrphanedTracks` (safety net for path-encoding mismatches) and `purgeOrphanedEntities` (automatic cleanup of albums/artists/genres with zero tracks). Resolved 403 Forbidden errors for art and stream caused by stale tracks referencing removed directories.
- [x] **V18.1: Genre Pipeline Hardening & Tuneable Penalty System** (2026-04-10):
  - **CTE Traversal Direction Fix**: Reversed `genre_tree_paths` materialized view CTE from entity1→entity0 to entity0→entity1 to match inverted MBDB link data. Rock, country, folk and other root genres now correctly appear in the tree.
  - **Vocabulary-Guided LLM Classification**: `categorizeSubGenres` now accepts a vocabulary array; LLM constrained to MBDB genre names. Library-scoped: < 300 genres uses actual library genres, ≥ 300 uses MBDB hierarchy. Both `generateHubConcepts` and `generateCustomPlaylist` prompts now receive vocabulary.
  - **Expanded Tier 2 SQL**: 6 UNION ALL branches with standalone genre parent fallback, GIN-indexed fuzzy matching (`%` operator), parenthesized `LIMIT 1` branches.
  - **KNN 8D Fallback**: `getGenrePathFromKNN` works with 8D-only tracks when MFCC is missing.
  - **Batch Tier 3 Feature Fetch**: Single query instead of N sequential queries.
  - **NaN/Invalid Vector Guards**: `isFinite()` checks on all vector values in both genreMatrix and database layers.
  - **Hop Cost Tiers Updated**: Deep sibling 0.05, cousin 0.20, share root 0.50, alien 2.0, unknown 2.0.
  - **Exponential Penalty Formula**: `distance * Math.pow(1 + hopCost, weight * curve)` replacing additive model.
  - **`genrePenaltyCurve` Setting**: New user slider (0-100, default 50) with live penalty preview table in PlaybackTab.
  - **Infinity Mode Multiplicative**: Switched from additive to multiplicative penalty for consistency.
  - **Negative Space Prompting**: `banned_genres` in LLM schemas — full-path veto (banning "dance" catches entire `electronic.dance.*` subtree). `genreMatrixService.getGenrePath()` exposed for path lookup.
  - **Timbre-Weighted MFCC**: 3× MFCC weight for electronic/synthetic playlists (acousticness < 0.3).
  - **MFCC Imputation Safeguard**: Strict distance threshold (< 0.25) and minimum 5 seeds. Prevents timbre poisoning from wrong-genre centroids.
  - **SQL-Level Acousticness Dealbreaker**: +5.0 distance penalty for acoustic tracks in electronic playlists.
  - **Hard Vector Clamping**: SQL WHERE-level exclusions for energy/danceability bounds. Chill playlists ban high-energy tracks; high-energy playlists ban ambient tracks.
  - **Explicit `::vector` Casts**: All 17 pgvector `<->` parameters use explicit type casts. Resolved `vector <-> numeric` operator errors.
  - **LLM Timeout**: Increased from 45s to 120s for local LLMs.
  - **Custom Playlist 8D Fix**: Vector dimension mismatch (7D→8D) resolved.
  - **Documentation Overhaul**: Updated all docs/ files to reflect 21D engine, MBDB taxonomy, and penalty system.


---

## Technical Debt & Remaining Items

### Architecture & Refactoring
- [ ] Refactor `LibraryTab.tsx` and other monolithic UI components to isolate API layers into a `features/api` structure and adopt `React.Suspense` driven fetching according to the frontend-dev-guidelines.
- [ ] **fMP4 Container Support for Lossless HLS**: Use `-f hls -hls_segment_type fmp4` for FLAC/ALAC sources to enable lossless streaming over HLS. Requires browser + Shaka fMP4 support detection. Not needed for Chromecast (AAC-in-MPEG-TS is sufficient). Also update `scanTrack.ts` to store `metadata.format.codec` over `metadata.format.container` (prefer codec) to accurately distinguish ALAC from AAC in M4A containers.

### Core Features
- [x] Create App entrypoint - wire up store initialization from IndexedDB on load
- [x] Add track duration display in playlist sidebar (MM:SS format) - DONE
- [x] Add current time display and remaining time to progress bar - DONE
- [x] Add visual feedback for keyboard shortcuts (e.g., keyboard shortcut hint)
- [ ] Implement Range Request support for transcoded WMA streams (to enable seeking)


### Enhanced Features
- [x] Album artwork display (embedded images from metadata) - DONE
- [x] Track title/artist display in main area when playing - DONE
- [x] Playback position indicator on progress bar - DONE
- [x] Volume percentage display in volume control
- [x] Library-Centric Navigation (Artists, Albums, Genres)
- [x] Responsive Drawer for mobile layouts
- [x] React Router navigation with browser back/forward support

### Theme & Aesthetics
- [x] Reactive Light/Dark mode system
- [x] Frosted Glassmorphism UI components
- [x] Matte Glass Background with Noise Texture

### Infrastructure
- [x] Node.js + Express Backend for scanning/streaming
- [x] PostgreSQL Library Database (via Podman/Docker)
- [x] Efficient Metadata Extraction (ID3/Vorbis/ASF)

### Polish & Testing
- [x] Add CSS styling for dark theme consistency - DONE
- [x] Verify persistence of playlist order across sessions - DONE
- [x] Test keyboard shortcuts work globally - DONE
- [ ] Manual testing of playback controls
- [ ] Run unit tests and add more coverage

## Verification Steps (Updated)
1. Unit tests for store actions (`togglePlay`, `setVolume`, navigation helpers). - DONE
2. Manual testing of keyboard shortcuts globally. - DONE
3. Verify progress bar seeks correctly and updates during playback. - DONE
4. Confirm playlist reordering persists across sessions. - DONE
5. Verify multi-folder library scanning and persistence. - DONE
6. Confirm seamless switching between Light and Dark glass themes. - DONE
7. Verify React Router navigation: Hub → Artists → Artist Detail → Album Detail → Back (returns to Artist Detail). - DONE
8. Browser back/forward buttons navigate within app (not away from it). - DONE
9. Refresh on `/library/artist/:id` loads the correct artist detail view. - DONE
10. Deep links work for all entity types (artist, album, genre). - DONE
11. Pin/unpin LLM playlists in Hub and Playlists view — verify immediate UI update. - DONE
12. Pinned playlists survive Hub regeneration; unpinned old ones are removed. - DONE
13. Orphaned playlist cleanup skips pinned playlists but removes them if user is deleted. - DONE
14. PWA installs and works offline (service worker precache). - DONE
15. Chromecast casting routes audio to cast device; local playback resumes when disconnected. - DONE
16. Player bar hidden when queue is empty, visible when tracks are queued. - DONE
17. Mobile: edge-to-edge mini player shows art, title, artist, play/pause, next. Desktop keeps floating pill. - DONE
18. Mobile: bottom tab bar with icons navigates to Hub, Playlists, Artists, Albums, Genres. Queue and Settings accessible. - DONE
19. Mobile: tapping mini player opens full-screen Now Playing with all controls. Swipe down to dismiss. - DONE
20. Mobile: swipe left/right on mini player skips tracks. - DONE
21. Mobile: Hub LLM playlist cards tap to play (no "Start Listening" button). Discover cards responsive. - DONE
22. Mobile: Playlists view has three-dot menu for Play/Pin/Delete actions. - DONE
23. Notched device safe area handling verified on iOS. - DONE
24. V15: Three-phase scanner shows walk → metadata → analysis progression in UI indicator. - DONE
25. V15: Per-directory stats display correctly in Settings → Library with coverage bars. - DONE
26. V15: Worker thread analysis completes without freezing the server; HTTP requests served during batch analysis. - DONE
27. V15: Non-ASCII filenames (Danish characters, em-dashes) process correctly via symlink workaround. - DONE
28. v0.7.0: Audio analysis with 35% seek + 15s decode produces meaningful feature vectors for recommendation engine. - DONE
