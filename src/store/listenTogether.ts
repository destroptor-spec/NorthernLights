import { create } from 'zustand';
import type { SESSION_SCOPES, SessionInvitePreview, SessionMember, UserAvatar } from '../../shared/api/v1';

export type SessionScope = typeof SESSION_SCOPES[number];

/** The session this user is a guest in (one at a time). Its owner is filled in once read. */
export interface SharedSession {
  sessionId: string;
  ownerName: string | null;
  owner: UserAvatar | null;
  /** What this user may do in it (its gig level), once read. */
  permissions?: SessionScope[] | null;
}

/** The owner's view of its own session: who may join, who is in, and the gig's level. */
export interface OwnTogether {
  visibility: 'private' | 'invite' | 'discoverable';
  guests: SessionMember[];
  /** The owner's own avatar, first in the gig's line. */
  ownerAvatar?: UserAvatar | null;
  /** The guests' permissions: the gig's newest working link's. */
  permissions?: SessionScope[] | null;
}

export interface ListenTogetherState {
  /** The user's own session, as the session follower reads it. */
  ownSessionId: string | null;
  own: OwnTogether | null;
  shared: SharedSession | null;
  /** An invitation to answer: a prompt from an owner, or a `/listen/<token>` link. */
  prompt: { token: string; preview: SessionInvitePreview } | null;
  /**
   * The shared session this device shows (6d): the device the user joined
   * on, or one where they chose Open. It follows that session instead of
   * the user's own, and sends what is done here to the device that plays it.
   * Per device, kept across reloads.
   */
  openedSessionId: string | null;
  /** Discoverable gigs nearby ("Available gigs", 6e), as previews. */
  available: SessionInvitePreview[];
}

const OPENED_KEY = 'aurora-listen-together-opened';

function readOpened(): string | null {
  try {
    return window.localStorage.getItem(OPENED_KEY);
  } catch {
    return null;
  }
}

export const useListenTogetherStore = create<ListenTogetherState>(() => ({
  ownSessionId: null,
  own: null,
  shared: null,
  prompt: null,
  openedSessionId: readOpened(),
  available: [],
}));

useListenTogetherStore.subscribe((state, previous) => {
  if (state.openedSessionId === previous.openedSessionId) return;
  try {
    if (state.openedSessionId) window.localStorage.setItem(OPENED_KEY, state.openedSessionId);
    else window.localStorage.removeItem(OPENED_KEY);
  } catch {
    // Not kept across reloads then.
  }
});
