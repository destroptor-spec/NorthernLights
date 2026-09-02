import { initDB, getPlaylistTracks, getSystemSetting, getUserSetting, setUserSetting } from '../database';
import OpenAI from 'openai';
import { getLlmConfig, extractJson } from './llm.service';
import { withTransaction } from '../utils/db';
import { christmasExclusionSql } from '../utils/seasonalFilter';
import {
  enumerateCompletedWrappedPeriods,
  wrappedYmToLocalMs,
  type WrappedPeriod,
} from '../utils/wrappedPeriods';
import {
  buildPlaylistFromPools,
  computeArtistCentroids,
  fetchCandidatePool,
  getArtistGenrePaths,
  getLibraryMainstreamVector,
  getSongDedupKey,
  PoolName,
  PoolSpec,
} from './candidatePool.service';
import { getScrobblesInRange } from './lastfm.service';
import { getListensInRange } from './listenbrainz.service';
import { publishApiV1Event } from './apiV1Events.service';

// ============================================================
// Smart Hub: On Repeat, Repeat Rewind, Jump Back In, Artist
// Radio, Daylist. All persist as system playlists with stable
// IDs so they can be played, pinned, and refreshed in place.
// ============================================================

type SmartKind =
  | 'on-repeat'
  | 'repeat-rewind'
  | 'daylist'
  | 'artist-radio'
  | 'seasonal-rewind'
  | 'year-rewind'
  | 'wrapped';

// ─── Global content filters ────────────────────────────────
// "Various Artists" is a compilation pseudo-entity, never an artist we'd
// want to feature (radio, jump-back-in tile, top-artist surface). The real
// per-track artists are tagged correctly on VA albums, so individual
// tracks still flow through normally.
//
// Detection comes from artists.is_va_pseudo, which is set when every track
// of the artist lives on a compilation album (where albums.is_compilation
// is itself driven primarily by the MusicBrainz RELEASETYPE secondary
// type). The legacy LOWER(name) NOT IN ('various artists','va',…) match
// has been retired — see migrateReleaseGroups() for the derivation.
function variousArtistsExclusion(artistAlias: string): string {
  return `COALESCE(${artistAlias}.is_va_pseudo, FALSE) = FALSE`;
}


const TTL_MS: Record<SmartKind, number> = {
  'on-repeat': 24 * 60 * 60 * 1000,
  'repeat-rewind': 7 * 24 * 60 * 60 * 1000,
  'daylist': 4 * 60 * 60 * 1000,
  'artist-radio': 12 * 60 * 60 * 1000,
  'seasonal-rewind': 7 * 24 * 60 * 60 * 1000,
  'year-rewind': 7 * 24 * 60 * 60 * 1000,
  // Wrapped snapshots are frozen once a period completes; ensureWrappedPeriod
  // treats them as never-stale, so this value is effectively unused.
  'wrapped': 365 * 24 * 60 * 60 * 1000,
};

function smartPlaylistId(kind: SmartKind, userId: string, suffix?: string): string {
  return suffix ? `smart_${kind}_${userId}_${suffix}` : `smart_${kind}_${userId}`;
}

interface CachedSmart {
  id: string;
  title: string;
  description: string;
  tracks: any[];
  ageMs: number;
  createdAtMs: number;
}

async function loadCachedSmart(id: string): Promise<CachedSmart | null> {
  const db = await initDB();
  const res = await db.query(
    `SELECT id, title, description, created_at FROM playlists WHERE id = $1`,
    [id]
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0] as any;
  const tracks = await getPlaylistTracks(id);
  return {
    id,
    title: row.title,
    description: row.description,
    tracks: tracks || [],
    ageMs: Date.now() - new Date(row.created_at).getTime(),
    createdAtMs: new Date(row.created_at).getTime(),
  };
}

async function getCachedSmartPlaylist(id: string, ttlMs: number) {
  const cached = await loadCachedSmart(id);
  if (!cached) return null;
  if (cached.ageMs > ttlMs) return null;
  const { ageMs: _drop, ...rest } = cached;
  return rest;
}

// Stale-while-revalidate: returns the cache regardless of age, plus a flag
// indicating whether a refresh should be triggered.
async function getStaleOrFresh(id: string, ttlMs: number) {
  const cached = await loadCachedSmart(id);
  if (!cached) return { cached: null, stale: true };
  const { ageMs, ...rest } = cached;
  return { cached: rest, stale: ageMs > ttlMs };
}

// Track in-flight refreshes per-user-per-kind to prevent stampedes
const inFlightRefreshes = new Set<string>();
function fireBackgroundRefresh(key: string, work: () => Promise<unknown>) {
  if (inFlightRefreshes.has(key)) return;
  inFlightRefreshes.add(key);
  Promise.resolve()
    .then(work)
    .catch((e) => console.error('[SmartHub] Background refresh failed', { key }, e))
    .finally(() => inFlightRefreshes.delete(key));
}

// Activity gate: never burn LLM tokens or compute on users who aren't
// actively listening. Cheap query (one indexed lookup).
interface UserActivity {
  hasPlayedEver: boolean;
  hasPlayedRecently: boolean; // last 7 days
  hasPlayedToday: boolean;    // last 24h
}

async function getUserActivity(userId: string): Promise<UserActivity> {
  const db = await initDB();
  const res = await db.query(
    `SELECT MAX(last_played_at) AS last_play FROM user_playback_stats WHERE user_id = $1`,
    [userId]
  );
  const lastPlay = (res.rows[0] as any)?.last_play;
  if (!lastPlay) return { hasPlayedEver: false, hasPlayedRecently: false, hasPlayedToday: false };
  const ageMs = Date.now() - new Date(lastPlay).getTime();
  return {
    hasPlayedEver: true,
    hasPlayedRecently: ageMs < 7 * 24 * 60 * 60 * 1000,
    hasPlayedToday: ageMs < 24 * 60 * 60 * 1000,
  };
}

async function persistSmart(
  id: string,
  kind: SmartKind,
  title: string,
  description: string,
  userId: string,
  trackIds: string[]
) {
  const uniqueTrackIds = Array.from(new Set(trackIds.filter(Boolean)));

  await withTransaction(async (client) => {
    // Bound the advisory-lock wait so a contended or stuck refresh can't pin a
    // pooled connection. lock_timeout applies to pg_advisory_xact_lock (it waits
    // via the standard lock manager), aborting with 55P03 if the lock isn't
    // granted in time. SET LOCAL scopes this to the transaction so it reverts on
    // COMMIT/ROLLBACK and never rides back into the pool on the released client.
    // 10s is far above normal serialization (a refresh holds the lock for ms)
    // yet well under the 30s statement_timeout and 2-min leak threshold.
    await client.query(`SET LOCAL lock_timeout = '10s'`);

    // Serialize same-playlist smart refreshes. Without this, two concurrent
    // Hub requests can interleave track replacement for the same stable ID.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [id]);

    await client.query(
      `
      INSERT INTO playlists (id, title, description, created_at, is_llm_generated, user_id, is_system, generation_source)
      VALUES ($1, $2, $3, NOW(), FALSE, $4, TRUE, $5)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        created_at = NOW(),
        is_llm_generated = FALSE,
        user_id = EXCLUDED.user_id,
        is_system = TRUE,
        generation_source = EXCLUDED.generation_source
      `,
      [id, title, description, userId, kind]
    );

    await client.query(`DELETE FROM playlist_tracks WHERE playlist_id = $1`, [id]);

    if (uniqueTrackIds.length > 0) {
      await client.query(
        `
        INSERT INTO playlist_tracks (playlist_id, track_id, sort_order, added_at)
        SELECT $1, input.track_id, input.ordinality - 1, NOW()
        FROM unnest($2::text[]) WITH ORDINALITY AS input(track_id, ordinality)
        JOIN tracks t ON t.id = input.track_id
        ORDER BY input.ordinality
        `,
        [id, uniqueTrackIds]
      );
    }
  });

  const tracks = await getPlaylistTracks(id);
  publishApiV1Event(userId, 'playlist.changed', { playlistId: id, action: 'generated', source: 'smartHub' });
  return { id, title, description, tracks };
}

