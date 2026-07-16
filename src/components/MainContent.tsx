import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { usePlayerStore } from '../store/index';
import { usePlayerPlacement } from '../hooks/usePlayerPlacement';
import { useScrollRestoration } from '../hooks/useScrollRestoration';
import { AlbumDetail, ArtistDetail, PlaylistDetail, LibraryHome, Hub, Playlists, SearchResultsPage } from '../utils/routePrefetch';

const GenreDetail = React.lazy(() => import('./library/GenreDetail').then(module => ({ default: module.GenreDetail })));
// Exported so App's logged-out invite gate and the routes below share one chunk.
export const InviteRegister = React.lazy(() => import('./InviteRegister').then(module => ({ default: module.InviteRegister })));

const RouteFallback: React.FC = () => (
  <div className="page-container">
    {/* Filter-toolbar-shaped placeholder (~80px footprint, matching FilterBar's
        ~56px rack + 24px margin) so the grid sits at the same Y as the real
        library views — avoids the layout shift when this fallback is replaced.
        A neutral row of pills is also harmless for the non-library lazy routes. */}
    <div className="flex gap-2 py-2.5 mb-6">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-9 w-10 rounded-xl bg-[var(--color-surface-variant)] animate-pulse" />
      ))}
    </div>
    <div className="album-grid">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex flex-col animate-pulse">
          <div className="aspect-square w-full mb-3 rounded-2xl bg-[var(--color-surface-variant)]" />
          <div className="px-1 space-y-1.5">
            <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
            <div className="h-3 w-1/2 rounded bg-[var(--color-surface-variant)]" />
          </div>
        </div>
      ))}
    </div>
  </div>
);

// The routed content area. This is the ONE piece of the shell that genuinely
// depends on the current route, so it owns `useLocation()` — keeping it out of
// App means navigation re-renders only this subtree, not the whole app shell.
export const MainContent: React.FC = () => {
  const location = useLocation();
  const library = usePlayerStore(state => state.library);
  const albums = usePlayerStore(state => state.albums);
  const artists = usePlayerStore(state => state.artists);
  const isLibraryLoading = usePlayerStore(state => state.isLibraryLoading);
  // The library is "present" as soon as the lightweight entity lists load
  // (entity-first), not only once the full track array arrives in the
  // background. Gating on `library` (tracks) alone showed the empty "add a
  // folder" prompt during the background-load window even when a library exists.
  const hasLibrary = library.length > 0 || albums.length > 0 || artists.length > 0;
  const isScanningGlobal = usePlayerStore(state => state.isScanning);
  const playlist = usePlayerStore(state => state.playlist);
  const [playerPlacement] = usePlayerPlacement();
  const [folderPathInput, setFolderPathInput] = React.useState('');
  // The single scroll viewport shared by every routed page (and the virtualized
  // grids). Restore its position on back/forward, reset to top on fresh nav.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  useScrollRestoration(scrollRef);

  return (
    <div className="flex-1 flex overflow-hidden">
      <div ref={scrollRef} className={`app-scroll-viewport flex-1 ${
        playlist.length > 0
          ? playerPlacement === 'dock'
            ? 'pb-32 md:pb-24'
            : 'pb-32 md:pb-44'
          : 'pb-16 md:pb-4'
      }`}>
        {!hasLibrary ? (
          isLibraryLoading && location.pathname !== '/library' ? (
            <div className="page-container">
              {/* Same filter-toolbar-shaped placeholder as RouteFallback so the
                  whole loading chain (this → route fallback → real view) keeps the
                  grid at one Y and doesn't shift. */}
              <div className="flex gap-2 py-2.5 mb-6">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-9 w-10 rounded-xl bg-[var(--color-surface-variant)] animate-pulse" />
                ))}
              </div>
              <div className="album-grid">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className="flex flex-col animate-pulse">
                    <div className="aspect-square w-full mb-3 rounded-2xl bg-[var(--color-surface-variant)]" />
                    <div className="px-1 space-y-1.5">
                      <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
                      <div className="h-3 w-1/2 rounded bg-[var(--color-surface-variant)]" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
          <React.Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/invite/:token" element={<InviteRegister />} />
              <Route path="*" element={
                <div className="empty-state font-body flex flex-col items-center justify-center p-8 flex-1">
                  <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-[var(--aurora-green)] to-[var(--color-primary)] mb-4">
                    NorthernLights
                  </h1>
                  <p className="text-lg text-[var(--color-text-secondary)] mb-8 max-w-md text-center">
                    Provide the absolute path to your local music directory to let the host scan and stream it.
                  </p>
                  <div className="flex flex-col md:flex-row gap-4 w-full max-w-lg">
                    <input
                      type="text"
                      placeholder="/home/andreas/Music"
                      value={folderPathInput}
                      onChange={(e) => setFolderPathInput(e.target.value)}
                      className="flex-1 px-4 py-3 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md text-[var(--color-text-primary)] shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent transition-ui duration-300"
                      disabled={isScanningGlobal}
                    />
                    <button
                      onClick={async () => {
                        if (!folderPathInput.trim()) return;
                        await usePlayerStore.getState().addLibraryFolder(folderPathInput.trim());
                        setFolderPathInput('');
                      }}
                      className="btn btn-lg whitespace-nowrap"
                      disabled={isScanningGlobal || !folderPathInput.trim()}
                    >
                      {isScanningGlobal ? '✦ Scanning...' : '✦ Map Folder'}
                    </button>
                  </div>
                </div>
              } />
            </Routes>
          </React.Suspense>
          )
        ) : (
          <React.Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/library" replace />} />
              <Route path="/invite/:token" element={<InviteRegister />} />
              <Route path="/library" element={<Hub />} />
              <Route path="/library/artists" element={<LibraryHome section="artists" />} />
              <Route path="/library/artist/:artistId" element={<ArtistDetail />} />
              <Route path="/library/albums" element={<LibraryHome section="albums" />} />
              <Route path="/library/album/:albumId" element={<AlbumDetail />} />
              <Route path="/library/genres" element={<LibraryHome section="genres" />} />
              <Route path="/library/genre/:genreId" element={<GenreDetail />} />
              <Route path="/search" element={<SearchResultsPage />} />
              <Route path="/playlists" element={<Playlists />} />
              <Route path="/playlists/:playlistId" element={<PlaylistDetail />} />
              <Route path="*" element={<Navigate to="/library" replace />} />
            </Routes>
          </React.Suspense>
        )}
      </div>
    </div>
  );
};

export default MainContent;
