// Multi-value tags can reach the scanner as one string with NUL separators:
// music-metadata passes ID3v2.3 TPE2/TPE3/TPE4 through raw ("Sebastian
// Ingrosso\0Steve Angello"). Postgres rejects NUL, and stripping it glues the
// names together ("Sebastian IngrossoSteve Angello"), so every tag string is
// split on NUL before it is stored or turned into an artist.

/** The values in a tag string or list, split on NUL, trimmed, empties dropped. */
export function splitTagValues(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((item): item is string => typeof item === 'string')
    .flatMap((item) => item.split('\0'))
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * One display string for a single-valued field. Picard-style tags put the
 * display credit first and the individual artists after it ("A vs. B\0A\0B"),
 * so values already named in the first one are dropped; the rest are joined
 * with `separator`. `null` when the tag is empty.
 */
export function joinTagValues(value: unknown, separator = ', '): string | null {
  const values = splitTagValues(value);
  if (values.length === 0) return null;
  const [first, ...rest] = values;
  const lowerFirst = first.toLowerCase();
  const extra = [...new Set(rest)].filter((item) => !lowerFirst.includes(item.toLowerCase()));
  return [first, ...extra].join(separator);
}

/** The first value of a tag string or list (e.g. the primary MusicBrainz id). */
export function firstTagValue(value: unknown): string | null {
  return splitTagValues(value)[0] ?? null;
}
