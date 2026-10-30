import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useListenTogetherStore, type OwnTogether } from '../store/listenTogether';
import { removeGuest } from '../utils/listenTogether';
import { gigRunning } from '../utils/listenTogetherText';
import { UserAvatar } from './UserAvatar';

const close = () => useListenTogetherStore.setState({ membersOpen: false });

/**
 * Who's in the owner's gig (Andreas, 2026-10-30): opened by tapping the
 * avatars on the gig's panel. The owner first, then each guest with Remove.
 * Mounted at app level: the Connect card closes on a tap outside it, so the
 * card closes as this opens. Closes itself when the gig ends.
 */
export const GigMembers: React.FC = () => {
  const open = useListenTogetherStore((s) => s.membersOpen);
  const own = useListenTogetherStore((s) => s.own);
  const running = gigRunning(own);

  useEffect(() => {
    if (open && !running) close();
  }, [open, running]);

  if (!open || !running) return null;
  return <GigMembersDialog own={own!} />;
};

const GigMembersDialog: React.FC<{ own: OwnTogether }> = ({ own }) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCancel = useCallback(close, []);
  // Focus starts on the dialog itself: no ring on Close as it opens.
  useDialogFocus(dialogRef, dialogRef, onCancel);

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4" onClick={close}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="gig-members relative z-10 w-full max-w-sm bg-[var(--color-background)] border border-[var(--glass-border)] rounded-2xl p-6 shadow-2xl animate-slide-up"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="absolute top-4 right-4 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <X size={18} />
        </button>
        <h2 id={titleId} className="text-lg font-bold text-[var(--color-text-primary)]">Your gig</h2>

        <ul className="gig-members-list">
          {own.ownerAvatar && (
            <li className="gig-member">
              <UserAvatar avatar={own.ownerAvatar} size="md" />
              <span className="gig-member-name">{own.ownerName ?? 'You'}</span>
              <span className="gig-member-role">Owner</span>
            </li>
          )}
          {own.guests.map((guest) => (
            <li key={guest.avatar.userId} className="gig-member">
              <UserAvatar avatar={guest.avatar} size="md" />
              <span className="gig-member-name">{guest.username}</span>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                aria-label={`Remove ${guest.username}`}
                onClick={() => void removeGuest(guest.avatar.userId)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
};
