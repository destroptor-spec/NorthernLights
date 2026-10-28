import React, { useState } from 'react';
import { Copy, Users } from 'lucide-react';
import type { SessionInvitePreview } from '../../shared/api/v1';
import { useListenTogetherStore } from '../store/listenTogether';
import { copyInviteLink, endTogether, setDiscoverable, setGigLevel, startGig } from '../utils/listenTogether';
import { GIG_LEVELS, gigLevelOf, sessionTitle } from '../utils/listenTogetherText';
import { AvatarStack, SessionPreviewAvatars } from './UserAvatar';

/**
 * The owner's gig, at the foot of the Connect card (Andreas, 2026-10-29):
 * a line like Output, "Start a gig" on the left and "Listen together" on the
 * right. Starting one makes the card longer, the devices above untouched:
 * "Make discoverable", "Copy invite link", the guests' level (three stops),
 * and End. While it runs, the line shows everyone in it, overlapping.
 */
export const GigSection: React.FC = () => {
  const own = useListenTogetherStore((s) => s.own);
  const [starting, setStarting] = useState(false);
  const [endArmed, setEndArmed] = useState(false);
  const running = !!own && (own.visibility !== 'private' || own.guests.length > 0);
  const people = running
    ? [...(own.ownerAvatar ? [own.ownerAvatar] : []), ...own.guests.map((guest) => guest.avatar)]
    : [];
  const level = gigLevelOf(own?.permissions);
  const discoverable = own?.visibility === 'discoverable';

  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await startGig();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className={`connect-gig${running ? ' is-running' : ''}`}>
      {running ? (
        <div className="connect-line" aria-label={`Your gig: ${people.length} ${people.length === 1 ? 'person' : 'people'}`}>
          <Users size={15} aria-hidden="true" className="shrink-0" />
          <span className="connect-line-label"><AvatarStack avatars={people} max={5} size="xs" /></span>
          <span className="connect-line-value">Listen together</span>
        </div>
      ) : (
        <button type="button" className="connect-line" disabled={starting} onClick={() => void start()}>
          <Users size={15} aria-hidden="true" className="shrink-0" />
          <span className="connect-line-label">Start a gig</span>
          <span className="connect-line-value">Listen together</span>
        </button>
      )}

      {/* Folds open (grid rows 0fr → 1fr) as the gig starts, and shut as it ends. */}
      <div className="connect-gig-body" inert={!running}>
        <div className="connect-gig-inner">
          <div className="connect-line">
            <span className="connect-line-label" id="gig-discoverable">Make discoverable</span>
            <button
              type="button"
              role="switch"
              aria-checked={discoverable}
              aria-labelledby="gig-discoverable"
              className="account-switch account-switch--sm"
              data-state={discoverable ? 'on' : 'off'}
              onClick={() => void setDiscoverable(!discoverable)}
            >
              <span className="account-switch__thumb" />
            </button>
          </div>
          <button type="button" className="connect-line" onClick={() => void copyInviteLink()}>
            <span className="connect-line-label">Copy invite link</span>
            <Copy size={15} aria-hidden="true" className="connect-line-icon" />
          </button>
          <div className="connect-line">
            <span className="connect-line-label">{GIG_LEVELS[level - 1].name}</span>
            <input
              type="range"
              className="gig-level"
              min={1}
              max={3}
              step={1}
              value={level}
              aria-label="What guests can do"
              aria-valuetext={GIG_LEVELS[level - 1].name}
              onChange={(event) => void setGigLevel(Number(event.target.value) as 1 | 2 | 3)}
            />
          </div>
          <button
            type="button"
            className={`btn btn-sm ${endArmed ? 'btn-danger-fill' : 'btn-danger'} connect-gig-end`}
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
            {endArmed ? 'End the gig? Tap to confirm' : 'End'}
          </button>
        </div>
      </div>
    </div>
  );
};

/** Discoverable gigs nearby, each with its preview and Join (6e). */
export const AvailableGigs: React.FC<{ gigs: SessionInvitePreview[]; onJoin: (gig: SessionInvitePreview) => void; disabled?: boolean }> = ({ gigs, onJoin, disabled }) => {
  if (gigs.length === 0) return null;
  return (
    <div className="connect-gigs">
      <span className="connect-section-title">Available gigs</span>
      {gigs.map((gig) => (
        <div key={gig.sessionId} className="connect-line">
          <SessionPreviewAvatars ownerName={gig.ownerName} owner={gig.owner} guests={gig.guests} size="sm" />
          <span className="connect-line-label">{sessionTitle(gig.ownerName)}</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={() => onJoin(gig)}>
            Join
          </button>
        </div>
      ))}
    </div>
  );
};

