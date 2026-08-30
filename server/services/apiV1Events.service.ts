import { EventEmitter } from 'events';
import crypto from 'crypto';
import { initDB } from '../database';
import { getLibraryRevision } from './apiV1Dto.service';

export type ApiV1EventType =
  | 'playbackSession.created'
  | 'playbackSession.updated'
  | 'playbackSession.handedOff'
  | 'playbackSession.deleted'
  | 'playlist.changed'
  | 'annotation.changed'
  | 'library.revision';

export interface ApiV1Event {
  id: string;
  type: ApiV1EventType;
  occurredAt: string;
  data: Record<string, unknown>;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(250);
const history = new Map<string, ApiV1Event[]>();
const HISTORY_LIMIT = 200;

export function publishApiV1Event(userId: string, type: ApiV1EventType, data: Record<string, unknown>) {
  const event: ApiV1Event = {
    id: crypto.randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
  const events = history.get(userId) || [];
  events.push(event);
  if (events.length > HISTORY_LIMIT) events.splice(0, events.length - HISTORY_LIMIT);
  history.set(userId, events);
  emitter.emit(userId, event);
  return event;
}

/** Broadcast a global library change into each user's isolated event stream. */
export async function publishApiV1LibraryRevision(data: Record<string, unknown> = {}) {
  try {
    const db = await initDB();
    const [revision, users] = await Promise.all([
      getLibraryRevision(),
      db.query('SELECT id FROM users'),
    ]);
    for (const row of users.rows) {
      publishApiV1Event(String(row.id), 'library.revision', { revision, ...data });
    }
    return revision;
  } catch (error) {
    // Invalidations are best-effort and must never turn a successful library
    // mutation into a failed scan. Reconnect/resync still repairs missed SSE.
    console.error('[API v1] failed to publish library revision:', error);
    return null;
  }
}

export function subscribeApiV1Events(userId: string, listener: (event: ApiV1Event) => void) {
  emitter.on(userId, listener);
  return () => emitter.off(userId, listener);
}

export function replayApiV1Events(userId: string, afterId?: string): ApiV1Event[] | null {
  if (!afterId) return [];
  const events = history.get(userId) || [];
  const index = events.findIndex((event) => event.id === afterId);
  return index === -1 ? null : events.slice(index + 1);
}
