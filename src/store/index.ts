import { create, StateCreator } from 'zustand';
import { persist, PersistOptions } from 'zustand/middleware';
import type { TrackInfo } from '../utils/fileSystem';
import { extractMetadata } from '../utils/fileSystem';
import { playbackManager, PlaybackState } from '../utils/PlaybackManager';
import { safeBtoa } from '../utils/safeBtoa';

const buildTrackUrls = (path: string, token: string) => {
  const base = `${window.location.protocol}//${window.location.host}`;
  const tokenParam = token ? `&token=${token}` : '';
  const pathB64 = safeBtoa(path);
  return {
    url: `${base}/api/stream?pathB64=${pathB64}${tokenParam}`,
    artUrl: `${base}/api/art?pathB64=${pathB64}${tokenParam}`,
  };
};

export interface Playlist {
  id: string;
  title: string;
  description: string | null;
  isLlmGenerated: boolean;
  pinned?: boolean;
  tracks: TrackInfo[];
}

export interface EntityInfo {
  id: string;
  name?: string;
  title?: string;
  artist_name?: string;
}

export interface PlayerState {
  // Library State
  library: TrackInfo[];
  libraryFolders: string[];
  playlists: Playlist[];

  // Entity State (for navigation)
  artists: EntityInfo[];
  albums: EntityInfo[];
  genres: EntityInfo[];

  // Playlist State (Current Play Queue)
  playlist: TrackInfo[];

  // Scanning State
  isScanning: boolean;
  scanPhase: 'idle' | 'walk' | 'metadata';
  scannedFiles: number;
  totalFiles: number;
  activeWorkers: number;
  activeFiles: string[];
  scanningFile: string | null; // legacy fallback

  // Setup State
  needsSetup: boolean | null;
  checkSetupStatus: () => Promise<void>;

  // Playback State (Transient)
  currentIndex: number | null;
  playbackState: PlaybackState;
  currentTime: number;
  duration: number;

  // Settings State (Persisted)
  volume: number;
  shuffle: boolean;
  repeat: "none" | "one" | "all";
  theme: 'light' | 'dark';
  lastFmApiKey: string;
  geniusApiKey: string;
  preferredProvider: 'lastfm' | 'genius';
  authToken: string | null; // JWT token

  // Current User State
  currentUser: { id: string; username: string; role: string } | null;

  // Global Engine Settings
  discoveryLevel: number;
  genreStrictness: number;
  artistAmnesiaLimit: number;
  audioAnalysisCpu: string;
  hubGenerationSchedule: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModelName: string;
  genreMatrixLastRun: number | null;
  genreMatrixLastResult: string | null;
  genreMatrixProgress: string | null;

  isSidebarCollapsed: boolean;
  setIsSidebarCollapsed: (collapsed: boolean) => void;

  setSettings: (settings: Partial<PlayerState>) => void;
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;
  
  isInfinityMode: boolean;
  isFetchingInfinity: boolean;
  toggleInfinityMode: () => void;
  ensureInfinityQueue: () => Promise<void>;
  fetchNextInfinityTrack: (isPrefetch?: boolean) => Promise<void>;

  fetchLibraryFromServer: () => Promise<void>;
  fetchPlaylistsFromServer: () => Promise<void>;
  createPlaylist: (title: string, description?: string) => Promise<void>;
  deletePlaylist: (playlistId: string) => Promise<void>;
  togglePin: (playlistId: string, pinned: boolean) => Promise<void>;
  addTracksToUserPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>;
  setAuthToken: (token: string) => void;
  clearAuthToken: () => void;
  login: (username: string, password: string) => Promise<boolean>;
  register: (inviteToken: string, username: string, password: string) => Promise<boolean>;
  getAuthHeader: () => Record<string, string>;
  addLibraryFolder: (folderPath: string) => Promise<void>;
  removeLibraryFolder: (folderName: string) => Promise<void>;
  rescanLibrary: (specificFolder?: string) => Promise<void>;
  addTracksToLibrary: (newTracks: TrackInfo[]) => void;
  setIsScanning: (
    isScanning: boolean,
    phase?: 'idle' | 'walk' | 'metadata',
    scanned?: number,
    total?: number,
    workers?: number,
    activeFiles?: string[],
    fileName?: string | null
  ) => void;

  // Library Actions
  deleteTrackFromLibrary: (trackId: string) => Promise<void>;

