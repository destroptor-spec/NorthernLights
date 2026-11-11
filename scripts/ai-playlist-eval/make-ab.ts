/**
 * Blind comparison for phase 5: for each saved concept, one playlist from the
 * pool engine and one from the scored engine, saved for a user as
 * "AI test NN · A" and "· B" in random order. Prints the key as JSON on the
 * last line; keep it away from whoever rates.
 *
 *   PGOPTIONS='-c max_parallel_workers_per_gather=0' npx tsx scripts/ai-playlist-eval/make-ab.ts <userId>
 *
 * (The pool engine's six parallel full scans can exhaust a container's 64 MB
 * /dev/shm; without parallel workers it runs.)
 */
import fs from 'fs';
import path from 'path';
import { addTracksToPlaylist, createPlaylist, initDB } from '../../server/database';
import { getHubCollections } from '../../server/services/recommendation.service';
import { getLlmPlaylistSettings } from '../../server/services/hubRefresh.service';

const userId = process.argv[2];
if (!userId) throw new Error('usage: make-ab.ts <userId>');

(async () => {
  const concepts = JSON.parse(fs.readFileSync(path.join(__dirname, 'concepts.json'), 'utf8')) as Array<{ prompt: string; concept: any }>;
  const tuning = await getLlmPlaylistSettings(userId);
  const key: Record<string, string> = {};
  for (const [index, { prompt, concept }] of concepts.entries()) {
    const run = async (engine: 'pools' | 'score') => (await getHubCollections([{ ...concept }], userId, {
      ...tuning, llmGenerationSource: 'custom', aiPlaylistEngine: engine, persist: false,
    }))[0];
    const [pools, score] = [await run('pools'), await run('score')];
    if (!pools || !score) { console.log(`skip ${prompt}: an engine made nothing`); continue; }
    const scoreFirst = Math.random() < 0.5;
    const n = String(index + 1).padStart(2, '0');
    key[n] = scoreFirst ? 'A=score B=pools' : 'A=pools B=score';
    for (const [label, hub] of [['A', scoreFirst ? score : pools], ['B', scoreFirst ? pools : score]] as const) {
      const id = `aitest_${n}_${label}_${Date.now().toString(36)}`;
      await createPlaylist(id, `AI test ${n} · ${label}`, `${prompt} (“${concept.title}”)`, false, userId);
      await addTracksToPlaylist(id, hub.tracks.map((t: any) => t.id));
      // Test material: only its owner sees it.
      await (await initDB()).query('UPDATE playlists SET is_private = true WHERE id = $1', [id]);
    }
    console.log(`AI test ${n}: ${prompt}`);
  }
  console.log(JSON.stringify(key));
  process.exit(0);
})();
