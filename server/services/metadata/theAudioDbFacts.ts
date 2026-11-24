import { countryCode } from '../../../shared/places';
import type { TadbArtist } from './providers/theaudiodb';

// What Aurora takes from a TheAudioDB artist besides pictures and the bio:
// facts that fill what MusicBrainz didn't give, links, and genre/style/mood for
// show on the artist page (display only: they don't feed genre fusion).

export interface DisplayTag {
  name: string;
  count: number;
  providers: Array<'lastfm' | 'musicbrainz' | 'theaudiodb'>;
}

export interface TheAudioDbFacts {
  area?: string;
  country?: string;
  lifeSpan?: { begin?: string; end?: string };
  links: { url: string; type: string }[];
  tags: DisplayTag[];
}

const text = (value: string | null | undefined) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const year = (value: string | null | undefined) => {
  const match = typeof value === 'string' ? value.match(/\b(1[89]\d\d|20\d\d)\b/) : null;
  return match ? match[1] : undefined;
};

const keyOf = (name: string) => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The same name, ignoring case, width and spacing. */
export function sameName(a: string | null | undefined, b: string): boolean {
  return typeof a === 'string' && keyOf(a) === keyOf(b);
}

/** The hit is this artist: its name or alternate name is the same, ignoring case. */
export function sameArtistName(artist: TadbArtist, name: string): boolean {
  const wanted = keyOf(name);
  return [artist.strArtist, ...(artist.strArtistAlternate || '').split(',')]
    .some((candidate) => typeof candidate === 'string' && candidate.trim() && keyOf(candidate) === wanted);
}

/** A link TheAudioDB gives as "www.example.com" or a full URL; junk (e.g. "1") is dropped. */
function linkUrl(value: string | null | undefined): string | undefined {
  const raw = text(value);
  if (!raw || /\s/.test(raw) || !raw.includes('.')) return undefined;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('.') ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function theAudioDbFacts(artist: TadbArtist): TheAudioDbFacts {
  const begin = year(artist.intFormedYear) ?? year(artist.intBornYear);
  const end = year(artist.intDiedYear) ?? year(artist.strDisbanded);
  const links = [
    { url: linkUrl(artist.strWebsite), type: 'official homepage' },
    { url: linkUrl(artist.strFacebook), type: 'social network' },
    { url: linkUrl(artist.strTwitter), type: 'social network' },
  ].filter((link): link is { url: string; type: string } => !!link.url);
  const tags: DisplayTag[] = [];
  for (const name of [artist.strGenre, artist.strStyle, artist.strMood].map(text)) {
    if (name && !tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      tags.push({ name, count: 100, providers: ['theaudiodb'] });
    }
  }
  return {
    area: text(artist.strCountry),
    country: countryCode(text(artist.strCountryCode)) ?? undefined,
    lifeSpan: begin || end ? { begin, end } : undefined,
    links,
    tags,
  };
}

const linkKey = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

/** MusicBrainz's links first, then any of TheAudioDB's it lacks. */
export function mergeLinks(
  links: { url: string; type: string }[] | undefined,
  extra: { url: string; type: string }[],
): { url: string; type: string }[] {
  const merged = [...(links || [])];
  const seen = new Set(merged.map((l) => linkKey(l.url)));
  for (const link of extra) {
    const key = linkKey(link.url);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(link);
    }
  }
  return merged;
}

/** Last.fm and MusicBrainz tags, with TheAudioDB's genre, style and mood marked on or added after them. */
export function withDisplayTags(tags: DisplayTag[] | undefined, extra: DisplayTag[]): DisplayTag[] | undefined {
  if (extra.length === 0) return tags;
  const merged = (tags || []).map((t) => ({ ...t, providers: [...t.providers] }));
  for (const tag of extra) {
    const same = merged.find((t) => t.name.toLowerCase() === tag.name.toLowerCase());
    if (same) {
      if (!same.providers.includes('theaudiodb')) same.providers.push('theaudiodb');
    } else {
      merged.push(tag);
    }
  }
  return merged.length > 0 ? merged : undefined;
}
