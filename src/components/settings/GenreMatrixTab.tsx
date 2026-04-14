import React, { useState, useEffect, useCallback } from 'react';
import { usePlayerStore } from '../../store/index';
import { ConfirmModal } from '../ConfirmModal';
import { DependencyBadge, DependencyGroup, DependencyInfoBox } from '../DependencyBadge';
import { Database, Sparkles, AlertTriangle, ArrowRight, Library } from 'lucide-react';

interface MbdbImportInfo {
    timestamp: number;
    duration: number;
    counts: { genres: number; aliases: number; links: number };
}

export const GenreMatrixTab: React.FC = () => {
    const genreMatrixLastRun = usePlayerStore(state => state.genreMatrixLastRun);
    const genreMatrixLastResult = usePlayerStore(state => state.genreMatrixLastResult);
    const genreMatrixProgress = usePlayerStore(state => state.genreMatrixProgress);
    const llmConnected = usePlayerStore(state => state.llmConnected);
    const storeMbdbLastImported = usePlayerStore(state => state.mbdbLastImported);
    const setSettings = usePlayerStore(state => state.setSettings);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const loadSettings = usePlayerStore(state => state.loadSettings);
    const library = usePlayerStore(state => state.library);

    // Local state for MBDB to ensure we have fresh data
    const [mbdbLastImported, setMbdbLastImported] = useState<MbdbImportInfo | null>(storeMbdbLastImported);

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

    // Directly fetch MBDB status from admin endpoint (same as DatabaseTab)
    const fetchMbdbStatus = useCallback(async () => {
        try {
            const authHeaders = getAuthHeader();
            const res = await fetch('/api/admin/mbdb/check-update', { headers: authHeaders });
            if (res.ok) {
                const data = await res.json();
                if (data.lastImport) {
                    setMbdbLastImported(data.lastImport);
                }
            }
        } catch(e) { console.error('Failed to fetch MBDB status', e); }
    }, [getAuthHeader]);

    // Refresh settings on mount to get latest MBDB status
    useEffect(() => {
        loadSettings();
        fetchMappings();
        fetchMbdbStatus();
    }, [loadSettings, fetchMappings, fetchMbdbStatus]);

    useEffect(() => {
        const isActive = !!genreMatrixProgress && 
                         genreMatrixProgress !== 'Complete' && 
                        !genreMatrixProgress.startsWith('Error') &&
                        !genreMatrixProgress.startsWith('Interrupted') &&
                        !genreMatrixProgress.startsWith('All genres');
        setIsRunningMatrix(isActive);
    }, [genreMatrixProgress]);

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

    useEffect(() => {
        if (genreMatrixProgress === 'Complete' || 
            (genreMatrixProgress && (genreMatrixProgress.startsWith('Error') || genreMatrixProgress.startsWith('Interrupted')))
        ) {
            setIsRunningMatrix(false);
        }
    }, [genreMatrixProgress]);

    const handleRunMatrix = async () => {
        if (!llmConnected) return;
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
        if (!llmConnected) return;
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
    const hasLibrary = library.length > 0;

    // Dependency status calculation
    const llmStatus = llmConnected ? 'available' : 'unavailable';
    const mbdbStatus = mbdbLastImported ? 'available' : 'unavailable';
    const libraryStatus = hasLibrary ? 'available' : 'unavailable';

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-2">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Genre Transition Matrix</h3>
            </div>
            <p className="text-sm text-[var(--color-text-muted)] mb-6">
                Maps hop costs between genres, powering Infinity Mode and Hub generation.
            </p>

            {/* Dependency Status Section */}
            <div className="mb-6 space-y-4">
                <DependencyGroup title="Dependencies">
                    <DependencyBadge
                        label="LLM Connection"
                        status={llmStatus}
                        message={llmConnected ? 'Connected & ready for categorization' : 'Required for genre mapping'}
                        actionLabel={!llmConnected ? 'Configure in GenAI tab' : undefined}
                        onAction={!llmConnected ? () => {
                            const tab = document.querySelector('[data-settings-tab="genai"]') as HTMLElement;
                            if (tab) tab.click();
                        } : undefined}
                    />
                    <DependencyBadge
                        label="MusicBrainz Database"
                        status={mbdbStatus}
                        message={mbdbLastImported 
                            ? `Imported ${mbdbLastImported.counts.genres.toLocaleString()} genres` 
                            : 'Optional - improves mapping accuracy'}
                        actionLabel={!mbdbLastImported ? 'Import in Database tab' : undefined}
                        onAction={!mbdbLastImported ? () => {
                            const tab = document.querySelector('[data-settings-tab="database"]') as HTMLElement;
                            if (tab) tab.click();
                        } : undefined}
                    />
                    <DependencyBadge
                        label="Library"
                        status={libraryStatus}
                        message={hasLibrary 
                            ? `${library.length.toLocaleString()} tracks ready for mapping` 
                            : 'Run a library scan first'}
                    />
                </DependencyGroup>

                {!llmConnected && (
                    <DependencyInfoBox
                        title="LLM Required"
                        description="The Genre Matrix uses AI to categorize unknown genres. Please configure and test your LLM connection in the GenAI tab before running the matrix."
                        icon={<AlertTriangle className="w-5 h-5" />}
                    />
                )}

                {hasLibrary && !genreMatrixLastRun && (
                    <DependencyInfoBox
                        title="Run After Scan"
                        description="After scanning your library, run the Genre Matrix to map your genres to the MusicBrainz taxonomy. This enables genre-aware recommendations in Infinity Mode and Hub playlists."
                        icon={<Sparkles className="w-5 h-5" />}
                    />
                )}
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-2 mb-6">
                <button
                    onClick={handleRunMatrix}
                    disabled={isRunningMatrix || !llmConnected}
                    className="btn btn-primary disabled:opacity-50 flex items-center justify-center gap-2"
                >
                    {isRunningMatrix && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                    {isRunningMatrix ? (genreMatrixProgress?.replace('Categorizing ', '') || 'Running...') : 'Incremental Run'}
                </button>
                <button
                    onClick={handleRemapAll}
                    disabled={isRunningMatrix || !llmConnected}
                    className="btn btn-danger disabled:opacity-50"
                >
                    Remap Library
                </button>
            </div>

            {/* Stats Display */}
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

            {/* Feature Info */}
            <div className="mt-6 p-4 rounded-xl bg-gradient-to-r from-[var(--color-primary)]/5 to-transparent border border-[var(--color-primary)]/10">
                <h4 className="text-sm font-semibold text-[var(--color-primary)] mb-2">How it works</h4>
                <ul className="text-xs text-[var(--color-text-muted)] space-y-1.5">
                    <li className="flex items-start gap-2">
                        <span className="text-[var(--color-primary)]">•</span>
                        Maps your local genres to MusicBrainz hierarchical taxonomy
                    </li>
                    <li className="flex items-start gap-2">
                        <span className="text-[var(--color-primary)]">•</span>
                        Calculates "hop cost" between genres for smooth transitions
                    </li>
                    <li className="flex items-start gap-2">
                        <span className="text-[var(--color-primary)]">•</span>
                        Powers Infinity Mode genre-aware track selection
                    </li>
                    <li className="flex items-start gap-2">
                        <span className="text-[var(--color-primary)]">•</span>
                        Enables Hub playlist genre diversity re-ranking
                    </li>
                </ul>
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