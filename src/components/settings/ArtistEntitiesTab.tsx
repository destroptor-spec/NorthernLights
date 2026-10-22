import React, { useState, useCallback, useEffect, useMemo, useId } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { Loader2, GitMerge, EyeOff, RefreshCw, AlertCircle, Users2, Layers, Wand2, ArrowLeft, ArrowLeftRight, CheckCircle2, Trash2, Fingerprint } from 'lucide-react';
import { ConfirmModal } from '../ConfirmModal';

interface ArtistDuplicateCandidate {
    candidateKey: string;
    normalizedKey: string;
    signature: string;
    totalTracks: number;
    artists: Array<{
        id: string;
        name: string;
        mbid: string | null;
        imageUrl?: string;
        trackCount: number;
        albumCount: number;
        displayScore: number;
    }>;
}

type CandidateKind = 'same-identity' | 'compound-credit' | 'same-musicbrainz';

const candidateKind = (candidate: ArtistDuplicateCandidate): CandidateKind =>
    candidate.candidateKey.startsWith('artist-amp-compound:') ? 'compound-credit'
        : candidate.candidateKey.startsWith('artist-mbid:') ? 'same-musicbrainz'
            : 'same-identity';

const KindBadge: React.FC<{ kind: CandidateKind }> = ({ kind }) => {
    if (kind === 'same-musicbrainz') {
        return (
            <span className="artist-entity-badge artist-entity-badge--mbid">
                <Fingerprint size={11} aria-hidden="true" />
                Same MusicBrainz artist
            </span>
        );
    }
    if (kind === 'compound-credit') {
        return (
            <span className="artist-entity-badge artist-entity-badge--compound">
                <Layers size={11} aria-hidden="true" />
                Compound credit
            </span>
        );
    }
    return (
        <span className="artist-entity-badge artist-entity-badge--same">
            <Users2 size={11} aria-hidden="true" />
            Same identity
        </span>
    );
};

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

