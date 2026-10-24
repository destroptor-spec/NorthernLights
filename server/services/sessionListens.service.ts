import { getUserSetting, initDB, recordPlaybackForUser, recordSkipForUser } from '../database';
import { addToSessionHistory } from '../state';
import { sendToScrobbleProviders, trackRowToProviderScrobble } from './scrobbleProviders.service';

/**
 * Plays, skips and scrobbles counted by the server, from the reports of the
 * device that plays a session (docs/playback_sessions.md). The web app used
 * to count them itself, and scrobbled only when a track ended on its own, so
 * nothing was scrobbled while casting (the receiver moves on by itself), after
 * Next, or with the phone asleep while a receiver followed the session
 * (2026-10-18). Reports reach the server whatever plays the session.
 *
 * One listen per session at a time, kept in memory: a handover from one
 * output to another continues the same listen, and a server restart forgets
 * only the listen in progress.
 */

const MIN_DURATION_S = 30;
const MAX_THRESHOLD_S = 240; // 4 minutes, like Last.fm's rule
/** Back near the start of an entry it already counted: repeat-one, or a restart. */
const RESTART_WITHIN_MS = 15_000;

export type ListenReport = { state: string; queueEntryId: string | null; positionMs: number };

type Listen = {
  entryId: string;
  trackId: string;
  track: Record<string, unknown>;
  startedAt: number;
  thresholdS: number | null;
  counted: boolean;
  played: boolean;
  lastPositionMs: number;
};

export type SessionListenDeps = {
  loadEntryTrack(sessionId: string, entryId: string): Promise<Record<string, unknown> | null>;
  thresholdPercent(userId: string): Promise<number>;
  recordPlay(userId: string, trackId: string, playedAt: Date): Promise<unknown>;
  recordSkip(userId: string, trackId: string): Promise<unknown>;
  addHistory(userId: string, trackId: string): void;
  scrobble(userId: string, track: Record<string, unknown>, submission: boolean, timestampS: number): Promise<unknown>;
  now(): number;
  log(message: string): void;
};

export const defaultSessionListenDeps: SessionListenDeps = {
  async loadEntryTrack(sessionId, entryId) {
    const db = await initDB();
    const result = await db.query(`
      SELECT t.* FROM playback_session_entries e JOIN tracks t ON t.id = e.track_id
      WHERE e.session_id = $1 AND e.queue_entry_id = $2
    `, [sessionId, entryId]);
    return result.rows[0] || null;
  },
  async thresholdPercent(userId) {
    const value = Number(await getUserSetting(userId, 'playedThresholdPercent'));
    return Number.isFinite(value) && value > 0 ? value : 50;
  },
  recordPlay: (userId, trackId, playedAt) => recordPlaybackForUser(userId, trackId, playedAt),
  recordSkip: (userId, trackId) => recordSkipForUser(userId, trackId),
  addHistory: (userId, trackId) => addToSessionHistory(userId, trackId),
  async scrobble(userId, track, submission, timestampS) {
    const payload = trackRowToProviderScrobble(track, submission ? timestampS : undefined);
    if (payload) await sendToScrobbleProviders(userId, [payload], submission);
  },
  now: () => Date.now(),
  log: (message) => console.log(`[Listens] ${message}`),
};

const listens = new Map<string, Listen>();
const queues = new Map<string, Promise<void>>();

const isPlaying = (state: string) => state === 'playing' || state === 'buffering';

/** Counts what an accepted output report means. Reports of one session are taken in order. */
export function noteSessionReport(userId: string, sessionId: string, report: ListenReport, deps: SessionListenDeps = defaultSessionListenDeps): Promise<void> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .then(() => applyReport(userId, sessionId, report, deps))
    .catch((error) => deps.log(`listen not counted: ${error instanceof Error ? error.message : String(error)}`));
  queues.set(sessionId, next);
  void next.finally(() => { if (queues.get(sessionId) === next) queues.delete(sessionId); });
  return next;
}

/** A deleted session leaves no listen behind. */
export function forgetSessionListen(sessionId: string): void {
  listens.delete(sessionId);
}

async function applyReport(userId: string, sessionId: string, report: ListenReport, deps: SessionListenDeps) {
  const entryId = report.queueEntryId;
  if (!entryId) return;
  let listen = listens.get(sessionId);

  const restarted = !!listen && listen.entryId === entryId && listen.counted
    && report.positionMs < RESTART_WITHIN_MS && report.positionMs + RESTART_WITHIN_MS < listen.lastPositionMs;
  if (!listen || listen.entryId !== entryId || restarted) {
    // The output moved on before the threshold: a skip, as Next counts one.
    if (listen && listen.entryId !== entryId && listen.played && !listen.counted) {
      await deps.recordSkip(userId, listen.trackId);
    }
    listens.delete(sessionId);
    // A listen begins when its entry plays; a paused or loading one waits.
    if (!isPlaying(report.state)) return;
    const track = await deps.loadEntryTrack(sessionId, entryId);
    if (!track) return;
    const duration = Number(track.duration) || 0;
    const percent = Math.min(Math.max(await deps.thresholdPercent(userId), 1), 100) / 100;
    listen = {
      entryId,
      trackId: String(track.id),
      track,
      startedAt: deps.now() - report.positionMs,
      thresholdS: duration > MIN_DURATION_S ? Math.min(duration * percent, MAX_THRESHOLD_S) : null,
      // First seen already past the threshold (the server restarted mid-track,
      // say): it may have been counted before, so it is not counted again.
      counted: false,
      played: false,
      lastPositionMs: report.positionMs,
    };
    if (listen.thresholdS !== null && report.positionMs / 1000 >= listen.thresholdS) listen.counted = true;
    listens.set(sessionId, listen);
  }

  if (isPlaying(report.state) && !listen.played) {
    listen.played = true;
    deps.addHistory(userId, listen.trackId);
    if (!listen.counted) await deps.scrobble(userId, listen.track, false, Math.floor(listen.startedAt / 1000));
  }
  listen.lastPositionMs = report.positionMs;

  if (!listen.counted && listen.played && listen.thresholdS !== null && report.positionMs / 1000 >= listen.thresholdS) {
    listen.counted = true;
    await deps.recordPlay(userId, listen.trackId, new Date(listen.startedAt));
    await deps.scrobble(userId, listen.track, true, Math.floor(listen.startedAt / 1000));
    deps.log(`played ${listen.trackId} in session ${sessionId}`);
  }
}

/** For tests. */
export function resetSessionListens(): void {
  listens.clear();
  queues.clear();
}
