/**
 * Special lists on this library: builds the theme menu, asks the AI for
 * picks, and builds each without saving, printing the dry run and the
 * tracks.
 *
 *   npx tsx scripts/ai-playlist-eval/special.ts <userId> [count] [--theme=<key>]
 *
 * --theme builds one theme with a neutral sound, without the AI.
 */
import { initDB } from '../../server/database';
import { getHubCollections } from '../../server/services/recommendation.service';
import { getLlmPlaylistSettings } from '../../server/services/hubRefresh.service';
import { generateSpecialPicks } from '../../server/services/llm.service';
import { buildThemeMenu, conceptForTheme, menuForAi } from '../../server/services/specialLists.service';

const userId = process.argv[2];
const count = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 3;
const only = process.argv.find(a => a.startsWith('--theme='))?.slice(8);

(async () => {
  const db = await initDB();
  const tuning = await getLlmPlaylistSettings(userId);
  const L = tuning.llmTracksPerPlaylist;
  const menu = await buildThemeMenu(db, { userId, playlistLength: L });
  console.log(`Menu: ${menu.length} themes for ${L}-track lists`);
  const picks = only
    ? [{ theme: only, title: `Test: ${menu.find(t => t.key === only)?.label}`, description: '', target_vector: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }]
    : await generateSpecialPicks(menuForAi(menu), count);
  for (const pick of picks) {
    const theme = menu.find(t => t.key === pick.theme);
    if (!theme) { console.log(`not on the menu: ${pick.theme}`); continue; }
    const concept = conceptForTheme(theme, pick);
    const [hub] = await getHubCollections([concept as any], userId, { ...tuning, llmGenerationSource: 'custom', persist: false });
    console.log(`\n=== ${pick.title} — ${theme.label} (${theme.songs} songs, ${theme.artists} artists)${hub ? '' : ' — not made'}`);
    if (!hub) continue;
    const styles = new Map((await db.query(`
      SELECT ts.track_id, string_agg(COALESCE(s.name, ts.genre), ', ' ORDER BY ts.strength DESC) AS s
      FROM track_styles ts LEFT JOIN style s ON s.id = ts.style_id WHERE ts.track_id = ANY($1) AND ts.strength >= 0.5 GROUP BY ts.track_id`,
      [hub.tracks.map((t: any) => t.id)])).rows.map((r: any) => [r.track_id, r.s]));
    hub.tracks.forEach((t: any, i: number) => console.log(`  ${String(i + 1).padStart(2)}. ${t.artist} — ${t.title}  [${styles.get(t.id) ?? ''}]`));
  }
  process.exit(0);
})();
