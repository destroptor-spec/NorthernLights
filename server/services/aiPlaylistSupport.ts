/**
 * The support check for custom AI playlists (docs/Aurora genre and style
 * redesign.md, AI playlists → Special lists → Custom requests): a request
 * that names a theme with hard filters ("Dansk rap fra 90'erne" → Hip Hop,
 * Denmark or Danish, 1990s), or one that names a style ("Jazz for a dinner
 * party"), is only made when the library has enough of it. Otherwise Aurora
 * says how much there is, instead of padding the list with something else.
 */

/** What the library has of a requested theme that is too thin for a playlist. */
export interface ThinRequest {
  /** Songs that are members of the requested styles and pass the hard filters. */
  songs: number;
  artists: number;
  /** The playlist length asked for. */
  needed: number;
  /** "Hip Hop or Gangsta tracks from Denmark or sung in Danish from the 1990s" */
  theme: string;
  message: string;
}

/** Thrown by generateCustomHubPlaylist when the library can't carry the request. */
export class ThinRequestError extends Error {
  readonly support: ThinRequest;
  constructor(support: ThinRequest) {
    super(support.message);
    this.name = 'ThinRequestError';
    this.support = support;
  }
}

/** The hard filters as the check reads them (recommendation.OriginFilter without moods). */
export interface HardFilter {
  countries: string[];
  languages: string[];
  yearFrom: number | null;
  yearTo: number | null;
  vocals: string | null;
}

/** No hard filter: a request that only names styles ("Jazz tracks"). */
export const NO_HARD_FILTER: HardFilter = { countries: [], languages: [], yearFrom: null, yearTo: null, vocals: null };

/**
 * A request whose focus (the AI's 0 mood … 1 genre) is at least this names a
 * style, so the library must have enough of it; the prompt sets focus ≥ 0.5
 * whenever a request names a genre or style.
 */
export const STYLE_REQUEST_FOCUS = 0.5;

export function hasHardFilter(filter: HardFilter | null | undefined): filter is HardFilter {
  return !!filter && (filter.countries.length > 0 || filter.languages.length > 0
    || filter.yearFrom != null || filter.yearTo != null || !!filter.vocals);
}

const displayName = (code: string, type: 'region' | 'language') => {
  try {
    return new Intl.DisplayNames(['en'], { type }).of(code) || code;
  } catch {
    return code;
  }
};

const orList = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;

function years(from: number | null, to: number | null): string | null {
  if (from != null && to != null) {
    if (from === to) return `from ${from}`;
    if (from % 10 === 0 && to === from + 9) return `from the ${from}s`;
    return `from ${from}–${to}`;
  }
  if (from != null) return `from ${from} on`;
  if (to != null) return `up to ${to}`;
  return null;
}

/** "Hip Hop tracks from Denmark or sung in Danish from the 1990s". */
export function describeTheme(styleNames: string[], filter: HardFilter, count: number): string {
  const names = orList(styleNames.slice(0, 3));
  const noun = count === 1 ? 'track' : 'tracks';
  const origin = orList([
    ...(filter.countries.length ? [`from ${orList(filter.countries.map(c => displayName(c, 'region')))}`] : []),
    ...(filter.languages.length ? [`sung in ${orList(filter.languages.map(l => displayName(l, 'language')))}`] : []),
  ]);
  return [names ? `${names} ${noun}` : noun, origin, years(filter.yearFrom, filter.yearTo), filter.vocals ? `with ${filter.vocals} vocals` : null]
    .filter(Boolean).join(' ');
}

/** The answer for a request the library can't carry. */
export function thinRequest(styleNames: string[], filter: HardFilter, found: { songs: number; artists: number }, needed: number): ThinRequest {
  const theme = describeTheme(styleNames, filter, found.songs);
  const message = found.songs === 0
    ? `Your library has no ${theme}.`
    : `Your library has ${found.songs} ${theme}, too few for a ${needed}-track playlist.`;
  return { songs: found.songs, artists: found.artists, needed, theme, message };
}
