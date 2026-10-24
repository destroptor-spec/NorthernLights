import crypto from 'crypto';
import type { NextRecommendationRequest, PlaybackSession } from '../../shared/api/v1';
import { getNextInfinityTrackForUser } from './infinityRequest.service';
import {
  getPlaybackSession,
  patchPlaybackSession,
  PlaybackSessionAnchorError,
  PlaybackSessionEntryIdError,
  PlaybackSessionRevisionError,
} from './playbackSession.service';

// Infinity, owned by the server (docs/playback_sessions.md, Phase 4). While
// a session has Infinity on, the server keeps INFINITY_AHEAD entries after the
// one that plays, chosen by the recommendation engine and appended as ordinary
// queue changes, so every device and the output see them through the normal
// sync path, and no two devices ever append for the same gap.
//
// For every output: since Phase 3 each takes the session's queue, so an
// append reaches the device that plays (a receiver that follows the session,
// a browser, or a casting device that manages its Cast window).

export const INFINITY_AHEAD = 3;
/** The same windows the web client sends to /recommendations/next. */
const HISTORY_ENTRIES = 50;
const SEED_ENTRIES = 10;
const EXCLUDE_LOOKBACK = 50;
const EXCLUDE_MAX = 200;
/** A gap needs at most INFINITY_AHEAD appends; conflicts get a few re-reads on top. */
const MAX_ATTEMPTS = INFINITY_AHEAD + 3;
const SERVER_CLIENT_ID = 'aurora-server-infinity';

type Recommend = (userId: string, input: NextRecommendationRequest) => Promise<{ id: unknown } | null | undefined>;

const running = new Map<string, Promise<number>>();

/** Whether the server keeps this session's upcoming entries: Infinity on, and something plays it. */
export function serverKeepsInfinity(session: PlaybackSession): boolean {
  return session.infinity && !!session.output && session.output.status !== 'ended';
}

/** How many entries follow the current one, or null without a current entry. */
function upcomingCount(session: PlaybackSession): number | null {
  const index = session.queue.findIndex((entry) => entry.queueEntryId === session.currentEntryId);
  return index < 0 ? null : session.queue.length - 1 - index;
}

function recommendationInput(session: PlaybackSession): NextRecommendationRequest {
  const ids = session.queue.map((entry) => entry.track.id);
  const index = Math.max(0, session.queue.findIndex((entry) => entry.queueEntryId === session.currentEntryId));
  return {
    // What has played in this session, ending with the playing track.
    sessionHistoryTrackIds: ids.slice(Math.max(0, index + 1 - HISTORY_ENTRIES), index + 1),
    exclude: Array.from(new Set(ids.slice(Math.max(0, index - EXCLUDE_LOOKBACK)))).slice(0, EXCLUDE_MAX),
    // The recommendation continues from the end of the queue as it stands.
    seedTrackIds: ids.slice(-SEED_ENTRIES),
    settings: {},
  };
}

/**
 * Tops the session up to INFINITY_AHEAD upcoming entries when the server keeps
 * its Infinity. Never runs twice at once for a session; a call while one runs
 * joins it. Resolves to the number of entries appended.
 */
export function topUpSessionInfinity(
  userId: string,
  sessionId: string,
  recommend: Recommend = getNextInfinityTrackForUser,
): Promise<number> {
  const key = `${userId}:${sessionId}`;
  const existing = running.get(key);
  if (existing) return existing;
  const run = fillGap(userId, sessionId, recommend)
    .catch((error) => {
      console.error('[Infinity] server top-up failed', error);
      return 0;
    })
    .finally(() => { running.delete(key); });
  running.set(key, run);
  return run;
}

async function fillGap(userId: string, sessionId: string, recommend: Recommend): Promise<number> {
  let session = await getPlaybackSession(userId, sessionId);
  let appended = 0;
  for (let attempt = 0; session && attempt < MAX_ATTEMPTS; attempt += 1) {
    if (!serverKeepsInfinity(session)) break;
    const upcoming = upcomingCount(session);
    if (upcoming === null || upcoming >= INFINITY_AHEAD) break;
    const input = recommendationInput(session);
    const track = await recommend(userId, input);
    const trackId = track ? String(track.id) : '';
    // Exhausted, or an engine that ignored the exclusions: stop, never loop.
    if (!trackId || (input.exclude ?? []).includes(trackId)) break;
    const last = session.queue[session.queue.length - 1];
    try {
      const result = await patchPlaybackSession({
        userId,
        clientId: SERVER_CLIENT_ID,
        sessionId,
        patch: {
          expectedRevision: session.revision,
          requestId: crypto.randomUUID(),
          operations: [{ type: 'insert', afterEntryId: last.queueEntryId, trackIds: [trackId], entryIds: [crypto.randomUUID()], addedBy: 'infinity' }],
        },
      });
      session = result.session;
      appended += 1;
    } catch (error) {
      // Someone changed the session meanwhile: read it again and decide anew.
      if (error instanceof PlaybackSessionRevisionError || error instanceof PlaybackSessionAnchorError
        || error instanceof PlaybackSessionEntryIdError) {
        session = await getPlaybackSession(userId, sessionId);
        continue;
      }
      throw error;
    }
  }
  if (appended) console.log(`[Infinity] server top-up session=${sessionId} appended=${appended}`);
  return appended;
}
