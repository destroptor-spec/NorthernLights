import React, { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import type { SessionInvitePreview, UserAvatar as UserAvatarData } from '../../shared/api/v1';
import { useListenTogetherStore } from '../store/listenTogether';
import { endTogether, prepareInviteLink, setDiscoverable, setGigLevel, shareInviteLink, startGig } from '../utils/listenTogether';
import { GIG_LEVELS, gigLevelOf, gigRunning, sessionTitle } from '../utils/listenTogetherText';
import { AvatarStack, SessionPreviewAvatars, UserAvatar } from './UserAvatar';

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
/** The owner's gig as the gig controls read it (Connect card and the desktop queue sidebar). */
export function useOwnGig() {
  const own = useListenTogetherStore((s) => s.own);
  const ownSessionId = useListenTogetherStore((s) => s.ownSessionId);
  const [starting, setStarting] = useState(false);
  const running = gigRunning(own);
  const people = running
    ? [...(own!.ownerAvatar ? [own!.ownerAvatar] : []), ...own!.guests.map((guest) => guest.avatar)]
    : [];

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

  return { own, running, people, starting, start };
}

/** Everyone in the gig, overlapping; opens the members (GigMembers). */
export const GigPeople: React.FC<{ people: UserAvatarData[]; onOpen?: () => void }> = ({ people, onOpen }) => (
  <button
    type="button"
    className="gig-people"
    aria-label={`Who's in your gig: ${people.length} ${people.length === 1 ? 'person' : 'people'}`}
    onClick={() => {
      onOpen?.();
      useListenTogetherStore.setState({ membersOpen: true });
    }}
  >
    <AvatarStack avatars={people} max={3} size="sm" />
  </button>
);

/** "Guest permissions" over three stops, filled up to the level. */
export const GigLevel: React.FC<{ permissions?: readonly string[] | null }> = ({ permissions }) => {
  const level = gigLevelOf(permissions);
  return (
    <>
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
    </>
  );
};

/** "Open session": others nearby can find and join the gig (discoverable). */
export const GigOpenSession: React.FC<{ discoverable: boolean }> = ({ discoverable }) => (
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
);

/** Ends the gig for everyone: the first tap asks. */
export const EndGigButton: React.FC<{ className?: string }> = ({ className = 'btn-danger' }) => {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={`btn btn-sm ${armed ? 'btn-danger-fill' : className}`}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        void endTogether();
      }}
    >
      {armed ? 'End for everyone?' : 'End gig'}
    </button>
  );
};

/** The share sheet, or a copy of the link where there is none. */
export const InviteButton: React.FC<{ className?: string }> = ({ className = 'btn btn-ghost btn-sm' }) => (
  <button type="button" className={className} onClick={() => void shareInviteLink()}>
    Invite
  </button>
);

/**
 * The owner's gig, at the foot of the Connect card: a line like Output,
 * "Start a gig" on the left and "Listen together" on the right. Starting one
 * makes the card longer, the devices above untouched, with the gig's panel
 * (Andreas's mockup, 2026-10-30): everyone in it on its top edge, overlapping
 * (tapping them opens the members, GigMembers, and closes the card), "Guest
 * permissions" over three stops, filled up to the level, "Open session"
 * (discoverable), then End gig and Invite (the share sheet, or a copy of the
 * link where there is none: no Copy link line, Andreas 2026-10-30).
 * On desktop, with the queue sidebar open, the gig is there instead (QueueSidebarGig).
 */
export const GigSection: React.FC<{ onDone?: () => void }> = ({ onDone }) => {
  const { own, running, people, starting, start } = useOwnGig();

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
            <GigPeople people={people} onOpen={onDone} />
            <GigLevel permissions={own?.permissions} />
            <GigOpenSession discoverable={own?.visibility === 'discoverable'} />
            <div className="gig-actions">
              <EndGigButton />
              <InviteButton />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * "Join Bo's Gig": the owner's avatar on the left, and a border whose light
 * slowly travels round it (.gig-join). The desktop queue sidebar's way into a
 * gig nearby, or into one the user is a guest in on another device.
 */
export const GigJoinButton: React.FC<{
  ownerName: string | null;
  owner: UserAvatarData | null;
  onJoin: () => void;
  disabled?: boolean;
}> = ({ ownerName, owner, onJoin, disabled }) => (
  <button type="button" className="gig-join" disabled={disabled} onClick={onJoin}>
    {owner ? <UserAvatar avatar={owner} size="sm" /> : <Users size={16} aria-hidden="true" />}
    <span className="gig-join-label">{ownerName ? `Join ${sessionTitle(ownerName)}` : 'Join the gig'}</span>
  </button>
);

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

