# Project Memory / Changelog

## [2026-04-10] V1.0.0-beta.2: Genre Pipeline Hardening & Tuneable Penalty System
- **CTE Traversal Direction Fix**: Discovered and fixed inverted MBDB link data. `genre_tree_paths` CTE reversed from entity1→entity0 to entity0→entity1. Rock, country, folk and other root genres now appear in the materialized view (1544→1651 rows).
- **Vocabulary-Guided LLM**: All LLM prompts (Genre Matrix, Hub, Custom Playlist) now receive a 300-genre vocabulary from MBDB. Library-scoped: < 300 library genres returns actual library genres; ≥ 300 returns top 300 from MBDB hierarchy. Eliminated 91%→100% LLM failure rate.
- **Expanded Tier 2 SQL**: 6 UNION ALL branches with standalone genre parent fallback (`COALESCE(gtp.path, parent.name || '.' || g.name)`), GIN-indexed fuzzy matching (`%` operator), proper parentheses on `LIMIT 1` branches.
- **KNN 8D Fallback**: `getGenrePathFromKNN` now works with tracks missing MFCC data via 8D-only neighbor search.
- **Batch Tier 3**: Single feature fetch query replacing N sequential queries for KNN timbre fallback.
- **Hop Cost Tiers**: Deep sibling 0.05, cousin 0.20, share root 0.50, alien 2.0, unknown 2.0. Unknown genres get same penalty as alien hops.
- **Exponential Penalty Formula**: Replaced additive `distance + hopCost * weight` with multiplicative `distance * Math.pow(1 + hopCost, weight * curve)`. Wrong-genre tracks must be 2×+ closer acoustically to overcome penalty.
- **`genrePenaltyCurve` Setting**: New user slider (0-100, default 50) with live penalty preview table showing multipliers for each hop tier. Controls curve exponent from 0.5 to 2.0.
- **Infinity Mode Multiplicative**: Switched from additive to multiplicative penalty for consistency with Hub playlists.
- **Negative Space Prompting**: `banned_genres` in LLM prompt schemas. Tracks matching banned genres get `combined: Infinity` — absolute veto regardless of acoustic proximity.
- **Timbre-Weighted MFCC**: 3× MFCC weight in SQL for electronic/synthetic playlists (target acousticness < 0.3). Prioritizes instrument texture over rhythm.
- **SQL-Level Acousticness Dealbreaker**: `CASE WHEN $3::real < 0.2 AND (tf.acoustic_vector_8d::text::real[])[6] > 0.5 THEN 5.0 ELSE 0 END`. Acoustic tracks get +5.0 distance spike in electronic playlists.
- **Bug Fixes**: LLM timeout 45s→120s; custom playlist 7D→8D vector fix; `DISTINCT ON` ordering for vocabulary SQL; `LIMIT 1` parentheses in UNION ALL branches.

## [2026-04-08] v1.0.0-beta.1: Hierarchical Genre Taxonomy & 21D Recommendation Engine
- **Hierarchical Genre Migration**: Successfully replaced the static 39-macro-genre matrix with a dynamic hierarchy imported from **MusicBrainz** (~2,000 genres).
- **Materialized Tree Paths & CTE Optimization**: Created `genre_tree_paths` view using recursive CTEs. Optimized for **Root-to-Leaf** traversal, reducing generation from 38+ minutes to under 5 seconds. Fixed "stuck" status loop bug.
- **Dynamic Hop-Cost Calculation**: Replaced the matrix lookup with path-based LCA (Lowest Common Ancestor) distance math.
- **MusicBrainz High-Performance Importer**: `mbdb.service.ts` implements streaming download + extraction (`tar -xjf`) + bulk insertion of TSV data. Now records version `tag` for accurate update checking.
- **3-Step Categorization Pipeline**:
  - **SQL Match**: Direct identifier/alias lookup in MBDB.
  - **LLM Batch**: Grouped tag categorization (20 tags/batch) with strict array validation.
  - **KNN Fallback**: Weighted timbre/acoustic similarity mapping if no metadata is available.
