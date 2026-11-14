import React, { useCallback, useMemo, useState } from 'react';
import { ChevronDown, Loader2, RefreshCw, Undo2 } from 'lucide-react';
import { useToast } from '../../hooks/useToast';

export interface ReviewPanelContext<Choice> {
  busy: boolean;
  onApply: (choice: Choice) => void;
  onSkip: () => void;
  canSkip: boolean;
  /** The entry opened because the previous one was decided. */
  autoFocus: boolean;
}

export function decidedOn(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

const QueueSkeleton: React.FC = () => (
  <ul className="entity-review-queue" aria-hidden="true">
    {[0, 1, 2].map(i => <li key={i} className="entity-review-entry entity-review-entry--skeleton"><span /><span /></li>)}
  </ul>
);

const trackCount = (n: number) => `${n.toLocaleString()} track${n === 1 ? '' : 's'}`;

/** One question in a queue: the row (question, subject, tracks) and, when open, its panel. */
export const ReviewEntryItem: React.FC<{
  open: boolean;
  panelId: string;
  question: React.ReactNode;
  subject: React.ReactNode;
  tracks: number;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ open, panelId, question, subject, tracks, onToggle, children }) => (
  <li className="entity-review-entry" data-open={open ? 'true' : 'false'}>
    <button type="button" className="entity-review-entry__row" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
      <span className="entity-review-entry__question">{question}</span>
      <span className="entity-review-entry__subject">{subject}</span>
      <span className="entity-review-entry__meta tabular-nums">{trackCount(tracks)}</span>
      <ChevronDown size={16} className="entity-review-entry__chevron" aria-hidden="true" />
    </button>
    {open && <div id={panelId}>{children}</div>}
  </li>
);

/** A collapsed section under the queue (Decided, Manual merge, …). */
export const ReviewSection: React.FC<{ title: React.ReactNode; count?: number; children: React.ReactNode; defaultOpen?: boolean }> = (
  { title, count, children, defaultOpen },
) => (
  <details className="entity-review-section" open={defaultOpen}>
    <summary>
      {title}
      {count !== undefined && <span className="entity-review-section__count tabular-nums">{count}</span>}
      <ChevronDown size={15} aria-hidden="true" />
    </summary>
    {children}
  </details>
);

/** The Decided list: each decision in words, with Undo for 30 days. */
export function DecidedSection<Decision extends { id: string; decidedAt: string }>({ decisions, describe, onUndo, undoingId }: {
  decisions: Decision[];
  describe: (decision: Decision) => string;
  onUndo: (decisionId: string) => void;
  undoingId: string | null;
}) {
  if (decisions.length === 0) return null;
  return (
    <ReviewSection title="Decided" count={decisions.length}>
      <p className="entity-review-section__hint">Each decision can be undone for 30 days.</p>
      <ul className="entity-review-decisions">
        {decisions.map(decision => (
          <li key={decision.id}>
            <span className="entity-review-decisions__what">{describe(decision)}</span>
            <span className="entity-review-decisions__when">{decidedOn(decision.decidedAt)}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onUndo(decision.id)}
              disabled={undoingId !== null}
              aria-label={`Undo: ${describe(decision)}`}
            >
              {undoingId === decision.id
                ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                : <Undo2 size={13} aria-hidden="true" />}
              Undo
            </button>
          </li>
        ))}
      </ul>
    </ReviewSection>
  );
}

export interface ReviewQueueProps<Entry extends { key: string }, Decision extends { id: string; decidedAt: string }, Choice> {
  entries: Entry[] | null;
  decisions: Decision[];
  loading: boolean;
  error?: string | null;
  refresh: () => Promise<void>;
  undo: (decisionId: string) => Promise<void>;
  /** Applies a choice; resolves to the new decision id and its toast text, or null when cancelled. */
  apply: (entry: Entry, choice: Choice) => Promise<{ decisionId: string; message: string } | null>;
  kindOf: (entry: Entry) => string;
  kindLabels: Record<string, string>;
  kindOrder: string[];
  question: (entry: Entry) => string;
  subject: (entry: Entry) => React.ReactNode;
  totalTracks: (entry: Entry) => number;
  renderPanel: (entry: Entry, context: ReviewPanelContext<Choice>) => React.ReactNode;
  describeDecision: (decision: Decision) => string;
  emptyText: React.ReactNode;
  /** Shown above the count (the Genres coverage meter). */
  summary?: React.ReactNode;
  /** Sections between the queue and Decided (bulk accepts). */
  beforeDecided?: React.ReactNode;
  /** Sections after Decided (manual tools). */
  children?: React.ReactNode;
  /** After any decision or undo: refresh library views. */
  onChanged?: () => void;
  idPrefix: string;
}

