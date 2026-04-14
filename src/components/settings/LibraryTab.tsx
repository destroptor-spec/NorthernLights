import React, { useState, useCallback, useEffect, useRef } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { Folder, Trash2, Download, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { PromptModal } from '../PromptModal';
import { ConfirmModal } from '../ConfirmModal';

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

    const [dirStats, setDirStats] = useState<Record<string, { totalTracks: number; withMetadata: number; analyzed: number }>>({});
    const [dirStatsLoading, setDirStatsLoading] = useState(false);

    const [modelStatus, setModelStatus] = useState<ModelFileStatus[]>([]);
    const [modelDownloadProgress, setModelDownloadProgress] = useState<Record<string, { bytes: number; total: number; status: string }>>({});
    const [isModelDownloading, setIsModelDownloading] = useState(false);
    const modelSseRef = useRef<EventSource | null>(null);
    
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
            const statsMap: Record<string, { totalTracks: number; withMetadata: number; analyzed: number }> = {};
            for (const d of data.directories || []) {
                statsMap[d.path] = { totalTracks: d.totalTracks, withMetadata: d.withMetadata, analyzed: d.analyzed };
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
            const sse = new EventSource('/api/settings/models/progress');
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
    }, [getAuthHeader, fetchModelStatus]);

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
        }
        prevIsScanning.current = isScanning;
    }, [isScanning, fetchDirStats]);



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
        } catch (e) {}
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
                } catch (e) {}
            },
        });
    };

    return (
        <div className="settings-section mb-8">

                    <div className="settings-section-header flex justify-between items-center mb-4">
                        <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Mapped Folders</h3>
                        <button className="btn btn-sm" onClick={handleAddFolder}>+ Map Folder Path</button>
                    </div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-4">Folders mapped here will be automatically scanned.</p>
                    <ul className="flex flex-col gap-3">
                        {libraryFolders.length === 0 ? (
                            <li className="p-4 rounded-xl border border-dashed border-[var(--glass-border)] bg-[var(--glass-bg)] text-center text-sm text-[var(--color-text-muted)] backdrop-blur-sm">No folders mapped yet.</li>
                        ) : (
                            libraryFolders.map((folderPath) => {
                                const stats = dirStats[folderPath];
                                return (
                                    <li key={folderPath} className="p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-sm backdrop-blur-sm">
                                        <div className="flex justify-between items-center mb-2">
                                            <span className="text-sm truncate mr-4 text-[var(--color-text-primary)] font-medium flex items-center gap-2"><Folder size={16} className="shrink-0 text-[var(--color-text-muted)]" /> {folderPath}</span>
                                            <div className="flex gap-2 shrink-0">
                                                <button className="btn btn-primary btn-sm" onClick={() => handleRescanFolder(folderPath)}>Rescan</button>
                                                <button className="btn btn-ghost btn-sm" onClick={() => handleRefreshMetadata(folderPath)} disabled={isScanning}>Refresh Metadata</button>
                                                <button className="btn btn-danger-fill btn-sm" onClick={() => handleRemoveFolder(folderPath)}>Remove</button>
                                            </div>
                                        </div>
                                        {stats && stats.totalTracks > 0 && (
                                            <div className="flex gap-4 text-xs text-[var(--color-text-secondary)] pl-1">
                                                <span>{stats.totalTracks} tracks</span><span>·</span><span>{stats.withMetadata} with metadata</span><span>·</span>
                                                <span className={stats.analyzed === stats.totalTracks ? 'text-green-600 dark:text-green-500' : 'text-amber-600 dark:text-amber-500'}>{stats.analyzed} analyzed</span>
                                            </div>
                                        )}
                                        {stats && stats.totalTracks === 0 && (<div className="text-xs text-[var(--color-text-muted)] pl-1">No tracks found. Click Rescan to index this folder.</div>)}
                                    </li>
                                );
                            })
                        )}
                    </ul>
                    <div className="mt-4 flex items-center justify-between p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)]">
                        <div>
                            <p className="text-sm font-medium text-[var(--color-text-primary)]">Automatic Folder Walk</p>
                            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Re-walk all folders every 30 minutes to detect renamed or deleted files.</p>
                        </div>
                        <button onClick={() => setSettings({ autoFolderWalk: !autoFolderWalk })} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ml-4 ${autoFolderWalk ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}>
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${autoFolderWalk ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                    </div>
                    <div className="mt-6 pt-4 border-t border-[var(--glass-border)]">
                        <div className="flex justify-between items-center mb-3">
                            <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">Audio Analysis</h4>
                            <div className="flex gap-2">
                                <button className="btn btn-primary btn-sm" onClick={handleAnalyze} disabled={isScanning}>{isScanning ? 'Analyzing...' : 'Analyze Missing'}</button>
                                <button className="btn btn-ghost btn-sm" onClick={handleForceAnalyze} disabled={isScanning}>Re-analyze All</button>
                            </div>
                        </div>
                        <p className="text-xs text-[var(--color-text-muted)]">Runs native Essentia audio feature extraction on tracks that haven't been analyzed yet. Requires ML models below.</p>
                        {(() => {
                            const totalStats = Object.values(dirStats).reduce((acc, s) => ({ totalTracks: acc.totalTracks + s.totalTracks, withMetadata: acc.withMetadata + s.withMetadata, analyzed: acc.analyzed + s.analyzed }), { totalTracks: 0, withMetadata: 0, analyzed: 0 });
                            if (dirStatsLoading) { return (<div className="mt-2"><div className="flex justify-between text-xs text-[var(--color-text-secondary)] mb-1"><span>Library Coverage</span><span className="animate-pulse">Loading...</span></div><div className="w-full h-2 rounded-full bg-[var(--glass-border)] overflow-hidden" /></div>); }
                            if (totalStats.totalTracks === 0) return null;
                            const pct = Math.round((totalStats.analyzed / totalStats.totalTracks) * 100);
                            return (<div className="mt-2"><div className="flex justify-between text-xs text-[var(--color-text-secondary)] mb-1"><span>Library Coverage</span><span>{totalStats.analyzed} / {totalStats.totalTracks} tracks ({pct}%)</span></div><div className="w-full h-2 rounded-full bg-[var(--glass-border)] overflow-hidden"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#22c55e' : pct > 50 ? '#f59e0b' : '#ef4444' }} /></div></div>);
                        })()}
                    </div>

                    {/* ML Models */}
                    <div className="mt-6 pt-4 border-t border-[var(--glass-border)]">
                        <div className="flex justify-between items-center mb-3">
                            <div>
                                <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">ML Models</h4>
                                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Discogs-EffNet (1280D) and MusiCNN (.pb) files used by the Python extractor.</p>
                            </div>
                            <button
                                className="btn btn-primary btn-sm flex items-center gap-1.5"
                                onClick={handleDownloadModels}
                                disabled={isModelDownloading}
                            >
                                {isModelDownloading
                                    ? <><Loader2 size={13} className="animate-spin" /> Downloading...</>
                                    : <><Download size={13} /> {modelStatus.every(m => m.cached) ? 'Re-download' : 'Download Models'}</>
                                }
                            </button>
                        </div>
                        <ul className="flex flex-col gap-2">
                            {modelStatus.length === 0 ? (
                                <li className="text-xs text-[var(--color-text-muted)] italic">Checking model status...</li>
                            ) : modelStatus.map(m => {
                                const prog = modelDownloadProgress[m.filename];
                                const isActive = prog && prog.status === 'downloading';
                                const pct = isActive && prog.total > 0 ? Math.round((prog.bytes / prog.total) * 100) : null;
                                return (
                                    <li key={m.filename} className="flex flex-col gap-1 p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)]">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                {m.cached
                                                    ? <CheckCircle2 size={14} className="text-green-500 shrink-0" />
                                                    : <AlertCircle size={14} className="text-amber-500 shrink-0" />
                                                }
                                                <span className="text-sm font-medium text-[var(--color-text-primary)]">{m.name}</span>
                                                <span className="text-xs text-[var(--color-text-muted)] font-mono">{m.filename}</span>
                                            </div>
                                            <span className="text-xs text-[var(--color-text-secondary)] shrink-0 ml-2">
                                                {m.cached ? formatBytes(m.size) : 'Not downloaded'}
                                            </span>
                                        </div>
                                        {isActive && (
                                            <div className="mt-1">
                                                <div className="flex justify-between text-xs text-[var(--color-text-muted)] mb-0.5">
                                                    <span>Downloading...</span>
                                                    <span>{pct !== null ? `${pct}%` : `${formatBytes(prog.bytes)}`}</span>
                                                </div>
                                                <div className="w-full h-1.5 rounded-full bg-[var(--glass-border)] overflow-hidden">
                                                    <div className="h-full rounded-full bg-[var(--color-primary)] transition-all duration-300" style={{ width: pct !== null ? `${pct}%` : '0%' }} />
                                                </div>
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>

            
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
