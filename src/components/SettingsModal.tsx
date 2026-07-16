import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/index';
import { Globe, User, Palette, Folder, Play, Cpu, LogOut, Search, X, Users, Database, Brain, Ticket, GitMerge, KeyRound, Radio } from 'lucide-react';

interface SettingsModalProps {
    onClose: () => void;
}

interface SettingsTab {
    id: string;
    label: string;
    category: 'User Settings' | 'App Settings' | 'Server Settings' | 'Admin';
}

const COMPACT_LAYOUT_QUERY = '(max-width: 1023px)';

const AccountTab = React.lazy(() => import('./settings/AccountTab').then(module => ({ default: module.AccountTab })));
const ScrobblingTab = React.lazy(() => import('./settings/ScrobblingTab').then(module => ({ default: module.ScrobblingTab })));
const ApiKeysTab = React.lazy(() => import('./settings/ApiKeysTab').then(module => ({ default: module.ApiKeysTab })));
const AppearanceTab = React.lazy(() => import('./settings/AppearanceTab').then(module => ({ default: module.AppearanceTab })));
const LibraryTab = React.lazy(() => import('./settings/LibraryTab').then(module => ({ default: module.LibraryTab })));
const PlaybackTab = React.lazy(() => import('./settings/PlaybackTab').then(module => ({ default: module.PlaybackTab })));
const SystemTab = React.lazy(() => import('./settings/SystemTab').then(module => ({ default: module.SystemTab })));
const GenAiTab = React.lazy(() => import('./settings/GenAiTab').then(module => ({ default: module.GenAiTab })));
const GenreMatrixTab = React.lazy(() => import('./settings/GenreMatrixTab').then(module => ({ default: module.GenreMatrixTab })));
const DatabaseTab = React.lazy(() => import('./settings/DatabaseTab').then(module => ({ default: module.DatabaseTab })));
const MetadataTab = React.lazy(() => import('./settings/MetadataTab').then(module => ({ default: module.MetadataTab })));
const LiveMusicTab = React.lazy(() => import('./settings/LiveMusicTab').then(module => ({ default: module.LiveMusicTab })));
const LibraryEntitiesTab = React.lazy(() => import('./settings/LibraryEntitiesTab').then(module => ({ default: module.LibraryEntitiesTab })));
const AdminDashboard = React.lazy(() => import('./settings/AdminDashboard').then(module => ({ default: module.AdminDashboard })));