  // Play Queue Actions
  setPlaylist: (tracks: TrackInfo[], startIndex?: number) => Promise<void>;
  addTrackToPlaylist: (track: TrackInfo) => void;
  playNext: (track: TrackInfo) => void;
  removeFromPlaylist: (index: number) => void;
  moveInPlaylist: (fromIndex: number, toIndex: number) => void;

  // Global Track Context Menu
  contextMenu: { track: TrackInfo; x: number; y: number } | null;
  openContextMenu: (track: TrackInfo, x: number, y: number) => void;
  closeContextMenu: () => void;

  // Playback Actions
  playAtIndex: (index: number) => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  stop: () => void;
  nextTrack: () => Promise<void>;
  prevTrack: () => Promise<void>;
  setVolume: (v: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setLastFmApiKey: (key: string) => void;
  setGeniusApiKey: (key: string) => void;
  setPreferredProvider: (provider: 'lastfm' | 'genius') => void;

  // Manager sync callbacks
  syncTimeUpdate: (time: number) => void;
  syncDuration: (duration: number) => void;
  syncPlaybackState: (state: PlaybackState) => void;

  // Engine session state
  sessionHistoryTrackIds: string[];
  recordPlay: (trackId: string) => void;
  recordSkip: (trackId: string) => void;
}

// Remove `PlayerPersist` hack as it was unnecessary and broke inference further

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set: any, get: any) => {
      // Setup PlaybackManager callbacks to update store state
      playbackManager.setCallbacks({
        onTimeUpdate: (time) => set({ currentTime: time }),
        onDuration: (duration) => set({ duration }),
        onPlayStateChange: (state) => set({ playbackState: state }),
        onEnded: () => {
          // Auto-play next track based on repeat and shuffle rules
          const { repeat, nextTrack, stop, fetchNextInfinityTrack } = get();
          if (repeat === 'one') {
            // Let the audio element handle loop if we implemented it, or manually replay
            get().playAtIndex(get().currentIndex!);
          } else if (repeat === 'none') {
            // Stop at end of list
            const currentIdx = get().currentIndex!;
            if (currentIdx < get().playlist.length - 1 || get().shuffle) {
              nextTrack();
            } else if (get().isInfinityMode) {
              // Infinity Mode bounds reached! Fetch the next track natively
              fetchNextInfinityTrack(false);
            } else {
              stop();
            }
          } else {
            // repeat === 'all'
            nextTrack();
          }
        }
      });

      return {
        // Initial State
        library: [] as TrackInfo[],
        libraryFolders: [] as string[],
        playlists: [] as Playlist[],
        artists: [] as EntityInfo[],
        albums: [] as EntityInfo[],
        genres: [] as EntityInfo[],
        playlist: [] as TrackInfo[],

        isScanning: false as boolean,
        scanPhase: 'idle' as 'idle' | 'walk' | 'metadata',
        scannedFiles: 0,
        totalFiles: 0,
        activeWorkers: 0,
        activeFiles: [] as string[],
        scanningFile: null as string | null,

        needsSetup: null as boolean | null,

        currentIndex: null as number | null,
        playbackState: 'stopped' as PlaybackState,
        currentTime: 0,
        duration: 0,
        volume: 1,
        shuffle: false as boolean,
        repeat: "none" as "none" | "one" | "all",
        theme: 'light' as 'light' | 'dark',
        lastFmApiKey: '',
        geniusApiKey: '',
        preferredProvider: 'lastfm' as 'lastfm' | 'genius',
        authToken: null as string | null,
        currentUser: null as { id: string; username: string; role: string } | null,

        isInfinityMode: true as boolean,
        isFetchingInfinity: false as boolean,


        discoveryLevel: 50,
        genreStrictness: 50,
        artistAmnesiaLimit: 50,
        audioAnalysisCpu: 'Balanced',
        hubGenerationSchedule: 'Daily',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmApiKey: '',
        llmModelName: 'gpt-4',
        genreMatrixLastRun: null as number | null,
        genreMatrixLastResult: null as string | null,
        genreMatrixProgress: null as string | null,

        isSidebarCollapsed: false as boolean,
        setIsSidebarCollapsed: (collapsed: boolean) => set({ isSidebarCollapsed: collapsed }),

        sessionHistoryTrackIds: [] as string[],

        // Actions
        checkSetupStatus: async () => {
          try {
            const res = await fetch('/api/setup/status');
            if (res.ok) {
              const data = await res.json();
              set({ needsSetup: data.needsSetup });
            } else {
              set({ needsSetup: false });
            }
          } catch (e) {
            console.error("Failed to check setup status", e);
            set({ needsSetup: false }); // Fallback assuming standard boot
          }
        },

        setIsScanning: (isScanning, phase = 'idle', scanned = 0, total = 0, workers = 0, activeFiles = [], fileName = null) => 
          set({ 
            isScanning, 
            scanPhase: phase, 
            scannedFiles: scanned, 
            totalFiles: total, 
            activeWorkers: workers, 
            activeFiles,
            scanningFile: fileName 
          }),

        setTheme: (theme: 'light' | 'dark') => {
          set({ theme });
          if (theme === 'dark') {
            document.documentElement.classList.add('dark');
          } else {
            document.documentElement.classList.remove('dark');
          }
        },

        setAuthToken: (token: string) => set({ authToken: token }),

        clearAuthToken: () => set({ authToken: null, currentUser: null }),

        login: async (username: string, password: string) => {
          try {
            const res = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username, password })
            });
            if (res.ok) {
              const data = await res.json();
              set({ authToken: data.token, currentUser: data.user });
              return true;
            }
            return false;
          } catch {
            return false;
          }
        },

        register: async (inviteToken: string, username: string, password: string) => {
          try {
            const res = await fetch('/api/auth/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ inviteToken, username, password })
            });
            if (res.ok) {
              const data = await res.json();
              set({ authToken: data.token, currentUser: data.user });
              return true;
            }
            return false;
          } catch {
            return false;
          }
        },

        // Helper for Auth Header (JWT Bearer)
        getAuthHeader: () => {
          const { authToken } = get();
          if (authToken) {
            return { 'Authorization': 'Bearer ' + authToken };
          }
          return {} as Record<string, string>;
        },

        setSettings: (settings: Partial<PlayerState>) => {
          set((state: PlayerState) => ({ ...state, ...settings }));
        },

        loadSettings: async () => {
          try {
            const authHeaders = (get() as any).getAuthHeader();
            const res = await fetch('/api/settings', { headers: authHeaders });
            if (res.ok) {
              const data = await res.json();
              set({
                discoveryLevel: data.discoveryLevel !== undefined ? data.discoveryLevel : 50,
                genreStrictness: data.genreStrictness !== undefined ? data.genreStrictness : 50,
                artistAmnesiaLimit: data.artistAmnesiaLimit !== undefined ? data.artistAmnesiaLimit : 50,
                audioAnalysisCpu: data.audioAnalysisCpu || 'Balanced',
                hubGenerationSchedule: data.hubGenerationSchedule || 'Daily',
                llmBaseUrl: data.llmBaseUrl || 'https://api.openai.com/v1',
                llmApiKey: data.llmApiKey || '',
                llmModelName: data.llmModelName || 'gpt-4',
                genreMatrixLastRun: data.genreMatrixLastRun || null,
                genreMatrixLastResult: data.genreMatrixLastResult || null,
                genreMatrixProgress: data.genreMatrixProgress || null
              });
            }
          } catch (e) {
            console.error('Failed to load DB settings', e);
          }
        },

        saveSettings: async () => {
           try {
              const state = get();
              const authHeaders = (state as any).getAuthHeader();
              const payload = {
                discoveryLevel: state.discoveryLevel,
                genreStrictness: state.genreStrictness,
                artistAmnesiaLimit: state.artistAmnesiaLimit,
                audioAnalysisCpu: state.audioAnalysisCpu,
                hubGenerationSchedule: state.hubGenerationSchedule,
                llmBaseUrl: state.llmBaseUrl,
                llmApiKey: state.llmApiKey,
                llmModelName: state.llmModelName
              };
              await fetch('/api/settings', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json', ...authHeaders },
                 body: JSON.stringify(payload)
              });
           } catch(e) {
              console.error('Failed to save settings', e);
           }
        },
        toggleInfinityMode: () => {
          const state = get();
          const newMode = !state.isInfinityMode;
          set({ isInfinityMode: newMode });
          if (newMode) {
            get().ensureInfinityQueue();
          }
        },

        ensureInfinityQueue: async () => {
          const state = get();
          if (!state.isInfinityMode || state.isFetchingInfinity) return;

          const currentIndex = state.currentIndex !== null ? state.currentIndex : 0;
          const remaining = Math.max(0, state.playlist.length - 1 - currentIndex);
          
          // Prefetch if there are no upcoming tracks in the queue
          if (remaining < 1 && state.playlist.length > 0) {
            await get().fetchNextInfinityTrack(true);
          }
        },

        fetchNextInfinityTrack: async (isPrefetch = false) => {
          const state = get();
          if (state.isFetchingInfinity) return;
          
          set({ isFetchingInfinity: true });
          try {
            const authHeaders = (state as any).getAuthHeader();
            const payload = {
              sessionHistoryTrackIds: state.sessionHistoryTrackIds,
              settings: {
                discoveryLevel: state.discoveryLevel,
                genreStrictness: state.genreStrictness,
                artistAmnesiaLimit: state.artistAmnesiaLimit,
              }
            };
            const res = await fetch('/api/recommend', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify(payload)
            });
            if (res.ok) {
              const data = await res.json();
              if (data.track) {
                const { authToken } = state;
                const token = authToken || '';

                const track = {
                  ...data.track,
                  isInfinity: true,
                  artists: typeof data.track.artists === 'string' ? JSON.parse(data.track.artists) : data.track.artists,
                  ...buildTrackUrls(data.track.path, token),
                };
                get().addTrackToPlaylist(track);
                if (!isPrefetch) {
                  get().playAtIndex(state.playlist.length); // Play the newly appended track
                }
              } else if (!isPrefetch) {
                get().stop();
              }
            } else if (!isPrefetch) {
               get().stop();
            }
          } catch (e) {
            console.error("Failed to fetch infinity track", e);
            if (!isPrefetch) get().stop();
          } finally {
            set({ isFetchingInfinity: false });
          }
        },

        fetchLibraryFromServer: async () => {
          try {
            const authHeaders = (get() as any).getAuthHeader();
            const res = await fetch('/api/library', { headers: authHeaders });
            if (res.ok) {
              const data = await res.json();
              
              const { authToken } = get();
              const token = authToken || '';

              const libraryWithUrls = data.tracks.map((t: any) => {
                let artistsArray = t.artists;
                if (typeof t.artists === 'string') {
                  try { artistsArray = JSON.parse(t.artists); } catch(e) {}
                }
                
                return {
                  ...t,
                  artists: artistsArray,
                  ...buildTrackUrls(t.path, token),
                };
              });

              set({
                library: libraryWithUrls,
                libraryFolders: data.directories,
                artists: data.artists || [],
                albums: data.albums || [],
                genres: data.genres || []
              });
            }
          } catch (e) {
            console.error("Failed to fetch library from server", e);
          }
        },

        fetchPlaylistsFromServer: async () => {
           try {
              const authHeaders = (get() as any).getAuthHeader();
              const res = await fetch('/api/playlists', { headers: authHeaders });
              if (res.ok) {
                 const data = await res.json();
                 
                 const { authToken, library } = get();
                 const token = authToken || '';

                 // Map track objects inside playlists to have full stream URLs
                 const populatedPlaylists = data.playlists.map((pl: any) => {
                    const mappedTracks = pl.tracks.map((t: any) => {
                       // Prefer library track (up-to-date art, etc.), fall back to API data
                       const fullTrack = library.find((lt: TrackInfo) => lt.id === t.id);
                       const track = fullTrack || t;
                       if (!track.path) return null;
                       return {
                         ...track,
                         ...buildTrackUrls(track.path, token),
                       };
                    }).filter(Boolean);
                    return { ...pl, tracks: mappedTracks };
                 });

                 set({ playlists: populatedPlaylists });
              }
           } catch (e) {
              console.error("Failed to fetch playlists from server", e);
           }
        },

        createPlaylist: async (title: string, description?: string) => {
           try {
              const authHeaders = (get() as any).getAuthHeader();
              const res = await fetch('/api/playlists', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json', ...authHeaders },
                 body: JSON.stringify({ title, description })
              });
              if (res.ok) {
                 await get().fetchPlaylistsFromServer();
              }
           } catch (e) {
               console.error("Failed to create playlist", e);
            }
         },

         deletePlaylist: async (playlistId: string) => {
            try {
               const authHeaders = (get() as any).getAuthHeader();
               const res = await fetch(`/api/playlists/${playlistId}`, {
                  method: 'DELETE',
                  headers: authHeaders,
               });
               if (res.ok) {
                  set({ playlists: get().playlists.filter((p: Playlist) => p.id !== playlistId) });
               }
            } catch (e) {
               console.error("Failed to delete playlist", e);
            }
         },

         togglePin: async (playlistId: string, pinned: boolean) => {
            try {
               const authHeaders = (get() as any).getAuthHeader();
               const res = await fetch(`/api/playlists/${playlistId}/pin`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: JSON.stringify({ pinned })
               });
               if (res.ok) {
                  set({
                     playlists: get().playlists.map((p: Playlist) =>
                        p.id === playlistId ? { ...p, pinned } : p
                     )
                  });
               }
            } catch (e) {
               console.error("Failed to toggle pin", e);
            }
         },

         addTracksToUserPlaylist: async (playlistId: string, trackIds: string[]) => {
           try {
              const authHeaders = (get() as any).getAuthHeader();
              const res = await fetch(`/api/playlists/${playlistId}/tracks`, {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json', ...authHeaders },
                 body: JSON.stringify({ trackIds })
              });
              if (res.ok) {
                 await get().fetchPlaylistsFromServer();
              }
           } catch (e) {
              console.error(`Failed to add tracks to playlist ${playlistId}`, e);
           }
        },

        addTracksToLibrary: (newTracks: TrackInfo[]) => set((state: PlayerState) => {
          const existingIds = new Set(state.library.map(t => t.id));
          const uniqueNew = newTracks.filter(t => !existingIds.has(t.id));
          if (uniqueNew.length === 0) return state;
          return { library: [...state.library, ...uniqueNew] };
        }),

        deleteTrackFromLibrary: async (trackId: string) => {
          // This would ideally hit a DELETE /api/library/:id endpoint
          // For now we just remove from UI state
          set((state: PlayerState): Partial<PlayerState> => {
            const newLibrary = state.library.filter(t => t.id !== trackId);
            // If the deleted track was the currently playing one in the playlist, stop it.
            let newIndex = state.currentIndex;
            if (state.currentIndex !== null) {
              const currentTrackId = state.playlist[state.currentIndex]?.id;
              if (currentTrackId === trackId) {
                playbackManager.stop();
                newIndex = null;
              }
            }
            // Remove it from the playlist array as well
            const newPlaylist = state.playlist.filter(t => t.id !== trackId);
            // Adjust the newIndex depending on items removed before it
            if (newIndex !== null && newPlaylist.length !== state.playlist.length) {
              const deletedPlaylistIdx = state.playlist.findIndex(t => t.id === trackId);
              if (deletedPlaylistIdx < newIndex) {
                newIndex = newIndex - 1;
              }
            }

            return { library: newLibrary, playlist: newPlaylist, currentIndex: newIndex };
          });
        },

        addLibraryFolder: async (folderPath: string) => {
          const state = get();
          if (state.libraryFolders.includes(folderPath)) return;

          set({ libraryFolders: [...state.libraryFolders, folderPath] });

          try {
            const authHeaders = (get() as any).getAuthHeader();
            
            // Instantly register the folder to the DB so page refreshes don't lose it
            await fetch('/api/library/add', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify({ path: folderPath })
            });

            // Queue a scan for JUST this newly added folder
            await get().rescanLibrary(folderPath);
          } catch (e) {
            console.error('Failed to add and scan folder', e);
          }
        },

        removeLibraryFolder: async (folderPath: string) => {
          set((state: PlayerState) => ({
            libraryFolders: state.libraryFolders.filter((f: string) => f !== folderPath)
          }));
          
          try {
            const authHeaders = (get() as any).getAuthHeader();
            await fetch('/api/library/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify({ path: folderPath })
            });
            await get().fetchLibraryFromServer();
          } catch (e) {
            console.error('Failed to remove folder from backend', e);
          }
        },

        rescanLibrary: async (specificFolder?: string) => {
          const state = get();

          const foldersToScan = specificFolder ? [specificFolder] : state.libraryFolders;

          // Trigger scans sequentially with backoff
          for (const folderPath of foldersToScan) {
            let scanStarted = false;
            while (!scanStarted) {
              try {
                const authHeaders = (get() as any).getAuthHeader();
                const res = await fetch('/api/library/scan', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: JSON.stringify({ path: folderPath })
                });
                
                if (res.status === 400) {
                  const errorData = await res.json();
                  if (errorData.error === 'Scan already in progress') {
                    // Wait if the backend is busy with another directory's scan
                    await new Promise(r => setTimeout(r, 1000));
                  } else {
                    console.error('Scan error:', errorData.error);
                    scanStarted = true; // other 400 error, skip
                  }
                } else if (!res.ok) {
                  console.error('Scan error:', res.statusText);
                  scanStarted = true; // other error, skip
                } else {
                  scanStarted = true; // Success
                }
              } catch (e) {
                console.error(`Failed to trigger scan for ${folderPath}`, e);
                scanStarted = true;
              }
            }
          }

          // Fetch the final library to reflect the new tracks
          try {
            const authHeaders = (get() as any).getAuthHeader();
            const fetchRes = await fetch('/api/library', { headers: authHeaders });
            if (fetchRes.ok) {
              const data = await fetchRes.json();
              
              const { authToken } = get();
              const token = authToken || '';

               const latestLibrary = data.tracks.map((t: any) => {
                let artistsArray = t.artists;
                if (typeof t.artists === 'string') {
                  try { artistsArray = JSON.parse(t.artists); } catch(e) {}
                }
                
                return {
                  ...t,
                  artists: artistsArray,
                  ...buildTrackUrls(t.path, token),
                };
              });
              set({
                library: latestLibrary,
                artists: data.artists || [],
                albums: data.albums || [],
                genres: data.genres || []
              });
            }
          } catch (e) {
            console.error('Failed to fetch updated library', e);
          }
        },

        setPlaylist: async (playlist: TrackInfo[], startIndex: number = 0) => {
          set({ playlist, currentIndex: startIndex });
          if (playlist.length > 0 && startIndex < playlist.length) {
            await get().playAtIndex(startIndex);
          } else {
            get().stop();
          }
        },

        addTrackToPlaylist: (track: TrackInfo) => set((state: PlayerState) => {
          return { playlist: [...state.playlist, track] };
        }),

        playNext: (track: TrackInfo) => set((state: PlayerState) => {
          const newPlaylist = [...state.playlist];
          const insertAt = state.currentIndex !== null ? state.currentIndex + 1 : newPlaylist.length;
          newPlaylist.splice(insertAt, 0, track);
          return { playlist: newPlaylist };
        }),

        // Global context menu
        contextMenu: null as { track: TrackInfo; x: number; y: number } | null,
        openContextMenu: (track: TrackInfo, x: number, y: number) => set({ contextMenu: { track, x, y } }),
        closeContextMenu: () => set({ contextMenu: null }),

        removeFromPlaylist: (index: number) => set((state: PlayerState) => {
          const newPlaylist = [...state.playlist];
          newPlaylist.splice(index, 1);

          let newIndex = state.currentIndex;
          if (state.currentIndex === index) {
            playbackManager.stop();
            newIndex = null;
          } else if (state.currentIndex !== null && index < state.currentIndex) {
            newIndex = state.currentIndex - 1;
          }
          return { playlist: newPlaylist, currentIndex: newIndex };
        }),

        moveInPlaylist: (fromIndex: number, toIndex: number) => set((state: PlayerState) => {
          const newPlaylist = [...state.playlist];
          const [moved] = newPlaylist.splice(fromIndex, 1);
          if (!moved) return state;
          newPlaylist.splice(toIndex, 0, moved);

          let newIndex = state.currentIndex;
          if (state.currentIndex !== null) {
            if (state.currentIndex === fromIndex) {
              newIndex = toIndex;
            } else {
              if (fromIndex < state.currentIndex && toIndex >= state.currentIndex) newIndex = state.currentIndex - 1;
              if (fromIndex > state.currentIndex && toIndex <= state.currentIndex) newIndex = state.currentIndex + 1;
            }
          }

          return { playlist: newPlaylist, currentIndex: newIndex };
        }),

        // Playback Actions
        playAtIndex: async (index: number) => {
          const { playlist, volume } = get();
          const track = playlist[index];
          if (!track) return;

          try {
            // Set volume before playing
            playbackManager.setVolume(volume);
            // Play using the HTTP stream URL
            if (track.url) {
              await playbackManager.playUrl(track.url, track.title, track.artist || ((track.artists as string[])?.join(', ')), track.artUrl);
            } else if (track.fileHandle) {
               // Fallback
               await playbackManager.playFile(track.fileHandle);
            }
            set({ currentIndex: index });

            // Telemetry: record successful playback and push to session history
            get().recordPlay(track.id);

            // Pre-fetch infinite track if bounds are reached
            get().ensureInfinityQueue();
          } catch (e) {
            console.error("Error playing track", e);
            get().nextTrack(); // try skipping to next
          }
        },

        pause: () => {
          playbackManager.pause();
        },

        resume: async () => {
          await playbackManager.resume();
        },

        stop: () => {
          playbackManager.stop();
          set({ currentIndex: null, currentTime: 0, playbackState: 'stopped' });
        },

        nextTrack: async () => {
          const { playlist, currentIndex, shuffle } = get();
          if (playlist.length === 0) return;

          // Telemetry: record skip for the track we are leaving
          if (currentIndex !== null && playlist[currentIndex]) {
            get().recordSkip(playlist[currentIndex].id);
          }

          let nextIndex = 0;
          if (shuffle) {
            nextIndex = Math.floor(Math.random() * playlist.length);
          } else if (currentIndex !== null) {
            nextIndex = (currentIndex + 1) % playlist.length;
          }

          await get().playAtIndex(nextIndex);
        },

        prevTrack: async () => {
          const { playlist, currentIndex, currentTime } = get();
          if (playlist.length === 0) return;

          // If we are more than 3 seconds in, just restart the track
          if (currentTime > 3 && currentIndex !== null) {
            playbackManager.seek(0);
            return;
          }

          let prevIndex = playlist.length - 1;
          if (currentIndex !== null) {
            prevIndex = (currentIndex - 1 + playlist.length) % playlist.length;
          }
          await get().playAtIndex(prevIndex);
        },

        setVolume: (v: number) => {
          playbackManager.setVolume(v);
          set({ volume: v });
        },

        toggleShuffle: () => set((state: PlayerState) => ({ shuffle: !state.shuffle })),

        cycleRepeat: () => set((state: PlayerState) => {
          const nextMode = state.repeat === 'none' ? 'all' : state.repeat === 'all' ? 'one' : 'none';
          return { repeat: nextMode };
        }),

        syncTimeUpdate: (time: number) => set({ currentTime: time }),
        syncDuration: (duration: number) => set({ duration }),
        syncPlaybackState: (state: PlaybackState) => set({ playbackState: state }),
        
        setLastFmApiKey: (key: string) => set({ lastFmApiKey: key }),
        setGeniusApiKey: (key: string) => set({ geniusApiKey: key }),
        setPreferredProvider: (provider: 'lastfm' | 'genius') => set({ preferredProvider: provider }),

        recordPlay: (trackId: string) => {
          // Push trackId to the 50-item rolling session history
          set((state: PlayerState) => {
            const updated = [...state.sessionHistoryTrackIds, trackId].slice(-50);
            return { sessionHistoryTrackIds: updated };
          });
          // Fire-and-forget telemetry to backend
          const authHeaders = (get() as any).getAuthHeader();
          fetch('/api/playback/record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ trackId })
          }).catch((e: Error) => console.warn('Telemetry record failed:', e));
        },

        recordSkip: (trackId: string) => {
          // Fire-and-forget telemetry to backend
          const authHeaders = (get() as any).getAuthHeader();
          fetch('/api/playback/skip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ trackId })
          }).catch((e: Error) => console.warn('Telemetry skip failed:', e));
        },
      };
    },
    {
      name: "player-store",
      // Only persist lightweight user settings, NOT the library.
      // The library is always fetched fresh from the server on boot.
      partialize: (state: PlayerState) => ({
        volume: state.volume,
        shuffle: state.shuffle,
        repeat: state.repeat,
        theme: state.theme,
        lastFmApiKey: state.lastFmApiKey,
        geniusApiKey: state.geniusApiKey,
        preferredProvider: state.preferredProvider,
        authToken: state.authToken,
        currentUser: state.currentUser,

        // We do *not* persist DB settings (API keys) in localStorage, we ONLY load them from DB on mount
        // by calling loadSettings() from an effect in the app root
      }),
    }
  )
);
