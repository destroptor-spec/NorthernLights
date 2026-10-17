import { getSystemSetting, initDB } from '../../database';
import { extractMbLinks, mbGetArtist } from './providers/musicbrainz';

// Resolve only the missing prerequisite for videos. Uses the existing MB
// provider/queue without making Now Playing fetch artwork, lyrics or biography.
export async function loadArtistVideoLinks(artistId: string, mbid: string | null) {
  if (!mbid || !(await getSystemSetting('musicBrainzEnabled'))) return false;
  const artist = await mbGetArtist(mbid, AbortSignal.timeout(15000));
  if (!artist) return false;
  const db = await initDB();
  // Another metadata request may have completed while ours was in flight.
  await db.query(`UPDATE artists SET links=$2,mbid=COALESCE(mbid,$3)
    WHERE id=$1 AND (links IS NULL OR links='' OR links='[]')`,
  [artistId, JSON.stringify(extractMbLinks(artist.relations ?? [])), mbid]);
  return true;
}