- **8D Acoustic Vector Upgrade**: Migrated audio analysis from 7D to **8D acoustic vectors**. Recommendation ranking now uses **21 dimensions** (8D acoustic + 13D MFCC timbre).
- **Audio Analysis Hardening & Performance Audit**:
  - **SQL-Side Statistics**: Migrated `getVectorStats` to SQL-based `AVG`/`STDDEV` calculation, eliminating massive JS JSON-parsing overhead.
  - **MFCC Performance**: Pre-computed Hanning window coefficients and implemented buffer reuse, eliminating millions of redundant trig calls.
  - **NaN & Dimension Guards**: Hardened recommendation engine with `NaN` guards and vector slicing for seamless 7D/8D interoperability.
  - **is_simulated**: Added persistence for tracks analyzed with fake PCM (when ffmpeg missing) to enable future re-analysis.
  - **UX/UI**: Added phase-aware status indicators to analysis guards and scanner indicators.
- **Backward Compatibility**: Implemented vector slicing in `database/index.ts` to maintain legacy 7D data support while populating the new 8D `acoustic_vector_8d` column.
- **Resilience & Infrastructure Hardening**: Added disk space pre-checks (statfs for /tmp), fixed health-check 500 crashes during DB downtime, and stabilized container connectivity with forced IPv4 (127.0.0.1).
- **Library Removal Stability**: Implemented `purgeOrphanedTracks` and `purgeOrphanedEntities` in `database/index.ts`. This ensures that when a folder is removed, not only are the tracks deleted (with a safety net for path-encoding mismatches), but the associated albums, artists, and genres with zero remaining tracks are also purged, preventing "ghost" entries in the UI. Fixed 403 Forbidden errors for cover art and streaming on tracks orphaned by manual directory removal.
- **UI/UX Polishing**:
  - **SetupWizard Stability**: Added `localStorage` persistence for current setup step. Added "Skip MBDB Import" option to Step 3.

  - **Modular Settings Architecture**: Deconstructed monolithic `SettingsModal.tsx` into domain-specific components under `src/components/settings/` (Account, Appearance, Library, Playback, System, GenAi, GenreMatrix, Database).
  - **Settings Performance**: Encapsulated polling hooks for Genre Matrix and MBDB status within their respective tabs to eliminate root-level re-render overhead when the modal is closed.
  - **Reactive Scanner UI**: Fixed `App.tsx` scanning indicator to use reactive Zustand subscriptions for `scanPhase` and progress counts, ensuring smooth visual transitions across walk/metadata/analysis phases.
  - **Accessibility & UI Hardening**: Standardized settings navigation with semantic ARIA tab roles. Fixed transparency and styling issues in light mode for all modal components (Prompt, Confirm, DatabaseControl).

## [2026-04-03] v0.9.0: Provider Reliability & Integration Overhaul (Part 2)
- **Artist Library Lazy Loading Fix**: Artist images now load on scroll via IntersectionObserver (`useInView` hook with 200px rootMargin). Added 200ms debounce in `useArtistData` to prevent API storms during rapid scrolling.
- **Backend Modularization**: Split monolithic `externalMetadata.service.ts` into `server/services/metadata/` directory:
  - `errors.ts` — `RateLimitError` and `ProviderError` classes with type guards
  - `cache.ts` — DB caching with `updateLastUpdated` flag (skips cache update on rate limit)
  - `rateLimiter.ts` — Semaphore class + retry logic
  - `providers/lastfm.ts`, `genius.ts`, `musicbrainz.ts` — separate API clients with proper error handling
  - `index.ts` — unified API with error propagation
