// Christmas / holiday content is suppressed from every auto-generated surface
// outside its season (Dec 1 – Jan 5, through Epiphany). We match on genre +
// album, never track title — "Holiday" by Madonna is not Christmas music (and
// the album pattern omits "holiday" for the same reason).
//
// Shared by candidatePool, smartHub, and the recommendation engine so the
// policy is applied identically on every candidate path (issue #18).

export function isChristmasSeason(now: Date = new Date()): boolean {
  const m = now.getMonth();
  const d = now.getDate();
  if (m === 11) return true; // December
  if (m === 0 && d <= 5) return true; // Jan 1–5 (through Epiphany)
  return false;
}

/**
 * SQL `AND` clauses excluding Christmas tracks by genre/album. Returns an empty
 * string during the season (nothing suppressed). `trackAlias` is the alias the
 * query uses for the `tracks` table (e.g. `'t'`).
 */
export function christmasExclusionSql(trackAlias: string): string {
  if (isChristmasSeason()) return '';
  return `
    AND COALESCE(${trackAlias}.genre, '') !~* '(christmas|xmas|holiday|noel)'
    AND COALESCE(${trackAlias}.album, '') !~* '(christmas|xmas|noel)'
  `;
}

/**
 * JS mirror of {@link christmasExclusionSql} for filtering already-fetched
 * candidate rows at a choke point where re-querying isn't practical. Returns
 * true if the row is Christmas content (checked against whichever of
 * genre / album / album_title the row carries). Callers gate on
 * {@link isChristmasSeason} themselves.
 */
export function isChristmasRow(row: {
  genre?: string | null;
  album?: string | null;
  album_title?: string | null;
}): boolean {
  const genre = row?.genre ?? '';
  const album = row?.album ?? row?.album_title ?? '';
  return /(christmas|xmas|holiday|noel)/i.test(genre) || /(christmas|xmas|noel)/i.test(album);
}
