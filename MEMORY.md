# Project Memory / Changelog

## [2026-03-31] V16: 20-Dimensional Dual-Vector Audio Recommendation Architecture
- **Dual-Vector Schema**: `track_features` table extended with `mfcc_vector VECTOR(13)` (nullable). Additive schema migration — existing data is preserved. Independent HNSW index (`track_features_mfcc_idx`) added for fast 13D ANN search.
- **MFCC Extraction (Essentia.js)**: `audioExtraction.service.ts` now runs `ess.MFCC(spectrum)` inside the existing `safeCall` wrapper after the 7-feature block. Each of the 13 coefficients is sigmoid-normalized to `[0,1]` (scale 20 for k=0, scale 8 for k>0). Falls back to `0.5` per coefficient if spectrum is unavailable. `AudioFeatures` interface extended with `mfcc_vector: [13 floats]`.
- **Boot-time MFCC Migrator**: `server/index.ts` fires a non-blocking IIFE 8 seconds after startup that calls `getTracksWithoutMfcc()` and runs `runBackgroundAnalysis()` at concurrency=1 to silently backfill MFCC data for previously-analyzed tracks.
- **Timbre Imputation Bridge**: LLM concepts still send 7D target vectors (token-efficient). `getHubCollections` synthesizes a `timbreCentroid` by querying the 20 nearest acoustic neighbours that have `mfcc_vector IS NOT NULL`, averaging their MFCC values. This centroid is then used as `$2` in the combined 20D query.
- **Dual-Vector Distance Math**: All 5 query sites in `recommendation.service.ts` now use `(tf.acoustic_vector <-> $1) + (tf.mfcc_vector <-> $2) AS distance` — Hub LLM playlists, Up Next (user + global fallback), The Vault (user + global fallback), and Infinity Mode relaxation loop.
- **Graceful Degradation**: Every 20D query guards with `WHERE tf.mfcc_vector IS NOT NULL`. If zero MFCC-enriched tracks exist (fresh install, pre-migration), all engines transparently fall back to 7D-only queries so recommendations continue to work immediately.
- **Weighted Decay MFCC Centroid (Infinity Mode)**: Infinity Mode computes a parallel 13D weighted-decay centroid (lambda=0.8) matching the existing 7D centroid logic, so timbre drift tracking follows the same momentum model as the acoustic vector.

## [2026-03-31] V15: Antigravity Context — Three-Phase Scanner & Worker Thread Analysis
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

## [2026-03-29] LLM Deduplication Fix, Tunable Settings & Button Unification
- **LLM Playlist Deduplication Bug Fix**: Fixed `getHubCollections()` in `recommendation.service.ts` where 5 LLM playlists could contain identical songs. Root cause: each concept queried the database independently with no shared exclusion set. Fix accumulates an exclusion set of already-assigned track IDs across the concept loop, with a `WHERE t.id NOT IN (...)` clause.
- **New Tunable Settings**: Added 4 user-facing settings to the Playback tab (LLM Playlists sub-tab):
  - *Playlist Diversity* (0–100%): Wander factor — weighted randomization vs deterministic top-N selection.
  - *Genre Blend Weight* (0–100%): Hop cost multiplier replacing the hardcoded `0.5` value.
  - *Tracks per Playlist* (5/10/15/20): Configurable playlist length.
  - *Number of Playlists* (2/3/5): How many LLM concepts to generate per cycle.
