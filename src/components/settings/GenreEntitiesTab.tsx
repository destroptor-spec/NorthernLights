import React, { useCallback, useEffect, useState } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { useReviewQueue } from '../../hooks/useReviewQueue';
import { ConfirmModal } from '../ConfirmModal';
import { ReviewEntryItem, ReviewQueue, ReviewSection } from './ReviewQueue';
import { GenreReviewEntry, type GenreChoice } from './GenreReviewEntry';
import type { GenreTaxonomy } from './StylePicker';
import {
  listJoin,
  targetLabel,
  type GenreReviewDecision,
  type GenreReviewEntry as Entry,
  type GenreReviewEvidence,
  type GenreReviewKind,
  type GenreReviewState,
} from '../../../shared/genreReview';

const BASE = '/api/library/genre-reviews';

const KIND_LABEL: Partial<Record<GenreReviewKind, string>> = {
  unmapped: 'No genre',
  'two-genres': 'Two genres',
  guessed: 'Guessed',
  compound: 'Several in one',
  spelling: 'Spellings',
};
const KIND_ORDER: GenreReviewKind[] = ['unmapped', 'two-genres', 'guessed', 'compound', 'spelling'];

/** The question on an entry's row, above the tag. */
export function genreQuestion(entry: Entry): string {
  const labels = entry.current.map(targetLabel);
  switch (entry.kind) {
    case 'unmapped': return 'Which genre?';
    case 'two-genres': return `${[...new Set(entry.current.map(t => t.genre))].join(' or ')}?`;
    case 'guessed': case 'compound': case 'exact': return `${listJoin(labels)}?`;
    case 'spelling': return (entry.spellings?.length ?? 0) > 2 ? 'One genre, several spellings?' : 'One genre, two spellings?';
    case 'reviewed': return listJoin(labels);
    case 'ignored': return 'Not a genre';
  }
}

const kindOf = (entry: Entry) => entry.kind;
const subject = (entry: Entry) => entry.subject;
const totalTracks = (entry: Entry) => entry.totalTracks;
const describeDecision = (decision: GenreReviewDecision) => decision.summary;
const tracks = (n: number) => `${n.toLocaleString()} track${n === 1 ? '' : 's'}`;

interface Decided { decisionId: string; summary: string }

