import React, { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/index';
import { useLlmConnectionTest } from '../hooks/useLlmConnectionTest';
import { ConfirmModal } from './ConfirmModal';
import { PromptModal } from './PromptModal';
import { Toast, type ToastType } from './Toast';
import { Folder, User, Palette, Play, Cpu, Globe, LogOut, Search, X, Shield, Users, Link, Trash2, Plus, Copy, Check, Database, BarChart2, Wrench } from 'lucide-react';
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
    const geniusApiKey = usePlayerStore(state => state.geniusApiKey);
    const setGeniusApiKey = usePlayerStore(state => state.setGeniusApiKey);
    const preferredProvider = usePlayerStore(state => state.preferredProvider);
    const setPreferredProvider = usePlayerStore(state => state.setPreferredProvider);

    const discoveryLevel = usePlayerStore(state => state.discoveryLevel);
    const genreStrictness = usePlayerStore(state => state.genreStrictness);
    const artistAmnesiaLimit = usePlayerStore(state => state.artistAmnesiaLimit);
    const audioAnalysisCpu = usePlayerStore(state => state.audioAnalysisCpu);
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
    
    const [isClosing, setIsClosing] = useState(false);
    const [isRunningMatrix, setIsRunningMatrix] = useState(false);
    const [mappings, setMappings] = useState<Record<string, string>>({});

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
            },
        });
    };

    const handleRescanFolder = async (folderPath: string) => {
        try {
            const authHeaders = getAuthHeader();
            await fetch('/api/library/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ path: folderPath })
            });
            await fetchLibraryFromServer();
        } catch (e) {
            console.error('Failed to rescan folder', e);
        }
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

    const [activeTab, setActiveTab] = useState('My Account');
    const [dbTab, setDbTab] = useState<'stats' | 'maintenance'>('stats');

    const isAdmin = currentUser?.role === 'admin';

    const tabs = [
        { id: 'My Account', label: 'My Account', category: 'User Settings' },
        { id: 'Appearance', label: 'Appearance', category: 'App Settings' },
        { id: 'Library', label: 'Library', category: 'App Settings' },
        { id: 'Playback', label: 'Playback', category: 'App Settings' },
        ...(isAdmin ? [
            { id: 'System', label: 'System', category: 'Server Settings' },
            { id: 'Providers', label: 'Providers', category: 'Server Settings' },
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
        if (tab.id === 'Library') return 'folder path scan library'.includes(query);
        if (tab.id === 'Playback') return 'infinity discovery genre artist amnesia matrix'.includes(query);
        if (tab.id === 'System') return 'cpu audio analysis hub schedule'.includes(query);
        if (tab.id === 'Providers') return 'llm api host model key last.fm genius'.includes(query);
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
                                                 tab.id === 'Genre Matrix' ? Globe : Globe;
                                    
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

                {/* Main Content */}
                <div className="settings-content-wrapper">
                    <div className="settings-content-container">
                        <div className="settings-content">
                            <div className="settings-content-scroll overflow-y-auto p-8">
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
                                                <button type="submit"
                                                    className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors">
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
                                                className="bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors"
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
                                                className={`flex-1 py-4 rounded-xl border font-semibold tracking-wide transition-all duration-300 ${theme === 'light' ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white shadow-lg scale-100' : 'border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)]'}`}
                                                onClick={() => setTheme('light')}
                                            >
                                                ☀️ Light
                                            </button>
                                            <button 
                                                className={`flex-1 py-4 rounded-xl border font-semibold tracking-wide transition-all duration-300 ${theme === 'dark' ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white shadow-lg scale-100 dark:bg-[var(--aurora-purple)] dark:border-[var(--aurora-purple)]' : 'border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)]'}`}
                                                onClick={() => setTheme('dark')}
                                            >
                                                🌙 Dark
                                            </button>
                                        </div>
                                    </div>
                                )}
                            
                                {activeTab === 'Library' && (
                                    <div className="settings-section mb-8">
                                        <div className="settings-section-header flex justify-between items-center mb-4">
                                            <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Mapped Folders</h3>
                                            <button className="btn btn-small" onClick={handleAddFolder}>
                                                ＋ Map Folder Path
                                            </button>
                                        </div>
                                        <p className="text-sm text-[var(--color-text-muted)] mb-4">
                                            Folders mapped here will be automatically scanned.
                                        </p>
                                        <ul className="flex flex-col gap-2">
                                            {libraryFolders.length === 0 ? (
                                                <li className="p-4 rounded-xl border border-dashed border-[var(--glass-border)] bg-[var(--glass-bg)] text-center text-sm text-[var(--color-text-muted)] backdrop-blur-sm">
                                                    No folders mapped yet.
                                                </li>
                                            ) : (
                                                libraryFolders.map((folderPath) => (
                                                    <li key={folderPath} className="flex justify-between items-center p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-sm backdrop-blur-sm">
                                                        <span className="text-sm truncate mr-4 text-[var(--color-text-primary)] font-medium flex items-center gap-2"><Folder size={16} className="shrink-0 text-[var(--color-text-muted)]" /> {folderPath}</span>
                                                        <div className="flex gap-2 shrink-0">
                                                            <button className="font-semibold text-xs bg-[var(--color-primary)] text-white px-3 py-1.5 rounded-lg hover:bg-[var(--color-primary-dark)] transition-colors" onClick={() => handleRescanFolder(folderPath)}>Rescan</button>
                                                            <button className="font-semibold text-xs bg-[var(--color-error)] text-white px-3 py-1.5 rounded-lg hover:bg-red-600 transition-colors" onClick={() => removeLibraryFolder(folderPath)}>Remove</button>
                                                        </div>
                                                    </li>
                                                ))
                                            )}
                                        </ul>
                                    </div>
                                )}

                                {activeTab === 'Playback' && (
                                    <div className="settings-section mb-8">
                                        <div className="settings-section-header mb-4">
                                            <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Infinity Mode Algorithm</h3>
                                        </div>
                                        <p className="text-sm text-[var(--color-text-muted)] mb-6">
                                            Tune how the engine selects the next track organically.
                                        </p>
                                        
                                        <div className="mb-6">
                                            <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                                <span>Discovery Level (Wander Factor)</span>
                                                <span>{discoveryLevel}%</span>
                                            </label>
                                            <input type="range" min="1" max="100" value={discoveryLevel} onChange={e => setSettings({ discoveryLevel: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                        </div>

                                        <div className="mb-6">
                                            <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                                <span>Genre Strictness</span>
                                                <span>{genreStrictness}%</span>
                                            </label>
                                            <input type="range" min="0" max="100" value={genreStrictness} onChange={e => setSettings({ genreStrictness: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
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
                                        </div>
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
                                                <option value="Background">Background (Low / Async)</option>
                                                <option value="Balanced">Balanced</option>
                                                <option value="Maximum">Maximum (Fastest Scan)</option>
                                            </select>
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
                                                   className="btn font-semibold text-xs bg-[var(--color-error)]/10 border border-[var(--color-error)]/30 px-4 py-2 rounded-lg hover:bg-[var(--color-error)]/20 text-[var(--color-error)] transition-all shadow-sm flex items-center gap-2"
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

                                {activeTab === 'Providers' && (
                                    <div className="settings-section mb-8">
                                        <div className="settings-section-header mb-4">
                                            <h3 className="text-xl font-bold text-[var(--color-text-primary)]">LLM / Engine Configurations</h3>
                                        </div>
                                        <p className="text-sm text-[var(--color-text-muted)] mb-4">
                                            Bring your own LLM to generate Hub playlists securely on your own hardware.
                                        </p>
                                        <div className="flex flex-col gap-4 mb-8 border-b border-[var(--glass-border)] pb-8">
                                            <div>
                                                <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">API Base URL</label>
                                                <input 
                                                    type="text" 
                                                    value={llmBaseUrl} 
                                                    onChange={(e) => setSettings({ llmBaseUrl: e.target.value })}
                                                    placeholder="https://api.openai.com/v1"
                                                    className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">API Key</label>
                                                <input 
                                                    type="password" 
                                                    value={llmApiKey} 
                                                    onChange={(e) => setSettings({ llmApiKey: e.target.value })}
                                                    placeholder="Leave blank if using local unrestricted provider"
                                                    className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
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
                                                    className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
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
                                                    className="font-semibold text-sm px-4 py-2 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-lg hover:bg-[var(--glass-bg-hover)] transition-colors text-[var(--color-text-primary)] disabled:opacity-50"
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

                                        <div className="settings-section-header mb-4">
                                            <h3 className="font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase">Metadata Providers</h3>
                                        </div>
                                        <div className="flex flex-col gap-4">
                                            <div>
                                                <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Last.fm API Key</label>
                                                <input type="text" value={lastFmApiKey} onChange={e => setLastFmApiKey(e.target.value)} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Genius Access Token</label>
                                                <input type="text" value={geniusApiKey} onChange={e => setGeniusApiKey(e.target.value)} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none" />
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
                                                className="shrink-0 font-semibold text-sm px-4 py-2.5 bg-[var(--color-primary)] text-white rounded-xl hover:bg-[var(--color-primary-dark)] transition-colors disabled:opacity-50 shadow-sm inline-flex items-center gap-2"
                                            >
                                                {isRunningMatrix && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                                                {isRunningMatrix ? (genreMatrixProgress?.replace('Categorizing ', '') || 'Running...') : 'Incremental Run'}
                                            </button>
                                            <button
                                                onClick={handleRemapAll}
                                                disabled={isRunningMatrix}
                                                className="shrink-0 font-semibold text-sm bg-red-500/10 border border-red-500/30 rounded-xl hover:bg-red-500/20 transition-colors text-red-400 disabled:opacity-50 px-4 py-2.5"
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
                                                className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${dbTab === 'stats' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
                                            >
                                                <BarChart2 size={16} className="inline mr-1 relative -top-[1px]" /> Stats
                                            </button>
                                            <button
                                                onClick={() => setDbTab('maintenance')}
                                                className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${dbTab === 'maintenance' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
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
                                                        className="btn font-semibold text-sm bg-red-500/10 border border-red-500/30 px-4 py-2.5 rounded-xl hover:bg-red-500/20 text-red-400 transition-all shadow-sm flex items-center gap-2"
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
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${adminTab === 'users' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
        >
          <Users className="w-4 h-4 inline mr-1" /> Users ({users.length})
        </button>
        <button
          onClick={() => setAdminTab('invites')}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${adminTab === 'invites' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
        >
          <Link className="w-4 h-4 inline mr-1" /> Invites ({invites.length})
        </button>
      </div>

      {adminTab === 'users' && (
        <div className="space-y-3">
          {!showCreateUser ? (
            <button
              onClick={() => setShowCreateUser(true)}
              className="w-full py-3 rounded-xl border-2 border-dashed border-[var(--glass-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-all flex items-center justify-center gap-2"
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
                <button onClick={createUser} className="flex-1 py-2 bg-[var(--color-primary)] text-white rounded-lg text-sm font-semibold hover:bg-[var(--color-primary-dark)]">Create</button>
                <button onClick={() => { setShowCreateUser(false); setCreateError(''); }} className="px-4 py-2 bg-[var(--glass-border)] text-[var(--color-text-secondary)] rounded-lg text-sm">Cancel</button>
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
                <button onClick={() => deleteUser(user.id)} className="p-2 text-red-400/60 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all" title="Delete">
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
            className="w-full py-3 rounded-xl border-2 border-dashed border-[var(--glass-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-all flex items-center justify-center gap-2"
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
                  <button onClick={() => revokeInvite(invite.token)} className="p-1.5 text-red-400/60 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all" title="Revoke">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-[var(--color-bg)] px-3 py-2 rounded-lg text-[var(--color-text-primary)] truncate">{inviteUrl}</code>
                  <button onClick={() => copyToClipboard(inviteUrl, invite.token)} className="p-2 bg-[var(--color-bg)] rounded-lg hover:bg-[var(--glass-border)] transition-all" title="Copy">
                    {copiedToken === invite.token ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-[var(--color-text-secondary)]" />}
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
