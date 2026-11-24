import { DEFAULT_METADATA_PROVIDER_PRIORITY, isGeniusPlaceholderImage, normaliseMetadataProviderPriority } from './metadataProviders';

describe('normaliseMetadataProviderPriority', () => {
  it('gives the defaults when nothing is stored', () => {
    expect(normaliseMetadataProviderPriority(null)).toEqual(DEFAULT_METADATA_PROVIDER_PRIORITY);
  });

  it('keeps a stored order, drops unknown and unsupported providers and repeats', () => {
    expect(normaliseMetadataProviderPriority({
      artistImage: ['genius', 'musicbrainz', 'lastfm', 'genius', 'spotify'],
      artistBanner: [],
      artistBio: ['genius'],
      albumArt: ['lastfm', 'musicbrainz'],
    })).toEqual({
      artistImage: ['genius', 'lastfm'],
      artistBanner: [],
      artistBio: ['genius'],
      albumArt: ['lastfm', 'musicbrainz'],
    });
  });

  it('follows the old single choices for items not stored yet', () => {
    expect(normaliseMetadataProviderPriority(undefined, {
      providerArtistImage: 'genius',
      providerArtistArtwork: 'none',
      providerArtistBio: 'lastfm',
      providerAlbumArt: 'genius',
    })).toEqual({
      artistImage: ['genius', 'lastfm'],
      artistBanner: [],
      artistBio: ['lastfm', 'genius'],
      // The Cover Art Archive was always asked first for a release the files name.
      albumArt: ['musicbrainz', 'genius', 'lastfm'],
    });
  });

  it('ignores an old choice the item never supported', () => {
    expect(normaliseMetadataProviderPriority(undefined, { providerArtistImage: 'musicbrainz' }).artistImage)
      .toEqual(DEFAULT_METADATA_PROVIDER_PRIORITY.artistImage);
  });

  it('does not share the default lists with the result', () => {
    normaliseMetadataProviderPriority(null).artistImage.push('musicbrainz');
    expect(DEFAULT_METADATA_PROVIDER_PRIORITY.artistImage).toEqual(['lastfm', 'genius']);
  });
});

describe('isGeniusPlaceholderImage', () => {
  it('knows Genius’s stock pictures and nothing else', () => {
    expect(isGeniusPlaceholderImage('https://assets.genius.com/images/default_cover_image.png?1700000000')).toBe(true);
    expect(isGeniusPlaceholderImage('https://assets.genius.com/images/default_avatar_300.png')).toBe(true);
    expect(isGeniusPlaceholderImage('https://images.genius.com/0f3a1b.1000x1000x1.jpg')).toBe(false);
    expect(isGeniusPlaceholderImage(null)).toBe(false);
  });
});
