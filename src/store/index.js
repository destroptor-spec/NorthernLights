import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { playbackManager } from '../utils/PlaybackManager';
// Remove `PlayerPersist` hack as it was unnecessary and broke inference further
export const usePlayerStore = create()(persist((set, get) => {
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
                get().playAtIndex(get().currentIndex);
            }
            else if (repeat === 'none') {
                // Stop at end of list
                const currentIdx = get().currentIndex;
                if (currentIdx < get().playlist.length - 1 || get().shuffle) {
                    nextTrack();
                }
                else if (get().isInfinityMode) {
                    // Infinity Mode bounds reached! Fetch the next track natively
                    fetchNextInfinityTrack(false);
                }
                else {
                    stop();
                }
            }
            else {
                // repeat === 'all'
                nextTrack();
            }
        }
    });
    return {
        // Initial State
        library: [],
        libraryFolders: [],
        playlists: [],
        playlist: [],
        currentView: 'home',
        selectedItem: null,
        isScanning: false,
        scanPhase: 'idle',
        scannedFiles: 0,
        totalFiles: 0,
        activeWorkers: 0,
        activeFiles: [],
        scanningFile: null,
        needsSetup: null,
        currentIndex: null,
        playbackState: 'stopped',
        currentTime: 0,
        duration: 0,
        volume: 1,
        shuffle: false,
        repeat: "none",
        theme: 'light',
        lastFmApiKey: '',
        geniusApiKey: '',
        preferredProvider: 'lastfm',
        authToken: null,
        isInfinityMode: true,
        isFetchingInfinity: false,
        discoveryLevel: 50,
        genreStrictness: 50,
        artistAmnesiaLimit: 50,
        audioAnalysisCpu: 'Balanced',
        hubGenerationSchedule: 'Daily',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmApiKey: '',
        llmModelName: 'gpt-4',
        genreMatrixLastRun: null,
        genreMatrixLastResult: null,
        sessionHistoryTrackIds: [],
        // Actions
        checkSetupStatus: async () => {
            try {
                const res = await fetch('/api/setup/status');
                if (res.ok) {
                    const data = await res.json();
                    set({ needsSetup: data.needsSetup });
                }
            }
            catch (e) {
                console.error("Failed to check setup status", e);
                set({ needsSetup: false }); // Fallback assuming standard boot
            }
        },
        setIsScanning: (isScanning, phase = 'idle', scanned = 0, total = 0, workers = 0, activeFiles = [], fileName = null) => set({
            isScanning,
            scanPhase: phase,
            scannedFiles: scanned,
            totalFiles: total,
            activeWorkers: workers,
            activeFiles,
            scanningFile: fileName
        }),
        setTheme: (theme) => {
            set({ theme });
            if (theme === 'dark') {
                document.documentElement.classList.add('dark');
            }
            else {
                document.documentElement.classList.remove('dark');
            }
        },
        setAuthToken: (token) => set({ authToken: token }),
        // Helper for Auth Header
        getAuthHeader: () => {
            const { authToken } = get();
            if (authToken) {
                return { 'Authorization': 'Basic ' + authToken };
            }
            // The browser will use its native basic auth popup if no authorization header is explicit
            return {};
        },
        setSettings: (settings) => {
            set((state) => ({ ...state, ...settings }));
        },
        loadSettings: async () => {
            try {
                const authHeaders = get().getAuthHeader();
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
                        genreMatrixLastResult: data.genreMatrixLastResult || null
                    });
                }
            }
            catch (e) {
                console.error('Failed to load DB settings', e);
            }
        },
        saveSettings: async () => {
            try {
                const state = get();
                const authHeaders = state.getAuthHeader();
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
            }
            catch (e) {
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
            if (!state.isInfinityMode || state.isFetchingInfinity)
                return;
            const currentIndex = state.currentIndex !== null ? state.currentIndex : 0;
            const remaining = Math.max(0, state.playlist.length - 1 - currentIndex);
            // Prefetch if there are no upcoming tracks in the queue
            if (remaining < 1 && state.playlist.length > 0) {
                await get().fetchNextInfinityTrack(true);
            }
        },
        fetchNextInfinityTrack: async (isPrefetch = false) => {
            const state = get();
            if (state.isFetchingInfinity)
                return;
            set({ isFetchingInfinity: true });
            try {
                const authHeaders = state.getAuthHeader();
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
                        const host = window.location.host;
                        const protocol = window.location.protocol;
                        const safeBtoa = (str) => {
                            return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => {
                                return String.fromCharCode(parseInt(p1, 16));
                            }));
                        };
                        const track = {
                            ...data.track,
                            isInfinity: true,
                            artists: typeof data.track.artists === 'string' ? JSON.parse(data.track.artists) : data.track.artists,
                            url: `${protocol}//${host}/api/stream?pathB64=${safeBtoa(data.track.path)}${token ? '&token=' + token : ''}`,
                            artUrl: `${protocol}//${host}/api/art?pathB64=${safeBtoa(data.track.path)}${token ? '&token=' + token : ''}`
                        };
                        get().addTrackToPlaylist(track);
                        if (!isPrefetch) {
                            get().playAtIndex(state.playlist.length); // Play the newly appended track
                        }
                    }
                    else if (!isPrefetch) {
                        get().stop();
                    }
                }
                else if (!isPrefetch) {
                    get().stop();
                }
            }
            catch (e) {
                console.error("Failed to fetch infinity track", e);
                if (!isPrefetch)
                    get().stop();
            }
            finally {
                set({ isFetchingInfinity: false });
            }
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
                    // Helper to safely base64 encode strings that might contain multibyte characters
                    const safeBtoa = (str) => {
                        return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => {
                            return String.fromCharCode(parseInt(p1, 16));
                        }));
                    };
                    const libraryWithUrls = data.tracks.map((t) => {
                        let artistsArray = t.artists;
                        if (typeof t.artists === 'string') {
                            try {
                                artistsArray = JSON.parse(t.artists);
                            }
                            catch (e) { }
                        }
                        return {
                            ...t,
                            artists: artistsArray,
                            url: `${protocol}//${host}/api/stream?pathB64=${safeBtoa(t.path)}${token ? `&token=${token}` : ''}`,
                            artUrl: `${protocol}//${host}/api/art?pathB64=${safeBtoa(t.path)}${token ? `&token=${token}` : ''}`
                        };
                    });
                    set({ library: libraryWithUrls, libraryFolders: data.directories });
                }
            }
            catch (e) {
                console.error("Failed to fetch library from server", e);
            }
        },
        fetchPlaylistsFromServer: async () => {
            try {
                const authHeaders = get().getAuthHeader();
                const res = await fetch('/api/playlists', { headers: authHeaders });
                if (res.ok) {
                    const data = await res.json();
                    const { authToken, library } = get();
                    const token = authToken || '';
                    const host = window.location.host;
                    const protocol = window.location.protocol;
                    const safeBtoa = (str) => {
                        return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => {
                            return String.fromCharCode(parseInt(p1, 16));
                        }));
                    };
                    // Map track objects inside playlists to have full stream URLs
                    const populatedPlaylists = data.playlists.map((pl) => {
                        const mappedTracks = pl.tracks.map((t) => {
                            const fullTrack = library.find((lt) => lt.id === t.id);
                            if (!fullTrack)
                                return null;
                            return {
                                ...fullTrack,
                                url: `${protocol}//${host}/api/stream?pathB64=${safeBtoa(fullTrack.path)}${token ? `&token=${token}` : ''}`,
                                artUrl: `${protocol}//${host}/api/art?pathB64=${safeBtoa(fullTrack.path)}${token ? `&token=${token}` : ''}`
                            };
                        }).filter(Boolean);
                        return { ...pl, tracks: mappedTracks };
                    });
                    set({ playlists: populatedPlaylists });
                }
            }
            catch (e) {
                console.error("Failed to fetch playlists from server", e);
            }
        },
        createPlaylist: async (title, description) => {
            try {
                const authHeaders = get().getAuthHeader();
                const res = await fetch('/api/playlists', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ title, description })
                });
                if (res.ok) {
                    await get().fetchPlaylistsFromServer();
                }
            }
            catch (e) {
                console.error("Failed to create playlist", e);
            }
        },
        addTracksToUserPlaylist: async (playlistId, trackIds) => {
            try {
                const authHeaders = get().getAuthHeader();
                const res = await fetch(`/api/playlists/${playlistId}/tracks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ trackIds })
                });
                if (res.ok) {
                    await get().fetchPlaylistsFromServer();
                }
            }
            catch (e) {
                console.error(`Failed to add tracks to playlist ${playlistId}`, e);
            }
        },
        addTracksToLibrary: (newTracks) => set((state) => {
            const existingIds = new Set(state.library.map(t => t.id));
            const uniqueNew = newTracks.filter(t => !existingIds.has(t.id));
            if (uniqueNew.length === 0)
                return state;
            return { library: [...state.library, ...uniqueNew] };
        }),
        deleteTrackFromLibrary: async (trackId) => {
            // This would ideally hit a DELETE /api/library/:id endpoint
            // For now we just remove from UI state
            set((state) => {
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
        addLibraryFolder: async (folderPath) => {
            const state = get();
            if (state.libraryFolders.includes(folderPath))
                return;
            set({ libraryFolders: [...state.libraryFolders, folderPath] });
            try {
                const authHeaders = get().getAuthHeader();
                // Instantly register the folder to the DB so page refreshes don't lose it
                await fetch('/api/library/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ path: folderPath })
                });
                // Queue a scan for JUST this newly added folder
                await get().rescanLibrary(folderPath);
            }
            catch (e) {
                console.error('Failed to add and scan folder', e);
            }
        },
        removeLibraryFolder: async (folderPath) => {
            set((state) => ({
                libraryFolders: state.libraryFolders.filter((f) => f !== folderPath)
            }));
            try {
                const authHeaders = get().getAuthHeader();
                await fetch('/api/library/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ path: folderPath })
                });
                await get().fetchLibraryFromServer();
            }
            catch (e) {
                console.error('Failed to remove folder from backend', e);
            }
        },
        rescanLibrary: async (specificFolder) => {
            const state = get();
            const foldersToScan = specificFolder ? [specificFolder] : state.libraryFolders;
            // Trigger scans sequentially with backoff
            for (const folderPath of foldersToScan) {
                let scanStarted = false;
                while (!scanStarted) {
                    try {
                        const authHeaders = get().getAuthHeader();
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
                            }
                            else {
                                console.error('Scan error:', errorData.error);
                                scanStarted = true; // other 400 error, skip
                            }
                        }
                        else if (!res.ok) {
                            console.error('Scan error:', res.statusText);
                            scanStarted = true; // other error, skip
                        }
                        else {
                            scanStarted = true; // Success
                        }
                    }
                    catch (e) {
                        console.error(`Failed to trigger scan for ${folderPath}`, e);
                        scanStarted = true;
                    }
                }
            }
            // Fetch the final library to reflect the new tracks
            try {
                const authHeaders = get().getAuthHeader();
                const fetchRes = await fetch('/api/library', { headers: authHeaders });
                if (fetchRes.ok) {
                    const data = await fetchRes.json();
                    const { authToken } = get();
                    const token = authToken || '';
                    const host = window.location.host;
                    const protocol = window.location.protocol;
                    const safeBtoa = (str) => {
                        return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => {
                            return String.fromCharCode(parseInt(p1, 16));
                        }));
                    };
                    const latestLibrary = data.tracks.map((t) => {
                        let artistsArray = t.artists;
                        if (typeof t.artists === 'string') {
                            try {
                                artistsArray = JSON.parse(t.artists);
                            }
                            catch (e) { }
                        }
                        const streamUrl = new URL(`${protocol}//${host}/api/stream`);
                        streamUrl.searchParams.append('pathB64', safeBtoa(t.path));
                        if (token)
                            streamUrl.searchParams.append('token', token);
                        const artUrlObj = new URL(`${protocol}//${host}/api/art`);
                        artUrlObj.searchParams.append('pathB64', safeBtoa(t.path));
                        if (token)
                            artUrlObj.searchParams.append('token', token);
                        return {
                            ...t,
                            artists: artistsArray,
                            url: streamUrl.toString(),
                            artUrl: artUrlObj.toString()
                        };
                    });
                    set({ library: latestLibrary });
                }
            }
            catch (e) {
                console.error('Failed to fetch updated library', e);
            }
        },
        setPlaylist: async (playlist, startIndex = 0) => {
            set({ playlist, currentIndex: startIndex });
            if (playlist.length > 0 && startIndex < playlist.length) {
                await get().playAtIndex(startIndex);
            }
            else {
                get().stop();
            }
        },
        addTrackToPlaylist: (track) => set((state) => {
            return { playlist: [...state.playlist, track] };
        }),
        playNext: (track) => set((state) => {
            const newPlaylist = [...state.playlist];
            const insertAt = state.currentIndex !== null ? state.currentIndex + 1 : newPlaylist.length;
            newPlaylist.splice(insertAt, 0, track);
            return { playlist: newPlaylist };
        }),
        // Global context menu
        contextMenu: null,
        openContextMenu: (track, x, y) => set({ contextMenu: { track, x, y } }),
        closeContextMenu: () => set({ contextMenu: null }),
        removeFromPlaylist: (index) => set((state) => {
            const newPlaylist = [...state.playlist];
            newPlaylist.splice(index, 1);
            let newIndex = state.currentIndex;
            if (state.currentIndex === index) {
                playbackManager.stop();
                newIndex = null;
            }
            else if (state.currentIndex !== null && index < state.currentIndex) {
                newIndex = state.currentIndex - 1;
            }
            return { playlist: newPlaylist, currentIndex: newIndex };
        }),
        moveInPlaylist: (fromIndex, toIndex) => set((state) => {
            const newPlaylist = [...state.playlist];
            const [moved] = newPlaylist.splice(fromIndex, 1);
            if (!moved)
                return state;
            newPlaylist.splice(toIndex, 0, moved);
            let newIndex = state.currentIndex;
            if (state.currentIndex !== null) {
                if (state.currentIndex === fromIndex) {
                    newIndex = toIndex;
                }
                else {
                    if (fromIndex < state.currentIndex && toIndex >= state.currentIndex)
                        newIndex = state.currentIndex - 1;
                    if (fromIndex > state.currentIndex && toIndex <= state.currentIndex)
                        newIndex = state.currentIndex + 1;
                }
            }
            return { playlist: newPlaylist, currentIndex: newIndex };
        }),
        navigateView: (view, item = null) => {
            set({ currentView: view, selectedItem: item });
        },
        // Playback Actions
        playAtIndex: async (index) => {
            const { playlist, volume } = get();
            const track = playlist[index];
            if (!track)
                return;
            try {
                // Set volume before playing
                playbackManager.setVolume(volume);
                // Play using the HTTP stream URL
                if (track.url) {
                    await playbackManager.playUrl(track.url);
                }
                else if (track.fileHandle) {
                    // Fallback
                    await playbackManager.playFile(track.fileHandle);
                }
                set({ currentIndex: index });
                // Telemetry: record successful playback and push to session history
                get().recordPlay(track.id);
                // Pre-fetch infinite track if bounds are reached
                get().ensureInfinityQueue();
            }
            catch (e) {
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
            if (playlist.length === 0)
                return;
            // Telemetry: record skip for the track we are leaving
            if (currentIndex !== null && playlist[currentIndex]) {
                get().recordSkip(playlist[currentIndex].id);
            }
            let nextIndex = 0;
            if (shuffle) {
                nextIndex = Math.floor(Math.random() * playlist.length);
            }
            else if (currentIndex !== null) {
                nextIndex = (currentIndex + 1) % playlist.length;
            }
            await get().playAtIndex(nextIndex);
        },
        prevTrack: async () => {
            const { playlist, currentIndex, currentTime } = get();
            if (playlist.length === 0)
                return;
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
        setVolume: (v) => {
            playbackManager.setVolume(v);
            set({ volume: v });
        },
        toggleShuffle: () => set((state) => ({ shuffle: !state.shuffle })),
        cycleRepeat: () => set((state) => {
            const nextMode = state.repeat === 'none' ? 'all' : state.repeat === 'all' ? 'one' : 'none';
            return { repeat: nextMode };
        }),
        syncTimeUpdate: (time) => set({ currentTime: time }),
        syncDuration: (duration) => set({ duration }),
        syncPlaybackState: (state) => set({ playbackState: state }),
        setLastFmApiKey: (key) => set({ lastFmApiKey: key }),
        setGeniusApiKey: (key) => set({ geniusApiKey: key }),
        setPreferredProvider: (provider) => set({ preferredProvider: provider }),
        recordPlay: (trackId) => {
            // Push trackId to the 50-item rolling session history
            set((state) => {
                const updated = [...state.sessionHistoryTrackIds, trackId].slice(-50);
                return { sessionHistoryTrackIds: updated };
            });
            // Fire-and-forget telemetry to backend
            const authHeaders = get().getAuthHeader();
            fetch('/api/playback/record', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ trackId })
            }).catch((e) => console.warn('Telemetry record failed:', e));
        },
        recordSkip: (trackId) => {
            // Fire-and-forget telemetry to backend
            const authHeaders = get().getAuthHeader();
            fetch('/api/playback/skip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ trackId })
            }).catch((e) => console.warn('Telemetry skip failed:', e));
        },
    };
}, {
    name: "player-store",
    // Only persist lightweight user settings, NOT the library.
    // The library is always fetched fresh from the server on boot.
    partialize: (state) => ({
        volume: state.volume,
        shuffle: state.shuffle,
        repeat: state.repeat,
        theme: state.theme,
        lastFmApiKey: state.lastFmApiKey,
        geniusApiKey: state.geniusApiKey,
        preferredProvider: state.preferredProvider,
        authToken: state.authToken,
        // We do *not* persist DB settings (API keys) in localStorage, we ONLY load them from DB on mount
        // by calling loadSettings() from an effect in the app root
    }),
}));
