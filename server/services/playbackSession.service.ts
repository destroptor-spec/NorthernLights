import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { initDB } from '../database';
import type { PlaybackCommandRequest, PlaybackOutput, PlaybackOutputClaim, PlaybackOutputReport, PlaybackSession, PlaybackSessionPatch, Track } from '../../shared/api/v1';
import { getApiV1TracksByIds } from './apiV1Dto.service';
import { isClientListening, publishApiV1Event } from './apiV1Events.service';

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
  output_id: string | null;
  output_kind: PlaybackOutput['kind'] | null;
  output_name: string | null;
  output_generation: string | number;
  output_claimed_at: Date | string | null;
  output_seq: string | number | null;
  output_state: PlaybackOutputReport['state'] | null;
  output_reason: string | null;
  output_entry_id: string | null;
  output_position_ms: number | null;
  output_reported_at: Date | string | null;
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
/** A report's body named a different output or generation than its credential. */
export class PlaybackOutputIdentityError extends Error {}
/** A refresh named an output grant that has since been replaced by a newer claim. */
export class PlaybackOutputGrantReplacedError extends Error {
  constructor(public readonly current: PlaybackSession) {
    super('Output grant replaced');
  }
}
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
/** An insert or move named an anchor entry that is no longer in the queue. */
export class PlaybackSessionAnchorError extends Error {
  current: PlaybackSession | null = null;
  constructor(public readonly anchorEntryId: string) {
    super('Anchor entry not found');
  }
}
/** A client-proposed entry ID is already used by another entry in the session. */
export class PlaybackSessionEntryIdError extends Error {
  current: PlaybackSession | null = null;
  constructor(public readonly entryIds: string[]) {
    super('Entry ID already in use');
  }
}
/** A patch reused a requestId with a different body. */
export class PlaybackSessionRequestReusedError extends Error {}

export type PlaybackSessionPatchResult = {
  session: PlaybackSession;
  /** The revision this patch produced; older than `session.revision` on a replay that others have since built on. */
  appliedRevision: number;
  /** True when the requestId had already been applied and nothing was applied again. */
  replayed: boolean;
};

// Request keys outlive any client retry, including an offline journal replay.
const REQUEST_KEY_TTL = "INTERVAL '24 hours'";
const REQUEST_KEYS_PER_SESSION = 1000;