- **Semaphore Bug Fix**: Fixed critical bug in concurrency limiter where queued tasks never executed. `release()` now properly calls pending resolve functions.
- **Global Toast System**: Added `toasts`, `addToast`, `removeToast` to Zustand store. Created `useToast()` hook and `ToastContainer` component rendered in `App.tsx`. SettingsModal now uses global toast instead of local state.
- **Configurable Debounce**: Added `debounceMs` option to `useArtistData` (default 200ms) and `useExternalImage` (default 0ms).
- **Dual-Vector Schema**: `track_features` table extended with `mfcc_vector VECTOR(13)` (nullable). Additive schema migration — existing data is preserved. Independent HNSW index (`track_features_mfcc_idx`) added for fast 13D ANN search.
- **MFCC Extraction (Essentia.js)**: `audioExtraction.service.ts` now runs `ess.MFCC(spectrum)` inside the existing `safeCall` wrapper after the 7-feature block. Each of the 13 coefficients is sigmoid-normalized to `[0,1]` (scale 20 for k=0, scale 8 for k>0). Falls back to `0.5` per coefficient if spectrum is unavailable. `AudioFeatures` interface extended with `mfcc_vector: [13 floats]`.
- **Boot-time MFCC Migrator**: `server/index.ts` fires a non-blocking IIFE 8 seconds after startup that calls `getTracksWithoutMfcc()` and runs `runBackgroundAnalysis()` at concurrency=1 to silently backfill MFCC data for previously-analyzed tracks.
- **Timbre Imputation Bridge**: LLM concepts still send 7D target vectors (token-efficient). `getHubCollections` synthesizes a `timbreCentroid` by querying the 20 nearest acoustic neighbours that have `mfcc_vector IS NOT NULL`, averaging their MFCC values. This centroid is then used as `$2` in the combined 20D query.
- **Dual-Vector Distance Math**: All 5 query sites in `recommendation.service.ts` now use `(tf.acoustic_vector <-> $1) + (tf.mfcc_vector <-> $2) AS distance` — Hub LLM playlists, Up Next (user + global fallback), The Vault (user + global fallback), and Infinity Mode relaxation loop.
- **Graceful Degradation**: Every 20D query guards with `WHERE tf.mfcc_vector IS NOT NULL`. If zero MFCC-enriched tracks exist (fresh install, pre-migration), all engines transparently fall back to 7D-only queries so recommendations continue to work immediately.
- **Weighted Decay MFCC Centroid (Infinity Mode)**: Infinity Mode computes a parallel 13D weighted-decay centroid (lambda=0.8) matching the existing 7D centroid logic, so timbre drift tracking follows the same momentum model as the acoustic vector.

## [2026-03-31] v0.7.0: Antigravity Context — Three-Phase Scanner & Worker Thread Analysis
- **Server Modularization (Phase 0)**: Split monolithic `server/index.ts` (1625 lines) into 12 route modules under `server/routes/`. Created `server/state.ts` for shared mutable state. New structure: auth, admin, library, playback, settings, hub, playlists, artists, albums, genres, media routes.
- **Real Audio Decoding (Phase 1)**: Replaced simulated Essentia data with actual ffmpeg subprocess decoding. Implemented smart seeking: ffmpeg seeks to ~35% into track (past intro) and decodes 15 seconds for representative chorus/verse analysis. Added `ffprobe` duration detection with fallback to file start.
- **Three-Phase Scanner Architecture**: Separated library scan into distinct phases:
  - *Phase 1 (Walk)*: Recursive directory traversal collecting audio paths
  - *Phase 2 (Metadata)*: Parallel ID3/Vorbis tag extraction and DB storage
  - *Phase 3 (Analysis)*: ffmpeg + Essentia audio feature extraction via worker threads
