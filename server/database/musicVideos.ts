import { initDB } from './index';

export interface VideoUpload {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  position: number;
}
export interface VideoAssociation { trackId: string; videoId: string }

export async function getArtistVideoUploads(artistId: string): Promise<VideoUpload[]> {
  const db = await initDB();
  return (await db.query(`SELECT video_id AS "videoId", title, thumbnail_url AS "thumbnailUrl",
    published_at AS "publishedAt", position FROM artist_video_uploads WHERE artist_id=$1 ORDER BY position`, [artistId])).rows;
}

// One transaction publishes uploads, every album-copy match, and the freshness
// marker together. Local rematching must never advance successful-fetch time.
export async function saveArtistVideoCatalog(artistId: string, uploads: VideoUpload[], matches: VideoAssociation[],
  options: { fetched: boolean; sourceKey: string; libraryKey: string; channelId: string | null }) {
  const db = await initDB();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM track_video_matches WHERE artist_id=$1', [artistId]);
    if (options.fetched) {
      await client.query('DELETE FROM artist_video_uploads WHERE artist_id=$1', [artistId]);
      for (const v of uploads) await client.query(`INSERT INTO artist_video_uploads
        (artist_id,video_id,title,thumbnail_url,published_at,position) VALUES ($1,$2,$3,$4,$5,$6)`,
      [artistId, v.videoId, v.title, v.thumbnailUrl, v.publishedAt, v.position]);
    }
    for (const match of matches) await client.query(`INSERT INTO track_video_matches (track_id,artist_id,video_id)
      VALUES ($1,$2,$3) ON CONFLICT (track_id) DO UPDATE SET artist_id=EXCLUDED.artist_id,video_id=EXCLUDED.video_id`,
    [match.trackId, artistId, match.videoId]);
    const count = new Set(matches.map(match => match.videoId)).size;
    if (options.fetched) {
      await client.query(`INSERT INTO artist_videos_cache
        (artist_id,youtube_channel_id,videos_count,last_error,fetched_at,source_key,library_key,uploads_cached)
        VALUES ($1,$2,$3,NULL,NOW(),$4,$5,TRUE)
        ON CONFLICT (artist_id) DO UPDATE SET youtube_channel_id=$2,videos_count=$3,last_error=NULL,
          fetched_at=NOW(),source_key=$4,library_key=$5,uploads_cached=TRUE,retry_after=NULL,attempt_source_key=NULL`,
      [artistId, options.channelId, count, options.sourceKey, options.libraryKey]);
    } else {
      await client.query('UPDATE artist_videos_cache SET videos_count=$2,library_key=$3 WHERE artist_id=$1',
        [artistId, count, options.libraryKey]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function noteArtistVideoFailure(artistId: string, sourceKey: string, reason: string, retryMs: number) {
  const db = await initDB();
  // A failed attempt is not a successful fetch. Preserve all existing videos
  // and fetched_at, including while the provider is unavailable.
  await db.query(`INSERT INTO artist_videos_cache (artist_id,last_error,retry_after,attempt_source_key)
    VALUES ($1,$2,NOW()+($3 * INTERVAL '1 millisecond'),$4)
    ON CONFLICT (artist_id) DO UPDATE SET last_error=$2,
      retry_after=NOW()+($3 * INTERVAL '1 millisecond'),attempt_source_key=$4`, [artistId, reason, retryMs, sourceKey]);
}
