import React from 'react';

// Centralised dynamic imports for the heavy routes. Exporting both the
// React.lazy components and the prefetch fns from here means hover/pointerdown
// warm-up and the actual route render hit the exact same module, so the second
// call returns the already-loaded chunk instead of a fresh network request.
//
// Each prefetch fn is idempotent (guarded by a module-level promise) and
// returns that promise, so a chunk loads at most once per session.

// ─── Detail routes (opened from cards) ──────────────────────────────────────
const importAlbumDetail = () => import('../components/library/AlbumDetail');
const importArtistDetail = () => import('../components/library/ArtistDetail');
const importPlaylistDetail = () => import('../components/library/PlaylistDetail');

let albumPromise: ReturnType<typeof importAlbumDetail> | null = null;
let artistPromise: ReturnType<typeof importArtistDetail> | null = null;
let playlistPromise: ReturnType<typeof importPlaylistDetail> | null = null;

export const prefetchAlbumDetail = (): Promise<unknown> => {
  if (!albumPromise) albumPromise = importAlbumDetail().catch((err) => { albumPromise = null; throw err; });
  return albumPromise;
};

export const prefetchArtistDetail = (): Promise<unknown> => {
  if (!artistPromise) artistPromise = importArtistDetail().catch((err) => { artistPromise = null; throw err; });
  return artistPromise;
};

export const prefetchPlaylistDetail = (): Promise<unknown> => {
  if (!playlistPromise) playlistPromise = importPlaylistDetail().catch((err) => { playlistPromise = null; throw err; });
  return playlistPromise;
};

export const AlbumDetail = React.lazy(() => importAlbumDetail().then(m => ({ default: m.AlbumDetail })));
export const ArtistDetail = React.lazy(() => importArtistDetail().then(m => ({ default: m.ArtistDetail })));
export const PlaylistDetail = React.lazy(() => importPlaylistDetail().then(m => ({ default: m.PlaylistDetail })));

// ─── List routes (opened from the nav tabs) ─────────────────────────────────
// Warmed on tab hover/pointerdown so the chunk is in memory by the time the
// tab is actually activated. LibraryHome backs albums/artists/genres.
const importLibraryHome = () => import('../components/library/LibraryHome');
const importHub = () => import('../components/Hub');
const importPlaylists = () => import('../components/library/Playlists');
const importSearchResultsPage = () => import('../components/SearchResultsPage');

let libraryHomePromise: ReturnType<typeof importLibraryHome> | null = null;
let hubPromise: ReturnType<typeof importHub> | null = null;
let playlistsPromise: ReturnType<typeof importPlaylists> | null = null;

export const prefetchLibraryHome = (): Promise<unknown> => {
  if (!libraryHomePromise) libraryHomePromise = importLibraryHome().catch((err) => { libraryHomePromise = null; throw err; });
  return libraryHomePromise;
};

export const prefetchHub = (): Promise<unknown> => {
  if (!hubPromise) hubPromise = importHub().catch((err) => { hubPromise = null; throw err; });
  return hubPromise;
};

export const prefetchPlaylists = (): Promise<unknown> => {
  if (!playlistsPromise) playlistsPromise = importPlaylists().catch((err) => { playlistsPromise = null; throw err; });
  return playlistsPromise;
};

export const LibraryHome = React.lazy(() => importLibraryHome().then(m => ({ default: m.LibraryHome })));
export const Hub = React.lazy(() => importHub().then(m => ({ default: m.Hub })));
export const Playlists = React.lazy(() => importPlaylists().then(m => ({ default: m.Playlists })));
export const SearchResultsPage = React.lazy(() => importSearchResultsPage().then(m => ({ default: m.SearchResultsPage })));

// Map a tab path to the prefetch fn for the chunk it renders. Shared by the
// desktop and mobile tab bars.
export const prefetchForTabPath = (path: string): void => {
  if (path === '/library') { void prefetchHub(); return; }
  if (path === '/playlists') { void prefetchPlaylists(); return; }
  if (path.startsWith('/library/')) { void prefetchLibraryHome(); return; }
};