- **Worker Thread Implementation**: Created `server/workers/audioAnalysis.worker.ts` and `server/workers/analyzeTrack.ts` to offload CPU-intensive Essentia WASM processing from main thread. Workers spawn persistent `tsx` child processes communicating via newline-delimited JSON over stdin/stdout. Prevents server unresponsiveness during batch analysis.
- **Non-ASCII Filename Support**: Implemented temp symlink workaround for files with special characters (Danish `øæ`, em-dashes, curly quotes). Raw Buffer paths create symlinks in `/tmp/am-*/`, passed to ffmpeg, cleaned up after processing. Solves Node.js spawn UTF-8 encoding limitations.
- **Safe Essentia Processing**: Wrapped each Essentia algorithm (Energy, Spectrum, DynamicComplexity, PitchSalience, Flux, ZeroCrossingRate, Danceability) in individual try-catch blocks with graceful fallback to 0. Prevents single algorithm crash from killing entire track analysis.
- **Per-Directory Library Stats**: Added `GET /api/library/stats` endpoint returning `{ totalTracks, withMetadata, analyzed }` per mapped folder. Updated SettingsModal Library tab with coverage progress bars and real-time stats refresh after folder operations.
- **Concurrency Control**: Connected `audioAnalysisCpu` setting (Background=1, Balanced=4, Maximum=6 workers) to analysis worker pool size. Added per-file 90-second timeout to prevent hung files from blocking batch.
- **Scan Status Improvements**: Metadata and analysis phases now show `"Artist - Title"` format in scanning indicator instead of just filename. Added new "Audio Analysis" section in Settings → Library with "Analyze Missing" and "Re-analyze All" buttons plus library-wide coverage progress bar.

## [2026-03-29] v0.6.0: LLM Deduplication Fix, Tunable Settings & Button Unification
- **LLM Playlist Deduplication Bug Fix**: Fixed `getHubCollections()` in `recommendation.service.ts` where 5 LLM playlists could contain identical songs. Root cause: each concept queried the database independently with no shared exclusion set. Fix accumulates an exclusion set of already-assigned track IDs across the concept loop, with a `WHERE t.id NOT IN (...)` clause.
- **New Tunable Settings**: Added 4 user-facing settings to the Playback tab (LLM Playlists sub-tab):
  - *Playlist Diversity* (0–100%): Wander factor — weighted randomization vs deterministic top-N selection.
  - *Genre Blend Weight* (0–100%): Hop cost multiplier replacing the hardcoded `0.5` value.
  - *Tracks per Playlist* (5/10/15/20): Configurable playlist length.
  - *Number of Playlists* (2/3/5): How many LLM concepts to generate per cycle.
