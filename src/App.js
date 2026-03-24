import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React from 'react';
import { PlaylistSidebar } from './components/PlaylistSidebar';
import PlayerControls from './components/PlayerControls';
import ProgressBar from './components/ProgressBar';
import KeyboardHint from './components/KeyboardHint';
import { usePlayerStore } from './store/index';
import { LibraryHome } from './components/library/LibraryHome';
import { AlbumDetail } from './components/library/AlbumDetail';
import { ArtistDetail } from './components/library/ArtistDetail';
import { GenreDetail } from './components/library/GenreDetail';
import { SetupWizard } from './components/SetupWizard';
import { Hub } from './components/Hub';
import { Playlists } from './components/library/Playlists';
import { GlobalSearch } from './components/GlobalSearch';
import { SettingsModal } from './components/SettingsModal';
import { Settings as SettingsIcon } from 'lucide-react';
import { TrackContextMenu } from './components/library/TrackContextMenu';
const App = () => {
    const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
    const [dbConnected, setDbConnected] = React.useState(null);
    const library = usePlayerStore(state => state.library);
    const currentView = usePlayerStore(state => state.currentView);
    const needsSetup = usePlayerStore(state => state.needsSetup);
    const checkSetupStatus = usePlayerStore(state => state.checkSetupStatus);
    const libraryFolders = usePlayerStore(state => state.libraryFolders);
    const rescanLibrary = usePlayerStore(state => state.rescanLibrary);
    const isScanningGlobal = usePlayerStore(state => state.isScanning);
    const scanningFileGlobal = usePlayerStore(state => state.scanningFile);
    // Trigger an initial library fetch, apply theme, and subscribe to scan events
    React.useEffect(() => {
        usePlayerStore.getState().setTheme(usePlayerStore.getState().theme);
        // Check DB health first, then load normally
        const checkHealth = async () => {
            try {
                const res = await fetch('/api/health');
                const data = await res.json();
                setDbConnected(data.dbConnected === true);
                return data.dbConnected === true;
            }
            catch {
                setDbConnected(false);
                return false;
            }
        };
        checkHealth().then((ok) => {
            if (!ok) {
                // Poll every 5 seconds until DB comes back
                const interval = setInterval(async () => {
                    const ok = await checkHealth();
                    if (ok) {
                        clearInterval(interval);
                        // Now do the normal startup
                        checkSetupStatus().then(() => {
                            const { needsSetup } = usePlayerStore.getState();
                            if (!needsSetup) {
                                usePlayerStore.getState().loadSettings();
                                usePlayerStore.getState().fetchLibraryFromServer();
                            }
                        });
                    }
                }, 5000);
                return;
            }
            // Check if we need to show the First Time Setup Wizard
            checkSetupStatus().then(() => {
                const { needsSetup } = usePlayerStore.getState();
                if (!needsSetup) {
                    usePlayerStore.getState().loadSettings();
                    usePlayerStore.getState().fetchLibraryFromServer();
                }
            });
        });
        // Listen to real-time scanning progress from backend
        const eventSource = new EventSource('/api/library/scan/status');
        eventSource.onmessage = (e) => {
            const data = JSON.parse(e.data);
            const wasScanning = usePlayerStore.getState().isScanning;
            // Update global UI state
            usePlayerStore.getState().setIsScanning(data.isScanning, data.phase, data.scannedFiles, data.totalFiles, data.activeWorkers, data.activeFiles, data.currentFile);
            // If a scan just finished, refresh the library automatically
            if (wasScanning && !data.isScanning) {
                usePlayerStore.getState().fetchLibraryFromServer();
            }
        };
        return () => eventSource.close();
    }, []);
    const [folderPathInput, setFolderPathInput] = React.useState('');
    const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);
    const renderView = () => {
        if (library.length === 0) {
            return (_jsxs("div", { className: "empty-state font-body flex flex-col items-center justify-center p-8 flex-1", children: [_jsx("h1", { className: "text-4xl md:text-5xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-[var(--aurora-green)] to-[var(--aurora-purple)] mb-4", children: "Aurora Media Server" }), _jsx("p", { className: "text-lg text-[var(--color-text-secondary)] mb-8 max-w-md text-center", children: "Provide the absolute path to your local music directory to let the host scan and stream it." }), _jsxs("div", { className: "flex flex-col md:flex-row gap-4 w-full max-w-lg", children: [_jsx("input", { type: "text", placeholder: "/home/andreas/Music", value: folderPathInput, onChange: (e) => setFolderPathInput(e.target.value), className: "flex-1 px-4 py-3 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md text-[var(--color-text-primary)] shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent transition-all duration-300", disabled: isScanningGlobal }), _jsx("button", { onClick: async () => {
                                    if (!folderPathInput.trim())
                                        return;
                                    await usePlayerStore.getState().addLibraryFolder(folderPathInput.trim());
                                    setFolderPathInput('');
                                }, className: "btn whitespace-nowrap", disabled: isScanningGlobal || !folderPathInput.trim(), children: isScanningGlobal ? '✦ Scanning...' : '✦ Map Folder' })] })] }));
        }
        switch (currentView) {
            case 'album': return _jsx(AlbumDetail, {});
            case 'artist': return _jsx(ArtistDetail, {});
            case 'genre': return _jsx(GenreDetail, {});
            case 'home': return _jsx(Hub, {});
            case 'playlists': return _jsx(Playlists, {});
            default: return _jsx(LibraryHome, {});
        }
    };
    if (needsSetup === null) {
        // Still checking setup status...
        return _jsx("div", { className: "h-screen w-full flex items-center justify-center text-[var(--color-primary)]", children: "Loading Application..." });
    }
    if (needsSetup) {
        return _jsx(SetupWizard, { onComplete: () => checkSetupStatus().then(() => usePlayerStore.getState().fetchLibraryFromServer()) });
    }
    return (_jsxs(_Fragment, { children: [_jsx(TrackContextMenu, {}), isScanningGlobal && (_jsxs("div", { className: "global-scanning-indicator", style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '16px', gap: '8px', width: '320px' }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }, children: [_jsx("div", { className: "scanning-spinner" }), _jsxs("div", { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }, children: [_jsx("span", { style: { fontWeight: 600 }, children: "Scanning Library..." }), _jsx("span", { style: {
                                                    fontSize: '0.7rem',
                                                    padding: '2px 6px',
                                                    borderRadius: '12px',
                                                    backgroundColor: 'var(--color-primary)',
                                                    color: 'white',
                                                    textTransform: 'uppercase',
                                                    letterSpacing: '0.05em'
                                                }, children: usePlayerStore.getState().scanPhase })] }), usePlayerStore.getState().scanPhase === 'metadata' ? (_jsxs("div", { style: { fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginTop: '2px', display: 'flex', justifyContent: 'space-between' }, children: [_jsxs("span", { children: [usePlayerStore.getState().scannedFiles, " / ", usePlayerStore.getState().totalFiles, " files"] }), _jsxs("span", { children: [usePlayerStore.getState().activeWorkers, " workers"] })] })) : (_jsx("div", { style: {
                                            fontSize: '0.8rem',
                                            color: 'var(--color-text-secondary)',
                                            marginTop: '2px',
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            width: '100%'
                                        }, children: scanningFileGlobal || 'Discovering files...' }))] })] }), usePlayerStore.getState().scanPhase === 'metadata' && usePlayerStore.getState().activeFiles.length > 0 && (_jsxs("div", { style: {
                            width: '100%',
                            marginTop: '8px',
                            paddingTop: '8px',
                            borderTop: '1px solid var(--glass-border)',
                            fontSize: '0.75rem',
                            color: 'var(--color-text-secondary)',
                            maxHeight: '120px',
                            overflowY: 'auto'
                        }, children: [_jsx("div", { style: { marginBottom: '4px', fontWeight: 600, color: 'var(--color-text-primary)' }, children: "Currently Processing:" }), _jsxs("ul", { style: { listStyleType: 'disc', paddingLeft: '16px', margin: 0, display: 'flex', flexDirection: 'column', gap: '2px' }, children: [usePlayerStore.getState().activeFiles.slice(0, 10).map((file, i) => (_jsx("li", { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: file }, i))), usePlayerStore.getState().activeFiles.length > 10 && (_jsxs("li", { style: { fontStyle: 'italic', listStyleType: 'none', marginLeft: '-16px' }, children: ["...and ", usePlayerStore.getState().activeFiles.length - 10, " more"] }))] })] }))] })), _jsxs("div", { className: "flex h-screen relative z-10 overflow-hidden text-[var(--color-text-primary)]", children: [dbConnected === false && (_jsx("div", { className: "fixed inset-0 z-[999] flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-text-primary)]", children: _jsxs("div", { className: "max-w-lg w-full mx-4 p-8 rounded-3xl border border-red-500/30 bg-red-500/5 backdrop-blur-2xl shadow-2xl text-center space-y-6", children: [_jsx("div", { className: "text-5xl", children: "\uD83D\uDDC4\uFE0F" }), _jsx("h1", { className: "text-2xl font-bold text-red-400", children: "Database Unavailable" }), _jsxs("p", { className: "text-[var(--color-text-secondary)] text-sm", children: ["Aurora cannot connect to PostgreSQL on ", _jsx("code", { className: "bg-black/20 px-1.5 py-0.5 rounded text-red-300 text-xs", children: "localhost:5432" }), ". The server is running, but waiting for the database to come online."] }), _jsxs("div", { className: "text-left bg-black/20 rounded-2xl p-5 space-y-3 text-sm", children: [_jsx("p", { className: "font-semibold text-[var(--color-text-primary)] mb-2", children: "Troubleshooting" }), _jsxs("div", { className: "space-y-2 text-[var(--color-text-secondary)]", children: [_jsxs("p", { children: ["\u2460 Start your PostgreSQL / Podman container:", _jsx("br", {}), _jsx("code", { className: "text-xs text-amber-300 mt-1 block", children: "podman start musicdb" })] }), _jsxs("p", { children: ["\u2461 Verify the DB is listening:", _jsx("br", {}), _jsx("code", { className: "text-xs text-amber-300 mt-1 block", children: "psql -U postgres -h localhost" })] }), _jsxs("p", { children: ["\u2462 Check your ", _jsx("code", { className: "text-xs text-amber-300", children: ".env" }), " for the correct ", _jsx("code", { className: "text-xs text-amber-300", children: "DATABASE_URL" }), "."] })] })] }), _jsxs("div", { className: "flex items-center justify-center gap-2 text-xs text-[var(--color-text-muted)]", children: [_jsx("div", { className: "w-2 h-2 rounded-full bg-red-400 animate-pulse" }), "Retrying every 5 seconds\u2026"] })] }) })), _jsxs("main", { className: "flex-1 flex flex-col min-w-0 relative", children: [_jsxs("div", { className: "md:hidden p-4 flex items-center justify-between border-b border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md", children: [_jsx("h1", { className: "font-bold text-lg text-[var(--color-primary)] tracking-wide", children: "AURORA" }), _jsx("button", { className: "p-2 text-[var(--color-text-primary)] focus:outline-none", onClick: () => setIsSidebarOpen(true), children: _jsxs("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("line", { x1: "3", y1: "12", x2: "21", y2: "12" }), _jsx("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), _jsx("line", { x1: "3", y1: "18", x2: "21", y2: "18" })] }) })] }), _jsxs("div", { className: "flex-none p-4 pb-0 flex gap-3 overflow-x-auto hide-scrollbar z-20 w-full pt-6 px-4 md:px-8 lg:px-12", children: [['home', 'playlists', 'artists', 'albums', 'genres'].map(tab => {
                                        const isActive = currentView === tab;
                                        const label = tab === 'home' ? 'Hub' : tab.charAt(0).toUpperCase() + tab.slice(1);
                                        return (_jsx("button", { onClick: () => usePlayerStore.getState().navigateView(tab), className: `
                            capitalize font-semibold text-sm px-5 py-2 rounded-full
                            border backdrop-blur-md whitespace-nowrap
                            transition-all duration-200 cursor-pointer
                            active:scale-95
                            ${isActive
                                                ? 'text-white border-purple-500/50 shadow-[0_0_18px_rgba(139,92,246,0.4)] hover:shadow-[0_0_24px_rgba(139,92,246,0.55)] hover:brightness-110'
                                                : 'text-[var(--color-text-secondary)] border-[var(--color-border)] bg-black/5 dark:bg-white/[0.06] hover:bg-black/10 dark:hover:bg-white/[0.12] hover:text-[var(--color-text-primary)] hover:border-[var(--glass-border-hover)]'}
                        `, style: isActive ? {
                                                background: 'linear-gradient(145deg, rgba(139, 92, 246, 0.85), rgba(109, 40, 217, 0.9))',
                                                border: '1px solid rgba(168, 85, 247, 0.5)',
                                                boxShadow: '0 0 18px rgba(139, 92, 246, 0.4), inset 0 1px 0 rgba(255,255,255,0.15)',
                                            } : {}, children: label }, tab));
                                    }), _jsxs("div", { className: "flex items-center gap-2 ml-auto", children: [_jsx(GlobalSearch, {}), _jsx("button", { onClick: () => setIsSettingsOpen(true), className: "p-2 rounded-full text-[var(--color-text-secondary)] bg-black/5 dark:bg-white/[0.06] hover:text-[var(--color-text-primary)] hover:bg-black/10 dark:hover:bg-white/[0.12] transition-all duration-300 border border-[var(--color-border)] hover:border-[var(--glass-border-hover)] flex-shrink-0", title: "Settings", children: _jsx(SettingsIcon, { className: "w-5 h-5" }) })] })] }), _jsx("div", { className: "flex-1 flex overflow-hidden", children: _jsx("div", { className: "flex-1 overflow-y-auto pb-48", children: renderView() }) }), _jsxs("div", { className: "absolute bottom-6 left-1/2 -translate-x-1/2 w-11/12 max-w-4xl z-40 bg-[var(--glass-bg)] backdrop-blur-2xl border border-[var(--glass-border)] rounded-[2rem] p-4 pb-5 shadow-2xl", children: [_jsx(ProgressBar, {}), _jsx("div", { className: "mt-2", children: _jsx(PlayerControls, {}) })] }), _jsx(KeyboardHint, {})] }), isSettingsOpen && (_jsx(SettingsModal, { onClose: () => setIsSettingsOpen(false) })), isSidebarOpen && (_jsx("div", { className: "fixed inset-0 bg-black/50 backdrop-blur-sm z-40 md:hidden transition-opacity", onClick: () => setIsSidebarOpen(false) })), _jsx("div", { className: `fixed inset-y-0 right-0 z-50 w-72 transform transition-transform duration-300 ease-in-out md:relative md:translate-x-0 border-l border-[var(--glass-border)] ${isSidebarOpen ? 'translate-x-0' : 'translate-x-full'}`, children: _jsx(PlaylistSidebar, {}) })] })] }));
};
export default App;
