import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, Link2, Share2 } from 'lucide-react';
import type { OnlineUser } from '../../shared/api/v1';
import { useListenTogetherStore } from '../store/listenTogether';
import { isPhoneOrTablet } from '../utils/deviceName';
import { endTogether, inviteUrl, inviteUser, loadOnlineUsers, refreshOwn, removeGuest, setSharing } from '../utils/listenTogether';
import { UserAvatar } from './UserAvatar';

/** How long Copy shows its check. */
export const COPIED_MS = 1500;

/**
 * The owner's sheet, inside the Connect card (docs/listen-together.md, UI):
 * who can join, the invite link, people online to invite, the guests with
 * Remove, and End listening together. Changes just take effect; text only
 * when something fails (a toast).
 */
export const ListenTogetherPanel: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const own = useListenTogetherStore((s) => s.own);
  const [online, setOnline] = useState<OnlineUser[] | null>(null);
  const [invited, setInvited] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState(false);
  // Shown to copy by hand when the clipboard refuses.
  const [manualLink, setManualLink] = useState<string | null>(null);
  const [endArmed, setEndArmed] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    void refreshOwn();
    void loadOnlineUsers().then((users) => { if (live) setOnline(users); });
    return () => {
      live = false;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const visibility = own?.visibility ?? 'private';
  const guests = own?.guests ?? [];
  const guestIds = new Set(guests.map((guest) => guest.avatar.userId));
  const invitable = (online ?? []).filter((user) => !guestIds.has(user.avatar.userId));
  const canShare = isPhoneOrTablet() && typeof navigator.share === 'function';

  const shareLink = async () => {
    const url = await inviteUrl();
    if (!url) return;
    if (canShare) {
      // Closing the share sheet without sharing is not an error.
      await navigator.share({ title: 'Listen together', url }).catch(() => undefined);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setManualLink(null);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setManualLink(url);
    }
  };

  const invite = async (userId: string) => {
    setInvited((current) => new Set(current).add(userId));
    if (!(await inviteUser(userId))) {
      setInvited((current) => {
        const next = new Set(current);
        next.delete(userId);
        return next;
      });
    }
  };

  return (
    <div className="connect-card together-panel" role="dialog" aria-label="Listen together">
      <div className="together-header">
        <button type="button" className="btn btn-icon btn-ghost together-back" onClick={onBack} aria-label="Back to Connect">
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <span className="connect-card-title">Listen together</span>
      </div>

      <div className="together-section">
        <span className="together-section-title" id="together-who">Who can join</span>
        <div className="together-segments" role="group" aria-labelledby="together-who">
          <button
            type="button"
            className={`btn btn-tab btn-sm${visibility === 'private' ? ' active' : ''}`}
            aria-pressed={visibility === 'private'}
            onClick={() => { if (visibility !== 'private') void setSharing('private'); }}
          >
            Private
          </button>
          <button
            type="button"
            className={`btn btn-tab btn-sm${visibility === 'invite' ? ' active' : ''}`}
            aria-pressed={visibility === 'invite'}
            onClick={() => { if (visibility !== 'invite') void setSharing('invite'); }}
          >
            Invite only
          </button>
        </div>
        <button type="button" className="btn btn-ghost together-link" onClick={() => void shareLink()}>
          {copied ? <Check size={16} aria-hidden="true" /> : canShare ? <Share2 size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}
          {canShare ? 'Share invite link' : 'Copy invite link'}
        </button>
        {manualLink && (
          <input
            className="together-link-text"
            readOnly
            value={manualLink}
            aria-label="Invite link"
            onFocus={(event) => event.currentTarget.select()}
            autoFocus
          />
        )}
      </div>

      {guests.length > 0 && (
        <div className="together-section">
          <span className="together-section-title">Listening with you</span>
          <ul className="together-people">
            {guests.map((guest) => (
              <li key={guest.avatar.userId} className="together-person">
                <UserAvatar avatar={guest.avatar} size="sm" />
                <span className="together-person-name">{guest.username}</span>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => void removeGuest(guest.avatar.userId)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {online !== null && (
        <div className="together-section">
          <span className="together-section-title">Online now</span>
          {invitable.length === 0 ? (
            <span className="together-empty">Nobody else has Aurora open.</span>
          ) : (
            <ul className="together-people">
              {invitable.map((user) => {
                const sent = invited.has(user.avatar.userId);
                return (
                  <li key={user.avatar.userId} className="together-person">
                    <UserAvatar avatar={user.avatar} size="sm" />
                    <span className="together-person-name">{user.username}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={sent}
                      onClick={() => void invite(user.avatar.userId)}
                      aria-label={sent ? `Invited ${user.username}` : `Invite ${user.username}`}
                    >
                      {sent ? <Check size={14} aria-hidden="true" /> : 'Invite'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {(guests.length > 0 || visibility !== 'private') && (
        <button
          type="button"
          className={`btn ${endArmed ? 'btn-danger-fill' : 'btn-danger'} together-end`}
          onClick={() => {
            // Ends it for everyone: the first tap asks.
            if (!endArmed) {
              setEndArmed(true);
              return;
            }
            setEndArmed(false);
            void endTogether();
          }}
        >
          {endArmed ? 'End for everyone? Tap to confirm' : 'End listening together'}
        </button>
      )}
    </div>
  );
};

export default ListenTogetherPanel;
