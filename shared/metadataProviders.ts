// Which metadata providers Aurora asks for each kind of artwork and text, in
// the admin's order (Settings → Metadata → Overview). The server asks them in
// that order and keeps the first one that has it; a provider left off a list is
// never asked for that item. Shared so the settings screen and the server read
// a stored value the same way.

export type MetadataProvider = 'lastfm' | 'genius' | 'musicbrainz' | 'theaudiodb' | 'fanarttv';

export type MetadataItem = 'artistImage' | 'artistBanner' | 'artistBio' | 'albumArt';

export type MetadataProviderPriority = Record<MetadataItem, MetadataProvider[]>;

export interface MetadataItemInfo {
  id: MetadataItem;
  label: string;
  description: string;
  /** The providers Aurora can get this item from. */
  providers: readonly MetadataProvider[];
}

export const METADATA_ITEMS: readonly MetadataItemInfo[] = [
  { id: 'artistImage', label: 'Artist images', description: 'The artist’s picture in grids and on their page.', providers: ['lastfm', 'genius', 'theaudiodb', 'fanarttv'] },
  { id: 'artistBanner', label: 'Artist banners', description: 'The wide picture across the top of an artist’s page.', providers: ['genius', 'theaudiodb', 'fanarttv'] },
  { id: 'artistBio', label: 'Artist bios', description: 'The text about the artist on their page.', providers: ['lastfm', 'genius', 'theaudiodb'] },
  { id: 'albumArt', label: 'Album art', description: 'Covers for albums without art in their files. MusicBrainz looks them up in the Cover Art Archive.', providers: ['musicbrainz', 'lastfm', 'genius', 'theaudiodb', 'fanarttv'] },
];

export const METADATA_PROVIDER_NAMES: Record<MetadataProvider, string> = {
  lastfm: 'Last.fm',
  genius: 'Genius',
  musicbrainz: 'MusicBrainz',
  theaudiodb: 'TheAudioDB',
  fanarttv: 'fanart.tv',
};

export const DEFAULT_METADATA_PROVIDER_PRIORITY: MetadataProviderPriority = {
  artistImage: ['lastfm', 'genius'],
  artistBanner: ['genius'],
  artistBio: ['lastfm', 'genius'],
  albumArt: ['musicbrainz', 'lastfm', 'genius'],
};

/** The single-choice settings this replaced: providerArtistImage, providerArtistArtwork, providerArtistBio, providerAlbumArt. */
export interface LegacyMetadataProviderChoices {
  providerArtistImage?: unknown;
  providerArtistArtwork?: unknown;
  providerArtistBio?: unknown;
  providerAlbumArt?: unknown;
}

const supportedFor = (item: MetadataItem) => METADATA_ITEMS.find((i) => i.id === item)!.providers;

function cleanList(item: MetadataItem, value: unknown): MetadataProvider[] | null {
  if (!Array.isArray(value)) return null;
  const supported = supportedFor(item);
  const list: MetadataProvider[] = [];
  for (const provider of value) {
    if (supported.includes(provider) && !list.includes(provider)) list.push(provider);
  }
  return list;
}

/** A single choice put first, the item's other providers after it in their default order: what the old setting did. */
function fromLegacyChoice(item: MetadataItem, choice: unknown): MetadataProvider[] | null {
  if (typeof choice !== 'string' || !choice) return null;
  const defaults = DEFAULT_METADATA_PROVIDER_PRIORITY[item];
  if (item === 'artistBanner') return choice === 'none' ? [] : null;
  if (!supportedFor(item).includes(choice as MetadataProvider)) return null;
  if (item === 'albumArt') {
    // The Cover Art Archive was always asked first for albums whose files name
    // their release, whatever the choice.
    const list: MetadataProvider[] = ['musicbrainz', choice as MetadataProvider, ...defaults];
    return list.filter((p, i, all) => all.indexOf(p) === i);
  }
  return [choice as MetadataProvider, ...defaults].filter((p, i, all) => all.indexOf(p) === i);
}

/**
 * The stored priority as a complete, valid value. Items it lacks come from the
 * old single-choice settings, else the defaults; unknown or unsupported
 * providers are dropped. An empty list is kept: that item is not looked up.
 */
export function normaliseMetadataProviderPriority(
  stored: unknown,
  legacy: LegacyMetadataProviderChoices = {},
): MetadataProviderPriority {
  const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  const legacyChoice: Record<MetadataItem, unknown> = {
    artistImage: legacy.providerArtistImage,
    artistBanner: legacy.providerArtistArtwork,
    artistBio: legacy.providerArtistBio,
    albumArt: legacy.providerAlbumArt,
  };
  const result = {} as MetadataProviderPriority;
  for (const { id } of METADATA_ITEMS) {
    result[id] = cleanList(id, raw[id])
      ?? fromLegacyChoice(id, legacyChoice[id])
      ?? [...DEFAULT_METADATA_PROVIDER_PRIORITY[id]];
  }
  return result;
}

/**
 * Genius answers an artist or song without art with a stock picture
 * (assets.genius.com/images/default_avatar…, default_cover_image.png), never
 * a real one: treat it as no picture. The same POSIX/JS regex is used in SQL
 * (stored rows from before this check, and the image backfill).
 */
export const GENIUS_PLACEHOLDER_IMAGE_PATTERN = 'genius\\.com/images/default_';
const geniusPlaceholder = new RegExp(GENIUS_PLACEHOLDER_IMAGE_PATTERN, 'i');

export function isGeniusPlaceholderImage(url: string | null | undefined): boolean {
  return typeof url === 'string' && geniusPlaceholder.test(url);
}
