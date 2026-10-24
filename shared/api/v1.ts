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

export const meSchema = z.object({
  user: userSchema,
  client: z.object({
    id: z.string().describe('The calling client: the X-Aurora-Client-Id it sent, or a server-assigned id.'),
    name: z.string(),
    authKind: z.enum(['jwt', 'appKey', 'scoped']),
    scope: z.literal('listener'),
  }),
}).meta({ id: 'Me' });

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
    albumArtistId: z.string().nullable(),
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
  editionLabel: z.string().nullable()
    .describe('Edition or release variant such as "Deluxe Edition", when the album is one of several editions.'),
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

export const PLAYBACK_OUTPUT_KINDS = ['browser', 'cast', 'receiver'] as const;
const PLAYBACK_OUTPUT_KIND_DESCRIPTION = 'browser: the device plays the session itself. cast: the device sends it to a Cast device it controls; `name` is the Cast device\'s. receiver: the Cast receiver plays the session itself, with its own credential; a controller claims it, and `name` is the Cast device\'s.';

export const PLAYBACK_OUTPUT_STATES = ['playing', 'paused', 'buffering', 'stopped', 'idle', 'error'] as const;

export const playbackOutputReportStateSchema = z.object({
  seq: z.number().int().nonnegative(),
  state: z.enum(PLAYBACK_OUTPUT_STATES),
  reason: z.string().nullable(),
  queueEntryId: z.string().uuid().nullable().describe('The entry the output is playing. Position belongs to this entry only.'),
  positionMs: z.number().int().nonnegative(),
  reportedAt: ISO_DATE_TIME.describe('Server time the report was accepted; interpolate from here while playing.'),
}).meta({ id: 'PlaybackOutputReportState' });

export const playbackOutputSchema = z.object({
  id: z.string().describe('The device that plays the session (its client ID).'),
  kind: z.enum(PLAYBACK_OUTPUT_KINDS).describe(PLAYBACK_OUTPUT_KIND_DESCRIPTION),
  name: z.string().nullable(),
  generation: z.number().int().positive().describe('Grant generation; goes up on every claim.'),
  claimedAt: ISO_DATE_TIME,
  castSessionId: z.string().nullable().optional()
    .describe("kind cast: the Cast session the output sends to; kind receiver: the Cast session the receiver runs in. When the server knows it (it is not kept across a server restart)."),
  status: z.enum(['active', 'unreachable', 'ended']).describe(
    'active: reporting. unreachable: silent for over a minute, last state kept; only a report or a new claim changes it. ended: the output itself reported stopped, idle or error.',
  ),
  report: playbackOutputReportStateSchema.nullable().describe("The output's latest accepted report."),
}).meta({ id: 'PlaybackOutput' });

export const playbackSessionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ownerClientId: z.string().describe('Deprecated: the client that last created or claimed the session. A session belongs to its user; any of their devices may change it.'),
  output: playbackOutputSchema.nullable().describe('The device currently playing the session, if any.'),
  currentEntryId: z.string().uuid().nullable(),
  positionMs: z.number().int().nonnegative(),
  playbackState: z.enum(['playing', 'paused', 'stopped']),
  repeatMode: z.enum(['none', 'one', 'all']),
  shuffle: z.boolean(),
  infinity: z.boolean().describe('Infinity: the server keeps a few upcoming entries, chosen by the recommendation engine, while something plays the session.'),
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

// Client-proposed entry IDs: one UUID per track, so an optimistic local entry
// and the confirmed server entry share an ID from the start. Omitted, the
// server generates them.
const proposedEntryIds = (max: number) => z.array(z.string().uuid()).max(max).optional()
  .describe('Client-proposed queue entry IDs, one unique UUID per track. Omitted, the server generates them.');
const entryIdsMatchTracks = (operation: { trackIds: string[]; entryIds?: string[] }) =>
  !operation.entryIds || (operation.entryIds.length === operation.trackIds.length && new Set(operation.entryIds).size === operation.entryIds.length);
const ENTRY_IDS_MESSAGE = 'entryIds must be unique and give one ID per track.';
// Exactly one of an index or an anchor. `afterEntryId: null` means the head of
// the queue. An anchor still means the same thing after other edits, so
// first-party clients use only the anchored form; the index form stays for
// existing API v1 clients.
const oneTarget = (indexKey: 'index' | 'toIndex') => (operation: Record<string, unknown>) =>
  (operation[indexKey] === undefined) !== (operation.afterEntryId === undefined);

