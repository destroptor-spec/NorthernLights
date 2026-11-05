import type { PlaybackCommand, PlaybackSession } from '../../shared/api/v1';
import { AuroraApiError } from '../api/auroraApi';
import * as sessionApi from '../api/playbackSessions';
import { currentSessionFromError } from '../api/playbackSessions';
import type { TrackInfo } from './fileSystem';
import { createQueueEntryId } from './queue';
import type { FollowedOutput } from './sessionFollow';
import { createUuid } from './uuid';

// The idle device's side of remote control (docs/playback_sessions.md,
// "Device choice and remote control"): send what the listener did here to
// the device that plays the session.

export type RemoteAction =
  | { type: 'play' | 'pause' | 'next' | 'previous' }
  | { type: 'seek'; seconds: number }
  | { type: 'setVolume'; level: number }
  /** A track in this device's copy of the session queue. */
  | { type: 'jump'; track: TrackInfo }
  /** Something new: replace the session queue and start `startIndex`. */
  | { type: 'load'; tracks: TrackInfo[]; startIndex: number };

export interface RemoteDeps {
  api?: Pick<typeof sessionApi, 'issuePlaybackCommand' | 'patchPlaybackSession'>;
  auth: Record<string, string>;
  /** The revision of the session as this device last saw it. */
  sessionRevision: () => number | null;
}

export type RemoteResult = 'sent' | 'replaced' | 'unreachable' | 'failed';

export async function sendRemoteAction(action: RemoteAction, target: FollowedOutput, deps: RemoteDeps): Promise<RemoteResult> {
  const api = deps.api ?? sessionApi;
  try {
    let command: PlaybackCommand;
    switch (action.type) {
      case 'seek':
        command = { type: 'seek', positionMs: Math.max(0, Math.round(action.seconds * 1000)) };
        break;
      case 'setVolume':
        command = { type: 'setVolume', level: Math.min(1, Math.max(0, action.level)) };
        break;
      case 'jump':
        if (!action.track.queueEntryId) return 'failed';
        command = { type: 'jump', entryId: action.track.queueEntryId };
        break;
      case 'load': {
        const revision = await replaceQueue(api, deps, target.sessionId, action.tracks, action.startIndex);
        if (!revision) return 'failed';
        command = { type: 'load', revision: revision.revision, entryId: revision.entryId };
        break;
      }
      default:
        command = { type: action.type };
    }
    await api.issuePlaybackCommand(deps.auth, target.sessionId, {
      requestId: createUuid(),
      outputId: target.outputId,
      outputGeneration: target.generation,
      command,
    });
    return 'sent';
  } catch (error) {
    if (error instanceof AuroraApiError && (error.code === 'OUTPUT_GRANT_REPLACED' || error.code === 'OUTPUT_NOT_ACTIVE')) return 'replaced';
    if (error instanceof AuroraApiError && error.code === 'OUTPUT_UNREACHABLE') return 'unreachable';
    return 'failed';
  }
}

/** Puts the new queue in the session, answering the revision it made and the entry to start. */
async function replaceQueue(
  api: NonNullable<RemoteDeps['api']>,
  deps: RemoteDeps,
  sessionId: string,
  tracks: TrackInfo[],
  startIndex: number,
): Promise<{ revision: number; entryId: string } | null> {
  if (!tracks[startIndex]) return null;
  const entryIds = tracks.map(() => createQueueEntryId());
  const operations = [{ type: 'replaceQueue' as const, trackIds: tracks.map((track) => track.id), entryIds, currentIndex: startIndex }];
  let expectedRevision = deps.sessionRevision();
  if (!expectedRevision) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const session: PlaybackSession = await api.patchPlaybackSession(deps.auth, sessionId, {
        expectedRevision, requestId: createUuid(), operations,
      } as Parameters<typeof api.patchPlaybackSession>[2]);
      return { revision: session.revision, entryId: entryIds[startIndex] };
    } catch (error) {
      // The playing device moved on meanwhile: the queue is replaced anyway.
      const current = currentSessionFromError(error);
      if (!current || !(error instanceof AuroraApiError) || error.code !== 'REVISION_CONFLICT') throw error;
      expectedRevision = current.revision;
    }
  }
  return null;
}

/**
 * Casting to a receiver that plays the session itself (docs/cast-receiver-output.md,
 * PR E): start `entryId` there. This device's pending queue edits reach the
 * session first, so the receiver finds the entry at the revision it is told.
 */
export async function startOnFollowingReceiver(entryId: string, deps: {
  api?: Pick<typeof sessionApi, 'issuePlaybackCommand'>;
  auth: Record<string, string>;
  grant: { sessionId: string; outputId: string; generation: number } | null;
  flush: () => Promise<PlaybackSession | null>;
}): Promise<RemoteResult> {
  const api = deps.api ?? sessionApi;
  const grant = deps.grant;
  if (!grant) return 'replaced';
  try {
    const session = await deps.flush();
    if (!session || session.id !== grant.sessionId || !session.queue.some((entry) => entry.queueEntryId === entryId)) return 'failed';
    await api.issuePlaybackCommand(deps.auth, grant.sessionId, {
      requestId: createUuid(),
      outputId: grant.outputId,
      outputGeneration: grant.generation,
      command: { type: 'load', revision: session.revision, entryId },
    });
    return 'sent';
  } catch (error) {
    if (error instanceof AuroraApiError && (error.code === 'OUTPUT_GRANT_REPLACED' || error.code === 'OUTPUT_NOT_ACTIVE')) return 'replaced';
    if (error instanceof AuroraApiError && error.code === 'OUTPUT_UNREACHABLE') return 'unreachable';
    return 'failed';
  }
}
