# AGENTS.md

## Project: Modern Web Music Player (Aurora)

A client-server music player built with React (Frontend) and Express + PostgreSQL (Backend). Features gapless local file playback, metadata extraction, AI-driven infinite playlist generation (hop costs), audio effects, offline support, dark/light themes, keyboard shortcuts, and PWA compatibility. Support for all major audio formats.

## Development Progress Tracker / implementation plan
Use [TASKS.md](./TASKS.md) for a detailed status of each milestone.
Update this file when changes are made, started and ended.
Be specific and thorough so progress can be picked up easily.

## Stability & File Editing (CRITICAL)
- **Read-First:** Always read the target file immediately before editing to ensure exact whitespace/content match.
- **Safe Overwrite:** Prefer `cat << 'EOF' > filename` for small/medium files.
- **No Sudo:** Stay within `$HOME`. System paths are read-only.
- **Python Fallback:** For complex edits on large files, write and run a temporary Python script for string replacement.

## Project Structure & Data Flow
Follow this directory hierarchy strictly:
- `src/components/`: Pure UI & layout (PlayerControls, ProgressBar, Sidebar, UserMenu, AdminPanel, InviteRegister).
- `src/components/library/`: Library views (AlbumDetail, GenreDetail, ArtistDetail, LibraryHome, Playlists).
- `src/hooks/`: Custom React hooks (useLoadLibrary, useVolumeSync, useDominantColor, useExternalImage, useLlmConnectionTest).
- `src/store/`: Zustand state definitions + persistence middleware.
- `src/utils/`: Pure utility functions (formatTime, safeBtoa, fileSystem, artistUtils, PlaybackManager, externalImagery, metadataCache).
- `src/App.tsx`: Layout orchestration. `main.tsx`: Entry point.
- `server/`: Express backend (index.ts, database/, services/, middleware/).
- `server/middleware/`: Auth middleware (auth.ts — JWT requireAuth + requireAdmin).
- `server/services/`: Business logic (auth.service.ts, llm.service.ts, recommendation.service.ts, etc.).
- `docs/`: Detailed feature specs and plans.

### Shared Components (src/components/library/)
- `BackButton` — "Back to Library" navigation button used in detail views.
- `FadedHeroImage` — Hero background with mask fade, used in GenreDetail and ArtistDetail.
- `ArtistInitial` — Renders first character of artist name as styled fallback.
- `AlbumCard` — Album artwork card with hover play button.

## Coding Standards
- **State:** Use **Zustand**. Keep playback state (currentTrack, progress) in the store.
- **Audio:** Wrap `HTMLAudioElement` and `AudioContext` in a singleton or custom hook to prevent duplicate instances.
- **Storage:** Frontend uses `idb-keyval` for configs. Backend uses **PostgreSQL** (`pg` driver) for library management and vector embeddings.
- **I/O:** Use Node.js `fs` streams and `music-metadata` for safe raw-byte extraction directly. Handle encoding explicitly.
- **Types:** Interfaces for `Track`, `Metadata`, and `StoreState`. Avoid `any`.
- **Icons:** Use `lucide-react` for all icons. Do not add new inline SVGs unless no lucide equivalent exists.
- **Styling:** Use Tailwind CSS classes. Extract repeated class strings to CSS classes in `index.css`. Use CSS custom properties for shared design tokens (colors, gradients, shadows).
- **Custom Hooks:** Extract repeated `useState` + `useEffect` patterns into hooks under `src/hooks/`.
- **Utility Functions:** Extract pure logic (formatting, encoding) to `src/utils/` and import rather than duplicating.

## Shared Utilities (src/utils/)
- `formatTime(seconds, fallback?)` — Formats seconds as `M:SS`. Returns fallback for invalid input (default `'0:00'`).
- `safeBtoa(str)` — Base64-encodes strings that may contain multibyte characters.
- `parseArtists(raw)` — Parses artist strings from metadata (handles JSON arrays, separators).
- `fetchGenreImage(genre)`, `fetchArtistData(artist)`, `fetchAlbumImage(album, artist)` — External image lookup from `externalImagery.ts`.

## Shared Hooks (src/hooks/)
- `useDominantColor(tracks)` — Extracts art URLs and dominant color from a track list. Returns `{ artUrls, primaryArt, bgColor }`.
- `useExternalImage(fetcher, deps)` — Generic image fetching with mounted guard. Returns `string | undefined`.
- `useLlmConnectionTest({ getAuthHeader, onModelsReceived })` — LLM connection testing state + logic.

## Workflow
- Always check `package.json` before installing new dependencies.
- Use `npm` for package management.
- Ensure `.env` is used for any non-public configuration.
- Use `npx vite build` to build.
- Use `npx tsc --noEmit` to typecheck.
- Run typecheck after every code change.

## Key Dependencies
- **Frontend:** React, Zustand, lucide-react, color-thief-react, idb-keyval
- **Backend:** Express, pg (PostgreSQL), music-metadata, jsonwebtoken, bcrypt
- **Build:** Vite, TypeScript, Tailwind CSS
