import React, { useEffect, useState } from 'react';
import { ReviewPanel } from './ReviewPanel';
import type {
  ArtistPagePreview,
  ArtistReviewEntry as Entry,
  ArtistReviewKind,
  ArtistReviewPreview,
  ReleasePreview,
} from '../../../shared/artistReview';

export const REVIEW_QUESTION: Record<ArtistReviewKind, string> = {
  'joined-credit': 'One act, or two artists?',
  'people-credit': 'One artist, or several people?',
  'same-identity': 'One artist, two spellings?',
  'same-musicbrainz': 'One artist under two names?',
  'compound-credit': 'A credit or an artist?',
};

const RELEASES_SHOWN = 3;

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const Avatar: React.FC<{ name: string; imageUrl: string | null }> = ({ name, imageUrl }) => (
  <span className="entity-review-avatar" aria-hidden="true">
    {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : (name || '?').slice(0, 1).toUpperCase()}
  </span>
);

const ReleaseList: React.FC<{ label: string; releases: ReleasePreview[] }> = ({ label, releases }) => {
  if (releases.length === 0) return null;
  // Changes first, so a long discography doesn't hide them.
  const ordered = [...releases].sort((a, b) => Number(!!b.change) - Number(!!a.change));
  const shown = ordered.slice(0, RELEASES_SHOWN);
  return (
    <div className="entity-review-releases">
      <span className="entity-review-releases__label">{label}</span>
      <ul>
        {shown.map(release => (
          <li key={`${release.albumId}:${release.title}`} data-change={release.change || undefined}>
            <span className="entity-review-releases__title">{release.title}</span>
            <span className="entity-review-releases__count">{release.tracks}</span>
            {release.change === 'added' && <span className="entity-review-tag entity-review-tag--added">New</span>}
            {release.change === 'removed' && <span className="entity-review-tag">Gone</span>}
          </li>
        ))}
      </ul>
      {ordered.length > shown.length && (
        <span className="entity-review-releases__more">{ordered.length - shown.length} more</span>
      )}
    </div>
  );
};

const PagePreview: React.FC<{ page: ArtistPagePreview }> = ({ page }) => (
  <li className="entity-review-page" data-status={page.status}>
    <div className="entity-review-page__head">
      <Avatar name={page.name} imageUrl={page.imageUrl} />
      <span className="entity-review-page__name">{page.name}</span>
      <span className="entity-review-tag">
        {page.status === 'removed' ? 'Page removed' : page.status === 'changed' ? 'Changes' : 'Unchanged'}
      </span>
    </div>
    {page.status === 'changed' && (
      <div className="entity-review-page__body">
        {page.ownTracks !== page.ownTracksBefore && (
          <p className="entity-review-page__tracks">
            Own tracks <span className="tabular-nums">{page.ownTracksBefore} → {page.ownTracks}</span>
          </p>
        )}
        <ReleaseList label="Releases" releases={page.releases} />
        <ReleaseList label="Appears on" releases={page.appearances} />
      </div>
    )}
  </li>
);

export const ArtistReviewEntry: React.FC<{
  entry: Entry;
  loadPreview: (entry: Entry) => Promise<ArtistReviewPreview>;
  busy: boolean;
  onApply: (outcomeId: string) => void;
  onSkip: () => void;
  canSkip: boolean;
  autoFocus?: boolean;
}> = ({ entry, loadPreview, busy, onApply, onSkip, canSkip, autoFocus }) => {
  const [preview, setPreview] = useState<ArtistReviewPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

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
    <ReviewPanel
      evidence={(
        <div className="entity-review-evidence">
          {entry.artists.map(artist => (
            <span key={artist.id} className="entity-review-evidence__artist">
              <Avatar name={artist.name} imageUrl={artist.imageUrl} />
              <span className="entity-review-evidence__name">{artist.name}</span>
              <span className="entity-review-evidence__meta">
                {count(artist.trackCount, 'track')}
                {artist.mbid ? <code>MusicBrainz {artist.mbid.slice(0, 8)}</code> : entry.kind === 'joined-credit' && artist.id === lead?.id ? ' · no MusicBrainz id' : null}
              </span>
            </span>
          ))}
        </div>
      )}
      outcomes={entry.outcomes.map(outcome => ({
        id: outcome.id,
        label: outcome.label,
        body: (
          <ul className="entity-review-pages">
            {pagesFor(outcome.id).map(page => <PagePreview key={`${page.artistId}:${page.name}`} page={page} />)}
          </ul>
        ),
      }))}
      ready={preview !== null}
      error={previewError}
      chosen={chosen}
      onChoose={setChosen}
      busy={busy}
      onApply={() => chosen && onApply(chosen)}
      onSkip={onSkip}
      canSkip={canSkip}
      autoFocus={autoFocus}
    />
  );
};
