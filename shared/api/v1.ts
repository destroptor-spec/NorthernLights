import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// Attach OpenAPI metadata support before creating the shared schemas. The
// browser imports their inferred types only; the server also uses the runtime
// schemas for validation and specification generation.
extendZodWithOpenApi(z);

export const ISO_DATE_TIME = z.string().datetime({ offset: true });
export const OPAQUE_ID = z.string().min(1).max(512);

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
    requestId: z.string().min(1),
  }),
}).meta({ id: 'ApiError' });

export const apiMetaSchema = z.object({
  requestId: z.string(),
}).meta({ id: 'ApiMeta' });

export const pageSchema = z.object({
  nextCursor: z.string().nullable(),
}).meta({ id: 'CursorPage' });

export const userSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  role: z.enum(['admin', 'user']),
}).meta({ id: 'AuroraUser' });

export const clientSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  name: z.string(),
  kind: z.enum(['desktop', 'web']),
  platform: z.string().nullable(),
  scope: z.literal('listener'),
  prefix: z.string(),
  createdAt: ISO_DATE_TIME,
  lastUsedAt: ISO_DATE_TIME.nullable(),
  revokedAt: ISO_DATE_TIME.nullable(),
}).meta({ id: 'AuroraClient' });

export const appKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  platform: z.string().trim().max(80).optional(),
}).strict().meta({ id: 'AppKeyCreate' });

export const pairingRequestSchema = z.object({
  clientName: z.string().trim().min(1).max(120),
  platform: z.string().trim().max(80).optional(),
  verifierChallenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
}).strict().meta({ id: 'PairingRequest' });

export const pairingExchangeSchema = z.object({
  requestId: z.string().uuid(),
  requestSecret: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
}).strict().meta({ id: 'PairingExchange' });

export const trackSchema = z.object({
  id: OPAQUE_ID,
  title: z.string(),
  artist: z.string(),
  albumArtist: z.string().nullable(),
  artists: z.array(z.string()),
  album: z.string(),
  genre: z.string().nullable(),
  genres: z.array(z.string()),
  durationSeconds: z.number().nonnegative().nullable(),
  trackNumber: z.number().int().positive().nullable(),
  discNumber: z.number().int().positive().nullable(),
  year: z.number().int().nullable(),
  releaseType: z.string().nullable(),
  compilation: z.boolean(),
  bitrate: z.number().int().nonnegative().nullable(),
  format: z.string().nullable(),
  lossless: z.boolean(),
  fileSize: z.number().int().nonnegative().nullable(),
  mediaEtag: z.string().nullable(),
  artistId: OPAQUE_ID.nullable(),
  albumId: OPAQUE_ID.nullable(),
  genreId: OPAQUE_ID.nullable(),
  loved: z.boolean(),
  rating: z.number().int().min(0).max(5),
  playCount: z.number().int().nonnegative(),
  lastPlayedAt: ISO_DATE_TIME.nullable(),
  artworkId: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  musicBrainz: z.object({
    recordingId: z.string().nullable(),
    trackId: z.string().nullable(),
    albumId: z.string().nullable(),
    artistId: z.string().nullable(),
    releaseGroupId: z.string().nullable(),
    workId: z.string().nullable(),
  }),
}).meta({ id: 'Track' });

export const artistSummarySchema = z.object({
  id: OPAQUE_ID,
  name: z.string(),
  imageUrl: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  genres: z.array(z.string()),
  artistType: z.string().nullable(),
  area: z.string().nullable(),
  lifeSpanBegin: z.string().nullable(),
}).meta({ id: 'ArtistSummary' });

export const albumSummarySchema = z.object({
  id: OPAQUE_ID,
  title: z.string(),
  artistName: z.string(),
  year: z.number().int().nullable(),
  genres: z.array(z.string()),
  releaseType: z.string(),
  trackCount: z.number().int().nonnegative(),
  artworkId: z.string().nullable(),
  imageUrl: z.string().nullable(),
  compilation: z.boolean(),
}).meta({ id: 'AlbumSummary' });

