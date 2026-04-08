# AGENTS.md

## Project: Modern Web Music Player (Aurora)

A client-server music player built with React (Frontend) and Express + PostgreSQL (Backend). Features gapless local file playback, metadata extraction, AI-driven infinite playlist generation (hop costs), audio effects, offline support, dark/light themes, keyboard shortcuts, and PWA compatibility. Support for all major audio formats.

## Development Progress Tracker / implementation plan
Use [TASKS.md](./TASKS.md) for a detailed status of each milestone.
Update this file when changes are made, started and ended.
Be specific and thorough so progress can be picked up easily.

## Versioning Schema

This project uses **Semantic Versioning (semver)** with a pre-1.0 release model:

| Format | Example | Meaning |
|--------|---------|---------|
| `major.minor.patch` | `1.0.0` | Stable release |
| `major.minor.patch-prerelease` | `1.0.0-beta.1` | Pre-release (beta, alpha, rc) |

### Current Version
- **package.json**: `version` field — currently `1.0.0-beta.1`
- **TASKS.md / MEMORY.md**: Milestones labeled as `v1.0.0-beta.1`, `v0.9.0`, `v0.8.0`, etc.

### Version Mapping (Historical Milestones)
| Milestone | Version | Description |
|-----------|---------|-------------|
| V18 | v1.0.0-beta.1 | Hierarchical MBDB Taxonomy & 21D (8D+13D) Recommendations |
| V17 | v0.9.0 | Provider Reliability & Integration Overhaul (Part 2) |
| V16 | v0.8.0 | 20D Audio Recommendation Architecture |
| V15 | v0.7.0 | Three-Phase Scanner & Worker Thread Analysis |
| V14 | v0.6.0 | Server Refactor & Real Audio Decoding |
| V13 | v0.5.0 | Mobile Optimization |
| V12 | v0.4.0 | LLM Deduplication Bug Fix & Tunable Engine Settings |
| V11 | v0.3.0 | Playlist Pinning & Hub Improvements |
| V10 | v0.2.0 | PWA & Chromecast |
| V9 | v0.1.0 | Multi-User System |
| V8–V1 | v0.0.x | Earlier milestones |

### Versioning Rules
- **Breaking changes**: Increment `major` (e.g., `1.0.0` → `2.0.0`)
- **New features (backward-compatible)**: Increment `minor` (e.g., `1.0.0` → `1.1.0`)
- **Bug fixes (backward-compatible)**: Increment `patch` (e.g., `1.0.0` → `1.0.1`)
- **Pre-releases**: Append hyphen + label (e.g., `1.0.0-beta.1`, `0.9.0-alpha.2`)
- **Pre-1.0 development**: All versions are `0.x.y` — no stability guarantee

### When Releasing a New Version
1. Update `version` in `package.json`
2. Create new entry in `MEMORY.md` with date and version tag
3. Create new entry in `TASKS.md` milestone list if it marks a significant feature
4. If pre-release, use `-beta.N`, `-alpha.N`, or `-rc.N` suffix

### Stability & File Editing (CRITICAL)
- **Read-First:** Always read the target file immediately before editing to ensure exact whitespace/content match.
- **Safe Overwrite:** Prefer `cat << 'EOF' > filename` for small/medium files.
- **No Sudo:** Stay within `$HOME`. System paths are read-only.
- **Python Fallback:** For complex edits on large files, write and run a temporary Python script for string replacement.

## Project Structure & Data Flow
Follow this directory hierarchy strictly:
- `src/components/`: Pure UI & layout (PlayerControls, ProgressBar, Sidebar, UserMenu, AdminPanel, InviteRegister, MobileMiniPlayer, MobileBottomTabs, MobileNowPlaying, GlobalSearch, SettingsModal, ConfirmModal, PromptModal).
- `src/components/library/`: Library views (AlbumDetail, GenreDetail, ArtistDetail, LibraryHome, Playlists).
- `src/components/settings/`: Modular settings tab components (AccountTab, AppearanceTab, LibraryTab, PlaybackTab, SystemTab, GenAiTab, GenreMatrixTab, DatabaseTab, AdminDashboard).
- `src/hooks/`: Custom React hooks (useLoadLibrary, useVolumeSync, useDominantColor, useExternalImage, useArtistData, useSwipe, useToast).
- `src/store/`: Zustand state definitions + persistence middleware.
- `src/utils/`: Pure utility functions (formatTime, safeBtoa, fileSystem, artistUtils, PlaybackManager, externalImagery, metadataCache).
- `src/App.tsx`: Layout orchestration. `main.tsx`: Entry point.
- `server/`: Express backend (index.ts, database/, services/, middleware/, routes/, workers/).
- `server/routes/`: Express route modules (auth.routes.ts, admin.routes.ts, library.routes.ts, playback.routes.ts, settings.routes.ts, hub.routes.ts, playlists.routes.ts, artists.routes.ts, albums.routes.ts, genres.routes.ts, media.routes.ts).
- `server/workers/`: Worker threads for CPU-intensive tasks (audioAnalysis.worker.ts, analyzeTrack.ts).
- `server/middleware/`: Auth middleware (auth.ts — JWT requireAuth + requireAdmin).
- `server/services/`: Business logic (auth.service.ts, llm.service.ts, recommendation.service.ts, audioExtraction.service.ts, genreMatrix.service.ts, etc.).
- `server/state.ts`: Shared mutable state (dbConnected, scanStatus, session history, path utilities).
- `docs/`: Detailed feature specs and plans.

