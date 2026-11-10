/**
 * Browse: Genre → Style → music (phase 2 of docs/Aurora genre and style
 * redesign.md). Reads only the fused results (track_styles) and the album and
 * artist profiles built from them (album_styles, artist_styles); nothing here
 * loads the whole library.
 */
import type { Pool } from 'pg';
import type {
  AlbumStyleProfile,
  ArtistStyleProfile,
  BrowseDecade,
  BrowseGenreDetail,
  BrowseGenres,
  BrowseSearchResult,
  BrowseStyleDetail,
  BrowseStyleRef,
  BrowseUnsorted,
  StyleProfileEntry,
} from '../../shared/api/v1';
import { tagKey } from './genreTaxonomy/data';

/** Albums and artists on a genre or style page before "more". */
export const BROWSE_PAGE_ENTITIES = 24;
/** A profile lists a genre or style held by at least this share, or among the 3 strongest. */
const PROFILE_MIN_SHARE = 0.2;
const PROFILE_TOP = 3;

/** What a list of tracks, albums or artists is filtered to. */
export interface BrowseFilter {
  genre?: string;
  styleId?: number;
  /** With genre: only tracks in the genre without a style in it. */
  noStyle?: boolean;
  decade?: number;
  /** Tracks without a genre; with tag, only those carrying that genre tag. */
  unsorted?: boolean;
  tag?: string;
}

const styleRef = (row: any): BrowseStyleRef => ({
  id: Number(row.style_id ?? row.id), genre: String(row.genre), name: String(row.name), trackCount: Number(row.tracks),
});

export async function listBrowseGenres(db: Pool, { includeHidden = false } = {}): Promise<BrowseGenres> {
  const [genres, styles, covers, unsorted] = await Promise.all([
    db.query(`
      SELECT g.name, g.hidden, COUNT(*)::int AS tracks
      FROM track_styles ts JOIN taxonomy_genre g ON g.name = ts.genre
      WHERE ts.style_id IS NULL AND ($1 OR NOT g.hidden)
      GROUP BY g.name, g.hidden ORDER BY tracks DESC, g.name`, [includeHidden]),
    db.query(`
      SELECT ts.genre, ts.style_id, s.name, COUNT(*)::int AS tracks
      FROM track_styles ts JOIN style s ON s.id = ts.style_id
      GROUP BY ts.genre, ts.style_id, s.name ORDER BY tracks DESC, s.name`),
    // Covers: the 4 albums most in each genre (by strength, then size), with art.
    db.query(`
      SELECT genre, art_hash FROM (
        SELECT a.genre, art.art_hash,
               ROW_NUMBER() OVER (PARTITION BY a.genre ORDER BY a.strength DESC, a.tracks DESC, a.album_id) AS rank
        FROM album_styles a
        CROSS JOIN LATERAL (
          SELECT t.art_hash FROM tracks t WHERE t.album_id = a.album_id AND COALESCE(t.art_hash, '') <> ''
          ORDER BY t.track_number NULLS LAST LIMIT 1
        ) art
        WHERE a.style_id IS NULL AND a.tracks >= 3
      ) ranked WHERE rank <= 4 ORDER BY genre, rank`),
    getUnsortedCounts(db),
  ]);
  const topStyles = new Map<string, BrowseStyleRef[]>();
  for (const row of styles.rows) {
    const list = topStyles.get(row.genre) || [];
    if (list.length < 3) list.push(styleRef(row));
    topStyles.set(row.genre, list);
  }
  const artwork = new Map<string, string[]>();
  for (const row of covers.rows) artwork.set(row.genre, [...(artwork.get(row.genre) || []), String(row.art_hash)]);
  return {
    genres: genres.rows.map((row: any) => ({
      name: row.name,
      hidden: row.hidden,
      trackCount: row.tracks,
      styles: topStyles.get(row.name) || [],
      artworkIds: artwork.get(row.name) || [],
    })),
    unsorted,
  };
}

