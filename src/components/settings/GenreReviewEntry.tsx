import React, { useEffect, useState } from 'react';
import { Avatar } from './ArtistReviewEntry';
import { ReviewPanel, type ReviewPanelOutcome } from './ReviewPanel';
import { StylePicker, type GenreTaxonomy } from './StylePicker';
import {
  listJoin,
  targetKey,
  targetLabel,
  type GenreAudioEvidence,
  type GenreReviewEntry as Entry,
  type GenreReviewEvidence,
  type GenreReviewOutcome,
  type GenreSuggestion,
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

const PROVIDER_NAME = { lastfm: 'Last.fm', musicbrainz: 'MusicBrainz' } as const;
/** Below this many analysed tracks the audio shares are too thin to warn about. */
const AUDIO_HINT_MIN_TRACKS = 5;
const STYLE_HINT_SHARE = 0.5;

const sameTargets = (a: GenreTarget[], b: GenreTarget[]) =>
  a.length === b.length && a.every(t => b.some(u => targetKey(u) === targetKey(t)));
const sameGenres = (a: GenreTarget[], b: GenreTarget[]) => {
  const genres = (list: GenreTarget[]) => [...new Set(list.map(t => t.genre))].sort().join('|');
  return genres(a) === genres(b);
};

/**
 * The outcome that already says what the suggestion says: the same targets,
 * or for a genre-only suggestion, the outcome in that genre.
 */
function suggestedOutcome(entry: Entry, suggestion: GenreSuggestion | null): string | null {
  if (!suggestion) return null;
  const genreOnly = suggestion.targets.every(t => t.styleId === null);
  const match = entry.outcomes.find(o => (o.kind === 'accept' || o.kind === 'only') && o.targets?.length
    && (sameTargets(o.targets, suggestion.targets) || (genreOnly && sameGenres(o.targets, suggestion.targets))));
  return match?.id ?? null;
}

const audioTracks = (audio: GenreAudioEvidence, target: GenreTarget) => target.styleId === null
  ? audio.genres.find(g => g.genre === target.genre)?.tracks ?? 0
  : audio.styles.find(s => s.styleId === target.styleId)?.tracks ?? 0;

function suggestionText(suggestion: GenreSuggestion, audio: GenreAudioEvidence | null): string {
  const label = listJoin(suggestion.targets.map(targetLabel));
  const why = suggestion.basis === 'both' ? 'audio and artist tags agree'
    : suggestion.basis === 'artists' ? 'from artist tags'
      : `the audio puts ${audio ? audioTracks(audio, suggestion.targets[0]) : 0} of ${audio?.analysed ?? 0} tracks there`;
  const styles = suggestion.stylesVary ? ' No style: they vary from track to track, so each track gets its own from its audio.' : '';
  return `Suggested: ${label}, ${why}.${styles}`;
}

/** A style the audio gives few of these tracks: say so, and point to the genre alone. */
function styleHint(picked: GenreTarget[], audio: GenreAudioEvidence | null): string | null {
  if (!audio || audio.analysed < AUDIO_HINT_MIN_TRACKS) return null;
  const thin = picked.find(t => t.styleId !== null && audioTracks(audio, t) / audio.analysed < STYLE_HINT_SHARE);
  if (!thin) return null;
  const n = audioTracks(audio, thin);
  return `${thin.style} is the audio's top style for ${n} of ${audio.analysed} tracks. Every track with this tag gets it; choose ${thin.genre} alone to let each track keep its own style.`;
}

const AudioLines: React.FC<{ audio: GenreAudioEvidence }> = ({ audio }) => {
  const lead = audio.genres[0]?.genre;
  const counted = audio.sampled ? `${audio.analysed.toLocaleString()} sampled tracks` : count(audio.analysed, 'track');
  return (
    <>
      <p className="genre-review-evidence__line">
        Audio, {counted}: {audio.genres.slice(0, 3).map(g => `${g.genre} ${g.tracks.toLocaleString()}`).join(' · ')}
      </p>
      <p className="genre-review-evidence__line">
        Top styles: {audio.styles.slice(0, 5)
          .map(s => `${s.style}${s.genre === lead ? '' : ` (${s.genre})`} ${s.tracks.toLocaleString()}`).join(' · ')}
      </p>
    </>
  );
};

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
      .then(result => {
        if (!live) return;
        setEvidence(result);
        // Start from the suggestion: the outcome that matches it, or (for a tag
        // with no genre) the picker filled in. Anything else waits for a choice.
        const match = suggestedOutcome(entry, result.suggestion);
        if (match) setChosen(current => current === null || current === 'pick' ? match : current);
        else if (result.suggestion && entry.outcomes.some(o => o.kind === 'pick')) {
          setPicked(current => current.length ? current : result.suggestion!.targets);
        }
      })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [entry, loadPreview]);

  const hint = styleHint(picked, evidence?.audio ?? null);
  const picker = (
    <>
      <StylePicker
        taxonomy={taxonomy}
        value={picked}
        onChange={targets => { setPicked(targets); setChosen('pick'); }}
        onFocus={() => setChosen('pick')}
        disabled={busy}
        label={`Genre or style for ${entry.subject}`}
      />
      {hint && <p className="genre-review-hint">{hint}</p>}
    </>
  );

  const suggestion = evidence?.suggestion ?? null;
  const suggestedId = suggestedOutcome(entry, suggestion)
    ?? (suggestion && sameTargets(picked, suggestion.targets) ? 'pick' : null);
  const outcomes: ReviewPanelOutcome[] = entry.outcomes.map(outcome => ({
    id: outcome.id,
    label: outcome.id === suggestedId
      ? <>{outcome.label} <span className="entity-review-tag entity-review-tag--added">Suggested</span></>
      : outcome.label,
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
          {evidence?.artistTags && (
            <p className="genre-review-evidence__line">
              Artist tags: {evidence.artistTags.map(p => `${PROVIDER_NAME[p.provider]} ${p.tags.join(', ')}`).join(' · ')}
            </p>
          )}
          {evidence?.audio && <AudioLines audio={evidence.audio} />}
          {suggestion && <p className="genre-review-evidence__suggestion">{suggestionText(suggestion, evidence?.audio ?? null)}</p>}
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
