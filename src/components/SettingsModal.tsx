import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/index';
import { Globe, User, Palette, Folder, Play, Cpu, LogOut, Search, X, Users, Database, Brain } from 'lucide-react';

import { AccountTab } from './settings/AccountTab';
import { AppearanceTab } from './settings/AppearanceTab';
import { LibraryTab } from './settings/LibraryTab';
import { PlaybackTab } from './settings/PlaybackTab';
import { SystemTab } from './settings/SystemTab';
import { GenAiTab } from './settings/GenAiTab';
import { GenreMatrixTab } from './settings/GenreMatrixTab';
import { DatabaseTab } from './settings/DatabaseTab';
import { MetadataTab } from './settings/MetadataTab';
import { AdminDashboard } from './settings/AdminDashboard';

interface SettingsModalProps {
    onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
    const loadSettings = usePlayerStore(state => state.loadSettings);
    const saveSettings = usePlayerStore(state => state.saveSettings);
    const currentUser = usePlayerStore(state => state.currentUser);
    const clearAuthToken = usePlayerStore(state => state.clearAuthToken);

    const [isClosing, setIsClosing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
    const [activeTab, setActiveTab] = useState('My Account');

    // 1. On mount: fetch latest settings
    useEffect(() => {
        loadSettings();
    }, [loadSettings]);

    // Handle Resize
    useEffect(() => {
        const handler = () => setIsMobile(window.innerWidth < 768);
        window.addEventListener('resize', handler);
        return () => window.removeEventListener('resize', handler);
    }, []);

    const handleClose = async () => {
        setIsClosing(true);
        await saveSettings();
        setTimeout(() => onClose(), 280); 
    };

    const isAdmin = currentUser?.role === 'admin';

    const tabs = [
        { id: 'My Account', label: 'My Account', category: 'User Settings' },
        { id: 'Appearance', label: 'Appearance', category: 'App Settings' },
        { id: 'Library', label: 'Library', category: 'App Settings' },
        { id: 'Metadata', label: 'Metadata', category: 'App Settings' },
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
        if (tab.id === 'Library') return 'folder path scan library stats analysis'.includes(query);
        if (tab.id === 'Metadata') return 'genius musicbrainz lastfm provider album bio image api mapping keys'.includes(query);
        if (tab.id === 'Playback') return 'infinity discovery genre artist amnesia matrix llm playlist diversity blend tracks wander'.includes(query);
        if (tab.id === 'System') return 'cpu audio analysis hub schedule auto-start'.includes(query);
        if (tab.id === 'GenAI') return 'llm api host model key'.includes(query);
        if (tab.id === 'Genre Matrix') return 'genre matrix transition hop cost mapping'.includes(query);
        if (tab.id === 'Database') return 'database postgres container podman start stop status'.includes(query);
        if (tab.id === 'Users') return 'admin users invites manage'.includes(query);
        
        return false;
    });

    const navGroups = ['User Settings', 'App Settings', 'Server Settings', 'Admin'];

