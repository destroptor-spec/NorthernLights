import React, { useEffect, useId, useRef } from 'react';
import { Loader2 } from 'lucide-react';

export interface ReviewPanelOutcome {
  id: string;
  label: React.ReactNode;
  /** What the outcome changes; shown inside its card. */
  body?: React.ReactNode;
}

const OutcomeSkeleton: React.FC = () => (
  <div className="entity-review-outcome entity-review-outcome--skeleton" aria-hidden="true">
    <span /><span /><span />
  </div>
);

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    && !(target instanceof HTMLInputElement && target.type === 'radio'));

/**
 * The open entry of a review queue: evidence, the outcomes as cards (one is
 * chosen), Skip and Apply. Keys 1–9 choose an outcome, S skips, Enter applies.
 * While `ready` is false the outcome cards show skeletons.
 */
export const ReviewPanel: React.FC<{
  evidence?: React.ReactNode;
  outcomes: ReviewPanelOutcome[];
  ready: boolean;
  error?: string | null;
  chosen: string | null;
  onChoose: (id: string) => void;
  /** Apply stays disabled while this is false (default: an outcome is chosen). */
  canApply?: boolean;
  busy: boolean;
  onApply: () => void;
  onSkip: () => void;
  canSkip: boolean;
  /** Focus the panel when it opens, so the keys work right after the previous decision. */
  autoFocus?: boolean;
}> = ({ evidence, outcomes, ready, error, chosen, onChoose, canApply, busy, onApply, onSkip, canSkip, autoFocus }) => {
  const groupName = useId();
  const ref = useRef<HTMLDivElement>(null);
  const applyEnabled = !busy && chosen !== null && (canApply ?? true);

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (busy || event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
    const index = Number(event.key) - 1;
    if (ready && Number.isInteger(index) && index >= 0 && index < outcomes.length) {
      event.preventDefault();
      onChoose(outcomes[index].id);
    } else if ((event.key === 's' || event.key === 'S') && canSkip) {
      event.preventDefault();
      onSkip();
    } else if (event.key === 'Enter' && applyEnabled && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      onApply();
    }
  };

  return (
    <div className="entity-review-entry__panel" ref={ref} tabIndex={-1} onKeyDown={onKeyDown}>
      {evidence}

      {error ? (
        <p className="entity-review-error" role="alert">{error}</p>
      ) : (
        <fieldset className="entity-review-outcomes">
          <legend className="sr-only">Choose an outcome</legend>
          {outcomes.map((outcome, index) => (
            ready ? (
              <label key={outcome.id} className="entity-review-outcome" data-selected={chosen === outcome.id ? 'true' : 'false'}>
                <input
                  type="radio"
                  className="sr-only"
                  name={groupName}
                  value={outcome.id}
                  aria-labelledby={`${groupName}-${index}-label`}
                  aria-describedby={outcome.body ? `${groupName}-${index}-body` : undefined}
                  checked={chosen === outcome.id}
                  onChange={() => onChoose(outcome.id)}
                  disabled={busy}
                />
                <span className="entity-review-outcome__label">
                  <span className="entity-review-outcome__text" id={`${groupName}-${index}-label`}>{outcome.label}</span>
                  {index < 9 && <kbd className="keyboard-hint-key entity-review-key" aria-hidden="true">{index + 1}</kbd>}
                </span>
                {outcome.body && <div className="entity-review-outcome__body" id={`${groupName}-${index}-body`}>{outcome.body}</div>}
              </label>
            ) : <OutcomeSkeleton key={outcome.id} />
          ))}
        </fieldset>
      )}

      <div className="entity-review-entry__actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onSkip} disabled={busy || !canSkip}>
          Skip
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onApply} disabled={!applyEnabled}>
          {busy && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
          Apply
        </button>
      </div>
    </div>
  );
};
