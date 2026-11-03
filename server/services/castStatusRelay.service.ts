import { publishApiV1Event } from './apiV1Events.service';

/** The largest status relayed. The receiver's `aurora.status` is about 1 KB. */
export const CAST_STATUS_MAX_BYTES = 4096;

/** A Cast session id as CAF gives it (a UUID today); nothing else is passed on. */
const CAST_SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

export type CastStatusRelayResult = 'relayed' | 'invalid';

/**
 * The Cast receiver's status, relayed (docs/cast-takeover.md, PR 1). The
 * receiver posts each `aurora.status` it broadcasts, signed with the media
 * token of what it plays; the server passes it on, live only, as
 * `cast.status` to that token's user and nobody else. A sender whose Cast
 * connection is one-way (a deaf join) hears the receiver this way, with sync
 * on or off: `/api/v1/events` does not depend on sync.
 */
export function relayCastStatus(userId: string, body: unknown): CastStatusRelayResult {
  if (!body || typeof body !== 'object') return 'invalid';
  const { castSessionId, status } = body as { castSessionId?: unknown; status?: unknown };
  if (typeof castSessionId !== 'string' || !CAST_SESSION_ID.test(castSessionId)) return 'invalid';
  if (!status || typeof status !== 'object' || Array.isArray(status)) return 'invalid';
  if ((status as { type?: unknown }).type !== 'aurora.status') return 'invalid';
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(status));
  } catch {
    return 'invalid';
  }
  if (size > CAST_STATUS_MAX_BYTES) return 'invalid';
  publishApiV1Event(userId, 'cast.status', { castSessionId, status }, { transient: true });
  return 'relayed';
}
