/**
 * Maintainer tool: writes server/data/genre-taxonomy/musicbrainz-genres.json
 * from the MusicBrainz genre tables of a database that ran the MBDB import
 * (Settings → Database). Aurora ships that snapshot, so installs no longer
 * need the 4 GB dump just for 2,000 genres (see docs/Aurora genre and style
 * redesign.md, "MusicBrainz genre data").
 *
 * Usage: npx tsx scripts/build-mb-genre-snapshot.ts
 * The genre, alias and genre-genre link tables come from MusicBrainz's core
 * dump (mbdump.tar.bz2), which MusicBrainz publishes under CC0.
 */
import fs from 'fs';
import path from 'path';
import { initDB, getSystemSetting } from '../server/database';

async function main() {
  const db = await initDB();
  const lastImport = await getSystemSetting('mbdbLastImport');
  const tag = (() => {
    // Stored as a JSON string; getSystemSetting may already have parsed it.
    const value = typeof lastImport === 'string' ? (() => { try { return JSON.parse(lastImport); } catch { return null; } })() : lastImport;
    return (value && typeof value === 'object' && typeof value.tag === 'string') ? value.tag as string : undefined;
  })();
  if (!tag) throw new Error('No MBDB import recorded (system setting mbdbLastImport); run the import first.');

  const genres = (await db.query(
    'SELECT id, gid::text AS gid, name, NULLIF(comment, \'\') AS comment FROM genre ORDER BY id')).rows;
  const aliases = (await db.query(
    'SELECT id, genre, name, locale, type, COALESCE(primary_for_locale, false) AS primary FROM genre_alias ORDER BY id')).rows;
  const links = (await db.query(
    'SELECT id, link, entity0, entity1 FROM l_genre_genre ORDER BY id')).rows;
  if (genres.length < 1000) throw new Error(`Only ${genres.length} genres; is the import complete?`);

  // Compact row arrays keep the committed file small and diffable.
  const snapshot = {
    version: `mb-${tag}`,
    source: `MusicBrainz core dump ${tag} (genre, genre_alias, l_genre_genre)`,
    license: 'CC0 1.0 (MusicBrainz core data)',
    columns: {
      genres: ['id', 'gid', 'name', 'comment'],
      aliases: ['id', 'genre', 'name', 'locale', 'type', 'primary'],
      links: ['id', 'link', 'entity0', 'entity1'],
    },
    genres: genres.map(g => [g.id, g.gid, g.name, g.comment]),
    aliases: aliases.map(a => [a.id, a.genre, a.name, a.locale, a.type, a.primary]),
    links: links.map(l => [l.id, l.link, l.entity0, l.entity1]),
  };
  const out = path.join(__dirname, '..', 'server', 'data', 'genre-taxonomy', 'musicbrainz-genres.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot) + '\n');
  console.log(`Wrote ${out}: ${genres.length} genres, ${aliases.length} aliases, ${links.length} links (${snapshot.version})`);
  process.exit(0);
}

main().catch(error => { console.error(error); process.exit(1); });
