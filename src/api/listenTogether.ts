import type {
  OnlineUser,
  PlaybackSession,
  SessionInvite,
  SessionInvitePreview,
  SessionMembers,
} from '../../shared/api/v1';
import { auroraApiRequest } from './auroraApi';

// Listen together calls for the web app (docs/listen-together.md, 6c).

type AuthHeaders = Record<string, string>;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const session = (sessionId: string) => `/playback-sessions/${encodeURIComponent(sessionId)}`;

export function setSessionSharing(auth: AuthHeaders, sessionId: string, visibility: 'private' | 'invite'): Promise<PlaybackSession> {
  return auroraApiRequest(`${session(sessionId)}/sharing`, auth, json('PATCH', { visibility }));
}

export function listSessionMembers(auth: AuthHeaders, sessionId: string): Promise<SessionMembers> {
  return auroraApiRequest(`${session(sessionId)}/members`, auth);
}

export function removeSessionMember(auth: AuthHeaders, sessionId: string, userId: string): Promise<void> {
  return auroraApiRequest(`${session(sessionId)}/members/${encodeURIComponent(userId)}`, auth, { method: 'DELETE' });
}

export function listSessionInvites(auth: AuthHeaders, sessionId: string): Promise<SessionInvite[]> {
  return auroraApiRequest(`${session(sessionId)}/invites`, auth);
}

export function createSessionInvite(auth: AuthHeaders, sessionId: string): Promise<SessionInvite> {
  return auroraApiRequest(`${session(sessionId)}/invites`, auth, json('POST', {}));
}

export function promptSessionInvite(auth: AuthHeaders, sessionId: string, token: string, userIds: string[]): Promise<{ prompted: number }> {
  return auroraApiRequest(`${session(sessionId)}/invites/${encodeURIComponent(token)}/prompt`, auth, json('POST', { userIds }));
}

export function endListeningTogether(auth: AuthHeaders, sessionId: string): Promise<PlaybackSession> {
  return auroraApiRequest(`${session(sessionId)}/together/end`, auth, json('POST', {}));
}

export function previewSessionInvite(auth: AuthHeaders, token: string): Promise<SessionInvitePreview> {
  return auroraApiRequest(`/session-invites/${encodeURIComponent(token)}`, auth);
}

export function joinSessionByInvite(auth: AuthHeaders, token: string): Promise<PlaybackSession> {
  return auroraApiRequest(`/session-invites/${encodeURIComponent(token)}/join`, auth, json('POST', {}));
}

export function listOnlineUsers(auth: AuthHeaders): Promise<OnlineUser[]> {
  return auroraApiRequest('/users/online', auth);
}
