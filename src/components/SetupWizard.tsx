import React, { useState, useCallback } from 'react';
import { usePlayerStore } from '../store/index';
import { Settings, FolderPlus, Key, Database, ChevronRight, CheckCircle2, Cpu, Clock, X, AlertCircle, Check, ArrowRight } from 'lucide-react';
import { useLlmConnectionTest } from '../hooks/useLlmConnectionTest';
import { useProviderConnectionTest } from '../hooks/useProviderConnectionTest';

export const SetupWizard: React.FC<{ onComplete: () => void }> = ({ onComplete }) => {
    const { addLibraryFolder, setLastFmApiKey, setGeniusApiKey, setMusicBrainzEnabled, setSettings, getAuthHeader } = usePlayerStore();
    const [step, setStep] = useState(() => {
        const saved = localStorage.getItem('setupWizardStep');
        return saved ? Number(saved) : 1;
    });

    React.useEffect(() => {
        localStorage.setItem('setupWizardStep', step.toString());
    }, [step]);
    
    // Step 1 State
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [authError, setAuthError] = useState('');
    
    // Step 2 State
    const [libraryPath, setLibraryPath] = useState('');
    
    // Step 3 State — LLM Provider
    const [llmBaseUrl, setLlmBaseUrl] = useState('http://localhost:1234/v1');
    const [llmApiKey, setLlmApiKey] = useState('');
    const [llmModelName, setLlmModelName] = useState('');

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
            if (!llmModelName) setLlmModelName(models[0]);
        },
    });

    // Step 4 State
    const [lastFmKey, setLastFmKeyState] = useState('');
    const [lastFmSecret, setLastFmSecretState] = useState('');
    const [geniusKey, setGeniusKeyState] = useState('');
    const [musicBrainzEnabledLocal, setMusicBrainzEnabledLocal] = useState(false);
    const [musicBrainzClientIdLocal, setMusicBrainzClientIdLocal] = useState('');
    const [musicBrainzClientSecretLocal, setMusicBrainzClientSecretLocal] = useState('');

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

    // Token estimate
    const [trackCount, setTrackCount] = useState(1000);
    const [isSaving, setIsSaving] = useState(false);
    const [mbdbProgress, setMbdbProgress] = useState<{
        isImporting: boolean,
        phase: string,
        message: string,
        progress: number,
        elapsedSeconds?: number,
        currentTable?: string,
        counts?: { genres: number, aliases: number, links: number },
        lastImport?: { timestamp: number; duration: number; counts: { genres: number; aliases: number; links: number } } | null,
        completedPhases?: string[]
    }>({ isImporting: false, phase: 'idle', message: '', progress: 0, completedPhases: [] });

    const [mbdbUpdateInfo, setMbdbUpdateInfo] = useState<{
        latestTag: string;
        lastImportTag: string | null;
        updateAvailable: boolean;
        lastImport: { timestamp: number; duration: number; counts: { genres: number; aliases: number; links: number } } | null;
    } | null>(null);

    const fetchMbdbUpdateInfo = useCallback(async () => {
        const token = usePlayerStore.getState().authToken;
        if (!token) return;
        try {
            const res = await fetch('/api/admin/mbdb/check-update', { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) {
                const data = await res.json();
                setMbdbUpdateInfo(data);
            }
        } catch (e) {
            console.error('Failed to fetch MBDB update info', e);
        }
    }, []);

    React.useEffect(() => {
        if (step === 3) {
            const token = usePlayerStore.getState().authToken;
            if (!token) return;
            fetchMbdbUpdateInfo();
            const es = new EventSource('/api/admin/mbdb/status?token=' + token);
            es.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    setMbdbProgress(data);
                    if (data.phase === 'complete') {
                        fetchMbdbUpdateInfo();
                    }
                } catch {}
            };
            return () => es.close();
        }
    }, [step, fetchMbdbUpdateInfo]);

    const TOTAL_STEPS = 5;

    const handleMbdbImport = async () => {
        try {
            const authHeaders = getAuthHeader();
            await fetch('/api/admin/mbdb/import', { method: 'POST', headers: authHeaders });
        } catch(e) {
            console.error('Failed to start MBDB import', e);
        }
    };

    const handleMbdbCancel = async () => {
        try {
            const authHeaders = getAuthHeader();
            await fetch('/api/admin/mbdb/cancel', { method: 'POST', headers: authHeaders });
        } catch(e) {
            console.error('Failed to cancel MBDB import', e);
        }
    };

    const handleCreateAdmin = async () => {
        setAuthError('');
        if (username.length < 3 || password.length < 5) {
            setAuthError('Username > 3 chars, Password > 5 chars required.');
            return;
        }
        
        setIsSaving(true);
        try {
            const res = await fetch('/api/setup/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            if (!res.ok) {
                const data = await res.json();
                setAuthError(data.error || 'Failed to securely configure server.');
                setIsSaving(false);
                return;
            }

            const data = await res.json();
            // Store JWT token and user info
            usePlayerStore.getState().setAuthToken(data.token);
            if (data.user) {
                usePlayerStore.setState({ currentUser: data.user });
            }
            
            setStep(2);
        } catch (e) {
            setAuthError('Network error connecting to setup API.');
        }
        setIsSaving(false);
    };

    const handleAddLibrary = async () => {
        if (libraryPath) {
            await addLibraryFolder(libraryPath);
        }
        setStep(3);
    };

    const handleSaveLlm = async () => {
        if (llmBaseUrl || llmApiKey || llmModelName) {
            await setSettings({ llmBaseUrl, llmApiKey, llmModelName });
            // Persist to backend
            const authHeaders = getAuthHeader();
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ llmBaseUrl, llmApiKey, llmModelName })
            });
        }
        setStep(4);
    };

    const handleFinish = async () => {
        if (lastFmKey) setLastFmApiKey(lastFmKey);
        if (geniusKey) setGeniusApiKey(geniusKey);
        setMusicBrainzEnabled(musicBrainzEnabledLocal);
        // Persist provider keys to backend DB
        try {
            const authHeaders = getAuthHeader();
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                    ...(lastFmKey ? { lastFmApiKey: lastFmKey } : {}),
                    ...(lastFmSecret ? { lastFmSharedSecret: lastFmSecret } : {}),
                    ...(geniusKey ? { geniusApiKey: geniusKey } : {}),
                    musicBrainzEnabled: musicBrainzEnabledLocal,
                    ...(musicBrainzClientIdLocal ? { musicBrainzClientId: musicBrainzClientIdLocal } : {}),
                    ...(musicBrainzClientSecretLocal ? { musicBrainzClientSecret: musicBrainzClientSecretLocal } : {}),
                })
            });
        } catch (e) { console.warn('Failed to persist provider settings to DB:', e); }
        localStorage.removeItem('setupWizardStep');
        onComplete();
    };

    const stepDotClass = (i: number) =>
        `w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-300 ${
            step === i ? 'bg-[var(--color-primary)] text-white scale-110 shadow-[var(--shadow-md)]'
            : step > i ? 'bg-[var(--color-primary-dark)] text-white'
            : 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]'
        }`;

    return (
        <div className="fixed inset-0 z-[100] bg-[var(--color-bg)] flex items-center justify-center p-4">
            <div className="absolute inset-0 z-0 opacity-30 bg-aurora-deep pointer-events-none" />
            
            <div className="relative z-10 w-full max-w-2xl bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-2xl rounded-3xl p-8 md:p-12 backdrop-blur-3xl overflow-hidden">
                
                {/* Header */}
                <div className="flex flex-col items-center mb-10">
                    <div className="w-16 h-16 bg-[var(--color-primary)]/20 text-[var(--color-primary)] rounded-full flex items-center justify-center mb-4">
                        <Settings className="w-8 h-8" />
                    </div>
                    <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-[var(--color-text-primary)]">Welcome to NorthernLights</h1>
                    <p className="text-[var(--color-text-secondary)] mt-2 text-center">Let's get your personal media server set up in a few simple steps.</p>
                </div>

                {/* Step Indicators */}
                <div className="flex items-center justify-center gap-2 mb-10">
                    {[1, 2, 3, 4, 5].map(i => (
                        <div key={i} className="flex items-center">
                            <div className={stepDotClass(i)}>
                                {step > i ? <CheckCircle2 className="w-4 h-4" /> : i}
                            </div>
                            {i < TOTAL_STEPS && <div className={`w-6 md:w-10 h-1 mx-1 md:mx-2 rounded ${step > i ? 'bg-[var(--color-primary)]' : 'bg-[var(--glass-border)]'}`} />}
                        </div>
                    ))}
                </div>

                {/* Step 1: Admin */}
                {step === 1 && (
                    <div className="space-y-6 animate-in slide-in-from-right-8 fade-in duration-500 fill-mode-both">
                        <div className="text-center mb-6">
                            <h2 className="text-xl font-bold flex justify-center items-center gap-2"><Key className="w-5 h-5 text-[var(--color-primary)]"/> Secure Your Server</h2>
                            <p className="text-sm text-[var(--color-text-secondary)] mt-1">Create an admin username and password. This protects your library from public access over the internet.</p>
                        </div>
                        
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Username</label>
                                <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="admin" className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-[var(--color-text-primary)]" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Password</label>
                                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-[var(--color-text-primary)]" />
                            </div>
                            {authError && <p className="text-red-400 text-sm opacity-90">{authError}</p>}
                        </div>

                        <button onClick={handleCreateAdmin} disabled={isSaving} className="w-full mt-6 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-semibold py-4 rounded-xl shadow-lg transition-transform active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50">
                            {isSaving ? 'Securing Server...' : 'Next Step'} <ChevronRight className="w-5 h-5" />
                        </button>
                    </div>
                )}

                {/* Step 2: Library mappings */}
                {step === 2 && (
                    <div className="space-y-6 animate-in slide-in-from-right-8 fade-in duration-500 fill-mode-both">
                        <div className="text-center mb-6">
                            <h2 className="text-xl font-bold flex justify-center items-center gap-2"><Database className="w-5 h-5 text-[var(--color-primary)]"/> Map Your Music</h2>
                            <p className="text-sm text-[var(--color-text-secondary)] mt-1">Provide the absolute path to your music folder on this server to begin importing tracks.</p>
                        </div>

                        <div className="bg-[var(--color-surface)]/50 border border-[var(--glass-border)] rounded-xl p-4 text-sm text-[var(--color-text-secondary)] mb-4">
                            Example: <code className="bg-black/30 px-1 py-0.5 rounded text-[var(--color-text-primary)]">/mnt/storage/music</code> or <code className="bg-black/30 px-1 py-0.5 rounded text-[var(--color-text-primary)]">C:\Users\Andreas\Music</code>
                        </div>
                        
                        <div>
                            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Absolute Directory Path</label>
                            <input type="text" value={libraryPath} onChange={e => setLibraryPath(e.target.value)} placeholder="/path/to/music" className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-[var(--color-text-primary)]" />
                        </div>

                        <div className="flex gap-4 mt-6">
                            <button onClick={handleAddLibrary} className="flex-1 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-semibold py-4 rounded-xl shadow-lg transition-transform active:scale-[0.98] flex items-center justify-center gap-2">
                                <FolderPlus className="w-5 h-5" /> Import Library
                            </button>
                            <button onClick={() => setStep(3)} className="px-6 bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] border border-[var(--glass-border)] text-[var(--color-text-primary)] font-semibold rounded-xl transition-all">
                                Skip
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 3: MBDB Import */}
                {step === 3 && (
                    <div className="space-y-6 animate-in slide-in-from-right-8 fade-in duration-500 fill-mode-both">
                        <div className="text-center mb-6">
                            <h2 className="text-xl font-bold flex justify-center items-center gap-2"><Database className="w-5 h-5 text-[var(--color-primary)]"/> MusicBrainz Taxonomy</h2>
                            <p className="text-sm text-[var(--color-text-secondary)] mt-1">Import the latest comprehensive genre taxonomy from the official MusicBrainz database. This enables high-accuracy recommendation tracking with zero AI token cost.</p>
                        </div>
                        
                        <div className="bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl p-5 mb-4">
                            {!mbdbProgress.isImporting ? (
                                <div className="flex flex-col gap-3">
                                    {mbdbProgress.phase === 'complete' ? (
                                        <div className="text-green-500 font-medium text-sm flex items-center justify-center gap-2 p-2">✓ Import completed successfully.</div>
                                    ) : (
                                        <button 
                                            onClick={handleMbdbImport}
                                            className="w-full bg-[var(--color-bg)] hover:bg-[var(--glass-bg)] text-[var(--color-text-primary)] border border-[var(--color-primary)] font-semibold py-3 rounded-lg shadow-sm transition-transform active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                            disabled={mbdbUpdateInfo?.updateAvailable === false}
                                        >
                                            <Database size={18} /> {mbdbUpdateInfo?.updateAvailable === false ? 'Already Up to Date' : 'Start Download & Import (~3.5GB)'}
                                        </button>
                                    )}
                                    {mbdbProgress.phase === 'error' && (
                                        <div className="text-red-500 font-medium text-sm mt-2 text-center flex items-center justify-center gap-2">
                                            <AlertCircle size={16} /> {mbdbProgress.message}
                                        </div>
                                    )}
                                    
                                    {/* Update Status */}
                                    {mbdbUpdateInfo && (
                                        <div className="bg-black/5 dark:bg-white/5 rounded-lg p-3 space-y-2">
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide">Status</span>
                                                {mbdbUpdateInfo.updateAvailable ? (
                                                    <span className="text-xs text-[var(--color-primary)] font-medium">Update Available</span>
                                                ) : (
                                                    <span className="text-xs text-green-500 font-medium">Up to Date</span>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                                                <span>Latest: <code className="bg-black/10 dark:bg-white/10 px-1 rounded">{mbdbUpdateInfo.latestTag}</code></span>
                                                {mbdbUpdateInfo.lastImportTag && (
                                                    <span>Installed: <code className="bg-black/10 dark:bg-white/10 px-1 rounded">{mbdbUpdateInfo.lastImportTag}</code></span>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    
                                    {/* Last Import Summary */}
                                    {(mbdbProgress.lastImport || mbdbUpdateInfo?.lastImport) && (
                                        <div className="bg-black/5 dark:bg-white/5 rounded-lg p-3 space-y-1 mt-2">
                                            <div className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide text-center">Last Import</div>
                                            <div className="flex items-center justify-center gap-4 text-sm">
                                                <span className="flex items-center gap-1">
                                                    <Clock size={14} className="text-[var(--color-text-muted)]" />
                                                    {Math.round(((mbdbProgress.lastImport || mbdbUpdateInfo?.lastImport)?.duration ?? 0) / 60)}min
                                                </span>
                                                <span>{(mbdbProgress.lastImport || mbdbUpdateInfo?.lastImport)?.counts.genres.toLocaleString()} genres</span>
                                                <span>{(mbdbProgress.lastImport || mbdbUpdateInfo?.lastImport)?.counts.aliases.toLocaleString()} aliases</span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {/* Pulsing Bar */}
                                    <div className="h-1 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                                        <div className="h-full bg-[var(--color-primary)] animate-pulse rounded-full" />
                                    </div>
                                    
                                    {/* Phase List */}
                                    <div className="space-y-2">
                                        {mbdbProgress.completedPhases?.map((phase, i) => (
                                            <div key={i} className="flex items-center gap-2 text-sm text-green-500">
                                                <Check size={14} className="flex-shrink-0" /> 
                                                <span className="break-all">{phase}</span>
                                            </div>
                                        ))}
                                        
                                        {/* Current Phase */}
                                        {mbdbProgress.phase !== 'complete' && mbdbProgress.phase !== 'error' && (
                                            <div className="flex items-center gap-2 text-sm">
                                                <ArrowRight size={14} className="animate-pulse flex-shrink-0 text-[var(--color-primary)]" /> 
                                                <span className="break-all text-[var(--color-text-primary)]">{mbdbProgress.message}</span>
                                            </div>
                                        )}
                                    </div>
                                    
                                    {/* Cancel Button */}
                                    <button 
                                        onClick={handleMbdbCancel}
                                        className="btn btn-danger w-full"
                                    >
                                        <X size={16} /> Cancel Import
                                    </button>
                                </div>
                            )}
                        </div>

                        <div className="flex gap-4 mt-6">
                            <button disabled={mbdbProgress.isImporting} onClick={() => setStep(4)} className="flex-1 py-2.5 rounded-xl bg-aurora-gradient hover:brightness-110 text-white font-semibold shadow-lg transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                                {mbdbProgress.phase === 'complete' ? 'Next Step' : 'Skip MBDB Import'} <ChevronRight className="w-5 h-5" />
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 4: LLM Provider */}
                {step === 4 && (
                    <div className="space-y-5 animate-in slide-in-from-right-8 fade-in duration-500 fill-mode-both">
                        <div className="text-center mb-4">
                            <h2 className="text-xl font-bold flex justify-center items-center gap-2"><Cpu className="w-5 h-5 text-[var(--color-primary)]"/> AI Playlist Provider</h2>
                            <p className="text-sm text-[var(--color-text-secondary)] mt-1">Optionally connect a local or cloud LLM to power AI-curated playlists and the Genre Matrix. Works great with LM Studio.</p>
                        </div>

                        {/* Token usage estimate */}
                        {(() => {
                            const genreCount = Math.max(10, Math.floor(trackCount / 30));
                            const monthlyHubTokens = 180 * 850;
                            const oneTimeMatrixTokens = genreCount * 600;
                            const totalFirstMonth = monthlyHubTokens + oneTimeMatrixTokens;
                            const fmt = (n: number) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : `${Math.round(n/1000)}K`;
                            
                            // Cost calculation (70% input, 30% output based on typical LLM usage)
                            const inputRatio = 0.7;
                            const outputRatio = 0.3;
                            const inputTokens = Math.round(totalFirstMonth * inputRatio);
                            const outputTokens = Math.round(totalFirstMonth * outputRatio);
                            const inputCost = (inputTokens / 1_000_000) * 0.20;
                            const outputCost = (outputTokens / 1_000_000) * 1.25;
                            const totalCost = inputCost + outputCost;
                            
                            return (
                                <div className="bg-[var(--color-surface)]/60 border border-[var(--glass-border)] rounded-2xl p-4 space-y-3">
                                    <div className="flex items-center justify-between gap-4">
                                        <label className="text-sm font-medium text-[var(--color-text-secondary)] shrink-0">Approx. track count</label>
                                        <input
                                            type="number"
                                            min={100} max={100000} step={100}
                                            value={trackCount}
                                            onChange={e => setTrackCount(Math.max(100, Number(e.target.value)))}
                                            className="w-28 text-right bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-1.5 text-sm font-mono text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
                                        />
                                    </div>
                                    <div className="border-t border-[var(--glass-border)] pt-3 space-y-1.5 text-sm">
                                        <div className="flex justify-between text-[var(--color-text-secondary)]">
                                            <span>Hub playlists (monthly, 4h schedule)</span>
                                            <span className="font-medium text-[var(--color-text-primary)]">~{fmt(monthlyHubTokens)} tokens</span>
                                        </div>
                                        <div className="flex justify-between text-[var(--color-text-secondary)]">
                                            <span>Genre Matrix (one-time, ~{genreCount} genres)</span>
                                            <span className="font-medium text-[var(--color-text-primary)]">~{fmt(oneTimeMatrixTokens)} tokens</span>
                                        </div>
                                        <div className="flex justify-between font-semibold border-t border-[var(--glass-border)] pt-2 mt-1 text-[var(--color-text-primary)]">
                                            <span>Expected monthly token usage</span>
                                            <span className="text-[var(--color-primary)]">~{fmt(totalFirstMonth)} tokens</span>
                                        </div>
                                        <div className="flex justify-between text-[var(--color-text-secondary)] pt-2">
                                            <span>Estimated first month cost</span>
                                            <span className="font-medium text-[var(--color-primary)]">${totalCost.toFixed(2)}</span>
                                        </div>
                                        <p className="text-xs text-[var(--color-text-muted)] pt-1">Fully free with local providers (LM Studio, Ollama). GPT-5.4-nano: $0.20/1M input, $1.25/1M output.</p>
                                    </div>
                                </div>
                            );
                        })()}

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">API Base URL</label>
                                <input
                                    type="text"
                                    value={llmBaseUrl}
                                    onChange={e => setLlmBaseUrl(e.target.value)}
                                    placeholder="http://localhost:1234/v1"
                                    className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-sm text-[var(--color-text-primary)]"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">API Key <span className="text-[var(--color-text-muted)] font-normal">(leave blank for local providers)</span></label>
                                <input
                                    type="password"
                                    value={llmApiKey}
                                    onChange={e => setLlmApiKey(e.target.value)}
                                    placeholder="sk-... or leave blank"
                                    className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-sm text-[var(--color-text-primary)]"
                                />
                            </div>

                            {/* Test Connection */}
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => runConnectionTest(llmBaseUrl, llmApiKey)}
                                    disabled={connectionStatus === 'testing'}
                                    className="font-semibold text-sm px-4 py-2 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-lg hover:bg-[var(--glass-bg-hover)] transition-colors text-[var(--color-text-primary)] disabled:opacity-50 shadow-sm"
                                >
                                    {connectionStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                                </button>
                                {connectionStatus === 'success' && <span className="text-green-500 font-semibold text-sm">✓ {connectionMessage}</span>}
                                {connectionStatus === 'error' && <span className="text-red-500 font-semibold text-sm truncate max-w-xs" title={connectionMessage}>✗ {connectionMessage}</span>}
                            </div>

                            {/* Model Name */}
                            <div className="relative">
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Model Name</label>
                                <input
                                    type="text"
                                    value={llmModelName}
                                    onChange={e => setLlmModelName(e.target.value)}
                                    onFocus={() => setShowModelDropdown(true)}
                                    onBlur={() => setTimeout(() => setShowModelDropdown(false), 200)}
                                    placeholder="gpt-4o / llama-3 (auto-filled on test)"
                                    className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-sm text-[var(--color-text-primary)]"
                                />
                                {availableModels.length > 0 && showModelDropdown && (
                                    <ul className="absolute left-0 right-0 z-50 w-full mt-1 max-h-40 overflow-y-auto bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl shadow-xl backdrop-blur-xl hide-scrollbar py-1">
                                        {availableModels.map(m => (
                                            <li
                                                key={m}
                                                className="px-4 py-2.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)] cursor-pointer transition-colors border-b border-[var(--glass-border)] last:border-0"
                                                onMouseDown={e => { e.preventDefault(); setLlmModelName(m); setShowModelDropdown(false); }}
                                            >
                                                {m}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>

                        <div className="flex gap-4 mt-2">
                            <button onClick={() => { handleSaveLlm(); setStep(5); }} className="flex-1 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-semibold py-4 rounded-xl shadow-lg transition-transform active:scale-[0.98] flex items-center justify-center gap-2">
                                Save & Continue <ChevronRight className="w-5 h-5" />
                            </button>
                            <button onClick={() => setStep(5)} className="px-6 bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] border border-[var(--glass-border)] text-[var(--color-text-primary)] font-semibold rounded-xl transition-all">
                                Skip
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 5: External APIs */}
                {step === 5 && (
                    <div className="space-y-6 animate-in slide-in-from-right-8 fade-in duration-500 fill-mode-both">
                        <div className="text-center mb-6">
                            <h2 className="text-xl font-bold flex justify-center items-center gap-2"><Settings className="w-5 h-5 text-[var(--color-primary)]"/> External Enablers</h2>
                            <p className="text-sm text-[var(--color-text-secondary)] mt-1">Optionally add API keys to fetch rich artist imagery, bios, and fallback album art directly in the frontend.</p>
                        </div>
                        
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Last.fm API Key</label>
                                <div className="flex gap-2">
                                    <input type="password" value={lastFmKey} onChange={e => setLastFmKeyState(e.target.value)} placeholder="32-character API key" className="flex-1 bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-[var(--color-text-primary)]" />
                                    <button onClick={() => testLastFm(lastFmKey)} disabled={lastFmStatus === 'testing' || !lastFmKey} className="px-4 py-2 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-lg font-semibold text-sm hover:bg-[var(--glass-bg-hover)] transition-colors text-[var(--color-text-primary)] disabled:opacity-50 shadow-sm whitespace-nowrap">
                                        {lastFmStatus === 'testing' ? 'Testing...' : 'Test'}
                                    </button>
                                </div>
                                {lastFmStatus === 'success' && <span className="text-green-500 font-semibold text-sm mt-1 block">✓ {lastFmMessage}</span>}
                                {lastFmStatus === 'error' && <span className="text-red-500 font-semibold text-sm mt-1 block">✗ {lastFmMessage}</span>}
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Last.fm Shared Secret</label>
                                <input type="password" value={lastFmSecret} onChange={e => setLastFmSecretState(e.target.value)} placeholder="For scrobbling (optional during setup)" className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-[var(--color-text-primary)]" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Genius Access Token</label>
                                <div className="flex gap-2">
                                    <input type="password" value={geniusKey} onChange={e => setGeniusKeyState(e.target.value)} placeholder="64-character Bearer Token" className="flex-1 bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-[var(--color-text-primary)]" />
                                    <button onClick={() => testGenius(geniusKey)} disabled={geniusStatus === 'testing' || !geniusKey} className="px-4 py-2 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-lg font-semibold text-sm hover:bg-[var(--glass-bg-hover)] transition-colors text-[var(--color-text-primary)] disabled:opacity-50 shadow-sm whitespace-nowrap">
                                        {geniusStatus === 'testing' ? 'Testing...' : 'Test'}
                                    </button>
                                </div>
                                {geniusStatus === 'success' && <span className="text-green-500 font-semibold text-sm mt-1 block">✓ {geniusMessage}</span>}
                                {geniusStatus === 'error' && <span className="text-red-500 font-semibold text-sm mt-1 block">✗ {geniusMessage}</span>}
                            </div>
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)]">MusicBrainz</label>
                                    <button
                                        onClick={() => setMusicBrainzEnabledLocal(!musicBrainzEnabledLocal)}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${musicBrainzEnabledLocal ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-bg-tertiary)]'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${musicBrainzEnabledLocal ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>
                                <p className="text-xs text-[var(--color-text-muted)] mb-2">Structured metadata with optional OAuth2. Provides artist disambiguation, official links, genre tags, and album art from Cover Art Archive.</p>
                                {musicBrainzEnabledLocal && (
                                    <div className="flex flex-col gap-2">
                                        <div className="flex gap-2 items-center">
                                            <button onClick={() => testMusicBrainz()} disabled={musicBrainzStatus === 'testing'} className="px-4 py-2 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-lg font-semibold text-sm hover:bg-[var(--glass-bg-hover)] transition-colors text-[var(--color-text-primary)] disabled:opacity-50 shadow-sm whitespace-nowrap">
                                                {musicBrainzStatus === 'testing' ? 'Testing...' : 'Test'}
                                            </button>
                                            {musicBrainzStatus === 'success' && <span className="text-green-500 font-semibold text-xs">✓ {musicBrainzMessage}</span>}
                                            {musicBrainzStatus === 'error' && <span className="text-red-500 font-semibold text-xs">✗ {musicBrainzMessage}</span>}
                                        </div>
                                        <label className="block text-xs font-medium text-[var(--color-text-secondary)]">Client ID (optional)</label>
                                        <input type="text" value={musicBrainzClientIdLocal} onChange={e => setMusicBrainzClientIdLocal(e.target.value)} placeholder="From musicbrainz.org/account/applications" className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all text-sm font-mono text-[var(--color-text-primary)]" />
                                        <label className="block text-xs font-medium text-[var(--color-text-secondary)]">Client Secret (optional)</label>
                                        <input type="password" value={musicBrainzClientSecretLocal} onChange={e => setMusicBrainzClientSecretLocal(e.target.value)} placeholder="From musicbrainz.org/account/applications" className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all text-sm font-mono text-[var(--color-text-primary)]" />
                                    </div>
                                )}
                            </div>
                        </div>

                        <button onClick={handleFinish} className="w-full mt-6 bg-aurora-gradient hover:brightness-110 text-white font-bold py-4 rounded-xl shadow-lg transition-transform active:scale-[0.98] flex items-center justify-center gap-2">
                            <CheckCircle2 className="w-5 h-5" /> Finish Setup & Launch
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