### Shared Components (src/components/library/)
- `BackButton` — "Back to Library" navigation button used in detail views.
- `FadedHeroImage` — Hero background with mask fade, used in GenreDetail and ArtistDetail.
- `ArtistInitial` — Renders first character of artist name as styled fallback.
- `AlbumCard` — Album artwork card with hover play button.

### Worker Threads (server/workers/)
- `audioAnalysis.worker.ts` — Worker thread manager that spawns persistent `tsx` child processes for CPU-intensive audio analysis. Communicates via newline-delimited JSON over stdin/stdout.
- `analyzeTrack.ts` — Child process script that receives file paths via stdin, runs ffmpeg + Essentia, outputs JSON features to stdout.

**Worker Architecture:**
```
Main Thread (Express Server)
  ├── Worker 1 → spawn("tsx analyzeTrack.ts") → stdin/stdout JSON
  ├── Worker 2 → spawn("tsx analyzeTrack.ts") → stdin/stdout JSON
  ├── Worker 3 → spawn("tsx analyzeTrack.ts") → stdin/stdout JSON
  └── Worker 4 → spawn("tsx analyzeTrack.ts") → stdin/stdout JSON
```

- Concurrency controlled by `audioAnalysisCpu` setting (Background=1, Balanced=4, Maximum=6)
- Keeps main event loop responsive during batch analysis of thousands of tracks
- Handles non-ASCII filenames via temp symlinks in `/tmp/am-*/`

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
   - **Step 1: Direct SQL Match** — Exact match against MusicBrainz Genres or Aliases.
   - **Step 2: LLM Batch Processing** — Grouping unmapped tags for bulk AI translation into standard keywords.
   - **Step 3: Fallback Logic** — Artist-based deduction or KNN-based acoustic similarity mapping if no metadata exists.

**API Endpoints:**
- `POST /api/library/scan` — Full three-phase scan
- `POST /api/library/analyze` — Analysis phase only (tracks without features)
- `GET /api/library/stats` — Per-directory coverage statistics
- `GET /api/library/status` — SSE stream for real-time scan progress.
- `GET /api/library/scan/status` — SSE stream for real-time scan progress (aliased).

**Scanner UI Reactivity**:
The scanner indicator in `App.tsx` must use reactive Zustand subscriptions for `scanPhaseGlobal`, `scannedFilesGlobal`, `totalFilesGlobal`, etc., rather than `getState()` snapshots. This ensures the UI accurately reflects transition between walk, metadata, and analysis phases. Updated `server/index.ts` and `library.routes.ts` now track a `libraryChanged` flag to eliminate redundant frontend re-fetches during no-op auto-walk ticks.

## Shared Utilities (src/utils/)
- `formatTime(seconds, fallback?)` — Formats seconds as `M:SS`. Returns fallback for invalid input (default `'0:00'`).
- `safeBtoa(str)` — Base64-encodes strings that may contain multibyte characters.
- `parseArtists(raw)` — Parses artist strings from metadata (handles JSON arrays, separators).
- `fetchGenreImage(genre)`, `fetchArtistData(artist)`, `fetchAlbumImage(album, artist)` — External image lookup from `externalImagery.ts`.
- `CastManager` — Singleton Google Cast (Chromecast) manager. Handles cast context init, media loading, play/pause/seek/volume routing. Used by `PlaybackManager` to delegate controls when cast-connected.
- `PlaybackManager` — Singleton audio playback manager. Routes play/pause/seek to local `HTMLAudioElement` or `CastManager` depending on connection state.

## Server Services (server/services/)
- `audioExtraction.service.ts` — ffmpeg subprocess decoding + Essentia.js WASM analysis. Smart seeking (35% into track), 15-second decode, non-ASCII filename symlink workaround, safe Essentia with individual algorithm error handling. Feature extraction optimized with **Hanning Window pre-computation** and **WASM buffer reuse**.
- `recommendation.service.ts` — Infinity Mode and Hub playlist generation using **21-dimensional** pgvector HNSW similarity search (8D acoustic + 13D MFCC) and genre hop-cost adjacency logic on MBDB. Hardened with `NaN` guards and cross-dimension compatibility (7D/8D).
- `llm.service.ts` — LLM integration for natural language playlist generation. Supports local providers (LM Studio, Ollama) and cloud (OpenAI).
- `genreMatrix.service.ts` — LLM-assisted 3nd-gen hierarchical ontology classification using MusicBrainz tree-paths and Lowest Common Ancestor (LCA) hop-cost math.
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
- Run typecheck after every code change.
- For worker threads: Test with various filename encodings (Danish, em-dashes, apostrophes).
- Monitor memory usage during batch analysis (target < 600MB RSS).

## Key Dependencies
- **Frontend:** React, Zustand, lucide-react, idb-keyval
- **Backend:** Express, pg (PostgreSQL), music-metadata, jsonwebtoken, bcrypt
- **Audio Analysis:** essentia.js (WASM), ffmpeg (system binary), ffprobe
- **Build:** Vite, TypeScript, Tailwind CSS, tsx (TypeScript execution)
