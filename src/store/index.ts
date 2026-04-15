import { create, StateCreator } from 'zustand';
import { persist, PersistOptions } from 'zustand/middleware';
import type { TrackInfo } from '../utils/fileSystem';
import { extractMetadata } from '../utils/fileSystem';
import { playbackManager, PlaybackState } from '../utils/PlaybackManager';
import { castManager } from '../utils/CastManager';

import { clearExternalCache } from '../utils/externalImagery';
import type { ToastType } from '../components/Toast';

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

// Re-entrancy guard: incremented on each playAtIndex call to discard stale callbacks
let playGeneration = 0;

const buildTrackUrls = (trackId: string, path: string, token: string, quality: string = '128k') => {
  const base = `${window.location.protocol}//${window.location.host}`;
  const tokenParam = token ? `&token=${token}` : '';
  // path is already base64 from the DB — just URL-encode for safe transport
  const pathB64 = encodeURIComponent(path);
  return {
    url: `${base}/api/stream/${encodeURIComponent(trackId)}/playlist.m3u8?quality=${quality}${tokenParam}`,
    rawUrl: `${base}/api/stream?pathB64=${pathB64}${tokenParam}`,
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
  isLibraryLoading: boolean;
  playlists: Playlist[];

  // Entity State (for navigation)
  artists: EntityInfo[];
  albums: EntityInfo[];
  genres: EntityInfo[];

  // Playlist State (Current Play Queue)
  playlist: TrackInfo[];

  // Scanning State
  isScanning: boolean;
  scanPhase: 'idle' | 'walk' | 'metadata' | 'analysis';
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
  isBuffering: boolean;
  castConnected: boolean;

  // Settings State (Persisted)
  volume: number;
  shuffle: boolean;
  repeat: "none" | "one" | "all";
  theme: 'light' | 'dark';
  lastFmApiKey: string;
  lastFmSharedSecret: string;
  lastFmScrobbleEnabled: boolean;
  lastFmConnected: boolean;
  lastFmUsername: string;
  geniusApiKey: string;
  musicBrainzEnabled: boolean;
  musicBrainzClientId: string;
  musicBrainzClientSecret: string;
  musicBrainzConnected: boolean;
  providerArtistImage: 'lastfm' | 'genius' | 'musicbrainz';
  providerArtistBio: 'lastfm' | 'genius';
  providerAlbumArt: 'lastfm' | 'genius' | 'musicbrainz';
  authToken: string | null; // JWT token
  streamingQuality: 'auto' | '64k' | '128k' | '160k' | '320k' | 'source';

  // Current User State
  currentUser: { id: string; username: string; role: string } | null;

  // Last.fm scrobble tracking (internal, not persisted)
  _scrobbleStartAt: number | null;
  _scrobbleEligible: boolean;

  // Global Engine Settings
  discoveryLevel: number;
  genreStrictness: number;
  artistAmnesiaLimit: number;
  llmPlaylistDiversity: number;
  genreBlendWeight: number;
  genrePenaltyCurve: number;
  llmTracksPerPlaylist: number;
  llmPlaylistCount: number;
  audioAnalysisCpu: string;
  scannerConcurrency: string;
  hubGenerationSchedule: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModelName: string;
  llmConnected: boolean; // Live connection status
  mbdbLastImported: { timestamp: number; duration: number; counts: { genres: number; aliases: number; links: number } } | null;
  genreMatrixLastRun: number | null;
  genreMatrixLastResult: string | null;
  genreMatrixProgress: string | null;
  autoFolderWalk: boolean;

  isSidebarCollapsed: boolean;
  setIsSidebarCollapsed: (collapsed: boolean) => void;

  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;

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
    phase?: 'idle' | 'walk' | 'metadata' | 'analysis',
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
  setCastConnected: (connected: boolean) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setLastFmApiKey: (key: string) => void;
  setLastFmSharedSecret: (secret: string) => void;
  setLastFmScrobbleEnabled: (enabled: boolean) => void;
  setLastFmConnected: (connected: boolean) => void;
  setLastFmUsername: (username: string) => void;
  setGeniusApiKey: (key: string) => void;
  setMusicBrainzEnabled: (enabled: boolean) => void;
  setMusicBrainzClientId: (id: string) => void;
  setMusicBrainzClientSecret: (secret: string) => void;
  setMusicBrainzConnected: (connected: boolean) => void;
  setProviderArtistImage: (provider: 'lastfm' | 'genius' | 'musicbrainz') => void;
  setProviderArtistBio: (provider: 'lastfm' | 'genius') => void;
  setProviderAlbumArt: (provider: 'lastfm' | 'genius' | 'musicbrainz') => void;
  setLlmConnected: (connected: boolean) => void;

  // Manager sync callbacks
  syncTimeUpdate: (time: number) => void;
  syncDuration: (duration: number) => void;
  syncPlaybackState: (state: PlaybackState) => void;

  // Engine session state
  sessionHistoryTrackIds: string[];
  recordPlay: (trackId: string) => void;
  recordSkip: (trackId: string) => void;

  // Toast state
  toasts: ToastItem[];
  addToast: (message: string, type: ToastType) => void;
  removeToast: (id: number) => void;

  // PWA update state
  pendingUpdate: boolean;
  setPendingUpdate: (val: boolean) => void;
}

// Remove `PlayerPersist` hack as it was unnecessary and broke inference further

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => {
      // Setup PlaybackManager callbacks to update store state
      playbackManager.setCallbacks({
        onTimeUpdate: (time) => {
          set({ currentTime: time });
          // Check scrobble eligibility (>50% duration or 4 minutes, whichever is earlier, and track >30s)
          const state = get();
          if (!state._scrobbleEligible && state._scrobbleStartAt && state.duration > 30) {
            const halfDuration = state.duration / 2;
            const threshold = Math.min(halfDuration, 240); // 4 minutes = 240s
            if (time >= threshold) {
              set({ _scrobbleEligible: true });
            }
          }
        },
        onDuration: (duration) => {
          // Only accept the player-reported duration if it's valid AND at least
          // as large as what we currently have. This prevents the early HLS
          // loadedmetadata (~10s = one segment) from overwriting the DB duration
          // that was set in playAtIndex. Once hls.js parses the full VOD playlist,
          // durationchange fires with the real total and we accept it.
          if (isFinite(duration) && duration > 0) {
            const current = get().duration;
            if (duration >= current || current === 0) {
              set({ duration });
            }
          }
        },
        onPlayStateChange: (state) => set({ playbackState: state }),
        onEnded: () => {
          // Scrobble the completed track if eligible
          const state = get();
          const { lastFmConnected, lastFmScrobbleEnabled, _scrobbleEligible, _scrobbleStartAt } = state;
          if (lastFmConnected && lastFmScrobbleEnabled && _scrobbleEligible && _scrobbleStartAt) {
            const currentTrack = state.currentIndex !== null ? state.playlist[state.currentIndex] : null;
            if (currentTrack?.artist && currentTrack?.title) {
              const authHeaders = (get() as any).getAuthHeader();
              fetch('/api/providers/lastfm/scrobble', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                  tracks: [{
                    artist: currentTrack.artist,
                    track: currentTrack.title,
                    album: currentTrack.album || '',
                    albumArtist: currentTrack.albumArtist || '',
                    duration: Math.round(state.duration),
                    timestamp: Math.floor(_scrobbleStartAt / 1000),
                    mbid: currentTrack.mbTrackId || '',
                  }]
                })
              }).catch(() => {});
            }
          }
          set({ _scrobbleStartAt: null, _scrobbleEligible: false });

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
        },
        onVolumeChange: (volume) => {
          // Sync volume from cast device → store (e.g., changed via Google Home)
          set({ volume });
        },
        onMuteChange: (_muted) => {
          // When muted, show volume as 0; volume will restore via VOLUME_LEVEL_CHANGED
          if (_muted) {
            set({ volume: 0 });
          }
          // When unmuted, VOLUME_LEVEL_CHANGED fires with the restored value
        },
        onTrackChange: (index) => {
          // Receiver auto-advanced to next track in the queue — sync sender UI
          const state = get();
          if (index !== state.currentIndex && index >= 0 && index < state.playlist.length) {
            set({
              currentIndex: index,
              currentTime: 0,
              duration: state.playlist[index].duration || 0,
              _scrobbleStartAt: Date.now(),
              _scrobbleEligible: false,
            });
          }
        },
        onBufferingChange: (isBuffering) => {
          set({ isBuffering });
        }
      });

      // Wire up CastManager state changes to the store
      setTimeout(() => {
        castManager.addStateChangeListener((castState) => {
          set({ castConnected: castState === 'CONNECTED' });
        });
      }, 0);

      return {
        // Initial State
        library: [] as TrackInfo[],
        libraryFolders: [] as string[],
        isLibraryLoading: false as boolean,
        playlists: [] as Playlist[],
        artists: [] as EntityInfo[],
        albums: [] as EntityInfo[],
        genres: [] as EntityInfo[],
        playlist: [] as TrackInfo[],

        isScanning: false as boolean,
        scanPhase: 'idle' as 'idle' | 'walk' | 'metadata' | 'analysis',
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
        isBuffering: false as boolean,
        castConnected: false as boolean,
        volume: 1,
        shuffle: false as boolean,
        repeat: "none" as "none" | "one" | "all",
        theme: 'light' as 'light' | 'dark',
        lastFmApiKey: '',
        lastFmSharedSecret: '',
        lastFmScrobbleEnabled: false as boolean,
        lastFmConnected: false as boolean,
        lastFmUsername: '',
        geniusApiKey: '',
        musicBrainzEnabled: false as boolean,
        musicBrainzClientId: '',
        musicBrainzClientSecret: '',
        musicBrainzConnected: false as boolean,
        providerArtistImage: 'lastfm' as 'lastfm' | 'genius' | 'musicbrainz',
        providerArtistBio: 'lastfm' as 'lastfm' | 'genius',
        providerAlbumArt: 'lastfm' as 'lastfm' | 'genius' | 'musicbrainz',
        authToken: null as string | null,
        streamingQuality: 'auto' as 'auto' | '64k' | '128k' | '160k' | '320k' | 'source',
        currentUser: null as { id: string; username: string; role: string } | null,

        // Last.fm scrobble state
        _scrobbleStartAt: null as number | null,
        _scrobbleEligible: false as boolean,

        isInfinityMode: true as boolean,
        isFetchingInfinity: false as boolean,


        discoveryLevel: 50,
        genreStrictness: 50,
        artistAmnesiaLimit: 50,
        llmPlaylistDiversity: 50,
        genreBlendWeight: 50,
        genrePenaltyCurve: 50,
        llmTracksPerPlaylist: 10,
        llmPlaylistCount: 3,
        audioAnalysisCpu: 'Balanced',
        scannerConcurrency: 'SSD',
        hubGenerationSchedule: 'Daily',
        llmBaseUrl: '',
        llmApiKey: '',
        llmModelName: '',
        llmConnected: false,
        mbdbLastImported: null,
        genreMatrixLastRun: null as number | null,
        genreMatrixLastResult: null as string | null,
        genreMatrixProgress: null as string | null,
        autoFolderWalk: false as boolean,

        isSidebarCollapsed: false as boolean,
        setIsSidebarCollapsed: (collapsed: boolean) => set({ isSidebarCollapsed: collapsed }),

        isSidebarOpen: false as boolean,
        setIsSidebarOpen: (open: boolean) => set({ isSidebarOpen: open }),

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
                llmPlaylistDiversity: data.llmPlaylistDiversity !== undefined ? data.llmPlaylistDiversity : 50,
                genreBlendWeight: data.genreBlendWeight !== undefined ? data.genreBlendWeight : 50,
                genrePenaltyCurve: data.genrePenaltyCurve !== undefined ? data.genrePenaltyCurve : 50,
                llmTracksPerPlaylist: data.llmTracksPerPlaylist !== undefined ? data.llmTracksPerPlaylist : 10,
                llmPlaylistCount: data.llmPlaylistCount !== undefined ? data.llmPlaylistCount : 3,
                audioAnalysisCpu: data.audioAnalysisCpu || 'Balanced',
                scannerConcurrency: data.scannerConcurrency || 'SSD',
                hubGenerationSchedule: data.hubGenerationSchedule || 'Daily',
                llmBaseUrl: data.llmBaseUrl || '',
                llmApiKey: data.llmApiKey || '',
                llmModelName: data.llmModelName || '',
                mbdbLastImported: data.mbdbLastImport || null,
                genreMatrixLastRun: data.genreMatrixLastRun || null,
                genreMatrixLastResult: data.genreMatrixLastResult || null,
                genreMatrixProgress: data.genreMatrixProgress || null,
                lastFmApiKey: data.lastFmApiKey || '',
                lastFmSharedSecret: data.lastFmSharedSecret || '',
                lastFmScrobbleEnabled: data.lastFmScrobbleEnabled ?? false,
                lastFmConnected: data.lastFmConnected ?? false,
                lastFmUsername: data.lastFmUsername || '',
                geniusApiKey: data.geniusApiKey || '',
                musicBrainzEnabled: data.musicBrainzEnabled ?? false,
                musicBrainzClientId: data.musicBrainzClientId || '',
                musicBrainzClientSecret: data.musicBrainzClientSecret || '',
                musicBrainzConnected: data.musicBrainzConnected ?? false,
                providerArtistImage: data.providerArtistImage || 'lastfm',
                providerArtistBio: data.providerArtistBio || 'lastfm',
                providerAlbumArt: data.providerAlbumArt || 'lastfm',
                autoFolderWalk: data.autoFolderWalk === 'true' || data.autoFolderWalk === true
              });

              // Auto-validate LLM connection if credentials exist
              if (data.llmBaseUrl && data.llmModelName) {
                try {
                  const healthRes = await fetch('/api/health/llm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ llmBaseUrl: data.llmBaseUrl, llmApiKey: data.llmApiKey || '' })
                  });
                  const healthData = await healthRes.json();
                  set({ llmConnected: healthRes.ok && healthData.status === 'ok' });
                } catch {
                  set({ llmConnected: false });
                }
              }
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
                llmPlaylistDiversity: state.llmPlaylistDiversity,
                genreBlendWeight: state.genreBlendWeight,
                genrePenaltyCurve: state.genrePenaltyCurve,
                llmTracksPerPlaylist: state.llmTracksPerPlaylist,
                llmPlaylistCount: state.llmPlaylistCount,
                audioAnalysisCpu: state.audioAnalysisCpu,
                scannerConcurrency: state.scannerConcurrency,
                hubGenerationSchedule: state.hubGenerationSchedule,
                llmBaseUrl: state.llmBaseUrl,
                llmApiKey: state.llmApiKey,
                llmModelName: state.llmModelName,
                lastFmApiKey: state.lastFmApiKey,
                lastFmSharedSecret: state.lastFmSharedSecret,
                lastFmScrobbleEnabled: state.lastFmScrobbleEnabled,
                geniusApiKey: state.geniusApiKey,
                musicBrainzEnabled: state.musicBrainzEnabled,
                musicBrainzClientId: state.musicBrainzClientId,
                musicBrainzClientSecret: state.musicBrainzClientSecret,
                providerArtistImage: state.providerArtistImage,
                providerArtistBio: state.providerArtistBio,
                providerAlbumArt: state.providerAlbumArt,
                autoFolderWalk: state.autoFolderWalk
              };
              await fetch('/api/settings', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json', ...authHeaders },
                 body: JSON.stringify(payload)
              });
              // Clear cached external imagery when provider settings change
              clearExternalCache();
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
                const { authToken, streamingQuality } = state;
                const token = authToken || '';
                const quality = streamingQuality === 'auto' ? '128k' : streamingQuality;

                const track = {
                  ...data.track,
                  isInfinity: true,
                  artists: typeof data.track.artists === 'string' ? JSON.parse(data.track.artists) : data.track.artists,
                  ...buildTrackUrls(data.track.id, data.track.path, token, quality),
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
          set({ isLibraryLoading: true });
          try {
            const authHeaders = (get() as any).getAuthHeader();
            const res = await fetch('/api/library', { headers: authHeaders });
            if (res.ok) {
              const data = await res.json();
              
              const { authToken, streamingQuality } = get();
              const token = authToken || '';
              const quality = streamingQuality === 'auto' ? '128k' : streamingQuality;

              const libraryWithUrls = data.tracks.map((t: any) => {
                let artistsArray = t.artists;
                if (typeof t.artists === 'string') {
                  try { artistsArray = JSON.parse(t.artists); } catch(e) {}
                }
                
                let genresArray = t.genres;
                if (typeof t.genres === 'string') {
                  try { genresArray = JSON.parse(t.genres); } catch(e) {}
                }
                
                return {
                  ...t,
                  artists: artistsArray,
                  genres: genresArray,
                  ...buildTrackUrls(t.id, t.path, token, quality),
                };
              });

              set({
                library: libraryWithUrls,
                libraryFolders: data.directories,
                artists: data.artists || [],
                albums: data.albums || [],
                genres: data.genres || [],
                isLibraryLoading: false,
              });
            } else {
              set({ isLibraryLoading: false });
            }
          } catch (e) {
            console.error("Failed to fetch library from server", e);
            set({ isLibraryLoading: false });
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
                       const quality = (get().streamingQuality === 'auto' ? '128k' : get().streamingQuality);
                       return {
                         ...track,
                         ...buildTrackUrls(track.id, track.path, token, quality),
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
              
              const { authToken, streamingQuality } = get();
              const token = authToken || '';
              const quality = streamingQuality === 'auto' ? '128k' : streamingQuality;

               const latestLibrary = data.tracks.map((t: any) => {
                let artistsArray = t.artists;
                if (typeof t.artists === 'string') {
                  try { artistsArray = JSON.parse(t.artists); } catch(e) {}
                }
                
                return {
                  ...t,
                  artists: artistsArray,
                  ...buildTrackUrls(t.id, t.path, token, quality),
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
          const { playlist, volume, repeat } = get();
          const track = playlist[index];
          if (!track) return;

          const generation = ++playGeneration;

          // Immediately set the DB-known duration so the UI doesn't flash "0:10"
          // while waiting for hls.js to parse the full manifest.
          set({ currentTime: 0, duration: track.duration || 0, isBuffering: true });

          try {
            // Set volume before playing
            playbackManager.setVolume(volume);

            if (castManager.isConnected()) {
              // Use rawUrl (direct file) for cast — the Default Media Receiver cannot play HLS
              await castManager.castMedia(
                track.rawUrl || track.url || '',
                track.title || 'Unknown Title',
                track.artist || ((track.artists as string[])?.join(', ')) || 'Unknown Artist',
                track.artUrl,
                track.album,
                track.format
              );
            } else if (track.url) {
              // Not casting: play locally
              await playbackManager.playUrl(track.url, track.title, track.artist || ((track.artists as string[])?.join(', ')), track.artUrl, track.album, track.format);
            } else if (track.fileHandle) {
               // Fallback for local file handles
               await playbackManager.playFile(track.fileHandle);
            }
            // A newer playAtIndex call has taken over — discard this result
            if (generation !== playGeneration) return;
            set({ currentIndex: index, isBuffering: false, _scrobbleStartAt: Date.now(), _scrobbleEligible: false });

            // Telemetry: record successful playback and push to session history
            get().recordPlay(track.id);

            // Send "now playing" to Last.fm if connected
            const state = get();
            if (state.lastFmConnected && state.lastFmScrobbleEnabled && track.artist && track.title) {
              const authHeaders = (get() as any).getAuthHeader();
              fetch('/api/providers/lastfm/now-playing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                  artist: track.artist,
                  track: track.title,
                  album: track.album || '',
                  albumArtist: track.albumArtist || '',
                  duration: track.duration ? Math.round(track.duration) : undefined,
                  mbid: track.mbTrackId || '',
                })
              }).catch(() => {});
            }

            // Pre-fetch infinite track if bounds are reached
            get().ensureInfinityQueue();
          } catch (e) {
            // A newer playAtIndex call has taken over — don't chain into nextTrack
            if (generation !== playGeneration) return;
            set({ isBuffering: false });
            console.error("Error playing track", e);
            get().nextTrack();
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

        setCastConnected: (connected: boolean) => set({ castConnected: connected }),

        syncTimeUpdate: (time: number) => set({ currentTime: time }),
        syncDuration: (duration: number) => set({ duration }),
        syncPlaybackState: (state: PlaybackState) => set({ playbackState: state }),
        
        setLastFmApiKey: (key: string) => set({ lastFmApiKey: key }),
        setLastFmSharedSecret: (secret: string) => set({ lastFmSharedSecret: secret }),
        setLastFmScrobbleEnabled: (enabled: boolean) => set({ lastFmScrobbleEnabled: enabled }),
        setLastFmConnected: (connected: boolean) => set({ lastFmConnected: connected }),
        setLastFmUsername: (username: string) => set({ lastFmUsername: username }),
        setGeniusApiKey: (key: string) => set({ geniusApiKey: key }),
        setMusicBrainzEnabled: (enabled: boolean) => set({ musicBrainzEnabled: enabled }),
        setMusicBrainzClientId: (id: string) => set({ musicBrainzClientId: id }),
        setMusicBrainzClientSecret: (secret: string) => set({ musicBrainzClientSecret: secret }),
        setMusicBrainzConnected: (connected: boolean) => set({ musicBrainzConnected: connected }),
        setProviderArtistImage: (provider: 'lastfm' | 'genius' | 'musicbrainz') => set({ providerArtistImage: provider }),
        setProviderArtistBio: (provider: 'lastfm' | 'genius') => set({ providerArtistBio: provider }),
        setProviderAlbumArt: (provider: 'lastfm' | 'genius' | 'musicbrainz') => set({ providerAlbumArt: provider }),
        setLlmConnected: (connected: boolean) => set({ llmConnected: connected }),

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

        toasts: [],
        addToast: (message: string, type: ToastType) => {
          const id = Date.now();
          set((state: PlayerState) => ({
            toasts: [...state.toasts, { id, message, type }]
          }));
          setTimeout(() => {
            get().removeToast(id);
          }, 4000);
        },
        removeToast: (id: number) => {
          set((state: PlayerState) => ({
            toasts: state.toasts.filter(t => t.id !== id)
          }));
        },

        pendingUpdate: false,
        setPendingUpdate: (val: boolean) => {
          set({ pendingUpdate: val } as Partial<PlayerState>);
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
        lastFmScrobbleEnabled: state.lastFmScrobbleEnabled,
        lastFmConnected: state.lastFmConnected,
        lastFmUsername: state.lastFmUsername,
        geniusApiKey: state.geniusApiKey,
        musicBrainzEnabled: state.musicBrainzEnabled,
        musicBrainzClientId: state.musicBrainzClientId,
        musicBrainzClientSecret: state.musicBrainzClientSecret,
        musicBrainzConnected: state.musicBrainzConnected,
        llmConnected: state.llmConnected,
        providerArtistImage: state.providerArtistImage,
        providerArtistBio: state.providerArtistBio,
        providerAlbumArt: state.providerAlbumArt,
        authToken: state.authToken,
        currentUser: state.currentUser,
        streamingQuality: state.streamingQuality,
        // Persist playlist + position for cast session recovery
        playlist: state.playlist ? state.playlist.map((t: TrackInfo) => {
          const { fileHandle, ...rest } = t;
          return rest;
        }) : [],
        currentIndex: state.currentIndex,
        currentTime: state.currentTime,
        castConnected: state.castConnected,
      }),
    }
  )
);
