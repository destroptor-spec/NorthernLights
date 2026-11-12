/**
 * Blind comparison of two AI playlist engine variants on the saved concepts
 * (concepts.json): one playlist from each, saved privately for a user as
 * "<label> NN · A" and "· B" in random order. Prints the key as JSON on the
 * last line; keep it away from whoever rates.
 *
 *   npx tsx scripts/ai-playlist-eval/make-ab.ts <userId> [label] [--concepts=<file>]
 *
 * Variants: mood-led (moodTerm: true: focus and moods from the sound)
 * against the engine before them (moodTerm: false).
 */
import fs from 'fs';
import path from 'path';
import { addTracksToPlaylist, createPlaylist, initDB } from '../../server/database';
import { getHubCollections } from '../../server/services/recommendation.service';
import { getLlmPlaylistSettings } from '../../server/services/hubRefresh.service';

const userId = process.argv[2];
const label = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'Mood test';
const conceptsFile = process.argv.find(a => a.startsWith('--concepts='))?.slice(11) ?? path.join(__dirname, 'concepts.json');
if (!userId) throw new Error('usage: make-ab.ts <userId> [label]');

(async () => {
  const concepts = JSON.parse(fs.readFileSync(conceptsFile, 'utf8')) as Array<{ prompt: string; concept: any }>;
  const tuning = await getLlmPlaylistSettings(userId);
  const key: Record<string, string> = {};
  for (const [index, { prompt, concept }] of concepts.entries()) {
    const run = async (moodTerm: boolean) => (await getHubCollections([{ ...concept }], userId, {
      ...tuning, llmGenerationSource: 'custom', persist: false, moodTerm,
    }))[0];
    const [mood, before] = [await run(true), await run(false)];
    if (!mood || !before) { console.log(`skip ${prompt}: an engine made nothing`); continue; }
    const moodFirst = Math.random() < 0.5;
    const n = String(index + 1).padStart(2, '0');
    key[n] = moodFirst ? 'A=mood B=before' : 'A=before B=mood';
    for (const [side, hub] of [['A', moodFirst ? mood : before], ['B', moodFirst ? before : mood]] as const) {
      const id = `abtest_${n}_${side}_${Date.now().toString(36)}`;
      await createPlaylist(id, `${label} ${n} · ${side}`, `${prompt} (“${concept.title}”)`, false, userId);
      await addTracksToPlaylist(id, hub.tracks.map((t: any) => t.id));
      // Test material: only its owner sees it.
      await (await initDB()).query('UPDATE playlists SET is_private = true WHERE id = $1', [id]);
    }
    console.log(`${label} ${n}: ${prompt}`);
  }
  console.log(JSON.stringify(key));
  process.exit(0);
})();
