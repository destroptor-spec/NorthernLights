# Changelog

## [Unreleased]

## [v1.0.0-rc.6] - 2026-07-14

### Audio & Playback
- **Adaptive Auto HLS ABR**: Replaced the browser `Auto` → `128 kbps` alias with source-aware adaptive AAC HLS across 64/128/160/320 kbps. One-process FFmpeg `asplit`/`var_stream_map` packaging with aligned 10-second renditions. hls.js seeds ABR from Network Information, caps to 64 kbps for Data Saver, and falls back on failure. The player signal chain shows `Auto · <active bitrate>`.
- **Cast Lossless**: Cast FLAC/WAV losslessly at Source quality; receiver passes progressive lossless through with a lossless UI badge. Receiver lossless-capability probe and raw-stream request logging added. Cast-safe AAC fallback retained for `auto`/`source` on the custom receiver path.
- **Authoritative Lossless Flag**: `music-metadata` now sets an authoritative `is_lossless` flag on tracks, replacing heuristic detection.
- **Audio Output Routing**: Route graph output through a `MediaStream` bridge on Firefox/Safari. Permission-gated device routing with `AudioContext` sink selector.
- **Loudness Normalization (EBU R128)**: Per-track EBU R128 loudness computed and stored during analysis. Per-element `GainNode` in the playback graph applies correction on track change. Library backfill via `POST /analyze/loudness`, `GET /api/loudness` read endpoint, distinct "Measuring Loudness" scan phase in the UI, and Lazy/Full/Both computation-mode switch.
- **Volume Scroll**: Adjust volume with mouse wheel on the player.
- **Cast Volume Clamp**: Receiver volume clamped on fresh session handover to prevent jarring jumps.

### Hub & Recommendations
- **Wrapped Recaps**: Generate year/season Wrapped playlists surfaced on Hub, Playlists, and Settings. Blends Last.fm/ListenBrainz listening history into recap playlists.
- **Procedural Aurora Covers**: Generative cover art for Wrapped and Hub discover mixes — three distinct discover styles, humanized engine-mix copy, full-decade numerals ("2010" not "10's"), thicker overlapping favourite curtains. Multi-color palette extracted from cover art via `useDominantColor`.
- **Hub Resume Slot**: User-configurable resume-freshness gate and last-opened-album fallback for the resume slot.
- **Hub Admin Toggles**: Admin toggles for personalized Hub rails with config-aware cache.
- **Artist Radio**: Eligibility check and adaptive radio length. Fixed missing stream/art URLs on artist radio tracks.
- **Now-Playing Source Link**: Click now-playing title to open where it's playing from (album/artist/playlist).

### Library & Metadata
- **Canonical Genre Identity**: Deterministic 0–100 duplicate scoring with connector-aware normalization, MusicBrainz path context, persistent signature-scoped dismissals, and reversible transactional grouping. Canonical identity drives genre grids, Genre Matrix coverage, KNN inputs, candidate pools, banned paths, hop costs, Infinity Mode, Hub mixes, album filters, and OpenSubsonic genre listing.
- **Library Entities Tab**: Expanded Artist Entities into Artists and Genres sub-tabs with ranked spelling-variant review, ambiguous slash-tag isolation, taxonomy-conflict preview, manual grouping, and reversible restore.
- **WMA Artwork Recovery**: Shared `sharp`-validated resolver tries every embedded ASF picture, removes malformed prefixes, reconstructs broken JPEGs, and falls back through provider chain. `tracks.artwork_version` triggers one automatic reparse for artless rows.
- **Credit Enrichment**: Background jobs with progress polling and MetadataTab progress bars. Credit-only artist detail rendering and loading-state fixes. Compilation tracks credited to real performers with name-based VA detection.
- **Artist Image Enrichment**: Batch enrichment service wired into scan, refresh, and cache-clear. Removed per-card image fetching from LibraryHome grid to reduce boot payload.
- **Self-Healing**: Unparsed tracks auto-recover on next scan; artwork decode failures are isolated per-file.

### Mobile
- **Two-Page Queue Sheet**: Queue sheet expanded to two pages with aurora bloom backdrop and Cast volume gating.
- **Now-Playing Backdrops**: Compositor-friendly backdrop morphs that scroll with page 1. Cross-fade backdrops track-to-track. Adaptive readability veil for low-contrast covers.
- **Music Video Backgrounds**: Mobile now-playing background music videos via YouTube, with vibrant mesh gradient fallback and appearance toggle.

