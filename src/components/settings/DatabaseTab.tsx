import React, { useState, useCallback } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { DatabaseControl } from '../DatabaseControl';
import { DatabaseBackups } from './DatabaseBackups';
import { ConfirmModal } from '../ConfirmModal';
import { BarChart2, Wrench, HardDriveDownload, Trash2 } from 'lucide-react';

export const DatabaseTab: React.FC = () => {
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    
    const { addToast } = useToast();
    const showToast = useCallback((msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type), [addToast]);

    const [dbTab, setDbTab] = useState<'stats' | 'maintenance' | 'backups'>('stats');
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);

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
                <button onClick={() => setDbTab('backups')} className={`btn-tab ${dbTab === 'backups' ? 'active' : ''}`}>
                    <HardDriveDownload size={16} className="inline mr-1 relative -top-[1px]" /> Backups
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

            {dbTab === 'backups' && <DatabaseBackups />}

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