- **LLM Prompt Improvement**: Added diversity instruction to the LLM prompt (`generateHubConcepts`) to enforce distinct acoustic profiles between concepts.
- **Unified Button System**: Replaced 27+ inline Tailwind button strings in SettingsModal.tsx with global CSS classes in `index.css`. New variant system: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-danger-fill`, `.btn-ghost`, `.btn-lg`, `.btn-sm`, `.btn-tab`, `.btn-dashed`, `.btn-icon`. Removed old `.btn-small`, `.remove-btn`, `.icon-btn`.
- **Nav Button Fix**: Fixed asymmetric padding on Hub/Playlists/Artists/Albums/Genres navigation buttons caused by `pb-0` on the container.

## [2026-03-23] AI Playlists, Queue Architecture & System Resilience
- **Database Resilience**: App now boots even if PostgreSQL is unreachable, displaying a full-page graceful error UI that polls for health recovery.
- **Robust LLM Integration**: Rewrote `llm.service` response parsing to handle unpredictable local LLM outputs (LM Studio, Ollama). SetupWizard now includes a dedicated LLM configuration step with token usage estimation and live connection testing. Added manual custom playlist generation via a prompt modal.
- **Recommendation Engine Upgrades**: Engine-driven playlists now use advanced math:
  - *Up Next & The Vault*: Re-ranked using a custom `reRankByHopCost` blending acoustic vector distance with a pre-calculated genre adjacency matrix.
  - *Jump Back In*: Replaced a broken rating system with a Heat Score calculation (`playCount × quadratic time decay`).
- **Global Track Context Menu**: Engineered a React Portal-based context menu (`TrackContextMenu`) accessible via a `⋯` button anywhere a track is rendered (Album, Search, Queue). Supports "Play Next" and "Add to Playlist" globally.
- **Drag-and-Drop Play Queue**: Refactored the `PlaylistSidebar` to support smooth drag-and-drop track reordering with visual drop indicators, hover drag handles, and transparent drag ghosts.

## [2026-03-13] Glassy UI Phase 2 & Audio Waveforms
- **Waveform Progress Bar**: Implemented a canvas-based `WaveformProgressBar` using the Web Audio API to decode audio files on-the-fly and render amplitude peaks as interactive bars.
- **Glassy Design System**: Refined the theme with a "premium glass" aesthetic:
  - **Player Controls**: Dark-on-light (light mode) and white-on-dark (dark mode) frosted glass buttons with purple gradient accents.
  - **Tab Navigation**: Replaced underlines with glassy pill buttons featuring glow effects and hover states.
- **Unified Album Display**: Created a shared `AlbumCard` component with a fade-in play overlay. Standardized album displays across `LibraryHome`, `ArtistDetail`, and `GenreDetail`.
- **Artist Credits**: Added "Also Appears On" logic to the Artist Detail view to surface guest features separate from primary releases.
- **Light Mode Parity**: Optimized all new glassy components for visibility and accessibility in Light Mode using theme-aware CSS variables.

## [2026-03-12] Security, Integrations & Onboarding
- **External Imagery APIs**: Integrated Last.fm and Genius APIs to fetch artist bios, fallback album art, and artist hero images dynamically on the frontend with caching.
- **Backend Security**: Implemented path traversal sanitization and Express Basic Authentication middleware (`requireAuth`) to safely host the application on the public web.
- **First-Time Setup Wizard**: Built a glassmorphic onboarding UI (`SetupWizard.tsx`) that bypasses auth on the very first boot to dynamically write admin credentials to the server's `.env` file natively.
- **Basic Auth URL Params**: Restructured frontend streaming and image rendering to append a base64 encoded auth `?token=` parameter to bypass stringent browser subresource credential stripping.


## [2026-03-12] UI Polish & Background Refactor
- **Matte Glass Background**: Replaced resource-heavy `HeroWave` canvas with a CSS-based Matte Glass background.
  - Implemented multi-point radial gradients on the `body` selector.
  - Added a `noise.svg` turbulence filter overlay for a textured "matte" finish.
- **Glassmorphism Reversion**: Completely removed "Brutalist Editorial" styling.
  - Restored rounded corners (`2xl`), soft shadows, and `backdrop-blur` across all components.
  - Simplified typography to standard sentence-cased font weights.

## [2026-03-11] Library-Centric Architecture (The Big Shift)
- **Backend Infrastructure**: Launched Node.js + Express server to handle file system operations.
  - Integrated SQLite for library persistence.
  - Implemented `/api/library` and `/api/stream` endpoints.
- **Navigation System**: Created a library-first UI with tabs for Artists, Albums, and Genres.
  - Added `AlbumDetail`, `ArtistDetail`, and `GenreDetail` sub-views.
- **Theme System**: Implemented Tailwind-based dark mode (`.dark`) with persistent user preference in Zustand.

## [2026-03-10] Core Player & Audio Engine
- **PlaybackManager**: Developed a singleton class for consistent audio handling.
- **Zustand Store**: Reorganized state to handle playlists, volume, and scanning states.
- **UI Base**: Implemented `PlayerControls`, `ProgressBar`, and `PlaylistSidebar`.
- **Keyboard Shortcuts**: Added global listeners for spacebar, arrows, and volume control.