### Music Videos
- **YouTube IFrame API**: Loader and track music video hook. Music Videos rail on artist pages. Track music video endpoint with DB index. YouTube host validation hardened.

### Playlists
- **Playlist Discovery**: Inline editing, privacy toggle, and rail-based playlist layout. Playlist discovery and privacy controls (backend + store).

### Security
- **CSP Enforcing**: Promoted Content-Security-Policy from Report-Only to enforcing. Dropped `script-src 'unsafe-inline'` in favor of sha256 hashes. Allowed Cast SDK scripts on insecure origins and service worker Google Fonts access.
- **npm Audit Fix**: Resolved 18 of 22 advisories.

### PWA & Offline
- **Adaptive HLS Offline Fallback**: Rendition-agnostic offline fallback for adaptive HLS caches — same-path cache lookup on exact-query miss so aligned AAC renditions can satisfy offline requests.
- **Stable Manifest ID**: PWA manifest id set independent of `start_url` so already-installed PWAs aren't treated as new on update.
- **Chunk Recovery**: Auto-recover from stale lazy chunks after deploy via `vite:preloadError` handler. PWA update reload prevents white screen and repeated prompts.

### Settings & Setup
- **Resumable Onboarding**: Three-step first-run flow (Account → Analysis → Library) with server-side progress independent from user existence. Interrupted installs resume after login. Model downloads use partial files and reject failed/incomplete downloads; scans defer feature analysis when models are unavailable.
- **ML Model Readiness**: Analysis gated on ML model readiness with atomic model downloads.
- **API Keys Tab**: OpenSubsonic key management moved to dedicated Settings → API Keys tab with create, rotate, revoke, delete, and disabled-service states.
- **OpenSubsonic Service Toggle**: `openSubsonicEnabled` system setting; `/rest` returns error `50` when disabled without deleting keys.
- **Subsonic Key Rotation**: `POST /api/auth/subsonic-api-keys/:id/rotate` replaces key secret in place and returns the new raw key once.

### Subsonic / OpenSubsonic
- **Scrobble Bridge**: `/rest/scrobble` now updates Aurora play history and optionally forwards to connected Last.fm/ListenBrainz providers with per-user toggle (disabled by default). Provider failures logged without failing the client request.
- **Scrobble Hardening**: Timeout + graceful soft-fail for LB/Last.fm submissions. Scrobble threshold default lowered from 95% to 50%.

### Performance
- **Lean DB Projections**: Stripped snake_case column duplicates from `mapTrackRow`. Trimmed `rawUrls` from `getAllTracks`; `decoded_path` never serialized. Index directory-prefix lookups via `decoded_path` column. Lean projection for `getAllArtists` to reduce boot payload.
- **Connection Hardening**: Capture leak-detect stack at real `connect()` call site. Bound advisory-lock wait with `SET LOCAL lock_timeout`. Restored native `pool.query` wrapping to prevent connection poisoning on DB blips.
- **Rendering**: Eliminate CLS by rendering FilterBar shape in loading states. Resolve actual scroll viewport for `VirtualizedCardGrid` to restore windowing. Compositor-friendly mobile backdrop morphs.
- **Dead Code Removal**: Removed unused theme system, dead `cn()` helper, deprecated `Semaphore` class, unused npm deps (`@tensorflow/tfjs-node`, `bottleneck`, `buffer`, `clsx`, `tailwind-merge` — 85 packages), Buffer polyfill, and `global` shims.

### UI
- **Semantic Color Tokens**: Semantic Tailwind color tokens with alpha modifier support.
- **Cover Gradient Utilities**: Extracted multi-color palette and cover gradient logic into shared modules. SoftAurora premultiplied alpha and glass opacity for cross-browser consistency.
- **Scroll Preservation**: Preserve scroll position across navigation.
- **Cast UI**: Recovery message on real launch failure, "Stop casting" label, queue stream/art URL rebuild from current token. Receiver CSP hardened with per-page script hashes.

### Infrastructure
- **Rootless Podman**: Enable rootless Podman lingering so DB container survives logout.

## [v1.0.0-rc.5] - 2026-06-10

