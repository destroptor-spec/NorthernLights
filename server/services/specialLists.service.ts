/**
 * Special lists (docs/Aurora genre and style redesign.md, AI playlists →
 * Special lists): tightly themed playlists the library can carry. This module
 * builds the menu of themes a library supports; the AI picks from it and
 * names the list, and the engine builds it strictly from the theme's tracks.
 *
 * A theme qualifies with at least 2 × L songs that are strong members
 * (strength ≥ 0.5, or a clear mood match for an activity) from at least
 * ⌈L / 2⌉ artists, L being the playlist length: enough to be good and to come
 * back fresh another day. Too broad is not a theme (a whole genre is a
 * general list); too narrow fails the minimum.
 */
import type { Pool, PoolClient } from 'pg';
import { STRONG_MEMBER } from './aiPlaylistScore.service';

type Db = Pool | PoolClient;

export type ThemeKind = 'style' | 'place' | 'era' | 'activity';

export interface Theme {
  /** Stable key, stored with a playlist so themes rotate: "style:123", "place:Hip Hop:DK", "era:123:1990", "activity:focus". */
  key: string;
  kind: ThemeKind;
  /** For the AI and the logs: "Trance", "Hip Hop · Denmark", "Eurodance · 1990s", "Focus". */
  label: string;
  genre?: string;
  styleId?: number;
  styleName?: string;
  country?: string;
  decade?: number;
  activity?: ActivityName;
  songs: number;
  artists: number;
  /** The user's plays of the theme's tracks in the last 90 days. */
  recentPlays: number;
}

export type ActivityName = 'focus' | 'workout' | 'wind-down' | 'party';

/**
 * Activities by the sound (track_moods, and instrumental / acoustic from
 * analysis): SQL conditions on `mo` (track_moods) and `tf` (track_features).
 * Focus leaves out film and game scores: to the mood models a score is as
 * calm and instrumental as music gets, and in a blind comparison
 * (12 Nov 2026) they made a coding playlist worse.
 */
export const ACTIVITIES: Record<ActivityName, { label: string; sql: string; describe: string }> = {
  focus: {
    label: 'Focus',
    describe: 'instrumental, calm and steady; no film or game scores',
    sql: `(tf.acoustic_vector_8d::real[])[5] >= 0.7 AND mo.relaxed >= 0.6 AND mo.aggressive <= 0.3 AND mo.party <= 0.5
          AND NOT EXISTS (SELECT 1 FROM track_styles sx WHERE sx.track_id = t.id AND sx.genre = 'Stage & Screen' AND sx.strength >= ${STRONG_MEMBER})`,
  },
  workout: {
    label: 'Workout',
    describe: 'hard, driving and energetic',
    // Party alone covers most dance music (12,469 dev tracks); Party is its own activity.
    sql: `mo.aggressive >= 0.75 AND mo.relaxed <= 0.2`,
  },
  'wind-down': {
    label: 'Wind-down',
    describe: 'calm, soft and unhurried',
    sql: `mo.relaxed >= 0.85 AND mo.party <= 0.2 AND mo.aggressive <= 0.15`,
  },
  party: {
    label: 'Party',
    describe: 'danceable, festive and bright',
    sql: `mo.party >= 0.85 AND mo.happy >= 0.5 AND mo.aggressive <= 0.5`,
  },
};

/** How many of each kind the menu keeps, so one kind never fills it. */
const KIND_CAP: Record<ThemeKind, number> = { style: 16, place: 10, era: 10, activity: 4 };
/**
 * A place theme must be distinctive: the country at least this many times
 * more common in the genre than in the library, so "Hip Hop · Denmark"
 * qualifies and "Pop · United States" (where most pop comes from) does not.
 */
const PLACE_MIN_LIFT = 1.5;

const SONG_KEY = `COALESCE(NULLIF(t.mb_recording_id, ''), lower(t.artist) || ':' || lower(t.title))`;
const RECENT_PLAYS = `COALESCE(SUM(ups.play_count) FILTER (WHERE ups.last_played_at > NOW() - INTERVAL '90 days'), 0)::int`;

export function themeMinimums(playlistLength: number) {
  return { songs: 2 * playlistLength, artists: Math.ceil(playlistLength / 2) };
}

const decadeLabel = (decade: number) => `${decade}s`;

/** Country name for a theme label ("DK" → "Denmark"). */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

/**
 * The themes this library supports for this user, best first: what the user
 * has played in the last 90 days, then depth, never a theme in `excludeKeys`
 * (made recently). At most `limit`, with a cap per kind.
 */
