/**
 * Blind comparison of the daylist: the pools against the scored mix
 * (scoredMix.service), from the same time-of-day mood. Saves the pairs
 * privately for a user as "<label> NN · A" and "· B" in random order and
 * prints the key as JSON on the last line; keep it away from whoever rates.
 * (Round 1, 2026-11-14, also compared artist radio, which moved to the score.)
 *
 *   npx tsx scripts/ai-playlist-eval/make-mix-ab.ts <userId> [label]
 */
import { addTracksToPlaylist, createPlaylist, initDB } from '../../server/database';
import { daylistDefaults, daylistTrackIds, type SmartMixEngine } from '../../server/services/smartHub.service';

const userId = process.argv[2];
const label = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'Daylist test';
if (!userId) throw new Error('usage: make-mix-ab.ts <userId> [label]');

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

  // Daylists: six times of day, each from its default mood.
  for (const timeOfDay of ['early morning', 'morning', 'midday', 'afternoon', 'evening', 'late night']) {
    const target = daylistDefaults(timeOfDay);
    const run = (engine: SmartMixEngine) => daylistTrackIds(userId, 30, target, engine);
    await save(`Daylist ${target.label}`, `Daylist: ${target.label}`, await run('pools'), await run('score'));
  }

  console.log(JSON.stringify(key));
  process.exit(0);
})();