export async function getBrowseGenre(
  db: Pool, genre: string,
  load: { albums: (filter: BrowseFilter) => Promise<BrowseGenreDetail['albums']>; artists: (filter: BrowseFilter) => Promise<BrowseGenreDetail['artists']> },
): Promise<BrowseGenreDetail | null> {
  const head = (await db.query(`
    SELECT g.name, g.hidden,
           (SELECT COUNT(*) FROM track_styles ts WHERE ts.genre = g.name AND ts.style_id IS NULL)::int AS tracks
    FROM taxonomy_genre g WHERE g.name = $1`, [genre])).rows[0];
  if (!head) return null;
  const [styles, noStyle, albums, artists, decades] = await Promise.all([
    db.query(`
      SELECT ts.genre, ts.style_id, s.name, COUNT(*)::int AS tracks
      FROM track_styles ts JOIN style s ON s.id = ts.style_id
      WHERE ts.genre = $1 GROUP BY ts.genre, ts.style_id, s.name ORDER BY tracks DESC, s.name`, [genre]),
    db.query(`
      SELECT COUNT(*)::int AS n FROM track_styles g
      WHERE g.genre = $1 AND g.style_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM track_styles s WHERE s.track_id = g.track_id AND s.genre = g.genre AND s.style_id IS NOT NULL)`, [genre]),
    load.albums({ genre }),
    load.artists({ genre }),
    browseDecades(db, { genre }),
  ]);
  return {
    genre: { name: head.name, hidden: head.hidden, trackCount: head.tracks },
    styles: styles.rows.map(styleRef),
    noStyleTrackCount: noStyle.rows[0].n,
    albums,
    artists,
    decades,
  };
}

export async function getBrowseStyle(
  db: Pool, styleId: number,
  load: { albums: (filter: BrowseFilter) => Promise<BrowseStyleDetail['albums']>; artists: (filter: BrowseFilter) => Promise<BrowseStyleDetail['artists']> },
): Promise<BrowseStyleDetail | null> {
  const style = (await db.query(`
    SELECT s.id AS style_id, s.genre, s.name,
           (SELECT COUNT(*) FROM track_styles ts WHERE ts.style_id = s.id)::int AS tracks
    FROM style s WHERE s.id = $1`, [styleId])).rows[0];
  if (!style) return null;
  const [albums, artists, decades] = await Promise.all([
    load.albums({ styleId }), load.artists({ styleId }), browseDecades(db, { styleId }),
  ]);
  return { style: styleRef(style), albums, artists, decades };
}

// ── Lists ────────────────────────────────────────────────────────────────

/**
 * The track rows a filter selects, as SQL with $-parameters from `params`.
 * Rows carry track_id and a ranking strength.
 */
function trackSelection(filter: BrowseFilter, params: unknown[]): string {
  const p = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const decade = filter.decade !== undefined
    ? ` AND t.year >= ${p(filter.decade)} AND t.year < ${p(filter.decade + 10)}` : '';
  if (filter.unsorted) {
    const tag = filter.tag !== undefined
      ? ` AND EXISTS (SELECT 1 FROM track_tags tt WHERE tt.track_id = t.id AND tt.tag_key = ${p(tagKey(filter.tag))})` : '';
    return `SELECT t.id AS track_id, 0::real AS strength FROM tracks t
      WHERE NOT EXISTS (SELECT 1 FROM track_styles x WHERE x.track_id = t.id)${tag}${decade}`;
  }
  if (filter.styleId !== undefined) {
    return `SELECT ts.track_id, ts.strength FROM track_styles ts JOIN tracks t ON t.id = ts.track_id
      WHERE ts.style_id = ${p(filter.styleId)}${decade}`;
  }
  const genre = p(filter.genre ?? '');
  const noStyle = filter.noStyle
    ? ` AND NOT EXISTS (SELECT 1 FROM track_styles s WHERE s.track_id = ts.track_id AND s.genre = ts.genre AND s.style_id IS NOT NULL)` : '';
  return `SELECT ts.track_id, ts.strength FROM track_styles ts JOIN tracks t ON t.id = ts.track_id
    WHERE ts.genre = ${genre} AND ts.style_id IS NULL${noStyle}${decade}`;
}

