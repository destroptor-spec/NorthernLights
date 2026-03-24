# Development Progress Tracker

## Current Status
The core music player architecture has transitioned to a client-server model using Node.js and PostgreSQL. The UI has been polished with a premium "Matte Glass" aesthetic and responsive library views.

## Milestone Completion History
- [x] **V1: Core Player**: Basic playback, volume, and progress bar with persistence.
- [x] **V2: Architecture Pivot**: Node.js backend integration, SQLite persistence, and HTTP streaming.
- [x] **V6: PostgreSQL Engine**: Migrated from PGlite/SQLite to containerized PostgreSQL for crash-free reliability.
- [x] **V3: Library Management**: Artist/Album/Genre grouping and deep directory scanning.
- [x] **V4: Visual Polish**: Glassmorphism Light/Dark themes and Matte Glass background.
- [x] **V5: Deep Metadata**: Multi-artist extraction, Release Type grouping (Albums, EPs, Singles, Compilations), Universal ID3/Vorbis parsing.
- [x] **V7: AI & Playlists**: Native LLM integration, custom playlist generation, vector recommendations, drag-and-drop queues, and global context menus.
- [x] **V8: React Router Navigation**: UUID-based entity tables (artists, albums, genres), react-router-dom integration, browser history support, meaningful URLs (`/library/artist/:id`, `/library/album/:id`, `/library/genre/:id`), back/forward navigation within app.

---

## Technical Debt & Remaining Items

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
