import { create, StateCreator } from 'zustand';
import { persist, PersistOptions } from 'zustand/middleware';
import type { TrackInfo } from '../utils/fileSystem';
import { extractMetadata } from '../utils/fileSystem';
import { playbackManager, PlaybackState } from '../utils/PlaybackManager';

export interface PlayerState {
  // Library State
  library: TrackInfo[];
  libraryFolders: string[];

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

  // View State (Library Navigation)
  currentView: 'home' | 'artists' | 'albums' | 'genres' | 'artist' | 'album' | 'genre';
  selectedItem: string | null;

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
  authToken: string | null;

  // Actions
  fetchLibraryFromServer: () => Promise<void>;
  setAuthToken: (token: string) => void;
  getAuthHeader: () => Record<string, string>;
  addLibraryFolder: (folderPath: string) => Promise<void>;
  removeLibraryFolder: (folderName: string) => Promise<void>;
  rescanLibrary: () => Promise<void>;
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

  // Playlist Actions
  setPlaylist: (tracks: TrackInfo[], startIndex?: number) => Promise<void>;
  addTrackToPlaylist: (track: TrackInfo) => void;
  removeFromPlaylist: (index: number) => void;
  moveInPlaylist: (fromIndex: number, toIndex: number) => void;

  // View Actions
  navigateView: (view: 'home' | 'artists' | 'albums' | 'genres' | 'artist' | 'album' | 'genre', item?: string | null) => void;

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
          const { repeat, nextTrack, stop } = get();
          if (repeat === 'one') {
            // Let the audio element handle loop if we implemented it, or manually replay
            get().playAtIndex(get().currentIndex!);
          } else if (repeat === 'none') {
            // Stop at end of list
            const currentIdx = get().currentIndex!;
            if (currentIdx < get().tracks.length - 1 || get().shuffle) {
              nextTrack();
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
        playlist: [] as TrackInfo[],
        currentView: 'artists' as 'home' | 'artists' | 'albums' | 'genres' | 'artist' | 'album' | 'genre',
        selectedItem: null as string | null,

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

        // Actions
        checkSetupStatus: async () => {
          try {
            const res = await fetch('/api/setup/status');
            if (res.ok) {
              const data = await res.json();
              set({ needsSetup: data.needsSetup });
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

        // Helper for Auth Header
        getAuthHeader: () => {
          const { authToken } = get();
          if (authToken) {
            return { 'Authorization': 'Basic ' + authToken };
          }
          // The browser will use its native basic auth popup if no authorization header is explicit
          return {} as Record<string, string>;
        },

        fetchLibraryFromServer: async () => {
          try {
            const res = await fetch('/api/library');
            if (res.ok) {
              const data = await res.json();
              
              const { authToken } = get();
              const token = authToken || '';
              
              const host = window.location.host; // e.g. localhost:3000
              const protocol = window.location.protocol;
              
              const libraryWithUrls = data.tracks.map((t: any) => {
                let artistsArray = t.artists;
                if (typeof t.artists === 'string') {
                  try { artistsArray = JSON.parse(t.artists); } catch(e) {}
                }
                
                return {
                  ...t,
                  artists: artistsArray,
                  url: `${protocol}//${host}/api/stream?path=${encodeURIComponent(t.path)}${token ? `&token=${token}` : ''}`,
                  artUrl: `${protocol}//${host}/api/art?path=${encodeURIComponent(t.path)}${token ? `&token=${token}` : ''}`
                };
              });

              set({ library: libraryWithUrls, libraryFolders: data.directories });
            }
          } catch (e) {
            console.error("Failed to fetch library from server", e);
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
          await get().rescanLibrary();
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

        rescanLibrary: async () => {
          const state = get();

          // Trigger scans for all mapped folders sequentially with backoff
          for (const folderPath of state.libraryFolders) {
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
              const host = window.location.host;
              const protocol = window.location.protocol;

              const latestLibrary = data.tracks.map((t: any) => {
                let artistsArray = t.artists;
                if (typeof t.artists === 'string') {
                  try { artistsArray = JSON.parse(t.artists); } catch(e) {}
                }
                
                const streamUrl = new URL(`${protocol}//${host}/api/stream`);
                streamUrl.searchParams.append('path', t.path);
                if (token) streamUrl.searchParams.append('token', token);

                const artUrlObj = new URL(`${protocol}//${host}/api/art`);
                artUrlObj.searchParams.append('path', t.path);
                if (token) artUrlObj.searchParams.append('token', token);
                
                return {
                  ...t,
                  artists: artistsArray,
                  url: streamUrl.toString(),
                  artUrl: artUrlObj.toString()
                };
              });
              set({ library: latestLibrary });
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

        navigateView: (view: 'home' | 'artists' | 'albums' | 'genres' | 'artist' | 'album' | 'genre', item: string | null = null) => {
          set({ currentView: view, selectedItem: item });
        },

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
              await playbackManager.playUrl(track.url);
            } else if (track.fileHandle) {
               // Fallback
               await playbackManager.playFile(track.fileHandle);
            }
            set({ currentIndex: index });
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
        authToken: state.authToken
      }),
    }
  )
);
