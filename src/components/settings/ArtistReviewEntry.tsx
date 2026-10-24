import React, { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type {
  ArtistPagePreview,
  ArtistReviewEntry as Entry,
  ArtistReviewKind,
  ArtistReviewPreview,
  ReleasePreview,
} from '../../../shared/artistReview';

export const REVIEW_QUESTION: Record<ArtistReviewKind, string> = {
  'joined-credit': 'One act, or two artists?',
  'same-identity': 'One artist, two spellings?',
  'same-musicbrainz': 'One artist under two names?',
  'compound-credit': 'A credit or an artist?',
};

const RELEASES_SHOWN = 3;

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const Avatar: React.FC<{ name: string; imageUrl: string | null }> = ({ name, imageUrl }) => (
  <span className="artist-review-avatar" aria-hidden="true">
    {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : (name || '?').slice(0, 1).toUpperCase()}
  </span>
);

const ReleaseList: React.FC<{ label: string; releases: ReleasePreview[] }> = ({ label, releases }) => {
  if (releases.length === 0) return null;
  // Changes first, so a long discography doesn't hide them.
  const ordered = [...releases].sort((a, b) => Number(!!b.change) - Number(!!a.change));
  const shown = ordered.slice(0, RELEASES_SHOWN);
  return (
    <div className="artist-review-releases">
      <span className="artist-review-releases__label">{label}</span>
      <ul>
        {shown.map(release => (
          <li key={`${release.albumId}:${release.title}`} data-change={release.change || undefined}>
            <span className="artist-review-releases__title">{release.title}</span>
            <span className="artist-review-releases__count">{release.tracks}</span>
            {release.change === 'added' && <span className="artist-review-tag artist-review-tag--added">New</span>}
            {release.change === 'removed' && <span className="artist-review-tag">Gone</span>}
          </li>
        ))}
      </ul>
      {ordered.length > shown.length && (
        <span className="artist-review-releases__more">{ordered.length - shown.length} more</span>
      )}
    </div>
  );
};

const PagePreview: React.FC<{ page: ArtistPagePreview }> = ({ page }) => (
  <li className="artist-review-page" data-status={page.status}>
    <div className="artist-review-page__head">
      <Avatar name={page.name} imageUrl={page.imageUrl} />
      <span className="artist-review-page__name">{page.name}</span>
      <span className="artist-review-tag">
        {page.status === 'removed' ? 'Page removed' : page.status === 'changed' ? 'Changes' : 'Unchanged'}
      </span>
    </div>
    {page.status === 'changed' && (
      <div className="artist-review-page__body">
        {page.ownTracks !== page.ownTracksBefore && (
          <p className="artist-review-page__tracks">
            Own tracks <span className="tabular-nums">{page.ownTracksBefore} → {page.ownTracks}</span>
          </p>
        )}
        <ReleaseList label="Releases" releases={page.releases} />
        <ReleaseList label="Appears on" releases={page.appearances} />
      </div>
    )}
  </li>
);

const OutcomeSkeleton: React.FC = () => (
  <div className="artist-review-outcome artist-review-outcome--skeleton" aria-hidden="true">
    <span /><span /><span />
  </div>
);

export const ArtistReviewEntry: React.FC<{
  entry: Entry;
  loadPreview: (entry: Entry) => Promise<ArtistReviewPreview>;
  busy: boolean;
  onApply: (outcomeId: string) => void;
  onSkip: () => void;
  canSkip: boolean;
}> = ({ entry, loadPreview, busy, onApply, onSkip, canSkip }) => {
  const [preview, setPreview] = useState<ArtistReviewPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const groupName = useId();

  useEffect(() => {
    let live = true;
    setPreview(null);
    setPreviewError(null);
    setChosen(null);
    loadPreview(entry)
      .then(result => { if (live) setPreview(result); })
      .catch((e: Error) => { if (live) setPreviewError(e.message); });
    return () => { live = false; };
  }, [entry, loadPreview]);

  const pagesFor = (outcomeId: string) => preview?.outcomes.find(o => o.id === outcomeId)?.pages || [];
  const lead = entry.artists[0];

  return (
    <div className="artist-review-entry__panel">
      <div className="artist-review-evidence">
        {entry.artists.map(artist => (
          <span key={artist.id} className="artist-review-evidence__artist">
            <Avatar name={artist.name} imageUrl={artist.imageUrl} />
            <span className="artist-review-evidence__name">{artist.name}</span>
            <span className="artist-review-evidence__meta">
              {count(artist.trackCount, 'track')}
              {artist.mbid ? <code>MusicBrainz {artist.mbid.slice(0, 8)}</code> : entry.kind === 'joined-credit' && artist.id === lead?.id ? ' · no MusicBrainz id' : null}
            </span>
          </span>
        ))}
      </div>

      {previewError ? (
        <p className="artist-review-error" role="alert">{previewError}</p>
      ) : (
        <fieldset className="artist-review-outcomes">
          <legend className="sr-only">Choose an outcome</legend>
          {entry.outcomes.map(outcome => (
            preview ? (
              <label key={outcome.id} className="artist-review-outcome" data-selected={chosen === outcome.id ? 'true' : 'false'}>
                <input
                  type="radio"
                  className="sr-only"
                  name={groupName}
                  value={outcome.id}
                  checked={chosen === outcome.id}
                  onChange={() => setChosen(outcome.id)}
                  disabled={busy}
                />
                <span className="artist-review-outcome__label">{outcome.label}</span>
                <ul className="artist-review-pages">
                  {pagesFor(outcome.id).map(page => <PagePreview key={`${page.artistId}:${page.name}`} page={page} />)}
                </ul>
              </label>
            ) : <OutcomeSkeleton key={outcome.id} />
          ))}
        </fieldset>
      )}

      <div className="artist-review-entry__actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onSkip} disabled={busy || !canSkip}>
          Skip
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => chosen && onApply(chosen)}
          disabled={busy || !chosen}
        >
          {busy && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
          Apply
        </button>
      </div>
    </div>
  );
};