async function computeOnRepeatFresh(userId: string, limit: number) {
  const id = smartPlaylistId('on-repeat', userId);
  const db = await initDB();
  const res = await db.query(
    `
    SELECT t.id, SUM(b.play_count) AS recent_plays
    FROM user_track_play_buckets b
    JOIN tracks t ON t.id = b.track_id
    WHERE b.user_id = $1
      AND b.year_month >= date_trunc('month', NOW() - INTERVAL '30 days')::date
      ${christmasExclusionSql('t')}
    GROUP BY t.id
    HAVING SUM(b.play_count) >= 3
    ORDER BY recent_plays DESC
    LIMIT $2
    `,
    [userId, limit]
  );
  const trackIds = res.rows.map((r: any) => r.id);
  return persistSmart(id, 'on-repeat', 'On Repeat', 'Songs you love right now.', userId, trackIds);
}

// ─── On Repeat ─────────────────────────────────────────────
// Tracks the user has played most in the last 30 days.
export async function computeOnRepeat(userId: string, limit = 30) {
  const id = smartPlaylistId('on-repeat', userId);
  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['on-repeat']);
  if (cached) {
    if (stale) {
      fireBackgroundRefresh(id, () => computeOnRepeatFresh(userId, limit));
    }
    return cached;
  }
  return computeOnRepeatFresh(userId, limit);
}

async function computeRepeatRewindFresh(userId: string, limit: number) {
  const id = smartPlaylistId('repeat-rewind', userId);
  const db = await initDB();
  const res = await db.query(
    `
    WITH rewind_scores AS (
      SELECT
        t.id,
        COALESCE(SUM(CASE WHEN b.year_month BETWEEN
          date_trunc('month', NOW() - INTERVAL '18 months')::date
          AND date_trunc('month', NOW() - INTERVAL '6 months')::date
          THEN b.play_count ELSE 0 END), 0) AS old_plays,
        COALESCE(SUM(CASE WHEN b.year_month >=
          date_trunc('month', NOW() - INTERVAL '3 months')::date
          THEN b.play_count ELSE 0 END), 0) AS recent_plays
      FROM user_track_play_buckets b
      JOIN tracks t ON t.id = b.track_id
      WHERE b.user_id = $1
        ${christmasExclusionSql('t')}
      GROUP BY t.id
    )
    SELECT id, old_plays, recent_plays
    FROM rewind_scores
    WHERE old_plays >= 4
    ORDER BY (old_plays - 2 * recent_plays) DESC
    LIMIT $2
    `,
    [userId, limit]
  );
  const trackIds = res.rows.map((r: any) => r.id);
  return persistSmart(
    id,
    'repeat-rewind',
    'Repeat Rewind',
    'Your past favorites.',
    userId,
    trackIds
  );
}

// ─── Repeat Rewind ─────────────────────────────────────────
// Tracks heavily played 6–18 months ago, mostly cold now.
export async function computeRepeatRewind(userId: string, limit = 30) {
  const id = smartPlaylistId('repeat-rewind', userId);
  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['repeat-rewind']);
  if (cached) {
    if (stale) {
      fireBackgroundRefresh(id, () => computeRepeatRewindFresh(userId, limit));
    }
    return cached;
  }
  return computeRepeatRewindFresh(userId, limit);
}

// ─── Jump Back In ──────────────────────────────────────────
// Mixed-type tile feed: recently played items (albums, playlists,
// artists). Returns descriptors, not a playlist — the UI renders
// each tile and handles its own play action.
export interface JumpTile {
  type: 'album' | 'playlist' | 'artist';
  id: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  lastPlayedAt: number;
}

export async function computeJumpBackIn(userId: string, limit = 12): Promise<JumpTile[]> {
  const db = await initDB();

  // Recently played tracks → group to album, taking most recent play per album
  const albumRes = await db.query(
    `
    SELECT
      t.album_id::text AS album_id,
      MAX(ups.last_played_at) AS last_played_at,
      MAX(t.album) AS album,
      MAX(COALESCE(t.album_artist, t.artist)) AS artist
    FROM user_playback_stats ups
    JOIN tracks t ON t.id = ups.track_id
    WHERE ups.user_id = $1
      AND ups.last_played_at IS NOT NULL
      AND ups.last_played_at > NOW() - INTERVAL '90 days'
      AND t.album_id IS NOT NULL
      AND t.album IS NOT NULL AND t.album <> ''
      ${christmasExclusionSql('t')}
    GROUP BY t.album_id
    ORDER BY last_played_at DESC
    LIMIT $2
    `,
    [userId, limit * 2]
  );

  // Recently played playlists (track-level approximation: any playlist that
  // contains recently played tracks)
  const playlistRes = await db.query(
    `
    SELECT p.id, p.title, MAX(ups.last_played_at) AS last_played_at
    FROM user_playback_stats ups
    JOIN playlist_tracks pt ON pt.track_id = ups.track_id
    JOIN playlists p ON p.id = pt.playlist_id
    WHERE ups.user_id = $1
      AND ups.last_played_at > NOW() - INTERVAL '60 days'
      AND (p.user_id = $1 OR p.is_system = TRUE)
      AND COALESCE(p.generation_source, '') NOT IN ('artist-radio')
    GROUP BY p.id, p.title
    ORDER BY last_played_at DESC
    LIMIT $2
    `,
    [userId, Math.ceil(limit / 2)]
  );

  // Recently played artists (top played in last 60 days)
  const artistRes = await db.query(
    `
    SELECT a.id::text AS id, a.name, a.image_url, MAX(ups.last_played_at) AS last_played_at
    FROM user_playback_stats ups
    JOIN tracks t ON t.id = ups.track_id
    JOIN artists a ON a.id = t.artist_id
    WHERE ups.user_id = $1
      AND ups.last_played_at > NOW() - INTERVAL '60 days'
      AND ${variousArtistsExclusion('a')}
    GROUP BY a.id, a.name, a.image_url
    ORDER BY last_played_at DESC
    LIMIT $2
    `,
    [userId, Math.ceil(limit / 3)]
  );

  const tiles: JumpTile[] = [];

  for (const r of albumRes.rows as any[]) {
    tiles.push({
      type: 'album',
      id: r.album_id,
      title: r.album,
      subtitle: r.artist,
      imageUrl: null,
      lastPlayedAt: new Date(r.last_played_at).getTime(),
    });
  }
  for (const r of playlistRes.rows as any[]) {
    tiles.push({
      type: 'playlist',
      id: r.id,
      title: r.title,
      subtitle: 'Playlist',
      imageUrl: null,
      lastPlayedAt: new Date(r.last_played_at).getTime(),
    });
  }
  for (const r of artistRes.rows as any[]) {
    tiles.push({
      type: 'artist',
      id: r.id,
      title: r.name,
      subtitle: 'Artist',
      imageUrl: r.image_url,
      lastPlayedAt: new Date(r.last_played_at).getTime(),
    });
  }

  tiles.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
  return tiles.slice(0, limit);
}

// ─── Artist Radio Candidates ───────────────────────────────
// Top recent artists ranked by play volume in last 60 days.
export interface ArtistRadioCandidate {
  artistId: string;
  artistName: string;
  imageUrl: string | null;
  recentPlays: number;
  withArtists: string[];
}

// For a candidate seed artist, peek at the 3 closest neighbour artists by
// 1280D embedding similarity. Mirrors what generateArtistRadioFresh would
// surface, so the subtitle previews who'll actually play. Empty array if
// the seed has no embeddings.
async function previewWithArtists(userId: string, artistId: string): Promise<string[]> {
  const db = await initDB();
  const res = await db.query(
    `
    WITH seed AS (
      SELECT tf.embedding_vector AS vec
      FROM tracks t
      JOIN track_features tf ON tf.track_id = t.id
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
      WHERE t.artist_id = $2
        AND tf.embedding_vector IS NOT NULL
      ORDER BY COALESCE(ups.play_count, 0) DESC, t.id ASC
      LIMIT 1
    ),
    neighbors AS (
      SELECT t.artist_id, tf.embedding_vector <=> (SELECT vec FROM seed) AS distance
      FROM tracks t
      JOIN track_features tf ON tf.track_id = t.id
      WHERE tf.embedding_vector IS NOT NULL
        AND t.artist_id IS NOT NULL
        AND t.artist_id <> $2
      ORDER BY distance ASC
      LIMIT 50
    )
    SELECT a.name, MIN(n.distance) AS d
    FROM neighbors n
    JOIN artists a ON a.id = n.artist_id
    WHERE ${variousArtistsExclusion('a')}
    GROUP BY a.name
    ORDER BY d ASC
    LIMIT 3
    `,
    [userId, artistId]
  );
  return res.rows.map((r: any) => r.name as string);
}