export async function buildThemeMenu(db: Db, opts: {
  userId: string | null;
  playlistLength: number;
  excludeKeys?: Iterable<string>;
  limit?: number;
}): Promise<Theme[]> {
  const min = themeMinimums(opts.playlistLength);
  const exclude = new Set(opts.excludeKeys ?? []);
  const limit = opts.limit ?? 40;
  const params = [opts.userId, STRONG_MEMBER, min.songs, min.artists];
  const [styles, places, eras, activities] = await Promise.all([
    db.query(`
      SELECT ts.style_id, s.genre, s.name, COUNT(DISTINCT ${SONG_KEY})::int AS songs,
             COUNT(DISTINCT t.artist_id)::int AS artists, ${RECENT_PLAYS} AS plays
      FROM track_styles ts
      JOIN style s ON s.id = ts.style_id
      JOIN taxonomy_genre g ON g.name = ts.genre AND NOT g.hidden
      JOIN tracks t ON t.id = ts.track_id
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1::uuid
      WHERE ts.strength >= $2
      GROUP BY ts.style_id, s.genre, s.name
      HAVING COUNT(DISTINCT ${SONG_KEY}) >= $3 AND COUNT(DISTINCT t.artist_id) >= $4`, params),
    db.query(`
      WITH members AS (
        SELECT DISTINCT ts.genre, t.id, t.artist_id, t.mb_recording_id, t.artist, t.title
        FROM track_styles ts JOIN taxonomy_genre g ON g.name = ts.genre AND NOT g.hidden
        JOIN tracks t ON t.id = ts.track_id
        WHERE ts.strength >= $2
      ), totals AS (
        SELECT genre, COUNT(DISTINCT ${SONG_KEY.replace(/t\./g, 'm.')})::int AS songs FROM members m GROUP BY genre
      ), library AS (
        SELECT country, COUNT(*)::float8 / SUM(COUNT(*)) OVER () AS share
        FROM track_origin WHERE country IS NOT NULL GROUP BY country
      )
      SELECT m.genre, o.country, COUNT(DISTINCT ${SONG_KEY.replace(/t\./g, 'm.')})::int AS songs,
             COUNT(DISTINCT m.artist_id)::int AS artists,
             COALESCE(SUM(ups.play_count) FILTER (WHERE ups.last_played_at > NOW() - INTERVAL '90 days'), 0)::int AS plays,
             MAX(tot.songs) AS genre_songs, MAX(lib.share) AS country_share
      FROM members m
      JOIN track_origin o ON o.track_id = m.id AND o.country IS NOT NULL
      JOIN totals tot ON tot.genre = m.genre
      JOIN library lib ON lib.country = o.country
      LEFT JOIN user_playback_stats ups ON ups.track_id = m.id AND ups.user_id = $1::uuid
      GROUP BY m.genre, o.country
      HAVING COUNT(DISTINCT ${SONG_KEY.replace(/t\./g, 'm.')}) >= $3 AND COUNT(DISTINCT m.artist_id) >= $4`, params),
    db.query(`
      SELECT ts.style_id, s.genre, s.name, o.decade, COUNT(DISTINCT ${SONG_KEY})::int AS songs,
             COUNT(DISTINCT t.artist_id)::int AS artists, ${RECENT_PLAYS} AS plays
      FROM track_styles ts
      JOIN style s ON s.id = ts.style_id
      JOIN taxonomy_genre g ON g.name = ts.genre AND NOT g.hidden
      JOIN tracks t ON t.id = ts.track_id
      JOIN track_origin o ON o.track_id = t.id AND o.decade IS NOT NULL
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1::uuid
      WHERE ts.strength >= $2
      GROUP BY ts.style_id, s.genre, s.name, o.decade
      HAVING COUNT(DISTINCT ${SONG_KEY}) >= $3 AND COUNT(DISTINCT t.artist_id) >= $4`, params),
    Promise.all((Object.entries(ACTIVITIES) as Array<[ActivityName, typeof ACTIVITIES[ActivityName]]>).map(async ([name, a]) => {
      const row = (await db.query(`
        SELECT COUNT(DISTINCT ${SONG_KEY})::int AS songs, COUNT(DISTINCT t.artist_id)::int AS artists, ${RECENT_PLAYS} AS plays
        FROM tracks t
        JOIN track_moods mo ON mo.track_id = t.id
        JOIN track_features tf ON tf.track_id = t.id AND NOT tf.is_simulated
        LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1::uuid
        WHERE ${a.sql}`, [opts.userId])).rows[0];
      return { name, ...row };
    })),
  ]);

  const themes: Theme[] = [];
  for (const r of styles.rows) {
    themes.push({ key: `style:${r.style_id}`, kind: 'style', label: r.name, genre: r.genre, styleId: r.style_id, styleName: r.name, songs: r.songs, artists: r.artists, recentPlays: r.plays });
  }
  for (const r of places.rows) {
    const lift = (r.songs / Number(r.genre_songs)) / Number(r.country_share);
    if (!(lift >= PLACE_MIN_LIFT)) continue;
    themes.push({ key: `place:${r.genre}:${r.country}`, kind: 'place', label: `${r.genre} · ${countryName(r.country)}`, genre: r.genre, country: r.country, songs: r.songs, artists: r.artists, recentPlays: r.plays });
  }
  for (const r of eras.rows) {
    themes.push({ key: `era:${r.style_id}:${r.decade}`, kind: 'era', label: `${r.name} · ${decadeLabel(r.decade)}`, genre: r.genre, styleId: r.style_id, styleName: r.name, decade: r.decade, songs: r.songs, artists: r.artists, recentPlays: r.plays });
  }
  for (const r of activities) {
    if (r.songs < min.songs || r.artists < min.artists) continue;
    themes.push({ key: `activity:${r.name}`, kind: 'activity', label: ACTIVITIES[r.name as ActivityName].label, activity: r.name as ActivityName, songs: r.songs, artists: r.artists, recentPlays: r.plays });
  }

  // What the user plays leads; depth breaks ties and ranks themes nobody has played yet.
  const rank = (t: Theme) => Math.log10(1 + t.recentPlays) + 0.25 * Math.log10(t.songs);
  const perKind: Record<ThemeKind, number> = { style: 0, place: 0, era: 0, activity: 0 };
  return themes
    .filter(t => !exclude.has(t.key))
    .sort((a, b) => rank(b) - rank(a) || b.songs - a.songs || a.key.localeCompare(b.key))
    .filter(t => (perKind[t.kind]++ < KIND_CAP[t.kind]))
    .slice(0, limit);
}
