import React, { useState, useCallback, useEffect, useRef } from 'react';
import { usePlayerStore } from '../../store/index';
import { useProviderConnectionTest } from '../../hooks/useProviderConnectionTest';
import { useToast } from '../../hooks/useToast';
import { Folder, Link, Search, Globe, Trash2 } from 'lucide-react';
import { PromptModal } from '../PromptModal';
import { ConfirmModal } from '../ConfirmModal';

export const LibraryTab: React.FC = () => {
    const libraryFolders = usePlayerStore(state => state.libraryFolders);
    const addLibraryFolder = usePlayerStore(state => state.addLibraryFolder);
    const removeLibraryFolder = usePlayerStore(state => state.removeLibraryFolder);
    
    const lastFmApiKey = usePlayerStore(state => state.lastFmApiKey);
    const setLastFmApiKey = usePlayerStore(state => state.setLastFmApiKey);
    const lastFmSharedSecret = usePlayerStore(state => state.lastFmSharedSecret);
    const setLastFmSharedSecret = usePlayerStore(state => state.setLastFmSharedSecret);
    const lastFmScrobbleEnabled = usePlayerStore(state => state.lastFmScrobbleEnabled);
    const setLastFmScrobbleEnabled = usePlayerStore(state => state.setLastFmScrobbleEnabled);
    const lastFmConnected = usePlayerStore(state => state.lastFmConnected);
    const setLastFmConnected = usePlayerStore(state => state.setLastFmConnected);
    const lastFmUsername = usePlayerStore(state => state.lastFmUsername);
    const setLastFmUsername = usePlayerStore(state => state.setLastFmUsername);
    
    const geniusApiKey = usePlayerStore(state => state.geniusApiKey);
    const setGeniusApiKey = usePlayerStore(state => state.setGeniusApiKey);
    
    const musicBrainzEnabled = usePlayerStore(state => state.musicBrainzEnabled);
    const setMusicBrainzEnabled = usePlayerStore(state => state.setMusicBrainzEnabled);
    const musicBrainzClientId = usePlayerStore(state => state.musicBrainzClientId);
    const setMusicBrainzClientId = usePlayerStore(state => state.setMusicBrainzClientId);
    const musicBrainzClientSecret = usePlayerStore(state => state.musicBrainzClientSecret);
    const setMusicBrainzClientSecret = usePlayerStore(state => state.setMusicBrainzClientSecret);
    const musicBrainzConnected = usePlayerStore(state => state.musicBrainzConnected);
    const setMusicBrainzConnected = usePlayerStore(state => state.setMusicBrainzConnected);
    
    const providerArtistImage = usePlayerStore(state => state.providerArtistImage);
    const providerArtistBio = usePlayerStore(state => state.providerArtistBio);
    const providerAlbumArt = usePlayerStore(state => state.providerAlbumArt);
    
    const setSettings = usePlayerStore(state => state.setSettings);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);
    const isScanning = usePlayerStore(state => state.isScanning);
    const autoFolderWalk = usePlayerStore(state => state.autoFolderWalk);
    const authToken = usePlayerStore(state => state.authToken);

    const [libTab, setLibTab] = useState<'folders' | 'lastfm' | 'genius' | 'musicbrainz'>('folders');
    const [lastFmConfigured, setLastFmConfigured] = useState(false);
    
    const [dirStats, setDirStats] = useState<Record<string, { totalTracks: number; withMetadata: number; analyzed: number }>>({});
    const [dirStatsLoading, setDirStatsLoading] = useState(false);
    
    const [promptDialog, setPromptDialog] = useState<{ title: string; label?: string; placeholder?: string; onSubmit: (value: string) => void } | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
    
    const { addToast } = useToast();
    const showToast = useCallback((msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type), [addToast]);

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

    const prevIsScanning = useRef(isScanning);
    useEffect(() => {
        if (prevIsScanning.current && !isScanning) {
            fetchDirStats();
        }
        prevIsScanning.current = isScanning;
    }, [isScanning, fetchDirStats]);

    useEffect(() => {
        const fetchLastFmStatus = async () => {
            try {
                const res = await fetch('/api/providers/lastfm/status', { headers: getAuthHeader() });
                if (res.ok) {
                    const data = await res.json();
                    setLastFmConfigured(!!data.hasApiKey);
                }
            } catch {}
        };
        fetchLastFmStatus();
    }, [getAuthHeader]);

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
            <div className="flex gap-2 mb-6">
                <button onClick={() => setLibTab('folders')} className={`btn-tab ${libTab === 'folders' ? 'active' : ''}`}>
                    <Folder size={16} className="inline mr-1 relative -top-[1px]" /> Folders
                </button>
                <button onClick={() => setLibTab('lastfm')} className={`btn-tab ${libTab === 'lastfm' ? 'active' : ''}`}>
                    <Link size={16} className="inline mr-1 relative -top-[1px]" /> Last.fm
                </button>
                <button onClick={() => setLibTab('genius')} className={`btn-tab ${libTab === 'genius' ? 'active' : ''}`}>
                    <Search size={16} className="inline mr-1 relative -top-[1px]" /> Genius
                </button>
                <button onClick={() => setLibTab('musicbrainz')} className={`btn-tab ${libTab === 'musicbrainz' ? 'active' : ''}`}>
                    <Globe size={16} className="inline mr-1 relative -top-[1px]" /> MusicBrainz
                </button>
            </div>

            {libTab === 'folders' && (
                <>
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
                                                <button className="btn btn-danger-fill btn-sm" onClick={() => handleRemoveFolder(folderPath)}>Remove</button>
                                            </div>
                                        </div>
                                        {stats && stats.totalTracks > 0 && (
                                            <div className="flex gap-4 text-xs text-[var(--color-text-secondary)] pl-1">
                                                <span>{stats.totalTracks} tracks</span><span>·</span><span>{stats.withMetadata} with metadata</span><span>·</span>
                                                <span className={stats.analyzed === stats.totalTracks ? 'text-green-500' : 'text-amber-500'}>{stats.analyzed} analyzed</span>
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
                        <button onClick={() => setSettings({ autoFolderWalk: !autoFolderWalk })} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ml-4 ${autoFolderWalk ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-bg-tertiary)]'}`}>
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
                        <p className="text-xs text-[var(--color-text-muted)]">Runs Essentia audio feature extraction on tracks that haven't been analyzed yet.</p>
                        {(() => {
                            const totalStats = Object.values(dirStats).reduce((acc, s) => ({ totalTracks: acc.totalTracks + s.totalTracks, withMetadata: acc.withMetadata + s.withMetadata, analyzed: acc.analyzed + s.analyzed }), { totalTracks: 0, withMetadata: 0, analyzed: 0 });
                            if (dirStatsLoading) { return (<div className="mt-2"><div className="flex justify-between text-xs text-[var(--color-text-secondary)] mb-1"><span>Library Coverage</span><span className="animate-pulse">Loading...</span></div><div className="w-full h-2 rounded-full bg-[var(--glass-border)] overflow-hidden" /></div>); }
                            if (totalStats.totalTracks === 0) return null;
                            const pct = Math.round((totalStats.analyzed / totalStats.totalTracks) * 100);
                            return (<div className="mt-2"><div className="flex justify-between text-xs text-[var(--color-text-secondary)] mb-1"><span>Library Coverage</span><span>{totalStats.analyzed} / {totalStats.totalTracks} tracks ({pct}%)</span></div><div className="w-full h-2 rounded-full bg-[var(--glass-border)] overflow-hidden"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#22c55e' : pct > 50 ? '#f59e0b' : '#ef4444' }} /></div></div>);
                        })()}
                    </div>
                </>
            )}

            {libTab === 'lastfm' && (
                <div className="flex flex-col gap-5">
                    <div><h3 className="text-lg font-bold text-[var(--color-text-primary)] mb-1">Last.fm</h3></div>
                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 flex flex-col gap-3">
                        <input type="text" value={lastFmApiKey} onChange={e => setLastFmApiKey(e.target.value)} placeholder="API Key" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                        <input type="password" value={lastFmSharedSecret} onChange={e => setLastFmSharedSecret(e.target.value)} placeholder="Shared Secret" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                        <div className="flex items-center gap-3">
                            <button onClick={() => testLastFm(lastFmApiKey)} disabled={lastFmStatus === 'testing' || !lastFmApiKey} className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50">{lastFmStatus === 'testing' ? 'Testing...' : 'Test'}</button>
                            {lastFmStatus === 'success' && <span className="text-green-500 font-semibold text-xs">✓ {lastFmMessage}</span>}
                            {lastFmStatus === 'error' && <span className="text-red-500 font-semibold text-xs">✗ {lastFmMessage}</span>}
                        </div>
                    </div>
                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5">
                        <h4 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">Scrobbling</h4>
                        {lastFmConnected ? (
                            <div className="flex flex-col gap-4">
                                <div className="flex items-center justify-between">
                                    <span className="text-green-500 font-semibold text-sm">Connected as {lastFmUsername || 'Last.fm'}</span>
                                    <button onClick={async () => { try { const res = await fetch('/api/providers/lastfm/disconnect', { method: 'POST' }); const data = await res.json(); if (!res.ok || data.error) { showToast(data.error || 'Failed to disconnect', 'error'); } else { setLastFmConnected(false); setLastFmUsername(''); } } catch (e: any) { showToast(e?.message || 'Network error', 'error'); } }} className="btn btn-danger btn-sm">Remove access</button>
                                </div>
                                <div className="border-t border-[var(--glass-border)] pt-4 flex items-center justify-between">
                                    <label className="text-sm text-[var(--color-text-primary)]">Auto-scrobble played tracks</label>
                                    <button onClick={() => setLastFmScrobbleEnabled(!lastFmScrobbleEnabled)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${lastFmScrobbleEnabled ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-bg-tertiary)]'}`}><span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${lastFmScrobbleEnabled ? 'translate-x-6' : 'translate-x-1'}`} /></button>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-3">
                                <p className="text-sm text-[var(--color-text-muted)]">Link your Last.fm account to scrobble played tracks.</p>
                                <button onClick={async () => { try { const tokenParam = authToken ? `?token=${authToken}` : ''; window.location.href = `/api/providers/lastfm/authorize${tokenParam}`; } catch (e: any) { showToast(e?.message || 'Network error', 'error'); } }} className="btn btn-primary btn-sm">Connect to Last.fm</button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {libTab === 'genius' && (
                <div className="flex flex-col gap-5">
                    <div><h3 className="text-lg font-bold text-[var(--color-text-primary)] mb-1">Genius</h3></div>
                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 flex flex-col gap-3">
                        <div className="flex gap-2">
                            <input type="text" value={geniusApiKey} onChange={e => setGeniusApiKey(e.target.value)} placeholder="Access Token" className="flex-1 p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                            <button onClick={() => testGenius(geniusApiKey)} disabled={geniusStatus === 'testing' || !geniusApiKey} className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50">{geniusStatus === 'testing' ? 'Testing...' : 'Test'}</button>
                        </div>
                        {geniusStatus === 'success' && <span className="text-green-500 font-semibold text-xs">✓ {geniusMessage}</span>}
                        {geniusStatus === 'error' && <span className="text-red-500 font-semibold text-xs">✗ {geniusMessage}</span>}
                    </div>
                </div>
            )}

            {libTab === 'musicbrainz' && (
                <div className="flex flex-col gap-5">
                    <div><h3 className="text-lg font-bold text-[var(--color-text-primary)] mb-1">MusicBrainz</h3></div>
                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 flex flex-col gap-3">
                        <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-[var(--color-text-primary)]">{musicBrainzEnabled ? 'Enabled' : 'Disabled'}</label>
                            <button onClick={() => setMusicBrainzEnabled(!musicBrainzEnabled)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${musicBrainzEnabled ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-bg-tertiary)]'}`}><span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${musicBrainzEnabled ? 'translate-x-6' : 'translate-x-1'}`} /></button>
                        </div>
                        {musicBrainzEnabled && (
                            <div className="flex flex-col gap-3 mt-1">
                                <input type="text" value={musicBrainzClientId} onChange={e => setMusicBrainzClientId(e.target.value)} placeholder="Client ID" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                                <input type="password" value={musicBrainzClientSecret} onChange={e => setMusicBrainzClientSecret(e.target.value)} placeholder="Client Secret" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                                <div className="flex gap-2 items-center">
                                    <button onClick={() => testMusicBrainz()} disabled={musicBrainzStatus === 'testing'} className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50">{musicBrainzStatus === 'testing' ? 'Testing...' : 'Test'}</button>
                                    {musicBrainzStatus === 'success' && <span className="text-green-500 font-semibold text-xs">✓ {musicBrainzMessage}</span>}
                                    {musicBrainzStatus === 'error' && <span className="text-red-500 font-semibold text-xs">✗ {musicBrainzMessage}</span>}
                                    {musicBrainzConnected ? (<><span className="text-green-500 font-semibold text-xs ml-auto">Connected</span><button onClick={async () => { await fetch('/api/providers/musicbrainz/disconnect', { method: 'POST' }); setMusicBrainzConnected(false); }} className="btn btn-danger btn-sm">Remove access</button></>) : (<button onClick={async () => { try { const tokenParam = authToken ? `?token=${authToken}` : ''; window.location.href = `/api/providers/musicbrainz/authorize${tokenParam}`; } catch (e: any) { showToast(e?.message || 'Network error', 'error'); } }} disabled={!musicBrainzClientId || !musicBrainzClientSecret} className="btn btn-primary btn-sm disabled:opacity-50 ml-auto">Connect</button>)}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Default Provider Configuration */}
            <div className="mt-6 pt-6 border-t border-[var(--glass-border)]">
                <h4 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">Default Provider per Service</h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                    <div>
                        <label className="block text-xs text-[var(--color-text-muted)] mb-1">Artist Images</label>
                        <select value={providerArtistImage} onChange={e => setSettings({ providerArtistImage: e.target.value as 'lastfm' | 'genius' | 'musicbrainz' })} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors">
                            <option value="lastfm">Last.fm</option><option value="genius">Genius</option>{musicBrainzEnabled && <option value="musicbrainz">MusicBrainz</option>}
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs text-[var(--color-text-muted)] mb-1">Artist Bios</label>
                        <select value={providerArtistBio} onChange={e => setSettings({ providerArtistBio: e.target.value as 'lastfm' | 'genius' })} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors">
                            <option value="lastfm">Last.fm</option><option value="genius">Genius</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs text-[var(--color-text-muted)] mb-1">Album Art</label>
                        <select value={providerAlbumArt} onChange={e => setSettings({ providerAlbumArt: e.target.value as 'lastfm' | 'genius' | 'musicbrainz' })} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors">
                            <option value="lastfm">Last.fm</option><option value="genius">Genius</option>{musicBrainzEnabled && <option value="musicbrainz">MusicBrainz</option>}
                        </select>
                    </div>
                </div>
                <button onClick={async () => { try { const authHeaders = getAuthHeader(); const res = await fetch('/api/providers/external/refresh', { method: 'POST', headers: authHeaders }); const data = await res.json(); if (!res.ok || data.error) { showToast(data.error || 'Failed to clear cache', 'error'); } else { showToast('Provider image & bio cache cleared', 'success'); } } catch (e: any) { showToast(e?.message || 'Network error', 'error'); } }} className="btn btn-ghost btn-sm gap-2"><Trash2 size={14} /> Clear cached images &amp; bios</button>
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
