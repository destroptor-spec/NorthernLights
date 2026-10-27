import { create } from 'zustand';
import type { SessionInvitePreview, SessionMember, UserAvatar } from '../../shared/api/v1';

/** The session this user is a guest in (one at a time). Its owner is filled in once read. */
export interface SharedSession {
  sessionId: string;
  ownerName: string | null;
  owner: UserAvatar | null;
}

/** The owner's view of its own session: who may join, and who is in. */
export interface OwnTogether {
  visibility: 'private' | 'invite' | 'discoverable';
  guests: SessionMember[];
}

export interface ListenTogetherState {
  /** The user's own session, as the session follower reads it. */
  ownSessionId: string | null;
  own: OwnTogether | null;
  shared: SharedSession | null;
  /** An invitation to answer: a prompt from an owner, or a `/listen/<token>` link. */
  prompt: { token: string; preview: SessionInvitePreview } | null;
}

export const useListenTogetherStore = create<ListenTogetherState>(() => ({
  ownSessionId: null,
  own: null,
  shared: null,
  prompt: null,
}));
