/**
 * Runs the saved evaluation concepts (concepts.json) through the AI playlist
 * engine without saving anything, and prints each playlist with every
 * track's genres and styles. AI_SCORE_DEBUG=1 also prints the top scores.
 *
 *   npx tsx scripts/ai-playlist-eval/run.ts [userId] [--only=<prompt substring>] [--concepts=<file>] [--no-moods]
 *
 * The blind comparison against the old six-pool engine (rated 2026-11-11:
 * the score 6, the pools 3, 1 tie) was built by make-ab.ts, removed with the
 * pools; see git history before the pools' removal.
 */
import fs from 'fs';
import path from 'path';
import { initDB } from '../../server/database';
import { getHubCollections } from '../../server/services/recommendation.service';
import { getLlmPlaylistSettings } from '../../server/services/hubRefresh.service';

const userId = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).toLowerCase();
const conceptsFile = process.argv.find(a => a.startsWith('--concepts='))?.slice(11) ?? path.join(__dirname, 'concepts.json');
const moodTerm = !process.argv.includes('--no-moods');

(async () => {
  const db = await initDB();
  const concepts = JSON.parse(fs.readFileSync(conceptsFile, 'utf8')) as Array<{ prompt: string; concept: any }>;
  const tuning = userId ? await getLlmPlaylistSettings(userId) : {};
  for (const { prompt, concept } of concepts) {
    if (only && !prompt.toLowerCase().includes(only)) continue;
    const started = Date.now();
    const [hub] = await getHubCollections([{ ...concept }], userId, { ...tuning, llmGenerationSource: 'custom', persist: false, moodTerm });
    const ms = Date.now() - started;
    console.log(`\n=== ${prompt} → "${concept.title}" (${ms} ms)`);
    if (!hub) { console.log('  (dropped)'); continue; }
    const ids = hub.tracks.map((t: any) => t.id);
    const styles = new Map((await db.query(`
      SELECT ts.track_id, string_agg(COALESCE(s.name, ts.genre) || ' ' || to_char(ts.strength, 'FM0.00'), ', ' ORDER BY ts.strength DESC) AS s
      FROM track_styles ts LEFT JOIN style s ON s.id = ts.style_id
      WHERE ts.track_id = ANY($1) GROUP BY ts.track_id`, [ids])).rows.map((r: any) => [r.track_id, r.s]));
    hub.tracks.forEach((t: any, i: number) => console.log(`  ${String(i + 1).padStart(2)}. ${t.artist} — ${t.title}  [${styles.get(t.id) ?? 'no genre'}]`));
  }
  process.exit(0);
})();
