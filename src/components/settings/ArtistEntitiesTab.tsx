import React, { useCallback, useMemo, useState } from 'react';
import { ChevronDown, RefreshCw, Loader2, Undo2 } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { useArtistReviews } from '../../hooks/useArtistReviews';
import { ArtistReviewEntry, REVIEW_QUESTION } from './ArtistReviewEntry';
import { ManualArtistMerge } from './ManualArtistMerge';
import type { ArtistReviewDecision, ArtistReviewEntry as Entry, ArtistReviewKind } from '../../../shared/artistReview';

const KIND_LABEL: Record<ArtistReviewKind, string> = {
  'joined-credit': 'One act or two',
  'same-identity': 'Spellings',
  'same-musicbrainz': 'Same MusicBrainz artist',
  'compound-credit': 'Credit rows',
};
const KIND_ORDER: ArtistReviewKind[] = ['joined-credit', 'same-musicbrainz', 'same-identity', 'compound-credit'];

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

function decidedOn(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

const QueueSkeleton: React.FC = () => (
  <ul className="artist-review-queue" aria-hidden="true">
    {[0, 1, 2].map(i => <li key={i} className="artist-review-entry artist-review-entry--skeleton"><span /><span /></li>)}
  </ul>
);

export const ArtistEntitiesTab: React.FC = () => {
  const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);
  const { addToast } = useToast();
  const { entries, decisions, loading, refresh, loadPreview, decide, undo } = useArtistReviews();

  const [kind, setKind] = useState<ArtistReviewKind | 'all'>('all');
  // null: the first entry is open; '': all closed.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  const kinds = useMemo(() => {
    const counts = new Map<ArtistReviewKind, number>();
    for (const entry of entries || []) counts.set(entry.kind, (counts.get(entry.kind) || 0) + 1);
    return KIND_ORDER.filter(k => counts.has(k)).map(k => ({ kind: k, count: counts.get(k)! }));
  }, [entries]);

  // Skipped entries move to the end for this visit.
  const visible = useMemo(() => {
    const shown = (entries || []).filter(entry => kind === 'all' || entry.kind === kind);
    const rank = (entry: Entry) => skipped.indexOf(entry.key);
    return [...shown].sort((a, b) => rank(a) - rank(b));
  }, [entries, kind, skipped]);

  const active = activeKey === '' ? null : visible.find(entry => entry.key === activeKey) || visible[0] || null;
  const nextAfter = useCallback((key: string) => {
    const index = visible.findIndex(entry => entry.key === key);
    return visible[index + 1]?.key ?? visible.find(entry => entry.key !== key)?.key ?? '';
  }, [visible]);

  const undoDecision = useCallback(async (decisionId: string) => {
    setUndoingId(decisionId);
    try {
      await undo(decisionId);
      await refresh();
      void fetchLibraryFromServer();
    } catch (e) {
      addToast((e as Error).message, 'error');
    } finally {
      setUndoingId(null);
    }
  }, [undo, refresh, fetchLibraryFromServer, addToast]);

  const apply = useCallback(async (entry: Entry, outcomeId: string) => {
    setBusyKey(entry.key);
    try {
      const decisionId = await decide(entry, outcomeId);
      addToast(describeDecision(decisionFor(entry, outcomeId)), 'success',
        { actionLabel: 'Undo', onAction: () => { void undoDecision(decisionId); } });
      setActiveKey(nextAfter(entry.key));
      await refresh();
      void fetchLibraryFromServer();
    } catch (e) {
      addToast((e as Error).message, 'error');
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }, [decide, addToast, undoDecision, refresh, fetchLibraryFromServer, nextAfter]);

  const skip = (entry: Entry) => {
    setSkipped(prev => [...prev.filter(key => key !== entry.key), entry.key]);
    setActiveKey(nextAfter(entry.key));
  };

  const total = entries?.length ?? 0;

  return (
    <div className="settings-section artist-review">
      <header className="artist-review__header">
        <p className="artist-review__count">
          {entries === null ? ' ' : total === 0 ? 'Nothing to review' : `${total} to review`}
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Check again"
          title="Check again"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
        </button>
      </header>

      {kinds.length > 1 && (
        <div className="artist-review__filters" role="group" aria-label="Show">
          <button type="button" className={`btn-tab ${kind === 'all' ? 'active' : ''}`} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
            All <span className="tabular-nums">{total}</span>
          </button>
          {kinds.map(k => (
            <button
              key={k.kind}
              type="button"
              className={`btn-tab ${kind === k.kind ? 'active' : ''}`}
              aria-pressed={kind === k.kind}
              onClick={() => setKind(k.kind)}
            >
              {KIND_LABEL[k.kind]} <span className="tabular-nums">{k.count}</span>
            </button>
          ))}
        </div>
      )}

      {entries === null ? <QueueSkeleton /> : total === 0 ? (
        <p className="artist-review__empty">
          Questions show up here when a scan finds artists the files don't settle on their own, like two spellings of one name.
        </p>
      ) : (
        <ul className="artist-review-queue">
          {visible.map(entry => {
            const open = active?.key === entry.key;
            const panelId = `artist-review-${entry.key}`;
            return (
              <li key={entry.key} className="artist-review-entry" data-open={open ? 'true' : 'false'}>
                <button
                  type="button"
                  className="artist-review-entry__row"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => setActiveKey(open ? '' : entry.key)}
                >
                  <span className="artist-review-entry__question">{REVIEW_QUESTION[entry.kind]}</span>
                  <span className="artist-review-entry__subject">{entry.subject}</span>
                  <span className="artist-review-entry__meta tabular-nums">
                    {entry.totalTracks} track{entry.totalTracks === 1 ? '' : 's'}
                  </span>
                  <ChevronDown size={16} className="artist-review-entry__chevron" aria-hidden="true" />
                </button>
                {open && (
                  <div id={panelId}>
                    <ArtistReviewEntry
                      entry={entry}
                      loadPreview={loadPreview}
                      busy={busyKey === entry.key}
                      onApply={outcomeId => void apply(entry, outcomeId)}
                      onSkip={() => skip(entry)}
                      canSkip={visible.length > 1}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {decisions.length > 0 && (
        <details className="artist-review-section">
          <summary>
            Decided <span className="artist-review-section__count tabular-nums">{decisions.length}</span>
            <ChevronDown size={15} aria-hidden="true" />
          </summary>
          <p className="artist-review-section__hint">Each decision can be undone for 30 days.</p>
          <ul className="artist-review-decisions">
            {decisions.map(decision => (
              <li key={decision.id}>
                <span className="artist-review-decisions__what">{describeDecision(decision)}</span>
                <span className="artist-review-decisions__when">{decidedOn(decision.decidedAt)}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void undoDecision(decision.id)}
                  disabled={undoingId !== null}
                  aria-label={`Undo: ${describeDecision(decision)}`}
                >
                  {undoingId === decision.id
                    ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                    : <Undo2 size={13} aria-hidden="true" />}
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <details className="artist-review-section">
        <summary>
          Manual merge
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <ManualArtistMerge onMerged={() => void refresh()} />
      </details>
    </div>
  );
};
