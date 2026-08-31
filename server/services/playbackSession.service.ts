import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { initDB } from '../database';
import type { PlaybackSession, PlaybackSessionPatch, Track } from '../../shared/api/v1';
import { getApiV1TracksByIds } from './apiV1Dto.service';
import { publishApiV1Event } from './apiV1Events.service';

type SessionRow = {
  id: string;
  user_id: string;
  name: string;
  owner_client_id: string;
  current_entry_id: string | null;
  position_ms: number;
  playback_state: 'playing' | 'paused' | 'stopped';
  repeat_mode: 'none' | 'one' | 'all';
  shuffle: boolean;
  source_kind: string | null;
  source_id: string | null;
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
};

type EntryRow = {
  queue_entry_id: string;
  track_id: string;
  position: number;
  added_at: Date | string;
};

export class PlaybackSessionNotFoundError extends Error {}
export class PlaybackSessionOwnershipError extends Error {}
export class PlaybackSessionRevisionError extends Error {
  constructor(public readonly current: PlaybackSession) {
    super('Playback session revision conflict');
  }
}
export class PlaybackSessionTrackError extends Error {
  constructor(public readonly missingIds: string[]) {
    super('One or more tracks no longer exist');
  }
}

async function loadEntries(db: PoolClient | Awaited<ReturnType<typeof initDB>>, sessionId: string): Promise<EntryRow[]> {
  const result = await db.query(`
    SELECT queue_entry_id, track_id, position, added_at
    FROM playback_session_entries
    WHERE session_id = $1
    ORDER BY position ASC
  `, [sessionId]);
  return result.rows as EntryRow[];
}

