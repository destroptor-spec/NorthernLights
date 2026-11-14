/**
 * The phase 5 scale test: AI playlists (the saved concepts), special lists
 * (menu and builds), artist radio and the Discover rail, timed on one
 * library database. Nothing is saved except the Discover rail's system
 * playlists, which belong to that database's test user.
 *
 *   DB_NAME=aurora_small npx tsx scripts/library-scale/run-scale.ts <userId> [--tracks]
 *
 * --tracks also prints the first tracks of each playlist (for judging a
 * small library by eye).
 */
import fs from 'fs';
import path from 'path';

const userId = process.argv[2];
const showTracks = process.argv.includes('--tracks');
if (!userId) throw new Error('usage: DB_NAME=<db> run-scale.ts <userId> [--tracks]');

const ms = (since: number) => `${Date.now() - since} ms`;

(async () => {
  const { initDB } = await import('../../server/database');
  const { getHubCollections } = await import('../../server/services/recommendation.service');
  const { getLlmPlaylistSettings } = await import('../../server/services/hubRefresh.service');
  const { buildThemeMenu, conceptForTheme } = await import('../../server/services/specialLists.service');
  const { computeArtistCentroids } = await import('../../server/services/candidatePool.service');
  const { artistRadioLength, artistRadioTrackIds } = await import('../../server/services/smartHub.service');
  const db = await initDB();
  const size = (await db.query(`SELECT current_database() AS db, (SELECT COUNT(*) FROM tracks)::int AS tracks,
    (SELECT COUNT(*) FROM track_features WHERE NOT is_simulated)::int AS analysed, (SELECT COUNT(*) FROM artists)::int AS artists`)).rows[0] as any;
  console.log(`\n# ${size.db}: ${size.tracks} tracks, ${size.analysed} analysed, ${size.artists} artists`);
  const tuning = await getLlmPlaylistSettings(userId);
  const L = tuning.llmTracksPerPlaylist;
  const timings: Record<string, number[]> = {};
  const time = (key: string, value: number) => { (timings[key] ??= []).push(value); };
  const describe = (tracks: any[]) => `${tracks.length} tracks / ${new Set(tracks.map((t: any) => t.artist)).size} artists`;
  const sample = (tracks: any[]) => showTracks ? `\n      ${tracks.slice(0, 6).map((t: any) => `${t.artist} — ${t.title}`).join('\n      ')}` : '';

  // AI playlists: the saved concepts.
  console.log(`\n## AI playlists (${L} tracks each)`);
  const concepts = JSON.parse(fs.readFileSync(path.join(__dirname, '../ai-playlist-eval/concepts.json'), 'utf8')) as Array<{ prompt: string; concept: any }>;
  for (const { prompt, concept } of concepts) {
    const started = Date.now();
    const c = { ...concept };
    const [hub] = await getHubCollections([c], userId, { ...tuning, llmGenerationSource: 'custom', persist: false });
    time('ai', Date.now() - started);
    const outcome = c.dropped ? `not made (${c.dropReason ?? 'dropped'}${c.support ? `: ${c.support.message}` : ''})` : describe(hub?.tracks ?? []);
    console.log(`- ${prompt}: ${outcome}, ${ms(started)}${c.dropped ? '' : sample(hub?.tracks ?? [])}`);
  }

  // Special lists: the menu, then its first themes built from a neutral sound.
  console.log('\n## Special lists');
  let started = Date.now();
  const menu = await buildThemeMenu(db, { userId, playlistLength: L });
  time('menu', Date.now() - started);
  const kinds = menu.reduce((acc: Record<string, number>, t) => ({ ...acc, [t.kind]: (acc[t.kind] ?? 0) + 1 }), {});
  console.log(`- menu: ${menu.length} themes ${JSON.stringify(kinds)}, ${ms(started)}${menu.length ? `; first: ${menu.slice(0, 5).map(t => t.label).join(', ')}` : ''}`);
  for (const theme of menu.slice(0, 4)) {
    started = Date.now();
    const c: any = conceptForTheme(theme, { title: `Test: ${theme.label}`, description: '', target_vector: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] });
    const [hub] = await getHubCollections([c], userId, { ...tuning, llmGenerationSource: 'hub', persist: false });
    time('special', Date.now() - started);
    console.log(`- ${theme.label} (${theme.songs} songs): ${c.dropped ? `not made (${c.dropReason})` : describe(hub?.tracks ?? [])}, ${ms(started)}${c.dropped ? '' : sample(hub?.tracks ?? [])}`);
  }

  // Artist radio: the three most played artists with enough analysed tracks.
  console.log('\n## Artist radio');
  const radioLength = await artistRadioLength();
  const artists = (await db.query(`
    SELECT a.id, a.name FROM artists a JOIN tracks t ON t.artist_id = a.id
    LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
    WHERE NOT COALESCE(a.is_va_pseudo, FALSE)
    GROUP BY a.id, a.name HAVING COUNT(*) >= 3
    ORDER BY COALESCE(SUM(ups.play_count), 0) DESC, COUNT(*) DESC LIMIT 3`, [userId])).rows as Array<{ id: string; name: string }>;
  for (const artist of artists) {
    started = Date.now();
    const centroids = await computeArtistCentroids(userId, artist.id, 5, { sampleFrom: 12 });
    const ids = centroids ? await artistRadioTrackIds(userId, artist.id, artist.name, radioLength, centroids) : [];
    time('radio', Date.now() - started);
    const tracks = ids.length ? (await db.query('SELECT id, artist, title FROM tracks WHERE id = ANY($1::text[])', [ids])).rows : [];
    console.log(`- ${artist.name} Radio: ${describe(tracks)} (length ${radioLength}), ${ms(started)}${sample(tracks)}`);
  }

  // The Discover rail: every engine system playlist, rebuilt.
  console.log('\n## Discover rail');
  const { setSystemSetting } = await import('../../server/database');
  await setSystemSetting('systemPlaylistConfigUpdatedAt', String(Date.now()));
  started = Date.now();
  const rail = (await getHubCollections([], userId, {} as any)).filter((h: any) => String(h.id).startsWith('engine_'));
  time('rail', Date.now() - started);
  console.log(`- ${rail.length} playlists, ${ms(started)}: ${rail.map((h: any) => h.title).join(', ')}`);

  console.log('\n## Timings (ms)');
  for (const [key, values] of Object.entries(timings)) {
    const sorted = [...values].sort((a, b) => a - b);
    console.log(`- ${key}: median ${sorted[Math.floor(sorted.length / 2)]}, max ${sorted[sorted.length - 1]} (${values.length} runs)`);
  }
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
