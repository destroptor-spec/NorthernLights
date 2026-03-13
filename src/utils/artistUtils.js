/**
 * Split an ID3/Vorbis artist string into individual artist names.
 * Handles common multi-artist delimiters: / \ ; feat. &
 */
export function parseArtists(artistStr) {
    if (!artistStr)
        return [];
    return artistStr
        .split(/\s*[\/\\;]\s*|\s+feat\.?\s+|\s+&\s+/i)
        .map(a => a.trim())
        .filter(Boolean);
}
/**
 * Check whether a given artist name appears in a track's artist field.
 * Uses case-insensitive matching after splitting multi-artist strings.
 */
export function trackMatchesArtist(trackArtist, artistName) {
    if (!trackArtist)
        return false;
    const normalised = artistName.toLowerCase();
    // Check exact match first (fast path)
    if (trackArtist.toLowerCase() === normalised)
        return true;
    // Check if the artist appears within a multi-artist string
    return parseArtists(trackArtist).some(a => a.toLowerCase() === normalised);
}
