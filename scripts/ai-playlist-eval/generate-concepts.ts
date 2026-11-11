/**
 * Phase 5 evaluation set (docs/Aurora genre and style redesign.md, AI
 * playlists): asks the configured AI for one playlist concept per prompt and
 * saves the answers, so the pool engine and the scored engine are compared on
 * the same input. Run once; rerun only to replace the set.
 *
 *   npx tsx scripts/ai-playlist-eval/generate-concepts.ts
 */
import fs from 'fs';
import path from 'path';
import { generateCustomPlaylist } from '../../server/services/llm.service';

const PROMPTS = [
  'Euphoric, melodic trance with progressive structures and soaring synthesizers',
  "Dansk rap fra 90'erne",
  'Music for code: focused, steady, mostly instrumental',
  'Velvet Shadows: dark, sultry late-night grooves',
  '90s Eurodance party',
  'Acoustic Sunday morning with coffee',
  'Heavy metal for the gym',
  'Deep house for a warm summer evening',
  'Melancholic indie rock for a rainy day',
  'Jazz for a dinner party',
];

(async () => {
  const out: unknown[] = [];
  for (const prompt of PROMPTS) {
    const concept = await generateCustomPlaylist(prompt);
    console.log(prompt, '→', concept ? `${concept.title} | targets ${JSON.stringify((concept as any).target_genres)} | banned ${JSON.stringify((concept as any).banned_genres)}` : 'no answer');
    if (concept) out.push({ prompt, concept });
  }
  const file = path.join(__dirname, 'concepts.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`Saved ${out.length} concepts to ${file}`);
  process.exit(0);
})();
