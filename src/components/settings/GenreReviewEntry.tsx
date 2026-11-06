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

/** Rows shown in each list of the sound section. */
const SOUND_ROWS = 5;
/** Below this many analysed tracks the shares are too thin to warn about. */
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

/** Why the suggestion, in words, shown in the suggested outcome's card. */
function suggestionReason(suggestion: GenreSuggestion, audio: GenreAudioEvidence | null, totalTracks: number, cardHasStyle: boolean): string {
  const target = suggestion.targets[0];
  const why = suggestion.basis === 'both'
    ? `The sound of the tracks and the artist tags both point to ${target.genre}.`
    : suggestion.basis === 'artists'
      ? `The artist tags point to ${target.genre}; too few of the tracks are analysed to check their sound.`
      : `${audio ? audioTracks(audio, target) : 0} of the ${audio?.analysed ?? 0} analysed tracks sound most like ${targetLabel(target)}.`;
  // A card that names a style (the tag is one, under two genres) settles the genre only.
  if (!suggestion.stylesVary || !audio || cardHasStyle) return `Suggested. ${why}`;
  const styles = audio.styles.filter(s => s.genre === target.genre).slice(0, 3).map(s => s.style!);
  return `Suggested. ${why} No style: the tracks sound like different ones (${listJoin(styles)}), and a style here would go on all ${count(totalTracks, 'track')}.`;
}

/** A style the sound gives few of these tracks: say so, and point to the genre alone. */
function styleHint(picked: GenreTarget[], audio: GenreAudioEvidence | null, totalTracks: number): string | null {
  if (!audio || audio.analysed < AUDIO_HINT_MIN_TRACKS) return null;
  const thin = picked.find(t => t.styleId !== null && audioTracks(audio, t) / audio.analysed < STYLE_HINT_SHARE);
  if (!thin) return null;
  return `Only ${audioTracks(audio, thin)} of the ${audio.analysed} analysed tracks sound most like ${thin.style}, but all ${count(totalTracks, 'track')} with this tag would get it. Choose ${thin.genre} alone if the style changes from track to track.`;
}

/** A labelled list of names with track counts (the artist review's release list). */
const CountList: React.FC<{ label: string; rows: Array<{ key: string; name: string; tracks: number }>; more: number }> = ({ label, rows, more }) => (
  <div className="entity-review-releases genre-review-counts">
    <span className="entity-review-releases__label">{label}</span>
    <ul>
      {rows.map(row => (
        <li key={row.key}>
          <span className="entity-review-releases__title">{row.name}</span>
          <span className="entity-review-releases__count">{row.tracks.toLocaleString()}</span>
        </li>
      ))}
    </ul>
    {more > 0 && <span className="entity-review-releases__more">{more} more</span>}
  </div>
);

/** What Aurora's own analysis of the audio files says about the tracks. */
const SoundSection: React.FC<{ audio: GenreAudioEvidence | null; totalTracks: number }> = ({ audio, totalTracks }) => {
  if (!audio) {
    return (
      <section className="genre-review-source">
        <h4 className="genre-review-source__title">How the tracks sound</h4>
        <p className="genre-review-source__desc">None of these tracks has been analysed yet.</p>
      </section>
    );
  }
  const lead = audio.genres[0]?.genre;
  const counted = audio.sampled
    ? `${audio.analysed.toLocaleString()} of the ${totalTracks.toLocaleString()} tracks, sampled`
    : audio.analysed === totalTracks ? `all ${count(totalTracks, 'track')}` : `${audio.analysed.toLocaleString()} of ${count(totalTracks, 'track')}`;
  return (
    <section className="genre-review-source">
      <h4 className="genre-review-source__title">How the tracks sound</h4>
      <p className="genre-review-source__desc">
        From Aurora's analysis of the audio in {counted}. Each track counts once, for the genre and style it sounds most like.
      </p>
      <div className="genre-review-source__lists">
        <CountList
          label="Genre"
          rows={audio.genres.slice(0, SOUND_ROWS).map(g => ({ key: g.genre, name: g.genre, tracks: g.tracks }))}
          more={Math.max(0, audio.genres.length - SOUND_ROWS)}
        />
        <CountList
          label="Style"
          rows={audio.styles.slice(0, SOUND_ROWS).map(s => ({
            key: targetKey(s),
            name: s.genre === lead ? s.style! : `${s.style} (${s.genre})`,
            tracks: s.tracks,
          }))}
          more={Math.max(0, audio.styles.length - SOUND_ROWS)}
        />
      </div>
    </section>
  );
};

/** Optional: what listeners tag the artists with. Hidden without provider data. */
const ArtistTagSection: React.FC<{ evidence: GenreReviewEvidence }> = ({ evidence }) => {
  const { artistTags, lean } = evidence;
  if (!artistTags && !lean) return null;
  const artist = evidence.artists[0]?.name;
  return (
    <section className="genre-review-source">
      <h4 className="genre-review-source__title">Artist tags</h4>
      <p className="genre-review-source__desc">
        {artistTags
          ? `What listeners tag ${artist} with on Last.fm and MusicBrainz, strongest first. They describe the artist, not single tracks.`
          : 'What listeners tag these artists with on Last.fm and MusicBrainz.'}
      </p>
      {artistTags ? (
        <ul className="genre-review-source__tags">
          {artistTags.map(tag => <li key={tag} className="entity-review-tag">{tag}</li>)}
        </ul>
      ) : lean && (
        <p className="genre-review-source__fact">Mostly {lean.genre} for {lean.artists} of {lean.of} artists</p>
      )}
    </section>
  );
};

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

  const suggestion = evidence?.suggestion ?? null;
  const suggestedId = suggestedOutcome(entry, suggestion)
    ?? (suggestion && sameTargets(picked, suggestion.targets) ? 'pick' : null);
  const suggestedTargets = suggestedId === 'pick' ? picked : entry.outcomes.find(o => o.id === suggestedId)?.targets || [];
  const reason = suggestion && evidence
    ? suggestionReason(suggestion, evidence.audio, entry.totalTracks, suggestedTargets.some(t => t.styleId !== null))
    : null;
  const why = (id: string) => id === suggestedId && reason ? <p className="genre-review-why">{reason}</p> : null;
  const hint = styleHint(picked, evidence?.audio ?? null, entry.totalTracks);

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

  const outcomes: ReviewPanelOutcome[] = entry.outcomes.map(outcome => ({
    id: outcome.id,
    label: outcome.id === suggestedId
      ? <>{outcome.label} <span className="entity-review-tag entity-review-tag--added">Suggested</span></>
      : outcome.label,
    body: evidence ? <>{outcomeBody(entry, outcome, evidence, picker)}{why(outcome.id)}</> : null,
  }));

  const artists = evidence?.artists || [];

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
          {evidence && (
            <div className="genre-review-sources">
              <SoundSection audio={evidence.audio} totalTracks={entry.totalTracks} />
              <ArtistTagSection evidence={evidence} />
            </div>
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
