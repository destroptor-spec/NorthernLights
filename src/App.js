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
const App = () => {
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
        // Check if we need to show the First Time Setup Wizard
        checkSetupStatus().then(() => {
            const { needsSetup } = usePlayerStore.getState();
            if (!needsSetup) {
                usePlayerStore.getState().fetchLibraryFromServer();
            }
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
            case 'home':
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
    return (_jsxs(_Fragment, { children: [isScanningGlobal && (_jsxs("div", { className: "global-scanning-indicator", style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '16px', gap: '8px', width: '320px' }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }, children: [_jsx("div", { className: "scanning-spinner" }), _jsxs("div", { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }, children: [_jsx("span", { style: { fontWeight: 600 }, children: "Scanning Library..." }), _jsx("span", { style: {
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
                        }, children: [_jsx("div", { style: { marginBottom: '4px', fontWeight: 600, color: 'var(--color-text-primary)' }, children: "Currently Processing:" }), _jsxs("ul", { style: { listStyleType: 'disc', paddingLeft: '16px', margin: 0, display: 'flex', flexDirection: 'column', gap: '2px' }, children: [usePlayerStore.getState().activeFiles.slice(0, 10).map((file, i) => (_jsx("li", { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: file }, i))), usePlayerStore.getState().activeFiles.length > 10 && (_jsxs("li", { style: { fontStyle: 'italic', listStyleType: 'none', marginLeft: '-16px' }, children: ["...and ", usePlayerStore.getState().activeFiles.length - 10, " more"] }))] })] }))] })), _jsxs("div", { className: "flex h-screen relative z-10 overflow-hidden text-[var(--color-text-primary)]", children: [isSidebarOpen && (_jsx("div", { className: "fixed inset-0 bg-black/50 backdrop-blur-sm z-40 md:hidden transition-opacity", onClick: () => setIsSidebarOpen(false) })), _jsx("div", { className: `fixed inset-y-0 left-0 z-50 w-72 transform transition-transform duration-300 ease-in-out md:relative md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`, children: _jsx(PlaylistSidebar, {}) }), _jsxs("main", { className: "flex-1 flex flex-col min-w-0 relative", children: [_jsxs("div", { className: "md:hidden p-4 flex items-center justify-between border-b border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md", children: [_jsx("h1", { className: "font-bold text-lg text-[var(--color-primary)] tracking-wide", children: "AURORA" }), _jsx("button", { className: "p-2 text-[var(--color-text-primary)] focus:outline-none", onClick: () => setIsSidebarOpen(true), children: _jsxs("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("line", { x1: "3", y1: "12", x2: "21", y2: "12" }), _jsx("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), _jsx("line", { x1: "3", y1: "18", x2: "21", y2: "18" })] }) })] }), _jsx("div", { className: "flex-1 flex overflow-hidden", children: renderView() }), _jsxs("div", { className: "playback-controls-footer", children: [_jsx(ProgressBar, {}), _jsx("div", { className: "mt-2", children: _jsx(PlayerControls, {}) })] }), _jsx(KeyboardHint, {})] })] })] }));
};
export default App;
