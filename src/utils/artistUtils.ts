import { cleanCreditPart, splitArtistNames } from '../../shared/artistCredit';

/**
 * Canonical identity key for an artist name. Mirrors the server-side
 * `normalizeArtistIdentityKey` so client-side comparisons match the
 * canonicalization used during merges (e.g. "N'to" and "NTO" -> "nto").
 */
export function normalizeArtistIdentityKey(name: string | null | undefined): string {
  return (name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`´]/g, "'")
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * Split an ID3/Vorbis artist string into individual artist names.
 * Handles `feat.`/`ft.`/`featuring` markers and comma-list patterns
 * ("A, B & C"). Does NOT split on a bare "&" or "and" — preserves group
 * names like "Nick & Jay" and "Florence and the Machine". Canonical
 * implementation lives in `shared/artistCredit` (shared with the server).
 */
export const parseArtists = splitArtistNames;

// Collaboration separators: " & " or " + ". Bare "and" / "with" / "vs"
// are intentionally omitted — too many false positives in real names.
const COLLAB_SEPARATOR = /\s+[&+]\s+/;

/**
 * Like `parseArtists`, but also splits a residual ` & ` or ` + ` join when
 * every half resolves to a known artist row. Lets credits like
 * "Tony Bennett & Lady Gaga" or "The Chainsmokers + Kygo" render as two
 * individually-clickable chips after their compound row has been merged into
 * one of the individuals, while leaving genuine groups like "Nik & Jay" or
 * "Hall & Oates" whole (their joined form is the known artist).
 */
export function parseArtistsForDisplay(
  artistStr: string | undefined,
  knownArtistKeys: Set<string>
): string[] {
  const parts = parseArtists(artistStr);
  if (knownArtistKeys.size === 0) return parts;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    let split = [part];
    if (COLLAB_SEPARATOR.test(part)) {
      const halves = part.split(COLLAB_SEPARATOR).map(cleanCreditPart).filter(Boolean);
      if (halves.length > 1 && halves.every(h => knownArtistKeys.has(normalizeArtistIdentityKey(h)))) {
        split = halves;
      }
    }
    for (const name of split) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(name);
    }
  }
  return result;
}

/**
 * Check whether a given artist name appears in a track's artist field.
 * Matches via canonical identity key so apostrophe/diacritic variants
 * (e.g. "N'to" vs "NTO", "Tiësto" vs "Tiesto") resolve to the same artist.
 */
export function trackMatchesArtist(trackArtist: string | undefined, artistName: string): boolean {
  if (!trackArtist) return false;
  const target = normalizeArtistIdentityKey(artistName);
  if (!target) return false;
  if (normalizeArtistIdentityKey(trackArtist) === target) return true;
  return parseArtists(trackArtist).some(a => normalizeArtistIdentityKey(a) === target);
}
