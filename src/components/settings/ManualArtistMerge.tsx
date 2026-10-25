import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { Loader2, GitMerge, ArrowLeft, ArrowLeftRight, CheckCircle2, Trash2 } from 'lucide-react';
import { ConfirmModal } from '../ConfirmModal';

interface ArtistMergeStats {
    trackCount: number;
    albumCount: number;
}

interface ManualMergeArtist {
    id: string;
    name?: string;
    image_url?: string;
    mbid?: string;
}

const ManualMergePreview: React.FC<{
    canonical: ManualMergeArtist;
    duplicate: ManualMergeArtist;
    canonicalStats: ArtistMergeStats;
    duplicateStats: ArtistMergeStats;
    variant?: 'inline' | 'confirm';
}> = ({ canonical, duplicate, canonicalStats, duplicateStats, variant = 'inline' }) => {
    const projectedTracks = canonicalStats.trackCount + duplicateStats.trackCount;
    return (
        <div className={`artist-merge-preview artist-merge-preview--${variant}`}>
            <div className="artist-merge-preview__cards">
                <article className="artist-merge-card artist-merge-card--keep">
                    <header>
                        <span className="artist-merge-card__role">
                            <CheckCircle2 size={12} aria-hidden="true" />
                            Keeping
                        </span>
                    </header>
                    <div className="artist-merge-card__body">
                        <div className="artist-merge-card__avatar" aria-hidden="true">
                            {canonical.image_url
                                ? <img src={canonical.image_url} alt="" loading="lazy" />
                                : <span>{(canonical.name || '?').slice(0, 1).toUpperCase()}</span>}
                        </div>
                        <div className="artist-merge-card__meta">
                            <h6>{canonical.name || 'Unknown'}</h6>
                            <ul>
                                <li><strong>{canonicalStats.trackCount}</strong> tracks</li>
                                <li><strong>{canonicalStats.albumCount}</strong> albums</li>
                                {canonical.mbid && <li><code>MBID {canonical.mbid.slice(0, 8)}</code></li>}
                            </ul>
                        </div>
                    </div>
                </article>

                <div className="artist-merge-preview__arrow" aria-hidden="true">
                    <ArrowLeft size={20} />
                </div>

                <article className="artist-merge-card artist-merge-card--drop">
                    <header>
                        <span className="artist-merge-card__role">
                            <Trash2 size={12} aria-hidden="true" />
                            Folded in
                        </span>
                    </header>
                    <div className="artist-merge-card__body">
                        <div className="artist-merge-card__avatar" aria-hidden="true">
                            {duplicate.image_url
                                ? <img src={duplicate.image_url} alt="" loading="lazy" />
                                : <span>{(duplicate.name || '?').slice(0, 1).toUpperCase()}</span>}
                        </div>
                        <div className="artist-merge-card__meta">
                            <h6>{duplicate.name || 'Unknown'}</h6>
                            <ul>
                                <li><strong>{duplicateStats.trackCount}</strong> tracks</li>
                                <li><strong>{duplicateStats.albumCount}</strong> albums</li>
                                {duplicate.mbid && <li><code>MBID {duplicate.mbid.slice(0, 8)}</code></li>}
                            </ul>
                        </div>
                    </div>
                </article>
            </div>

            <p className="artist-merge-preview__summary">
                After merging, <strong>{canonical.name}</strong> will own {projectedTracks} track{projectedTracks === 1 ? '' : 's'}.
                Tracks, albums, subscriptions, and concert events from <strong>{duplicate.name}</strong> move across. The duplicate row stays
                as a redirect so refresh-metadata can't recreate it. Identity metadata (MBID, image, bio) on <strong>{canonical.name}</strong> is preserved;
                missing fields are filled in from <strong>{duplicate.name}</strong> only when their normalized identity keys match.
            </p>
        </div>
    );
};

/** Merge any two artists the review queue doesn't pair up ("DJ Tiësto" and
 * "Tiësto"), with a preview before it runs. */
