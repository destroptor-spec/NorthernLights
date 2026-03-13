# Project Memory / Changelog

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
