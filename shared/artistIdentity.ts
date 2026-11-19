/**
 * The canonical identity key for an artist name: two names are the same
 * artist when their keys are equal ("N'to" and "NTO" -> "nto", "Simon & Garfunkel"
 * and "Simon and Garfunkel" -> "simonandgarfunkel"). Lowercased, accents
 * stripped, apostrophe variants alike, `&` as "and", then letters and digits
 * only. A name with no Latin letters or digits has an empty key: compare those
 * by lowercased name instead (the server's sameArtistIdentity does).
 *
 * One definition for the server (artists.normalized_key, getOrCreateArtist,
 * search) and the client (artist links, known-artist splitting).
 */
export function normalizeArtistIdentityKey(name: string | null | undefined): string {
  return (name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}
