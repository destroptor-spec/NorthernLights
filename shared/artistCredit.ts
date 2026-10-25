// Canonical artist-credit splitting, shared verbatim by the client
// (`src/utils/artistUtils.ts`) and the server (`server/database/index.ts`) so
// the two can never drift. Pure string helpers — no DOM, DB, or Node deps — so
// the file resolves in the browser bundle, under tsx on the server, and in
// tests alike.
//
// NOTE: the scan worker's `splitNames` (server/workers/scanTrack.ts) is a
// deliberately different, more aggressive splitter (it splits on bare `&`, `/`,
// `;`, `vs`) used for credit-role tags, and is intentionally NOT shared here.

/** Trim a credit part and strip wrapping brackets/parens. */
export function cleanCreditPart(value: string): string {
  return value
    .trim()
    .replace(/^[([{]+/, '')
    .replace(/[)\]}]+$/, '')
    .trim();
}

/** Dedupe artist names case-insensitively, preserving first-seen order and
 * re-cleaning each part so stray brackets never split identical names apart. */
export function uniqueArtistNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawName of names) {
    const name = cleanCreditPart(rawName);
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(name);
  }

  return result;
}

// Splits a list-style credit like "Alok, Martin Jensen & Jason Derulo" into
// individual names. The comma is the trigger: presence of a comma means the
// string is a list, so we split on commas and on a final " & " (Oxford-and).
// Without a comma we keep the part intact so true group names like
// "Nick & Jay" / "Hall & Oates" / "Mr. & Mrs. Smith" are preserved. We avoid
// splitting on the word "and" — too many band names contain it.
export function explodeListCredit(part: string): string[] {
  if (!part.includes(',')) return [part];
  const commaParts = part
    .split(/\s*,\s*/)
    .map(cleanCreditPart)
    .filter(Boolean);
  if (commaParts.length === 0) return [];
  const last = commaParts[commaParts.length - 1];
  const ampSplit = last
    .split(/\s+&\s+/)
    .map(cleanCreditPart)
    .filter(Boolean);
  if (ampSplit.length > 1) {
    return [...commaParts.slice(0, -1), ...ampSplit];
  }
  return commaParts;
}

/**
 * Split an ID3/Vorbis artist string into individual artist names. Handles
 * `feat.`/`ft.`/`featuring` markers and comma-list patterns ("A, B & C").
 * With its dot, `feat.`/`ft.` needs no space after it ("Brooke Candy
 * feat.Sia"); the bare words do, so names that merely contain them stay whole.
 * Deliberately does NOT split on a bare "&" or "and" — names like "Nick & Jay"
 * or "Florence and the Machine" are a single artist.
 */
// A `feat.`/`ft.`/`featuring` marker with something after it.
const FEATURING = /\s*(?:[\(\[\{]\s*)?\b(?:(?:feat|ft)\.\s*|(?:feat|ft|featuring)\b\.?\s+)(?!$)/i;

/**
 * The main act and the featured artists of a credit with a featuring marker,
 * or null without one: "Ecstasy, Passion and Pain featuring Barbara Roy" →
 * ["Ecstasy, Passion and Pain", "Barbara Roy"]. The main act stays whole; the
 * featured part is split like any credit.
 */
export function splitAtFeaturing(artistStr: string | null | undefined): string[] | null {
  if (!artistStr) return null;
  const marker = FEATURING.exec(artistStr);
  if (!marker) return null;
  const main = cleanCreditPart(artistStr.slice(0, marker.index));
  if (!main) return null;
  return uniqueArtistNames([main, ...splitArtistNames(artistStr.slice(marker.index + marker[0].length))]);
}

export function splitArtistNames(artistStr: string | null | undefined): string[] {
  if (!artistStr) return [];
  const featuredParts = artistStr
    .split(FEATURING)
    .map(cleanCreditPart)
    .filter(Boolean);
  const exploded = featuredParts.flatMap(explodeListCredit);
  return uniqueArtistNames(exploded);
}

// "&", "+" or "and" between two names. Matched on its own, then one kind at a
// time, so "Above & Beyond and Spencer Brown" can also split as
// "Above & Beyond" | "Spencer Brown".
const JOINERS = [/\s+(?:&|\+|and)\s+/i, /\s+and\s+/i, /\s+&\s+/, /\s+\+\s+/];
// "Percy Faith and His Orchestra": the band of the name before it.
const BACKING_BAND = /^(?:his|her|their)\s/i;

/**
 * The ways a credit joined with "&", "+" or "and" can split into names, most
 * split first: "Justin Timberlake & Timbaland" → [["Justin Timberlake",
 * "Timbaland"]]. Empty for a credit with no joiner, a featuring credit, or
 * one naming a backing band ("Percy Faith and His Orchestra"). Which split
 * (if any) is
 * right needs to know the library's artists — see `splitJoinedCredit`.
 */
export function joinedCreditSplits(credit: string | null | undefined): string[][] {
  // A featuring credit is split at its marker first (splitAtFeaturing).
  if (!credit || FEATURING.test(credit)) return [];
  const splits: string[][] = [];
  const seen = new Set<string>();
  for (const joiner of JOINERS) {
    const names = uniqueArtistNames(credit.split(joiner));
    const key = names.join('\u0000').toLowerCase();
    if (names.length < 2 || seen.has(key) || names.some(name => BACKING_BAND.test(name))) continue;
    seen.add(key);
    splits.push(names);
  }
  return splits;
}

/**
 * A joined credit split into the artists it names, or null when it isn't
 * known to name several: every name must be one the library already has on
 * its own (`isKnown`). Keeps duos like "Simon & Garfunkel" or "Florence and
 * the Machine" whole, since their halves aren't artists of their own.
 */
export function splitJoinedCredit(
  credit: string | null | undefined,
  isKnown: (name: string) => boolean,
): string[] | null {
  return joinedCreditSplits(credit).find(names => names.every(isKnown)) || null;
}

/**
 * A credit listing people with commas, stored as one name ("Morten Hampenberg,
 * Alexander Brown" as a single ARTISTS entry), split into the artists it
 * lists, or null when it isn't known to name several: every name must be one
 * the library already has on its own (`isKnown`). Keeps names like "Tyler, the
 * Creator" or "Earth, Wind & Fire" whole, since their parts aren't artists.
 */
export function splitPeopleCredit(
  credit: string | null | undefined,
  isKnown: (name: string) => boolean,
): string[] | null {
  if (!credit || !credit.includes(',') || FEATURING.test(credit)) return null;
  const names = uniqueArtistNames(explodeListCredit(credit));
  return names.length > 1 && names.every(isKnown) ? names : null;
}
