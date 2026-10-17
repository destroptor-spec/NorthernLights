// An artist's picture as the Artists grid shows it: the provider portrait
// (`image_url`), else the stored provider artwork (`artwork_url`). Every query
// that returns an artist picture uses this so no surface shows initials for an
// artist the grid shows a photo for. Empty strings count as missing.

/**
 * SQL expression for an artist's display image. `artistAlias` is the alias the
 * query uses for the `artists` table (e.g. `'a'`). A query that groups by the
 * artist must also group by `image_url` and `artwork_url` (or the primary key).
 */
export function artistImageSql(artistAlias: string): string {
  return `COALESCE(NULLIF(${artistAlias}.image_url, ''), NULLIF(${artistAlias}.artwork_url, ''))`;
}
