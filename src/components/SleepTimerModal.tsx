import React, { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { usePlayerStore } from '../store/index';
import { useDialogFocus } from '../hooks/useDialogFocus';

const MIN_MINUTES = 10;
const MAX_MINUTES = 90;
const STEP_MINUTES = 5;

/**
 * Sets the sleep timer (opened from the user menu) on a slider from 10 to 90
 * minutes. The music fades out over its last 20 seconds and pauses. One timer
 * at a time: the menu offers this only while none runs.
 */
export const SleepTimerModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const startSleepTimer = usePlayerStore((state) => state.startSleepTimer);
  const [minutes, setMinutes] = useState(30);
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDialogFocus(dialogRef, inputRef, onClose);

  const start = () => {
    startSleepTimer(minutes);
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative z-10 w-full max-w-sm bg-[var(--color-background)] border border-[var(--glass-border)] rounded-2xl p-6 shadow-2xl space-y-4 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <X size={18} />
        </button>
        <div>
          <h2 id={titleId} className="text-lg font-bold text-[var(--color-text-primary)]">Sleep timer</h2>
          <p id={descriptionId} className="text-sm text-[var(--color-text-secondary)] mt-1">
            The music fades out over the last 20 seconds and pauses.
          </p>
        </div>

        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <div>
            <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
              <span>Stop after</span>
              <span className="tabular-nums">{minutes} min</span>
            </label>
            <input
              ref={inputRef}
              type="range"
              min={MIN_MINUTES}
              max={MAX_MINUTES}
              step={STEP_MINUTES}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              aria-label="Minutes"
              aria-valuetext={`${minutes} minutes`}
              className="w-full accent-[var(--color-primary)]"
            />
            <div className="flex justify-between text-xs text-[var(--color-text-muted)] mt-1 tabular-nums" aria-hidden="true">
              <span>{MIN_MINUTES} min</span>
              <span>{MAX_MINUTES} min</span>
            </div>
          </div>
          <div className="flex gap-3">
            <button type="submit" className="btn btn-primary flex-1">
              Start
            </button>
            <button type="button" onClick={onClose} className="btn btn-ghost flex-1">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
};
