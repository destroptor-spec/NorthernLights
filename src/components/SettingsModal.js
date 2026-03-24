import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/index';
export const SettingsModal = ({ onClose }) => {
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
    const setSettings = usePlayerStore(state => state.setSettings);
    const saveSettings = usePlayerStore(state => state.saveSettings);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);
    const setIsScanning = usePlayerStore(state => state.setIsScanning);
    const [isClosing, setIsClosing] = useState(false);
    const [activeTab, setActiveTab] = useState('General');
    const [connectionStatus, setConnectionStatus] = useState('idle');
    const [connectionMessage, setConnectionMessage] = useState('');
    const [availableModels, setAvailableModels] = useState([]);
    const [showModelDropdown, setShowModelDropdown] = useState(false);
    const [isRunningMatrix, setIsRunningMatrix] = useState(false);
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
        }
        catch (e) {
            console.error('Failed to run genre matrix', e);
        }
        finally {
            setIsRunningMatrix(false);
        }
    };
    const testLlmConnection = async () => {
        setConnectionStatus('testing');
        setConnectionMessage('');
        setAvailableModels([]);
        try {
            const authHeaders = getAuthHeader();
            const res = await fetch('/api/health/llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ llmBaseUrl, llmApiKey })
            });
            const data = await res.json();
            if (res.ok && data.status === 'ok') {
                setConnectionStatus('success');
                setConnectionMessage('Connection OK');
                if (data.models && data.models.length > 0) {
                    setAvailableModels(data.models);
                    if (!llmModelName) {
                        setSettings({ llmModelName: data.models[0] });
                    }
                }
            }
            else {
                setConnectionStatus('error');
                setConnectionMessage(data.error || 'Connection failed');
            }
        }
        catch (err) {
            setConnectionStatus('error');
            setConnectionMessage(err.message || 'Network error');
        }
    };
    const handleClose = async () => {
        setIsClosing(true);
        await saveSettings();
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
    };
    const handleManualHubRegen = async () => {
        try {
            const authHeaders = getAuthHeader();
            await fetch('/api/hub/regenerate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ force: true })
            });
            alert('Hub regeneration requested. It runs in the background.');
        }
        catch (e) {
            console.error(e);
            alert('Failed to request generation');
        }
    };
    const tabs = ['General', 'Playback', 'System', 'Providers'];
    return createPortal(_jsx("div", { className: `drawer-backdrop ${isClosing ? 'closing' : ''}`, onClick: handleClose, children: _jsxs("div", { className: `drawer-content ${isClosing ? 'closing' : ''}`, onClick: e => e.stopPropagation(), children: [_jsxs("div", { className: "modal-header border-b border-[var(--glass-border)] pb-4 mb-4", children: [_jsx("h2", { className: "font-bold text-2xl tracking-wide text-[var(--color-text-primary)]", children: "Settings" }), _jsx("button", { className: "close-btn text-2xl hover:text-[var(--color-primary)] transition-colors", onClick: handleClose, children: "\u2715" })] }), _jsx("div", { className: "flex gap-2 border-b border-[var(--glass-border)] pb-2 mb-6 overflow-x-auto", children: tabs.map(tab => (_jsx("button", { className: `px-4 py-2 font-semibold text-sm rounded-t-lg transition-colors whitespace-nowrap ${activeTab === tab ? 'text-[var(--color-primary)] border-b-2 border-[var(--color-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}`, onClick: () => setActiveTab(tab), children: tab }, tab))) }), _jsxs("div", { className: "modal-body overflow-y-auto", children: [activeTab === 'General' && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "settings-section mb-8", children: [_jsx("div", { className: "settings-section-header mb-4", children: _jsx("h3", { className: "font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase", children: "Appearance" }) }), _jsxs("div", { className: "flex gap-4 mb-4", children: [_jsx("button", { className: `flex-1 py-4 rounded-xl border font-semibold tracking-wide transition-all duration-300 ${theme === 'light' ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white shadow-lg scale-100' : 'border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)]'}`, onClick: () => setTheme('light'), children: "\u2600\uFE0F Light" }), _jsx("button", { className: `flex-1 py-4 rounded-xl border font-semibold tracking-wide transition-all duration-300 ${theme === 'dark' ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white shadow-lg scale-100 dark:bg-[var(--aurora-purple)] dark:border-[var(--aurora-purple)]' : 'border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)]'}`, onClick: () => setTheme('dark'), children: "\uD83C\uDF19 Dark" })] })] }), _jsxs("div", { className: "settings-section mb-8", children: [_jsxs("div", { className: "settings-section-header flex justify-between items-center mb-4", children: [_jsx("h3", { className: "font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase", children: "Mapped Folders" }), _jsx("button", { className: "btn btn-small", onClick: handleAddFolder, title: "Map a folder path on the server", children: "\uFF0B Map Folder Path" })] }), _jsx("p", { className: "text-sm text-[var(--color-text-muted)] mb-4", children: "Folders mapped here will be automatically scanned." }), _jsx("ul", { className: "flex flex-col gap-2", children: libraryFolders.length === 0 ? (_jsx("li", { className: "p-4 rounded-xl border border-dashed border-[var(--glass-border)] bg-[var(--glass-bg)] text-center text-sm text-[var(--color-text-muted)] backdrop-blur-sm", children: "No folders mapped yet." })) : (libraryFolders.map((folderPath) => (_jsxs("li", { className: "flex justify-between items-center p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-sm backdrop-blur-sm", children: [_jsxs("span", { className: "text-sm truncate mr-4 text-[var(--color-text-primary)] font-medium", children: ["\uD83D\uDCC1 ", folderPath] }), _jsxs("div", { className: "flex gap-2 shrink-0", children: [_jsx("button", { className: "font-semibold text-xs bg-[var(--color-primary)] text-white px-3 py-1.5 rounded-full hover:bg-[var(--color-primary-dark)] transition-colors shadow-sm", onClick: () => handleRescanFolder(folderPath), children: "Rescan" }), _jsx("button", { className: "font-semibold text-xs bg-[var(--color-error)] text-white px-3 py-1.5 rounded-full hover:bg-red-600 transition-colors shadow-sm", onClick: () => removeLibraryFolder(folderPath), children: "Remove" })] })] }, folderPath)))) })] })] })), activeTab === 'Playback' && (_jsx(_Fragment, { children: _jsxs("div", { className: "settings-section mb-8", children: [_jsx("div", { className: "settings-section-header mb-4", children: _jsx("h3", { className: "font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase", children: "Infinity Mode Algorithm" }) }), _jsx("p", { className: "text-sm text-[var(--color-text-muted)] mb-6", children: "Tune how the engine selects the next track organically." }), _jsxs("div", { className: "mb-6", children: [_jsxs("label", { className: "flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2", children: [_jsx("span", { children: "Discovery Level (Wander Factor)" }), _jsxs("span", { children: [discoveryLevel, "%"] })] }), _jsx("input", { type: "range", min: "1", max: "100", value: discoveryLevel, onChange: e => setSettings({ discoveryLevel: Number(e.target.value) }), className: "w-full accent-[var(--color-primary)]" }), _jsx("p", { className: "text-xs text-[var(--color-text-muted)] mt-1", children: "Controls how far the engine drifts from the mathematically perfect next track to introduce serendipity." })] }), _jsxs("div", { className: "mb-6", children: [_jsxs("label", { className: "flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2", children: [_jsx("span", { children: "Genre Strictness" }), _jsxs("span", { children: [genreStrictness, "%"] })] }), _jsx("input", { type: "range", min: "0", max: "100", value: genreStrictness, onChange: e => setSettings({ genreStrictness: Number(e.target.value) }), className: "w-full accent-[var(--color-primary)]" }), _jsx("p", { className: "text-xs text-[var(--color-text-muted)] mt-1", children: "Higher strictness penalizes jumping between culturally unrelated genres." })] }), _jsxs("div", { className: "mb-6", children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-primary)] mb-2", children: "Artist Amnesia (Anti-Repeat)" }), _jsxs("select", { value: artistAmnesiaLimit, onChange: e => setSettings({ artistAmnesiaLimit: Number(e.target.value) }), className: "w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none", children: [_jsx("option", { value: 0, children: "Allow Defaults" }), _jsx("option", { value: 10, children: "Standard (10 tracks)" }), _jsx("option", { value: 50, children: "Strict (50 tracks)" })] }), _jsx("p", { className: "text-xs text-[var(--color-text-muted)] mt-1", children: "Number of recent tracks strictly banned from repeating." })] }), _jsxs("div", { className: "pt-6 border-t border-[var(--glass-border)]", children: [_jsxs("div", { className: "flex items-center justify-between mb-3", children: [_jsxs("div", { children: [_jsx("h4", { className: "font-semibold text-sm text-[var(--color-text-primary)]", children: "Genre Transition Matrix" }), _jsx("p", { className: "text-xs text-[var(--color-text-muted)] mt-0.5", children: "Maps hop costs between genres, powering Infinity Mode transitions." })] }), _jsxs("button", { onClick: handleRunMatrix, disabled: isRunningMatrix, className: "ml-4 shrink-0 font-semibold text-xs px-4 py-2 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-lg hover:bg-[var(--glass-bg-hover)] transition-colors text-[var(--color-text-primary)] disabled:opacity-50 shadow-sm inline-flex items-center gap-2", children: [isRunningMatrix && _jsx("div", { className: "w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" }), isRunningMatrix ? 'Running...' : 'Run Now'] })] }), _jsxs("div", { className: "flex flex-col gap-2 text-sm p-3 rounded-xl bg-black/5 dark:bg-white/[0.04] border border-[var(--glass-border)]", children: [_jsxs("div", { className: "flex justify-between items-center border-b border-[var(--glass-border)] pb-2", children: [_jsx("span", { className: "text-[var(--color-text-secondary)]", children: "Last Run" }), _jsx("span", { className: "text-[var(--color-text-primary)] font-medium", children: genreMatrixLastRun ? new Date(genreMatrixLastRun).toLocaleString() : 'Never' })] }), _jsxs("div", { className: "flex justify-between items-center pt-1", children: [_jsx("span", { className: "text-[var(--color-text-secondary)]", children: "Last Result" }), _jsx("span", { className: "text-[var(--color-text-primary)] font-medium max-w-[200px] text-right truncate", title: genreMatrixLastResult || 'N/A', children: genreMatrixLastResult || 'N/A' })] })] })] })] }) })), activeTab === 'System' && (_jsx(_Fragment, { children: _jsxs("div", { className: "settings-section mb-8", children: [_jsx("div", { className: "settings-section-header mb-4", children: _jsx("h3", { className: "font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase", children: "System & Processing" }) }), _jsxs("div", { className: "mb-6", children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-primary)] mb-2", children: "Audio Analysis CPU Usage" }), _jsxs("select", { value: audioAnalysisCpu, onChange: e => setSettings({ audioAnalysisCpu: e.target.value }), className: "w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none", children: [_jsx("option", { value: "Background", children: "Background (Low / Async)" }), _jsx("option", { value: "Balanced", children: "Balanced" }), _jsx("option", { value: "Maximum", children: "Maximum (Fastest Scan)" })] })] }), _jsxs("div", { className: "mb-6", children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-primary)] mb-2", children: "Hub Generation Schedule" }), _jsxs("select", { value: hubGenerationSchedule, onChange: e => setSettings({ hubGenerationSchedule: e.target.value }), className: "w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none", children: [_jsx("option", { value: "Manual Only", children: "Manual Only" }), _jsx("option", { value: "Daily", children: "Daily" }), _jsx("option", { value: "Weekly", children: "Weekly" })] }), _jsx("div", { className: "mt-4", children: _jsx("button", { onClick: handleManualHubRegen, className: "btn font-semibold text-sm bg-[var(--color-surface)] border border-[var(--glass-border)] px-4 py-2 rounded-lg hover:bg-[var(--glass-bg-hover)] text-[var(--color-text-primary)]", children: "Force Regenerate Hub Now" }) })] })] }) })), activeTab === 'Providers' && (_jsx(_Fragment, { children: _jsxs("div", { className: "settings-section mb-8", children: [_jsx("div", { className: "settings-section-header mb-4", children: _jsx("h3", { className: "font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase", children: "LLM / Engine Configurations" }) }), _jsx("p", { className: "text-sm text-[var(--color-text-muted)] mb-4", children: "Bring your own LLM to generate Hub playlists securely on your own hardware using LM Studio, Ollama, or OpenAI." }), _jsxs("div", { className: "flex flex-col gap-4 mb-8 border-b border-[var(--glass-border)] pb-8", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-primary)] mb-1", children: "API Base URL" }), _jsx("input", { type: "text", value: llmBaseUrl, onChange: (e) => setSettings({ llmBaseUrl: e.target.value }), placeholder: "https://api.openai.com/v1", className: "w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-primary)] mb-1", children: "API Key" }), _jsx("input", { type: "password", value: llmApiKey, onChange: (e) => setSettings({ llmApiKey: e.target.value }), placeholder: "Leave blank if using local unrestricted provider", className: "w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" })] }), _jsxs("div", { className: "relative", children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-primary)] mb-1", children: "Model Name" }), _jsx("input", { type: "text", value: llmModelName, onChange: (e) => setSettings({ llmModelName: e.target.value }), onFocus: () => setShowModelDropdown(true), onBlur: () => setTimeout(() => setShowModelDropdown(false), 200), placeholder: "gpt-4o / llama-3", className: "w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" }), availableModels.length > 0 && showModelDropdown && (_jsx("ul", { className: "absolute left-0 right-0 z-50 w-full mt-2 max-h-48 overflow-y-auto bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.12)] backdrop-blur-xl hide-scrollbar py-1", children: availableModels.map(m => (_jsx("li", { className: "px-4 py-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)] cursor-pointer transition-colors border-b border-[var(--glass-border)] last:border-0", onMouseDown: (e) => {
                                                                e.preventDefault(); // Prevent blur before click registers
                                                                setSettings({ llmModelName: m });
                                                                setShowModelDropdown(false);
                                                            }, children: m }, m))) }))] }), _jsxs("div", { className: "flex items-center gap-4 mt-2", children: [_jsx("button", { onClick: testLlmConnection, disabled: connectionStatus === 'testing', className: "font-semibold text-sm px-4 py-2 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-lg hover:bg-[var(--glass-bg-hover)] transition-colors text-[var(--color-text-primary)] disabled:opacity-50 shadow-sm", children: connectionStatus === 'testing' ? 'Testing...' : 'Test Connection' }), connectionStatus === 'success' && (_jsxs("span", { className: "text-green-500 font-semibold text-sm drop-shadow-sm", children: ["\u2713 ", connectionMessage] })), connectionStatus === 'error' && (_jsxs("span", { className: "text-red-500 font-semibold text-sm drop-shadow-sm truncate max-w-xs", title: connectionMessage, children: ["\u2717 ", connectionMessage] }))] })] }), _jsx("div", { className: "settings-section-header mb-4", children: _jsx("h3", { className: "font-semibold tracking-wide text-sm text-[var(--color-text-secondary)] uppercase", children: "Metadata Providers" }) }), _jsxs("div", { className: "flex flex-col gap-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-primary)] mb-1", children: "Last.fm API Key" }), _jsx("input", { type: "text", value: lastFmApiKey, onChange: e => setLastFmApiKey(e.target.value), className: "w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-primary)] mb-1", children: "Genius Access Token" }), _jsx("input", { type: "text", value: geniusApiKey, onChange: e => setGeniusApiKey(e.target.value), className: "w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" })] })] })] }) }))] })] }) }), document.body);
};
