# CLAUDE.md

## Project: Modern Web Music Player

A browser‑only music player supporting local file playback, metadata extraction/editing, playlist management, audio effects, offline mode, dark/light themes, keyboard shortcuts, state persistence, accessibility, i18n, unit tests, and PWA support. It should support all major file formats.

## Development Progress Tracker / implementation plan
Use [TASKS.md](./TASKS.md) for a detailed status of each milestone.
Update this file when changes are made, started and ended.
Be specific and thoroug so progress can be picked up easily.

## 🛠 Stability & File Editing (CRITICAL)
- **Problem:** "Error editing file" occurs due to fragile `sed` commands and immutable OS restrictions.
- **Rules:**
  1. **Read-First:** Always `cat` the target file immediately before editing to ensure exact whitespace/content match.
  2. **Safe Overwrite:** Prefer `cat << 'EOF' > filename` for small/medium files.
  3. **No Sudo:** Stay within `$HOME`. System paths are read-only.
  4. **Python Fallback:** For complex edits on large files, write and run a temporary Python script for string replacement.

## 📂 Project Structure & Data Flow
Follow this directory hierarchy strictly:
- `src/components/`: Pure UI & layout (PlayerControls, ProgressBar, Sidebar).
- `src/hooks/`: Business logic & lifecycle (useLoadLibrary, useVolumeSync).
- `src/store/`: Zustand state definitions + persistence middleware.
- `src/utils/`: Pure functions (FileSystem Access API, tag parsing, IndexedDB).
- `src/App.tsx`: Layout orchestration. `main.tsx`: Entry point.
- `docs/`: Detailed feature specs and plans

## 🏗 Coding Standards
- **State:** Use **Zustand**. Keep playback state (currentTrack, progress) in the store.
- **Audio:** Wrap `HTMLAudioElement` and `AudioContext` in a singleton or custom hook to prevent duplicate instances.
- **Storage:** Use `Dexie` or `idb-keyval` for metadata storage in IndexedDB.
- **I/O:** Use `File System Access API` for local folder scanning. Handle permission requests gracefully.
- **Types:** Interfaces for `Track`, `Metadata`, and `StoreState`. No `any`.

## 🚀 Workflow
- Always check `package.json` before installing new dependencies.
- Use `npm` for package management.
- Ensure `.env` is used for any non-public configuration.
- Use `npx vite build` to build
- Use `npx tsc --noEmit` to test