const SettingsTabFallback: React.FC = () => (
    <div className="space-y-4 animate-pulse">
        <div className="h-7 w-44 rounded bg-[var(--color-surface-variant)]" />
        <div className="h-4 w-72 max-w-full rounded bg-[var(--color-surface-variant)]" />
        <div className="mt-8 space-y-3">
            <div className="h-16 rounded-2xl bg-[var(--color-surface-variant)]" />
            <div className="h-16 rounded-2xl bg-[var(--color-surface-variant)]" />
            <div className="h-16 rounded-2xl bg-[var(--color-surface-variant)]" />
        </div>
    </div>
);

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
    const loadSettings = usePlayerStore(state => state.loadSettings);
    const saveSettings = usePlayerStore(state => state.saveSettings);
    const currentUser = usePlayerStore(state => state.currentUser);
    const clearAuthToken = usePlayerStore(state => state.clearAuthToken);

    const [isClosing, setIsClosing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [isCompactLayout, setIsCompactLayout] = useState(() => (
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(COMPACT_LAYOUT_QUERY).matches
            : false
    ));
    const [activeTab, setActiveTab] = useState('My Account');

    useEffect(() => {
        loadSettings();
    }, [loadSettings]);

    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, []);

    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;

        const mediaQuery = window.matchMedia(COMPACT_LAYOUT_QUERY);
        const handleChange = (event: MediaQueryListEvent) => setIsCompactLayout(event.matches);

        setIsCompactLayout(mediaQuery.matches);
        mediaQuery.addEventListener('change', handleChange);
        return () => mediaQuery.removeEventListener('change', handleChange);
    }, []);

    const handleClose = useCallback(async () => {
        if (isClosing) return;
        setIsClosing(true);
        await saveSettings();
        setTimeout(() => onClose(), 280); 
    }, [isClosing, onClose, saveSettings]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                handleClose();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleClose]);

    const isAdmin = currentUser?.role === 'admin';

    const tabs: SettingsTab[] = useMemo(() => [
        { id: 'My Account', label: 'My Account', category: 'User Settings' },
        { id: 'Scrobbling', label: 'Scrobbling', category: 'User Settings' },
        { id: 'API Keys', label: 'API Keys', category: 'User Settings' },
        { id: 'Live Music', label: 'Live Music', category: 'User Settings' },
        { id: 'Appearance', label: 'Appearance', category: 'App Settings' },
        ...(isAdmin ? ([
            { id: 'Library', label: 'Library', category: 'App Settings' },
            { id: 'Library Entities', label: 'Library Entities', category: 'App Settings' },
            { id: 'Metadata', label: 'Metadata', category: 'App Settings' },
        ] satisfies SettingsTab[]) : []),
        { id: 'Playback', label: 'Playback', category: 'App Settings' },
        ...(isAdmin ? ([
            { id: 'System', label: 'System', category: 'Server Settings' },
            { id: 'GenAI', label: 'GenAI', category: 'Server Settings' },
            { id: 'Genre Matrix', label: 'Genre Matrix', category: 'Server Settings' },
            { id: 'Database', label: 'Database', category: 'Server Settings' },
            { id: 'Users', label: 'Users', category: 'Admin' },
        ] satisfies SettingsTab[]) : []),
    ], [isAdmin]);

    const filteredTabs = useMemo(() => tabs.filter(tab => {
        const query = searchQuery.trim().toLowerCase();
        if (!query) return true;
        if (tab.label.toLowerCase().includes(query)) return true;
        
        // Also search within common setting labels for this tab
        if (tab.id === 'Scrobbling') return 'scrobble scrobbling lastfm last.fm listenbrainz listen brainz connect account now playing love listening services subsonic opensubsonic bridge symfonium'.includes(query);
        if (tab.id === 'API Keys') return 'api key keys subsonic opensubsonic rest client rotate revoke delete'.includes(query);
        if (tab.id === 'Appearance') return 'light dark theme'.includes(query);
        if (tab.id === 'Library') return 'folder path scan library stats analysis'.includes(query);
        if (tab.id === 'Library Entities') return 'artist genre duplicate group merge canonical compound credit identity library hygiene'.includes(query);
        if (tab.id === 'Metadata') return 'genius musicbrainz lastfm jambase provider album bio image api mapping keys concerts tour live'.includes(query);
        if (tab.id === 'Live Music') return 'concerts tour live tickets jambase events location subscribe artists'.includes(query);
        if (tab.id === 'Playback') return 'infinity discovery genre artist amnesia matrix llm playlist diversity blend tracks wander played threshold scrobble count percent listened sleep timer quality streaming'.includes(query);
        if (tab.id === 'System') return 'cpu audio analysis hub schedule auto-start opensubsonic subsonic api rest security captcha turnstile cloudflare sign-in login protection'.includes(query);
        if (tab.id === 'GenAI') return 'llm api host model key'.includes(query);
        if (tab.id === 'Genre Matrix') return 'genre matrix transition hop cost mapping'.includes(query);
        if (tab.id === 'Database') return 'database postgres container podman start stop status'.includes(query);
        if (tab.id === 'Users') return 'admin users invites manage'.includes(query);
        
        return false;
    }), [searchQuery, tabs]);

    const navGroups: SettingsTab['category'][] = ['User Settings', 'App Settings', 'Server Settings', 'Admin'];

    useEffect(() => {
        if (!searchQuery.trim() || filteredTabs.length === 0 || filteredTabs.some(tab => tab.id === activeTab)) {
            return;
        }

        setActiveTab(filteredTabs[0].id);
    }, [activeTab, filteredTabs, searchQuery]);

    const getTabIcon = (tabId: string) => {
        if (tabId === 'My Account') return User;
        if (tabId === 'Scrobbling') return Radio;
        if (tabId === 'API Keys') return KeyRound;
        if (tabId === 'Live Music') return Ticket;
        if (tabId === 'Appearance') return Palette;
        if (tabId === 'Library') return Folder;
        if (tabId === 'Library Entities') return GitMerge;
        if (tabId === 'Metadata') return Globe;
        if (tabId === 'Playback') return Play;
        if (tabId === 'System') return Cpu;
        if (tabId === 'Users') return Users;
        if (tabId === 'Database') return Database;
        if (tabId === 'GenAI') return Brain;
        return Globe;
    };

    const getTabDataAttribute = (tabId: string) => {
        if (tabId === 'GenAI') return 'genai';
        if (tabId === 'Database') return 'database';
        if (tabId === 'Genre Matrix') return 'genre-matrix';
        return undefined;
    };

    return createPortal(
        <div className={`settings-full-backdrop ${isClosing ? 'closing' : ''}`}>
            <div className="settings-modal-shell flex w-full h-[100dvh] lg:h-auto lg:max-h-[85vh] lg:w-[90vw] lg:max-w-6xl bg-[var(--color-background)] lg:rounded-3xl shadow-2xl overflow-hidden relative flex-col lg:flex-row border border-[var(--glass-border)]" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" onClick={e => e.stopPropagation()}>
                
                {/* Close Button UI */}
                <div className="settings-close-action absolute top-4 right-4 flex items-center justify-center z-50 group">
                    <button 
                        type="button"
                        onClick={handleClose}
                        disabled={isClosing}
                        className="w-10 h-10 rounded-full bg-[var(--color-surface)] border border-[var(--glass-border)] hover:bg-[var(--glass-bg-hover)] text-[var(--color-text-primary)] flex items-center justify-center backdrop-blur-md transition-ui active:scale-95 shadow-lg"
                        aria-label="Close Settings"
                    >
                        <X size={20} />
                    </button>
                    <span className="hidden md:block absolute right-14 px-2 py-1 bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-primary)] text-xs rounded opacity-0 translate-x-[10px] group-hover:opacity-100 group-hover:translate-x-0 transition-ui pointer-events-none shadow-lg">ESC</span>
                </div>

                {/* Compact: phone and tablet navigation */}
                {isCompactLayout && (
                    <div className="w-full bg-[var(--color-surface)] border-b border-[var(--glass-border)] pt-[var(--safe-area-top)] z-10 shrink-0 backdrop-blur-xl">
                        <div className="px-4 sm:px-6 pt-4 pb-3 pr-16">
                            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{tabs.find(tab => tab.id === activeTab)?.category}</p>
                            <h2 id="settings-modal-title" className="mt-1 text-xl font-bold text-[var(--color-text-primary)] tracking-tight">Settings</h2>
                        </div>

                        <div className="px-4 sm:px-6 pb-3 relative">
                            <Search size={16} className="absolute left-8 sm:left-10 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
                            <input
                                type="text"
                                aria-label="Search settings"
                                className="w-full min-h-11 bg-background border border-[var(--glass-border)] rounded-2xl pl-10 pr-4 py-2.5 text-base text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-primary/50 transition-ui placeholder:text-[var(--color-text-muted)]"
                                placeholder="Search settings"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>

                        <nav className="flex items-center gap-2 overflow-x-auto hide-scrollbar px-4 sm:px-6 pb-3" aria-label="Settings sections">
                            {filteredTabs.map(tab => {
                                const Icon = getTabIcon(tab.id);

                                return (
                                    <button
                                        type="button"
                                        key={tab.id}
                                        aria-current={activeTab === tab.id ? 'page' : undefined}
                                        data-settings-tab={getTabDataAttribute(tab.id)}
                                        onClick={() => setActiveTab(tab.id)}
                                        className={`flex min-h-11 items-center gap-2 px-3.5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-ui flex-shrink-0 ${
                                            activeTab === tab.id
                                                ? 'bg-[var(--color-primary)] text-[var(--color-bg-primary)] shadow-md'
                                                : 'text-[var(--color-text-muted)] bg-[var(--color-surface-variant)] hover:bg-[var(--glass-bg-hover)]'
                                        }`}
                                    >
                                        <Icon size={14} />
                                        {tab.label}
                                    </button>
                                );
                            })}
                            <button
                                type="button"
                                onClick={() => {
                                    clearAuthToken();
                                    handleClose();
                                }}
                                className="flex min-h-11 items-center gap-2 px-3.5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-ui flex-shrink-0 text-[var(--color-error)] bg-error/10 hover:bg-error/15 ml-auto"
                            >
                                <LogOut size={14} />
                                Sign Out
                            </button>
                        </nav>
                    </div>
                )}

                {/* Desktop: Sidebar */}
                {!isCompactLayout && (
                    <div className="w-72 shrink-0 bg-[var(--color-surface)] border-r border-[var(--glass-border)] flex flex-col pt-8 pb-4 z-10">
                        <div className="px-6 mb-6">
                            <h2 id="settings-modal-title" className="text-2xl font-bold text-[var(--color-text-primary)] tracking-tight">Settings</h2>
                        </div>
                        <div className="px-5 mb-6 relative">
                            <Search size={16} className="absolute left-8 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
                            <input 
                                type="text" 
                                aria-label="Search settings"
                                className="w-full bg-background border border-[var(--glass-border)] rounded-full pl-10 pr-4 py-2.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-primary/50 transition-ui placeholder:text-[var(--color-text-muted)]" 
                                placeholder="Search settings" 
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>

                        <nav className="flex-1 overflow-y-auto px-3 pb-6 hide-scrollbar" aria-label="Settings sections">
                            {navGroups.map(group => {
                                const groupTabs = filteredTabs.filter(t => t.category === group);
                                if (groupTabs.length === 0) return null;
                                
                                return (
                                    <div key={group} className="mb-6">
                                        <h4 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider pl-3 mb-2">{group}</h4>
                                        <div className="flex flex-col gap-0.5">
                                            {groupTabs.map(tab => {
                                                const Icon = getTabIcon(tab.id);
                                                
                                                return (
                                                    <button 
                                                        type="button"
                                                        key={tab.id}
                                                        aria-current={activeTab === tab.id ? 'page' : undefined}
                                                        data-settings-tab={getTabDataAttribute(tab.id)}
                                                        className={`w-full flex items-center px-3 py-2.5 rounded-xl text-sm font-medium transition-ui duration-200 ${
                                                            activeTab === tab.id 
                                                            ? 'bg-[var(--color-primary)] text-[var(--color-bg-primary)] shadow-md' 
                                                            : 'text-[var(--color-text-secondary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-text-primary)]'
                                                        }`}
                                                        onClick={() => setActiveTab(tab.id)}
                                                    >
                                                        <Icon size={18} className={`mr-3 ${activeTab === tab.id ? 'opacity-100' : 'opacity-70'}`} />
                                                        {tab.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}

                            <div className="mt-8 border-t border-[var(--glass-border)] pt-4">
                                <button 
                                    type="button"
                                    className="w-full flex items-center px-3 py-2.5 rounded-xl text-sm font-medium text-[var(--color-error)] hover:bg-error/10 transition-colors"
                                    onClick={() => {
                                        clearAuthToken();
                                        handleClose();
                                    }}
                                >
                                    <LogOut size={18} className="mr-3 opacity-70" />
                                    Sign Out
                                </button>
                            </div>
                        </nav>
                    </div>
                )}

                {/* Main Content Area */}
                <div className="flex-1 min-w-0 flex flex-col bg-[var(--color-background)] overflow-hidden relative">
                    <div className="settings-modal-ambient" aria-hidden="true"></div>
                    
                    <div className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-10 py-5 sm:py-7 lg:py-10 pb-[calc(1rem+var(--safe-area-bottom))]">
                        <div className="max-w-3xl lg:max-w-2xl mx-auto w-full relative z-10">
                            {filteredTabs.length === 0 ? (
                                <div className="rounded-2xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-5 shadow-lg" role="status">
                                    <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">No matching settings</h3>
                                    <p className="mt-2 text-sm text-[var(--color-text-secondary)]">Try a tab name like Playback, Library, Metadata, or GenAI.</p>
                                </div>
                            ) : (
                                <React.Suspense fallback={<SettingsTabFallback />}>
                                    {activeTab === 'My Account' && <AccountTab onClose={handleClose} />}
                                    {activeTab === 'Scrobbling' && <ScrobblingTab />}
                                    {activeTab === 'API Keys' && <ApiKeysTab />}
                                    {activeTab === 'Live Music' && <LiveMusicTab />}
                                    {activeTab === 'Appearance' && <AppearanceTab />}
                                    {isAdmin && activeTab === 'Library' && <LibraryTab />}
                                    {isAdmin && activeTab === 'Library Entities' && <LibraryEntitiesTab />}
                                    {isAdmin && activeTab === 'Metadata' && <MetadataTab />}
                                    {activeTab === 'Playback' && <PlaybackTab />}
                                    
                                    {isAdmin && (
                                        <>
                                            {activeTab === 'System' && <SystemTab />}
                                            {activeTab === 'GenAI' && <GenAiTab />}
                                            {activeTab === 'Genre Matrix' && <GenreMatrixTab />}
                                            {activeTab === 'Database' && <DatabaseTab />}
                                            {activeTab === 'Users' && <AdminDashboard />}
                                        </>
                                    )}
                                </React.Suspense>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
};
