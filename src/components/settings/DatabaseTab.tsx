import React, { useState, useEffect, useCallback } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { DatabaseControl } from '../DatabaseControl';
import { ConfirmModal } from '../ConfirmModal';
import { BarChart2, Wrench, Globe, AlertCircle, Clock, Database, Check, ArrowRight, Trash2, X } from 'lucide-react';

export const DatabaseTab: React.FC = () => {
    const authToken = usePlayerStore(state => state.authToken);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    
    const { addToast } = useToast();
    const showToast = useCallback((msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type), [addToast]);

    const [dbTab, setDbTab] = useState<'stats' | 'maintenance' | 'mbdb'>('stats');
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);

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
    
    const [mbdbUpdateLoading, setMbdbUpdateLoading] = useState(false);

    const fetchMbdbUpdateInfo = useCallback(async () => {
        if (!authToken) return;
        setMbdbUpdateLoading(true);
        try {
            const res = await fetch('/api/admin/mbdb/check-update', { headers: getAuthHeader() });
            if (res.ok) {
                const data = await res.json();
                setMbdbUpdateInfo(data);
            }
        } catch (e) {
            console.error('Failed to fetch MBDB update info', e);
        } finally {
            setMbdbUpdateLoading(false);
        }
    }, [authToken, getAuthHeader]);

    useEffect(() => {
        if (dbTab === 'mbdb' && authToken) {
            fetchMbdbUpdateInfo();
            const es = new EventSource('/api/admin/mbdb/status?token=' + authToken);
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
    }, [dbTab, authToken, fetchMbdbUpdateInfo]);

    const handleMbdbImport = async () => {
        setConfirmDialog({
            title: 'Start MusicBrainz Import',
            message: 'This will stream the MusicBrainz database dump (~3.5GB) to extract taxonomy. This process can take several minutes depending on network speed.',
            confirmLabel: 'Start Import',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    const res = await fetch('/api/admin/mbdb/import', { method: 'POST', headers: getAuthHeader() });
                    if (!res.ok) throw new Error(await res.text());
                } catch(e) {
                    showToast('Failed to start import', 'error');
                }
            }
        });
    };

    const handleMbdbCancel = async () => {
        try {
            const res = await fetch('/api/admin/mbdb/cancel', { method: 'POST', headers: getAuthHeader() });
            if (!res.ok) throw new Error(await res.text());
        } catch(e) {
            showToast('Failed to cancel import', 'error');
        }
    };

    const handleCleanupPlaylists = async () => {
        setConfirmDialog({
            title: 'Clean Orphaned Playlists',
            message: 'This will permanently delete any playlists that do not belong to a valid user. This action cannot be undone.',
            confirmLabel: 'Clean Up',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    const authHeaders = getAuthHeader();
                    const res = await fetch('/api/admin/cleanup-playlists', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders }
                    });
                    let data: any = {};
                    try { data = await res.json(); } catch {}
                    if (res.ok) {
                        showToast(`Cleanup complete. Deleted ${data.deletedCount} orphaned playlist(s).`, 'success');
                    } else {
                        showToast(data.error || `Server error: ${res.status}`, 'error');
                    }
                } catch(e) {
                    showToast('Failed to connect to server', 'error');
                }
            },
        });
    };

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Database Management</h3>
            </div>

            <div className="flex gap-2 mb-6">
                <button onClick={() => setDbTab('stats')} className={`btn-tab ${dbTab === 'stats' ? 'active' : ''}`}>
                    <BarChart2 size={16} className="inline mr-1 relative -top-[1px]" /> Stats
                </button>
                <button onClick={() => setDbTab('maintenance')} className={`btn-tab ${dbTab === 'maintenance' ? 'active' : ''}`}>
                    <Wrench size={16} className="inline mr-1 relative -top-[1px]" /> Maintenance
                </button>
                <button onClick={() => setDbTab('mbdb')} className={`btn-tab ${dbTab === 'mbdb' ? 'active' : ''}`}>
                    <Globe size={16} className="inline mr-1 relative -top-[1px]" /> MBDB
                </button>
            </div>

            {dbTab === 'stats' && (
                <div className="space-y-3">
                    <p className="text-sm text-[var(--color-text-muted)] mb-4">
                        Manage your PostgreSQL container instance and monitor its health.
                    </p>
                    <DatabaseControl inline={true} variant="stats" />
                </div>
            )}

            {dbTab === 'maintenance' && (
                <div className="space-y-4">
                    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--glass-border)] p-4">
                        <div className="flex justify-between items-center mb-4">
                            <div>
                                <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">Maintenance</h4>
                                <p className="text-sm text-[var(--color-text-muted)]">Clean up orphaned playlists and optimize database storage.</p>
                            </div>
                        </div>
                        <button onClick={handleCleanupPlaylists} className="btn btn-danger">
                            <Trash2 size={16} /> Clean Orphaned Playlists
                        </button>
                    </div>
                </div>
            )}

            {dbTab === 'mbdb' && (
                <div className="space-y-4">
                    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--glass-border)] p-4">
                        <div className="flex justify-between items-center mb-4">
                            <div>
                                <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">MusicBrainz Taxonomy Database</h4>
                                <p className="text-sm text-[var(--color-text-muted)]">Import the latest comprehensive genre taxonomy straight from the official MusicBrainz database dumps.</p>
                            </div>
                        </div>
                        
                        {!mbdbProgress.isImporting ? (
                            <div className="flex flex-col gap-3">
                                {mbdbProgress.phase === 'complete' && (
                                    <div className="text-green-500 font-medium text-sm flex items-center gap-2">✓ Last Import Successful. Tree paths cached.</div>
                                )}
                                {mbdbProgress.phase === 'error' && (
                                    <div className="text-red-500 font-medium text-sm flex items-center gap-2">
                                        <AlertCircle size={16} /> {mbdbProgress.message}
                                    </div>
                                )}
                                
                                {mbdbUpdateInfo && !mbdbUpdateLoading && (
                                    <div className="bg-black/5 dark:bg-white/5 rounded-lg p-3 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide">Update Status</span>
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
                                {mbdbUpdateLoading && (
                                    <div className="text-xs text-[var(--color-text-muted)]">Checking for updates...</div>
                                )}
                                
                                {(mbdbProgress.lastImport || mbdbUpdateInfo?.lastImport) && (
                                    <div className="bg-black/5 dark:bg-white/5 rounded-lg p-3 space-y-1">
                                        <div className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide">Last Import</div>
                                        <div className="flex items-center gap-4 text-sm">
                                            <span className="flex items-center gap-1">
                                                <Clock size={14} className="text-[var(--color-text-muted)]" />
                                                {Math.round(((mbdbProgress.lastImport || mbdbUpdateInfo?.lastImport)?.duration ?? 0) / 60)}min
                                            </span>
                                            <span>{((mbdbProgress.lastImport || mbdbUpdateInfo?.lastImport)?.counts?.genres ?? 0).toLocaleString()} genres</span>
                                        </div>
                                    </div>
                                )}
                                
                                <button 
                                    onClick={handleMbdbImport}
                                    className="btn btn-primary self-start"
                                    disabled={mbdbUpdateInfo?.updateAvailable === false}
                                >
                                    <Database size={16} /> {mbdbUpdateInfo?.updateAvailable === false ? 'Already Up to Date' : 'Sync MBDB Now'}
                                </button>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="h-1 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                                    <div className="h-full bg-[var(--color-primary)] animate-pulse rounded-full" />
                                </div>
                                <div className="space-y-2">
                                    {mbdbProgress.completedPhases?.map((phase, i) => (
                                        <div key={i} className="flex items-center gap-2 text-sm text-green-500">
                                            <Check size={14} className="flex-shrink-0" /> 
                                            <span className="break-all">{phase}</span>
                                        </div>
                                    ))}
                                    {mbdbProgress.phase !== 'complete' && mbdbProgress.phase !== 'error' && (
                                        <div className="flex items-center gap-2 text-sm">
                                            <ArrowRight size={14} className="animate-pulse flex-shrink-0 text-[var(--color-primary)]" /> 
                                            <span className="break-all text-[var(--color-text-primary)]">{mbdbProgress.message}</span>
                                        </div>
                                    )}
                                </div>
                                <button onClick={handleMbdbCancel} className="btn btn-danger w-full">
                                    <X size={16} /> Cancel Import
                                </button>
                            </div>
                        )}
                    </div>
                </div>
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
