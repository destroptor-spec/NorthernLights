import React, { useState, useCallback, useEffect, useRef } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { Activity, AlertCircle, BarChart3, BrainCircuit, CheckCircle2, Download, Folder, FolderPlus, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { PromptModal } from '../PromptModal';
import { ConfirmModal } from '../ConfirmModal';
import type { LibraryDirectoryStats } from '../../../shared/libraryStats';
import { ServerEventStream } from '../../utils/serverEvents';

interface SimulatedFeatureTrack {
    id: string;
    title: string;
    artist: string | null;
    album: string | null;
    filename: string;
    filePath: string;
    bpm: number | null;
}

interface ModelFileStatus {
    name: string;
    filename: string;
    url: string;
    size: number;
    cached: boolean;
    downloading: boolean;
    error?: string;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export const LibraryTab: React.FC = () => {
    const libraryFolders = usePlayerStore(state => state.libraryFolders);
    const addLibraryFolder = usePlayerStore(state => state.addLibraryFolder);
    const removeLibraryFolder = usePlayerStore(state => state.removeLibraryFolder);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);
    const isScanning = usePlayerStore(state => state.isScanning);
    const autoFolderWalk = usePlayerStore(state => state.autoFolderWalk);
    const setSettings = usePlayerStore(state => state.setSettings);
    const authToken = usePlayerStore(state => state.authToken);
    const sseAccessToken = usePlayerStore(state => state.sseAccessToken);

    const [dirStats, setDirStats] = useState<Record<string, LibraryDirectoryStats>>({});
    const [dirStatsLoading, setDirStatsLoading] = useState(false);
    const [simulatedTracks, setSimulatedTracks] = useState<SimulatedFeatureTrack[]>([]);
    const [simulatedLoading, setSimulatedLoading] = useState(false);

    const [modelStatus, setModelStatus] = useState<ModelFileStatus[]>([]);
    const [modelDownloadProgress, setModelDownloadProgress] = useState<Record<string, { bytes: number; total: number; status: string }>>({});
    const [isModelDownloading, setIsModelDownloading] = useState(false);
    const modelSseRef = useRef<ServerEventStream | null>(null);

    const [promptDialog, setPromptDialog] = useState<{ title: string; label?: string; placeholder?: string; onSubmit: (value: string) => void } | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
    
    const { addToast } = useToast();
    const showToast = useCallback((msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type), [addToast]);

    const fetchDirStats = useCallback(async () => {
        try {
            setDirStatsLoading(true);
            const authHeaders = getAuthHeader();
            const res = await fetch('/api/library/stats', { headers: { ...authHeaders } });
            if (!res.ok) return;
            const data = await res.json();
            const statsMap: Record<string, LibraryDirectoryStats> = {};
            for (const d of data.directories || []) {
                statsMap[d.path] = { ...d, missingAnalysis: d.missingAnalysis ?? 0, outdatedAnalysis: d.outdatedAnalysis ?? 0 };
            }
            setDirStats(statsMap);
        } catch (e) {
            console.error('Failed to fetch directory stats', e);
        } finally {
            setDirStatsLoading(false);
        }
    }, [getAuthHeader]);

    useEffect(() => {
        fetchDirStats();
    }, [fetchDirStats]);

    const fetchSimulatedTracks = useCallback(async () => {
        try {
            setSimulatedLoading(true);
            const res = await fetch('/api/library/analyze/simulated?limit=25', { headers: getAuthHeader() });
            if (!res.ok) return;
            const data = await res.json();
            setSimulatedTracks(Array.isArray(data.tracks) ? data.tracks : []);
        } catch (e) {
            console.error('Failed to fetch simulated analysis tracks', e);
        } finally {
            setSimulatedLoading(false);
        }
    }, [getAuthHeader]);

    useEffect(() => {
        fetchSimulatedTracks();
    }, [fetchSimulatedTracks]);

    const fetchModelStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/settings/models/status', { headers: getAuthHeader() });
            if (!res.ok) return;
            const data = await res.json();
            const files: ModelFileStatus[] = (data.models || []).flatMap((m: any) => m.files || []);
            setModelStatus(files);
            setIsModelDownloading(!!data.isDownloading);
        } catch {}
    }, [getAuthHeader]);

    const handleDownloadModels = useCallback(async () => {
        try {
            const res = await fetch('/api/settings/models/download', {
                method: 'POST',
                headers: getAuthHeader(),
            });
            if (!res.ok) return;
            setIsModelDownloading(true);

            // Open SSE stream for live progress
            if (modelSseRef.current) modelSseRef.current.close();
            const token = sseAccessToken;
            if (!token) return;
            const sse = new ServerEventStream('/api/settings/models/progress?token=' + encodeURIComponent(token));
            modelSseRef.current = sse;
            sse.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    if (data.type === 'status') return;
                    if (data.model && data.file) {
                        setModelDownloadProgress(prev => ({
                            ...prev,
                            [data.file]: { bytes: data.bytesDownloaded, total: data.totalBytes, status: data.status }
                        }));
                        if (data.status === 'done' || data.status === 'error') {
                            fetchModelStatus();
                        }
                    }
                } catch {}
            };
            sse.onerror = () => { sse.close(); setIsModelDownloading(false); fetchModelStatus(); };
        } catch {}
    }, [getAuthHeader, fetchModelStatus, sseAccessToken, authToken]);

    // Mount model status fetch (after fetchModelStatus is declared)
    useEffect(() => {
        fetchModelStatus();
    }, [fetchModelStatus]);

    // Cleanup SSE on unmount
    useEffect(() => { return () => { modelSseRef.current?.close(); }; }, []);

    const prevIsScanning = useRef(isScanning);
    useEffect(() => {
        if (prevIsScanning.current && !isScanning) {
            fetchDirStats();
            fetchSimulatedTracks();
        }
        prevIsScanning.current = isScanning;
    }, [isScanning, fetchDirStats, fetchSimulatedTracks]);



    const handleAddFolder = async () => {
        setPromptDialog({
            title: 'Map Folder Path',
            label: 'Enter the absolute path to your music folder on the server.',
            placeholder: '/home/andreas/Music',
            onSubmit: async (path) => {
                setPromptDialog(null);
                await addLibraryFolder(path);
                fetchDirStats();
            },
        });
    };

    const handleRescanFolder = async (folderPath: string) => {
        try {
            const authHeaders = getAuthHeader();
            let scanStarted = false;
            while (!scanStarted) {
                const res = await fetch('/api/library/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ path: folderPath })
                });
                if (res.status === 400) {
                    const errorData = await res.json().catch(() => ({}));
                    if (errorData.error === 'Scan already in progress') {
                        await new Promise(r => setTimeout(r, 1000));
                    } else {
                        showToast(`Rescan failed: ${errorData.error}`, 'error');
                        scanStarted = true;
                    }
                } else {
                    scanStarted = true;
                    if (res.ok) {
                        const data = await res.json();
                        if (data.added > 0 || data.removed > 0) {
                            showToast(`Scanned ${data.added} new tracks, removed ${data.removed} stale`, 'success');
                        } else {
                            showToast('No changes detected in folder', 'info');
                        }
                    } else {
                        const errData = await res.json().catch(() => ({}));
                        showToast(`Rescan failed: ${errData.error || res.statusText}`, 'error');
                    }
                }
            }
            await fetchLibraryFromServer();
            fetchDirStats();
        } catch (e) {
            showToast(`Rescan failed: ${e}`, 'error');
        }
    };

    const handleRefreshMetadata = useCallback(async (folderPath: string) => {
        try {
            const authHeaders = getAuthHeader();
            let refreshStarted = false;
            while (!refreshStarted) {
                const res = await fetch('/api/library/refresh-metadata', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ path: folderPath })
                });
                if (res.status === 400) {
                    const errorData = await res.json().catch(() => ({}));
                    if (errorData.error === 'Scan already in progress') {
                        await new Promise(r => setTimeout(r, 1000));
                    } else {
                        showToast(`Refresh failed: ${errorData.error}`, 'error');
                        refreshStarted = true;
                    }
                } else {
                    refreshStarted = true;
                    if (res.ok) {
                        showToast(`Metadata refresh commenced in background`, 'success');
                    } else {
                        const errData = await res.json().catch(() => ({}));
                        showToast(`Refresh failed: ${errData.error || res.statusText}`, 'error');
                    }
                }
            }
            await fetchLibraryFromServer();
            fetchDirStats();
        } catch (e) {
            showToast(`Refresh failed: ${e}`, 'error');
        }
    }, [getAuthHeader, showToast, fetchLibraryFromServer, fetchDirStats]);

    const handleRemoveFolder = async (folderPath: string) => {
        await removeLibraryFolder(folderPath);
        fetchDirStats();
    };

    const handleAnalyze = async () => {
        try {
            const res = await fetch('/api/library/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({ force: false })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                showToast(data.detail || data.error || 'Analysis failed', 'error');
                return;
            }
            fetchDirStats();
            fetchSimulatedTracks();
        } catch (e) {}
    };

    const handleAnalyzeSimulated = async () => {
        try {
            const res = await fetch('/api/library/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({ simulatedOnly: true })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                showToast(data.detail || data.error || 'Analysis failed', 'error');
                return;
            }
            const data = await res.json().catch(() => ({}));
            showToast(data.message || 'Re-analysis started', 'success');
            fetchDirStats();
            fetchSimulatedTracks();
        } catch (e) {
            showToast(`Analysis failed: ${e}`, 'error');
        }
    };

    const handleForceAnalyze = async () => {
        setConfirmDialog({
            title: 'Re-analyze All Tracks',
            message: 'This will re-run audio analysis on your entire library, replacing existing feature data. This may take several minutes.',
            confirmLabel: 'Re-analyze All',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    const res = await fetch('/api/library/analyze', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                        body: JSON.stringify({ force: true })
                    });
                    if (!res.ok) {
                        const data = await res.json().catch(() => ({}));
                        showToast(data.detail || data.error || 'Analysis failed', 'error');
                        return;
                    }
                    fetchDirStats();
                    fetchSimulatedTracks();
                } catch (e) {}
            },
        });
    };

    const handleMeasureLoudness = async () => {
        try {
            const res = await fetch('/api/library/analyze/loudness', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({}),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                showToast(data.detail || data.error || 'Loudness measurement failed', 'error');
                return;
            }
            showToast(data.message || 'Loudness measurement started', 'success');
            fetchDirStats();
        } catch (e) {
            showToast(`Loudness measurement failed: ${e}`, 'error');
        }
    };

    const totalStats = Object.values(dirStats).reduce(
        (acc, s) => ({
            totalTracks: acc.totalTracks + s.totalTracks,
            withMetadata: acc.withMetadata + s.withMetadata,
            analyzed: acc.analyzed + s.analyzed,
            missingAnalysis: acc.missingAnalysis + s.missingAnalysis,
            outdatedAnalysis: acc.outdatedAnalysis + s.outdatedAnalysis,
        }),
        { totalTracks: 0, withMetadata: 0, analyzed: 0, missingAnalysis: 0, outdatedAnalysis: 0 }
    );
    const analysisPct = totalStats.totalTracks > 0
        ? Math.min(totalStats.analyzed === totalStats.totalTracks ? 100 : 99,
            Math.round((totalStats.analyzed / totalStats.totalTracks) * 100))
        : 0;
    const hasModels = modelStatus.length > 0;
    const allModelsCached = hasModels && modelStatus.every(m => m.cached);

    return (
        <div className="settings-section library-settings">
            <header className="library-settings__header">
                <div>
                    <p className="library-settings__eyebrow">Library</p>
                    <h3>Library Sources</h3>
                    <p>Map server folders, scan tracks, and prepare audio analysis models.</p>
                </div>
                <button type="button" className="btn btn-primary btn-sm" onClick={handleAddFolder}>
                    <FolderPlus size={15} aria-hidden="true" />
                    Map Folder
                </button>
            </header>

            <section className="library-overview" aria-label="Library coverage">
                <div className="library-overview__item">
                    <span>Folders</span>
                    <strong>{libraryFolders.length}</strong>
                </div>
                <div className="library-overview__item">
                    <span>Tracks</span>
                    <strong>{totalStats.totalTracks}</strong>
                </div>
                <div className="library-overview__item">
                    <span>Metadata</span>
                    <strong>{totalStats.withMetadata}</strong>
                </div>
                <div className="library-overview__item">
                    <span>Analyzed</span>
                    <strong>{analysisPct}%</strong>
                </div>
            </section>

            <section className="library-panel library-panel--folders">
                <div className="library-panel__header">
                    <div className="library-panel__title">
                        <Folder size={17} aria-hidden="true" />
                        <h4>Mapped Folders</h4>
                    </div>
                    <p>Folders here are scanned from the server filesystem.</p>
                </div>

                <ul className="library-folder-list">
                    {libraryFolders.length === 0 ? (
                        <li className="library-empty-state">
                            <FolderPlus size={18} aria-hidden="true" />
                            <span>No folders mapped yet.</span>
                        </li>
                    ) : (
                        libraryFolders.map((folderPath) => {
                            const stats = dirStats[folderPath];
                            const analysisState = stats && stats.totalTracks > 0 && stats.analyzed === stats.totalTracks ? 'complete' : 'partial';
                            return (
                                <li key={folderPath} className="library-folder-row">
                                    <div className="library-folder-row__main">
                                        <div className="library-folder-row__path">
                                            <Folder size={16} aria-hidden="true" />
                                            <span title={folderPath}>{folderPath}</span>
                                        </div>
                                        <div className="library-folder-row__actions">
                                            <button type="button" className="btn btn-primary btn-sm" onClick={() => handleRescanFolder(folderPath)}>
                                                <RefreshCw size={14} aria-hidden="true" />
                                                Rescan
                                            </button>
                                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleRefreshMetadata(folderPath)} disabled={isScanning}>
                                                Refresh Metadata
                                            </button>
                                            <button type="button" className="btn btn-danger-fill btn-sm" onClick={() => handleRemoveFolder(folderPath)}>
                                                <Trash2 size={14} aria-hidden="true" />
                                                Remove
                                            </button>
                                        </div>
                                    </div>

                                    {stats && stats.totalTracks > 0 && (
                                        <div className="library-folder-row__stats">
                                            <span>{stats.totalTracks} tracks</span>
                                            <span>{stats.withMetadata} with metadata</span>
                                            <span data-state={analysisState}>{stats.analyzed} analysis up to date</span>
                                            {stats.missingAnalysis > 0 && <span>{stats.missingAnalysis} awaiting analysis</span>}
                                            {stats.outdatedAnalysis > 0 && <span>{stats.outdatedAnalysis} need analysis updates</span>}
                                        </div>
                                    )}
                                    {stats && stats.totalTracks === 0 && (
                                        <div className="library-folder-row__empty">No tracks found. Rescan to index this folder.</div>
                                    )}
                                </li>
                            );
                        })
                    )}
                </ul>

                <div className="library-toggle-row">
                    <div>
                        <h5>Automatic Folder Walk</h5>
                        <p>Re-walk all folders every 30 minutes to detect renamed or deleted files.</p>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={autoFolderWalk}
                        onClick={() => setSettings({ autoFolderWalk: !autoFolderWalk })}
                        className="account-switch"
                        data-state={autoFolderWalk ? 'on' : 'off'}
                    >
                        <span className="account-switch__thumb" />
                    </button>
                </div>
            </section>

            <section className="library-panel library-panel--analysis">
                <div className="library-panel__header">
                    <div className="library-panel__title">
                        <Activity size={17} aria-hidden="true" />
                        <h4>Audio Analysis</h4>
                    </div>
                    <div className="library-panel__actions">
                        <button type="button" className="btn btn-primary btn-sm" onClick={handleAnalyze} disabled={isScanning}>
                            {isScanning ? 'Analyzing...' : 'Analyze Pending'}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={handleForceAnalyze} disabled={isScanning}>
                            Re-analyze All
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={handleMeasureLoudness} disabled={isScanning}>
                            Measure Loudness
                        </button>
                    </div>
                </div>
                <p className="library-panel__description">Analyzes tracks with missing or outdated results. Rescans also process this backlog across the library, including older tracks that need updates after analyzer improvements. Requires ML models below. "Measure Loudness" computes loudness for volume normalization where it is missing.</p>
                {dirStatsLoading ? (
                    <div className="library-progress" aria-live="polite">
                        <div className="library-progress__label">
                            <span>Analysis up to date</span>
                            <span className="library-progress__loading">Loading...</span>
                        </div>
                        <div className="library-progress__track" />
                    </div>
                ) : totalStats.totalTracks > 0 ? (
                    <div className="library-progress">
                        <div className="library-progress__label">
                            <span>Analysis up to date</span>
                            <span>{totalStats.analyzed} / {totalStats.totalTracks} tracks ({analysisPct}%)</span>
                        </div>
                        <div className="library-progress__track">
                            <div className="library-progress__fill" data-state={analysisPct === 100 ? 'complete' : analysisPct > 50 ? 'partial' : 'low'} style={{ width: `${analysisPct}%` }} />
                        </div>
                    </div>
                ) : null}
                {(totalStats.missingAnalysis > 0 || totalStats.outdatedAnalysis > 0) && (
                    <p className="library-panel__description">
                        {totalStats.missingAnalysis} awaiting analysis; {totalStats.outdatedAnalysis} need analysis updates.
                    </p>
                )}

                <div className="library-simulated">
                    <div className="library-simulated__head">
                        <div>
                            <h5>Fallback Analysis</h5>
                            <p>Tracks listed here used placeholder vectors because native extraction failed.</p>
                        </div>
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={handleAnalyzeSimulated}
                            disabled={isScanning || simulatedLoading || simulatedTracks.length === 0}
                        >
                            <RefreshCw size={14} aria-hidden="true" />
                            Re-analyze Fallbacks
                        </button>
                    </div>

                    {simulatedLoading ? (
                        <div className="library-empty-state library-empty-state--inline" role="status">
                            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                            <span>Checking fallback tracks...</span>
                        </div>
                    ) : simulatedTracks.length === 0 ? (
                        <div className="library-empty-state library-empty-state--inline">
                            <CheckCircle2 size={16} aria-hidden="true" />
                            <span>No simulated fallback analysis stored.</span>
                        </div>
                    ) : (
                        <ul className="library-simulated-list" aria-label="Tracks with simulated analysis">
                            {simulatedTracks.map(track => (
                                <li key={track.id} className="library-simulated-row">
                                    <div className="library-simulated-row__main">
                                        <AlertCircle size={15} aria-hidden="true" />
                                        <div>
                                            <strong>{track.artist ? `${track.artist} - ${track.title}` : track.title}</strong>
                                            <span>{track.album || track.filename}</span>
                                        </div>
                                    </div>
                                    <code title={track.filePath}>{track.filePath}</code>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </section>

            <section className="library-panel library-panel--models">
                <div className="library-panel__header">
                    <div className="library-panel__title">
                        <BrainCircuit size={17} aria-hidden="true" />
                        <h4>ML Models</h4>
                    </div>
                    <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={handleDownloadModels}
                        disabled={isModelDownloading}
                    >
                        {isModelDownloading
                            ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Downloading...</>
                            : <><Download size={14} aria-hidden="true" /> {allModelsCached ? 'Re-download' : 'Download Models'}</>
                        }
                    </button>
                </div>
                <p className="library-panel__description">Discogs-EffNet and MusiCNN files used by the Python extractor.</p>

                <ul className="library-model-list">
                    {modelStatus.length === 0 ? (
                        <li className="library-empty-state library-empty-state--inline">
                            <BarChart3 size={16} aria-hidden="true" />
                            <span>Checking model status...</span>
                        </li>
                    ) : modelStatus.map(m => {
                        const prog = modelDownloadProgress[m.filename];
                        const isActive = prog && prog.status === 'downloading';
                        const pct = isActive && prog.total > 0 ? Math.round((prog.bytes / prog.total) * 100) : null;
                        return (
                            <li key={m.filename} className="library-model-row">
                                <div className="library-model-row__main">
                                    <div className="library-model-row__name">
                                        {m.cached
                                            ? <CheckCircle2 size={15} className="library-model-row__icon library-model-row__icon--ready" aria-hidden="true" />
                                            : <AlertCircle size={15} className="library-model-row__icon library-model-row__icon--missing" aria-hidden="true" />
                                        }
                                        <span>{m.name}</span>
                                        <code>{m.filename}</code>
                                    </div>
                                    <span className="library-model-row__size">
                                        {m.cached ? formatBytes(m.size) : 'Not downloaded'}
                                    </span>
                                </div>
                                {isActive && (
                                    <div className="library-model-row__progress">
                                        <div className="library-progress__label">
                                            <span>Downloading...</span>
                                            <span>{pct !== null ? `${pct}%` : `${formatBytes(prog.bytes)}`}</span>
                                        </div>
                                        <div className="library-progress__track library-progress__track--compact">
                                            <div className="library-progress__fill" data-state="partial" style={{ width: pct !== null ? `${pct}%` : '0%' }} />
                                        </div>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </section>

            {promptDialog && (
                <PromptModal
                    title={promptDialog.title}
                    label={promptDialog.label}
                    placeholder={promptDialog.placeholder}
                    onSubmit={promptDialog.onSubmit}
                    onCancel={() => setPromptDialog(null)}
                />
            )}
            {confirmDialog && (
                <ConfirmModal
                    title={confirmDialog.title}
                    message={confirmDialog.message}
                    confirmLabel={confirmDialog.confirmLabel}
                    onConfirm={confirmDialog.onConfirm}
                    onCancel={() => setConfirmDialog(null)}
                />
            )}
        </div>
    );
};