const queueReplaceOperation = z.object({
  type: z.literal('replaceQueue'),
  trackIds: z.array(OPAQUE_ID).max(2000),
  entryIds: proposedEntryIds(2000),
  currentIndex: z.number().int().nonnegative().optional(),
}).refine(entryIdsMatchTracks, { message: ENTRY_IDS_MESSAGE, path: ['entryIds'] });
const queueInsertOperation = z.object({
  type: z.literal('insert'),
  index: z.number().int().nonnegative().optional().describe('Legacy position form. Give exactly one of index or afterEntryId.'),
  afterEntryId: z.string().uuid().nullable().optional().describe('Insert after this entry; null inserts at the head. Give exactly one of index or afterEntryId.'),
  trackIds: z.array(OPAQUE_ID).min(1).max(200),
  entryIds: proposedEntryIds(200),
})
  .refine(oneTarget('index'), { message: 'Give exactly one of index or afterEntryId.' })
  .refine(entryIdsMatchTracks, { message: ENTRY_IDS_MESSAGE, path: ['entryIds'] });
const queueRemoveOperation = z.object({
  type: z.literal('remove'),
  queueEntryIds: z.array(z.string().uuid()).min(1).max(200),
});
const queueMoveOperation = z.object({
  type: z.literal('move'),
  queueEntryId: z.string().uuid(),
  toIndex: z.number().int().nonnegative().optional().describe('Legacy position form. Give exactly one of toIndex or afterEntryId.'),
  afterEntryId: z.string().uuid().nullable().optional().describe('Move after this entry; null moves to the head. Give exactly one of toIndex or afterEntryId.'),
}).refine(oneTarget('toIndex'), { message: 'Give exactly one of toIndex or afterEntryId.' });
const transportOperation = z.object({
  type: z.literal('setTransport'),
  currentEntryId: z.string().uuid().nullable().optional(),
  positionMs: z.number().int().nonnegative().optional(),
  playbackState: z.enum(['playing', 'paused', 'stopped']).optional(),
  repeatMode: z.enum(['none', 'one', 'all']).optional(),
  shuffle: z.boolean().optional(),
  infinity: z.boolean().optional(),
});

export const playbackSessionPatchSchema = z.object({
  expectedRevision: z.number().int().positive(),
  // Idempotency key for the whole patch. A retry with the same key and body
  // returns the original success instead of a conflict with itself.
  requestId: z.string().uuid().optional().describe('Idempotency key for the whole patch; kept 24 hours.'),
  operations: z.array(z.discriminatedUnion('type', [
    queueReplaceOperation,
    queueInsertOperation,
    queueRemoveOperation,
    queueMoveOperation,
    transportOperation,
  ])).min(1).max(50),
}).strict().meta({ id: 'PlaybackSessionPatch' });

export const playbackOutputClaimSchema = z.object({
  kind: z.enum(PLAYBACK_OUTPUT_KINDS).describe(PLAYBACK_OUTPUT_KIND_DESCRIPTION),
  name: z.string().trim().min(1).max(120).optional(),
  castSessionId: z.string().trim().min(1).max(128).optional()
    .describe('kind cast: the Cast session this device sends to, so another device can tell joining it from starting a new one. kind receiver (required): the Cast session the receiver runs in; the output ID becomes `receiver:<castSessionId>`.'),
}).strict().refine((claim) => claim.kind !== 'receiver' || !!claim.castSessionId, {
  message: 'A receiver claim names the Cast session the receiver runs in.',
  path: ['castSessionId'],
}).meta({ id: 'PlaybackOutputClaim' });

export const playbackOutputReportSchema = z.object({
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).describe('Increases with every report within one grant; a report not above the last accepted one is dropped.'),
  state: z.enum(PLAYBACK_OUTPUT_STATES),
  reason: z.string().trim().min(1).max(40).optional().describe('Why the output stopped, e.g. "shutdown".'),
  queueEntryId: z.string().uuid().nullable(),
  positionMs: z.number().int().nonnegative(),
  outputId: z.string().max(160).optional().describe('Optional; must match the output credential.'),
  outputGeneration: z.number().int().positive().optional().describe('Optional; must match the output credential.'),
}).strict().meta({ id: 'PlaybackOutputReport' });

export const playbackOutputReportResultSchema = z.object({
  accepted: z.boolean().describe('False when the report was older than one already accepted (by seq) and was dropped.'),
  revision: z.number().int().positive(),
}).meta({ id: 'PlaybackOutputReportResult' });

