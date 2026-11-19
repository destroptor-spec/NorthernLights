import React, { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { usePlayerStore } from '../store/index';
import { useDialogFocus } from '../hooks/useDialogFocus';

const PRESETS = [15, 30, 45, 60, 90];
const MAX_MINUTES = 480;

/**
 * Sets the sleep timer (opened from the user menu): a preset or a number of
 * minutes. The music fades out over its last 20 seconds and pauses. One timer
 * at a time: the menu offers this only while none runs.
 */
export const SleepTimerModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const startSleepTimer = usePlayerStore((state) => state.startSleepTimer);
  const [minutes, setMinutes] = useState('30');
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDialogFocus(dialogRef, inputRef, onClose);

  const value = Number(minutes);
  const valid = Number.isInteger(value) && value >= 1 && value <= MAX_MINUTES;
  const start = (chosen: number) => {
    startSleepTimer(chosen);
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

        <div className="flex flex-wrap gap-2" role="group" aria-label="Presets">
          {PRESETS.map((preset) => (
            <button key={preset} type="button" className="btn btn-ghost btn-sm" onClick={() => start(preset)}>
              {preset} min
            </button>
          ))}
        </div>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) start(value);
          }}
        >
          <label className="flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
            Or
            <input
              ref={inputRef}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_MINUTES}
              step={1}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              aria-label="Minutes"
              className="w-24 px-3 py-2 rounded-xl bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors text-sm tabular-nums"
            />
            minutes
          </label>
          <div className="flex gap-3">
            <button type="submit" disabled={!valid} className="btn btn-primary flex-1 disabled:opacity-50 disabled:cursor-not-allowed">
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
