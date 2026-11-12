/**
 * Phase 5 evaluation set (docs/Aurora genre and style redesign.md, AI
 * playlists): asks the configured AI for one playlist concept per prompt and
 * saves the answers, so every change to the engine is judged on the same
 * input (run.ts). Run once; rerun only to replace the set.
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
  const file = path.join(__dirname, 'concepts.json');
  // Written after every answer (a local model can take minutes each); the
  // set is replaced only when every prompt has one.
  const partial = `${file}.partial`;
  for (const prompt of PROMPTS) {
    const started = Date.now();
    const concept = await generateCustomPlaylist(prompt);
    console.log(prompt, '→', concept ? `${concept.title} | targets ${JSON.stringify((concept as any).target_genres)} | focus ${(concept as any).focus} | moods ${JSON.stringify((concept as any).sound_moods)}` : 'no answer', `(${Math.round((Date.now() - started) / 1000)} s)`);
    if (concept) out.push({ prompt, concept });
    fs.writeFileSync(partial, JSON.stringify(out, null, 2) + '\n');
  }
  if (out.length === PROMPTS.length) {
    fs.renameSync(partial, file);
    console.log(`Saved ${out.length} concepts to ${file}`);
  } else {
    console.log(`Only ${out.length} of ${PROMPTS.length} answered; kept them in ${partial}`);
  }
  process.exit(0);
})();