export const ManualArtistMerge: React.FC<{ onMerged: () => void }> = ({ onMerged }) => {
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);
    const allArtists = usePlayerStore(state => state.artists);
    const library = usePlayerStore(state => state.library);
    // Per-artist track/album counts are derived from the full library, which is
    // no longer loaded at boot — load it on demand for this admin tool.
    const ensureFullLibraryLoaded = usePlayerStore(state => state.ensureFullLibraryLoaded);
    useEffect(() => { void ensureFullLibraryLoaded(); }, [ensureFullLibraryLoaded]);

    const [confirmDialog, setConfirmDialog] = useState<{
        title: string;
        body?: React.ReactNode;
        confirmLabel?: string;
        confirmTone?: 'danger' | 'primary';
        onConfirm: () => void;
    } | null>(null);
    const [manualCanonical, setManualCanonical] = useState('');
    const [manualDuplicate, setManualDuplicate] = useState('');
    const [manualBusy, setManualBusy] = useState(false);
    const manualListId = useId();

    const { addToast } = useToast();
    const showToast = useCallback((msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type), [addToast]);
    const fetchCandidates = onMerged;

    const sortedArtists = useMemo(
        () => [...allArtists].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
        [allArtists]
    );

    // Track and album counts per artist_id, derived from the library snapshot.
    // The reviewed-candidates endpoint returns these for auto-detected pairs;
    // for manual picks we compute them client-side so the preview shows the
    // same numbers the user sees elsewhere.
    const statsByArtistId = useMemo(() => {
        const map = new Map<string, ArtistMergeStats>();
        const albumByArtist = new Map<string, Set<string>>();
        for (const track of library) {
            const aid = track.artistId;
            if (!aid) continue;
            const existing = map.get(aid) || { trackCount: 0, albumCount: 0 };
            existing.trackCount += 1;
            map.set(aid, existing);
            if (track.albumId) {
                const albumSet = albumByArtist.get(aid) || new Set<string>();
                albumSet.add(track.albumId);
                albumByArtist.set(aid, albumSet);
            }
        }
        for (const [aid, albums] of albumByArtist) {
            const existing = map.get(aid);
            if (existing) existing.albumCount = albums.size;
        }
        return map;
    }, [library]);

    const resolveManualArtist = useCallback((raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        const exact = sortedArtists.find(a => (a.name || '').toLowerCase() === trimmed.toLowerCase());
        return exact || null;
    }, [sortedArtists]);

    const manualCanonicalArtist = resolveManualArtist(manualCanonical);
    const manualDuplicateArtist = resolveManualArtist(manualDuplicate);
    const manualReady = Boolean(manualCanonicalArtist && manualDuplicateArtist && manualCanonicalArtist.id !== manualDuplicateArtist.id);

    const swapManualDirection = useCallback(() => {
        setManualCanonical(manualDuplicate);
        setManualDuplicate(manualCanonical);
    }, [manualCanonical, manualDuplicate]);

    const handleManualMerge = useCallback(() => {
        if (!manualCanonicalArtist || !manualDuplicateArtist) {
            showToast('Pick existing artists for both fields', 'error');
            return;
        }
        if (manualCanonicalArtist.id === manualDuplicateArtist.id) {
            showToast('Canonical and duplicate must be different artists', 'error');
            return;
        }
        const canonical = manualCanonicalArtist;
        const duplicate = manualDuplicateArtist;
        const canonicalStats = statsByArtistId.get(canonical.id) || { trackCount: 0, albumCount: 0 };
        const duplicateStats = statsByArtistId.get(duplicate.id) || { trackCount: 0, albumCount: 0 };

        const previewBody = (
            <ManualMergePreview
                canonical={canonical}
                duplicate={duplicate}
                canonicalStats={canonicalStats}
                duplicateStats={duplicateStats}
                variant="confirm"
            />
        );

        setConfirmDialog({
            title: 'Confirm artist merge',
            body: previewBody,
            confirmLabel: `Merge into ${canonical.name}`,
            confirmTone: 'primary',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    setManualBusy(true);
                    const res = await fetch('/api/library/artists/manual-merge', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                        body: JSON.stringify({
                            canonicalArtistId: canonical.id,
                            duplicateArtistIds: [duplicate.id],
                        }),
                    });
                    if (!res.ok) {
                        const data = await res.json().catch(() => ({}));
                        showToast(data.error || 'Failed to merge artists', 'error');
                        return;
                    }
                    showToast(`Merged "${duplicate.name}" into "${canonical.name}"`, 'success');
                    setManualCanonical('');
                    setManualDuplicate('');
                    await fetchLibraryFromServer();
                    await fetchCandidates();
                } catch (e) {
                    showToast(`Merge failed: ${e}`, 'error');
                } finally {
                    setManualBusy(false);
                }
            },
        });
    }, [manualCanonicalArtist, manualDuplicateArtist, statsByArtistId, getAuthHeader, fetchCandidates, fetchLibraryFromServer, showToast]);

    return (
        <>
            <div className="artist-review-tool">
                <p className="artist-review-tool__hint">
                    For two artists the queue doesn't pair up. The second one's tracks and albums move to the first.
                </p>
                <div className="artist-entities-manual__grid">
                    <label className="artist-entities-manual__field">
                        <span>Keep</span>
                        <input
                            type="text"
                            list={`${manualListId}-canonical`}
                            value={manualCanonical}
                            onChange={e => setManualCanonical(e.target.value)}
                            placeholder="Search artists…"
                            autoComplete="off"
                            spellCheck={false}
                            disabled={manualBusy}
                            aria-invalid={Boolean(manualCanonical) && !manualCanonicalArtist}
                        />
                        <datalist id={`${manualListId}-canonical`}>
                            {sortedArtists.map(a => <option key={a.id} value={a.name || ''} />)}
                        </datalist>
                    </label>
                    <button
                        type="button"
                        className="artist-entities-manual__swap"
                        onClick={swapManualDirection}
                        disabled={manualBusy || (!manualCanonical && !manualDuplicate)}
                        aria-label="Swap merge direction"
                        title="Swap merge direction"
                    >
                        <ArrowLeftRight size={14} aria-hidden="true" />
                    </button>
                    <label className="artist-entities-manual__field">
                        <span>Fold in</span>
                        <input
                            type="text"
                            list={`${manualListId}-duplicate`}
                            value={manualDuplicate}
                            onChange={e => setManualDuplicate(e.target.value)}
                            placeholder="Search artists…"
                            autoComplete="off"
                            spellCheck={false}
                            disabled={manualBusy}
                            aria-invalid={Boolean(manualDuplicate) && !manualDuplicateArtist}
                        />
                        <datalist id={`${manualListId}-duplicate`}>
                            {sortedArtists.map(a => <option key={a.id} value={a.name || ''} />)}
                        </datalist>
                    </label>
                </div>

                {manualCanonical && !manualCanonicalArtist && (
                    <p className="artist-entities-manual__hint" role="status">No artist in your library matches "{manualCanonical}".</p>
                )}
                {manualDuplicate && !manualDuplicateArtist && (
                    <p className="artist-entities-manual__hint" role="status">No artist in your library matches "{manualDuplicate}".</p>
                )}
                {manualCanonicalArtist && manualDuplicateArtist && manualCanonicalArtist.id === manualDuplicateArtist.id && (
                    <p className="artist-entities-manual__hint" role="status">Canonical and duplicate must be different artists.</p>
                )}

                {manualReady && manualCanonicalArtist && manualDuplicateArtist && (
                    <ManualMergePreview
                        canonical={manualCanonicalArtist}
                        duplicate={manualDuplicateArtist}
                        canonicalStats={statsByArtistId.get(manualCanonicalArtist.id) || { trackCount: 0, albumCount: 0 }}
                        duplicateStats={statsByArtistId.get(manualDuplicateArtist.id) || { trackCount: 0, albumCount: 0 }}
                        variant="inline"
                    />
                )}

                <div className="artist-entities-manual__footer">
                    <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={handleManualMerge}
                        disabled={!manualReady || manualBusy}
                    >
                        {manualBusy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <GitMerge size={13} aria-hidden="true" />}
                        Review &amp; merge
                    </button>
                </div>
            </div>
            {confirmDialog && (
                <ConfirmModal
                    title={confirmDialog.title}
                    body={confirmDialog.body}
                    confirmLabel={confirmDialog.confirmLabel}
                    confirmTone={confirmDialog.confirmTone}
                    onConfirm={confirmDialog.onConfirm}
                    onCancel={() => setConfirmDialog(null)}
                />
            )}
        </>
    );
};