export async function computeArtistRadioCandidates(
  userId: string,
  limit = 6
): Promise<ArtistRadioCandidate[]> {
  const db = await initDB();
  const res = await db.query(
    `
    SELECT
      a.id::text AS artist_id,
      a.name AS artist_name,
      a.image_url,
      SUM(b.play_count) AS recent_plays,
      0.7 * SUM(CASE WHEN b.year_month >=
        date_trunc('month', NOW() - INTERVAL '60 days')::date
        THEN b.play_count ELSE 0 END)
      + 0.3 * SUM(CASE WHEN b.year_month BETWEEN
        date_trunc('month', NOW() - INTERVAL '180 days')::date
        AND date_trunc('month', NOW() - INTERVAL '60 days')::date
        THEN b.play_count ELSE 0 END) AS score
    FROM user_track_play_buckets b
    JOIN tracks t ON t.id = b.track_id
    JOIN artists a ON a.id = t.artist_id
    WHERE b.user_id = $1
      AND b.year_month >= date_trunc('month', NOW() - INTERVAL '180 days')::date
      AND ${variousArtistsExclusion('a')}
    GROUP BY a.id, a.name, a.image_url
    HAVING SUM(b.play_count) >= 10
    ORDER BY score DESC
    LIMIT $2
    `,
    // Over-fetch so eligibility filtering can still fill the rail.
    [userId, limit * 3]
  );

  // Only surface artists that can actually produce a quality radio, so the
  // rail never offers a card that then builds a thin mix.
  const eligible: any[] = [];
  for (const r of res.rows as any[]) {
    if (eligible.length >= limit) break;
    const { eligible: ok } = await evaluateArtistRadioEligibility(userId, r.artist_id).catch(
      () => ({ eligible: false } as ArtistRadioEligibility)
    );
    if (ok) eligible.push(r);
  }

  const candidates: ArtistRadioCandidate[] = await Promise.all(
    eligible.map(async (r: any) => ({
      artistId: r.artist_id,
      artistName: r.artist_name,
      imageUrl: r.image_url,
      recentPlays: Number(r.recent_plays),
      withArtists: await previewWithArtists(userId, r.artist_id).catch(() => []),
    }))
  );
  return candidates;
}

// ─── Artist Radio eligibility ──────────────────────────────
// Whether a quality radio can actually be built for an artist, evaluated
// cheaply enough to drive the Play-Radio button's enabled state. The bar
// scales SUB-LINEARLY with library size: a tiny library qualifies with a
// short radio; a huge one plateaus at the full length — never a fixed % of
// the library.

const RADIO_MIN_OWN_ANALYZED = 3; // Gate 1: artist must have a real presence
const RADIO_LEN_MIN = 8;
const RADIO_LEN_MAX = 30;

// L = clamp(8, 30, round(a + b*sqrt(N))). Constants tuned so L≈12 @ 100,
// ≈22 @ 2k, and plateaus at 30 by ~20k analysed tracks. Tunable.
function adaptiveRadioLength(analyzedLibrarySize: number): number {
  const raw = 9 + 0.29 * Math.sqrt(Math.max(0, analyzedLibrarySize));
  return Math.max(RADIO_LEN_MIN, Math.min(RADIO_LEN_MAX, Math.round(raw)));
}

// Cache the analysed-library size briefly — it changes slowly and the
// eligibility endpoint is hit on every artist view.
let _analyzedLibSizeCache: { value: number; ts: number } | null = null;
const ANALYZED_LIB_CACHE_MS = 10 * 60 * 1000;

async function getAnalyzedLibrarySize(): Promise<number> {
  if (_analyzedLibSizeCache && Date.now() - _analyzedLibSizeCache.ts < ANALYZED_LIB_CACHE_MS) {
    return _analyzedLibSizeCache.value;
  }
  const db = await initDB();
  const res = await db.query(
    `SELECT COUNT(*)::int AS n FROM track_features WHERE acoustic_vector_8d IS NOT NULL`
  );
  const value = Number((res.rows[0] as any)?.n ?? 0);
  _analyzedLibSizeCache = { value, ts: Date.now() };
  return value;
}

export interface ArtistRadioEligibility {
  eligible: boolean;
  reason?: string;
  targetLength: number;
  ownAnalyzed: number;
  similarPool: number;
}

// Short-lived per-(user, artist) memoisation so repeat views and the
// generate-after-check flow don't re-run the neighbour query.
const _eligibilityCache = new Map<string, { value: ArtistRadioEligibility; ts: number }>();
const ELIGIBILITY_CACHE_MS = 5 * 60 * 1000;