export const genreSchema = z.object({
  id: OPAQUE_ID,
  name: z.string(),
  trackCount: z.number().int().nonnegative(),
  aliasCount: z.number().int().nonnegative(),
  imageUrl: z.string().nullable(),
}).meta({ id: 'Genre' });

export const playlistTrackSchema = z.object({
  track: trackSchema,
  addedAt: ISO_DATE_TIME.nullable(),
}).meta({ id: 'PlaylistTrack' });

// What produced a playlist. `isSystem`/`isGenerated` only say *that* something
// was generated; clients need the family to group playlists into their own
// rails and pick the right cover art (Wrapped recaps, artist radios, …).
export const playlistGenerationSourceSchema = z.enum([
  'manual',          // hand-built by the listener
  'hub',             // LLM hub mix
  'custom',          // LLM mix from a listener prompt
  'system',          // engine mix (genre/decade rails)
  'on-repeat',
  'repeat-rewind',
  'daylist',
  'artist-radio',
  'seasonal-rewind',
  'year-rewind',
  'wrapped',         // frozen year/season recap
]).meta({ id: 'PlaylistGenerationSource' });

export const playlistSchema = z.object({
  id: OPAQUE_ID,
  title: z.string(),
  description: z.string().nullable(),
  ownerUsername: z.string().nullable(),
  isOwner: z.boolean(),
  isSystem: z.boolean(),
  isGenerated: z.boolean(),
  generationSource: playlistGenerationSourceSchema,
  pinned: z.boolean(),
  private: z.boolean(),
  readOnly: z.boolean(),
  createdAt: ISO_DATE_TIME.nullable(),
  tracks: z.array(playlistTrackSchema),
}).meta({ id: 'Playlist' });

export const playbackDescriptorRequestSchema = z.object({
  quality: z.enum(['auto', '64k', '128k', '160k', '320k', 'source']).default('auto'),
  capabilities: z.object({
    hls: z.boolean().default(true),
    directPlay: z.boolean().default(true),
    codecs: z.array(z.string()).max(32).default([]),
  }).default({ hls: true, directPlay: true, codecs: [] }),
}).strict().meta({ id: 'PlaybackDescriptorRequest' });

export const playbackSourceSchema = z.object({
  kind: z.enum(['hls', 'direct']),
  url: z.string(),
  mimeType: z.string(),
  quality: z.string(),
  expiresAt: ISO_DATE_TIME,
}).meta({ id: 'PlaybackSource' });

export const playbackDescriptorSchema = z.object({
  track: trackSchema,
  sources: z.array(playbackSourceSchema).min(1),
  loudness: z.object({
    trackLufs: z.number().nullable(),
    albumLufs: z.number().nullable(),
    truePeakDbfs: z.number().nullable(),
  }),
  byteLength: z.number().int().nonnegative().nullable(),
  etag: z.string().nullable(),
  acceptRanges: z.literal(true),
}).meta({ id: 'PlaybackDescriptor' });

export const lyricsSchema = z.object({
  trackId: OPAQUE_ID,
  documents: z.array(z.object({
    language: z.string(),
    synced: z.boolean(),
    lines: z.array(z.object({
      startMs: z.number().int().nonnegative().optional(),
      text: z.string(),
    })),
  })),
}).meta({ id: 'TrackLyrics' });

export const queueEntrySchema = z.object({
  queueEntryId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  track: trackSchema,
  addedAt: ISO_DATE_TIME,
}).meta({ id: 'PlaybackQueueEntry' });

export const playbackSessionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ownerClientId: z.string(),
  currentEntryId: z.string().uuid().nullable(),
  positionMs: z.number().int().nonnegative(),
  playbackState: z.enum(['playing', 'paused', 'stopped']),
  repeatMode: z.enum(['none', 'one', 'all']),
  shuffle: z.boolean(),
  source: z.object({ kind: z.string(), id: z.string().nullable() }).nullable(),
  revision: z.number().int().positive(),
  queue: z.array(queueEntrySchema),
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
}).meta({ id: 'PlaybackSession' });