export const playbackOutputRefreshSchema = z.object({
  outputId: z.string().min(1).max(160),
  generation: z.number().int().positive(),
}).strict().meta({ id: 'PlaybackOutputRefresh' });

export const playbackOutputCredentialSchema = z.object({
  token: z.string().describe('Output credential: a short-lived token bound to this session and grant. Keep it in memory only. For a receiver output, a receiver credential, which the receiver itself uses.'),
  expiresAt: ISO_DATE_TIME,
  outputId: z.string(),
  generation: z.number().int().positive(),
  renewableUntil: ISO_DATE_TIME.optional()
    .describe('Receiver credentials only: the receiver may renew its own credential (POST …/output/renew) until then, 24 hours after a controller issued it.'),
}).meta({ id: 'PlaybackOutputCredential' });

export const playbackOutputClaimResultSchema = z.object({
  session: playbackSessionSchema,
  credential: playbackOutputCredentialSchema,
}).meta({ id: 'PlaybackOutputClaimResult' });

// Remote control: another of the user's devices asks the session's output to
// act. The output carries the command out and its next report confirms it.
export const playbackCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play') }).strict(),
  z.object({ type: z.literal('pause') }).strict(),
  z.object({ type: z.literal('next') }).strict(),
  z.object({ type: z.literal('previous') }).strict(),
  z.object({ type: z.literal('seek'), positionMs: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('jump'), entryId: z.string().uuid().describe('Play this queue entry from its start.') }).strict(),
  z.object({
    type: z.literal('load'),
    revision: z.number().int().positive().describe('The output first adopts the session queue at this revision or later.'),
    entryId: z.string().uuid().describe('Then plays this entry from its start.'),
  }).strict(),
]).meta({ id: 'PlaybackCommand' });

export const playbackCommandRequestSchema = z.object({
  requestId: z.string().uuid().describe('A repeated requestId is accepted once.'),
  outputId: z.string().min(1).max(160).describe("The output this command is for: the session's current output.id."),
  outputGeneration: z.number().int().positive().describe("Its current output.generation; a newer claim makes the command stale."),
  command: playbackCommandSchema,
}).strict().meta({ id: 'PlaybackCommandRequest' });

export const playbackCommandResultSchema = z.object({
  accepted: z.boolean().describe('True when sent to the output; false for a repeated requestId.'),
}).meta({ id: 'PlaybackCommandResult' });

export const CONNECTED_DEVICE_KINDS = ['browser', 'receiver', 'app'] as const;
export const connectedDeviceSchema = z.object({
  clientId: z.string().describe("The device's client ID (X-Aurora-Client-Id, or the event stream's clientId)."),
  name: z.string().nullable().describe('The name the device gave itself ("Chrome on Linux"), when it gave one.'),
  kind: z.enum(CONNECTED_DEVICE_KINDS).describe('browser: the web app. receiver: a Cast receiver following a session. app: another API v1 client.'),
}).meta({ id: 'ConnectedDevice' });

export const playbackTransferRequestSchema = z.object({
  targetClientId: z.string().min(8).max(128).describe('A device from GET /devices: it takes the session over and plays it from where it is.'),
}).strict().meta({ id: 'PlaybackTransferRequest' });

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

export const infinitySettingsSchema = z.object({
  discoveryLevel: z.number().min(0).max(100).optional(),
  genreStrictness: z.number().min(0).max(100).optional(),
  artistAmnesiaLimit: z.number().int().min(0).max(200).optional(),
}).passthrough().meta({
  id: 'InfinitySettings',
  description: 'Per-request overrides for saved user tuning. Omitted values use saved settings or engine defaults.',
});

export const nextRecommendationSchema = z.object({
  sessionHistoryTrackIds: z.array(OPAQUE_ID).max(200).default([])
    .describe('Playback-start history, oldest to newest, including the playing track. Merged after older server history; does not record plays.'),
  exclude: z.array(OPAQUE_ID).max(200).default([])
    .describe('Track IDs already queued or otherwise excluded. Exclusions survive similarity relaxation and fallback.'),
  seedTrackIds: z.array(OPAQUE_ID).max(50).optional()
    .describe('The end of the play queue, oldest to newest, ending with the track the recommendation will follow. When present it steers the recommendation instead of playback history; history still prevents repeats. Only the last 10 are used.'),
  settings: infinitySettingsSchema.default({}),
}).strict().meta({ id: 'NextRecommendationRequest' });