- **LLM Prompt Improvement**: Added diversity instruction to the LLM prompt (`generateHubConcepts`) to enforce distinct acoustic profiles between concepts.
- **Unified Button System**: Replaced 27+ inline Tailwind button strings in SettingsModal.tsx with global CSS classes in `index.css`. New variant system: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-danger-fill`, `.btn-ghost`, `.btn-lg`, `.btn-sm`, `.btn-tab`, `.btn-dashed`, `.btn-icon`. Removed old `.btn-small`, `.remove-btn`, `.icon-btn`.
- **Nav Button Fix**: Fixed asymmetric padding on Hub/Playlists/Artists/Albums/Genres navigation buttons caused by `pb-0` on the container.

## [2026-03-23] v0.5.0: AI Playlists, Queue Architecture & System Resilience
- **Database Resilience**: App now boots even if PostgreSQL is unreachable, displaying a full-page graceful error UI that polls for health recovery.
- **Robust LLM Integration**: Rewrote `llm.service` response parsing to handle unpredictable local LLM outputs (LM Studio, Ollama). SetupWizard now includes a dedicated LLM configuration step with token usage estimation and live connection testing. Added manual custom playlist generation via a prompt modal.
- **Recommendation Engine Upgrades**: Engine-driven playlists now use advanced math:
  - *Up Next & The Vault*: Re-ranked using a custom `reRankByHopCost` blending acoustic vector distance with a pre-calculated genre adjacency matrix.
  - *Jump Back In*: Replaced a broken rating system with a Heat Score calculation (`playCount × quadratic time decay`).
- **Global Track Context Menu**: Engineered a React Portal-based context menu (`TrackContextMenu`) accessible via a `⋯` button anywhere a track is rendered (Album, Search, Queue). Supports "Play Next" and "Add to Playlist" globally.
- **Drag-and-Drop Play Queue**: Refactored the `PlaylistSidebar` to support smooth drag-and-drop track reordering with visual drop indicators, hover drag handles, and transparent drag ghosts.

## [2026-03-13] v0.4.0: Glassy UI Phase 2 & Audio Waveforms
- **Waveform Progress Bar**: Implemented a canvas-based `WaveformProgressBar` using the Web Audio API to decode audio files on-the-fly and render amplitude peaks as interactive bars.
- **Glassy Design System**: Refined the theme with a "premium glass" aesthetic:
  - **Player Controls**: Dark-on-light (light mode) and white-on-dark (dark mode) frosted glass buttons with purple gradient accents.
  - **Tab Navigation**: Replaced underlines with glassy pill buttons featuring glow effects and hover states.
- **Unified Album Display**: Created a shared `AlbumCard` component with a fade-in play overlay. Standardized album displays across `LibraryHome`, `ArtistDetail`, and `GenreDetail`.
- **Artist Credits**: Added "Also Appears On" logic to the Artist Detail view to surface guest features separate from primary releases.
- **Light Mode Parity**: Optimized all new glassy components for visibility and accessibility in Light Mode using theme-aware CSS variables.

## [2026-03-12] v0.3.0: Security, Integrations & Onboarding
- **External Imagery APIs**: Integrated Last.fm and Genius APIs to fetch artist bios, fallback album art, and artist hero images dynamically on the frontend with caching.
- **Backend Security**: Implemented path traversal sanitization and Express Basic Authentication middleware (`requireAuth`) to safely host the application on the public web.
- **First-Time Setup Wizard**: Built a glassmorphic onboarding UI (`SetupWizard.tsx`) that bypasses auth on the very first boot to dynamically write admin credentials to the server's `.env` file natively.
- **Basic Auth URL Params**: Restructured frontend streaming and image rendering to append a base64 encoded auth `?token=` parameter to bypass stringent browser subresource credential stripping.


## [2026-03-12] v0.2.0: UI Polish & Background Refactor
- **Matte Glass Background**: Replaced resource-heavy `HeroWave` canvas with a CSS-based Matte Glass background.
  - Implemented multi-point radial gradients on the `body` selector.
  - Added a `noise.svg` turbulence filter overlay for a textured "matte" finish.
- **Glassmorphism Reversion**: Completely removed "Brutalist Editorial" styling.
  - Restored rounded corners (`2xl`), soft shadows, and `backdrop-blur` across all components.
  - Simplified typography to standard sentence-cased font weights.

## [2026-03-11] v0.1.0: Library-Centric Architecture (The Big Shift)
- **Backend Infrastructure**: Launched Node.js + Express server to handle file system operations.
  - Integrated SQLite for library persistence.
  - Implemented `/api/library` and `/api/stream` endpoints.
- **Navigation System**: Created a library-first UI with tabs for Artists, Albums, and Genres.
  - Added `AlbumDetail`, `ArtistDetail`, and `GenreDetail` sub-views.
- **Theme System**: Implemented Tailwind-based dark mode (`.dark`) with persistent user preference in Zustand.

## [2026-03-10] v0.0.1: Core Player & Audio Engine
- **PlaybackManager**: Developed a singleton class for consistent audio handling.
- **Zustand Store**: Reorganized state to handle playlists, volume, and scanning states.
- **UI Base**: Implemented `PlayerControls`, `ProgressBar`, and `PlaylistSidebar`.
- **Keyboard Shortcuts**: Added global listeners for spacebar, arrows, and volume control.
