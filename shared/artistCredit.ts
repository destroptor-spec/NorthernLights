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
 * Deliberately does NOT split on a bare "&" or "and" — names like "Nick & Jay"
 * or "Florence and the Machine" are a single artist.
 */
export function splitArtistNames(artistStr: string | null | undefined): string[] {
  if (!artistStr) return [];
  const featuredParts = artistStr
    .split(/\s*(?:[\(\[\{]\s*)?\b(?:feat\.?|ft\.?|featuring)\b\.?\s+(?!$)/i)
    .map(cleanCreditPart)
    .filter(Boolean);
  const exploded = featuredParts.flatMap(explodeListCredit);
  return uniqueArtistNames(exploded);
}
