/**
 * How many AI playlists the Hub makes, and how many of them may be special
 * lists (themes the library can carry; docs/Aurora genre and style
 * redesign.md, AI playlists → Special lists). Decided 2026-11-11: 2, 3, 6 or
 * 9, of which up to 1, 1, 2 or 3 are special lists, in the same rail.
 */
export const HUB_PLAYLIST_COUNTS = [2, 3, 6, 9] as const;
export type HubPlaylistCount = typeof HUB_PLAYLIST_COUNTS[number];

const SPECIAL_LISTS: Record<HubPlaylistCount, number> = { 2: 1, 3: 1, 6: 2, 9: 3 };

/** A saved count as one of the allowed ones: the nearest, the lower on a tie (an old 5 becomes 6). */
export function normalizeHubPlaylistCount(value: unknown): HubPlaylistCount {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  if (n === 5) return 6;
  return HUB_PLAYLIST_COUNTS.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), HUB_PLAYLIST_COUNTS[0]);
}

/** At most this many of the Hub's AI playlists are special lists. */
export function specialListCount(count: unknown): number {
  return SPECIAL_LISTS[normalizeHubPlaylistCount(count)];
}
