import React, { useEffect, useRef, useState } from 'react';
import { ListPlus, ListX, Loader2, MoreHorizontal, PanelRightClose, Users } from 'lucide-react';
import { usePlayerStore } from '../store';
import { useListenTogetherStore } from '../store/listenTogether';
import { useQueueSidebarShowsGig } from '../hooks/useQueueSidebarShowsGig';
import { sessionTitle } from '../utils/listenTogetherText';
import { ContextMenuButton, ContextMenuDivider, ContextMenuFrame, ContextMenuList, ContextMenuPortal } from './ContextMenu';
import { EndGigButton, GigJoinButton, GigLevel, GigOpenSession, GigPeople, InviteButton, useOwnGig } from './GigSection';
import { UserAvatar } from './UserAvatar';
import { usePresenceList } from '../hooks/usePresenceList';

const blockKey = (block: { key: string }) => block.key;
import { joinNearby, leaveSharedSession, openSharedSession, refreshNearby } from '../utils/listenTogether';

/**
 * The top of the desktop queue sidebar (Andreas's design, 2026-11-18): "Now
 * playing" and ⋯ (Save as playlist, Clear, Collapse), with Start Gig under
 * it. While the user's gig runs, the gig's name instead, with everyone in it,
 * Invite, Guest permissions, Open session and End gig: on desktop the gig
 * lives here, not in the Connect card (useQueueSidebarShowsGig). On a device
 * that shows someone else's gig, that gig's name.
 */
export const QueueSidebarHeader: React.FC<{
  onSave: () => void;
  saving: boolean;
  onClear: () => void;
  onCollapse: () => void;
}> = ({ onSave, saving, onClear, onCollapse }) => {
  const queueLength = usePlayerStore((state) => state.playlist.length);
  const syncOn = usePlayerStore((state) => state.syncPlaybackAcrossDevices);
  const showsGig = useQueueSidebarShowsGig();
  const shared = useListenTogetherStore((state) => state.shared);
  const openedSessionId = useListenTogetherStore((state) => state.openedSessionId);
  const available = useListenTogetherStore((state) => state.available);
  const { own, running, people, starting, start } = useOwnGig();
  const [menuOpen, setMenuOpen] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  const guestView = !!openedSessionId && shared?.sessionId === openedSessionId;
  const gig = syncOn && showsGig && !guestView;
  // Gigs nearby to join, and one this user is a guest in that another of their devices shows.
  const nearby = available.filter((preview) => !preview.joined && preview.sessionId !== shared?.sessionId);
  const sharedElsewhere = gig && shared && !guestView ? shared : null;

  // The list nearby: read once here; its events keep it current after that.
  useEffect(() => {
    if (syncOn && showsGig) void refreshNearby();
  }, [syncOn, showsGig]);

  // What sits under the title, each folding open as it comes and shut as it
  // goes (a gig opening nearby, starting or ending a gig), as in Connect.
  const headerBlocks: Array<{ key: string; render: () => React.ReactNode }> = [];
  // A gig to join: the user's own on another device first, then those nearby.
  if (sharedElsewhere) {
    headerBlocks.push({
      key: `join-${sharedElsewhere.sessionId}`,
      render: () => (
        <GigJoinButton
          ownerName={sharedElsewhere.ownerName}
          owner={sharedElsewhere.owner}
          disabled={!!joining}
          onJoin={() => void join('shared', openSharedSession)}
        />
      ),
    });
  }
  if (gig) {
    for (const preview of nearby) {
      headerBlocks.push({
        key: `join-${preview.sessionId}`,
        render: () => (
          <GigJoinButton
            ownerName={preview.ownerName}
            owner={preview.owner}
            disabled={!!joining}
            onJoin={() => void join(preview.sessionId, () => joinNearby(preview))}
          />
        ),
      });
    }
  }
  // A guest, on the device that shows the gig: its owner, and Leave.
  if (syncOn && showsGig && guestView) {
    headerBlocks.push({
      key: 'guest',
      render: () => (
        <div className="queue-gig-people">
          {shared?.owner && <UserAvatar avatar={shared.owner} size="sm" />}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void leaveSharedSession()}>
            Leave
          </button>
        </div>
      ),
    });
  }
  if (gig && !running) {
    headerBlocks.push({
      key: 'start',
      render: () => (
        <button type="button" className="queue-gig-start" disabled={starting} onClick={() => void start()}>
          <Users size={13} aria-hidden="true" />
          Start Gig
        </button>
      ),
    });
  }
  if (gig && running) {
    headerBlocks.push({
      key: 'gig',
      render: () => (
        <div className="queue-gig">
          <div className="queue-gig-people">
            <GigPeople people={people} />
            <InviteButton className="queue-gig-invite" />
          </div>
          <GigLevel permissions={own?.permissions} />
          <GigOpenSession discoverable={own?.visibility === 'discoverable'} />
          <div>
            <EndGigButton className="btn-ghost" />
          </div>
        </div>
      ),
    });
  }
  const blocks = usePresenceList(headerBlocks, blockKey);

  const join = async (key: string, act: () => Promise<void>) => {
    if (joining) return;
    setJoining(key);
    try {
      await act();
    } finally {
      setJoining(null);
    }
  };
  const title = guestView
    ? (shared?.ownerName ? sessionTitle(shared.ownerName) : 'Listening together')
    : gig && running
      ? (own?.ownerName ? sessionTitle(own.ownerName) : 'Your gig')
      : 'Now playing';

  return (
    <div className="queue-sidebar-head">
      <div className="queue-sidebar-title-row">
        <h2 className="queue-sidebar-title">{title}</h2>
        <button
          ref={moreRef}
          type="button"
          className="queue-sidebar-more"
          aria-label="Queue options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <MoreHorizontal size={18} />}
        </button>
      </div>

      {blocks.map(({ key, item, entering, leaving }) => (
        <div
          key={key}
          className={`presence-fold${entering ? ' is-entering' : ''}${leaving ? ' is-leaving' : ''}`}
          aria-hidden={leaving || undefined}
        >
          <div className="presence-fold-inner queue-sidebar-block">{item.render()}</div>
        </div>
      ))}

      <ContextMenuPortal
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={moreRef}
        desktopWidth={224}
        desktopHeight={150}
      >
        {({ isMobile }) => (
          <ContextMenuFrame isMobile={isMobile} widthClassName="w-56">
            <ContextMenuList>
              {queueLength > 0 && (
                <>
                  <ContextMenuButton
                    icon={<ListPlus size={15} />}
                    label="Save queue as playlist"
                    onClick={() => {
                      setMenuOpen(false);
                      if (!saving) onSave();
                    }}
                  />
                  <ContextMenuButton
                    icon={<ListX size={15} />}
                    label="Clear queue"
                    onClick={() => {
                      setMenuOpen(false);
                      onClear();
                    }}
                  />
                  <ContextMenuDivider />
                </>
              )}
              <ContextMenuButton
                icon={<PanelRightClose size={15} />}
                label="Collapse"
                onClick={() => {
                  setMenuOpen(false);
                  onCollapse();
                }}
              />
            </ContextMenuList>
          </ContextMenuFrame>
        )}
      </ContextMenuPortal>
    </div>
  );
};
