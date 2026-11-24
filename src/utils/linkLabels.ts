// Labels for links from files and providers, and which page a link belongs
// on: the artist page leaves out links to a release, the album page leaves
// out links to an artist. A link that could be either (Wikidata) shows on both.

/**
 * Returns false for URLs that clearly point to a specific release/album/track
 * rather than an artist page (e.g. discogs.com/master/…, allmusic.com/album/…).
 */
export function isArtistLevelUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.replace(/^www\./, '');
    const path = pathname.toLowerCase();

    if (host === 'discogs.com') return path.startsWith('/artist/');
    if (host === 'allmusic.com') return !path.startsWith('/album/') && !path.startsWith('/song/') && !path.startsWith('/composition/');
    if (host === 'open.spotify.com' || host === 'spotify.com') return path.startsWith('/artist/');
    if (host === 'last.fm' || host.endsWith('.last.fm')) {
      // /music/Artist → ok; /music/Artist/Album → release
      const segs = path.split('/').filter(Boolean);
      return !(segs[0] === 'music' && segs.length >= 3);
    }
    if (host === 'musicbrainz.org') return path.startsWith('/artist/');

    return true;
  } catch {
    return true;
  }
}

export function getLinkLabel(url: string, type: string): string {
  const u = url.toLowerCase();
  if (u.includes('spotify.com')) return 'Spotify';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  if (u.includes('instagram.com')) return 'Instagram';
  if (u.includes('facebook.com') || u.includes('fb.com')) return 'Facebook';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'X / Twitter';
  if (u.includes('tiktok.com')) return 'TikTok';
  if (u.includes('bandcamp.com')) return 'Bandcamp';
  if (u.includes('soundcloud.com')) return 'SoundCloud';
  if (u.includes('discogs.com')) return 'Discogs';
  if (u.includes('allmusic.com')) return 'AllMusic';
  if (u.includes('wikipedia.org')) return 'Wikipedia';
  if (u.includes('wikidata.org')) return 'Wikidata';
  if (u.includes('last.fm') || u.includes('lastfm.')) return 'Last.fm';
  if (u.includes('apple.com') || u.includes('music.apple')) return 'Apple Music';
  if (u.includes('tidal.com')) return 'Tidal';
  if (u.includes('deezer.com')) return 'Deezer';
  if (u.includes('genius.com')) return 'Genius';
  if (u.includes('rateyourmusic.com')) return 'RateYourMusic';
  if (u.includes('musicbrainz.org')) return 'MusicBrainz';

  if (type === 'official homepage') return 'Official Site';
  if (type === 'social network') return 'Social';
  if (type === 'streaming') return 'Streaming';
  if (type === 'official audio source') return 'Audio Source';
  if (type === 'discogs') return 'Discogs';
  if (type === 'youtube') return 'YouTube';
  if (type === 'spotify') return 'Spotify';
  if (type === 'soundcloud') return 'SoundCloud';
  if (type === 'bandcamp') return 'Bandcamp';
  if (type === 'wikipedia') return 'Wikipedia';
  return type || 'Link';
}

/** True for links that clearly point to an artist, not a release (left off the album page). */
export function isArtistPageUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.replace(/^www\./, '').toLowerCase();
    const path = pathname.toLowerCase();
    const segs = path.split('/').filter(Boolean);
    const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);

    if (is('discogs.com') || is('allmusic.com') || is('musicbrainz.org') || is('spotify.com')) return segs[0] === 'artist';
    if (is('last.fm')) return segs[0] === 'music' && segs.length === 2;
    // An artist's or label's own Bandcamp site; its releases are under /album/ and /track/.
    if (is('bandcamp.com')) return segs.length === 0;
    if (is('facebook.com') || is('instagram.com') || is('twitter.com') || is('x.com') || is('tiktok.com') || is('myspace.com')) return true;
    return false;
  } catch {
    return false;
  }
}
