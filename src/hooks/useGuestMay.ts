import { useListenTogetherStore, type SessionScope } from '../store/listenTogether';

/**
 * Whether this device may do what needs `scope`: always on the user's own
 * session; on a shared one (a gig), by the gig's level. Controls it may not
 * use are disabled, with no text (docs/listen-together.md, Permissions).
 */
export function useGuestMay(scope: SessionScope): boolean {
  return useListenTogetherStore((s) => !s.openedSessionId || !s.shared?.permissions || s.shared.permissions.includes(scope));
}

