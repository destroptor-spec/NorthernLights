import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/index';
import { useLlmConnectionTest } from '../hooks/useLlmConnectionTest';

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
    
    const [isClosing, setIsClosing] = useState(false);
    const [activeTab, setActiveTab] = useState<'General' | 'Playback' | 'System' | 'Providers'>('General');
    const [isRunningMatrix, setIsRunningMatrix] = useState(false);
    const [mappings, setMappings] = useState<Record<string, string>>({});

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
        const confirm = window.confirm('This will clear ALL existing genre mappings and re-categorize your entire library into the new 39-genre ontology. Proceed?');
        if (!confirm) return;

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
        const path = prompt("Enter the absolute path to your music folder (e.g., /home/andreas/Music):");
        if (path && path.trim() !== '') {
            const addLibraryFolder = usePlayerStore.getState().addLibraryFolder;
            await addLibraryFolder(path.trim());
        }
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
        const confirm = window.confirm('Reset Hub? This will delete ALL existing LLM-generated playlists and regenerate fresh ones. User-created playlists will not be affected.');
        if (!confirm) return;

        try {
            const authHeaders = getAuthHeader();
            await fetch('/api/hub/regenerate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ force: true })
            });
            alert('Hub reset triggered. Playlists are being regenerated in the background.');
        } catch(e) {
            console.error(e);
            alert('Failed to request reset');
        }
    };

    const tabs = ['General', 'Playback', 'System', 'Providers'] as const;

    return createPortal(
        <div className={`drawer-backdrop ${isClosing ? 'closing' : ''}`} onClick={handleClose}>
            <div className={`drawer-content ${isClosing ? 'closing' : ''}`} onClick={e => e.stopPropagation()}>
                <div className="modal-header border-b border-[var(--glass-border)] pb-4 mb-4">
                    <h2 className="font-bold text-2xl tracking-wide text-[var(--color-text-primary)]">Settings</h2>
                    <button className="close-btn text-2xl hover:text-[var(--color-primary)] transition-colors" onClick={handleClose}>✕</button>
                </div>

                {/* Tabs Header */}
                <div className="flex gap-2 border-b border-[var(--glass-border)] pb-2 mb-6 overflow-x-auto">
                    {tabs.map(tab => (
                        <button 
                            key={tab}
                            className={`px-4 py-2 font-semibold text-sm rounded-t-lg transition-colors whitespace-nowrap ${activeTab === tab ? 'text-[var(--color-primary)] border-b-2 border-[var(--color-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}`}
                            onClick={() => setActiveTab(tab)}
                        >
                            {tab}
                        </button>
                    ))}
                </div>

                <div className="modal-body overflow-y-auto">
                    {activeTab === 'General' && (
                        <>
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
                                    <button className="btn btn-small" onClick={handleAddFolder} title="Map a folder path on the server">
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
                                                <span className="text-sm truncate mr-4 text-[var(--color-text-primary)] font-medium">📁 {folderPath}</span>
                                                <div className="flex gap-2 shrink-0">
                                                    <button className="font-semibold text-xs bg-[var(--color-primary)] text-white px-3 py-1.5 rounded-full hover:bg-[var(--color-primary-dark)] transition-colors shadow-sm" onClick={() => handleRescanFolder(folderPath)}>Rescan</button>
                                                    <button className="font-semibold text-xs bg-[var(--color-error)] text-white px-3 py-1.5 rounded-full hover:bg-red-600 transition-colors shadow-sm" onClick={() => removeLibraryFolder(folderPath)}>Remove</button>
                                                </div>
                                            </li>
                                        ))
                                    )}
                                </ul>
                            </div>
                        </>
                    )}

                    {activeTab === 'Playback' && (
                        <>
                            <div className="settings-section mb-8">
                                <div className="settings-section-header mb-4">
                                    <h3 className="font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase">Infinity Mode Algorithm</h3>
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
                                    <p className="text-xs text-[var(--color-text-muted)] mt-1">Controls how far the engine drifts from the mathematically perfect next track to introduce serendipity.</p>
                                </div>

                                <div className="mb-6">
                                    <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                        <span>Genre Strictness</span>
                                        <span>{genreStrictness}%</span>
                                    </label>
                                    <input type="range" min="0" max="100" value={genreStrictness} onChange={e => setSettings({ genreStrictness: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                    <p className="text-xs text-[var(--color-text-muted)] mt-1">Higher strictness penalizes jumping between culturally unrelated genres.</p>
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
                                    <p className="text-xs text-[var(--color-text-muted)] mt-1">Number of recent tracks strictly banned from repeating.</p>
                                </div>

                                <div className="pt-6 border-t border-[var(--glass-border)]">
                                    <div className="flex flex-col mb-4">
                                        <div>
                                            <h4 className="font-semibold text-sm text-[var(--color-text-primary)]">Genre Transition Matrix</h4>
                                            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Maps hop costs between genres, powering Infinity Mode and Hub generation.</p>
                                        </div>
                                        <div className="flex items-center gap-2 mt-3">
                                            <button
                                                onClick={handleRunMatrix}
                                                disabled={isRunningMatrix}
                                                className="shrink-0 font-semibold text-xs px-4 py-2 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-lg hover:bg-[var(--glass-bg-hover)] transition-colors text-[var(--color-text-primary)] disabled:opacity-50 shadow-sm inline-flex items-center gap-2"
                                            >
                                                {isRunningMatrix && <div className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />}
                                                {isRunningMatrix ? (genreMatrixProgress?.replace('Categorizing ', '') || 'Running...') : 'Run Now'}
                                            </button>
                                            <button
                                                onClick={handleRemapAll}
                                                disabled={isRunningMatrix}
                                                title="Destructive: Clears all mappings and starts fresh for the 39-genre ontology"
                                                className="shrink-0 font-semibold text-xs px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg hover:bg-red-500/20 transition-colors text-red-400 disabled:opacity-50 shadow-sm"
                                            >
                                                Remap Library
                                            </button>
                                        </div>
                                        <div className="grid grid-cols-2 gap-4 mt-4 px-1">
                                            <p className="text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                                                <strong className="text-[var(--color-text-secondary)] uppercase tracking-wider block mb-0.5">Incremental</strong>
                                                Scans only new sub-genres added since last run. Safe and fast.
                                            </p>
                                            <p className="text-[10px] leading-relaxed text-[var(--color-text-muted)] border-l border-[var(--glass-border)] pl-3">
                                                <strong className="text-red-400/80 uppercase tracking-wider block mb-0.5">Full Remap</strong>
                                                Clears all mappings. Forces LLM to re-examine every track for the 39-genre ontology.
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-2 text-sm p-3 rounded-xl bg-black/5 dark:bg-white/[0.04] border border-[var(--glass-border)]">
                                        <div className="flex justify-between items-center border-b border-[var(--glass-border)] pb-2">
                                            <span className="text-[var(--color-text-secondary)]">Last Run</span>
                                            <span className="text-[var(--color-text-primary)] font-medium">
                                                {genreMatrixLastRun ? new Date(genreMatrixLastRun).toLocaleString() : 'Never'}
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-center border-b border-[var(--glass-border)] pb-2 pt-1">
                                            <span className="text-[var(--color-text-secondary)]">Last Result</span>
                                            <span className="text-[var(--color-text-primary)] font-medium max-w-[200px] text-right truncate" title={genreMatrixLastResult || 'N/A'}>
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
                            </div>
                        </>
                    )}

                    {activeTab === 'System' && (
                        <>
                            <div className="settings-section mb-8">
                                <div className="settings-section-header mb-4">
                                    <h3 className="font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase">System & Processing</h3>
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
                            </div>
                        </>
                    )}

                    {activeTab === 'Providers' && (
                        <>
                            <div className="settings-section mb-8">
                                <div className="settings-section-header mb-4">
                                    <h3 className="font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase">LLM / Engine Configurations</h3>
                                </div>
                                <p className="text-sm text-[var(--color-text-muted)] mb-4">
                                    Bring your own LLM to generate Hub playlists securely on your own hardware using LM Studio, Ollama, or OpenAI.
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
                                            <ul className="absolute left-0 right-0 z-50 w-full mt-2 max-h-48 overflow-y-auto bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.12)] backdrop-blur-xl hide-scrollbar py-1">
                                                {availableModels.map(m => (
                                                    <li 
                                                        key={m} 
                                                        className="px-4 py-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)] cursor-pointer transition-colors border-b border-[var(--glass-border)] last:border-0"
                                                        onMouseDown={(e) => {
                                                            e.preventDefault(); // Prevent blur before click registers
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
                                            className="font-semibold text-sm px-4 py-2 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-lg hover:bg-[var(--glass-bg-hover)] transition-colors text-[var(--color-text-primary)] disabled:opacity-50 shadow-sm"
                                        >
                                            {connectionStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                                        </button>
                                        {connectionStatus === 'success' && (
                                            <span className="text-green-500 font-semibold text-sm drop-shadow-sm">✓ {connectionMessage}</span>
                                        )}
                                        {connectionStatus === 'error' && (
                                            <span className="text-red-500 font-semibold text-sm drop-shadow-sm truncate max-w-xs" title={connectionMessage}>✗ {connectionMessage}</span>
                                        )}
                                    </div>
                                </div>

                                <div className="settings-section-header mb-4">
                                    <h3 className="font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase">Metadata Providers</h3>
                                </div>
                                <div className="flex flex-col gap-4">
                                    <div>
                                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Last.fm API Key</label>
                                        <input type="text" value={lastFmApiKey} onChange={e => setLastFmApiKey(e.target.value)} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Genius Access Token</label>
                                        <input type="text" value={geniusApiKey} onChange={e => setGeniusApiKey(e.target.value)} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
};