/** Track ids for a filter, strongest first (Play, track lists). */
export async function listBrowseTrackIds(db: Pool, filter: BrowseFilter, offset: number, limit: number) {
  const params: unknown[] = [];
  const sql = trackSelection(filter, params);
  params.push(limit + 1, offset);
  const rows = (await db.query(
    `SELECT track_id FROM (${sql}) sel ORDER BY strength DESC, track_id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params)).rows;
  return { ids: rows.slice(0, limit).map((r: any) => String(r.track_id)), hasMore: rows.length > limit };
}

// ── Mix: what Shuffle plays ─────────────────────────────────────────────

/** The strongest members a mix is drawn from. */
const MIX_POOL = 300;
const MIX_MAX = 30;
const MIX_MIN = 15;
const MIX_PER_ARTIST = 2;

/**
 * How many tracks Shuffle starts with: a quarter of the genre or style,
 * 15 to 30; a small one plays whole. Infinity mode (when on) carries on.
 */
export function mixSize(total: number): number {
  if (total <= MIX_MIN) return total;
  return Math.min(MIX_MAX, Math.max(MIX_MIN, Math.round(total / 4)));
}

export interface MixCandidate { trackId: string; artist: string }

/**
 * A random handful of candidates: at most 2 per artist (relaxed only when
 * there are too few artists to fill it), ordered so the same artist doesn't
 * play twice in a row where that can be avoided.
 */
export function chooseMix(candidates: MixCandidate[], size: number, random: () => number = Math.random): string[] {
  const pool = [...candidates];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked: MixCandidate[] = [];
  const perArtist = new Map<string, number>();
  for (const candidate of pool) {
    if (picked.length >= size) break;
    const n = perArtist.get(candidate.artist) || 0;
    if (n >= MIX_PER_ARTIST) continue;
    perArtist.set(candidate.artist, n + 1);
    picked.push(candidate);
  }
  for (const candidate of pool) {
    if (picked.length >= size) break;
    if (!picked.includes(candidate)) picked.push(candidate);
  }
  // Spread artists out: next comes the artist with the most tracks left
  // (other than the one just played), so one artist's tracks don't pile up
  // at the end.
  const ordered: MixCandidate[] = [];
  const rest = [...picked];
  const left = new Map<string, number>();
  for (const c of rest) left.set(c.artist, (left.get(c.artist) || 0) + 1);
  while (rest.length) {
    const previous = ordered[ordered.length - 1]?.artist;
    let index = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].artist === previous) continue;
      if (index === -1 || left.get(rest[i].artist)! > left.get(rest[index].artist)!) index = i;
    }
    const next = rest.splice(index === -1 ? 0 : index, 1)[0];
    left.set(next.artist, left.get(next.artist)! - 1);
    ordered.push(next);
  }
  return ordered.map(c => c.trackId);
}

/** The tracks Shuffle plays for a filter, in play order. */
export async function pickBrowseMix(db: Pool, filter: BrowseFilter, random: () => number = Math.random): Promise<string[]> {
  const params: unknown[] = [];
  const sql = trackSelection(filter, params);
  params.push(MIX_POOL);
  const rows = (await db.query(`
    SELECT sel.track_id, COALESCE(tr.artist_id::text, lower(tr.artist), '') AS artist, COUNT(*) OVER () AS total
    FROM (${sql}) sel JOIN tracks tr ON tr.id = sel.track_id
    ORDER BY sel.strength DESC, random() LIMIT $${params.length}`, params)).rows;
  // Ties (every track a tag puts in a genre has the same strength) are drawn
  // at random: by id they'd be a few artists' folders (ids encode the path).
  if (rows.length === 0) return [];
  const total = Number(rows[0].total);
  return chooseMix(rows.map((r: any) => ({ trackId: String(r.track_id), artist: String(r.artist) })), mixSize(total), random);
}

async function browseDecades(db: Pool, filter: BrowseFilter): Promise<BrowseDecade[]> {
  const params: unknown[] = [];
  const sql = trackSelection(filter, params);
  const rows = (await db.query(`
    SELECT (t.year / 10) * 10 AS decade, COUNT(*)::int AS tracks
    FROM (${sql}) sel JOIN tracks t ON t.id = sel.track_id
    WHERE t.year BETWEEN 1000 AND 2999 GROUP BY 1 ORDER BY 1`, params)).rows;
  return rows.map((r: any) => ({ decade: Number(r.decade), trackCount: r.tracks }));
}

/** Albums most in a genre or style: by strength (share × how sure), then size. */
export async function listBrowseAlbumRows(db: Pool, filter: BrowseFilter, offset: number, limit: number) {
  const rows = (await db.query(`
    SELECT album_id, share, tracks FROM album_styles
    WHERE ${filter.styleId !== undefined ? 'style_id = $1' : 'genre = $1 AND style_id IS NULL'}
    ORDER BY strength DESC, tracks DESC, album_id LIMIT $2 OFFSET $3`,
  [filter.styleId ?? filter.genre, limit + 1, offset])).rows;
  return { rows: rows.slice(0, limit).map((r: any) => ({ albumId: String(r.album_id), share: Number(r.share), tracks: r.tracks })), hasMore: rows.length > limit };
}

/** Artists most in a genre or style: by album-weighted share, then albums. */
export async function listBrowseArtistRows(db: Pool, filter: BrowseFilter, offset: number, limit: number) {
  const rows = (await db.query(`
    SELECT artist_id, share, albums FROM artist_styles
    WHERE ${filter.styleId !== undefined ? 'style_id = $1' : 'genre = $1 AND style_id IS NULL'}
    ORDER BY share DESC, albums DESC, artist_id LIMIT $2 OFFSET $3`,
  [filter.styleId ?? filter.genre, limit + 1, offset])).rows;
  return { rows: rows.slice(0, limit).map((r: any) => ({ artistId: String(r.artist_id), share: Number(r.share), albums: r.albums })), hasMore: rows.length > limit };
}

// ── Search and Unsorted ──────────────────────────────────────────────────

/**
 * Genres and styles by name, and by any tag that maps to them ("Drum & Bass"
 * finds Drum n Bass). Only those with tracks; exact names first.
 */
export async function searchBrowseStyles(db: Pool, query: string, limit = 20): Promise<BrowseSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = (await db.query(`
    WITH counts AS (
      SELECT genre, style_id, COUNT(*)::int AS tracks FROM track_styles GROUP BY genre, style_id
    ), named AS (
      SELECT g.name AS genre, NULL::int AS style_id, g.name AS name, NULL::text AS alias FROM taxonomy_genre g WHERE g.name ILIKE '%' || $1 || '%'
      UNION ALL
      SELECT s.genre, s.id, s.name, NULL FROM style s WHERE s.name ILIKE '%' || $1 || '%'
      UNION ALL
      SELECT m.genre, m.style_id, COALESCE(s.name, m.genre), $1 FROM tag_map m LEFT JOIN style s ON s.id = m.style_id
      WHERE m.tag = $2 AND m.reliability >= 0.8
    )
    SELECT DISTINCT ON (n.genre, n.style_id) n.genre, n.style_id, n.name, n.alias, c.tracks
    FROM named n JOIN counts c ON c.genre = n.genre AND c.style_id IS NOT DISTINCT FROM n.style_id
    ORDER BY n.genre, n.style_id, n.alias NULLS FIRST`, [q, tagKey(q)])).rows;
  const lower = q.toLowerCase();
  const rank = (r: any) => {
    const name = String(r.name).toLowerCase();
    return name === lower ? 0 : r.alias ? 1 : name.startsWith(lower) ? 2 : 3;
  };
  return rows
    .sort((a: any, b: any) => rank(a) - rank(b) || b.tracks - a.tracks || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit)
    .map((r: any) => ({
      genre: r.genre,
      styleId: r.style_id === null ? null : Number(r.style_id),
      label: r.style_id === null ? r.genre : `${r.name} · ${r.genre}`,
      matchedAlias: r.alias && String(r.name).toLowerCase() !== lower ? q : null,
      trackCount: r.tracks,
    }));
}

async function getUnsortedCounts(db: Pool): Promise<BrowseGenres['unsorted']> {
  const row = (await db.query(`
    WITH unsorted AS (SELECT t.id FROM tracks t WHERE NOT EXISTS (SELECT 1 FROM track_styles x WHERE x.track_id = t.id))
    SELECT (SELECT COUNT(*) FROM unsorted)::int AS tracks,
           (SELECT COUNT(DISTINCT tt.tag_key) FROM track_tags tt JOIN unsorted u ON u.id = tt.track_id)::int AS tags`)).rows[0];
  return { trackCount: row.tracks, tagCount: row.tags };
}

export async function getBrowseUnsorted(db: Pool, limit = 200): Promise<BrowseUnsorted> {
  const [tags, untagged] = await Promise.all([
    db.query(`
      SELECT mode() WITHIN GROUP (ORDER BY tt.tag) AS tag, COUNT(DISTINCT tt.track_id)::int AS tracks
      FROM track_tags tt
      WHERE NOT EXISTS (SELECT 1 FROM track_styles x WHERE x.track_id = tt.track_id)
      GROUP BY tt.tag_key ORDER BY tracks DESC, tag LIMIT $1`, [limit]),
    db.query(`
      SELECT COUNT(*)::int AS n FROM tracks t
      WHERE NOT EXISTS (SELECT 1 FROM track_styles x WHERE x.track_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM track_tags tt WHERE tt.track_id = t.id)`),
  ]);
  return { tags: tags.rows.map((r: any) => ({ tag: r.tag, trackCount: r.tracks })), untaggedTrackCount: untagged.rows[0].n };
}

// ── Profiles ─────────────────────────────────────────────────────────────

/**
 * Genres and styles each held by ≥ 20 %, or among the 3 strongest of their
 * kind; genres first, each kind by share.
 */
function profileEntries<T extends { style_id: number | null; share: number; rank_value: number }>(rows: T[]): T[] {
  const keep = (list: T[]) => list
    .sort((a, b) => b.rank_value - a.rank_value)
    .filter((row, index) => index < PROFILE_TOP || row.share >= PROFILE_MIN_SHARE)
    .sort((a, b) => b.share - a.share);
  return [...keep(rows.filter(r => r.style_id === null)), ...keep(rows.filter(r => r.style_id !== null))];
}

const profileEntry = (row: any): StyleProfileEntry => ({
  genre: row.genre,
  styleId: row.style_id === null ? null : Number(row.style_id),
  style: row.style ?? null,
  share: Math.min(1, Number(row.share)),
  trackCount: row.tracks,
});

export async function getAlbumStyleProfile(db: Pool, albumId: string): Promise<AlbumStyleProfile> {
  const rows = (await db.query(`
    SELECT a.genre, a.style_id, s.name AS style, a.share, a.strength AS rank_value, a.tracks
    FROM album_styles a LEFT JOIN style s ON s.id = a.style_id WHERE a.album_id = $1`, [albumId])).rows
    .map((r: any) => ({ ...r, share: Number(r.share), rank_value: Number(r.rank_value) }));
  return { entries: profileEntries(rows).map(profileEntry) };
}

export async function getArtistStyleProfile(db: Pool, artistId: string): Promise<ArtistStyleProfile> {
  const [rows, tags] = await Promise.all([
    db.query(`
      SELECT a.genre, a.style_id, s.name AS style, a.share, a.share AS rank_value, a.tracks, a.albums
      FROM artist_styles a LEFT JOIN style s ON s.id = a.style_id WHERE a.artist_id = $1`, [artistId]),
    db.query(`
      SELECT mode() WITHIN GROUP (ORDER BY tag) AS tag, MAX(weight) AS weight
      FROM artist_tags WHERE artist_id = $1 AND weight >= 0.2
      GROUP BY tag_key ORDER BY weight DESC, tag_key LIMIT 8`, [artistId]),
  ]);
  const entries = profileEntries(rows.rows.map((r: any) => ({ ...r, share: Number(r.share), rank_value: Number(r.rank_value) })));
  return {
    entries: entries.map((r: any) => ({ ...profileEntry(r), albumCount: r.albums })),
    listenerTags: tags.rows.map((r: any) => String(r.tag)),
  };
}