export async function evaluateArtistRadioEligibility(
  userId: string,
  artistId: string
): Promise<ArtistRadioEligibility> {
  const cacheKey = `${userId}:${artistId}`;
  const hit = _eligibilityCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < ELIGIBILITY_CACHE_MS) return hit.value;

  const db = await initDB();
  const remember = (value: ArtistRadioEligibility): ArtistRadioEligibility => {
    _eligibilityCache.set(cacheKey, { value, ts: Date.now() });
    return value;
  };

  const analyzedLibSize = await getAnalyzedLibrarySize();
  const targetLength = adaptiveRadioLength(analyzedLibSize);

  // Reject missing artist / VA pseudo-entity up front.
  const artistRes = await db.query(
    `SELECT COALESCE(is_va_pseudo, FALSE) AS is_va_pseudo FROM artists WHERE id = $1`,
    [artistId]
  );
  if (artistRes.rowCount === 0) {
    return remember({ eligible: false, reason: 'Artist not found', targetLength, ownAnalyzed: 0, similarPool: 0 });
  }
  if ((artistRes.rows[0] as any).is_va_pseudo) {
    return remember({ eligible: false, reason: 'No radio for compilation artists', targetLength, ownAnalyzed: 0, similarPool: 0 });
  }

  // Gate 1: enough of the artist's OWN tracks are analysed.
  const ownRes = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM tracks t
     JOIN track_features tf ON tf.track_id = t.id
     WHERE t.artist_id::text = $1 AND tf.acoustic_vector_8d IS NOT NULL`,
    [artistId]
  );
  const ownAnalyzed = Number((ownRes.rows[0] as any)?.n ?? 0);
  if (ownAnalyzed < RADIO_MIN_OWN_ANALYZED) {
    return remember({
      eligible: false,
      reason: 'Not enough tracks by this artist for a radio',
      targetLength,
      ownAnalyzed,
      similarPool: 0,
    });
  }

  // Gate 2: the library has enough acoustically-similar tracks to fill L.
  // Reuse the same primitive generation uses (one HNSW-indexed query).
  const centroids = await computeArtistCentroids(userId, artistId, 5);
  if (!centroids || !centroids.acousticVectorStr) {
    return remember({
      eligible: false,
      reason: 'Not enough similar music for a radio',
      targetLength,
      ownAnalyzed,
      similarPool: 0,
    });
  }
  const neighbors = await fetchCandidatePool({
    name: 'core',
    limit: targetLength,
    vectorStr: centroids.acousticVectorStr,
    embeddingCentroidStr: centroids.embeddingCentroidStr,
    effnetWeight: 0.55,
    userId,
  });
  const similarPool = neighbors.length;
  if (similarPool < targetLength) {
    return remember({
      eligible: false,
      reason: 'Not enough similar music for a radio',
      targetLength,
      ownAnalyzed,
      similarPool,
    });
  }

  return remember({ eligible: true, targetLength, ownAnalyzed, similarPool });
}

// ─── Artist Radio (generated on demand) ────────────────────
// Multi-pool radio: a seed pool (artist's own most-played) plus core
// (embedding K-NN around a centroid of the artist's top tracks), adjacent
// (tracks sharing genre paths), bridge (blend with library mainstream),
// and discovery (never-played / dormant neighbors). Dedup by MB recording
// id + normalized title; artist diversity enforced via the shared
// candidatePool primitive.
async function generateArtistRadioFresh(userId: string, artistId: string, requestedLimit?: number) {
  const id = smartPlaylistId('artist-radio', userId, artistId);
  const db = await initDB();

  const artistRes = await db.query(
    `SELECT name, COALESCE(is_va_pseudo, FALSE) AS is_va_pseudo FROM artists WHERE id = $1`,
    [artistId]
  );
  if (artistRes.rowCount === 0) {
    throw new Error(`Artist not found: ${artistId}`);
  }
  const artistName = (artistRes.rows[0] as any).name;

  // Refuse to build a radio for the "Various Artists" pseudo-entity — by
  // definition it has no coherent acoustic signature.
  if ((artistRes.rows[0] as any).is_va_pseudo) {
    throw new Error('Cannot generate radio for compilation pseudo-artist');
  }

  // Adaptive length: scales sub-linearly with library size unless a caller
  // pins an explicit count.
  const limit = requestedLimit ?? adaptiveRadioLength(await getAnalyzedLibrarySize());

  // Sample the seed centroid from a wider window of the artist's top tracks so
  // each press steers the pools in a slightly different direction (variety).
  const centroids = await computeArtistCentroids(userId, artistId, 5, { sampleFrom: 12 });

  // Library-of-one fallback: artist has no analysed tracks (no acoustic
  // vector). Return their plain catalogue ordered by user play count.
  if (!centroids) {
    const fallbackRes = await db.query(
      `
      SELECT t.id
      FROM tracks t
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
      WHERE t.artist_id::text = $2
      ${christmasExclusionSql('t')}
      ORDER BY COALESCE(ups.play_count, 0) DESC, t.id ASC
      LIMIT $3
      `,
      [userId, artistId, limit]
    );
    const trackIds = fallbackRes.rows.map((r: any) => r.id);
    return persistSmart(
      id,
      'artist-radio',
      `${artistName} Radio`,
      `A mix inspired by ${artistName}.`,
      userId,
      trackIds
    );
  }

  const { acousticVectorStr, embeddingCentroidStr } = centroids;
  const { primaryPath, adjacentPaths, rootPath } = await getArtistGenrePaths(artistId);
  const mainstreamVectorStr = await getLibraryMainstreamVector();

  // Bridge vector = midpoint between seed centroid and library mainstream.
  // Pulls the recommendation slightly toward the listener's general taste so
  // the radio can sneak in safe non-genre matches without going random.
  let bridgeVectorStr: string | null = null;
  if (acousticVectorStr && mainstreamVectorStr) {
    try {
      const a = JSON.parse(acousticVectorStr);
      const m = JSON.parse(mainstreamVectorStr);
      if (Array.isArray(a) && Array.isArray(m) && a.length === 8 && m.length === 8) {
        const mid = a.map((x: number, i: number) => (Number(x) + Number(m[i])) / 2);
        bridgeVectorStr = `[${mid.join(',')}]`;
      }
    } catch {}
  }

  const seedSpec: PoolSpec = {
    name: 'seed',
    limit: 6,
    favoritesScore: true,
    restrictArtistIds: [artistId],
  };

  const coreSpec: PoolSpec = {
    name: 'core',
    limit: Math.max(40, limit * 2),
    vectorStr: acousticVectorStr,
    embeddingCentroidStr,
    effnetWeight: 0.55,
  };

  const adjacentSpec: PoolSpec | null = adjacentPaths.length > 0 || primaryPath
    ? {
        name: 'adjacent',
        limit: Math.max(15, limit),
        vectorStr: acousticVectorStr,
        embeddingCentroidStr,
        effnetWeight: 0.35,
        pathPrefixes: primaryPath ? [primaryPath, ...adjacentPaths] : adjacentPaths,
      }
    : null;

  const bridgeSpec: PoolSpec = {
    name: 'bridge',
    limit: Math.max(12, Math.ceil(limit * 0.5)),
    vectorStr: bridgeVectorStr ?? acousticVectorStr,
    embeddingCentroidStr,
    effnetWeight: 0.30,
  };

  const discoverySpec: PoolSpec = {
    name: 'discovery',
    limit: Math.max(15, limit),
    vectorStr: acousticVectorStr,
    embeddingCentroidStr,
    effnetWeight: 0.45,
    enableDiscoveryBoost: true,
  };

  const poolSpecs: PoolSpec[] = [seedSpec, coreSpec, bridgeSpec, discoverySpec];
  if (adjacentSpec) poolSpecs.push(adjacentSpec);

  const poolTargets = new Map<PoolName, number>([
    ['seed', Math.max(3, Math.round(limit * 0.13))],
    ['core', Math.round(limit * 0.38)],
    ['adjacent', Math.round(limit * (adjacentSpec ? 0.18 : 0))],
    ['bridge', Math.round(limit * 0.15)],
    ['discovery', Math.round(limit * 0.16)],
  ]);

  // Protect the seed artist from the per-artist cap so the seed pool can
  // actually surface multiple of their tracks. Everyone else is capped.
  const result = await buildPlaylistFromPools({
    userId,
    count: limit,
    poolSpecs,
    poolTargets,
    artistSpread: 0.55,
    diversity: 0.50,
    discoveryBias: 0.45,
    // Radio regenerates on every press — raise the per-pick jitter so the mix
    // is meaningfully different each time rather than a deterministic rerun.
    freshness: 1.8,
    relaxationPlan: [
      // Drop genre filters, widen K, relax artist floor.
      {
        poolSpecs: [
          seedSpec,
          { ...coreSpec, limit: Math.max(60, limit * 3) },
          { ...bridgeSpec, limit: Math.max(20, limit) },
          { ...discoverySpec, limit: Math.max(25, limit * 2) },
        ],
        poolTargets,
      },
    ],
  });

  // Belt-and-braces: if the multi-pool came back empty (unusable centroid,
  // tiny library, etc.) keep the legacy artist-only fallback as the last
  // resort instead of returning a silent empty playlist.
  let trackIds = result.trackIds;
  if (trackIds.length === 0) {
    const fallbackRes = await db.query(
      `
      SELECT t.id
      FROM tracks t
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
      WHERE t.artist_id::text = $2
      ${christmasExclusionSql('t')}
      ORDER BY COALESCE(ups.play_count, 0) DESC, t.id ASC
      LIMIT $3
      `,
      [userId, artistId, limit]
    );
    trackIds = fallbackRes.rows.map((r: any) => r.id);
  }

  void rootPath;

  return persistSmart(
    id,
    'artist-radio',
    `${artistName} Radio`,
    `A mix inspired by ${artistName}.`,
    userId,
    trackIds
  );
}

// Artist radio regenerates fresh on every play (request path passes
// forceRefresh). The stale-while-revalidate branch is retained only for any
// internal callers that want the cheap cached copy; `limit` defaults to the
// adaptive length when omitted.
export async function generateArtistRadio(
  userId: string,
  artistId: string,
  opts?: { limit?: number; forceRefresh?: boolean }
) {
  if (opts?.forceRefresh) {
    return generateArtistRadioFresh(userId, artistId, opts.limit);
  }
  const id = smartPlaylistId('artist-radio', userId, artistId);
  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['artist-radio']);
  if (cached) {
    if (stale) {
      fireBackgroundRefresh(id, () => generateArtistRadioFresh(userId, artistId, opts?.limit));
    }
    return cached;
  }
  return generateArtistRadioFresh(userId, artistId, opts?.limit);
}

// ─── Daylist ────────────────────────────────────────────────
// Time-of-day + weekday-aware LLM-curated playlist with a quirky
// title (e.g. "indie folk petrichor tuesday afternoon").
function describeTimeOfDay(hour: number): string {
  if (hour < 5) return 'late night';
  if (hour < 8) return 'early morning';
  if (hour < 12) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 17) return 'afternoon';
  if (hour < 20) return 'evening';
  if (hour < 23) return 'night';
  return 'late night';
}

interface DaylistConcept {
  title: string;
  description: string;
  target_genres: string[];
  banned_genres?: string[];
  target_vector?: number[];
}

const DAYLIST_TITLE_WORDS = new Set([
  'lazy', 'easy', 'warm', 'bright', 'quiet', 'mellow', 'dreamy', 'soft',
  'focused', 'slow', 'sunny', 'cozy', 'gentle', 'calm', 'loose', 'late',
]);

const DAYLIST_DEFAULT_MOODS: Record<string, { word: string; vector: number[]; banned: string[] }> = {
  'late night': { word: 'Quiet', vector: [0.16, 0.22, 0.18, 0.42, 0.58, 0.72, 0.16, 0.18], banned: ['metal', 'punk', 'hardcore', 'techno'] },
  'early morning': { word: 'Gentle', vector: [0.22, 0.36, 0.24, 0.45, 0.38, 0.66, 0.24, 0.28], banned: ['metal', 'hardcore', 'industrial'] },
  morning: { word: 'Easy', vector: [0.34, 0.52, 0.36, 0.52, 0.24, 0.48, 0.42, 0.42], banned: ['doom metal', 'hardcore', 'noise'] },
  midday: { word: 'Bright', vector: [0.58, 0.66, 0.54, 0.56, 0.18, 0.30, 0.62, 0.58], banned: ['ambient', 'drone', 'doom metal'] },
  afternoon: { word: 'Lazy', vector: [0.32, 0.42, 0.30, 0.48, 0.28, 0.58, 0.38, 0.34], banned: ['metal', 'hardcore', 'drum and bass', 'techno'] },
  evening: { word: 'Warm', vector: [0.42, 0.38, 0.38, 0.54, 0.26, 0.54, 0.48, 0.42], banned: ['hardcore', 'noise', 'industrial'] },
  night: { word: 'Mellow', vector: [0.28, 0.30, 0.28, 0.48, 0.42, 0.62, 0.34, 0.30], banned: ['metal', 'hardcore', 'gabber', 'drum and bass'] },
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeDaylistVector(vector: unknown, timeOfDay: string): number[] {
  const fallback = DAYLIST_DEFAULT_MOODS[timeOfDay]?.vector || DAYLIST_DEFAULT_MOODS.afternoon.vector;
  if (!Array.isArray(vector) || vector.length !== 8) return fallback;
  const normalized = vector.map((value) => Number(value));
  if (normalized.some((value) => !Number.isFinite(value))) return fallback;
  return normalized.map(clamp01);
}

function normalizeDaylistGenres(genres: unknown, fallback: string[]): string[] {
  const raw = Array.isArray(genres) ? genres : fallback;
  return Array.from(new Set(raw.map((genre) => String(genre).trim().toLowerCase()).filter(Boolean))).slice(0, 5);
}

function titleCaseDaylist(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(' ');
}

function simplifyDaylistTitle(rawTitle: string | undefined, weekday: string, timeOfDay: string): string {
  const weekdayLower = weekday.toLowerCase();
  const timeLower = timeOfDay.toLowerCase();
  const fallbackWord = DAYLIST_DEFAULT_MOODS[timeLower]?.word || 'Easy';
  const normalized = String(rawTitle || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  const moodWord = words.find((word) => DAYLIST_TITLE_WORDS.has(word)) || fallbackWord.toLowerCase();
  return titleCaseDaylist(`${moodWord} ${weekdayLower} ${timeLower}`);
}

async function generateDaylistConcept(
  weekday: string,
  timeOfDay: string,
  recentGenres: string[]
): Promise<DaylistConcept | null> {
  const { apiKey, baseUrl, modelName } = await getLlmConfig();
  if (baseUrl.includes('api.openai.com') && apiKey === 'dummy-key') return null;

  const openai = new OpenAI({ baseURL: baseUrl, apiKey });
  const recentGenresStr = recentGenres.length > 0 ? recentGenres.join(', ') : 'eclectic';

  const prompt = `You are curating a personalised daily mix for a music app, inspired by Spotify's "daylist".