### Architecture & Performance
- **Entity-First Client Boot**: The client no longer loads the full track list at boot. Views render from lightweight entity lists (artists/albums/genres); tracks are fetched per-entity on demand via the new `useEntityTracks` hook. `fetchLibraryFromServer` fetches entities + directories in parallel, then reconciles the restored play queue via `POST /api/library/tracks/exists`.
- **Server-Side Search**: `GET /api/library/search` runs trigram-indexed ILIKE queries (tracks, artists, albums) with per-user `is_loved`. `GlobalSearch` debounces input and aborts the prior request per keystroke. Empty query → empty result; results are capped.
- **Server-Precomputed Album Metadata**: `getAllAlbums` computes track_count, derived_year, derived_genres, derived_release_type, and art_hash server-side via a LATERAL aggregate over tracks grouped by album_id. The client's `deriveAlbumMetadata` prefers these fields and only falls back to track derivation if absent.
- **Per-Entity Track Endpoints**: `getTracksBy{Artist,Album,Genre}` accept userId for per-user is_loved. New endpoints: `GET /api/artists/:id/appears-on` (collaborations), `GET /api/playlists/:id/suggestions` (bounded candidate pool), `GET /api/library/tracks`, `GET /api/library/directories`, `POST /api/library/tracks/exists`.
- **Playlist Suggestion Pool**: `getPlaylistSuggestionPool` returns a bounded pool (≤500) of tracks sharing the playlist's artists, genres, or album-artists, ordered so shared-artist matches survive the cap. The existing client overlap-scoring then ranks the pool.
- **Gzip Compression**: Added `compression` middleware to gzip JSON/text responses, reducing the ~26MB library payload significantly. SSE streams are excluded to avoid buffering real-time scan/progress updates.
- **Slow-Query Observability**: Refactored slow-query logging to split connection-acquire time from execution time by acquiring the pool client explicitly. Reveals whether a slow query is pool pressure or SQL cost.
- **In-Memory Settings Cache**: `system_settings` and `user_settings` are read through in-memory Maps with 30s TTL and write-through on set, eliminating repeated pool round-trips. Progress-polled keys excluded.
- **Materialized View for Similar Artists**: `artist_audio_profiles` MV precomputes per-artist averaged musicnn + effnet vectors. `getSimilarArtistsByAudioProfile` reads candidates from the MV instead of re-aggregating the whole library. Refreshed after analysis batch writes features.
- **Rendering Churn Reduction**: Decomposed App shell into memoized sub-components, memoized always-mounted components, preserved artist/album filter+sort memoization across route changes, and extracted library derivations to survive route unmount. Pre-warms tab route chunks on hover/focus/pointerdown. Replaced correlated EXISTS with LEFT JOIN in playlist-track loaders.
- **Virtualized Grids**: Virtualized album/artist card grids in LibraryHome and the playlist grid with lazy-loaded thumbnails. Bumped PWA art cache maxEntries from 500 to 4000. Measurement gate on `VirtualizedCardGrid` prevents mounting hundreds of cards at once (each firing /api/art requests) when containerWidth is 0, which caused OOM on large libraries under HTTP/1.1. Fixed resize feedback loop crash.
- **DB Scaling for 100k+ Libraries**: Fetch dedup/cancellation and render churn improvements targeting large libraries.

### Library & Metadata
- **Incremental Scan**: New `art_hash` and `file_mtime` columns enable reprocessing only changed files. Art is encoded at scan time via the new `artCache` service (`sharp` moved to production deps). Hash-addressed `/api/art` endpoint serves pre-encoded AVIF cache. Content-hash art URLs and size-aware AlbumArt.
- **Album Disc Hero**: Album detail view shows a disc platter that rolls out from behind the cover. Uses Cover Art Archive "Medium" images when available (real printed disc/vinyl-label scans), falls back to a procedural vinyl label built from local cover art. Backend adds `caaGetReleaseImages`, `pickMediumImage`, `pickFrontImage`, `getRepresentativeReleaseMbid`, and `GET /api/providers/album/media-image`.
- **Taxonomy-Grouped Genre View**: Genre grid reorganized into taxonomy-grouped aurora cards when MBDB taxonomy is available.
- **Track File Size**: `file_size` stored in `tracks` and backfilled on scan; surfaced in Subsonic responses.

