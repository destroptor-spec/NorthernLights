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
- [x] **V9: Multi-User System**: JWT authentication, invite-based registration, admin panel, user roles (admin/user), per-user playback telemetry (`user_playback_stats`), per-user playlists, per-user Hub/Infinity Mode recommendations, per-user settings (`user_settings`).
- [x] **V10: PWA & Chromecast**: Progressive Web App support via vite-plugin-pwa, service worker registration, manifest generation. Google Cast (Chromecast) audio streaming via CastManager, integrated into PlaybackManager and PlayerControls.
- [x] **V11: Playlist Pinning & Hub Improvements**: Pin/unpin LLM playlists to protect them from Hub regeneration auto-cleanup. Pinned playlists stay visible in Hub beyond 4h and survive `deleteOldLlmPlaylists`. Database maintenance tab with orphaned playlist cleanup (respects pinned status). Disc3 fallback icon for missing artwork in Discover section.
- [x] **V12: LLM Deduplication Bug Fix & Tunable Engine Settings**: Fixed cross-playlist deduplication in `getHubCollections()` — accumulated exclusion set prevents duplicate songs across LLM playlists. Added 4 new user-tunable settings: Playlist Diversity (wander factor), Genre Blend Weight (hop cost multiplier), Tracks per Playlist, Number of LLM Playlists. Unified button styling system in `index.css` with global variant classes (`.btn-primary`, `.btn-danger`, `.btn-tab`, etc.). Fixed nav button padding asymmetry in App.tsx.
- [x] **V13: Mobile Optimization**: Complete mobile-first redesign across 8 phases. **Phase 1-2:** Player bar visibility tied to queue state (hides when queue empty). New `MobileMiniPlayer` component — edge-to-edge fixed bar with album art, artist/title, play/pause, next. Desktop floating pill preserved for `md:`+. **Phase 3:** Bottom tab navigation on mobile (Hub, Playlists, Artists, Albums, Genres + Queue/Settings buttons). Simplified mobile header (AudioWaveform icon + search/user). **Phase 4:** Safe area insets for notched devices (`viewport-fit=cover`, `env(safe-area-inset-*)`). iOS PWA meta tags. **Phase 5:** Hub card widths responsive (`w-[80vw] sm:w-[28rem]`). Keyboard hint and volume controls hidden on mobile. Touch targets enlarged (48px buttons, 64px play). **Phase 6:** Single-click to play in playlist sidebar (was double-click). Mobile reorder arrows instead of drag-and-drop. `touch-action: manipulation` globally. **Phase 7:** `useSwipe` hook — swipe left/right on mini player for next/prev with visual feedback. **Phase 8:** Full-screen `MobileNowPlaying` overlay — large album art, progress bar, full transport controls (shuffle, repeat, infinity), cast button, playlist access. Tap mini player to expand, swipe down to dismiss. **Hub fixes:** LLM playlist "Start Listening" button hidden on mobile (card tap plays). Discover cards responsive with overlapping cover art (same-size, right shadow). **Playlists fix:** Play/Pin/Delete actions moved behind three-dot context menu.

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