Today is ${weekday} ${timeOfDay}. The listener's recent genres include: ${recentGenresStr}.

Create a single playlist concept with:
- a SIMPLE title with exactly 3 words: one plain mood adjective + weekday + time-of-day. Good: "Lazy Wednesday Afternoon", "Warm Friday Evening", "Quiet Sunday Night". Bad: poetic, genre-heavy, surreal, or more than 3 words.
- a short plain description
- 3-5 target genres pulled from the listener's recent genre list when possible
- 2-4 banned genres that clash with the exact mood
- target_vector with the same 8D order used by Hub playlists: [energy, brightness, percussiveness, chromagram, instrumentalness, acousticness, danceability, tempo]

Choose target_vector values precisely for the mood. For "lazy afternoon", prefer low-medium energy, softer percussiveness, higher acousticness, moderate/low danceability, slower tempo. Avoid generic 0.5 values.

Output ONLY valid JSON, no prose:
{
  "title": "Lazy Wednesday Afternoon",
  "description": "Unhurried songs for a soft Wednesday afternoon.",
  "target_genres": ["indie folk", "ambient folk", "chamber pop"],
  "banned_genres": ["metal", "hardcore", "techno"],
  "target_vector": [0.32, 0.42, 0.30, 0.48, 0.28, 0.58, 0.38, 0.34]
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
    });
    const content = response.choices[0].message.content;
    if (!content) return null;
    const parsed = extractJson(content);
    if (!parsed || !parsed.title || !Array.isArray(parsed.target_genres)) return null;
    return {
      title: simplifyDaylistTitle(String(parsed.title || ''), weekday, timeOfDay),
      description: String(parsed.description || ''),
      target_genres: normalizeDaylistGenres(parsed.target_genres, recentGenres.slice(0, 4)),
      banned_genres: normalizeDaylistGenres(parsed.banned_genres, DAYLIST_DEFAULT_MOODS[timeOfDay]?.banned || []),
      target_vector: normalizeDaylistVector(parsed.target_vector, timeOfDay),
    };
  } catch (err) {
    console.error('[Daylist] LLM error', err);
    return null;
  }
}

function getDaylistBucketStartMs(now: Date): number {
  const hour = now.getHours();
  const startHour =
    hour < 5 ? 0 :
    hour < 8 ? 5 :
    hour < 12 ? 8 :
    hour < 14 ? 12 :
    hour < 17 ? 14 :
    hour < 20 ? 17 :
    hour < 23 ? 20 :
    23;
  const start = new Date(now);
  start.setHours(startHour, 0, 0, 0);
  return start.getTime();
}

function isDaylistFromCurrentBucket(cached: Pick<CachedSmart, 'createdAtMs'> | null, now = new Date()): boolean {
  return !!cached && cached.createdAtMs >= getDaylistBucketStartMs(now);
}

