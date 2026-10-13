import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ConfirmModalProps {
  title: string;
  message?: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmTone?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * The second button's own action. Without it, that button cancels; with
   * it, only Escape, the backdrop and the close button cancel.
   */
  onCancelButton?: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title,
  message,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmTone = 'danger',
  onConfirm,
  onCancel,
  onCancelButton,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButtonRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }

      if (e.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter(element => !element.hasAttribute('aria-hidden'));

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previouslyFocused?.focus();
    };
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={`relative z-10 w-full ${body ? 'max-w-2xl' : 'max-w-md'} bg-[var(--color-background)] border border-[var(--glass-border)] rounded-2xl p-6 shadow-2xl space-y-4 animate-slide-up`}
        onClick={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close confirmation"
          className="absolute top-4 right-4 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <X size={18} />
        </button>

        <div>
          <h2 id={titleId} className="text-lg font-bold text-[var(--color-text-primary)]">{title}</h2>
          {message && (
            <p id={descriptionId} className="text-sm text-[var(--color-text-secondary)] mt-2">{message}</p>
          )}
        </div>

        {body && (
          <div id={message ? undefined : descriptionId} className="text-sm text-[var(--color-text-secondary)]">
            {body}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={onConfirm}
            className={`btn ${confirmTone === 'primary' ? 'btn-primary' : 'btn-danger-fill'} flex-1 py-2.5`}
          >
            {confirmLabel}
          </button>
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancelButton ?? onCancel}
            className="btn btn-ghost flex-1 py-2.5"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
