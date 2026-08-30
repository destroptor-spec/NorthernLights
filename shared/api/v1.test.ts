import {
  appKeyCreateSchema,
  pairingExchangeSchema,
  playbackDescriptorSchema,
  playbackSessionDeleteSchema,
  playbackSessionPatchSchema,
  trackSchema,
} from './v1';

const track = {
  id: 'track-1', title: 'Night Drive', artist: 'Aurora', albumArtist: null, artists: ['Aurora'],
  album: 'North', genre: 'Electronic', genres: ['Electronic'], durationSeconds: 180,
  trackNumber: 1, discNumber: 1, year: 2026, releaseType: 'Album', compilation: false,
  bitrate: 1000, format: 'FLAC', lossless: true, fileSize: 42, mediaEtag: 'etag',
  artistId: 'artist-1', albumId: 'album-1', genreId: 'genre-1', loved: false, rating: 0,
  playCount: 0, lastPlayedAt: null, artworkId: null, artworkUrl: null,
  musicBrainz: { recordingId: null, trackId: null, albumId: null, artistId: null, releaseGroupId: null, workId: null },
};

describe('Aurora API v1 contracts', () => {
  it('strips internal file paths from track resources', () => {
    const parsed = trackSchema.parse({ ...track, path: '/music/private/album.flac', pathB64: 'secret' });
    expect(parsed).not.toHaveProperty('path');
    expect(parsed).not.toHaveProperty('pathB64');
  });

  it('rejects unknown fields in authentication requests', () => {
    expect(appKeyCreateSchema.safeParse({ name: 'Desktop', scope: 'admin' }).success).toBe(false);
    expect(pairingExchangeSchema.safeParse({ requestId: 'bad', requestSecret: 'x', verifier: 'y' }).success).toBe(false);
  });

  it('requires optimistic revisions for playback-session changes', () => {
    expect(playbackSessionPatchSchema.safeParse({
      expectedRevision: 2,
      operations: [{ type: 'setTransport', playbackState: 'playing', positionMs: 1200 }],
    }).success).toBe(true);
    expect(playbackSessionPatchSchema.safeParse({
      operations: [{ type: 'setTransport', playbackState: 'playing' }],
    }).success).toBe(false);
    expect(playbackSessionDeleteSchema.safeParse({ expectedRevision: 2 }).success).toBe(true);
    expect(playbackSessionDeleteSchema.safeParse({}).success).toBe(false);
  });

  it('labels measured loudness values as LUFS and true peak, never replay gain', () => {
    const descriptor = {
      track,
      sources: [{ kind: 'direct', url: '/media', mimeType: 'audio/flac', quality: 'source', expiresAt: '2026-08-30T10:00:00.000Z' }],
      loudness: { trackLufs: -14, albumLufs: -13.5, truePeakDbfs: -0.5 },
      byteLength: 42,
      etag: 'etag',
      acceptRanges: true,
    };
    expect(playbackDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(playbackDescriptorSchema.safeParse({
      ...descriptor,
      loudness: { trackGainDb: -14, albumGainDb: -13.5, peak: -0.5 },
    }).success).toBe(false);
  });
});