### Subsonic / OpenSubsonic
- **Extended Endpoints**: Implemented play queue, lyrics, similar songs, and `getUser` on the `/rest` surface.
- **Symfonium Compatibility**: `search3` query="" treated as match-all for full-library sync. `getOpenSubsonicExtensions` served without auth so Symfonium can discover apiKey auth. Fixed album list pagination, sorting, and scan status. URL-safe song IDs via base64url encoding. Subsonic client compat fixes for suffix, size, created, filters, and rate limit.
- **OpenSubsonic Service Toggle**: Admin enable/disable toggle in System settings. `openSubsonicEnabled` added to store state. `/rest` returns error `50` when disabled.
- **API Keys Tab**: Subsonic API key management moved to dedicated Settings tab with rotate and hard-delete support.
- **LLM Playlists Read-Only**: LLM-generated playlists marked read-only via Subsonic; hub refresh triggered on generation.

### Playback
- **Configurable Played Threshold**: User-configurable played threshold with fixed play/skip recording timing.
- **Wake Lock & Sleep Timer**: Screen wake lock during playback and a sleep timer with scrobble failure surfacing.
- **MediaSession Stop Action**: Added `stop` action handler to Media Session controls.
- **Autoplay Handling**: `PlaybackManager.playUrl` treats `NotAllowedError` as paused (no `nextTrack()` cascade). `onRehydrateStorage` coerces persisted 'playing' to 'paused' on reload.
- **Incidental Offline Playback**: Made incidental offline playback reliable.
- **Last.fm Signature Fix**: Use byte-order sort for Last.fm API signatures.

### UI
- **Filter UI Consolidation**: Replaced `FacetPopover` and `MobileFilterOverlay` with shared `ContextMenuPortal` (desktop popover / mobile bottom-sheet). Genre facet gains hierarchical drill-down via `GenreFacetMenu` when MBDB taxonomy is available. `QueryBuilderModal` goes fullscreen on mobile.
- **Love → Like Rename**: UI labels renamed from "love"/"favorite" to "like"/"liked" for consistency. Internal field names and Last.fm/ListenBrainz integration remain "love".
- **Shareable Playlist Links**: Public read-only snapshot links for playlists.
- **Scrobbling Tab**: Extracted Scrobbling tab from Account settings into its own section.
- **Mobile Tab Feedback**: Instant visual feedback on mobile tab taps.
- **View Transition Removal**: Removed the view transition system introduced in rc.4.

### Security
- **Rate Limiting**: Added rate limiting to all route groups; hardened invite preview endpoint.
- **Admin Auth on Mutations**: Required admin auth on library mutation endpoints.
- **HLS Path Validation**: Hardened HLS segment path validation against directory traversal.
- **Playlist Insert Cap**: Capped playlist track inserts to prevent unbounded bulk queries.

### Infrastructure
- **Container Runtime Detection**: Hardened container runtime detection with absolute path resolution. PM2/systemd often run with a minimal PATH that omits /usr/bin, causing spurious "No container runtime found". Probes common install locations with `fs.accessSync` before falling back to PATH resolution.

### Documentation
- Added `docs/library_data_loading.md` covering the entity-first boot flow, per-entity track fetching, server-side search, queue reconciliation, and the on-demand full-library cache for admin tools. Updated `architecture_overview.md` and `production_guide.md` with HTTP/2/3 reverse proxy guidance. Refreshed README with rc.4 features and high-level comparative features.

## [v1.0.0-rc.4] - 2026-05-26

### API
- **OpenSubsonic Compatibility**: Full API-key-only `/rest` surface for Subsonic clients — browsing, search, playlists, stream/download/HLS, cover art, stars, ratings, scrobbling, and compatibility stubs. Legacy u/p and token/salt auth rejected with OpenSubsonic error codes 41/42. Keys are SHA-256–hashed; the raw key is shown once at creation.
- **Subsonic Key Management**: `GET/POST/DELETE /api/auth/subsonic-api-keys` for listing, creating, and revoking Aurora-managed Subsonic API keys. Includes per-key rate limiting and last-used-at tracking.
- **Single-Playlist Endpoint**: `GET /api/playlists/:id` returns one playlist with tracks, eliminating the N+1 fetch pattern when opening a single playlist detail view.
- **Track Rating**: `setTrackRatingForUser` for Subsonic 1–5 star ratings stored in `user_playback_stats`.
- **Trigram Search Indexes**: GIN `gin_trgm_ops` indexes on `tracks(title, artist, album)` for fast Subsonic search2/search3 ILIKE queries.

