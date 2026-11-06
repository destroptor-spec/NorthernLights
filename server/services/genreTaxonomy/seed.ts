/**
 * Startup seeding for the genre & style taxonomy:
 *  - taxonomy_genre / style from the Discogs-400 label list (stable style ids:
 *    rows are upserted by label, never renumbered);
 *  - MusicBrainz genre, alias and link tables from the shipped snapshot,
 *    unless the install holds a newer MBDB import.
 */
import type { Pool, PoolClient } from 'pg';
import { getSystemSetting, setSystemSetting } from '../../database';
import { HIDDEN_GENRES, loadDiscogsLabels, loadMbSnapshot, type MbGenreSnapshot } from './data';

const log = (message: string) => console.log(`[GenreTaxonomy] ${message}`);

async function inTransaction<T>(db: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function seedTaxonomy(db: Pool): Promise<{ version: number; changed: boolean }> {
  const { raw, genres, styles } = loadDiscogsLabels();
  const current = Number(await getSystemSetting('genreTaxonomyVersion')) || 0;
  const count = Number((await db.query('SELECT COUNT(*)::int AS n FROM style WHERE source = \'discogs\'')).rows[0].n);
  if (current === raw.taxonomyVersion && count === styles.length) return { version: current, changed: false };

  await inTransaction(db, async client => {
    await client.query(
      `INSERT INTO taxonomy_genre (name, hidden, taxonomy_version)
       SELECT name, hidden, $3 FROM unnest($1::text[], $2::boolean[]) AS g(name, hidden)
       ON CONFLICT (name) DO UPDATE SET taxonomy_version = EXCLUDED.taxonomy_version`,
      [genres, genres.map(g => HIDDEN_GENRES.has(g)), raw.taxonomyVersion]);
    await client.query(
      `INSERT INTO style (label, genre, name, model_index, source, taxonomy_version)
       SELECT label, genre, name, idx, 'discogs', $5
       FROM unnest($1::text[], $2::text[], $3::text[], $4::smallint[]) AS s(label, genre, name, idx)
       ON CONFLICT (label) DO UPDATE SET
         genre = EXCLUDED.genre, name = EXCLUDED.name,
         model_index = EXCLUDED.model_index, taxonomy_version = EXCLUDED.taxonomy_version`,
      [styles.map(s => s.label), styles.map(s => s.genre), styles.map(s => s.name), styles.map(s => s.modelIndex), raw.taxonomyVersion]);
  });
  await setSystemSetting('genreTaxonomyVersion', raw.taxonomyVersion);
  log(`Seeded ${genres.length} genres and ${styles.length} styles (taxonomy v${raw.taxonomyVersion})`);
  return { version: raw.taxonomyVersion, changed: true };
}

interface GenreSource { kind: 'snapshot' | 'import'; version: string }

/** Settings may be stored double-encoded (a JSON string of JSON); unwrap until an object. */
export function parseSetting<T>(value: unknown): T | null {
  for (let i = 0; i < 3 && typeof value === 'string'; i++) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' ? value as T : null;
}

/**
 * Versions are 'mb-YYYYMMDD-HHMMSS' (the MusicBrainz dump tag), so they
 * compare as strings. Returns why the snapshot should load, or null to keep
 * what the install has.
 */
export function snapshotDecision(
  snapshotVersion: string,
  tableHasRows: boolean,
  source: GenreSource | null,
  lastImportTag: string | null,
): string | null {
  if (!tableHasRows) return 'tables empty';
  const installed = source?.version ?? (lastImportTag ? `mb-${lastImportTag}` : null);
  if (!installed) return 'unknown genre source';
  if (installed < snapshotVersion) return `installed ${installed} is older`;
  return null;
}

async function writeSnapshot(db: Pool, snapshot: MbGenreSnapshot) {
  await inTransaction(db, async client => {
    // genre_alias and l_genre_genre reference genre(id); clear children first.
    await client.query('DELETE FROM l_genre_genre');
    await client.query('DELETE FROM genre_alias');
    await client.query('DELETE FROM genre');
    const g = snapshot.genres;
    await client.query(
      `INSERT INTO genre (id, gid, name, comment)
       SELECT * FROM unnest($1::int[], $2::uuid[], $3::text[], $4::text[])`,
      [g.map(r => r[0]), g.map(r => r[1]), g.map(r => r[2]), g.map(r => r[3])]);
    const a = snapshot.aliases;
    await client.query(
      `INSERT INTO genre_alias (id, genre, name, locale, type, primary_for_locale)
       SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::int[], $6::boolean[])`,
      [a.map(r => r[0]), a.map(r => r[1]), a.map(r => r[2]), a.map(r => r[3]), a.map(r => r[4]), a.map(r => r[5])]);
    const l = snapshot.links;
    await client.query(
      `INSERT INTO l_genre_genre (id, link, entity0, entity1)
       SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::int[])`,
      [l.map(r => r[0]), l.map(r => r[1]), l.map(r => r[2]), l.map(r => r[3])]);
  });
  // The old engine reads genre paths from this view until phase 4.
  try {
    await db.query('REFRESH MATERIALIZED VIEW genre_tree_paths');
  } catch (error: any) {
    console.warn('[GenreTaxonomy] genre_tree_paths refresh failed (non-fatal):', error?.message || error);
  }
}

export async function loadMbSnapshotIfNeeded(db: Pool): Promise<{ loaded: boolean; version: string; reason?: string }> {
  const snapshot = loadMbSnapshot();
  const hasRows = Number((await db.query('SELECT COUNT(*)::int AS n FROM genre')).rows[0].n) > 0;
  const source = parseSetting<GenreSource>(await getSystemSetting('mbGenreSource'));
  const lastImport = parseSetting<{ tag?: string; status?: string }>(await getSystemSetting('mbdbLastImport'));
  const reason = snapshotDecision(snapshot.version, hasRows, source,
    lastImport?.status === 'success' && lastImport.tag ? lastImport.tag : null);
  if (!reason) {
    if (!source && lastImport?.tag) await setSystemSetting('mbGenreSource', { kind: 'import', version: `mb-${lastImport.tag}` });
    return { loaded: false, version: source?.version ?? `mb-${lastImport?.tag}` };
  }
  await writeSnapshot(db, snapshot);
  await setSystemSetting('mbGenreSource', { kind: 'snapshot', version: snapshot.version });
  log(`Loaded MusicBrainz genre snapshot ${snapshot.version} (${reason}): ${snapshot.genres.length} genres, ${snapshot.aliases.length} aliases, ${snapshot.links.length} links`);
  return { loaded: true, version: snapshot.version, reason };
}
