import { useMemo } from 'react';
import type { UserAvatar } from '../../shared/api/v1';
import { useListenTogetherStore } from '../store/listenTogether';
import { gigRunning } from '../utils/listenTogetherText';

export interface GigPerson {
  avatar: UserAvatar;
  name: string | null;
}

/**
 * Everyone in the gig this device shows, by user ID: the user's own running
 * gig (owner and guests), or the owner of the gig they are a guest in. Null
 * when there is no gig: then nobody's avatar is shown on the queue's rows.
 */
export function useGigPeople(): Map<string, GigPerson> | null {
  const own = useListenTogetherStore((state) => state.own);
  const shared = useListenTogetherStore((state) => state.shared);
  const openedSessionId = useListenTogetherStore((state) => state.openedSessionId);

  return useMemo(() => {
    const people = new Map<string, GigPerson>();
    if (openedSessionId && shared?.sessionId === openedSessionId) {
      if (shared.owner) people.set(shared.owner.userId, { avatar: shared.owner, name: shared.ownerName });
      return people;
    }
    if (!gigRunning(own)) return null;
    if (own!.ownerAvatar) people.set(own!.ownerAvatar.userId, { avatar: own!.ownerAvatar, name: own!.ownerName ?? null });
    for (const guest of own!.guests) people.set(guest.avatar.userId, { avatar: guest.avatar, name: guest.username });
    return people;
  }, [own, shared, openedSessionId]);
}