### UI
- **View-Transition Morphing**: All detail pages (album, artist, playlist) now use `document.startViewTransition` + per-entity `view-transition-name` so cover art and avatars morph smoothly between list and detail views. Falls back to instant navigation on browsers without the API or when the user prefers reduced motion.
- **Hero State Skeletons**: Album, artist, and playlist detail routes receive hero placeholder data via router state, allowing them to render title, art, and metadata instantly before the store hydrates.
- **Route Prefetch**: Hover, focus, and pointer-down on album cards, artist cards, playlist cards, Hub tiles, and search results warm up the lazy-loaded detail chunk so navigation is near-instant.
- **GlobalSearch Overhaul**: Replaced inline Tailwind with named CSS classes. Added pill expansion animation, mobile full-screen overlay with 180ms slide-out close, result row hover translate, and `prefers-reduced-motion` guards.
- **Mobile Now Playing Sheet**: Deferred unmount via `data-state` (`open`/`closing`) with dedicated enter/exit keyframes so the slide-down animation completes before the DOM is removed.
- **Context Menu Cleanup**: Removed unused `showMobileHandle` prop and the drag-handle strip from mobile sheets.
- **Hub Navigation**: All Hub card, tile, and unique-collection clicks now pass hero state through `withViewTransition` for morphing cover art. Jump tiles also prefetch their target on hover/focus.
- **Subsonic API Key UI**: New "OpenSubsonic API Keys" section in Account settings to create, copy, and revoke keys with prefix display, creation date, last-used date, and revoked state.

### Performance
- **Playlist Single-Fetch**: Detail views use `fetchPlaylistFromServer(id)` to load one playlist instead of refreshing all playlists. Falls back to bulk refresh only on 404.
- **View-Transition `flushSync`**: Navigation inside `startViewTransition` callbacks uses `flushSync` to commit the DOM synchronously so the browser captures the post-navigation state for the morph.

## [v1.0.0-rc.3] - 2026-05-19

### Library
- **Facet Filters & Query Builder**: Artists and Albums now have sort, facet, and advanced query filtering with a visual query builder modal supporting AND/OR condition groups
- **Filter API**: `POST /api/filter/artists` and `/api/filter/albums` with validated SQL field references and ILIKE queries
- **GIN Trigram Indexes**: `artists(name, genres, community_tags, area)` and `albums(title, artist_name, tags)` for index-backed wildcard text search at scale
- **Merged Artist Redirects**: Merged rows preserved as redirect pointers (`merged_into` UUID column) instead of deletion, preventing re-creation on library refresh
- **Manual Artist Merge**: New "Manual merge" section in Artist Entities to merge any two artists by name with side-by-side preview cards and audit trail in `artist_duplicate_reviews`
- **Album Merge Conflict Handling**: `UNIQUE(title, artist_name)` violations now fold tracks into the survivor album instead of failing

### UI
- **SoftAurora WebGL Backdrop**: Animated aurora bands on Login and Invite Register pages via `ogl` renderer
- **Reduced Motion Toggle**: Appearance settings now offers a persistent reduced-motion preference independent of OS-level `prefers-reduced-motion`
- **Settings Modal Redesign**: Grouped nav (User/App/Server/Admin), search with auto-switch, ESC close, body scroll lock, compact layout via matchMedia
- **Settings Tabs Redesign**: Account (profile hero, password form, deletion flow), Library (coverage stats, folder rows, analysis progress), Artist Entities (overview, guide cards, review queue, manual merge), Live Music (hero toggle, overview grid, collapsible location, auto-subscribe strip)
- **Modal Accessibility**: ConfirmModal/PromptModal now have focus traps, `aria-labelledby`/`aria-describedby`, `role="dialog"`, and restore-focus-on-unmount. PromptModal supports `inputType`, `autoComplete`, `confirmLabel`
- **Filter Bar Spacing**: `.filter-zone` wrapper with consistent bottom margin (24px desktop, 18px mobile, 28px coarse-touch) to prevent layout compression
- **~2500 lines of new CSS**: Filter rack, settings panels, switch toggles, merge preview cards, live music panels, unified responsive grids

## [v1.0.0-rc.2] - 2026-05-19

