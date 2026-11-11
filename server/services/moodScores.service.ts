/**
 * Moods from the sound for tracks analysed before mood scores existed
 * (track_moods, shared/audioMoods.ts): the mood classifiers run on each
 * track's stored embedding instead of re-analysing the audio. On 400 dev
 * tracks that shortcut reproduced the full per-patch classifiers at r
 * 0.98–0.99, mean error 0.03–0.04. New analysis writes 'analysis' rows
 * itself; this fills 'embedding' rows, a batch at a time, in the analysis
 * worker that is already running.
 */
import type { Pool } from 'pg';
import { upsertTrackMoods } from '../database';
import { scoreMoodsFromEmbeddings } from './audioExtraction.service';
import { AUDIO_FEATURE_VERSION } from './audioFeatureVersion';
import { MOOD_SCORE_VERSION } from '../../shared/audioMoods';

const BATCH = 200;
/** Between batches, so analysis jobs sharing the worker never wait long. */
const PAUSE_MS = 200;
/** Mood models still downloading, or the worker down: try again later. */
const RETRY_MS = 30 * 60 * 1000;

const log = (message: string) => console.log(`[Moods] ${message}`);

let running: Promise<void> | null = null;
let stopRequested = false;
let retryTimer: NodeJS.Timeout | null = null;

/** Tracks with a real embedding and no current mood row (an 'analysis' row is never redone here). */
export async function countTracksWithoutMoods(db: Pool): Promise<number> {
  return Number((await db.query(`
    SELECT COUNT(*)::int AS n FROM track_features tf
    LEFT JOIN track_moods m ON m.track_id = tf.track_id
    WHERE NOT tf.is_simulated AND tf.embedding_vector IS NOT NULL AND tf.feature_version = $1
      AND (m.track_id IS NULL OR (m.method = 'embedding' AND m.mood_version < $2))`,
  [AUDIO_FEATURE_VERSION, MOOD_SCORE_VERSION])).rows[0].n);
}

/** One pass over every track without moods; resolves with the number scored. */
export async function backfillMoods(db: Pool, score = scoreMoodsFromEmbeddings): Promise<number> {
  let done = 0;
  const started = Date.now();
  for (;;) {
    if (stopRequested) break;
    const rows = (await db.query(`
      SELECT tf.track_id, tf.embedding_vector::text AS e
      FROM track_features tf
      LEFT JOIN track_moods m ON m.track_id = tf.track_id
      WHERE NOT tf.is_simulated AND tf.embedding_vector IS NOT NULL AND tf.feature_version = $2
        AND (m.track_id IS NULL OR (m.method = 'embedding' AND m.mood_version < $3))
      ORDER BY tf.track_id
      LIMIT $1`, [BATCH, AUDIO_FEATURE_VERSION, MOOD_SCORE_VERSION])).rows as Array<{ track_id: string; e: string }>;
    if (!rows.length) break;
    const scores = await score(rows.map(r => JSON.parse(r.e) as number[]));
    for (let i = 0; i < rows.length; i++) await upsertTrackMoods(db, rows[i].track_id, scores[i], 'embedding');
    done += rows.length;
    if (done % 5000 < BATCH) log(`Scored moods for ${done} tracks from their embeddings`);
    await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
  }
  if (done > 0) log(`Scored moods for ${done} tracks in ${Math.round((Date.now() - started) / 1000)} s`);
  return done;
}

/** Starts the backfill in the background; on failure (models not there yet) it tries again in 30 minutes. */
export function startMoodBackfill(getDb: () => Promise<Pool>): Promise<void> {
  if (running) return running;
  stopRequested = false;
  running = (async () => {
    const db = await getDb();
    if (!(await countTracksWithoutMoods(db))) return;
    await backfillMoods(db);
  })().catch(error => {
    console.warn(`[Moods] Backfill paused: ${error?.message || error}; trying again in 30 minutes`);
    if (!stopRequested) retryTimer = setTimeout(() => { retryTimer = null; void startMoodBackfill(getDb); }, RETRY_MS);
  }).finally(() => { running = null; });
  return running;
}

export function stopMoodBackfill() {
  stopRequested = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}