async function serializeSession(db: PoolClient | Awaited<ReturnType<typeof initDB>>, row: SessionRow): Promise<PlaybackSession> {
  const entries = await loadEntries(db, row.id);
  const tracks = await getApiV1TracksByIds(row.user_id, entries.map((entry) => entry.track_id));
  const trackById = new Map<string, Track>();
  for (const track of tracks) trackById.set(track.id, track);
  const currentEntryId = row.current_entry_id && entries.some((entry) => entry.queue_entry_id === row.current_entry_id)
    ? row.current_entry_id
    : null;
  return {
    id: row.id,
    name: row.name,
    ownerClientId: row.owner_client_id,
    currentEntryId,
    positionMs: Number(row.position_ms) || 0,
    playbackState: row.playback_state,
    repeatMode: row.repeat_mode,
    shuffle: row.shuffle,
    source: row.source_kind ? { kind: row.source_kind, id: row.source_id } : null,
    revision: Number(row.revision),
    queue: entries.flatMap((entry) => {
      const track = trackById.get(entry.track_id);
      return track ? [{
        queueEntryId: entry.queue_entry_id,
        position: Number(entry.position),
        track,
        addedAt: new Date(entry.added_at).toISOString(),
      }] : [];
    }),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function ensureTracksExist(db: PoolClient, trackIds: string[]) {
  const unique = Array.from(new Set(trackIds));
  if (unique.length === 0) return;
  const result = await db.query('SELECT id FROM tracks WHERE id = ANY($1::text[])', [unique]);
  const existing = new Set(result.rows.map((row) => String(row.id)));
  const missing = unique.filter((id) => !existing.has(id));
  if (missing.length) throw new PlaybackSessionTrackError(missing);
}

async function replaceEntries(db: PoolClient, sessionId: string, entries: EntryRow[]) {
  await db.query('DELETE FROM playback_session_entries WHERE session_id = $1', [sessionId]);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    await db.query(`
      INSERT INTO playback_session_entries (session_id, queue_entry_id, track_id, position, added_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [sessionId, entry.queue_entry_id, entry.track_id, index, entry.added_at]);
  }
}

export async function createPlaybackSession(input: {
  userId: string;
  clientId: string;
  name: string;
  trackIds: string[];
  currentIndex: number;
  positionMs: number;
  source?: { kind: string; id: string | null } | null;
}): Promise<PlaybackSession> {
  const db = await initDB();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await ensureTracksExist(client, input.trackIds);
    const entries = input.trackIds.map((trackId, position): EntryRow => ({
      queue_entry_id: crypto.randomUUID(),
      track_id: trackId,
      position,
      added_at: new Date(),
    }));
    const current = entries[Math.min(input.currentIndex, Math.max(0, entries.length - 1))] || null;
    const result = await client.query(`
      INSERT INTO playback_sessions
        (user_id, name, owner_client_id, current_entry_id, position_ms, source_kind, source_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      input.userId,
      input.name,
      input.clientId,
      current?.queue_entry_id || null,
      input.positionMs,
      input.source?.kind || null,
      input.source?.id || null,
    ]);
    await replaceEntries(client, result.rows[0].id, entries);
    await client.query('COMMIT');
    const session = await serializeSession(db, result.rows[0] as SessionRow);
    publishApiV1Event(input.userId, 'playbackSession.created', { sessionId: session.id, revision: session.revision });
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listPlaybackSessions(userId: string): Promise<PlaybackSession[]> {
  const db = await initDB();
  const result = await db.query(`
    SELECT * FROM playback_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50
  `, [userId]);
  return Promise.all((result.rows as SessionRow[]).map((row) => serializeSession(db, row)));
}

export async function getPlaybackSession(userId: string, sessionId: string): Promise<PlaybackSession | null> {
  const db = await initDB();
  const result = await db.query('SELECT * FROM playback_sessions WHERE id = $1 AND user_id = $2', [sessionId, userId]);
  return result.rows[0] ? serializeSession(db, result.rows[0] as SessionRow) : null;
}

export async function patchPlaybackSession(input: {
  userId: string;
  clientId: string;
  sessionId: string;
  patch: PlaybackSessionPatch;
}): Promise<PlaybackSession> {
  const db = await initDB();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT * FROM playback_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE
    `, [input.sessionId, input.userId]);
    const row = result.rows[0] as SessionRow | undefined;
    if (!row) throw new PlaybackSessionNotFoundError();
    if (row.owner_client_id !== input.clientId) throw new PlaybackSessionOwnershipError();
    if (Number(row.revision) !== input.patch.expectedRevision) {
      await client.query('ROLLBACK');
      const current = await getPlaybackSession(input.userId, input.sessionId);
      if (!current) throw new PlaybackSessionNotFoundError();
      throw new PlaybackSessionRevisionError(current);
    }

    let entries = await loadEntries(client, input.sessionId);
    let queueChanged = false;
    let currentEntryId = row.current_entry_id;
    let positionMs = Number(row.position_ms) || 0;
    let playbackState = row.playback_state;
    let repeatMode = row.repeat_mode;
    let shuffle = row.shuffle;

    for (const operation of input.patch.operations) {
      switch (operation.type) {
        case 'replaceQueue': {
          await ensureTracksExist(client, operation.trackIds);
          entries = operation.trackIds.map((trackId, position) => ({
            queue_entry_id: crypto.randomUUID(),
            track_id: trackId,
            position,
            added_at: new Date(),
          }));
          currentEntryId = entries[Math.min(operation.currentIndex || 0, Math.max(0, entries.length - 1))]?.queue_entry_id || null;
          positionMs = 0;
          queueChanged = true;
          break;
        }
        case 'insert': {
          await ensureTracksExist(client, operation.trackIds);
          const at = Math.min(operation.index, entries.length);
          entries.splice(at, 0, ...operation.trackIds.map((trackId, offset) => ({
            queue_entry_id: crypto.randomUUID(),
            track_id: trackId,
            position: at + offset,
            added_at: new Date(),
          })));
          if (!currentEntryId) currentEntryId = entries[0]?.queue_entry_id || null;
          queueChanged = true;
          break;
        }
        case 'remove': {
          const removed = new Set(operation.queueEntryIds);
          entries = entries.filter((entry) => !removed.has(entry.queue_entry_id));
          if (currentEntryId && removed.has(currentEntryId)) {
            currentEntryId = entries[0]?.queue_entry_id || null;
            positionMs = 0;
          }
          queueChanged = true;
          break;
        }
        case 'move': {
          const from = entries.findIndex((entry) => entry.queue_entry_id === operation.queueEntryId);
          if (from >= 0) {
            const [entry] = entries.splice(from, 1);
            entries.splice(Math.min(operation.toIndex, entries.length), 0, entry);
            queueChanged = true;
          }
          break;
        }
        case 'setTransport': {
          if (operation.currentEntryId !== undefined) {
            if (operation.currentEntryId !== null && !entries.some((entry) => entry.queue_entry_id === operation.currentEntryId)) {
              throw new PlaybackSessionTrackError([]);
            }
            if (currentEntryId !== operation.currentEntryId) positionMs = 0;
            currentEntryId = operation.currentEntryId;
          }
          if (operation.positionMs !== undefined) positionMs = operation.positionMs;
          if (operation.playbackState !== undefined) playbackState = operation.playbackState;
          if (operation.repeatMode !== undefined) repeatMode = operation.repeatMode;
          if (operation.shuffle !== undefined) shuffle = operation.shuffle;
          break;
        }
      }
    }

    if (queueChanged) await replaceEntries(client, input.sessionId, entries);
    const updated = await client.query(`
      UPDATE playback_sessions
      SET current_entry_id = $3, position_ms = $4, playback_state = $5,
          repeat_mode = $6, shuffle = $7, revision = revision + 1, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `, [input.sessionId, input.userId, currentEntryId, positionMs, playbackState, repeatMode, shuffle]);
    await client.query('COMMIT');
    const session = await serializeSession(db, updated.rows[0] as SessionRow);
    publishApiV1Event(input.userId, 'playbackSession.updated', { sessionId: session.id, revision: session.revision });
    return session;
  } catch (error) {
    if (!(error instanceof PlaybackSessionRevisionError)) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function handoffPlaybackSession(input: {
  userId: string;
  clientId: string;
  sessionId: string;
  expectedRevision: number;
}): Promise<PlaybackSession> {
  const db = await initDB();
  const result = await db.query(`
    UPDATE playback_sessions
    SET owner_client_id = $3, revision = revision + 1, updated_at = NOW()
    WHERE id = $1 AND user_id = $2 AND revision = $4
    RETURNING *
  `, [input.sessionId, input.userId, input.clientId, input.expectedRevision]);
  if (!result.rows[0]) {
    const current = await getPlaybackSession(input.userId, input.sessionId);
    if (!current) throw new PlaybackSessionNotFoundError();
    throw new PlaybackSessionRevisionError(current);
  }
  const session = await serializeSession(db, result.rows[0] as SessionRow);
  publishApiV1Event(input.userId, 'playbackSession.handedOff', {
    sessionId: session.id,
    ownerClientId: input.clientId,
    revision: session.revision,
  });
  return session;
}

export async function deletePlaybackSession(
  userId: string,
  clientId: string,
  sessionId: string,
  expectedRevision: number,
): Promise<void> {
  const db = await initDB();
  const result = await db.query(
    'DELETE FROM playback_sessions WHERE id = $1 AND user_id = $2 AND owner_client_id = $3 AND revision = $4 RETURNING id',
    [sessionId, userId, clientId, expectedRevision],
  );
  if ((result.rowCount || 0) === 0) {
    const current = await getPlaybackSession(userId, sessionId);
    if (!current) throw new PlaybackSessionNotFoundError();
    if (current.ownerClientId !== clientId) throw new PlaybackSessionOwnershipError();
    throw new PlaybackSessionRevisionError(current);
  }
  publishApiV1Event(userId, 'playbackSession.deleted', { sessionId });
}