async function computeDaylistFresh(userId: string, limit: number) {
  const id = smartPlaylistId('daylist', userId);
  const db = await initDB();
  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const timeOfDay = describeTimeOfDay(now.getHours());

  // Recent listening signature: top genres by play count over last 7 days.
  // Used as flavor input for the LLM title/description and to derive
  // banned-genre paths (mood-driven), not as a hard track filter.
  const genresRes = await db.query(
    `
    SELECT g.name AS genre, SUM(b.play_count) AS plays
    FROM user_track_play_buckets b
    JOIN tracks t ON t.id = b.track_id
    JOIN genres g ON g.id = t.genre_id AND g.merged_into IS NULL
    WHERE b.user_id = $1
      AND b.year_month >= date_trunc('month', NOW() - INTERVAL '7 days')::date
      AND g.name <> ''
    GROUP BY g.id, g.name
    ORDER BY plays DESC
    LIMIT 8
    `,
    [userId]
  );
  const recentGenres = genresRes.rows.map((r: any) => String(r.genre).toLowerCase());

  const concept = await generateDaylistConcept(weekday, timeOfDay, recentGenres);
  const fallbackTitle = simplifyDaylistTitle(undefined, weekday, timeOfDay);
  const title = concept?.title ? simplifyDaylistTitle(concept.title, weekday, timeOfDay) : fallbackTitle;
  const description =
    concept?.description ||
    `A fresh mix for your ${weekday} ${timeOfDay}.`;
  const bannedGenres = normalizeDaylistGenres(
    concept?.banned_genres,
    DAYLIST_DEFAULT_MOODS[timeOfDay]?.banned || []
  );
  const targetVector = normalizeDaylistVector(concept?.target_vector, timeOfDay);
  const targetVectorStr = `[${targetVector.join(',')}]`;

  // Daylist identity: discovery mix of favorites the user hasn't reached for
  // and tracks they haven't heard. Mood vector biases the acoustic pool but
  // doesn't dominate. Banned genres are honoured.
  const favoritesSpec: PoolSpec = {
    name: 'favorites',
    limit: Math.max(40, limit * 2),
    favoritesScore: true,
    vectorStr: targetVectorStr,
  };

  const acousticSpec: PoolSpec = {
    name: 'acoustic',
    limit: Math.max(25, limit),
    vectorStr: targetVectorStr,
  };

  const discoverySpec: PoolSpec = {
    name: 'discovery',
    limit: Math.max(35, limit * 2),
    vectorStr: targetVectorStr,
    enableDiscoveryBoost: true,
    dormantOnly: true,
  };

  const poolTargets = new Map<PoolName, number>([
    ['favorites', Math.round(limit * 0.40)],
    ['acoustic', Math.round(limit * 0.25)],
    ['discovery', Math.round(limit * 0.35)],
  ]);

  const result = await buildPlaylistFromPools({
    userId,
    count: limit,
    poolSpecs: [favoritesSpec, acousticSpec, discoverySpec],
    poolTargets,
    bannedGenres,
    artistSpread: 0.70,
    diversity: 0.55,
    discoveryBias: 0.60,
    allowSoftVetoRecovery: true,
    relaxationPlan: [
      // Step 1: drop banned-genre hard veto (soft penalty only) and lift the
      // discovery dormancy filter so any unheard track qualifies.
      {
        poolSpecs: [
          favoritesSpec,
          acousticSpec,
          { ...discoverySpec, dormantOnly: false },
        ],
        poolTargets,
        softVeto: true,
      },
      // Step 2: broaden the acoustic radius (bigger pool sizes, no vector
      // anchor on favorites/discovery so the recency/novelty signal dominates).
      {
        poolSpecs: [
          { ...favoritesSpec, vectorStr: null, limit: Math.max(60, limit * 3) },
          { ...discoverySpec, vectorStr: null, dormantOnly: false, limit: Math.max(60, limit * 3) },
        ],
        poolTargets: new Map<PoolName, number>([
          ['favorites', Math.round(limit * 0.55)],
          ['discovery', Math.round(limit * 0.45)],
        ]),
        softVeto: true,
      },
    ],
  });

  let trackIds = result.trackIds;
  if (trackIds.length === 0) {
    // Final safety net: pure random by recency, no acoustic guidance.
    const fallbackRes = await db.query(
      `
      SELECT t.id
      FROM tracks t
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
      WHERE TRUE
        ${christmasExclusionSql('t')}
      ORDER BY
        COALESCE(ups.last_played_at, NOW() - INTERVAL '10 years') DESC,
        RANDOM()
      LIMIT $2
      `,
      [userId, limit]
    );
    trackIds = fallbackRes.rows.map((r: any) => r.id);
  }

  return persistSmart(id, 'daylist', title, description, userId, trackIds);
}

export async function computeDaylist(userId: string, limit = 30) {
  const id = smartPlaylistId('daylist', userId);
  const activity = await getUserActivity(userId);

  // Never call the LLM for a user with no listening history.
  if (!activity.hasPlayedEver) return null;

  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['daylist']);
  if (cached) {
    // Bucket-aware: if the cached playlist was created before the current
    // time-of-day bucket, force a refresh even if within TTL — but only for
    // users who have actually engaged in the last 24h.
    const bucketChanged = !isDaylistFromCurrentBucket(cached);
    if ((stale || bucketChanged) && activity.hasPlayedToday) {
      fireBackgroundRefresh(id, () => computeDaylistFresh(userId, limit));
    }
    return cached;
  }

  // First-ever generation: only proceed if user has played recently, otherwise
  // the daylist would be a random mix and the LLM call is wasted.
  if (!activity.hasPlayedRecently) return null;
  return computeDaylistFresh(userId, limit);
}

// ─── Time capsules: Seasonal Rewind + Year Rewind ─────────
// Surface only when the calendar puts us in a meaningful window:
// - Seasonal rewinds run during the matching 3-month season,
//   pulling tracks from the same season last year.
// - Year rewinds run Dec 1 – Jan 31, pulling the closing year.
// Both require ≥10 distinct tracks in the source window or they
// don't render — a sad capsule is worse than no capsule.

interface SeasonalWindow {
  season: 'spring' | 'summer' | 'autumn' | 'winter';
  label: string;
  emoji: string;
  rangeStart: string; // 'YYYY-MM-01'
  rangeEnd: string;   // last month of season, 'YYYY-MM-01'
}

function getActiveSeasonalWindow(now: Date): SeasonalWindow | null {
  const m = now.getMonth(); // 0-indexed
  const y = now.getFullYear();
  const fmt = (yy: number, mm: number) =>
    `${yy}-${String(mm).padStart(2, '0')}-01`;

  if (m >= 2 && m <= 4) {
    return { season: 'spring', label: 'Spring Rewind', emoji: '🌸', rangeStart: fmt(y - 1, 3), rangeEnd: fmt(y - 1, 5) };
  }
  if (m >= 5 && m <= 7) {
    return { season: 'summer', label: 'Summer Rewind', emoji: '☀️', rangeStart: fmt(y - 1, 6), rangeEnd: fmt(y - 1, 8) };
  }
  if (m >= 8 && m <= 10) {
    return { season: 'autumn', label: 'Autumn Rewind', emoji: '🍂', rangeStart: fmt(y - 1, 9), rangeEnd: fmt(y - 1, 11) };
  }
  // Winter (Dec / Jan / Feb): previous full winter spans Dec → Feb across year boundary.
  if (m === 11) {
    // Dec(y): previous winter = Dec(y-1), Jan(y), Feb(y)
    return { season: 'winter', label: 'Winter Rewind', emoji: '❄️', rangeStart: fmt(y - 1, 12), rangeEnd: fmt(y, 2) };
  }
  // Jan(y) or Feb(y): previous winter = Dec(y-2), Jan(y-1), Feb(y-1)
  return { season: 'winter', label: 'Winter Rewind', emoji: '❄️', rangeStart: fmt(y - 2, 12), rangeEnd: fmt(y - 1, 2) };
}

function getActiveYearRewind(now: Date): { year: number; label: string } | null {
  const m = now.getMonth();
  const y = now.getFullYear();
  if (m === 11) return { year: y, label: `Your ${y}` };
  if (m === 0) return { year: y - 1, label: `Your ${y - 1}` };
  return null;
}

const MIN_CAPSULE_TRACKS = 10;

async function computeSeasonalRewindFresh(userId: string, limit: number) {
  const win = getActiveSeasonalWindow(new Date());
  if (!win) return null;
  const id = smartPlaylistId('seasonal-rewind', userId, win.season);
  const db = await initDB();
  const res = await db.query(
    `
    SELECT t.id, SUM(b.play_count) AS plays
    FROM user_track_play_buckets b
    JOIN tracks t ON t.id = b.track_id
    WHERE b.user_id = $1
      AND b.year_month >= $2::date
      AND b.year_month <= $3::date
      ${christmasExclusionSql('t')}
    GROUP BY t.id
    HAVING SUM(b.play_count) >= 2
    ORDER BY plays DESC
    LIMIT $4
    `,
    [userId, win.rangeStart, win.rangeEnd, limit]
  );
  if (res.rowCount! < MIN_CAPSULE_TRACKS) return null;
  const trackIds = res.rows.map((r: any) => r.id);
  const yearLabel = new Date(win.rangeStart).getFullYear();
  return persistSmart(
    id,
    'seasonal-rewind',
    `${win.emoji} ${win.label}`,
    `${trackIds.length} tracks that defined your ${win.season} of ${yearLabel}.`,
    userId,
    trackIds
  );
}

export async function computeSeasonalRewind(userId: string, limit = 30) {
  const win = getActiveSeasonalWindow(new Date());
  if (!win) return null;
  const id = smartPlaylistId('seasonal-rewind', userId, win.season);
  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['seasonal-rewind']);
  if (cached) {
    if (stale) {
      fireBackgroundRefresh(id, () => computeSeasonalRewindFresh(userId, limit));
    }
    return cached;
  }
  return computeSeasonalRewindFresh(userId, limit);
}

