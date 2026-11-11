/**
 * Genre paths from the fused genres and styles (phase 4 of the genre
 * redesign): "electronic" for a genre, "electronic.house" for a style. They
 * replace the MusicBrainz tree paths ("electronic.dance.house.deep house")
 * that the AI playlists, the library's genre health, artist radio and the
 * banned-genre veto used to read, so that code keeps its prefix logic
 * ("electronic" covers every Electronic style) on Aurora's own taxonomy.
 *
 * A track has one path per fused membership (track_styles), so a track in
 * Rock › Punk and Pop has both "rock.punk" and "pop"; its primary path is its
 * strongest membership.
 */
import type { Pool, PoolClient } from 'pg';
import { tagKey } from './data';

type Db = Pool | PoolClient;

/** One path segment: lower case, dots made spaces ("P.Funk" → "p funk"). */
export const pathSegment = (name: string) => String(name || '').replace(/\./g, ' ').toLowerCase().trim();

export const genrePath = (genre: string, styleName?: string | null) =>
  styleName ? `${pathSegment(genre)}.${pathSegment(styleName)}` : pathSegment(genre);

/** The same path in SQL, for `track_styles ts LEFT JOIN style s ON s.id = ts.style_id`. */
export const PATH_SQL = `lower(replace(ts.genre, '.', ' ')) || COALESCE('.' || lower(replace(s.name, '.', ' ')), '')`;

/**
 * LEFT JOIN LATERAL giving `tgp.genre_path` (strongest membership) and
 * `tgp.genre_paths` (all of them; NULL for a track with none) for `alias`.
 */
export function trackGenrePathsJoin(alias = 't') {
  return `
    LEFT JOIN LATERAL (
      SELECT (array_agg(p.path ORDER BY p.strength DESC, p.is_genre, p.path))[1] AS genre_path,
             array_agg(p.path ORDER BY p.strength DESC, p.is_genre, p.path) AS genre_paths
      FROM (
        SELECT ${PATH_SQL} AS path, ts.strength, ts.style_id IS NULL AS is_genre
        FROM track_styles ts LEFT JOIN style s ON s.id = ts.style_id
        WHERE ts.track_id = ${alias}.id
      ) p
    ) tgp ON true`;
}

/** SQL: one of the track's paths is one of `$param` or below it. Needs trackGenrePathsJoin. */
export function pathsMatchSql(param: string) {
  return `EXISTS (SELECT 1 FROM unnest(COALESCE(tgp.genre_paths, '{}'::text[])) AS gp, unnest(${param}::text[]) AS prefix
    WHERE gp = prefix OR gp LIKE prefix || '.%')`;
}