### Security
- **Scoped Token Auth**: Separate `mediaAccessToken` and `sseAccessToken` JWTs (scope-limited, 7-day expiry) for HLS/Cast URLs and SSE streams — account JWT never exposed in URLs
- **Password Policy**: Minimum 12 characters enforced across all creation surfaces (register, setup, admin create, password change)
- **DB Recovery Token**: `AURORA_DB_RECOVERY_TOKEN` env var for unauthenticated database maintenance when auth cannot be verified
- **SSE Token Encoding**: All EventSource connections use `encodeURIComponent` for token parameters

### UI
- **PlayerShell**: Desktop player redesigned as a compositional floating-pill / full-width-docked slab with animated transition between modes
  - Top-edge chevron toggle (`bend`) for float ↔ dock switching
  - Signal chain chip: hover-expanding pill showing quality → codec → bitrate
  - Ticker title in float mode for long track names
  - `usePlayerPlacement` hook for responsive placement
  - 660 lines of new CSS: shell, bar-row grid, transport, volume, chain, waveform

### Cast Reliability
- Session preservation: `SESSION_ENDED` with active rejoin now stores session ID and calls `requestSessionById` instead of dropping
- Stale hydration cancellation: monotonically increasing `rejoinHydrationRunId` cancels outdated rejoin loops
- Stale media status discard: refreshes discarded when session ID changes between call and callback
- Remote-player disconnect during rejoin preserved as recovering state

## [v1.0.0-rc.1] - 2026-04-30

### Core Architecture
- Client-server music player with React + Express + PostgreSQL
- JWT authentication with per-user libraries, playlists, and recommendations
- PWA support with Workbox service worker and offline-capable caching

### Audio & Playback
- Gapless local file playback via FFmpeg-backed HLS streaming
- Google Cast (Chromecast) integration with custom CAF receiver UI
- Multi-output device selection (system default, specific speakers)
- Media Session API controls for background playback
- Prebuffering and next-track prewarm for smooth transitions

### AI Playlist Generation (Hub)
- Library-relative LLM concept compiler that interprets concepts against actual local library
- Explicit candidate pools: core, adjacent, root, acoustic, discovery, bridge
- Recovery ladder: exact → adjacent → same-root → acoustic → bridge → discovery
- Per-playlist diagnostics: pool sizes, relaxation level, diversity metrics
- Configurable tuning: Genre Cohesion, Playlist Diversity, Discovery Bias, Artist Spread

### Recommendation Engine
- 21-dimensional vector similarity: 8D acoustic + 1280D Discogs-EffNet embeddings
- pgvector HNSW indexes for fast similarity search
- Library profile layer: analyzed coverage, artist entropy, per-genre health
- Hop-cost genre math via MusicBrainz hierarchical taxonomy (~2,000 genres)
- 3-step genre pipeline: SQL match → LLM batch → KNN fallback

### Artist Management
- Normalized artist keys for variant resolution (Tiësto/Tiesto, N'to/NTO)
- Duplicate detection with manual merge/dismiss workflow
- Compound credit splitting (preserves "Nick & Jay", splits "A, B & C")
- Collaboration album surfacing (50%+ track credit = co-primary on both artist pages)

### Smart Playlists
- Daylist: time-of-day aware with bucket-based freshness
- On Repeat: listening pattern analysis
- Repeat Rewind: past favorites
- Time Capsules: seasonal/yearly rewind
- SmartHub persistence with transaction safety and advisory locking

### UI/UX
- Premium "Matte Glass" dark theme with responsive design
- Hub with crossfade animations and crossfaded tile transitions
- Queue save-as-playlist functionality
- Horizontal scroll rails with arrow navigation
- Virtualized library views for large collections
- Shared context menu primitives for mobile/desktop
- Performance-optimized: lazy routes, LRU-cached dominant colors, optimized waveform rendering

### Deployment
- One-line install script for Ubuntu/Debian
- PM2 or systemd service management
- Reverse proxy (Nginx) configuration for HTTPS
- Production guide in `docs/production_guide.md`

### Documentation
- `docs/architecture_overview.md` - System architecture diagram and component breakdown
- `docs/music_recommendation_engine.md` - Engine details and vector schema
- `docs/production_guide.md` - Deployment, environment config, troubleshooting
- `docs/API.md` - API endpoints reference
