import React, { useState, useEffect, useCallback } from 'react';
import { usePlayerStore } from '../../store/index';
import { ConfirmModal } from '../ConfirmModal';

export const GenreMatrixTab: React.FC = () => {
    const genreMatrixLastRun = usePlayerStore(state => state.genreMatrixLastRun);
    const genreMatrixLastResult = usePlayerStore(state => state.genreMatrixLastResult);
    const genreMatrixProgress = usePlayerStore(state => state.genreMatrixProgress);
    const setSettings = usePlayerStore(state => state.setSettings);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const loadSettings = usePlayerStore(state => state.loadSettings);
    const library = usePlayerStore(state => state.library);

    const [isRunningMatrix, setIsRunningMatrix] = useState(false);
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
    const [mappings, setMappings] = useState<Record<string, string>>({});

    const fetchMappings = useCallback(async () => {
        try {
            const authHeaders = getAuthHeader();
            const res = await fetch('/api/genre-matrix/mappings', { headers: authHeaders });
            if (res.ok) setMappings(await res.json());
        } catch(e) { console.error('Failed to fetch mappings', e); }
    }, [getAuthHeader]);

    useEffect(() => {
        fetchMappings();
    }, [fetchMappings]);

    // 2. Initialize/Sync isRunningMatrix based on progress string
    useEffect(() => {
        const isActive = !!genreMatrixProgress && 
                         genreMatrixProgress !== 'Complete' && 
                        !genreMatrixProgress.startsWith('Error') &&
                        !genreMatrixProgress.startsWith('Interrupted') &&
                        !genreMatrixProgress.startsWith('All genres');
        setIsRunningMatrix(isActive);
    }, [genreMatrixProgress]);

    // 3. Poll while progress is active
    useEffect(() => {
        let interval: any;
        if (isRunningMatrix) {
            interval = setInterval(() => {
                loadSettings();
                fetchMappings();
            }, 2000);
        }
        return () => clearInterval(interval);
    }, [isRunningMatrix, loadSettings, fetchMappings]);

    // Auto-disable isRunningMatrix when progress is "Complete"
    useEffect(() => {
        if (genreMatrixProgress === 'Complete' || 
            (genreMatrixProgress && (genreMatrixProgress.startsWith('Error') || genreMatrixProgress.startsWith('Interrupted')))
        ) {
            setIsRunningMatrix(false);
        }
    }, [genreMatrixProgress]);

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
        setConfirmDialog({
            title: 'Remap All Genres',
            message: 'This will clear ALL existing genre mappings and re-categorize your entire library into the new 39-genre ontology.',
            confirmLabel: 'Remap All',
            onConfirm: async () => {
                setConfirmDialog(null);
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
            },
        });
    };

    const distinctGenres = Array.from(new Set(library.map(t => (t.genre || '').toLowerCase().trim()).filter(Boolean)));
    const mappedCount = distinctGenres.filter(g => mappings[g.toLowerCase().replace(/[^\w\s-]/g, '')]).length;
    const coveragePercent = distinctGenres.length > 0 ? Math.round((mappedCount / distinctGenres.length) * 100) : 100;

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-2">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Genre Transition Matrix</h3>
            </div>
            <p className="text-sm text-[var(--color-text-muted)] mb-6">
                Maps hop costs between genres, powering Infinity Mode and Hub generation.
            </p>

            <div className="flex items-center gap-2 mb-6">
                <button
                    onClick={handleRunMatrix}
                    disabled={isRunningMatrix}
                    className="btn btn-primary disabled:opacity-50 flex items-center justify-center gap-2"
                >
                    {isRunningMatrix && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                    {isRunningMatrix ? (genreMatrixProgress?.replace('Categorizing ', '') || 'Running...') : 'Incremental Run'}
                </button>
                <button
                    onClick={handleRemapAll}
                    disabled={isRunningMatrix}
                    className="btn btn-danger disabled:opacity-50"
                >
                    Remap Library
                </button>
            </div>

            <div className="flex flex-col gap-2 text-sm p-4 rounded-2xl bg-[var(--color-surface)] border border-[var(--glass-border)]">
                <div className="flex justify-between items-center border-b border-[var(--glass-border)] pb-3">
                    <span className="text-[var(--color-text-secondary)]">Last Run</span>
                    <span className="text-[var(--color-text-primary)] font-medium">
                        {genreMatrixLastRun ? new Date(genreMatrixLastRun).toLocaleString() : 'Never'}
                    </span>
                </div>
                <div className="flex justify-between items-center border-b border-[var(--glass-border)] pb-3 pt-1">
                    <span className="text-[var(--color-text-secondary)]">Last Result</span>
                    <span className="text-[var(--color-text-primary)] font-medium truncate max-w-[200px]" title={genreMatrixLastResult || 'N/A'}>
                        {genreMatrixLastResult || 'N/A'}
                    </span>
                </div>
                <div className="flex justify-between items-center pt-1">
                    <span className="text-[var(--color-text-secondary)]">Library Coverage</span>
                    <div className="flex flex-col items-end gap-1">
                        <span className="text-[var(--color-text-primary)] font-bold">{coveragePercent}%</span>
                        <div className="w-24 h-1.5 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-[var(--color-primary)] transition-all duration-500"
                                style={{ width: `${coveragePercent}%` }}
                            />
                        </div>
                    </div>
                </div>
            </div>

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