export const ArtistEntitiesTab: React.FC = () => {
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);
    const allArtists = usePlayerStore(state => state.artists);
    const library = usePlayerStore(state => state.library);
    // Per-artist track/album counts are derived from the full library, which is
    // no longer loaded at boot — load it on demand for this admin tool.
    const ensureFullLibraryLoaded = usePlayerStore(state => state.ensureFullLibraryLoaded);
    useEffect(() => { void ensureFullLibraryLoaded(); }, [ensureFullLibraryLoaded]);

    const [candidates, setCandidates] = useState<ArtistDuplicateCandidate[]>([]);
    const [loading, setLoading] = useState(false);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [canonicalByKey, setCanonicalByKey] = useState<Record<string, string>>({});
    const [confirmDialog, setConfirmDialog] = useState<{
        title: string;
        message?: string;
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

    const fetchCandidates = useCallback(async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/library/artist-duplicates', { headers: getAuthHeader() });
            if (!res.ok) return;
            const data = await res.json();
            const rows: ArtistDuplicateCandidate[] = Array.isArray(data.candidates) ? data.candidates : [];
            setCandidates(rows);
            setCanonicalByKey(prev => {
                const next = { ...prev };
                for (const candidate of rows) {
                    if (!next[candidate.candidateKey] || !candidate.artists.some(a => a.id === next[candidate.candidateKey])) {
                        next[candidate.candidateKey] = candidate.artists[0]?.id || '';
                    }
                }
                return next;
            });
        } catch (e) {
            console.error('Failed to fetch artist duplicate candidates', e);
        } finally {
            setLoading(false);
        }
    }, [getAuthHeader]);

    useEffect(() => {
        fetchCandidates();
    }, [fetchCandidates]);

    const handleDismiss = useCallback(async (candidate: ArtistDuplicateCandidate) => {
        try {
            setBusyKey(candidate.candidateKey);
            const res = await fetch('/api/library/artist-duplicates/dismiss', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({
                    candidateKey: candidate.candidateKey,
                    signature: candidate.signature,
                    artistIds: candidate.artists.map(a => a.id),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                showToast(data.error || 'Failed to dismiss artist duplicate', 'error');
                return;
            }
            showToast('Candidate dismissed', 'success');
            await fetchCandidates();
        } catch (e) {
            showToast(`Dismiss failed: ${e}`, 'error');
        } finally {
            setBusyKey(null);
        }
    }, [fetchCandidates, getAuthHeader, showToast]);

    const handleMerge = useCallback((candidate: ArtistDuplicateCandidate) => {
        const canonicalArtistId = canonicalByKey[candidate.candidateKey] || candidate.artists[0]?.id;
        const canonicalArtist = candidate.artists.find(a => a.id === canonicalArtistId);
        if (!canonicalArtist) return;
        const duplicateArtistIds = candidate.artists.filter(a => a.id !== canonicalArtistId).map(a => a.id);
        const kind = candidateKind(candidate);

        const message = kind === 'compound-credit'
            ? `Merge the credit row${duplicateArtistIds.length === 1 ? '' : 's'} into "${canonicalArtist.name}"? Tracks, subscriptions, dismissed-auto state, and concert events will be moved. Metadata (MBID, image, bio) will not be copied across because the credit row's MBID belongs to the credit string, not to ${canonicalArtist.name}.`
            : kind === 'same-musicbrainz'
            ? `Fold the other spelling${duplicateArtistIds.length === 1 ? '' : 's'} into "${canonicalArtist.name}"? Tracks, subscriptions, dismissed-auto state, and concert events will be moved. Files tagged with ${duplicateArtistIds.length === 1 ? 'that spelling' : 'those spellings'} keep landing on "${canonicalArtist.name}" in later scans. Picture and bio are not copied.`
            : `Merge ${duplicateArtistIds.length} artist entr${duplicateArtistIds.length === 1 ? 'y' : 'ies'} into "${canonicalArtist.name}"? Track links, subscriptions, dismissed-auto state, concert events, and any missing metadata will be copied to the canonical artist.`;

        setConfirmDialog({
            title: 'Merge Artist Entries',
            message,
            confirmLabel: 'Merge Artists',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    setBusyKey(candidate.candidateKey);
                    const res = await fetch('/api/library/artist-duplicates/merge', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                        body: JSON.stringify({
                            candidateKey: candidate.candidateKey,
                            signature: candidate.signature,
                            canonicalArtistId,
                            duplicateArtistIds,
                        }),
                    });
                    if (!res.ok) {
                        const data = await res.json().catch(() => ({}));
                        showToast(data.error || 'Failed to merge artists', 'error');
                        return;
                    }
                    showToast(`Merged into ${canonicalArtist.name}`, 'success');
                    await fetchLibraryFromServer();
                    await fetchCandidates();
                } catch (e) {
                    showToast(`Merge failed: ${e}`, 'error');
                } finally {
                    setBusyKey(null);
                }
            },
        });
    }, [canonicalByKey, fetchCandidates, fetchLibraryFromServer, getAuthHeader, showToast]);

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

    const sameIdentityCount = candidates.filter(c => candidateKind(c) === 'same-identity').length;
    const compoundCount = candidates.filter(c => candidateKind(c) === 'compound-credit').length;
    const musicBrainzCount = candidates.filter(c => candidateKind(c) === 'same-musicbrainz').length;

    return (
        <div className="settings-section artist-entities-settings">
            <header className="artist-entities-settings__header">
                <div>
                    <p className="artist-entities-settings__eyebrow">Library Hygiene</p>
                    <h3>Artist Entities</h3>
                    <p>Review duplicate rows and compound credit strings before they shape artist pages.</p>
                </div>
                <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={fetchCandidates}
                    disabled={loading}
                >
                    <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
                    Refresh
                </button>
            </header>

            <section className="artist-entities-overview" aria-label="Artist entity review summary">
                <div className="artist-entities-overview__item">
                    <span>Candidates</span>
                    <strong>{candidates.length}</strong>
                </div>
                <div className="artist-entities-overview__item">
                    <span>Same identity</span>
                    <strong>{sameIdentityCount}</strong>
                </div>
                <div className="artist-entities-overview__item">
                    <span>Compound</span>
                    <strong>{compoundCount}</strong>
                </div>
                <div className="artist-entities-overview__item">
                    <span>MusicBrainz</span>
                    <strong>{musicBrainzCount}</strong>
                </div>
            </section>

            <section className="artist-entities-guide">
                <div className="artist-entities-guide__item">
                    <KindBadge kind="same-identity" />
                    <div>
                        <h4>Same identity duplicates</h4>
                        <p>
                            Name variants normalize to the same key, for example <code>Tiësto</code> and <code>Tiesto</code>.
                            Choose the best display name, then merge tracks, subscriptions, events, and missing metadata into it.
                        </p>
                    </div>
                </div>
                <div className="artist-entities-guide__item">
                    <KindBadge kind="compound-credit" />
                    <div>
                        <h4>Compound credits</h4>
                        <p>
                            Credits such as <code>Tony Bennett &amp; Lady Gaga</code> or <code>The Chainsmokers + Kygo</code>
                            can be folded into the canonical artist row. Tracks move across, but credit-string metadata stays behind.
                        </p>
                    </div>
                </div>
                <div className="artist-entities-guide__item">
                    <KindBadge kind="same-musicbrainz" />
                    <div>
                        <h4>Same MusicBrainz artist</h4>
                        <p>
                            Artist names follow your files, so when files credit one MusicBrainz artist under different
                            names, for example <code>Sabrina</code> and <code>Sabrina Salerno</code>, each name gets its own row.
                            Keep them apart, or fold them into the name you want; later scans respect your choice.
                        </p>
                    </div>
                </div>
                <div className="artist-entities-guide__note">
                    <AlertCircle size={15} aria-hidden="true" />
                    <p>
                        Genuine duos are intentionally skipped when their first half is not already a separate artist row.
                        Dismiss real groups you do see; dismissals return only when track or album counts change.
                    </p>
                </div>
            </section>

            <section className="artist-entities-manual" aria-label="Manual artist merge">
                <div className="artist-entities-manual__head">
                    <Wand2 size={15} aria-hidden="true" />
                    <div>
                        <h4>Manual merge</h4>
                        <p>Pick two artists from your library. Review the preview, then merge — the duplicate's tracks and albums move into the canonical row.</p>
                    </div>
                </div>
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
            </section>

            <section className="artist-entities-queue">
                <div className="artist-entities-queue__header">
                    <div>
                        <h4>Review Queue</h4>
                        <p>
                            {loading
                                ? 'Checking artist identity keys...'
                                : `${candidates.length} candidate${candidates.length === 1 ? '' : 's'} ready for review`}
                        </p>
                    </div>
                </div>

            {loading ? (
                <div className="artist-entities-empty" role="status">
                    <Loader2 size={17} className="animate-spin" aria-hidden="true" />
                    <span>Checking artist identity keys...</span>
                </div>
            ) : candidates.length === 0 ? (
                <div className="artist-entities-empty" role="status">
                    <GitMerge size={17} aria-hidden="true" />
                    <span>No artist candidates need review.</span>
                </div>
            ) : (
                <div className="artist-candidate-list">
                    {candidates.map(candidate => {
                        const canonicalArtistId = canonicalByKey[candidate.candidateKey] || candidate.artists[0]?.id || '';
                        const busy = busyKey === candidate.candidateKey;
                        const kind = candidateKind(candidate);
                        return (
                            <article key={`${candidate.candidateKey}:${candidate.signature}`} className="artist-candidate">
                                <div className="artist-candidate__head">
                                    <div className="artist-candidate__title">
                                        <KindBadge kind={kind} />
                                        <h5>{candidate.normalizedKey}</h5>
                                    </div>
                                    <div className="artist-candidate__meta">
                                        <span>{candidate.artists.length} artists</span>
                                        <span>{candidate.totalTracks} tracks</span>
                                    </div>
                                </div>

                                <div className="artist-candidate__body">
                                    <div className="artist-choice-list">
                                        {candidate.artists.map(artist => (
                                            <label key={artist.id} className="artist-choice" data-selected={canonicalArtistId === artist.id ? 'true' : 'false'}>
                                                <input
                                                    type="radio"
                                                    name={`canonical-${candidate.candidateKey}`}
                                                    checked={canonicalArtistId === artist.id}
                                                    onChange={() => setCanonicalByKey(prev => ({ ...prev, [candidate.candidateKey]: artist.id }))}
                                                />
                                                <span className="artist-choice__copy">
                                                    <span className="artist-choice__name">{artist.name}</span>
                                                    <span className="artist-choice__meta">
                                                        <span>{artist.trackCount} tracks</span>
                                                        <span>{artist.albumCount} albums</span>
                                                        {artist.mbid && <code>MBID {artist.mbid.slice(0, 8)}</code>}
                                                    </span>
                                                </span>
                                            </label>
                                        ))}
                                    </div>

                                    <div className="artist-candidate__actions">
                                        <button
                                            type="button"
                                            className="btn btn-primary btn-sm"
                                            onClick={() => handleMerge(candidate)}
                                            disabled={busy}
                                        >
                                            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <GitMerge size={13} aria-hidden="true" />}
                                            Merge into selected
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-sm"
                                            onClick={() => handleDismiss(candidate)}
                                            disabled={busy}
                                        >
                                            <EyeOff size={13} aria-hidden="true" />
                                            Dismiss
                                        </button>
                                    </div>
                                </div>
                            </article>
                        );
                    })}
                </div>
            )}
            </section>

            {confirmDialog && (
                <ConfirmModal
                    title={confirmDialog.title}
                    message={confirmDialog.message}
                    body={confirmDialog.body}
                    confirmLabel={confirmDialog.confirmLabel}
                    confirmTone={confirmDialog.confirmTone}
                    onConfirm={confirmDialog.onConfirm}
                    onCancel={() => setConfirmDialog(null)}
                />
            )}
        </div>
    );
};
