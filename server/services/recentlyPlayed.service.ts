import { initDB } from '../database';

/**
 * The user's recently played tracks, newest first: each track once, at the
 * time it was last played on any device (user_playback_stats, kept by
 * playback reports and Subsonic scrobbles). A keyset page over
 * (last_played_at, track_id), served by ups_user_last_played_idx; the cursor
 * keeps the timestamp at full precision so no row is skipped or repeated.
 */
export interface RecentlyPlayedCursor {
  playedAt: string;
  trackId: string;
}

export async function getRecentlyPlayedPage(
  userId: string,
  { limit, after }: { limit: number; after: RecentlyPlayedCursor | null },
): Promise<Array<{ trackId: string; playedKey: string }>> {
  const db = await initDB();
  const result = await db.query(
    `SELECT ups.track_id, ups.last_played_at::text AS played_key
       FROM user_playback_stats ups
      WHERE ups.user_id = $1
        AND ups.last_played_at IS NOT NULL
        AND ($2::timestamptz IS NULL OR (ups.last_played_at, ups.track_id) < ($2::timestamptz, $3::text))
      ORDER BY ups.last_played_at DESC, ups.track_id DESC
      LIMIT $4`,
    [userId, after?.playedAt ?? null, after?.trackId ?? null, limit],
  );
  return result.rows.map((row: { track_id: string; played_key: string }) => ({ trackId: String(row.track_id), playedKey: String(row.played_key) }));
}