export const playbackSessionCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  trackIds: z.array(OPAQUE_ID).max(2000).default([]),
  currentIndex: z.number().int().nonnegative().default(0),
  positionMs: z.number().int().nonnegative().default(0),
  source: z.object({ kind: z.string().max(40), id: z.string().max(512).nullable() }).nullable().optional(),
}).strict().meta({ id: 'PlaybackSessionCreate' });

const queueReplaceOperation = z.object({
  type: z.literal('replaceQueue'),
  trackIds: z.array(OPAQUE_ID).max(2000),
  currentIndex: z.number().int().nonnegative().optional(),
});
const queueInsertOperation = z.object({
  type: z.literal('insert'),
  index: z.number().int().nonnegative(),
  trackIds: z.array(OPAQUE_ID).min(1).max(200),
});
const queueRemoveOperation = z.object({
  type: z.literal('remove'),
  queueEntryIds: z.array(z.string().uuid()).min(1).max(200),
});
const queueMoveOperation = z.object({
  type: z.literal('move'),
  queueEntryId: z.string().uuid(),
  toIndex: z.number().int().nonnegative(),
});
const transportOperation = z.object({
  type: z.literal('setTransport'),
  currentEntryId: z.string().uuid().nullable().optional(),
  positionMs: z.number().int().nonnegative().optional(),
  playbackState: z.enum(['playing', 'paused', 'stopped']).optional(),
  repeatMode: z.enum(['none', 'one', 'all']).optional(),
  shuffle: z.boolean().optional(),
});

export const playbackSessionPatchSchema = z.object({
  expectedRevision: z.number().int().positive(),
  operations: z.array(z.discriminatedUnion('type', [
    queueReplaceOperation,
    queueInsertOperation,
    queueRemoveOperation,
    queueMoveOperation,
    transportOperation,
  ])).min(1).max(50),
}).strict().meta({ id: 'PlaybackSessionPatch' });

export const playbackSessionDeleteSchema = z.object({
  expectedRevision: z.number().int().positive(),
}).strict().meta({ id: 'PlaybackSessionDelete' });

export const playbackReportSchema = z.object({
  eventId: z.string().uuid(),
  trackId: OPAQUE_ID,
  kind: z.enum(['nowPlaying', 'played', 'skipped']),
  occurredAt: ISO_DATE_TIME.optional(),
  positionMs: z.number().int().nonnegative().optional(),
}).strict().meta({ id: 'PlaybackReport' });

export const listenerPreferencesSchema = z.object({
  streamingQuality: z.enum(['auto', '64k', '128k', '160k', '320k', 'source']),
  prebufferPolicy: z.enum(['off', 'conservative', 'aggressive']),
  playedThresholdPercent: z.number().min(1).max(100),
  loudnessNormEnabled: z.boolean(),
  loudnessTargetLufs: z.number().min(-30).max(-5),
  loudnessPreampDb: z.number().min(-12).max(12),
  loudnessMode: z.enum(['track', 'album']),
  subsonicProviderScrobbleEnabled: z.boolean(),
}).meta({ id: 'ListenerPreferences' });

export type ApiError = z.infer<typeof apiErrorSchema>;
export type AuroraUser = z.infer<typeof userSchema>;
export type AuroraClient = z.infer<typeof clientSchema>;
export type Track = z.infer<typeof trackSchema>;
export type ArtistSummary = z.infer<typeof artistSummarySchema>;
export type AlbumSummary = z.infer<typeof albumSummarySchema>;
export type Genre = z.infer<typeof genreSchema>;
export type PlaylistGenerationSource = z.infer<typeof playlistGenerationSourceSchema>;
export type Playlist = z.infer<typeof playlistSchema>;
export type PlaybackDescriptor = z.infer<typeof playbackDescriptorSchema>;
export type TrackLyrics = z.infer<typeof lyricsSchema>;
export type PlaybackSession = z.infer<typeof playbackSessionSchema>;
export type PlaybackSessionPatch = z.infer<typeof playbackSessionPatchSchema>;
export type ListenerPreferences = z.infer<typeof listenerPreferencesSchema>;