/**
 * A decision queue in Settings → Library entities: kind filters, one entry
 * open at a time, Skip moves an entry to the end, a decision shows an Undo
 * toast and opens the next entry, and recent decisions can be undone.
 */
export function ReviewQueue<Entry extends { key: string }, Decision extends { id: string; decidedAt: string }, Choice>(
  props: ReviewQueueProps<Entry, Decision, Choice>,
) {
  const { entries, decisions, loading, error, refresh, undo, apply, kindOf, kindLabels, kindOrder, question, subject,
    totalTracks, renderPanel, describeDecision, emptyText, summary, beforeDecided, children, onChanged, idPrefix } = props;
  const { addToast } = useToast();
  const [kind, setKind] = useState<string>('all');
  // null: the first entry is open; '': all closed.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries || []) counts.set(kindOf(entry), (counts.get(kindOf(entry)) || 0) + 1);
    return kindOrder.filter(k => counts.has(k)).map(k => ({ kind: k, count: counts.get(k)! }));
  }, [entries, kindOf, kindOrder]);

  // Skipped entries move to the end for this visit.
  const visible = useMemo(() => {
    const shown = (entries || []).filter(entry => kind === 'all' || kindOf(entry) === kind);
    const rank = (entry: Entry) => skipped.indexOf(entry.key);
    return [...shown].sort((a, b) => rank(a) - rank(b));
  }, [entries, kind, kindOf, skipped]);

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
      onChanged?.();
    } catch (e) {
      addToast((e as Error).message, 'error');
    } finally {
      setUndoingId(null);
    }
  }, [undo, refresh, onChanged, addToast]);

  const applyChoice = useCallback(async (entry: Entry, choice: Choice) => {
    setBusyKey(entry.key);
    try {
      const result = await apply(entry, choice);
      if (!result) return;
      addToast(result.message, 'success', { actionLabel: 'Undo', onAction: () => { void undoDecision(result.decisionId); } });
      setActiveKey(nextAfter(entry.key));
      setAdvanced(true);
      await refresh();
      onChanged?.();
    } catch (e) {
      addToast((e as Error).message, 'error');
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }, [apply, addToast, undoDecision, refresh, onChanged, nextAfter]);

  const skip = (entry: Entry) => {
    setSkipped(prev => [...prev.filter(key => key !== entry.key), entry.key]);
    setActiveKey(nextAfter(entry.key));
    setAdvanced(true);
  };

  const total = entries?.length ?? 0;

  return (
    <div className="settings-section entity-review">
      <header className="entity-review__header">
        <div className="entity-review__summary">
          {summary}
          <p className="entity-review__count">
            {entries === null ? (error ? '' : ' ') : total === 0 ? 'Nothing to review' : `${total} to review`}
          </p>
        </div>
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

      {error && entries === null && (
        <p className="entity-review-error" role="alert">
          {error}{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()}>Retry</button>
        </p>
      )}

      {kinds.length > 1 && (
        <div className="entity-review__filters" role="group" aria-label="Show">
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
              {kindLabels[k.kind]} <span className="tabular-nums">{k.count}</span>
            </button>
          ))}
        </div>
      )}

      {entries === null ? (error ? null : <QueueSkeleton />) : total === 0 ? (
        <p className="entity-review__empty">{emptyText}</p>
      ) : (
        <ul className="entity-review-queue">
          {visible.map(entry => {
            const open = active?.key === entry.key;
            const panelId = `${idPrefix}-${entry.key}`;
            return (
              <ReviewEntryItem
                key={entry.key}
                open={open}
                panelId={panelId}
                question={question(entry)}
                subject={subject(entry)}
                tracks={totalTracks(entry)}
                onToggle={() => { setAdvanced(false); setActiveKey(open ? '' : entry.key); }}
              >
                {renderPanel(entry, {
                  busy: busyKey === entry.key,
                  onApply: choice => void applyChoice(entry, choice),
                  onSkip: () => skip(entry),
                  canSkip: visible.length > 1,
                  autoFocus: advanced,
                })}
              </ReviewEntryItem>
            );
          })}
        </ul>
      )}

      {beforeDecided}
      <DecidedSection decisions={decisions} describe={describeDecision} onUndo={id => void undoDecision(id)} undoingId={undoingId} />
      {children}
    </div>
  );
}