function hashPatch(patch: PlaybackSessionPatch): string {
  const { requestId: _requestId, ...body } = patch;
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function newEntries(trackIds: string[], entryIds?: string[]): EntryRow[] {
  const addedAt = new Date();
  return trackIds.map((trackId, offset) => ({
    queue_entry_id: entryIds?.[offset] ?? crypto.randomUUID(),
    track_id: trackId,
    position: offset,
    added_at: addedAt,
  }));
}

// `null` is the head of the queue; otherwise the slot after the anchor.
function anchorSlot(entries: EntryRow[], afterEntryId: string | null): number {
  if (afterEntryId === null) return 0;
  const anchor = entries.findIndex((entry) => entry.queue_entry_id === afterEntryId);
  if (anchor < 0) throw new PlaybackSessionAnchorError(afterEntryId);
  return anchor + 1;
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

// Reports come every ~10 s while playing and every ~30 s as a heartbeat while
// paused or buffering, so a minute of silence is two missed heartbeats.
export const OUTPUT_UNREACHABLE_AFTER_MS = 60_000;
const TERMINAL_OUTPUT_STATES = new Set(['stopped', 'idle', 'error']);

/**
 * Silence only ever makes an output unreachable, never ended: a phone in a
 * lift and a killed receiver look the same. It ends only when the output says
 * so itself, and a new claim replaces it.
 */
/**
 * The Cast session each `cast` output sends to (or each `receiver` output runs
 * in), by playback session, for the grant that named it. Only a hint, so it is not stored: after a restart it
 * is unknown, and clients then act as if no other device casts there.
 */
const castSessionIds = new Map<string, { generation: number; castSessionId: string }>();

function serializeOutput(row: SessionRow, now = Date.now()): PlaybackOutput | null {
  if (!row.output_id || !row.output_kind || !row.output_claimed_at) return null;
  const reported = row.output_reported_at && row.output_state ? {
    seq: Number(row.output_seq),
    state: row.output_state,
    reason: row.output_reason,
    queueEntryId: row.output_entry_id,
    positionMs: Number(row.output_position_ms) || 0,
    reportedAt: new Date(row.output_reported_at).toISOString(),
  } : null;
  const lastHeard = Date.parse(reported?.reportedAt ?? new Date(row.output_claimed_at).toISOString());
  const status = reported && TERMINAL_OUTPUT_STATES.has(reported.state)
    ? 'ended'
    : now - lastHeard > OUTPUT_UNREACHABLE_AFTER_MS ? 'unreachable' : 'active';
  const cast = castSessionIds.get(row.id);
  const castSessionId = cast && cast.generation === Number(row.output_generation) ? cast.castSessionId : null;
  return {
    id: row.output_id,
    kind: row.output_kind,
    name: row.output_name,
    ...(row.output_kind === 'cast' || row.output_kind === 'receiver' ? { castSessionId } : {}),
    generation: Number(row.output_generation),
    claimedAt: new Date(row.output_claimed_at).toISOString(),
    status,
    report: reported,
  };
}

async function serializeSession(db: PoolClient | Awaited<ReturnType<typeof initDB>>, row: SessionRow): Promise<PlaybackSession> {
  const entries = await loadEntries(db, row.id);
  const tracks = await getApiV1TracksByIds(row.user_id, entries.map((entry) => entry.track_id));
  const trackById = new Map<string, Track>();
  for (const track of tracks) trackById.set(track.id, track);
  // Entries whose track is gone are left out, and positions are renumbered so
  // the queue a client sees never has holes.
  const queue = entries.flatMap((entry) => {
    const track = trackById.get(entry.track_id);
    return track ? [{ entry, track }] : [];
  });
  const currentEntryId = row.current_entry_id && queue.some(({ entry }) => entry.queue_entry_id === row.current_entry_id)
    ? row.current_entry_id
    : null;
  return {
    id: row.id,
    name: row.name,
    ownerClientId: row.owner_client_id,
    output: serializeOutput(row),
    currentEntryId,
    positionMs: Number(row.position_ms) || 0,
    playbackState: row.playback_state,
    repeatMode: row.repeat_mode,
    shuffle: row.shuffle,
    source: row.source_kind ? { kind: row.source_kind, id: row.source_id } : null,
    revision: Number(row.revision),
    queue: queue.map(({ entry, track }, position) => ({
      queueEntryId: entry.queue_entry_id,
      position,
      track,
      addedAt: new Date(entry.added_at).toISOString(),
    })),
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

// Writes only what changed: entries that kept their position stay untouched;
// removed entries and entries that moved are deleted, and the moved and new
// ones are inserted at their new positions in one statement. An Infinity
// append to a 2,000-entry queue therefore writes only the appended rows.
// Positions come out as 0..n-1, which also closes holes left by tracks that
// were deleted from the library (their entries cascade away).
async function writeEntries(db: PoolClient, sessionId: string, previous: EntryRow[], next: EntryRow[]) {
  const previousPosition = new Map(previous.map((entry) => [entry.queue_entry_id, Number(entry.position)]));
  const unchanged = new Set<string>();
  const changed: Array<{ entry: EntryRow; position: number }> = [];
  next.forEach((entry, position) => {
    if (previousPosition.get(entry.queue_entry_id) === position) unchanged.add(entry.queue_entry_id);
    else changed.push({ entry, position });
  });
  const stale = previous.map((entry) => entry.queue_entry_id).filter((id) => !unchanged.has(id));
  if (stale.length) {
    await db.query(
      'DELETE FROM playback_session_entries WHERE session_id = $1 AND queue_entry_id = ANY($2::uuid[])',
      [sessionId, stale],
    );
  }
  if (changed.length === 0) return;
  await db.query(`
    INSERT INTO playback_session_entries (session_id, queue_entry_id, track_id, position, added_at)
    SELECT $1, entry.queue_entry_id, entry.track_id, entry.position, entry.added_at
    FROM unnest($2::uuid[], $3::text[], $4::int[], $5::timestamptz[])
      AS entry(queue_entry_id, track_id, position, added_at)
  `, [
    sessionId,
    changed.map(({ entry }) => entry.queue_entry_id),
    changed.map(({ entry }) => entry.track_id),
    changed.map(({ position }) => position),
    changed.map(({ entry }) => new Date(entry.added_at)),
  ]);
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
    await writeEntries(client, result.rows[0].id, [], entries);
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
}): Promise<PlaybackSessionPatchResult> {
  const db = await initDB();
  const client = await db.connect();
  const { requestId } = input.patch;
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT * FROM playback_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE
    `, [input.sessionId, input.userId]);
    const row = result.rows[0] as SessionRow | undefined;
    if (!row) throw new PlaybackSessionNotFoundError();
    // No device check: a session belongs to its user, and any of their devices
    // may change it. Only reports are tied to the output grant.

    // The request key is checked before the revision, so a retry after a lost
    // response gets its original success rather than a conflict with itself.
    const requestHash = requestId ? hashPatch(input.patch) : null;
    if (requestId) {
      const prior = await client.query(`
        SELECT request_hash, revision FROM playback_session_requests
        WHERE session_id = $1 AND request_id = $2 AND created_at > NOW() - ${REQUEST_KEY_TTL}
      `, [input.sessionId, requestId]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new PlaybackSessionRequestReusedError();
        await client.query('ROLLBACK');
        return { session: await serializeSession(db, row), appliedRevision: Number(prior.rows[0].revision), replayed: true };
      }
    }

    if (Number(row.revision) !== input.patch.expectedRevision) {
      await client.query('ROLLBACK');
      const current = await getPlaybackSession(input.userId, input.sessionId);
      if (!current) throw new PlaybackSessionNotFoundError();
      throw new PlaybackSessionRevisionError(current);
    }

    const storedEntries = await loadEntries(client, input.sessionId);
    let entries = [...storedEntries];
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
          // A proposed ID may name an entry already in the queue, for the same
          // track: replacing is idempotent, so that entry simply survives.
          const existing = new Map(entries.map((entry) => [entry.queue_entry_id, entry]));
          const clashes = (operation.entryIds || []).filter((id, offset) => {
            const kept = existing.get(id);
            return kept !== undefined && kept.track_id !== operation.trackIds[offset];
          });
          if (clashes.length) throw new PlaybackSessionEntryIdError(clashes);
          entries = newEntries(operation.trackIds, operation.entryIds)
            .map((entry) => existing.get(entry.queue_entry_id) ?? entry);
          currentEntryId = entries[Math.min(operation.currentIndex || 0, Math.max(0, entries.length - 1))]?.queue_entry_id || null;
          positionMs = 0;
          queueChanged = true;
          break;
        }
        case 'insert': {
          await ensureTracksExist(client, operation.trackIds);
          if (operation.entryIds) {
            const used = new Set(entries.map((entry) => entry.queue_entry_id));
            const clashes = operation.entryIds.filter((id) => used.has(id));
            if (clashes.length) throw new PlaybackSessionEntryIdError(clashes);
          }
          const at = operation.afterEntryId !== undefined
            ? anchorSlot(entries, operation.afterEntryId)
            : Math.min(operation.index ?? entries.length, entries.length);
          entries.splice(at, 0, ...newEntries(operation.trackIds, operation.entryIds));
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
          // Moving an entry that is already gone is a no-op, which is what a
          // rebase would make of it anyway.
          const from = entries.findIndex((entry) => entry.queue_entry_id === operation.queueEntryId);
          if (from < 0) break;
          const [entry] = entries.splice(from, 1);
          const to = operation.afterEntryId === undefined
            ? Math.min(operation.toIndex ?? entries.length, entries.length)
            : operation.afterEntryId === operation.queueEntryId
              ? from
              : anchorSlot(entries, operation.afterEntryId);
          entries.splice(to, 0, entry);
          queueChanged = true;
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

    if (queueChanged) await writeEntries(client, input.sessionId, storedEntries, entries);
    const updated = await client.query(`
      UPDATE playback_sessions
      SET current_entry_id = $3, position_ms = $4, playback_state = $5,
          repeat_mode = $6, shuffle = $7, revision = revision + 1, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `, [input.sessionId, input.userId, currentEntryId, positionMs, playbackState, repeatMode, shuffle]);
    const appliedRevision = Number(updated.rows[0].revision);
    if (requestId) {
      // An expired key that hasn't been pruned yet is reused as a new one.
      await client.query(`
        INSERT INTO playback_session_requests (session_id, request_id, request_hash, revision)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (session_id, request_id)
        DO UPDATE SET request_hash = EXCLUDED.request_hash, revision = EXCLUDED.revision, created_at = NOW()
      `, [input.sessionId, requestId, requestHash, appliedRevision]);
      await client.query(`
        DELETE FROM playback_session_requests
        WHERE session_id = $1 AND (
          created_at <= NOW() - ${REQUEST_KEY_TTL}
          OR request_id IN (
            SELECT request_id FROM playback_session_requests
            WHERE session_id = $1 ORDER BY created_at DESC OFFSET $2
          )
        )
      `, [input.sessionId, REQUEST_KEYS_PER_SESSION]);
    }
    await client.query('COMMIT');
    const session = await serializeSession(db, updated.rows[0] as SessionRow);
    publishApiV1Event(input.userId, 'playbackSession.updated', { sessionId: session.id, revision: session.revision });
    return { session, appliedRevision, replayed: false };
  } catch (error) {
    if (!(error instanceof PlaybackSessionRevisionError)) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
    }
    // Anchor and entry-ID conflicts carry the current session, like a revision
    // conflict, so the client can rebase without another read.
    if (error instanceof PlaybackSessionAnchorError || error instanceof PlaybackSessionEntryIdError) {
      error.current = await getPlaybackSession(input.userId, input.sessionId);
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The output a claim makes: the calling device, or for a receiver claim the
 * Cast receiver in the named Cast session (docs/cast-receiver-output.md, PR B).
 */
export function claimedOutputId(clientId: string, output: PlaybackOutputClaim): string {
  return output.kind === 'receiver' ? `receiver:${output.castSessionId}` : clientId;
}

/**
 * Makes the calling device the session's output ("play here"), or, for kind
 * `receiver`, the Cast receiver that device casts to. Any of the owner's
 * devices may claim at any time, without a revision check, so moving playback
 * between devices is seamless. Each claim raises the generation; reports from
 * an earlier grant are stale from that moment.
 */
export async function claimPlaybackOutput(input: {
  userId: string;
  clientId: string;
  sessionId: string;
  output: PlaybackOutputClaim;
  expectedRevision?: number;
}): Promise<PlaybackSession> {
  const db = await initDB();
  const outputId = claimedOutputId(input.clientId, input.output);
  const result = await db.query(`
    UPDATE playback_sessions
    SET owner_client_id = $3, output_id = $7, output_kind = $4, output_name = $5,
        output_generation = output_generation + 1, output_claimed_at = NOW(),
        output_seq = NULL, output_state = NULL, output_reason = NULL,
        output_entry_id = NULL, output_position_ms = NULL, output_reported_at = NULL,
        revision = revision + 1, updated_at = NOW()
    WHERE id = $1 AND user_id = $2 AND ($6::bigint IS NULL OR revision = $6::bigint)
    RETURNING *
  `, [input.sessionId, input.userId, input.clientId, input.output.kind, input.output.name ?? null, input.expectedRevision ?? null, outputId]);
  if (!result.rows[0]) {
    const current = await getPlaybackSession(input.userId, input.sessionId);
    if (!current) throw new PlaybackSessionNotFoundError();
    throw new PlaybackSessionRevisionError(current);
  }
  const generation = Number((result.rows[0] as SessionRow).output_generation);
  if ((input.output.kind === 'cast' || input.output.kind === 'receiver') && input.output.castSessionId) {
    castSessionIds.set(input.sessionId, { generation, castSessionId: input.output.castSessionId });
  } else {
    castSessionIds.delete(input.sessionId);
  }
  const session = await serializeSession(db, result.rows[0] as SessionRow);
  publishApiV1Event(input.userId, 'playbackSession.handedOff', {
    sessionId: session.id,
    ownerClientId: input.clientId,
    outputId,
    outputKind: session.output!.kind,
    outputName: session.output!.name,
    castSessionId: session.output!.castSessionId ?? null,
    generation: session.output!.generation,
    revision: session.revision,
  });
  return session;
}

export class PlaybackOutputUnreachableError extends Error {
  constructor(public readonly current: PlaybackSession) {
    super('The device playing the session is not connected.');
  }
}

export class PlaybackOutputNotActiveError extends Error {
  constructor(public readonly current: PlaybackSession) {
    super('The session output is not playing anywhere right now.');
  }
}

/** requestIds already sent, per session, for a few minutes. */
const recentCommandIds = new Map<string, Map<string, number>>();
const COMMAND_ID_TTL_MS = 5 * 60_000;

function firstUseOfCommandId(sessionId: string, requestId: string, now: number): boolean {
  const seen = recentCommandIds.get(sessionId) ?? new Map<string, number>();
  for (const [id, at] of seen) if (now - at > COMMAND_ID_TTL_MS) seen.delete(id);
  if (seen.has(requestId)) return false;
  seen.set(requestId, now);
  recentCommandIds.set(sessionId, seen);
  return true;
}

/**
 * Remote control: sends a command to the session's output as a live-only
 * `playbackSession.command` event. It is checked against the output the
 * caller means (id and generation), so a command never reaches a device that
 * has since been replaced. Nothing is stored: the output's next report shows
 * whether it took effect.
 */
export async function issuePlaybackCommand(input: {
  userId: string;
  clientId: string;
  sessionId: string;
  request: PlaybackCommandRequest;
}): Promise<{ accepted: boolean }> {
  const session = await getPlaybackSession(input.userId, input.sessionId);
  if (!session) throw new PlaybackSessionNotFoundError();
  const output = session.output;
  if (!output) throw new PlaybackOutputNotActiveError(session);
  if (output.id !== input.request.outputId || output.generation !== input.request.outputGeneration) {
    throw new PlaybackOutputGrantReplacedError(session);
  }
  if (output.status !== 'active') throw new PlaybackOutputNotActiveError(session);
  // Commands travel over the output's event stream: without one open (its
  // app closed, or offline), nothing would carry it out. Say so at once
  // rather than after a minute of silence.
  if (!isClientListening(input.userId, output.id)) throw new PlaybackOutputUnreachableError(session);
  if (!firstUseOfCommandId(session.id, input.request.requestId, Date.now())) return { accepted: false };
  publishApiV1Event(input.userId, 'playbackSession.command', {
    sessionId: session.id,
    outputId: output.id,
    generation: output.generation,
    requestId: input.request.requestId,
    issuedBy: input.clientId,
    command: input.request.command,
  }, { transient: true });
  return { accepted: true };
}

/**
 * Checks that `outputId`/`generation` is still the session's current grant,
 * so a fresh output credential can be minted for it. It never revives a
 * replaced grant: that takes a new claim.
 */
export async function getCurrentOutputGrant(input: {
  userId: string;
  sessionId: string;
  outputId: string;
  generation: number;
}): Promise<{ sid: string; oid: string; gen: number; kind: PlaybackOutput['kind'] }> {
  const session = await getPlaybackSession(input.userId, input.sessionId);
  if (!session) throw new PlaybackSessionNotFoundError();
  if (session.output?.id !== input.outputId || session.output.generation !== input.generation) {
    throw new PlaybackOutputGrantReplacedError(session);
  }
  return { sid: session.id, oid: session.output.id, gen: session.output.generation, kind: session.output.kind };
}

const SESSION_STATE_FOR_OUTPUT: Record<PlaybackOutputReport['state'], SessionRow['playback_state'] | null> = {
  playing: 'playing',
  paused: 'paused',
  buffering: null, // between states; keep what the session says
  stopped: 'stopped',
  idle: 'stopped',
  error: 'stopped',
};

/**
 * Accepts a report from the session's output. Identity comes from the output
 * credential (`grant`), never from the body: a body that names another output
 * or generation is refused, and so is a grant that has been replaced. Reports
 * at or below the last accepted `seq` are dropped, which also covers a delayed
 * report from before a seek within the same track.
 *
 * A position report changes no revision, so controllers' edits don't conflict
 * with playback every ten seconds. A track change (to an entry still in the
 * queue) or a play/pause/stop change does bump it and publishes an update.
 */
export async function reportPlaybackOutput(input: {
  userId: string;
  grant: { sid: string; oid: string; gen: number };
  sessionId: string;
  report: PlaybackOutputReport;
}): Promise<{ accepted: boolean; revision: number }> {
  const { grant, report } = input;
  if (grant.sid !== input.sessionId
    || (report.outputId !== undefined && report.outputId !== grant.oid)
    || (report.outputGeneration !== undefined && report.outputGeneration !== grant.gen)) {
    throw new PlaybackOutputIdentityError();
  }
  const db = await initDB();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT * FROM playback_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [input.sessionId, input.userId],
    );
    const row = result.rows[0] as SessionRow | undefined;
    if (!row) throw new PlaybackSessionNotFoundError();
    if (row.output_id !== grant.oid || Number(row.output_generation) !== grant.gen) {
      await client.query('ROLLBACK');
      const current = await getPlaybackSession(input.userId, input.sessionId);
      if (!current) throw new PlaybackSessionNotFoundError();
      throw new PlaybackOutputGrantReplacedError(current);
    }
    if (row.output_seq !== null && report.seq <= Number(row.output_seq)) {
      await client.query('ROLLBACK');
      return { accepted: false, revision: Number(row.revision) };
    }

    let currentEntryId = row.current_entry_id;
    if (report.queueEntryId && report.queueEntryId !== row.current_entry_id) {
      const inQueue = await client.query(
        'SELECT 1 FROM playback_session_entries WHERE session_id = $1 AND queue_entry_id = $2',
        [input.sessionId, report.queueEntryId],
      );
      if (inQueue.rowCount) currentEntryId = report.queueEntryId;
    }
    const playbackState = SESSION_STATE_FOR_OUTPUT[report.state] ?? row.playback_state;
    const changed = currentEntryId !== row.current_entry_id || playbackState !== row.playback_state;
    const updated = await client.query(`
      UPDATE playback_sessions
      SET output_seq = $3, output_state = $4, output_reason = $5, output_entry_id = $6,
          output_position_ms = $7, output_reported_at = NOW(),
          current_entry_id = $8, playback_state = $9,
          position_ms = CASE WHEN $8::uuid IS NOT DISTINCT FROM $6::uuid THEN $7 ELSE position_ms END,
          revision = revision + $10::int,
          updated_at = CASE WHEN $10::int = 1 THEN NOW() ELSE updated_at END
      WHERE id = $1 AND user_id = $2
      RETURNING revision, output_reported_at
    `, [
      input.sessionId, input.userId, report.seq, report.state, report.reason ?? null, report.queueEntryId,
      report.positionMs, currentEntryId, playbackState, changed ? 1 : 0,
    ]);
    await client.query('COMMIT');
    const revision = Number(updated.rows[0].revision);
    if (changed) publishApiV1Event(input.userId, 'playbackSession.updated', { sessionId: input.sessionId, revision });
    // Every accepted report, so other devices can show live progress without
    // fetching the session. Not kept for replay; the next report replaces it.
    publishApiV1Event(input.userId, 'playbackSession.progress', {
      sessionId: input.sessionId,
      revision,
      outputId: grant.oid,
      generation: grant.gen,
      report: {
        seq: report.seq,
        state: report.state,
        reason: report.reason ?? null,
        queueEntryId: report.queueEntryId,
        positionMs: report.positionMs,
        reportedAt: new Date(updated.rows[0].output_reported_at).toISOString(),
      },
    }, { transient: true });
    return { accepted: true, revision };
  } catch (error) {
    if (!(error instanceof PlaybackOutputGrantReplacedError)) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Legacy alias for a browser claim by the caller, at an expected revision. */
export async function handoffPlaybackSession(input: {
  userId: string;
  clientId: string;
  clientName?: string;
  sessionId: string;
  expectedRevision: number;
}): Promise<PlaybackSession> {
  return claimPlaybackOutput({
    userId: input.userId,
    clientId: input.clientId,
    sessionId: input.sessionId,
    output: { kind: 'browser', ...(input.clientName ? { name: input.clientName } : {}) },
    expectedRevision: input.expectedRevision,
  });
}

export async function deletePlaybackSession(
  userId: string,
  sessionId: string,
  expectedRevision: number,
): Promise<void> {
  const db = await initDB();
  const result = await db.query(
    'DELETE FROM playback_sessions WHERE id = $1 AND user_id = $2 AND revision = $3 RETURNING id',
    [sessionId, userId, expectedRevision],
  );
  if ((result.rowCount || 0) === 0) {
    const current = await getPlaybackSession(userId, sessionId);
    if (!current) throw new PlaybackSessionNotFoundError();
    throw new PlaybackSessionRevisionError(current);
  }
  publishApiV1Event(userId, 'playbackSession.deleted', { sessionId });
}
