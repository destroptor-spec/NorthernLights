import type {
  PlaybackCommandRequest,
  PlaybackOutputClaim,
  PlaybackOutputCredential,
  PlaybackOutputReport,
  PlaybackSession,
  PlaybackSessionPatch,
} from '../../shared/api/v1';
import { AuroraApiError, auroraApiRequest } from './auroraApi';

// Playback session calls for the first-party web app (docs/playback_sessions.md).
// Everything except reports authenticates as the user; a report carries only
// the output credential its claim returned.

type AuthHeaders = Record<string, string>;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function listPlaybackSessions(auth: AuthHeaders): Promise<PlaybackSession[]> {
  return auroraApiRequest<PlaybackSession[]>('/playback-sessions', auth);
}

export function getPlaybackSession(auth: AuthHeaders, sessionId: string): Promise<PlaybackSession> {
  return auroraApiRequest<PlaybackSession>(`/playback-sessions/${encodeURIComponent(sessionId)}`, auth);
}

export function createPlaybackSession(auth: AuthHeaders, name: string): Promise<PlaybackSession> {
  return auroraApiRequest<PlaybackSession>('/playback-sessions', auth, json('POST', { name, trackIds: [] }));
}

export function patchPlaybackSession(auth: AuthHeaders, sessionId: string, patch: PlaybackSessionPatch): Promise<PlaybackSession> {
  return auroraApiRequest<PlaybackSession>(`/playback-sessions/${encodeURIComponent(sessionId)}`, auth, json('PATCH', patch));
}

export function claimPlaybackOutput(
  auth: AuthHeaders,
  sessionId: string,
  claim: PlaybackOutputClaim,
): Promise<{ session: PlaybackSession; credential: PlaybackOutputCredential }> {
  return auroraApiRequest(`/playback-sessions/${encodeURIComponent(sessionId)}/output`, auth, json('POST', claim));
}

export function refreshOutputCredential(
  auth: AuthHeaders,
  sessionId: string,
  grant: { outputId: string; generation: number },
): Promise<PlaybackOutputCredential> {
  return auroraApiRequest(`/playback-sessions/${encodeURIComponent(sessionId)}/output/refresh`, auth, json('POST', grant));
}

export function reportPlaybackOutput(
  credential: PlaybackOutputCredential,
  sessionId: string,
  report: PlaybackOutputReport,
): Promise<{ accepted: boolean; revision: number }> {
  return auroraApiRequest(
    `/playback-sessions/${encodeURIComponent(sessionId)}/reports`,
    { Authorization: `Bearer ${credential.token}` },
    json('POST', report),
  );
}

/** Remote control: ask the session's output to act (it confirms through its next report). */
export function issuePlaybackCommand(auth: AuthHeaders, sessionId: string, request: PlaybackCommandRequest): Promise<{ accepted: boolean }> {
  return auroraApiRequest(`/playback-sessions/${encodeURIComponent(sessionId)}/commands`, auth, json('POST', request));
}

/** The session an error answered with (`details.current`), when it carries one. */
export function currentSessionFromError(error: unknown): PlaybackSession | null {
  if (!(error instanceof AuroraApiError)) return null;
  const current = (error.details as { current?: PlaybackSession } | undefined)?.current;
  return current && typeof current === 'object' && Array.isArray(current.queue) ? current : null;
}
