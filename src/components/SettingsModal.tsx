import React, { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/index';
import { useLlmConnectionTest } from '../hooks/useLlmConnectionTest';
import { useProviderConnectionTest } from '../hooks/useProviderConnectionTest';
import { ConfirmModal } from './ConfirmModal';
import { PromptModal } from './PromptModal';
import { Toast, type ToastType } from './Toast';
import { Folder, User, Palette, Play, Cpu, Globe, LogOut, Search, X, Shield, Users, Link, Trash2, Plus, Copy, Check, Database, BarChart2, Wrench, Radio, Brain } from 'lucide-react';
import { DatabaseControl } from './DatabaseControl';

interface SettingsModalProps {
    onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
    const libraryFolders = usePlayerStore(state => state.libraryFolders);
    const addLibraryFolder = usePlayerStore(state => state.addLibraryFolder);
    const removeLibraryFolder = usePlayerStore(state => state.removeLibraryFolder);
    const theme = usePlayerStore(state => state.theme);
    const setTheme = usePlayerStore(state => state.setTheme);
    const lastFmApiKey = usePlayerStore(state => state.lastFmApiKey);
    const setLastFmApiKey = usePlayerStore(state => state.setLastFmApiKey);
    const lastFmSharedSecret = usePlayerStore(state => state.lastFmSharedSecret);
    const setLastFmSharedSecret = usePlayerStore(state => state.setLastFmSharedSecret);
    const lastFmScrobbleEnabled = usePlayerStore(state => state.lastFmScrobbleEnabled);
    const setLastFmScrobbleEnabled = usePlayerStore(state => state.setLastFmScrobbleEnabled);
    const lastFmConnected = usePlayerStore(state => state.lastFmConnected);
    const setLastFmConnected = usePlayerStore(state => state.setLastFmConnected);
    const lastFmUsername = usePlayerStore(state => state.lastFmUsername);
    const setLastFmUsername = usePlayerStore(state => state.setLastFmUsername);
    const geniusApiKey = usePlayerStore(state => state.geniusApiKey);
    const setGeniusApiKey = usePlayerStore(state => state.setGeniusApiKey);
    const musicBrainzEnabled = usePlayerStore(state => state.musicBrainzEnabled);
    const setMusicBrainzEnabled = usePlayerStore(state => state.setMusicBrainzEnabled);
    const musicBrainzClientId = usePlayerStore(state => state.musicBrainzClientId);
    const setMusicBrainzClientId = usePlayerStore(state => state.setMusicBrainzClientId);
    const musicBrainzClientSecret = usePlayerStore(state => state.musicBrainzClientSecret);
    const setMusicBrainzClientSecret = usePlayerStore(state => state.setMusicBrainzClientSecret);
    const musicBrainzConnected = usePlayerStore(state => state.musicBrainzConnected);
    const setMusicBrainzConnected = usePlayerStore(state => state.setMusicBrainzConnected);
    const providerArtistImage = usePlayerStore(state => state.providerArtistImage);
    const setProviderArtistImage = usePlayerStore(state => state.setProviderArtistImage);
    const providerArtistBio = usePlayerStore(state => state.providerArtistBio);
    const setProviderArtistBio = usePlayerStore(state => state.setProviderArtistBio);
    const providerAlbumArt = usePlayerStore(state => state.providerAlbumArt);
    const setProviderAlbumArt = usePlayerStore(state => state.setProviderAlbumArt);

    const discoveryLevel = usePlayerStore(state => state.discoveryLevel);
    const genreStrictness = usePlayerStore(state => state.genreStrictness);
    const artistAmnesiaLimit = usePlayerStore(state => state.artistAmnesiaLimit);
    const llmPlaylistDiversity = usePlayerStore(state => state.llmPlaylistDiversity);
    const genreBlendWeight = usePlayerStore(state => state.genreBlendWeight);
    const llmTracksPerPlaylist = usePlayerStore(state => state.llmTracksPerPlaylist);
    const llmPlaylistCount = usePlayerStore(state => state.llmPlaylistCount);
    const audioAnalysisCpu = usePlayerStore(state => state.audioAnalysisCpu);
    const scannerConcurrency = usePlayerStore(state => state.scannerConcurrency);
    const hubGenerationSchedule = usePlayerStore(state => state.hubGenerationSchedule);
    const llmBaseUrl = usePlayerStore(state => state.llmBaseUrl);
    const llmApiKey = usePlayerStore(state => state.llmApiKey);
    const llmModelName = usePlayerStore(state => state.llmModelName);
    const genreMatrixLastRun = usePlayerStore(state => state.genreMatrixLastRun);
    const genreMatrixLastResult = usePlayerStore(state => state.genreMatrixLastResult);
    const genreMatrixProgress = usePlayerStore(state => state.genreMatrixProgress);
    const setSettings = usePlayerStore(state => state.setSettings);
    const saveSettings = usePlayerStore(state => state.saveSettings);
    const loadSettings = usePlayerStore(state => state.loadSettings);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);
    const library = usePlayerStore(state => state.library);
    const currentUser = usePlayerStore(state => state.currentUser);
    const isScanning = usePlayerStore(state => state.isScanning);
    const autoFolderWalk = usePlayerStore(state => state.autoFolderWalk);
    
    const [isClosing, setIsClosing] = useState(false);
    const [isRunningMatrix, setIsRunningMatrix] = useState(false);
    const [mappings, setMappings] = useState<Record<string, string>>({});
    const [dirStats, setDirStats] = useState<Record<string, { totalTracks: number; withMetadata: number; analyzed: number }>>({});
    const [dirStatsLoading, setDirStatsLoading] = useState(false);

    // Dialog state
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
    const [promptDialog, setPromptDialog] = useState<{ title: string; label?: string; placeholder?: string; onSubmit: (value: string) => void } | null>(null);
    const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);

    const showToast = useCallback((message: string, type: ToastType) => {
        setToast(null);
        setTimeout(() => setToast({ message, type }), 0);
    }, []);

    // 1. On mount: fetch latest settings and mappings
    React.useEffect(() => {
        loadSettings();
        fetchMappings();
    }, []);

    // 1b. Check Last.fm configuration status
    React.useEffect(() => {
        const fetchLastFmStatus = async () => {
            try {
                const authHeaders = getAuthHeader();
                const res = await fetch('/api/providers/lastfm/status', { headers: authHeaders });
                if (res.ok) {
                    const data = await res.json();
                    setLastFmConfigured(!!data.hasApiKey);
                }
            } catch {}
        };
        fetchLastFmStatus();
    }, [getAuthHeader]);

    // 2. Initialize/Sync isRunningMatrix based on progress string
    React.useEffect(() => {
        const isActive = !!genreMatrixProgress && 
                         genreMatrixProgress !== 'Complete' && 
                        !genreMatrixProgress.startsWith('Error') &&
                        !genreMatrixProgress.startsWith('Interrupted') &&
                        !genreMatrixProgress.startsWith('All genres');
        setIsRunningMatrix(isActive);
    }, [genreMatrixProgress]);

    // 3. Poll while progress is active
    React.useEffect(() => {
        let interval: any;
        if (isRunningMatrix) {
            interval = setInterval(() => {
                loadSettings();
                fetchMappings();
            }, 2000);
        }
        return () => clearInterval(interval);
    }, [isRunningMatrix, loadSettings]);

    const {
        connectionStatus,
        connectionMessage,
        availableModels,
        showModelDropdown,
        setShowModelDropdown,
        testLlmConnection: runConnectionTest,
    } = useLlmConnectionTest({
        getAuthHeader,
        onModelsReceived: (models) => {
            if (!llmModelName) setSettings({ llmModelName: models[0] });
        },
    });

    const {
        lastFmStatus,
        lastFmMessage,
        geniusStatus,
        geniusMessage,
        musicBrainzStatus,
        musicBrainzMessage,
        testLastFm,
        testGenius,
        testMusicBrainz,
    } = useProviderConnectionTest();

    const fetchMappings = async () => {
        try {
            const authHeaders = getAuthHeader();
            const res = await fetch('/api/genre-matrix/mappings', { headers: authHeaders });
            if (res.ok) setMappings(await res.json());
        } catch(e) { console.error('Failed to fetch mappings', e); }
    };

    const handleRunMatrix = async () => {
        setIsRunningMatrix(true);
        try {
            const authHeaders = getAuthHeader();
            const res = await fetch('/api/genre-matrix/regenerate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders }
            });
            const data = await res.json();
            if (res.ok) {
                setSettings({
                    genreMatrixLastRun: data.lastRun,
                    genreMatrixLastResult: data.lastResult
                });
            }
        } catch (e) {
            console.error('Failed to run genre matrix', e);
        }
    };

    const handleRemapAll = async () => {
        setConfirmDialog({
            title: 'Remap All Genres',
            message: 'This will clear ALL existing genre mappings and re-categorize your entire library into the new 39-genre ontology.',
            confirmLabel: 'Remap All',
            onConfirm: async () => {
                setConfirmDialog(null);
                setIsRunningMatrix(true);
                try {
                    const authHeaders = getAuthHeader();
                    await fetch('/api/genre-matrix/remap-all', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders }
                    });
                } catch (e) {
                    console.error('Failed to start remap', e);
                    setIsRunningMatrix(false);
                }
            },
        });
    };

    // Auto-disable isRunningMatrix when progress is "Complete"
    React.useEffect(() => {
        if (genreMatrixProgress === 'Complete' || 
            (genreMatrixProgress && (genreMatrixProgress.startsWith('Error') || genreMatrixProgress.startsWith('Interrupted')))
        ) {
            setIsRunningMatrix(false);
        }
    }, [genreMatrixProgress]);

    const distinctGenres = Array.from(new Set(library.map(t => (t.genre || '').toLowerCase().trim()).filter(Boolean)));
    const mappedCount = distinctGenres.filter(g => mappings[g.toLowerCase().replace(/[^\w\s-]/g, '')]).length;
    const coveragePercent = distinctGenres.length > 0 ? Math.round((mappedCount / distinctGenres.length) * 100) : 100;

    const handleClose = async () => {
        setIsClosing(true);
        await saveSettings();
        setTimeout(() => onClose(), 280); 
    };

    const handleAddFolder = async () => {
        setPromptDialog({
            title: 'Map Folder Path',
            label: 'Enter the absolute path to your music folder on the server.',
            placeholder: '/home/andreas/Music',
            onSubmit: async (path) => {
                setPromptDialog(null);
                const addLibraryFolder = usePlayerStore.getState().addLibraryFolder;
                await addLibraryFolder(path);
                fetchDirStats();
            },
        });
    };

    const handleRescanFolder = async (folderPath: string) => {
        try {
            const authHeaders = getAuthHeader();
            let scanStarted = false;
            while (!scanStarted) {
                const res = await fetch('/api/library/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ path: folderPath })
                });
                if (res.status === 400) {
                    const errorData = await res.json().catch(() => ({}));
                    if (errorData.error === 'Scan already in progress') {
                        await new Promise(r => setTimeout(r, 1000));
                    } else {
                        console.error('Rescan error:', errorData.error);
                        scanStarted = true;
                    }
                } else {
                    scanStarted = true;
                }
            }
            await fetchLibraryFromServer();
            fetchDirStats();
        } catch (e) {
            console.error('Failed to rescan folder', e);
        }
    };

    const handleRemoveFolder = async (folderPath: string) => {
        await removeLibraryFolder(folderPath);
        fetchDirStats();
    };

    const handleAnalyze = async () => {
        try {
            const authHeaders = getAuthHeader();
            await fetch('/api/library/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ force: false })
            });
            fetchDirStats();
        } catch (e) {
            console.error('Failed to start analysis', e);
        }
    };

    const handleForceAnalyze = async () => {
        setConfirmDialog({
            title: 'Re-analyze All Tracks',
            message: 'This will re-run audio analysis on your entire library, replacing existing feature data. This may take several minutes.',
            confirmLabel: 'Re-analyze All',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    const authHeaders = getAuthHeader();
                    await fetch('/api/library/analyze', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders },
                        body: JSON.stringify({ force: true })
                    });
                    fetchDirStats();
                } catch (e) {
                    console.error('Failed to start re-analysis', e);
                }
            },
        });
    };

    const handleManualHubRegen = async () => {
        setConfirmDialog({
            title: 'Reset Hub',
            message: 'This will delete ALL existing LLM-generated playlists and regenerate fresh ones. User-created playlists will not be affected.',
            confirmLabel: 'Reset Hub',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    const authHeaders = getAuthHeader();
                    await fetch('/api/hub/regenerate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders },
                        body: JSON.stringify({ force: true })
                    });
                    showToast('Hub reset triggered. Playlists are being regenerated in the background.', 'success');
                } catch(e) {
                    console.error(e);
                    showToast('Failed to request reset', 'error');
                }
            },
        });
    };

    const handleCleanupPlaylists = async () => {
        setConfirmDialog({
            title: 'Clean Orphaned Playlists',
            message: 'This will permanently delete any playlists that do not belong to a valid user. This action cannot be undone.',
            confirmLabel: 'Clean Up',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    const authHeaders = getAuthHeader();
                    const res = await fetch('/api/admin/cleanup-playlists', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders }
                    });
                    let data: any = {};
                    try { data = await res.json(); } catch {}
                    if (res.ok) {
                        showToast(`Cleanup complete. Deleted ${data.deletedCount} orphaned playlist(s).`, 'success');
                    } else {
                        showToast(data.error || `Server error: ${res.status} ${res.statusText}`, 'error');
                    }
                } catch(e) {
                    console.error(e);
                    showToast('Failed to connect to server', 'error');
                }
            },
        });
    };

    const [searchQuery, setSearchQuery] = useState('');
    const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

    React.useEffect(() => {
        const handler = () => setIsMobile(window.innerWidth < 768);
        window.addEventListener('resize', handler);
        return () => window.removeEventListener('resize', handler);
    }, []);

    const [activeTab, setActiveTab] = useState('My Account');
    const [dbTab, setDbTab] = useState<'stats' | 'maintenance'>('stats');
    const [playbackTab, setPlaybackTab] = useState<'infinity' | 'llm'>('infinity');
    const [libTab, setLibTab] = useState<'folders' | 'lastfm' | 'genius' | 'musicbrainz'>('folders');
    const [lastFmConfigured, setLastFmConfigured] = useState(false);

    const isAdmin = currentUser?.role === 'admin';

    // Fetch directory stats (reusable)
    const fetchDirStats = useCallback(async () => {
        try {
            setDirStatsLoading(true);
            const authHeaders = getAuthHeader();
            const res = await fetch('/api/library/stats', { headers: { ...authHeaders } });
            if (!res.ok) return;
            const data = await res.json();
            const statsMap: Record<string, { totalTracks: number; withMetadata: number; analyzed: number }> = {};
            for (const d of data.directories || []) {
                statsMap[d.path] = { totalTracks: d.totalTracks, withMetadata: d.withMetadata, analyzed: d.analyzed };
            }
            setDirStats(statsMap);
        } catch (e) {
            console.error('Failed to fetch directory stats', e);
        } finally {
            setDirStatsLoading(false);
        }
    }, [getAuthHeader]);

    // Fetch directory stats when Library tab becomes active
    React.useEffect(() => {
        if (activeTab === 'Library') {
            fetchDirStats();
        }
    }, [activeTab, fetchDirStats]);

    // Auto-refresh dir stats when a scan completes while Library tab is visible
    const prevIsScanning = React.useRef(isScanning);
    React.useEffect(() => {
        if (prevIsScanning.current && !isScanning && activeTab === 'Library') {
            fetchDirStats();
        }
        prevIsScanning.current = isScanning;
    }, [isScanning, activeTab, fetchDirStats]);

    const tabs = [
        { id: 'My Account', label: 'My Account', category: 'User Settings' },
        { id: 'Appearance', label: 'Appearance', category: 'App Settings' },
        { id: 'Library', label: 'Library', category: 'App Settings' },
        { id: 'Playback', label: 'Playback', category: 'App Settings' },
        ...(isAdmin ? [
            { id: 'System', label: 'System', category: 'Server Settings' },
            { id: 'GenAI', label: 'GenAI', category: 'Server Settings' },
            { id: 'Genre Matrix', label: 'Genre Matrix', category: 'Server Settings' },
            { id: 'Database', label: 'Database', category: 'Server Settings' },
            { id: 'Users', label: 'Users', category: 'Admin' },
        ] : []),
    ];

    const filteredTabs = tabs.filter(tab => {
        const query = searchQuery.toLowerCase();
        if (tab.label.toLowerCase().includes(query)) return true;
        
        // Also search within common setting labels for this tab
        if (tab.id === 'Appearance') return 'light dark theme'.includes(query);
        if (tab.id === 'Scrobble') return 'lastfm scrobble connect'.includes(query);
        if (tab.id === 'Library') return 'folder path scan library'.includes(query);
        if (tab.id === 'Playback') return 'infinity discovery genre artist amnesia matrix llm playlist diversity blend tracks wander'.includes(query);
        if (tab.id === 'System') return 'cpu audio analysis scanner concurrency hub schedule'.includes(query);
        if (tab.id === 'GenAI') return 'llm api host model key last.fm genius'.includes(query);
        if (tab.id === 'Genre Matrix') return 'genre matrix transition hop cost mapping'.includes(query);
        if (tab.id === 'Database') return 'database postgres container podman start stop status'.includes(query);
        if (tab.id === 'Users') return 'admin users invites manage'.includes(query);
        
        return false;
    });

    const navGroups = ['User Settings', 'App Settings', 'Server Settings', 'Admin'];

    const username = currentUser?.username || 'User';

    return createPortal(
        <div className={`settings-full-backdrop ${isClosing ? 'closing' : ''}`}>
            <div className="settings-layout" onClick={e => e.stopPropagation()}>
                {/* Close Button UI */}
                <div className="settings-close-container">
                    <div className="settings-close-circle" onClick={handleClose}>
                        <X size={20} />
                    </div>
                    <span className="settings-close-hint">ESC</span>
                </div>

                {/* Mobile: Horizontal tab bar at top */}
                {isMobile && (
                    <div className="settings-mobile-tabs">
                        <div className="flex items-center gap-1 overflow-x-auto hide-scrollbar px-2 pt-3 pb-2">
                            {filteredTabs.map(tab => {
                                         const Icon = tab.id === 'My Account' ? User : 
                                             tab.id === 'Appearance' ? Palette :
                                             tab.id === 'Library' ? Folder :
                                             tab.id === 'Playback' ? Play :
                                             tab.id === 'System' ? Cpu :
                                             tab.id === 'Users' ? Users :
                                             tab.id === 'Database' ? Database :
                                             tab.id === 'GenAI' ? Brain : Globe;

                                return (
                                    <button
                                        key={tab.id}
                                        onClick={() => setActiveTab(tab.id)}
                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                                            activeTab === tab.id
                                                ? 'bg-[var(--color-primary)] text-white'
                                                : 'text-[var(--color-text-muted)] bg-[var(--color-surface)]'
                                        }`}
                                    >
                                        <Icon size={14} />
                                        {tab.label}
                                    </button>
                                );
                            })}
                            <button
                                onClick={() => {
                                    usePlayerStore.getState().clearAuthToken();
                                    handleClose();
                                }}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 text-red-400 bg-[var(--color-surface)] ml-auto"
                            >
                                <LogOut size={14} />
                                Sign Out
                            </button>
                        </div>
                    </div>
                )}

                {/* Desktop: Sidebar */}
                {!isMobile && (
                    <div className="settings-sidebar">
                    <div className="settings-sidebar-header">
                        <h2 className="text-xl font-bold px-3 py-4 text-[var(--color-text-primary)] tracking-tight">Settings</h2>
                    </div>
                    <div className="settings-search-container">
                        <input 
                            type="text" 
                            className="settings-search-input" 
                            placeholder="Search" 
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                    </div>

                    {navGroups.map(group => {
                        const groupTabs = filteredTabs.filter(t => t.category === group);
                        if (groupTabs.length === 0) return null;
                        
                        return (
                            <div key={group} className="settings-nav-group">
                                <h4 className="settings-nav-header">{group}</h4>
                                {groupTabs.map(tab => {
                                    const Icon = tab.id === 'My Account' ? User : 
                                                 tab.id === 'Appearance' ? Palette :
                                                 tab.id === 'Library' ? Folder :
                                                 tab.id === 'Playback' ? Play :
                                                 tab.id === 'System' ? Cpu :
                                                 tab.id === 'Users' ? Users :
                                                 tab.id === 'Database' ? Database :
                                                 tab.id === 'Genre Matrix' ? Globe :
                                                 tab.id === 'GenAI' ? Brain : Globe;
                                    
                                    return (
                                        <div 
                                            key={tab.id}
                                            className={`settings-nav-item ${activeTab === tab.id ? 'active' : ''}`}
                                            onClick={() => setActiveTab(tab.id)}
                                        >
                                            <Icon size={18} className="mr-3 opacity-70" />
                                            {tab.label}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })}

                    <div className="settings-nav-group mt-auto">
                        <div className="border-t border-[var(--glass-border)] pt-4 mt-4">
                            <div 
                                className="settings-nav-item logout"
                                onClick={() => {
                                    usePlayerStore.getState().clearAuthToken();
                                    handleClose();
                                }}
                            >
                                <LogOut size={18} className="mr-3 opacity-70" />
                                Sign Out
                            </div>
                        </div>
                    </div>
                    </div>
                )}

                {/* Main Content */}
                <div className="settings-content-wrapper">
                    <div className="settings-content-container">
                        <div className="settings-content">
                            <div className="settings-content-scroll p-8">
                                {activeTab === 'My Account' && (
                                    <div className="settings-section">
                                        <div className="settings-section-header mb-6">
                                            <h3 className="text-xl font-bold text-[var(--color-text-primary)]">My Account</h3>
                                        </div>

                                        <div className="bg-[var(--color-surface)] rounded-2xl overflow-hidden border border-[var(--glass-border)] shadow-xl">
                                            <div className="h-24 bg-gradient-to-r from-[var(--color-primary)] to-[var(--aurora-purple)] opacity-80"></div>
                                            <div className="px-4 pb-6 -mt-12">
                                                <div className="flex items-end gap-3 mb-4">
                                                    <div className="w-20 h-20 rounded-full border-4 border-[var(--color-surface)] bg-[var(--color-surface-variant)] flex items-center justify-center text-3xl font-bold text-[var(--color-text-primary)] overflow-hidden shadow-lg backdrop-blur-md">
                                                        {username[0]?.toUpperCase() || 'U'}
                                                    </div>
                                                    <div className="mb-1">
                                                        <h4 className="text-xl font-bold text-white">{username}</h4>
                                                        <span className="text-xs text-white/60 capitalize">{currentUser?.role}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Change Password */}
                                        <div className="mt-6 bg-[var(--color-surface)] rounded-2xl p-5 border border-[var(--glass-border)]">
                                            <h4 className="font-semibold text-[var(--color-text-primary)] mb-4">Change Password</h4>
                                            <form
                                                onSubmit={async (e) => {
                                                    e.preventDefault();
                                                    const form = e.target as HTMLFormElement;
                                                    const current = (form.elements.namedItem('currentPassword') as HTMLInputElement).value;
                                                    const newPw = (form.elements.namedItem('newPassword') as HTMLInputElement).value;
                                                    const confirm = (form.elements.namedItem('confirmPassword') as HTMLInputElement).value;

                                                    if (!current || !newPw) return;
                                                    if (newPw.length < 5) { showToast('Password must be 5+ characters', 'error'); return; }
                                                    if (newPw !== confirm) { showToast('Passwords do not match', 'error'); return; }

                                                    try {
                                                        const res = await fetch('/api/auth/change-password', {
                                                            method: 'POST',
                                                            headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                                                            body: JSON.stringify({ currentPassword: current, newPassword: newPw })
                                                        });
                                                        const data = await res.json();
                                                        if (res.ok) {
                                                            showToast('Password changed', 'success');
                                                            form.reset();
                                                        } else {
                                                            showToast(data.error || 'Failed', 'error');
                                                        }
                                                    } catch { showToast('Network error', 'error'); }
                                                }}
                                                className="space-y-3"
                                            >
                                                <input name="currentPassword" type="password" placeholder="Current password" required
                                                    className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50" />
                                                <input name="newPassword" type="password" placeholder="New password (5+ chars)" required
                                                    className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50" />
                                                <input name="confirmPassword" type="password" placeholder="Confirm new password" required
                                                    className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50" />
                                                <button type="submit" className="btn btn-primary">
                                                    Update Password
                                                </button>
                                            </form>
                                        </div>

                                        {/* Delete Account */}
                                        <div className="mt-6 bg-red-500/5 rounded-2xl p-5 border border-red-500/20">
                                            <h4 className="font-semibold text-red-400 mb-2">Danger Zone</h4>
                                            <p className="text-sm text-[var(--color-text-muted)] mb-4">Permanently delete your account and all associated data. This cannot be undone.</p>
                                            <button
                                                onClick={() => {
                                                    setConfirmDialog({
                                                        title: 'Delete Account',
                                                        message: 'This will permanently delete your account. You will be signed out immediately. Type your password to confirm.',
                                                        confirmLabel: 'Delete My Account',
                                                        onConfirm: async () => {
                                                            setConfirmDialog(null);
                                                            setPromptDialog({
                                                                title: 'Confirm Password',
                                                                label: 'Enter your password to delete your account.',
                                                                onSubmit: async (password) => {
                                                                    setPromptDialog(null);
                                                                    try {
                                                                        const res = await fetch('/api/auth/delete-account', {
                                                                            method: 'DELETE',
                                                                            headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                                                                            body: JSON.stringify({ password })
                                                                        });
                                                                        if (res.ok) {
                                                                            showToast('Account deleted', 'success');
                                                                            usePlayerStore.getState().clearAuthToken();
                                                                            handleClose();
                                                                        } else {
                                                                            const data = await res.json();
                                                                            showToast(data.error || 'Failed', 'error');
                                                                        }
                                                                    } catch { showToast('Network error', 'error'); }
                                                                },
                                                            });
                                                        },
                                                    });
                                                }}
                                                className="btn btn-danger"
                                            >
                                                Delete Account
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {activeTab === 'Appearance' && (
                                    <div className="settings-section mb-8">
                                        <div className="settings-section-header mb-4">
                                            <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Appearance</h3>
                                        </div>
                                        <div className="flex gap-4 mb-4">
                                            <button 
                                                className={`btn flex-1 py-4 tracking-wide duration-300 ${theme === 'light' ? 'btn-primary !shadow-lg !scale-100' : 'btn-ghost'}`}
                                                onClick={() => setTheme('light')}
                                            >
                                                ☀️ Light
                                            </button>
                                            <button 
                                                className={`btn flex-1 py-4 tracking-wide duration-300 ${theme === 'dark' ? 'btn-primary !shadow-lg !scale-100 dark:bg-[var(--aurora-purple)] dark:border-[var(--aurora-purple)]' : 'btn-ghost'}`}
                                                onClick={() => setTheme('dark')}
                                            >
                                                🌙 Dark
                                            </button>
                                        </div>
                                    </div>
                                )}
                            
                                {activeTab === 'Library' && (
                                    <div className="settings-section mb-8">
                                        {/* Sub-tabs */}
                                        <div className="flex gap-2 mb-6">
                                            <button onClick={() => setLibTab('folders')} className={`btn-tab ${libTab === 'folders' ? 'active' : ''}`}>
                                                <Folder size={16} className="inline mr-1 relative -top-[1px]" /> Folders
                                            </button>
                                            <button onClick={() => setLibTab('lastfm')} className={`btn-tab ${libTab === 'lastfm' ? 'active' : ''}`}>
                                                <Link size={16} className="inline mr-1 relative -top-[1px]" /> Last.fm
                                            </button>
                                            <button onClick={() => setLibTab('genius')} className={`btn-tab ${libTab === 'genius' ? 'active' : ''}`}>
                                                <Search size={16} className="inline mr-1 relative -top-[1px]" /> Genius
                                            </button>
                                            <button onClick={() => setLibTab('musicbrainz')} className={`btn-tab ${libTab === 'musicbrainz' ? 'active' : ''}`}>
                                                <Globe size={16} className="inline mr-1 relative -top-[1px]" /> MusicBrainz
                                            </button>
                                        </div>

                                        {libTab === 'folders' && (
                                            <>
                                                <div className="settings-section-header flex justify-between items-center mb-4">
                                                    <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Mapped Folders</h3>
                                                    <button className="btn btn-sm" onClick={handleAddFolder}>+ Map Folder Path</button>
                                                </div>
                                                <p className="text-sm text-[var(--color-text-muted)] mb-4">Folders mapped here will be automatically scanned.</p>
                                                <ul className="flex flex-col gap-3">
                                                    {libraryFolders.length === 0 ? (
                                                        <li className="p-4 rounded-xl border border-dashed border-[var(--glass-border)] bg-[var(--glass-bg)] text-center text-sm text-[var(--color-text-muted)] backdrop-blur-sm">No folders mapped yet.</li>
                                                    ) : (
                                                        libraryFolders.map((folderPath) => {
                                                            const stats = dirStats[folderPath];
                                                            return (
                                                                <li key={folderPath} className="p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-sm backdrop-blur-sm">
                                                                    <div className="flex justify-between items-center mb-2">
                                                                        <span className="text-sm truncate mr-4 text-[var(--color-text-primary)] font-medium flex items-center gap-2"><Folder size={16} className="shrink-0 text-[var(--color-text-muted)]" /> {folderPath}</span>
                                                                        <div className="flex gap-2 shrink-0">
                                                                            <button className="btn btn-primary btn-sm" onClick={() => handleRescanFolder(folderPath)}>Rescan</button>
                                                                            <button className="btn btn-danger-fill btn-sm" onClick={() => handleRemoveFolder(folderPath)}>Remove</button>
                                                                        </div>
                                                                    </div>
                                                                    {stats && stats.totalTracks > 0 && (
                                                                        <div className="flex gap-4 text-xs text-[var(--color-text-secondary)] pl-1">
                                                                            <span>{stats.totalTracks} tracks</span><span>·</span><span>{stats.withMetadata} with metadata</span><span>·</span>
                                                                            <span className={stats.analyzed === stats.totalTracks ? 'text-green-500' : 'text-amber-500'}>{stats.analyzed} analyzed</span>
                                                                        </div>
                                                                    )}
                                                                    {stats && stats.totalTracks === 0 && (<div className="text-xs text-[var(--color-text-muted)] pl-1">No tracks found. Click Rescan to index this folder.</div>)}
                                                                </li>
                                                            );
                                                        })
                                                    )}
                                                </ul>
                                                <div className="mt-4 flex items-center justify-between p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)]">
                                                    <div>
                                                        <p className="text-sm font-medium text-[var(--color-text-primary)]">Automatic Folder Walk</p>
                                                        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Re-walk all folders every 30 minutes to detect renamed or deleted files.</p>
                                                    </div>
                                                    <button id="autoFolderWalk-toggle" onClick={() => setSettings({ autoFolderWalk: !autoFolderWalk })} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ml-4 ${autoFolderWalk ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-bg-tertiary)]'}`} title={autoFolderWalk ? 'Auto-walk enabled' : 'Auto-walk disabled'}>
                                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${autoFolderWalk ? 'translate-x-6' : 'translate-x-1'}`} />
                                                    </button>
                                                </div>
                                                <div className="mt-6 pt-4 border-t border-[var(--glass-border)]">
                                                    <div className="flex justify-between items-center mb-3">
                                                        <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">Audio Analysis</h4>
                                                        <div className="flex gap-2">
                                                            <button className="btn btn-primary btn-sm" onClick={handleAnalyze} disabled={isScanning}>{isScanning ? 'Analyzing...' : 'Analyze Missing'}</button>
                                                            <button className="btn btn-ghost btn-sm" onClick={handleForceAnalyze} disabled={isScanning}>Re-analyze All</button>
                                                        </div>
                                                    </div>
                                                    <p className="text-xs text-[var(--color-text-muted)]">Runs Essentia audio feature extraction on tracks that haven't been analyzed yet. This powers the recommendation engine (Infinity Mode, Hub playlists).</p>
                                                    {(() => {
                                                        const totalStats = Object.values(dirStats).reduce((acc, s) => ({ totalTracks: acc.totalTracks + s.totalTracks, withMetadata: acc.withMetadata + s.withMetadata, analyzed: acc.analyzed + s.analyzed }), { totalTracks: 0, withMetadata: 0, analyzed: 0 });
                                                        if (dirStatsLoading) { return (<div className="mt-2"><div className="flex justify-between text-xs text-[var(--color-text-secondary)] mb-1"><span>Library Coverage</span><span className="animate-pulse">Loading...</span></div><div className="w-full h-2 rounded-full bg-[var(--glass-border)] overflow-hidden" /></div>); }
                                                        if (totalStats.totalTracks === 0) return null;
                                                        const pct = Math.round((totalStats.analyzed / totalStats.totalTracks) * 100);
                                                        return (<div className="mt-2"><div className="flex justify-between text-xs text-[var(--color-text-secondary)] mb-1"><span>Library Coverage</span><span>{totalStats.analyzed} / {totalStats.totalTracks} tracks ({pct}%)</span></div><div className="w-full h-2 rounded-full bg-[var(--glass-border)] overflow-hidden"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#22c55e' : pct > 50 ? '#f59e0b' : '#ef4444' }} /></div></div>);
                                                    })()}
                                                </div>
                                            </>
                                        )}

                                        {libTab === 'lastfm' && (
                                            <div className="flex flex-col gap-5">
                                                <div><h3 className="text-lg font-bold text-[var(--color-text-primary)] mb-1">Last.fm</h3><p className="text-sm text-[var(--color-text-muted)]">Metadata and scrobbling service. API key and shared secret are configured by the admin.</p></div>
                                                <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 flex flex-col gap-3">
                                                    <input type="text" value={lastFmApiKey} onChange={e => setLastFmApiKey(e.target.value)} placeholder="API Key" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                                                    <input type="password" value={lastFmSharedSecret} onChange={e => setLastFmSharedSecret(e.target.value)} placeholder="Shared Secret (for scrobbling)" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                                                    <div className="flex items-center gap-3">
                                                        <button onClick={() => testLastFm(lastFmApiKey)} disabled={lastFmStatus === 'testing' || !lastFmApiKey} className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50">{lastFmStatus === 'testing' ? 'Testing...' : 'Test'}</button>
                                                        {lastFmStatus === 'success' && <span className="text-green-500 font-semibold text-xs">✓ {lastFmMessage}</span>}
                                                        {lastFmStatus === 'error' && <span className="text-red-500 font-semibold text-xs">✗ {lastFmMessage}</span>}
                                                    </div>
                                                </div>
                                                <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5">
                                                    <h4 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">Scrobbling</h4>
                                                    {lastFmConnected ? (
                                                        <div className="flex flex-col gap-4">
                                                            <div className="flex items-center justify-between">
                                                                <span className="text-green-500 font-semibold text-sm">Connected as {lastFmUsername || 'Last.fm'}</span>
                                                                <button onClick={async () => { try { const res = await fetch('/api/providers/lastfm/disconnect', { method: 'POST' }); const data = await res.json(); if (!res.ok || data.error) { showToast(data.error || 'Failed to disconnect', 'error'); } else { setLastFmConnected(false); setLastFmUsername(''); } } catch (e: any) { showToast(e?.message || 'Network error', 'error'); } }} className="btn btn-danger btn-sm">Remove access</button>
                                                            </div>
                                                            <div className="border-t border-[var(--glass-border)] pt-4 flex items-center justify-between">
                                                                <label className="text-sm text-[var(--color-text-primary)]">Auto-scrobble played tracks</label>
                                                                <button onClick={() => setLastFmScrobbleEnabled(!lastFmScrobbleEnabled)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${lastFmScrobbleEnabled ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-bg-tertiary)]'}`}><span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${lastFmScrobbleEnabled ? 'translate-x-6' : 'translate-x-1'}`} /></button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <div className="flex flex-col gap-3">
                                                            <p className="text-sm text-[var(--color-text-muted)]">Link your Last.fm account to scrobble played tracks.</p>
                                                            <button onClick={async () => { try { const authHeaders = (usePlayerStore.getState() as any).getAuthHeader?.() || {}; const res = await fetch('/api/providers/lastfm/authorize', { headers: { ...authHeaders } }); const data = await res.json(); if (!res.ok || data.error) { showToast(data.error || `Server error: ${res.status}`, 'error'); } else if (data.url) { window.open(data.url, '_blank'); } } catch (e: any) { showToast(e?.message || 'Network error', 'error'); } }} className="btn btn-primary btn-sm">Connect to Last.fm</button>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {libTab === 'genius' && (
                                            <div className="flex flex-col gap-5">
                                                <div><h3 className="text-lg font-bold text-[var(--color-text-primary)] mb-1">Genius</h3><p className="text-sm text-[var(--color-text-muted)]">Lyrics, artist bios, and album art fallback. Requires a Genius API access token.</p></div>
                                                <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 flex flex-col gap-3">
                                                    <div className="flex gap-2">
                                                        <input type="text" value={geniusApiKey} onChange={e => setGeniusApiKey(e.target.value)} placeholder="Access Token" className="flex-1 p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                                                        <button onClick={() => testGenius(geniusApiKey)} disabled={geniusStatus === 'testing' || !geniusApiKey} className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50">{geniusStatus === 'testing' ? 'Testing...' : 'Test'}</button>
                                                    </div>
                                                    {geniusStatus === 'success' && <span className="text-green-500 font-semibold text-xs">✓ {geniusMessage}</span>}
                                                    {geniusStatus === 'error' && <span className="text-red-500 font-semibold text-xs">✗ {geniusMessage}</span>}
                                                </div>
                                            </div>
                                        )}

                                        {libTab === 'musicbrainz' && (
                                            <div className="flex flex-col gap-5">
                                                <div><h3 className="text-lg font-bold text-[var(--color-text-primary)] mb-1">MusicBrainz</h3><p className="text-sm text-[var(--color-text-muted)]">Structured metadata with optional OAuth2. Provides artist disambiguation, official links, genre tags, and album art from Cover Art Archive.</p></div>
                                                <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 flex flex-col gap-3">
                                                    <div className="flex items-center justify-between">
                                                        <label className="text-sm font-medium text-[var(--color-text-primary)]">{musicBrainzEnabled ? 'Enabled' : 'Disabled'}</label>
                                                        <button onClick={() => setMusicBrainzEnabled(!musicBrainzEnabled)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${musicBrainzEnabled ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-bg-tertiary)]'}`}><span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${musicBrainzEnabled ? 'translate-x-6' : 'translate-x-1'}`} /></button>
                                                    </div>
                                                    {musicBrainzEnabled && (
                                                        <div className="flex flex-col gap-3 mt-1">
                                                            <input type="text" value={musicBrainzClientId} onChange={e => setMusicBrainzClientId(e.target.value)} placeholder="Client ID" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                                                            <input type="password" value={musicBrainzClientSecret} onChange={e => setMusicBrainzClientSecret(e.target.value)} placeholder="Client Secret" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                                                            <div className="flex gap-2 items-center">
                                                                <button onClick={() => testMusicBrainz()} disabled={musicBrainzStatus === 'testing'} className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50">{musicBrainzStatus === 'testing' ? 'Testing...' : 'Test'}</button>
                                                                {musicBrainzStatus === 'success' && <span className="text-green-500 font-semibold text-xs">✓ {musicBrainzMessage}</span>}
                                                                {musicBrainzStatus === 'error' && <span className="text-red-500 font-semibold text-xs">✗ {musicBrainzMessage}</span>}
                                                                {musicBrainzConnected ? (<><span className="text-green-500 font-semibold text-xs ml-auto">Connected</span><button onClick={async () => { await fetch('/api/providers/musicbrainz/disconnect', { method: 'POST' }); setMusicBrainzConnected(false); }} className="btn btn-danger btn-sm">Remove access</button></>) : (<button onClick={async () => { try { const res = await fetch('/api/providers/musicbrainz/authorize'); const data = await res.json(); if (!res.ok || data.error) { showToast(data.error || `Server error: ${res.status}`, 'error'); } else if (data.url) { window.open(data.url, '_blank'); } } catch (e: any) { showToast(e?.message || 'Network error', 'error'); } }} disabled={!musicBrainzClientId || !musicBrainzClientSecret} className="btn btn-primary btn-sm disabled:opacity-50 ml-auto">Connect</button>)}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        <div className="mt-6 pt-6 border-t border-[var(--glass-border)]">
                                            <h4 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">Default Provider per Service</h4>
                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                                                <div>
                                                    <label className="block text-xs text-[var(--color-text-muted)] mb-1">Artist Images</label>
                                                    <select value={providerArtistImage} onChange={e => setSettings({ providerArtistImage: e.target.value as 'lastfm' | 'genius' | 'musicbrainz' })} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors">
                                                        <option value="lastfm">Last.fm</option><option value="genius">Genius</option>{musicBrainzEnabled && <option value="musicbrainz">MusicBrainz</option>}
                                                    </select>
                                                </div>
                                                <div>
                                                    <label className="block text-xs text-[var(--color-text-muted)] mb-1">Artist Bios</label>
                                                    <select value={providerArtistBio} onChange={e => setSettings({ providerArtistBio: e.target.value as 'lastfm' | 'genius' })} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors">
                                                        <option value="lastfm">Last.fm</option><option value="genius">Genius</option>
                                                    </select>
                                                </div>
                                                <div>
                                                    <label className="block text-xs text-[var(--color-text-muted)] mb-1">Album Art</label>
                                                    <select value={providerAlbumArt} onChange={e => setSettings({ providerAlbumArt: e.target.value as 'lastfm' | 'genius' | 'musicbrainz' })} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors">
                                                        <option value="lastfm">Last.fm</option><option value="genius">Genius</option>{musicBrainzEnabled && <option value="musicbrainz">MusicBrainz</option>}
                                                    </select>
                                                </div>
                                            </div>
                                            <button onClick={async () => { try { const authHeaders = (usePlayerStore.getState() as any).getAuthHeader?.() || {}; const res = await fetch('/api/providers/external/refresh', { method: 'POST', headers: authHeaders }); const data = await res.json(); if (!res.ok || data.error) { showToast(data.error || 'Failed to clear cache', 'error'); } else { showToast('Provider image & bio cache cleared', 'success'); } } catch (e: any) { showToast(e?.message || 'Network error', 'error'); } }} className="btn btn-ghost btn-sm gap-2"><Trash2 size={14} /> Clear cached images &amp; bios</button>
                                        </div>
                                    </div>
                                )}{activeTab === 'Playback' && (
                                    <div className="settings-section mb-8">
                                        <div className="settings-section-header mb-4">
                                            <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Playback & Discovery</h3>
                                        </div>

                                        {/* Sub-tabs */}
                                        <div className="flex gap-2 mb-6">
                                            <button
                                                onClick={() => setPlaybackTab('infinity')}
                                                className={`btn-tab ${playbackTab === 'infinity' ? 'active' : ''}`}
                                            >
                                                Infinity Mode
                                            </button>
                                            <button
                                                onClick={() => setPlaybackTab('llm')}
                                                className={`btn-tab ${playbackTab === 'llm' ? 'active' : ''}`}
                                            >
                                                LLM Playlists
                                            </button>
                                        </div>

                                        {playbackTab === 'infinity' && (
                                            <div>
                                                <p className="text-sm text-[var(--color-text-muted)] mb-6">
                                                    Tune how the engine selects the next track organically.
                                                </p>
                                                
                                                <div className="mb-6">
                                                    <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                                        <span>Discovery Level (Wander Factor)</span>
                                                        <span>{discoveryLevel}%</span>
                                                    </label>
                                                    <input type="range" min="1" max="100" value={discoveryLevel} onChange={e => setSettings({ discoveryLevel: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">Controls how adventurous the engine is when picking the next track. Low values stay close to your current vibe; high values explore further from your listening center of gravity.</p>
                                                </div>

                                                <div className="mb-6">
                                                    <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                                        <span>Genre Strictness</span>
                                                        <span>{genreStrictness}%</span>
                                                    </label>
                                                    <input type="range" min="0" max="100" value={genreStrictness} onChange={e => setSettings({ genreStrictness: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How much the engine penalizes genre jumps. 0% lets any genre play; 100% keeps you tightly within the current genre.</p>
                                                </div>

                                                <div className="mb-6">
                                                    <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Artist Amnesia (Anti-Repeat)</label>
                                                    <select 
                                                        value={artistAmnesiaLimit} 
                                                        onChange={e => setSettings({ artistAmnesiaLimit: Number(e.target.value) })}
                                                        className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                                                    >
                                                        <option value={0}>Allow Defaults</option>
                                                        <option value={10}>Standard (10 tracks)</option>
                                                        <option value={50}>Strict (50 tracks)</option>
                                                    </select>
                                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How many recent tracks to exclude from the next pick. Prevents the same artist or song from repeating too soon.</p>
                                                </div>
                                            </div>
                                        )}

                                        {playbackTab === 'llm' && (
                                            <div>
                                                <p className="text-sm text-[var(--color-text-muted)] mb-6">
                                                    Control how AI-generated Hub playlists are created and diversified.
                                                </p>

                                                <div className="mb-6">
                                                    <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                                        <span>Playlist Diversity</span>
                                                        <span>{llmPlaylistDiversity}%</span>
                                                    </label>
                                                    <input type="range" min="0" max="100" value={llmPlaylistDiversity} onChange={e => setSettings({ llmPlaylistDiversity: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">Higher values introduce more randomness into track selection, making playlists less predictable. Lower values pick the acoustically closest matches every time.</p>
                                                </div>

                                                <div className="mb-6">
                                                    <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                                        <span>Genre Blend Weight</span>
                                                        <span>{genreBlendWeight}%</span>
                                                    </label>
                                                    <input type="range" min="0" max="100" value={genreBlendWeight} onChange={e => setSettings({ genreBlendWeight: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How strongly genre similarity influences playlist track selection. Higher values keep playlists genre-coherent; lower values let tracks from different genres mix freely based on acoustic similarity alone.</p>
                                                </div>

                                                <div className="mb-6">
                                                    <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Tracks per Playlist</label>
                                                    <select 
                                                        value={llmTracksPerPlaylist} 
                                                        onChange={e => setSettings({ llmTracksPerPlaylist: Number(e.target.value) })}
                                                        className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                                                    >
                                                        <option value={5}>5 tracks</option>
                                                        <option value={10}>10 tracks</option>
                                                        <option value={15}>15 tracks</option>
                                                        <option value={20}>20 tracks</option>
                                                    </select>
                                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">Number of tracks included in each AI-generated playlist.</p>
                                                </div>

                                                <div className="mb-6">
                                                    <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Number of Playlists</label>
                                                    <select 
                                                        value={llmPlaylistCount} 
                                                        onChange={e => setSettings({ llmPlaylistCount: Number(e.target.value) })}
                                                        className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                                                    >
                                                        <option value={2}>2 playlists</option>
                                                        <option value={3}>3 playlists</option>
                                                        <option value={5}>5 playlists</option>
                                                    </select>
                                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How many distinct playlist concepts the AI generates per cycle. Each playlist gets a unique mood and acoustic profile.</p>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activeTab === 'System' && (
                                    <div className="settings-section mb-8">
                                        <div className="settings-section-header mb-4">
                                            <h3 className="text-xl font-bold text-[var(--color-text-primary)]">System & Processing</h3>
                                        </div>
                                        <div className="mb-6">
                                            <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Audio Analysis CPU Usage</label>
                                            <select 
                                                value={audioAnalysisCpu} 
                                                onChange={e => setSettings({ audioAnalysisCpu: e.target.value })}
                                                className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                                            >
                                                <option value="Background">Background (1 process)</option>
                                                <option value="Balanced">Balanced (4 processes)</option>
                                                <option value="Performance">Performance (8 processes)</option>
                                                <option value="Intensive">Intensive (16 processes)</option>
                                                <option value="Maximum">Maximum (all CPU cores)</option>
                                            </select>
                                        </div>

                                        <div className="mb-6">
                                            <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Scanner Concurrency</label>
                                            <select 
                                                value={scannerConcurrency} 
                                                onChange={e => setSettings({ scannerConcurrency: e.target.value })}
                                                className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                                            >
                                                <option value="HDD">HDD (4 processes)</option>
                                                <option value="SSD">Standard SSD (16 processes)</option>
                                                <option value="NVMe">Premium NVMe (32 processes)</option>
                                            </select>
                                            <p className="text-xs text-[var(--color-text-muted)] mt-1.5">Controls how many files are scanned simultaneously for metadata. Higher values require faster disk I/O.</p>
                                        </div>

                                        <div className="mb-6">
                                            <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Hub Generation Schedule</label>
                                            <select 
                                                value={hubGenerationSchedule} 
                                                onChange={e => setSettings({ hubGenerationSchedule: e.target.value })}
                                                className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                                            >
                                                <option value="Manual Only">Manual Only</option>
                                                <option value="Daily">Daily</option>
                                                <option value="Weekly">Weekly</option>
                                            </select>
                                            <div className="mt-4">
                                                <p className="text-xs text-[var(--color-text-muted)] mb-2 max-w-sm leading-relaxed">
                                                    Manually trigger the AI to generate fresh playlists based on the time of day and your listening history. 
                                                    <span className="text-[var(--color-error)] block mt-1 font-medium">Warning: Resetting will delete all current LLM-generated playlists from your hub.</span>
                                                </p>
                                                <button 
                                                   onClick={handleManualHubRegen}
                                                   className="btn btn-danger"
                                                >
                                                   <span className="text-lg leading-none">↺</span> Reset Hub
                                                </button>
                                            </div>
                                        </div>

                                        {/* Aurora App Auto-Start Configuration */}
                                        <div className="mt-8 pt-6 border-t border-[var(--glass-border)]">
                                            <div className="flex items-center gap-2 mb-3">
                                                <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">Aurora Auto-Start</h4>
                                                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">systemd</span>
                                            </div>
                                            <p className="text-sm text-[var(--color-text-muted)] mb-4 leading-relaxed">
                                                Configure Aurora to automatically start when your computer starts. This requires a user-level systemd service.
                                            </p>
                                            
                                            <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--glass-border)] p-4">
                                                <div className="flex items-center gap-2 mb-3">
                                                    <span className="text-sm font-medium text-[var(--color-text-primary)]">Service Status:</span>
                                                    <span className="text-xs px-2 py-1 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">Not Configured</span>
                                                </div>
                                                    <p className="mb-4 text-amber-200/80 italic">
                                                        Note: You must run <b>npm run build</b> once before starting the service.
                                                    </p>
                                                    <div className="bg-black/40 rounded-lg p-3 font-mono text-xs text-green-400 overflow-x-auto">
                                                        <p className="mb-1">mkdir -p ~/.config/systemd/user</p>
                                                        <p className="mb-1">cat &gt; ~/.config/systemd/user/aurora.service &lt;&lt; 'EOF'</p>
                                                        <p className="mb-1">[Unit]</p>
                                                        <p className="mb-1">Description=Aurora Music Player</p>
                                                        <p className="mb-1">After=default.target</p>
                                                        <p className="mb-1"></p>
                                                        <p className="mb-1">[Service]</p>
                                                        <p className="mb-1">Type=simple</p>
                                                        <p className="mb-1">ExecStart=/bin/bash -c 'cd "/var/home/andreas/VS Code/Music App" && npx tsx server/index.ts'</p>
                                                        <p className="mb-1">Restart=on-failure</p>
                                                        <p className="mb-1">RestartSec=10</p>
                                                    <p className="mb-1"></p>
                                                    <p className="mb-1">[Install]</p>
                                                    <p className="mb-1">WantedBy=default.target</p>
                                                    <p className="mb-1">EOF</p>
                                                    <p className="mb-1"></p>
                                                    <p className="mb-1">systemctl --user daemon-reload</p>
                                                    <p className="mb-1">systemctl --user enable aurora.service</p>
                                                    <p className="mb-1">systemctl --user start aurora.service</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {activeTab === 'GenAI' && (
                                    <div className="settings-section mb-8">
                                        <div className="settings-section-header mb-4">
                                            <h3>LLM / Engine Configurations</h3>
                                        </div>
                                        <p className="settings-description">
                                            Bring your own LLM to generate Hub playlists securely on your own hardware.
                                        </p>
                                        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 mb-8">
                                            <div className="flex flex-col gap-4">
                                                <div>
                                                    <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">API Base URL</label>
                                                    <input 
                                                        type="text" 
                                                        value={llmBaseUrl} 
                                                        onChange={(e) => setSettings({ llmBaseUrl: e.target.value })}
                                                        placeholder="https://api.openai.com/v1"
                                                        className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">API Key</label>
                                                    <input 
                                                        type="password" 
                                                        value={llmApiKey} 
                                                        onChange={(e) => setSettings({ llmApiKey: e.target.value })}
                                                        placeholder="Leave blank if using local unrestricted provider"
                                                        className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                                                    />
                                                </div>
                                                <div className="relative">
                                                    <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Model Name</label>
                                                    <input 
                                                        type="text" 
                                                        value={llmModelName} 
                                                        onChange={(e) => setSettings({ llmModelName: e.target.value })}
                                                        onFocus={() => setShowModelDropdown(true)}
                                                        onBlur={() => setTimeout(() => setShowModelDropdown(false), 200)}
                                                        placeholder="gpt-4o / llama-3"
                                                        className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                                                    />
                                                    {availableModels.length > 0 && showModelDropdown && (
                                                        <ul className="absolute left-0 right-0 z-50 w-full mt-2 max-h-48 overflow-y-auto bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl shadow-xl py-1">
                                                            {availableModels.map(m => (
                                                                <li 
                                                                    key={m} 
                                                                    className="px-4 py-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)] cursor-pointer transition-colors"
                                                                    onMouseDown={(e) => {
                                                                        e.preventDefault();
                                                                        setSettings({ llmModelName: m });
                                                                        setShowModelDropdown(false);
                                                                    }}
                                                                >
                                                                    {m}
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-4 mt-2">
                                                    <button 
                                                        onClick={() => runConnectionTest(llmBaseUrl, llmApiKey)}
                                                        disabled={connectionStatus === 'testing'}
                                                        className="btn btn-ghost disabled:opacity-50"
                                                    >
                                                        {connectionStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                                                    </button>
                                                    {connectionStatus === 'success' && (
                                                        <span className="text-green-500 font-semibold text-sm">✓ {connectionMessage}</span>
                                                    )}
                                                    {connectionStatus === 'error' && (
                                                        <span className="text-red-500 font-semibold text-sm truncate max-w-xs">✗ {connectionMessage}</span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                    </div>
                                )}

                                {activeTab === 'Genre Matrix' && (
                                    <div className="settings-section mb-8">
                                        <div className="settings-section-header mb-2">
                                            <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Genre Transition Matrix</h3>
                                        </div>
                                        <p className="text-sm text-[var(--color-text-muted)] mb-6">
                                            Maps hop costs between genres, powering Infinity Mode and Hub generation.
                                        </p>

                                        <div className="flex items-center gap-2 mb-6">
                                            <button
                                                onClick={handleRunMatrix}
                                                disabled={isRunningMatrix}
                                                className="btn btn-primary disabled:opacity-50"
                                            >
                                                {isRunningMatrix && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                                                {isRunningMatrix ? (genreMatrixProgress?.replace('Categorizing ', '') || 'Running...') : 'Incremental Run'}
                                            </button>
                                            <button
                                                onClick={handleRemapAll}
                                                disabled={isRunningMatrix}
                                                className="btn btn-danger disabled:opacity-50"
                                            >
                                                Remap Library
                                            </button>
                                        </div>

                                        <div className="flex flex-col gap-2 text-sm p-4 rounded-2xl bg-[var(--color-surface)] border border-[var(--glass-border)]">
                                            <div className="flex justify-between items-center border-b border-[var(--glass-border)] pb-3">
                                                <span className="text-[var(--color-text-secondary)]">Last Run</span>
                                                <span className="text-[var(--color-text-primary)] font-medium">
                                                    {genreMatrixLastRun ? new Date(genreMatrixLastRun).toLocaleString() : 'Never'}
                                                </span>
                                            </div>
                                            <div className="flex justify-between items-center border-b border-[var(--glass-border)] pb-3 pt-1">
                                                <span className="text-[var(--color-text-secondary)]">Last Result</span>
                                                <span className="text-[var(--color-text-primary)] font-medium truncate" title={genreMatrixLastResult || 'N/A'}>
                                                    {genreMatrixLastResult || 'N/A'}
                                                </span>
                                            </div>
                                            <div className="flex justify-between items-center pt-1">
                                                <span className="text-[var(--color-text-secondary)]">Library Coverage</span>
                                                <div className="flex flex-col items-end gap-1">
                                                    <span className="text-[var(--color-text-primary)] font-bold">{coveragePercent}%</span>
                                                    <div className="w-24 h-1 bg-black/20 dark:bg-white/10 rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full bg-[var(--color-primary)] transition-all duration-500"
                                                            style={{ width: `${coveragePercent}%` }}
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                 {activeTab === 'Database' && (
                                    <div className="settings-section mb-8">
                                        <div className="settings-section-header mb-4">
                                            <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Database Management</h3>
                                        </div>

                                        {/* Sub-tabs */}
                                        <div className="flex gap-2 mb-6">
                                            <button
                                                onClick={() => setDbTab('stats')}
                                                className={`btn-tab ${dbTab === 'stats' ? 'active' : ''}`}
                                            >
                                                <BarChart2 size={16} className="inline mr-1 relative -top-[1px]" /> Stats
                                            </button>
                                            <button
                                                onClick={() => setDbTab('maintenance')}
                                                className={`btn-tab ${dbTab === 'maintenance' ? 'active' : ''}`}
                                            >
                                                <Wrench size={16} className="inline mr-1 relative -top-[1px]" /> Maintenance
                                            </button>
                                        </div>

                                        {dbTab === 'stats' && (
                                            <div className="space-y-3">
                                                <p className="text-sm text-[var(--color-text-muted)] mb-4">
                                                    Manage your PostgreSQL container instance and monitor its health.
                                                </p>
                                                <DatabaseControl inline={true} variant="stats" />
                                            </div>
                                        )}

                                        {dbTab === 'maintenance' && (
                                            <div className="space-y-4">
                                                <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--glass-border)] p-4">
                                                    <div className="flex justify-between items-center mb-4">
                                                        <div>
                                                            <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">Maintenance</h4>
                                                            <p className="text-sm text-[var(--color-text-muted)]">Clean up orphaned playlists and optimize database storage.</p>
                                                        </div>
                                                    </div>
                                                    <button 
                                                        onClick={handleCleanupPlaylists}
                                                        className="btn btn-danger"
                                                    >
                                                        <Trash2 size={16} /> Clean Orphaned Playlists
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activeTab === 'Users' && (
                                    <AdminSettingsContent
                                        getAuthHeader={getAuthHeader}
                                        currentUser={currentUser}
                                        showToast={showToast}
                                    />
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {confirmDialog && (
                <ConfirmModal
                    title={confirmDialog.title}
                    message={confirmDialog.message}
                    confirmLabel={confirmDialog.confirmLabel}
                    onConfirm={confirmDialog.onConfirm}
                    onCancel={() => setConfirmDialog(null)}
                />
            )}

            {promptDialog && (
                               <PromptModal
                    title={promptDialog.title}
                    label={promptDialog.label}
                    placeholder={promptDialog.placeholder}
                    onSubmit={promptDialog.onSubmit}
                    onCancel={() => setPromptDialog(null)}
                />
            )}

            {toast && (
                <Toast
                    message={toast.message}
                    type={toast.type}
                    onDismiss={() => setToast(null)}
                />
            )}
        </div>,
        document.body
    );
};

// ==========================================
// Admin Settings Content (inline component)
// ==========================================

interface User {
  id: string;
  username: string;
  role: string;
  created_at: number;
  last_login_at: number;
}

interface Invite {
  token: string;
  created_by: string;
  role: string;
  max_uses: number;
  uses: number;
  expires_at: number | null;
  created_at: number;
}

const AdminSettingsContent: React.FC<{
  getAuthHeader: () => Record<string, string>;
  currentUser: { id: string; username: string; role: string } | null;
  showToast: (msg: string, type: ToastType) => void;
}> = ({ getAuthHeader, currentUser, showToast }) => {
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [adminTab, setAdminTab] = useState<'users' | 'invites'>('users');
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [createError, setCreateError] = useState('');
  const [copiedToken, setCopiedToken] = useState('');
  const [inviteUrls, setInviteUrls] = useState<Record<string, string>>({});

  const authHeaders = getAuthHeader();

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/admin/users', { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
      }
    } catch (e) { console.error('Failed to fetch users', e); }
  };

  const fetchInvites = async () => {
    try {
      const res = await fetch('/api/admin/invites', { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setInvites(data.invites);
      }
    } catch (e) { console.error('Failed to fetch invites', e); }
  };

  React.useEffect(() => { fetchUsers(); fetchInvites(); }, []);

  const createUser = async () => {
    setCreateError('');
    if (newUsername.length < 3 || newPassword.length < 5) {
      setCreateError('Username 3+ chars, password 5+ chars');
      return;
    }
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole })
      });
      if (res.ok) {
        setNewUsername(''); setNewPassword(''); setNewRole('user');
        setShowCreateUser(false);
        fetchUsers();
        showToast('User created', 'success');
      } else {
        const data = await res.json();
        setCreateError(data.error || 'Failed');
      }
    } catch (e) { setCreateError('Network error'); }
  };

  const deleteUser = async (id: string) => {
    if (id === currentUser?.id) return;
    try {
      await fetch(`/api/admin/users/${id}`, { method: 'DELETE', headers: authHeaders });
      fetchUsers();
      showToast('User deleted', 'success');
    } catch (e) { console.error(e); }
  };

  const createInvite = async () => {
    try {
      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ role: 'user', maxUses: 1 })
      });
      if (res.ok) {
        const data = await res.json();
        setInviteUrls(prev => ({ ...prev, [data.invite.token]: data.inviteUrl }));
        fetchInvites();
        showToast('Invite created', 'success');
      }
    } catch (e) { console.error(e); }
  };

  const revokeInvite = async (token: string) => {
    try {
      await fetch(`/api/admin/invites/${token}`, { method: 'DELETE', headers: authHeaders });
      fetchInvites();
      showToast('Invite revoked', 'success');
    } catch (e) { console.error(e); }
  };

  const copyToClipboard = (text: string, token: string) => {
    navigator.clipboard.writeText(text);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(''), 2000);
    showToast('Copied to clipboard', 'success');
  };

  const formatDate = (ts: number | string) => {
    const num = Number(ts);
    if (!num || isNaN(num)) return 'Never';
    return new Date(num).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="settings-section mb-8">
      <div className="settings-section-header mb-4">
        <h3 className="text-xl font-bold text-[var(--color-text-primary)]">User Management</h3>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setAdminTab('users')}
          className={`btn-tab ${adminTab === 'users' ? 'active' : ''}`}
        >
          <Users className="w-4 h-4 inline mr-1" /> Users ({users.length})
        </button>
        <button
          onClick={() => setAdminTab('invites')}
          className={`btn-tab ${adminTab === 'invites' ? 'active' : ''}`}
        >
          <Link className="w-4 h-4 inline mr-1" /> Invites ({invites.length})
        </button>
      </div>

      {adminTab === 'users' && (
        <div className="space-y-3">
          {!showCreateUser ? (
            <button
              onClick={() => setShowCreateUser(true)}
              className="btn-dashed"
            >
              <Plus className="w-4 h-4" /> Add User
            </button>
          ) : (
            <div className="bg-[var(--color-surface)] rounded-xl p-4 space-y-3 border border-[var(--glass-border)]">
              <input
                type="text" value={newUsername} onChange={e => setNewUsername(e.target.value)}
                placeholder="Username" autoFocus
                className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
              />
              <input
                type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                placeholder="Password"
                className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
              />
              <select value={newRole} onChange={e => setNewRole(e.target.value)}
                className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none"
              >
                <option value="user">Regular User</option>
                <option value="admin">Admin</option>
              </select>
              {createError && <p className="text-red-400 text-xs">{createError}</p>}
              <div className="flex gap-2">
                <button onClick={createUser} className="btn btn-primary flex-1">Create</button>
                <button onClick={() => { setShowCreateUser(false); setCreateError(''); }} className="btn btn-ghost">Cancel</button>
              </div>
            </div>
          )}

          {users.map(user => (
            <div key={user.id} className="flex items-center justify-between p-3 bg-[var(--color-surface)] rounded-xl border border-[var(--glass-border)]">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[var(--color-text-primary)]">{user.username}</span>
                  {user.role === 'admin' && (
                    <span className="text-[0.65rem] px-2 py-0.5 rounded-full bg-[var(--color-primary)]/20 text-[var(--color-primary)] font-semibold uppercase">Admin</span>
                  )}
                  {user.id === currentUser?.id && (
                    <span className="text-[0.65rem] px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 font-semibold">You</span>
                  )}
                </div>
                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                  Joined {formatDate(user.created_at)} · Last login {formatDate(user.last_login_at)}
                </p>
              </div>
              {user.id !== currentUser?.id && (
                <button onClick={() => deleteUser(user.id)} className="btn-icon btn-danger" title="Delete">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {adminTab === 'invites' && (
        <div className="space-y-3">
          <button
            onClick={createInvite}
            className="btn-dashed"
          >
            <Plus className="w-4 h-4" /> Generate Invite Link
          </button>

          {invites.map(invite => {
            const isExpired = invite.expires_at && Date.now() > invite.expires_at;
            const isUsedUp = invite.uses >= invite.max_uses;
            const inviteUrl = inviteUrls[invite.token] || `${window.location.origin}/invite/${invite.token}`;

            return (
              <div key={invite.token} className={`p-3 bg-[var(--color-surface)] rounded-xl border border-[var(--glass-border)] ${isExpired || isUsedUp ? 'opacity-50' : ''}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-[var(--color-text-muted)]">{invite.token.substring(0, 12)}...</span>
                    {invite.role === 'admin' && <span className="text-[0.65rem] px-2 py-0.5 rounded-full bg-[var(--color-primary)]/20 text-[var(--color-primary)] font-semibold uppercase">Admin</span>}
                    {isExpired && <span className="text-[0.65rem] px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">Expired</span>}
                    {isUsedUp && !isExpired && <span className="text-[0.65rem] px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">Used</span>}
                  </div>
                  <button onClick={() => revokeInvite(invite.token)} className="btn-icon btn-danger" title="Revoke">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-[var(--color-bg)] px-3 py-2 rounded-lg text-[var(--color-text-primary)] truncate">{inviteUrl}</code>
                  <button onClick={() => copyToClipboard(inviteUrl, invite.token)} className="btn-icon" title="Copy">
                    {copiedToken === invite.token ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                  Uses: {invite.uses}/{invite.max_uses} · Created {formatDate(invite.created_at)}
                </p>
              </div>
            );
          })}

          {invites.length === 0 && (
            <p className="text-center text-sm text-[var(--color-text-muted)] py-8">No invites yet. Generate one to invite users.</p>
          )}
        </div>
      )}
    </div>
  );
};