export const listenerPreferencesSchema = z.object({
  streamingQuality: z.enum(['auto', '64k', '128k', '160k', '320k', 'source']),
  prebufferPolicy: z.enum(['off', 'conservative', 'aggressive']),
  playedThresholdPercent: z.number().min(1).max(100),
  loudnessNormEnabled: z.boolean(),
  loudnessTargetLufs: z.number().min(-30).max(-5),
  loudnessPreampDb: z.number().min(-12).max(12),
  loudnessMode: z.enum(['track', 'album']),
  subsonicProviderScrobbleEnabled: z.boolean(),
  subsonicProviderLoveSyncEnabled: z.boolean()
    .describe('Mirror stars from OpenSubsonic clients to Last.fm and MusicBrainz. Defaults to true.'),
}).meta({ id: 'ListenerPreferences' });

export const hubRegenerationSchema = z.object({
  skipped: z.boolean().describe('True when nothing was generated, for example because a refresh is already running or no LLM is configured.'),
  reason: z.string().nullable().describe('Why the regeneration was skipped.'),
  generated: z.number().int().nonnegative().describe('Number of hub playlists created.'),
}).meta({ id: 'HubRegeneration' });

export const artistRadioEligibilitySchema = z.object({
  eligible: z.boolean(),
  reason: z.string().nullable().describe('Why no radio can be built, when not eligible.'),
  targetLength: z.number().int().nonnegative().nullable(),
}).meta({ id: 'ArtistRadioEligibility' });

export const artistDetailSchema = z.object({
  artist: artistSummarySchema,
  details: z.object({
    bio: z.string().nullable(),
    disambiguation: z.string().nullable(),
    musicBrainzId: z.string().nullable(),
    links: z.unknown().nullable(),
    lifeSpanEnd: z.string().nullable(),
  }),
  tracks: z.array(trackSchema)
    .describe('Credited tracks first, then tracks on albums the artist owns as album artist without a performer credit.'),
  ownedAlbums: z.array(albumSummarySchema)
    .describe('Albums owned by the Various Artists pseudo-artist. Always empty for real artists.'),
}).meta({ id: 'ArtistDetail' });

export const albumDetailSchema = z.object({
  album: albumSummarySchema,
  details: z.object({
    description: z.string().nullable(),
    tags: z.unknown().nullable(),
    musicBrainzId: z.string().nullable(),
    editionLabel: z.string().nullable(),
  }),
  tracks: z.array(trackSchema),
}).meta({ id: 'AlbumDetail' });

export const genreDetailSchema = z.object({
  genre: genreSchema,
  tracks: z.array(trackSchema),
}).meta({ id: 'GenreDetail' });

export type ApiError = z.infer<typeof apiErrorSchema>;
export type AuroraUser = z.infer<typeof userSchema>;
export type Me = z.infer<typeof meSchema>;
export type AuroraClient = z.infer<typeof clientSchema>;
export type Track = z.infer<typeof trackSchema>;
export type ArtistSummary = z.infer<typeof artistSummarySchema>;
export type AlbumSummary = z.infer<typeof albumSummarySchema>;
export type Genre = z.infer<typeof genreSchema>;
export type ArtistDetail = z.infer<typeof artistDetailSchema>;
export type AlbumDetail = z.infer<typeof albumDetailSchema>;
export type GenreDetail = z.infer<typeof genreDetailSchema>;
export type PlaylistGenerationSource = z.infer<typeof playlistGenerationSourceSchema>;
export type Playlist = z.infer<typeof playlistSchema>;
export type PlaybackDescriptor = z.infer<typeof playbackDescriptorSchema>;
export type TrackLyrics = z.infer<typeof lyricsSchema>;
export type PlaybackSession = z.infer<typeof playbackSessionSchema>;
export type PlaybackSessionPatch = z.infer<typeof playbackSessionPatchSchema>;
export type PlaybackOutput = z.infer<typeof playbackOutputSchema>;
export type PlaybackOutputClaim = z.infer<typeof playbackOutputClaimSchema>;
export type PlaybackOutputReport = z.infer<typeof playbackOutputReportSchema>;
export type PlaybackOutputCredential = z.infer<typeof playbackOutputCredentialSchema>;
export type PlaybackCommand = z.infer<typeof playbackCommandSchema>;
export type PlaybackCommandRequest = z.infer<typeof playbackCommandRequestSchema>;
export type ConnectedDevice = z.infer<typeof connectedDeviceSchema>;
export type PlaybackTransferRequest = z.infer<typeof playbackTransferRequestSchema>;
export type ListenerPreferences = z.infer<typeof listenerPreferencesSchema>;
export type NextRecommendationRequest = z.input<typeof nextRecommendationSchema>;
