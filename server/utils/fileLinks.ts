// Links in a file's tags (the album's and artist's pages elsewhere): the
// scanner reads them into tracks.raw_urls, and the background re-read
// (trackOrigin.service) fills them in for files scanned before a tag was known.

/** A tag value that is just a web link. */
function isLink(value: unknown): value is string {
  return typeof value === 'string' && /^\s*https?:\/\/\S+\s*$/i.test(value);
}

/** The kind of link from its site, for tags that don't say. */
export function linkType(url: string): string {
  let host = '';
  try { host = new URL(url.trim()).hostname.replace(/^www\./, '').toLowerCase(); } catch { return 'other'; }
  const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (is('discogs.com')) return 'discogs';
  if (is('allmusic.com')) return 'allmusic';
  if (is('wikidata.org')) return 'wikidata';
  if (is('wikipedia.org')) return 'wikipedia';
  if (is('last.fm')) return 'last.fm';
  if (is('bandcamp.com')) return 'bandcamp';
  if (is('soundcloud.com')) return 'soundcloud';
  if (is('youtube.com') || is('youtu.be')) return 'youtube';
  if (is('spotify.com')) return 'spotify';
  if (is('musicbrainz.org')) return 'musicbrainz';
  if (is('facebook.com') || is('instagram.com') || is('twitter.com') || is('x.com') || is('tiktok.com') || is('myspace.com')) return 'social network';
  return 'other';
}

function sanitizeUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  // Strip null bytes, BOM, and ASCII control characters (except tab)
  const cleaned = raw
    .replace(/\x00/g, '')           // null bytes (crash Postgres)
    .replace(/\uFEFF/g, '')         // BOM
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // control chars
    .trim();
  if (!cleaned) return null;
  // Must be http(s) and a plausible length
  if (!/^https?:\/\/.{3,}/i.test(cleaned)) return null;
  if (cleaned.length > 2048) return null;
  // Validate parseable by URL constructor
  try { new URL(cleaned); } catch { return null; }
  return cleaned;
}

export function extractUrlTags(native: Record<string, any[]>): { url: string; type: string }[] {
  const results: { url: string; type: string }[] = [];
  const seen = new Set<string>();

  const add = (raw: string, type: string) => {
    const url = sanitizeUrl(raw);
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ url, type });
  };

  for (const [format, tags] of Object.entries(native || {})) {
    if (!Array.isArray(tags)) continue;

    if (format === 'vorbis') {
      for (const tag of tags) {
        const id = (tag.id || '').toUpperCase();
        const val = typeof tag.value === 'string' ? tag.value : '';
        switch (id) {
          case 'URL_OFFICIAL_ARTIST_SITE':
          case 'WEBSITE': add(val, 'official homepage'); break;
          case 'URL_OFFICIAL_RELEASE_SITE': add(val, 'official audio source'); break;
          case 'URL_DISCOGS_ARTIST_PAGE':
          case 'URL_DISCOGS_RELEASE_PAGE': add(val, 'discogs'); break;
          case 'URL_SOUNDCLOUD': add(val, 'soundcloud'); break;
          case 'URL_YOUTUBE': add(val, 'youtube'); break;
          case 'URL_WIKIPEDIA_ARTIST':
          case 'URL_WIKIPEDIA_RELEASE': add(val, 'wikipedia'); break;
          case 'URL_SPOTIFY_ARTIST':
          case 'URL_SPOTIFY_ALBUM': add(val, 'spotify'); break;
          case 'URL_BANDCAMP': add(val, 'bandcamp'); break;
          // Any other tag that holds just a link: Picard's per-site tags
          // (DISCOGS.COM, ALLMUSIC.COM, WIKIDATA.ORG, LAST.FM, BANDCAMP.COM,
          // SOCIAL MEDIA, LOCATION …). About a fifth of dev files carry them.
          default: if (isLink(val)) add(val, linkType(val));
        }
      }
    } else if (!format.startsWith('ID3v2')) {
      // MP4 freeform (----:com.apple.iTunes:DISCOGS.COM), APE and the rest:
      // only tags that hold just a link.
      for (const tag of tags) {
        const val = typeof tag.value === 'string' ? tag.value : '';
        if (isLink(val)) add(val, linkType(val));
      }
    }
    if (format.startsWith('ID3v2')) {
      for (const tag of tags) {
        const id = tag.id || '';
        const val = tag.value;
        switch (id) {
          case 'WOAR': if (typeof val === 'string') add(val, 'official homepage'); break;
          case 'WOAS': if (typeof val === 'string') add(val, 'official audio source'); break;
          case 'WORS': if (typeof val === 'string') add(val, 'streaming'); break;
          case 'WPUB': if (typeof val === 'string') add(val, 'official homepage'); break;
          case 'WCOM': if (typeof val === 'string') add(val, 'commercial'); break;
          case 'WXXX': {
            if (typeof val === 'object' && val?.url) {
              const desc = (val.description || '').toLowerCase();
              let type = 'other';
              if (desc.includes('spotify')) type = 'spotify';
              else if (desc.includes('youtube')) type = 'youtube';
              else if (desc.includes('instagram') || desc.includes('facebook') || desc.includes('twitter') || desc.includes('x.com')) type = 'social network';
              else if (desc.includes('discogs')) type = 'discogs';
              else if (desc.includes('bandcamp')) type = 'bandcamp';
              else if (desc.includes('soundcloud')) type = 'soundcloud';
              else if (desc.includes('wikipedia')) type = 'wikipedia';
              add(val.url, type);
            }
            break;
          }
          // A user text frame that holds just a link (TXXX:DISCOGS.COM …).
          case 'TXXX': {
            const text = typeof val === 'object' && val ? (Array.isArray(val.text) ? val.text[0] : val.text) : undefined;
            if (isLink(text)) add(text, linkType(text));
            break;
          }
        }
      }
    }
  }

  return results;
}
