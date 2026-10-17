// Pure YouTube-title normalization helpers, split out from youtube.service.ts
// so they can be unit-tested without pulling in the database/HTTP layer.

// "Artist - Title" style separators (hyphen, en/em dash, colon, pipe).
export const SEPARATORS = /\s+[-–—:|]\s+/;

// Bracket/paren groups that are video-type noise rather than part of the title,
// e.g. "(Official Music Video)", "[HD]", "(Lyric Video)".
const NOISE_GROUP = /[\(\[]\s*[^\)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv|m\/v|clip|explicit|full)\b[^\)\]]*[\)\]]/gi;

// Normalize a YouTube upload title toward the bare song title so it can be
// matched against the library. We do NOT strip "feat." here — track titles in
// the library often carry it, and getSongDedupKey applies the same
// normalization to both sides.
export function cleanYouTubeVideoTitle(title: string): string {
  if (!title) return '';
  let t = title.replace(NOISE_GROUP, group => /\b(live|acoustic|remix|instrumental|karaoke|demo|edit)\b/i.test(group) ? group : ' ');
  // Trailing dash-qualifiers, e.g. "Song - Official Video".
  t = t.replace(/\s+[-–—]\s+(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|visuali[sz]er|hd|4k|mv)\s*$/i, '');
  return t.replace(/\s+/g, ' ').trim();
}

// Candidate title strings to match against the library: the cleaned title, plus
// the cleaned title with a leading "Artist - " prefix removed (channel uploads
// almost always carry that prefix).
export function videoTitleCandidates(title: string): string[] {
  const cleaned = cleanYouTubeVideoTitle(title);
  const candidates = [cleaned];
  if (SEPARATORS.test(cleaned)) {
    candidates.push(cleaned.split(SEPARATORS).slice(1).join(' - '));
  }
  return candidates;
}
