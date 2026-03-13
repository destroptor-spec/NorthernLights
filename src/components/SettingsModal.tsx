import React from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/index';
import { importFolderFallback, extractMetadata, TrackInfo } from '../utils/fileSystem';

interface SettingsModalProps {
    onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
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

    const handleRescanFolder = async (folderPath: string) => {
        try {
            setIsScanning(true, 'walk', 0, 0, 0, [], `Initializing scan for ${folderPath.split(/[\\/]/).pop()}...`);
            const authHeaders = getAuthHeader();
            await fetch('/api/library/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ path: folderPath })
            });
            await fetchLibraryFromServer();
        } catch (e) {
            console.error('Failed to rescan folder', e);
        } finally {
            setIsScanning(false);
        }
    };

    return createPortal(
        <div className={`drawer-backdrop ${isClosing ? 'closing' : ''}`} onClick={handleClose}>
            <div className={`drawer-content ${isClosing ? 'closing' : ''}`} onClick={e => e.stopPropagation()}>
                <div className="modal-header border-b border-[var(--glass-border)] pb-4 mb-4">
                    <h2 className="font-bold text-2xl tracking-wide text-[var(--color-text-primary)]">Settings</h2>
                    <button className="close-btn text-2xl hover:text-[var(--color-primary)] transition-colors" onClick={handleClose}>✕</button>
                </div>

                <div className="modal-body overflow-y-auto">
                    <div className="settings-section mb-8">
                        <div className="settings-section-header mb-4">
                            <h3 className="font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase">Appearance</h3>
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

                    <div className="settings-section mb-8">
                        <div className="settings-section-header flex justify-between items-center mb-4">
                            <h3 className="font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase">Mapped Folders</h3>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <button className="btn btn-small" onClick={handleAddFolder} title="Map a folder path on the server">
                                    ＋ Map Folder Path
                                </button>
                            </div>
                        </div>

                        <p className="text-sm text-[var(--color-text-muted)] mb-4">
                            Folders mapped here will be automatically scanned for music every time you open the app.
                        </p>

                        <ul className="flex flex-col gap-2">
                            {libraryFolders.length === 0 ? (
                                <li className="p-4 rounded-xl border border-dashed border-[var(--glass-border)] bg-[var(--glass-bg)] text-center text-sm text-[var(--color-text-muted)] backdrop-blur-sm">
                                    No folders mapped yet.
                                </li>
                            ) : (
                                libraryFolders.map((folderPath) => (
                                    <li key={folderPath} className="flex justify-between items-center p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-sm backdrop-blur-sm">
                                        <span className="text-sm truncate mr-4 text-[var(--color-text-primary)] font-medium">📁 {folderPath}</span>
                                        <div className="flex gap-2 shrink-0">
                                            <button
                                                className="font-semibold text-xs bg-[var(--color-primary)] text-white px-3 py-1.5 rounded-full hover:bg-[var(--color-primary-dark)] transition-colors shadow-sm"
                                                onClick={() => handleRescanFolder(folderPath)}
                                                title="Rescan folder for new music"
                                            >
                                                Rescan
                                            </button>
                                            <button
                                                className="font-semibold text-xs bg-[var(--color-error)] text-white px-3 py-1.5 rounded-full hover:bg-red-600 transition-colors shadow-sm"
                                                onClick={() => removeLibraryFolder(folderPath)}
                                                title="Remove folder from library"
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    </li>
                                ))
                            )}
                        </ul>
                    </div>

                    <div className="settings-section mb-8">
                        <div className="settings-section-header mb-4">
                            <h3 className="font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase">External Providers</h3>
                        </div>
                        <p className="text-sm text-[var(--color-text-muted)] mb-4">
                            Configure API keys to automatically fetch artist metadata, imagery, and album covers.
                        </p>
                        <div className="flex flex-col gap-4">
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Last.fm API Key</label>
                                <input 
                                    type="text" 
                                    value={lastFmApiKey} 
                                    onChange={(e) => setLastFmApiKey(e.target.value)}
                                    placeholder="Enter Last.fm API Key"
                                    className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Genius Access Token</label>
                                <input 
                                    type="text" 
                                    value={geniusApiKey} 
                                    onChange={(e) => setGeniusApiKey(e.target.value)}
                                    placeholder="Enter Genius Access Token"
                                    className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Preferred Provider</label>
                                <p className="text-xs text-[var(--color-text-muted)] mb-2">If both keys are provided, which API should be preferred for artist imagery and bios?</p>
                                <div className="flex gap-4">
                                    <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
                                        <input 
                                            type="radio" 
                                            name="preferredProvider" 
                                            value="lastfm" 
                                            checked={preferredProvider === 'lastfm'} 
                                            onChange={() => setPreferredProvider('lastfm')}
                                            className="accent-[var(--color-primary)]"
                                        />
                                        Last.fm
                                    </label>
                                    <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
                                        <input 
                                            type="radio" 
                                            name="preferredProvider" 
                                            value="genius" 
                                            checked={preferredProvider === 'genius'} 
                                            onChange={() => setPreferredProvider('genius')}
                                            className="accent-[var(--color-primary)]"
                                        />
                                        Genius
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
};
