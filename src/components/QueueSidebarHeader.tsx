import React, { useRef, useState } from 'react';
import { ListPlus, ListX, Loader2, MoreHorizontal, PanelRightClose, Users } from 'lucide-react';
import { usePlayerStore } from '../store';
import { useListenTogetherStore } from '../store/listenTogether';
import { useQueueSidebarShowsGig } from '../hooks/useQueueSidebarShowsGig';
import { sessionTitle } from '../utils/listenTogetherText';
import { ContextMenuButton, ContextMenuDivider, ContextMenuFrame, ContextMenuList, ContextMenuPortal } from './ContextMenu';
import { EndGigButton, GigLevel, GigOpenSession, GigPeople, InviteButton, useOwnGig } from './GigSection';

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
  const { own, running, people, starting, start } = useOwnGig();
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  const guestView = !!openedSessionId && shared?.sessionId === openedSessionId;
  const gig = syncOn && showsGig && !guestView;
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

      {gig && !running && (
        <button type="button" className="queue-gig-start" disabled={starting} onClick={() => void start()}>
          <Users size={13} aria-hidden="true" />
          Start Gig
        </button>
      )}

      {gig && running && (
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
      )}

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