/** Find a tag: any tag, reviewed or not, to change what it maps to. */
const FindTag: React.FC<{
  search: (q: string) => Promise<Entry[]>;
  loadPreview: (entry: Entry) => Promise<GenreReviewEvidence>;
  taxonomy: GenreTaxonomy | null;
  decide: (entry: Entry, choice: GenreChoice) => Promise<void>;
  version: number;
}> = ({ search, loadPreview, taxonomy, decide, version }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entry[] | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) { setResults(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      search(query).then(entries => { if (live) setResults(entries); }).catch(() => { if (live) setResults([]); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query, search, version]);

  return (
    <div className="entity-review-tool">
      <input
        type="search"
        className="entity-review-input"
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="Search tags…"
        aria-label="Search tags"
        autoComplete="off"
        spellCheck={false}
      />
      {results !== null && (results.length === 0 ? (
        <p className="entity-review-section__hint">No tag contains "{query.trim()}".</p>
      ) : (
        <ul className="entity-review-queue">
          {results.map(entry => {
            const open = openKey === entry.key;
            return (
              <ReviewEntryItem
                key={entry.key}
                open={open}
                panelId={`genre-find-${entry.key}`}
                question={genreQuestion(entry)}
                subject={entry.subject}
                tracks={entry.totalTracks}
                onToggle={() => setOpenKey(open ? null : entry.key)}
              >
                <GenreReviewEntry
                  entry={entry}
                  loadPreview={loadPreview}
                  taxonomy={taxonomy}
                  busy={busyKey === entry.key}
                  onApply={choice => {
                    setBusyKey(entry.key);
                    void decide(entry, choice).then(() => setOpenKey(null)).finally(() => setBusyKey(null));
                  }}
                  onSkip={() => setOpenKey(null)}
                  canSkip={false}
                />
              </ReviewEntryItem>
            );
          })}
        </ul>
      ))}
    </div>
  );
};

export const GenreEntitiesTab: React.FC = () => {
  const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);
  const { addToast } = useToast();
  const queue = useReviewQueue<Entry, GenreReviewDecision, GenreReviewEvidence, GenreReviewState>(BASE);
  const { state, post, get, refresh, undo, loadPreview } = queue;
  const [taxonomy, setTaxonomy] = useState<GenreTaxonomy | null>(null);
  const [conflict, setConflict] = useState<{ entry: Entry; resolve: (ok: boolean) => void } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    get<GenreTaxonomy>('/taxonomy').then(setTaxonomy).catch(e => console.error('Failed to load the genre list', e));
  }, [get]);

  const changed = useCallback(() => {
    setVersion(v => v + 1);
    void fetchLibraryFromServer();
  }, [fetchLibraryFromServer]);

  const undoAndRefresh = useCallback(async (decisionId: string) => {
    try {
      await undo(decisionId);
      await refresh();
      changed();
    } catch (e) {
      addToast((e as Error).message, 'error');
    }
  }, [undo, refresh, changed, addToast]);

  /** Decisions made outside the queue (bulk accept, Not genres, Find a tag): toast with Undo, refresh. */
  const run = useCallback(async (action: string, work: () => Promise<Decided | null>) => {
    setBusyAction(action);
    try {
      const result = await work();
      if (!result) return;
      addToast(result.summary, 'success', { actionLabel: 'Undo', onAction: () => { void undoAndRefresh(result.decisionId); } });
      await refresh();
      changed();
    } catch (e) {
      addToast((e as Error).message, 'error');
      await refresh();
    } finally {
      setBusyAction(null);
    }
  }, [addToast, undoAndRefresh, refresh, changed]);

  const askConflict = (entry: Entry) => new Promise<boolean>(resolve => setConflict({ entry, resolve }));

  // Posts one answer. Spellings in different parts of the old genre tree are confirmed first.
  const decide = useCallback(async (entry: Entry, choice: GenreChoice): Promise<Decided | null> => {
    const outcome = entry.outcomes.find(o => o.id === choice.outcomeId);
    let acknowledgeConflict = false;
    if (outcome?.kind === 'merge' && entry.taxonomyConflict) {
      if (!(await askConflict(entry))) return null;
      acknowledgeConflict = true;
    }
    const send = (ack: boolean) => post<Decided>('/decide', {
      key: entry.key, signature: entry.signature, outcomeId: choice.outcomeId, targets: choice.targets, acknowledgeConflict: ack,
    });
    try {
      return await send(acknowledgeConflict);
    } catch (e) {
      if ((e as Error & { code?: string }).code === 'GENRE_TAXONOMY_CONFLICT' && !acknowledgeConflict) {
        return (await askConflict(entry)) ? send(true) : null;
      }
      throw e;
    }
  }, [post]);

  const apply = useCallback(async (entry: Entry, choice: GenreChoice) => {
    const result = await decide(entry, choice);
    return result && { decisionId: result.decisionId, message: result.summary };
  }, [decide]);

  const search = useCallback(async (q: string) => (await get<{ entries: Entry[] }>(`/tags?q=${encodeURIComponent(q)}`)).entries, [get]);

  const coverage = state?.coverage;
  const percent = coverage ? Math.floor(coverage.ratio * 1000) / 10 : 0;
  const allReviewed = state !== null && state.entries.length === 0 && state.exact.length === 0;
  const exact = state?.exact || [];
  const ignored = state?.ignored || [];
  const grouped = (state?.groups || []).flatMap(group => group.aliases.map(alias => ({ alias, canonical: group.canonical })));

  return (
    <>
      <ReviewQueue<Entry, GenreReviewDecision, GenreChoice>
        entries={queue.entries}
        decisions={queue.decisions}
        loading={queue.loading}
        error={queue.error}
        refresh={refresh}
        undo={undo}
        apply={apply}
        kindOf={kindOf}
        kindLabels={KIND_LABEL as Record<string, string>}
        kindOrder={KIND_ORDER}
        question={genreQuestion}
        subject={subject}
        totalTracks={totalTracks}
        describeDecision={describeDecision}
        onChanged={changed}
        idPrefix="genre-review"
        emptyText="Questions show up here when a scan finds genre tags that don't match a genre or style by name."
        summary={coverage && (
          <div className="library-progress genre-review-meter">
            <div className="library-progress__label">
              <span>{allReviewed ? `Every tag is reviewed · ${percent.toFixed(1)} % of tagged tracks have a genre` : `${percent.toFixed(1)} % of tagged tracks have a genre`}</span>
              <span className="tabular-nums">{coverage.mapped.toLocaleString()} / {coverage.tagged.toLocaleString()}</span>
            </div>
            <div className="library-progress__track library-progress__track--compact" aria-hidden="true">
              <div
                className="library-progress__fill"
                data-state={coverage.ratio >= coverage.target ? 'complete' : 'partial'}
                style={{ width: `${Math.min(100, coverage.ratio * 100)}%` }}
              />
            </div>
          </div>
        )}
        renderPanel={(entry, context) => (
          <GenreReviewEntry
            entry={entry}
            loadPreview={loadPreview}
            taxonomy={taxonomy}
            busy={context.busy}
            onApply={context.onApply}
            onSkip={context.onSkip}
            canSkip={context.canSkip}
            autoFocus={context.autoFocus}
          />
        )}
        beforeDecided={exact.length > 0 && (
          <ReviewSection title="Name matches" count={exact.length}>
            <p className="entity-review-section__hint">
              These tags are a genre or style by name. Check the list, then accept them together; one Undo takes them all back.
            </p>
            <ul className="entity-review-decisions genre-review-matches">
              {exact.map(match => (
                <li key={match.key}>
                  <span className="entity-review-decisions__what">{match.subject} → {listJoin(match.targets.map(targetLabel))}</span>
                  <span className="entity-review-decisions__when tabular-nums">{tracks(match.tracks)}</span>
                </li>
              ))}
            </ul>
            <div className="entity-review-entry__actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busyAction !== null}
                onClick={() => void run('exact', () => post<Decided>('/accept-exact', {
                  items: exact.map(match => ({ key: match.key, signature: match.signature })),
                }))}
              >
                Accept all {exact.length}
              </button>
            </div>
          </ReviewSection>
        )}
      >
        {ignored.length > 0 && (
          <ReviewSection title="Not genres" count={ignored.length}>
            <p className="entity-review-section__hint">Tags that don't count as a genre. Built-in ones (Other, None, …) are skipped everywhere.</p>
            <ul className="entity-review-decisions">
              {ignored.map(tag => (
                <li key={tag.key}>
                  <span className="entity-review-decisions__what">{tag.subject}</span>
                  <span className="entity-review-decisions__when tabular-nums">{tracks(tag.tracks)}</span>
                  {tag.byHand ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busyAction !== null}
                      aria-label={`Restore ${tag.subject}`}
                      onClick={() => void run(tag.key, () => post<Decided>('/decide', { key: tag.key, signature: tag.signature, outcomeId: 'restore' }))}
                    >
                      Restore
                    </button>
                  ) : <span className="entity-review-decisions__when">Built in</span>}
                </li>
              ))}
            </ul>
          </ReviewSection>
        )}
        {grouped.length > 0 && (
          <ReviewSection title="Spellings kept as one" count={grouped.length}>
            <p className="entity-review-section__hint">The library's genre list shows each pair as one genre.</p>
            <ul className="entity-review-decisions">
              {grouped.map(({ alias, canonical }) => (
                <li key={alias.id}>
                  <span className="entity-review-decisions__what">{alias.name} → {canonical.name}</span>
                  <span />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busyAction !== null}
                    aria-label={`Separate ${alias.name} from ${canonical.name}`}
                    onClick={() => void run(alias.id, () => post<Decided>(`/groups/${encodeURIComponent(alias.id)}/separate`, {}))}
                  >
                    Separate
                  </button>
                </li>
              ))}
            </ul>
          </ReviewSection>
        )}
        <ReviewSection title="Find a tag">
          <FindTag
            search={search}
            loadPreview={loadPreview}
            taxonomy={taxonomy}
            version={version}
            decide={(entry, choice) => run(entry.key, () => decide(entry, choice))}
          />
        </ReviewSection>
      </ReviewQueue>

      {conflict && (
        <ConfirmModal
          title="Different parts of the genre tree"
          message={`${conflict.entry.subject} sit in different parts of the old genre tree. Keep them as one genre anyway?`}
          confirmLabel="Keep as one"
          confirmTone="primary"
          onConfirm={() => { conflict.resolve(true); setConflict(null); }}
          onCancel={() => { conflict.resolve(false); setConflict(null); }}
        />
      )}
    </>
  );
};