    return createPortal(
        <div className={`settings-full-backdrop ${isClosing ? 'closing' : ''}`}>
            <div className="flex w-full h-[100dvh] md:h-auto md:max-h-[85vh] md:w-[90vw] md:max-w-6xl bg-[var(--color-background)] md:rounded-3xl shadow-2xl overflow-hidden relative flex-col md:flex-row border border-black/10 dark:border-white/5" onClick={e => e.stopPropagation()}>
                
                {/* Close Button UI */}
                <div className="absolute top-4 right-4 flex items-center justify-center z-50 group">
                    <button 
                        onClick={handleClose}
                        className="w-10 h-10 rounded-full bg-[var(--color-surface)] border border-[var(--glass-border)] hover:bg-[var(--glass-bg-hover)] text-[var(--color-text-primary)] flex items-center justify-center backdrop-blur-md transition-all active:scale-95 shadow-lg"
                        aria-label="Close Settings"
                    >
                        <X size={20} />
                    </button>
                    <span className="hidden md:block absolute right-14 px-2 py-1 bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-primary)] text-xs rounded opacity-0 translate-x-[10px] group-hover:opacity-100 group-hover:translate-x-0 transition-all pointer-events-none shadow-lg">ESC</span>
                </div>

                {/* Mobile: Horizontal tab bar at top */}
                {isMobile && (
                    <div className="w-full bg-[var(--color-surface)] border-b border-[var(--glass-border)] pt-[env(safe-area-inset-top)] z-10 shrink-0">
                        <div className="flex items-center gap-2 overflow-x-auto hide-scrollbar px-3 pt-4 pb-3">
                            {filteredTabs.map(tab => {
                                const Icon = tab.id === 'My Account' ? User : 
                                    tab.id === 'Appearance' ? Palette :
                                    tab.id === 'Library' ? Folder :
                                    tab.id === 'Metadata' ? Globe :
                                    tab.id === 'Playback' ? Play :
                                    tab.id === 'System' ? Cpu :
                                    tab.id === 'Users' ? Users :
                                    tab.id === 'Database' ? Database :
                                    tab.id === 'GenAI' ? Brain : Globe;

                                return (
                                    <button
                                        key={tab.id}
                                        role="tab"
                                        aria-selected={activeTab === tab.id}
                                        data-settings-tab={tab.id === 'GenAI' ? 'genai' : tab.id === 'Database' ? 'database' : tab.id === 'Genre Matrix' ? 'genre-matrix' : ''}
                                        onClick={() => setActiveTab(tab.id)}
                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                                            activeTab === tab.id
                                                ? 'bg-[var(--color-primary)] text-white'
                                                : 'text-[var(--color-text-muted)] bg-[var(--color-surface-variant)] hover:bg-[var(--glass-bg-hover)]'
                                        }`}
                                    >
                                        <Icon size={14} />
                                        {tab.label}
                                    </button>
                                );
                            })}
                            <button
                                onClick={() => {
                                    clearAuthToken();
                                    handleClose();
                                }}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 text-red-500 bg-red-500/10 hover:bg-red-500/20 ml-auto"
                            >
                                <LogOut size={14} />
                                Sign Out
                            </button>
                        </div>
                    </div>
                )}

                {/* Desktop: Sidebar */}
                {!isMobile && (
                    <div className="w-72 shrink-0 bg-[var(--color-surface)] border-r border-[var(--glass-border)] flex flex-col pt-8 pb-4 z-10">
                        <div className="px-6 mb-6">
                            <h2 className="text-2xl font-bold text-[var(--color-text-primary)] tracking-tight">Settings</h2>
                        </div>
                        <div className="px-5 mb-6 relative">
                            <Search size={16} className="absolute left-8 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
                            <input 
                                type="text" 
                                className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-full pl-10 pr-4 py-2.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all placeholder:text-[var(--color-text-muted)]" 
                                placeholder="Search settings..." 
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>

                        <div className="flex-1 overflow-y-auto px-3 pb-6 hide-scrollbar">
                            {navGroups.map(group => {
                                const groupTabs = filteredTabs.filter(t => t.category === group);
                                if (groupTabs.length === 0) return null;
                                
                                return (
                                    <div key={group} className="mb-6">
                                        <h4 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider pl-3 mb-2">{group}</h4>
                                        <div className="flex flex-col gap-0.5">
                                            {groupTabs.map(tab => {
                                                const Icon = tab.id === 'My Account' ? User : 
                                                            tab.id === 'Appearance' ? Palette :
                                                            tab.id === 'Library' ? Folder :
                                                            tab.id === 'Metadata' ? Globe :
                                                            tab.id === 'Playback' ? Play :
                                                            tab.id === 'System' ? Cpu :
                                                            tab.id === 'Users' ? Users :
                                                            tab.id === 'Database' ? Database :
                                                            tab.id === 'Genre Matrix' ? Globe :
                                                            tab.id === 'GenAI' ? Brain : Globe;
                                                
                                                return (
                                                    <button 
                                                        key={tab.id}
                                                        role="tab"
                                                        aria-selected={activeTab === tab.id}
                                                        data-settings-tab={tab.id === 'GenAI' ? 'genai' : tab.id === 'Database' ? 'database' : tab.id === 'Genre Matrix' ? 'genre-matrix' : ''}
                                                        className={`w-full flex items-center px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                                                            activeTab === tab.id 
                                                            ? 'bg-[var(--color-primary)] text-white shadow-md' 
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
                                    className="w-full flex items-center px-3 py-2.5 rounded-xl text-sm font-medium text-red-500 hover:bg-red-500/10 transition-colors"
                                    onClick={() => {
                                        clearAuthToken();
                                        handleClose();
                                    }}
                                >
                                    <LogOut size={18} className="mr-3 opacity-70" />
                                    Sign Out
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Main Content Area */}
                <div className="flex-1 flex flex-col bg-[var(--color-background)] overflow-hidden relative">
                    {/* Top gradient blur matching Aurora theme */}
                    <div className="absolute top-[-100px] right-[-100px] w-[500px] h-[500px] bg-[var(--color-primary)]/10 rounded-full blur-[100px] pointer-events-none"></div>
                    
                    <div className="flex-1 overflow-y-auto px-4 md:px-10 py-6 md:py-10 pb-[env(safe-area-inset-bottom)]">
                        <div className="max-w-2xl mx-auto w-full relative z-10">
                            {activeTab === 'My Account' && <AccountTab onClose={handleClose} />}
                            {activeTab === 'Appearance' && <AppearanceTab />}
                            {activeTab === 'Library' && <LibraryTab />}
                            {activeTab === 'Metadata' && <MetadataTab />}
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
                        </div>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
};