/** Path `path` is `prefix` or below it. */
export const pathUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}.`);

/** The paths of a row from trackGenrePathsJoin (or a single genre_path). */
export function rowPaths(row: { genre_paths?: string[] | null; genre_path?: string | null }): string[] {
  if (Array.isArray(row.genre_paths) && row.genre_paths.length) return row.genre_paths;
  return row.genre_path ? [row.genre_path] : [];
}

/** A row is banned when one of its paths is a banned path or below one. */
export function isRowBanned(row: { genre_paths?: string[] | null; genre_path?: string | null }, bannedPaths: string[]): boolean {
  if (!bannedPaths.length) return false;
  return rowPaths(row).some(path => bannedPaths.some(banned => pathUnder(path, banned)));
}

interface Taxonomy {
  genres: Map<string, string>;               // tagKey → path
  styles: Array<{ key: string; path: string; genre: string }>;
}

const TAXONOMY_TTL_MS = 5 * 60 * 1000;
let taxonomyCache: { value: Promise<Taxonomy>; expiresAt: number } | null = null;

function loadTaxonomy(db: Db): Promise<Taxonomy> {
  const now = Date.now();
  if (taxonomyCache && taxonomyCache.expiresAt > now) return taxonomyCache.value;
  const value = (async () => {
    const [genres, styles] = await Promise.all([
      db.query(`SELECT name FROM taxonomy_genre`),
      db.query(`SELECT genre, name FROM style`),
    ]);
    return {
      genres: new Map(genres.rows.map((r: any) => [tagKey(r.name), genrePath(r.name)])),
      styles: styles.rows.map((r: any) => ({ key: tagKey(r.name), path: genrePath(r.genre, r.name), genre: pathSegment(r.genre) })),
    };
  })();
  value.catch(() => { taxonomyCache = null; });
  taxonomyCache = { value, expiresAt: now + TAXONOMY_TTL_MS };
  return value;
}

export function clearGenrePathCache() {
  taxonomyCache = null;
}

/**
 * Keys to try for a name: the whole name first ("P.Funk" is a style), then,
 * for a dotted path in another form ("rock.alternative rock.grunge"), its
 * last part.
 */
function nameKeys(raw: string): string[] {
  const keys = [tagKey(raw)];
  if (raw.includes('.')) keys.push(tagKey(raw.split('.').pop()!));
  return [...new Set(keys.filter(Boolean))];
}

/**
 * Paths for genre names as the AI writes them ("Deep House", "hip hop",
 * "electronic.house"): a path in our own form is taken as is; a genre name
 * gives its genre; a style name gives that style in every genre it exists in
 * ("Trip Hop" is in Electronic and Hip Hop); otherwise the library's tag
 * mapping (reliable rows; a genre-only mapping gives the genre).
 */
export async function resolveGenrePaths(db: Db, name: string): Promise<string[]> {
  const raw = String(name || '').trim();
  if (!raw) return [];
  const taxonomy = await loadTaxonomy(db);
  if (raw.includes('.')) {
    const [genre, ...rest] = raw.split('.');
    const asPath = genrePath(genre, rest.join(' ') || null);
    if (taxonomy.genres.has(tagKey(genre)) && taxonomy.styles.some(s => s.path === asPath)) return [asPath];
  }
  for (const key of nameKeys(raw)) {
    const genre = taxonomy.genres.get(key);
    if (genre) return [genre];
    const styles = taxonomy.styles.filter(s => s.key === key).map(s => s.path);
    if (styles.length) return styles;
  }
  for (const key of nameKeys(raw)) {
    const mapped = (await db.query(
      `SELECT DISTINCT m.genre, s.name FROM tag_map m LEFT JOIN style s ON s.id = m.style_id
       WHERE m.tag = $1 AND m.reliability >= 0.8`, [key])).rows as Array<{ genre: string; name: string | null }>;
    const withStyle = mapped.filter(r => r.name).map(r => genrePath(r.genre, r.name));
    if (withStyle.length) return [...new Set(withStyle)];
    if (mapped.length) return [...new Set(mapped.map(r => genrePath(r.genre)))];
  }
  return [];
}

/**
 * Banned names to paths, for the hard veto. Like resolveGenrePaths, but a
 * name also bans every style that ends in it ("metal" bans Heavy, Death and
 * Doom Metal), any mapping with a style counts (an ambiguous "hardcore" bans
 * both Hardcores), and a tag mapped only to a genre never bans that whole
 * genre: only a genre's own name does.
 */
export async function resolveBannedPaths(db: Db, names: string[]): Promise<string[]> {
  const taxonomy = await loadTaxonomy(db);
  const out = new Set<string>();
  for (const name of names) {
    const raw = String(name || '').trim();
    if (!raw) continue;
    const keys = nameKeys(raw);
    const genre = taxonomy.genres.get(keys[0]);
    if (genre) { out.add(genre); continue; }
    for (const key of keys) {
      for (const s of taxonomy.styles) if (s.key === key || s.key.endsWith(` ${key}`)) out.add(s.path);
      const mapped = (await db.query(
        `SELECT DISTINCT m.genre, s.name FROM tag_map m JOIN style s ON s.id = m.style_id WHERE m.tag = $1`, [key])).rows;
      for (const r of mapped as Array<{ genre: string; name: string }>) out.add(genrePath(r.genre, r.name));
    }
  }
  return [...out];
}

/**
 * An artist's paths from their profile (artist_styles: own tracks, each
 * album counted once): the strongest style first, then up to three more,
 * and the genre of the strongest.
 */
export async function artistGenrePaths(db: Db, artistId: string): Promise<{ primaryPath: string | null; adjacentPaths: string[]; rootPath: string | null }> {
  const rows = (await db.query(`
    SELECT a.genre, s.name
    FROM artist_styles a LEFT JOIN style s ON s.id = a.style_id
    WHERE a.artist_id::text = $1
    ORDER BY (a.style_id IS NULL), a.share DESC
    LIMIT 4`, [artistId])).rows as Array<{ genre: string; name: string | null }>;
  if (!rows.length) return { primaryPath: null, adjacentPaths: [], rootPath: null };
  const paths = [...new Set(rows.map(r => genrePath(r.genre, r.name)))];
  return { primaryPath: paths[0], adjacentPaths: paths.slice(1), rootPath: pathSegment(rows[0].genre) };
}

/**
 * The names the AI may use for target and banned genres: the genres and
 * styles the library actually has, most tracks first (genres, then styles;
 * a style name in two genres is listed once and resolves to both). Only
 * strong members count: a style the sound model guesses weakly on a few
 * hundred tracks (Trip Hop on dev: 63 guesses, no tags) would let the AI aim
 * a playlist at music the library hardly has.
 */
const VOCABULARY_MIN_STRENGTH = 0.5;
export async function getStyleVocabulary(db: Db, limit = 300): Promise<string[]> {
  const rows = (await db.query(`
    SELECT name, MAX(tracks) AS tracks, bool_or(is_genre) AS is_genre FROM (
      SELECT ts.genre AS name, COUNT(DISTINCT ts.track_id) AS tracks, true AS is_genre
      FROM track_styles ts JOIN taxonomy_genre g ON g.name = ts.genre AND NOT g.hidden
      WHERE ts.strength >= $2
      GROUP BY ts.genre
      UNION ALL
      SELECT s.name, COUNT(DISTINCT ts.track_id), false
      FROM track_styles ts JOIN style s ON s.id = ts.style_id
      JOIN taxonomy_genre g ON g.name = s.genre AND NOT g.hidden
      WHERE ts.strength >= $2
      GROUP BY s.name
    ) x
    GROUP BY name
    ORDER BY bool_or(is_genre) DESC, MAX(tracks) DESC, name
    LIMIT $1`, [limit, VOCABULARY_MIN_STRENGTH])).rows as Array<{ name: string }>;
  return rows.map(r => r.name);
}
