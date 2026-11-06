import React, { useCallback } from 'react';
import { usePlayerStore } from '../../store/index';
import { useReviewQueue } from '../../hooks/useReviewQueue';
import { ArtistReviewEntry, REVIEW_QUESTION } from './ArtistReviewEntry';
import { ManualArtistMerge } from './ManualArtistMerge';
import { ReviewQueue, ReviewSection } from './ReviewQueue';
import type { ArtistReviewDecision, ArtistReviewEntry as Entry, ArtistReviewKind, ArtistReviewPreview } from '../../../shared/artistReview';

const KIND_LABEL: Record<ArtistReviewKind, string> = {
  'joined-credit': 'One act or two',
  'people-credit': 'Several people',
  'same-identity': 'Spellings',
  'same-musicbrainz': 'Same MusicBrainz artist',
  'compound-credit': 'Credit rows',
};
const KIND_ORDER: ArtistReviewKind[] = ['joined-credit', 'people-credit', 'same-musicbrainz', 'same-identity', 'compound-credit'];

const list = (names: string[]) => names.length <= 1 ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** What a decision did, in a sentence for the Decided list and the toast. */
export function describeDecision(decision: Pick<ArtistReviewDecision, 'decision' | 'names'>): string {
  const [first, ...rest] = decision.names;
  switch (decision.decision) {
    case 'merged': return `Merged ${list(rest)} into ${first}`;
    case 'dismissed': return `Kept ${list(decision.names)} apart`;
    case 'kept': return `Kept ${first} together`;
    case 'split': return `Split ${first} into ${list(rest)}`;
  }
}

// The decision an outcome records, for the toast after applying it.
function decisionFor(entry: Entry, outcomeId: string): Pick<ArtistReviewDecision, 'decision' | 'names'> {
  if (outcomeId === 'split') return { decision: 'split', names: [entry.subject, ...(entry.splitInto || [])] };
  if (outcomeId === 'keep-together') return { decision: 'kept', names: [entry.subject] };
  if (outcomeId === 'keep-apart') return { decision: 'dismissed', names: entry.artists.map(a => a.name) };
  const canonical = entry.artists.find(a => `merge:${a.id}` === outcomeId);
  return { decision: 'merged', names: [canonical?.name || '', ...entry.artists.filter(a => a !== canonical).map(a => a.name)] };
}

const kindOf = (entry: Entry) => entry.kind;
const question = (entry: Entry) => REVIEW_QUESTION[entry.kind];
const subject = (entry: Entry) => entry.subject;
const totalTracks = (entry: Entry) => entry.totalTracks;

export const ArtistEntitiesTab: React.FC = () => {
  const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);
  const queue = useReviewQueue<Entry, ArtistReviewDecision, ArtistReviewPreview>('/api/library/artist-reviews');
  const { decide, loadPreview, refresh } = queue;

  const apply = useCallback(async (entry: Entry, outcomeId: string) => {
    const decisionId = await decide(entry, { outcomeId });
    return { decisionId, message: describeDecision(decisionFor(entry, outcomeId)) };
  }, [decide]);

  return (
    <ReviewQueue<Entry, ArtistReviewDecision, string>
      entries={queue.entries}
      decisions={queue.decisions}
      loading={queue.loading}
      error={queue.error}
      refresh={refresh}
      undo={queue.undo}
      apply={apply}
      kindOf={kindOf}
      kindLabels={KIND_LABEL}
      kindOrder={KIND_ORDER}
      question={question}
      subject={subject}
      totalTracks={totalTracks}
      describeDecision={describeDecision}
      onChanged={() => void fetchLibraryFromServer()}
      idPrefix="artist-review"
      emptyText="Questions show up here when a scan finds artists the files don't settle on their own, like two spellings of one name."
      renderPanel={(entry, context) => (
        <ArtistReviewEntry
          entry={entry}
          loadPreview={loadPreview}
          busy={context.busy}
          onApply={context.onApply}
          onSkip={context.onSkip}
          canSkip={context.canSkip}
          autoFocus={context.autoFocus}
        />
      )}
    >
      <ReviewSection title="Manual merge">
        <ManualArtistMerge onMerged={() => void refresh()} />
      </ReviewSection>
    </ReviewQueue>
  );
};
