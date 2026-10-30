import React, { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import type { SessionInvitePreview } from '../../shared/api/v1';
import { useListenTogetherStore } from '../store/listenTogether';
import { endTogether, prepareInviteLink, setDiscoverable, setGigLevel, shareInviteLink, startGig } from '../utils/listenTogether';
import { GIG_LEVELS, gigLevelOf, gigRunning, sessionTitle } from '../utils/listenTogetherText';
import { AvatarStack, SessionPreviewAvatars } from './UserAvatar';

/**
 * The owner's gig, at the foot of the Connect card: a line like Output,
 * "Start a gig" on the left and "Listen together" on the right. Starting one
 * makes the card longer, the devices above untouched, with the gig's panel
 * (Andreas's mockup, 2026-10-30): everyone in it on its top edge, overlapping
 * (tapping them opens the members, GigMembers, and closes the card), "Guest
 * permissions" over three stops, filled up to the level, "Open session"
 * (discoverable), then End gig and Invite (the share sheet, or a copy of the
 * link where there is none: no Copy link line, Andreas 2026-10-30).
 */
export const GigSection: React.FC<{ onDone?: () => void }> = ({ onDone }) => {
  const own = useListenTogetherStore((s) => s.own);
  const ownSessionId = useListenTogetherStore((s) => s.ownSessionId);
  const [starting, setStarting] = useState(false);
  const [endArmed, setEndArmed] = useState(false);
  const running = gigRunning(own);
  const people = running
    ? [...(own!.ownerAvatar ? [own!.ownerAvatar] : []), ...own!.guests.map((guest) => guest.avatar)]
    : [];
  const level = gigLevelOf(own?.permissions);
  const discoverable = own?.visibility === 'discoverable';

  // Invite opens the share sheet at once only with the link already read.
  useEffect(() => {
    if (running) prepareInviteLink();
  }, [running, ownSessionId]);

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
      {!running && (
        <button type="button" className="connect-line" disabled={starting} onClick={() => void start()}>
          <Users size={15} aria-hidden="true" className="shrink-0" />
          <span className="connect-line-label">Start a gig</span>
          <span className="connect-line-value">Listen together</span>
        </button>
      )}

      {/* Folds open (grid rows 0fr → 1fr) as the gig starts, and shut as it ends. */}
      <div className="connect-gig-body" inert={!running}>
        <div className="connect-gig-inner">
          <div className="gig-panel">
            <button
              type="button"
              className="gig-people"
              aria-label={`Who's in your gig: ${people.length} ${people.length === 1 ? 'person' : 'people'}`}
              onClick={() => {
                onDone?.();
                useListenTogetherStore.setState({ membersOpen: true });
              }}
            >
              <AvatarStack avatars={people} max={3} size="sm" />
            </button>

            <div className="gig-row">
              <span className="gig-row-label" id="gig-level-label">Guest permissions</span>
              <span className="gig-row-value">{GIG_LEVELS[level - 1].name}</span>
            </div>
            <input
              type="range"
              className="gig-level"
              min={1}
              max={3}
              step={1}
              value={level}
              data-level={level}
              aria-labelledby="gig-level-label"
              aria-valuetext={GIG_LEVELS[level - 1].name}
              onChange={(event) => void setGigLevel(Number(event.target.value) as 1 | 2 | 3)}
            />

            <div className="gig-row">
              <span className="gig-row-label" id="gig-discoverable">Open session</span>
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

            <div className="gig-actions">
              <button
                type="button"
                className={`btn btn-sm ${endArmed ? 'btn-danger-fill' : 'btn-danger'}`}
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
                {endArmed ? 'End for everyone?' : 'End gig'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void shareInviteLink()}>
                Invite
              </button>
            </div>
          </div>
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