async function computeYearRewindFresh(userId: string, limit: number) {
  const yr = getActiveYearRewind(new Date());
  if (!yr) return null;
  const id = smartPlaylistId('year-rewind', userId, String(yr.year));
  const db = await initDB();
  const res = await db.query(
    `
    SELECT t.id, SUM(b.play_count) AS plays
    FROM user_track_play_buckets b
    JOIN tracks t ON t.id = b.track_id
    WHERE b.user_id = $1
      AND b.year_month >= make_date($2::int, 1, 1)
      AND b.year_month < make_date(($2::int + 1), 1, 1)
      ${christmasExclusionSql('t')}
    GROUP BY t.id
    HAVING SUM(b.play_count) >= 2
    ORDER BY plays DESC
    LIMIT $3
    `,
    [userId, yr.year, limit]
  );
  if (res.rowCount! < MIN_CAPSULE_TRACKS) return null;
  const trackIds = res.rows.map((r: any) => r.id);
  return persistSmart(
    id,
    'year-rewind',
    `🎉 ${yr.label}`,
    `${trackIds.length} tracks that defined your ${yr.year}.`,
    userId,
    trackIds
  );
}

export async function computeYearRewind(userId: string, limit = 50) {
  const yr = getActiveYearRewind(new Date());
  if (!yr) return null;
  const id = smartPlaylistId('year-rewind', userId, String(yr.year));
  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['year-rewind']);
  if (cached) {
    if (stale) {
      fireBackgroundRefresh(id, () => computeYearRewindFresh(userId, limit));
    }
    return cached;
  }
  return computeYearRewindFresh(userId, limit);
}

// ─── Wrapped (year + season recaps) ─────────────────────────
// Frozen, completed-period snapshots from user_track_play_buckets. Unlike the
// rewinds (a single rotating "active" capsule), Wrapped accumulates ONE playlist
// per completed year and season, year-scoped so history never collides.
// computeWrapped returns the newest completed year + season for the Hub's
// "Uniquely yours" rail and backfills older periods in the background; the full
// archive surfaces via the Playlists "Wrapped" rail. No Christmas exclusion —
// a Wrapped is a factual recap, so seasonal music you actually played belongs.
const WRAPPED_MIN_TRACKS = 10;

// Blend a user's external scrobbles (Last.fm + ListenBrainz) into the in-app
// play counts for a period so a recap reflects real listening even for tracks
// played elsewhere. External history is matched to local library tracks by song
// key (MB recording id → normalized artist+title); scrobbles that don't resolve
// to a library track can't sit in a playlist of local tracks and are dropped.
// Runs once per period (snapshots are frozen) and is fully resilient — if both
// providers are unreachable the recap is simply the in-app ranking.
async function computeWrappedPeriodFresh(userId: string, p: WrappedPeriod) {
  const id = smartPlaylistId('wrapped', userId, p.suffix);
  const db = await initDB();

  // 1) In-app plays for the period — one row per track, all with ≥1 play. The
  //    ≥2 floor is applied to the blended total below, not here.
  const res = await db.query(
    `
    SELECT t.id, t.mb_recording_id, t.artist, t.title, SUM(b.play_count)::int AS plays
    FROM user_track_play_buckets b
    JOIN tracks t ON t.id = b.track_id
    WHERE b.user_id = $1
      AND b.year_month >= $2::date
      AND b.year_month < $3::date
    GROUP BY t.id
    `,
    [userId, p.startYm, p.endYmExclusive]
  );

  // Collapse to one entry per song, summing plays across duplicate local files
  // and keeping the best-played file as the representative track id.
  interface WrappedEntry { trackId: string; key: string; inApp: number; external: number; repPlays: number; }
  const byKey = new Map<string, WrappedEntry>();
  for (const r of res.rows as any[]) {
    const key = getSongDedupKey({ title: r.title, artist: r.artist, mb_recording_id: r.mb_recording_id });
    const plays = Number(r.plays) || 0;
    const e = byKey.get(key);
    if (!e) {
      byKey.set(key, { trackId: r.id, key, inApp: plays, external: 0, repPlays: plays });
    } else {
      e.inApp += plays;
      if (plays > e.repPlays) { e.repPlays = plays; e.trackId = r.id; }
    }
  }

  // 2) External scrobbles for the same window, aggregated by song key. Both
  //    providers run in parallel and self-heal to [] on failure.
  const fromTs = Math.floor(wrappedYmToLocalMs(p.startYm) / 1000);
  const toTs = Math.floor(wrappedYmToLocalMs(p.endYmExclusive) / 1000) - 1;
  const [lfm, lb] = await Promise.all([
    getScrobblesInRange(userId, fromTs, toTs).catch(() => []),
    getListensInRange(userId, fromTs, toTs).catch(() => []),
  ]);
  const externalByKey = new Map<string, number>();
  for (const l of [...lfm, ...lb]) {
    const key = getSongDedupKey({ title: l.track, artist: l.artist, mb_recording_id: l.mbid });
    externalByKey.set(key, (externalByKey.get(key) || 0) + 1);
  }

  // 3) Attach external counts. Keys already played in-app get boosted directly;
  //    external-only songs are resolved to a library track by MB recording id
  //    (a targeted, indexed lookup — no full-library scan). External-only songs
  //    without an MBID can't be resolved cheaply and are left out.
  const unresolvedMbIds: string[] = [];
  for (const [key, count] of externalByKey) {
    const e = byKey.get(key);
    if (e) { e.external += count; continue; }
    if (key.startsWith('mb:')) unresolvedMbIds.push(key.slice(3));
  }
  if (unresolvedMbIds.length > 0) {
    const lib = await db.query(
      `
      SELECT DISTINCT ON (lower(trim(mb_recording_id))) id, lower(trim(mb_recording_id)) AS k
      FROM tracks
      WHERE mb_recording_id IS NOT NULL AND lower(trim(mb_recording_id)) = ANY($1)
      ORDER BY lower(trim(mb_recording_id)), id
      `,
      [unresolvedMbIds]
    );
    for (const row of lib.rows as any[]) {
      const key = `mb:${row.k}`;
      const count = externalByKey.get(key) || 0;
      if (count > 0 && !byKey.has(key)) {
        byKey.set(key, { trackId: row.id, key, inApp: 0, external: count, repPlays: 0 });
      }
    }
  }

  // 4) Rank by blended total, apply the ≥2 floor, cap at the period limit.
  const ranked = Array.from(byKey.values())
    .map((e) => ({ trackId: e.trackId, key: e.key, total: e.inApp + e.external }))
    .filter((e) => e.total >= 2)
    .sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, p.limit);

  if (ranked.length < WRAPPED_MIN_TRACKS) return null;
  const trackIds = ranked.map((e) => e.trackId);
  return persistSmart(
    id, 'wrapped', p.title,
    `${trackIds.length} tracks that defined your ${p.descLabel}.`,
    userId, trackIds
  );
}

// Returns a frozen Wrapped snapshot if already generated, else null. NEVER
// generates — all generation is backgrounded (computeWrappedPeriodFresh pages
// external history for seconds and must stay off the Hub request path).
async function getCachedWrapped(userId: string, p: WrappedPeriod) {
  const id = smartPlaylistId('wrapped', userId, p.suffix);
  const { cached } = await getStaleOrFresh(id, Number.MAX_SAFE_INTEGER);
  return cached;
}

// Generates a period if missing; frozen once generated. Called only from the
// background generation job.
async function ensureWrappedPeriod(userId: string, p: WrappedPeriod) {
  const id = smartPlaylistId('wrapped', userId, p.suffix);
  const { cached } = await getStaleOrFresh(id, Number.MAX_SAFE_INTEGER);
  if (cached) return cached;
  return computeWrappedPeriodFresh(userId, p);
}

// Suffixes we've already tried to generate. A completed period whose data
// doesn't qualify (too few plays) never will — its months are in the past and
// immutable — so we record the attempt to avoid re-querying it (and re-hitting
// Last.fm/ListenBrainz) on every Hub load.
async function getWrappedAttempted(userId: string): Promise<Set<string>> {
  const raw = await getUserSetting(userId, 'wrappedAttemptedSuffixes');
  return new Set(Array.isArray(raw) ? raw.filter((x: unknown) => typeof x === 'string') : []);
}

