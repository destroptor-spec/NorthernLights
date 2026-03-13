import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/index';
export const SettingsModal = ({ onClose }) => {
    const libraryFolders = usePlayerStore(state => state.libraryFolders);
    const addLibraryFolder = usePlayerStore(state => state.addLibraryFolder);
    const removeLibraryFolder = usePlayerStore(state => state.removeLibraryFolder);
    const addTracksToLibrary = usePlayerStore(state => state.addTracksToLibrary);
    const theme = usePlayerStore(state => state.theme);
    const setTheme = usePlayerStore(state => state.setTheme);
    const lastFmApiKey = usePlayerStore(state => state.lastFmApiKey);
    const setLastFmApiKey = usePlayerStore(state => state.setLastFmApiKey);
    const geniusApiKey = usePlayerStore(state => state.geniusApiKey);
    const setGeniusApiKey = usePlayerStore(state => state.setGeniusApiKey);
    const preferredProvider = usePlayerStore(state => state.preferredProvider);
    const setPreferredProvider = usePlayerStore(state => state.setPreferredProvider);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);
    const setIsScanning = usePlayerStore(state => state.setIsScanning);
    const [isClosing, setIsClosing] = React.useState(false);
    const handleClose = () => {
        setIsClosing(true);
        // Wait slightly less than the 300ms animation to trigger unmount
        setTimeout(() => onClose(), 280);
    };
    const handleAddFolder = async () => {
        const path = prompt("Enter the absolute path to your music folder (e.g., /home/andreas/Music):");
        if (path && path.trim() !== '') {
            await addLibraryFolder(path.trim());
        }
    };
    const handleRescanFolder = async (folderPath) => {
        try {
            setIsScanning(true, 'walk', 0, 0, 0, [], `Initializing scan for ${folderPath.split(/[\\/]/).pop()}...`);
            const authHeaders = getAuthHeader();
            await fetch('/api/library/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ path: folderPath })
            });
            await fetchLibraryFromServer();
        }
        catch (e) {
            console.error('Failed to rescan folder', e);
        }
        finally {
            setIsScanning(false);
        }
    };
    return createPortal(_jsx("div", { className: `drawer-backdrop ${isClosing ? 'closing' : ''}`, onClick: handleClose, children: _jsxs("div", { className: `drawer-content ${isClosing ? 'closing' : ''}`, onClick: e => e.stopPropagation(), children: [_jsxs("div", { className: "modal-header border-b border-[var(--glass-border)] pb-4 mb-4", children: [_jsx("h2", { className: "font-bold text-2xl tracking-wide text-[var(--color-text-primary)]", children: "Settings" }), _jsx("button", { className: "close-btn text-2xl hover:text-[var(--color-primary)] transition-colors", onClick: handleClose, children: "\u2715" })] }), _jsxs("div", { className: "modal-body overflow-y-auto", children: [_jsxs("div", { className: "settings-section mb-8", children: [_jsx("div", { className: "settings-section-header mb-4", children: _jsx("h3", { className: "font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase", children: "Appearance" }) }), _jsxs("div", { className: "flex gap-4 mb-4", children: [_jsx("button", { className: `flex-1 py-4 rounded-xl border font-semibold tracking-wide transition-all duration-300 ${theme === 'light' ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white shadow-lg scale-100' : 'border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)]'}`, onClick: () => setTheme('light'), children: "\u2600\uFE0F Light" }), _jsx("button", { className: `flex-1 py-4 rounded-xl border font-semibold tracking-wide transition-all duration-300 ${theme === 'dark' ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white shadow-lg scale-100 dark:bg-[var(--aurora-purple)] dark:border-[var(--aurora-purple)]' : 'border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)]'}`, onClick: () => setTheme('dark'), children: "\uD83C\uDF19 Dark" })] })] }), _jsxs("div", { className: "settings-section mb-8", children: [_jsxs("div", { className: "settings-section-header flex justify-between items-center mb-4", children: [_jsx("h3", { className: "font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase", children: "Mapped Folders" }), _jsx("div", { style: { display: 'flex', gap: '8px' }, children: _jsx("button", { className: "btn btn-small", onClick: handleAddFolder, title: "Map a folder path on the server", children: "\uFF0B Map Folder Path" }) })] }), _jsx("p", { className: "text-sm text-[var(--color-text-muted)] mb-4", children: "Folders mapped here will be automatically scanned for music every time you open the app." }), _jsx("ul", { className: "flex flex-col gap-2", children: libraryFolders.length === 0 ? (_jsx("li", { className: "p-4 rounded-xl border border-dashed border-[var(--glass-border)] bg-[var(--glass-bg)] text-center text-sm text-[var(--color-text-muted)] backdrop-blur-sm", children: "No folders mapped yet." })) : (libraryFolders.map((folderPath) => (_jsxs("li", { className: "flex justify-between items-center p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-sm backdrop-blur-sm", children: [_jsxs("span", { className: "text-sm truncate mr-4 text-[var(--color-text-primary)] font-medium", children: ["\uD83D\uDCC1 ", folderPath] }), _jsxs("div", { className: "flex gap-2 shrink-0", children: [_jsx("button", { className: "font-semibold text-xs bg-[var(--color-primary)] text-white px-3 py-1.5 rounded-full hover:bg-[var(--color-primary-dark)] transition-colors shadow-sm", onClick: () => handleRescanFolder(folderPath), title: "Rescan folder for new music", children: "Rescan" }), _jsx("button", { className: "font-semibold text-xs bg-[var(--color-error)] text-white px-3 py-1.5 rounded-full hover:bg-red-600 transition-colors shadow-sm", onClick: () => removeLibraryFolder(folderPath), title: "Remove folder from library", children: "Remove" })] })] }, folderPath)))) })] }), _jsxs("div", { className: "settings-section mb-8", children: [_jsx("div", { className: "settings-section-header mb-4", children: _jsx("h3", { className: "font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase", children: "External Providers" }) }), _jsx("p", { className: "text-sm text-[var(--color-text-muted)] mb-4", children: "Configure API keys to automatically fetch artist metadata, imagery, and album covers." }), _jsxs("div", { className: "flex flex-col gap-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-primary)] mb-1", children: "Last.fm API Key" }), _jsx("input", { type: "text", value: lastFmApiKey, onChange: (e) => setLastFmApiKey(e.target.value), placeholder: "Enter Last.fm API Key", className: "w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-primary)] mb-1", children: "Genius Access Token" }), _jsx("input", { type: "text", value: geniusApiKey, onChange: (e) => setGeniusApiKey(e.target.value), placeholder: "Enter Genius Access Token", className: "w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-primary)] mb-1", children: "Preferred Provider" }), _jsx("p", { className: "text-xs text-[var(--color-text-muted)] mb-2", children: "If both keys are provided, which API should be preferred for artist imagery and bios?" }), _jsxs("div", { className: "flex gap-4", children: [_jsxs("label", { className: "flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer", children: [_jsx("input", { type: "radio", name: "preferredProvider", value: "lastfm", checked: preferredProvider === 'lastfm', onChange: () => setPreferredProvider('lastfm'), className: "accent-[var(--color-primary)]" }), "Last.fm"] }), _jsxs("label", { className: "flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer", children: [_jsx("input", { type: "radio", name: "preferredProvider", value: "genius", checked: preferredProvider === 'genius', onChange: () => setPreferredProvider('genius'), className: "accent-[var(--color-primary)]" }), "Genius"] })] })] })] })] })] })] }) }), document.body);
};
