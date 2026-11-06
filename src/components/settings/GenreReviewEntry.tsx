import React, { useEffect, useState } from 'react';
import { Avatar } from './ArtistReviewEntry';
import { ReviewPanel, type ReviewPanelOutcome } from './ReviewPanel';
import { StylePicker, type GenreTaxonomy } from './StylePicker';
import {
  targetKey,
  targetLabel,
  type GenreReviewEntry as Entry,
  type GenreReviewEvidence,
  type GenreReviewOutcome,
  type GenreTarget,
} from '../../../shared/genreReview';

export interface GenreChoice { outcomeId: string; targets?: GenreTarget[] }

const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** Where the outcome sends the tag's tracks, and what each place holds today. */
const TargetList: React.FC<{ targets: GenreTarget[]; evidence: GenreReviewEvidence }> = ({ targets, evidence }) => (
  <div className="entity-review-releases">
    <span className="entity-review-releases__label">Tracks there today</span>
    <ul>
      {targets.map(target => {
        const today = evidence.targetTracks[targetKey(target)] ?? 0;
        return (
          <li key={targetKey(target)}>
            <span className="entity-review-releases__title">{targetLabel(target)}</span>
            {today > 0
              ? <span className="entity-review-releases__count">{today.toLocaleString()}</span>
              : <span className="entity-review-tag entity-review-tag--added">New</span>}
          </li>
        );
      })}
    </ul>
  </div>
);

const Effect: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="genre-review-effect">{children}</p>
);

function outcomeBody(entry: Entry, outcome: GenreReviewOutcome, evidence: GenreReviewEvidence, picker: React.ReactNode): React.ReactNode {
  switch (outcome.kind) {
    case 'accept':
    case 'only':
      return <TargetList targets={outcome.targets || []} evidence={evidence} />;
    case 'pick':
      return picker;
    case 'ignore':
      return <Effect>The files keep the tag; it no longer counts as a genre.</Effect>;
    case 'restore':
      return <Effect>It goes back to the automatic matching.</Effect>;
    case 'merge': {
      const kept = entry.spellings?.find(s => `merge:${s.id}` === outcome.id);
      const others = (entry.spellings || []).filter(s => s !== kept);
      return <Effect>{others.map(s => s.name).join(', ')} becomes {kept?.name}; {count(entry.totalTracks, 'track')} in one genre.</Effect>;
    }
    case 'keep-apart':
      return <Effect>Both stay in the genre list.</Effect>;
  }
}

export const GenreReviewEntry: React.FC<{
  entry: Entry;
  loadPreview: (entry: Entry) => Promise<GenreReviewEvidence>;
  taxonomy: GenreTaxonomy | null;
  busy: boolean;
  onApply: (choice: GenreChoice) => void;
  onSkip: () => void;
  canSkip: boolean;
  autoFocus?: boolean;
}> = ({ entry, loadPreview, taxonomy, busy, onApply, onSkip, canSkip, autoFocus }) => {
  const [evidence, setEvidence] = useState<GenreReviewEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [picked, setPicked] = useState<GenreTarget[]>([]);

  useEffect(() => {
    let live = true;
    setEvidence(null);
    setError(null);
    setChosen(entry.kind === 'unmapped' ? 'pick' : null);
    setPicked([]);
    loadPreview(entry)
      .then(result => { if (live) setEvidence(result); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [entry, loadPreview]);

  const picker = (
    <StylePicker
      taxonomy={taxonomy}
      value={picked}
      onChange={targets => { setPicked(targets); setChosen('pick'); }}
      onFocus={() => setChosen('pick')}
      disabled={busy}
      label={`Genre or style for ${entry.subject}`}
    />
  );

  const outcomes: ReviewPanelOutcome[] = entry.outcomes.map(outcome => ({
    id: outcome.id,
    label: outcome.label,
    body: evidence ? outcomeBody(entry, outcome, evidence, picker) : null,
  }));

  const artists = evidence?.artists || [];
  const lean = evidence?.lean;

  return (
    <ReviewPanel
      evidence={(
        <div className="genre-review-evidence">
          {entry.note && <p className="genre-review-evidence__note">{entry.note}</p>}
          {artists.length > 0 && (
            <div className="entity-review-evidence">
              {artists.map(artist => (
                <span key={artist.name} className="entity-review-evidence__artist">
                  <Avatar name={artist.name} imageUrl={artist.imageUrl} />
                  <span className="entity-review-evidence__name">{artist.name}</span>
                  <span className="entity-review-evidence__meta">{count(artist.tracks, 'track')}</span>
                </span>
              ))}
            </div>
          )}
          {evidence && evidence.albums.length > 0 && (
            <p className="genre-review-evidence__line">On {evidence.albums.join(', ')}</p>
          )}
          {lean && (
            <p className="genre-review-evidence__line">
              Artist tags from Last.fm and MusicBrainz lean {lean.genre}: {lean.artists} of {lean.of} artists
            </p>
          )}
        </div>
      )}
      outcomes={outcomes}
      ready={evidence !== null}
      error={error}
      chosen={chosen}
      onChoose={setChosen}
      canApply={chosen !== 'pick' || picked.length > 0}
      busy={busy}
      onApply={() => chosen && onApply({ outcomeId: chosen, targets: chosen === 'pick' ? picked : undefined })}
      onSkip={onSkip}
      canSkip={canSkip}
      autoFocus={autoFocus}
    />
  );
};
