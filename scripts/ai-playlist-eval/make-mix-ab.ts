/**
 * Blind comparison of artist radio and the daylist: the six-pool mixer
 * against the scored mix (scoredMix.service), from the same inputs (the same
 * artist centroid; the same time-of-day mood). Saves the pairs privately for
 * a user as "<label> NN · A" and "· B" in random order and prints the key as
 * JSON on the last line; keep it away from whoever rates.
 *
 *   npx tsx scripts/ai-playlist-eval/make-mix-ab.ts <userId> [label] [--artists=6]
 *
 * Artists: the user's most played with enough analysed tracks, at most two
 * per genre. Daylists: morning, afternoon, evening and late night moods.
 */
import { addTracksToPlaylist, createPlaylist, initDB } from '../../server/database';
import { computeArtistCentroids } from '../../server/services/candidatePool.service';
import { artistRadioLength, artistRadioTrackIds, daylistDefaults, daylistTrackIds, type SmartMixEngine } from '../../server/services/smartHub.service';

const userId = process.argv[2];
const label = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'Mix test';
const artistCount = Number(process.argv.find(a => a.startsWith('--artists='))?.slice(10) ?? 6);
if (!userId) throw new Error('usage: make-mix-ab.ts <userId> [label] [--artists=6]');

(async () => {
  const db = await initDB();
  const key: Record<string, string> = {};
  let n = 0;
  const save = async (title: string, description: string, pools: string[], score: string[]) => {
    if (!pools.length || !score.length) { console.log(`skip ${title}: an engine made nothing`); return; }
    n++;
    const num = String(n).padStart(2, '0');
    const scoreFirst = Math.random() < 0.5;
    key[num] = `${title}: ${scoreFirst ? 'A=score B=pools' : 'A=pools B=score'}`;
    for (const [side, ids] of [['A', scoreFirst ? score : pools], ['B', scoreFirst ? pools : score]] as const) {
      const id = `abtest_mix_${num}_${side}_${Date.now().toString(36)}`;
      await createPlaylist(id, `${label} ${num} · ${side}`, description, false, userId);
      await addTracksToPlaylist(id, ids);
      // Test material: only its owner sees it.
      await db.query('UPDATE playlists SET is_private = true WHERE id = $1', [id]);
    }
    console.log(`${label} ${num}: ${description}`);
  };

  // Artist radio: the most played artists, at most two per genre.
  const artists = (await db.query(`
    SELECT a.id, a.name,
      (SELECT ast.genre FROM artist_styles ast WHERE ast.artist_id = a.id ORDER BY ast.share DESC LIMIT 1) AS genre
    FROM artists a
    JOIN tracks t ON t.artist_id = a.id
    JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
    WHERE NOT COALESCE(a.is_va_pseudo, FALSE)
      AND (SELECT COUNT(*) FROM tracks t2 JOIN track_features tf ON tf.track_id = t2.id
           WHERE t2.artist_id = a.id AND NOT tf.is_simulated) >= 5
    GROUP BY a.id, a.name
    ORDER BY SUM(ups.play_count) DESC
    LIMIT 60`, [userId])).rows as Array<{ id: string; name: string; genre: string | null }>;
  const perGenre = new Map<string, number>();
  const chosen = artists.sort(() => Math.random() - 0.5).filter((a) => {
    const g = a.genre ?? '-';
    if ((perGenre.get(g) ?? 0) >= 2) return false;
    perGenre.set(g, (perGenre.get(g) ?? 0) + 1);
    return true;
  }).slice(0, artistCount);
  const length = await artistRadioLength();
  for (const artist of chosen) {
    const centroids = await computeArtistCentroids(userId, artist.id, 5, { sampleFrom: 12 });
    if (!centroids) continue;
    const run = (engine: SmartMixEngine) => artistRadioTrackIds(userId, artist.id, artist.name, length, centroids, engine);
    await save(`${artist.name} Radio`, `${artist.name} Radio`, await run('pools'), await run('score'));
  }

  // Daylists: four times of day, each from its default mood.
  for (const timeOfDay of ['morning', 'afternoon', 'evening', 'late night']) {
    const target = daylistDefaults(timeOfDay);
    const run = (engine: SmartMixEngine) => daylistTrackIds(userId, 30, target, engine);
    await save(`Daylist ${target.label}`, `Daylist: ${target.label}`, await run('pools'), await run('score'));
  }

  console.log(JSON.stringify(key));
  process.exit(0);
})();