export async function computeWrapped(userId: string): Promise<{ wrappedYear: any; wrappedSeason: any }> {
  const db = await initDB();
  const minRes = await db.query(
    `SELECT MIN(year_month) AS minm FROM user_track_play_buckets WHERE user_id = $1`,
    [userId]
  );
  const minm = (minRes.rows[0] as any)?.minm;
  if (!minm) return { wrappedYear: null, wrappedSeason: null };

  const periods = enumerateCompletedWrappedPeriods(new Date(), new Date(minm));
  const newestYear = periods.find((p) => p.isYear) ?? null;
  const newestSeason = periods.find((p) => !p.isYear) ?? null;

  // Hot path: return only what's already frozen — never generate here.
  const [wrappedYear, wrappedSeason] = await Promise.all([
    newestYear ? getCachedWrapped(userId, newestYear).catch(() => null) : Promise.resolve(null),
    newestSeason ? getCachedWrapped(userId, newestSeason).catch(() => null) : Promise.resolve(null),
  ]);

  // Generate any not-yet-built periods in the background (newest first, so the
  // headline year+season land before the archive). A newly-completed period's
  // card therefore appears on the next Hub load, not this one. fireBackgroundRefresh
  // dedups by key; once every period is generated-or-attempted this is a no-op.
  const attempted = await getWrappedAttempted(userId);
  const existing = new Set(
    (await db.query(`SELECT id FROM playlists WHERE id LIKE $1`, [`smart_wrapped_${userId}_%`]))
      .rows.map((r: any) => r.id)
  );
  const missing = periods.filter(
    (p) => !existing.has(smartPlaylistId('wrapped', userId, p.suffix)) && !attempted.has(p.suffix)
  );
  if (missing.length) {
    fireBackgroundRefresh(`wrapped_gen_${userId}`, async () => {
      const done = await getWrappedAttempted(userId);
      for (const p of missing) {
        try {
          await ensureWrappedPeriod(userId, p);
          done.add(p.suffix); // clean outcome (generated or didn't qualify) — don't retry
        } catch (e) {
          // Transient (e.g. DB hiccup) — leave un-attempted so a later load retries.
          console.error('[SmartHub] wrapped generation failed', p.suffix, e);
        }
      }
      await setUserSetting(userId, 'wrappedAttemptedSuffixes', Array.from(done));
    });
  }
  return { wrappedYear, wrappedSeason };
}

// ─── Pre-warm queue ────────────────────────────────────────
// Called from the main Hub view. Skipped entirely for inactive users
// to avoid spending CPU/LLM tokens on lurkers.
export function queueSmartHubRefreshForUser(userId: string) {
  void (async () => {
    try {
      const activity = await getUserActivity(userId);
      // Lurker — return whatever's cached without recomputing anything.
      if (!activity.hasPlayedRecently) return;

      const onRepeatId = smartPlaylistId('on-repeat', userId);
      const repeatRewindId = smartPlaylistId('repeat-rewind', userId);
      const daylistId = smartPlaylistId('daylist', userId);

      const [onRepeatCache, repeatRewindCache, daylistCache] = await Promise.all([
        loadCachedSmart(onRepeatId),
        loadCachedSmart(repeatRewindId),
        loadCachedSmart(daylistId),
      ]);

      if (!onRepeatCache || onRepeatCache.ageMs > TTL_MS['on-repeat']) {
        fireBackgroundRefresh(onRepeatId, () => computeOnRepeatFresh(userId, 30));
      }
      if (!repeatRewindCache || repeatRewindCache.ageMs > TTL_MS['repeat-rewind']) {
        fireBackgroundRefresh(repeatRewindId, () => computeRepeatRewindFresh(userId, 30));
      }
      // Daylist refresh only fires if the user has actually engaged today.
      if (activity.hasPlayedToday) {
        const daylistBucketChanged = daylistCache && !isDaylistFromCurrentBucket(daylistCache);
        if (
          !daylistCache ||
          daylistCache.ageMs > TTL_MS['daylist'] ||
          daylistBucketChanged
        ) {
          fireBackgroundRefresh(daylistId, () => computeDaylistFresh(userId, 30));
        }
      }

      // Capsules pre-warm only when the calendar puts us in their window.
      const seasonal = getActiveSeasonalWindow(new Date());
      if (seasonal) {
        const seasonalId = smartPlaylistId('seasonal-rewind', userId, seasonal.season);
        const cache = await loadCachedSmart(seasonalId);
        if (!cache || cache.ageMs > TTL_MS['seasonal-rewind']) {
          fireBackgroundRefresh(seasonalId, () => computeSeasonalRewindFresh(userId, 30));
        }
      }
      const yr = getActiveYearRewind(new Date());
      if (yr) {
        const yearId = smartPlaylistId('year-rewind', userId, String(yr.year));
        const cache = await loadCachedSmart(yearId);
        if (!cache || cache.ageMs > TTL_MS['year-rewind']) {
          fireBackgroundRefresh(yearId, () => computeYearRewindFresh(userId, 50));
        }
      }
    } catch (e) {
      console.error('[SmartHub] Pre-warm failed', e);
    }
  })();
}

// ─── Bundle endpoint helper ────────────────────────────────
export async function computeSmartHubBundle(userId: string) {
  // Hard short-circuit for users with zero listening history. Saves 5+ SQL
  // queries per Hub view and prevents any chance of an LLM call.
  const activity = await getUserActivity(userId);
  if (!activity.hasPlayedEver) {
    return {
      jumpBackIn: [],
      onRepeat: null,
      repeatRewind: null,
      daylist: null,
      artistRadios: [],
      seasonalRewind: null,
      yearRewind: null,
      wrappedYear: null,
      wrappedSeason: null,
    };
  }

  // Admin Hub-Playlists toggles. Missing key → enabled (default on). The
  // `uniquelyYours` switch gates the whole on-repeat / repeat-rewind / daylist /
  // artist-radio rail; `smartJumpBackIn` gates the "Jump back in" tiles.
  const rawConfig = await getSystemSetting('systemPlaylistConfig');
  const cfg = rawConfig && typeof rawConfig === 'object' ? rawConfig as Record<string, unknown> : {};
  const jumpBackInEnabled = cfg.smartJumpBackIn !== false;
  const uniquelyYoursEnabled = cfg.uniquelyYours !== false;
  const wrappedEnabled = cfg.wrapped !== false;

  const [
    jumpBackIn,
    onRepeat,
    repeatRewind,
    daylist,
    artistRadios,
    seasonalRewind,
    yearRewind,
    wrapped,
  ] = await Promise.all([
    jumpBackInEnabled ? computeJumpBackIn(userId).catch((e) => {
      console.error('[SmartHub] jumpBackIn failed', e);
      return [];
    }) : Promise.resolve([]),
    uniquelyYoursEnabled ? computeOnRepeat(userId).catch((e) => {
      console.error('[SmartHub] onRepeat failed', e);
      return null;
    }) : Promise.resolve(null),
    uniquelyYoursEnabled ? computeRepeatRewind(userId).catch((e) => {
      console.error('[SmartHub] repeatRewind failed', e);
      return null;
    }) : Promise.resolve(null),
    uniquelyYoursEnabled ? computeDaylist(userId).catch((e) => {
      console.error('[SmartHub] daylist failed', e);
      return null;
    }) : Promise.resolve(null),
    uniquelyYoursEnabled ? computeArtistRadioCandidates(userId).catch((e) => {
      console.error('[SmartHub] artistRadios failed', e);
      return [];
    }) : Promise.resolve([]),
    computeSeasonalRewind(userId).catch((e) => {
      console.error('[SmartHub] seasonalRewind failed', e);
      return null;
    }),
    computeYearRewind(userId).catch((e) => {
      console.error('[SmartHub] yearRewind failed', e);
      return null;
    }),
    wrappedEnabled ? computeWrapped(userId).catch((e) => {
      console.error('[SmartHub] wrapped failed', e);
      return { wrappedYear: null, wrappedSeason: null };
    }) : Promise.resolve({ wrappedYear: null, wrappedSeason: null }),
  ]);

  return {
    jumpBackIn,
    onRepeat,
    repeatRewind,
    daylist,
    artistRadios,
    seasonalRewind,
    yearRewind,
    wrappedYear: wrapped.wrappedYear,
    wrappedSeason: wrapped.wrappedSeason,
  };
}
