import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z, type ZodType } from 'zod';
import {
  albumDetailSchema,
  albumSummarySchema,
  apiErrorSchema,
  appKeyCreateSchema,
  artistDetailSchema,
  artistRadioEligibilitySchema,
  artistSummarySchema,
  clientSchema,
  genreDetailSchema,
  genreSchema,
  hubRegenerationSchema,
  listenerPreferencesSchema,
  meSchema,
  nextRecommendationSchema,
  lyricsSchema,
  pairingExchangeSchema,
  pairingRequestSchema,
  playbackDescriptorRequestSchema,
  playbackDescriptorSchema,
  playbackReportSchema,
  playbackSessionCreateSchema,
  playbackSessionDeleteSchema,
  playbackSessionPatchSchema,
  playbackSessionSchema,
  playbackOutputClaimSchema,
  playbackCommandRequestSchema,
  playbackTransferRequestSchema,
  sessionSharingSchema,
  sessionMembersSchema,
  sessionInviteCreateSchema,
  sessionInviteSchema,
  sessionInvitePromptSchema,
  sessionInvitePreviewSchema,
  onlineUserSchema,
  artworkLinksRequestSchema,
  artworkLinksSchema,
  connectedDeviceSchema,
  playbackCommandResultSchema,
  playbackOutputClaimResultSchema,
  playbackOutputCredentialSchema,
  playbackOutputRefreshSchema,
  playbackOutputReportSchema,
  playbackOutputReportResultSchema,
  playlistSchema,
  trackSchema,
  userSchema,
} from '../../../shared/api/v1';

const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'listenerAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'Aurora web JWT or a dedicated aurora_app_ listener key.',
});

const schemas = {
  ApiError: registry.register('ApiError', apiErrorSchema),
  User: registry.register('AuroraUser', userSchema),
  Client: registry.register('AuroraClient', clientSchema),
  Track: registry.register('Track', trackSchema),
  Artist: registry.register('ArtistSummary', artistSummarySchema),
  Album: registry.register('AlbumSummary', albumSummarySchema),
  Genre: registry.register('Genre', genreSchema),
  ArtistDetail: registry.register('ArtistDetail', artistDetailSchema),
  AlbumDetail: registry.register('AlbumDetail', albumDetailSchema),
  GenreDetail: registry.register('GenreDetail', genreDetailSchema),
  Playlist: registry.register('Playlist', playlistSchema),
  PlaybackDescriptor: registry.register('PlaybackDescriptor', playbackDescriptorSchema),
  PlaybackSession: registry.register('PlaybackSession', playbackSessionSchema),
  PlaybackOutputClaimResult: registry.register('PlaybackOutputClaimResult', playbackOutputClaimResultSchema),
  PlaybackCommandResult: registry.register('PlaybackCommandResult', playbackCommandResultSchema),
  ConnectedDevice: registry.register('ConnectedDevice', connectedDeviceSchema),
  SessionMembers: registry.register('SessionMembers', sessionMembersSchema),
  SessionInvite: registry.register('SessionInvite', sessionInviteSchema),
  SessionInvitePreview: registry.register('SessionInvitePreview', sessionInvitePreviewSchema),
  OnlineUser: registry.register('OnlineUser', onlineUserSchema),
  PlaybackOutputCredential: registry.register('PlaybackOutputCredential', playbackOutputCredentialSchema),
  PlaybackOutputReportResult: registry.register('PlaybackOutputReportResult', playbackOutputReportResultSchema),
  Preferences: registry.register('ListenerPreferences', listenerPreferencesSchema),
  Lyrics: registry.register('TrackLyrics', lyricsSchema),
};

const requestId = z.string().describe('Request ID echoed in the X-Request-Id response header.');
const cursorPage = z.object({ nextCursor: z.string().nullable() });
const json = (schema: ZodType) => ({ 'application/json': { schema } });
const data = (schema: ZodType) => z.object({ data: schema, meta: z.object({ requestId }) });
const page = (schema: ZodType) => z.object({
  data: schema,
  page: cursorPage,
  meta: z.object({ requestId, libraryRevision: z.string().optional() }),
});
const ok = (schema: ZodType, description = 'Successful response') => ({
  200: { description, content: json(data(schema)) },
  400: { description: 'Invalid request', content: json(schemas.ApiError) },
  401: { description: 'Authentication failed', content: json(schemas.ApiError) },
  403: { description: 'Insufficient access', content: json(schemas.ApiError) },
  404: { description: 'Resource not found', content: json(schemas.ApiError) },
  409: { description: 'Revision or state conflict', content: json(schemas.ApiError) },
  500: { description: 'Server error', content: json(schemas.ApiError) },
});
const paged = (schema: ZodType) => ({
  ...ok(schema),
  200: { description: 'Cursor page', content: json(page(schema)) },
});
const created = (schema: ZodType) => ({
  ...ok(schema),
  201: { description: 'Resource created', content: json(data(schema)) },
});
const noContent = () => {
  const { 200: _success, ...errors } = ok(unknownObject);
  return { ...errors, 204: { description: 'Resource deleted' } };
};

const idParams = z.object({ id: z.string().min(1) });
const codeParams = z.object({ code: z.string().min(1) });
const cursorQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
const authed = [{ listenerAuth: [] }];
const unknownObject = z.record(z.string(), z.unknown());

function path(config: Parameters<typeof registry.registerPath>[0]) {
  registry.registerPath(config);
}

path({ method: 'get', path: '/meta', summary: 'Discover server and API capabilities', tags: ['Discovery'], responses: ok(unknownObject) });
path({ method: 'get', path: '/openapi.json', summary: 'Download this OpenAPI document', tags: ['Discovery'], responses: { 200: { description: 'OpenAPI 3.1 document', content: json(unknownObject) } } });
path({
  method: 'post', path: '/pairing/requests', summary: 'Begin browser-assisted app pairing', tags: ['Authentication'],
  request: { body: { required: true, content: json(pairingRequestSchema) } }, responses: created(unknownObject),
});
path({
  method: 'post', path: '/pairing/exchange', summary: 'Poll and exchange an approved pairing request', tags: ['Authentication'],
  request: { body: { required: true, content: json(pairingExchangeSchema) } }, responses: { ...ok(unknownObject), 202: { description: 'Pairing is still pending', content: json(data(unknownObject)) } },
});
path({
  method: 'get', path: '/media/tracks/{id}', summary: 'Stream track bytes with Range support', tags: ['Playback'],
  request: { params: idParams, query: z.object({ token: z.string() }) },
  responses: { 200: { description: 'Complete audio stream' }, 206: { description: 'Audio byte range' }, 401: { description: 'Invalid media token', content: json(schemas.ApiError) }, 404: { description: 'Media unavailable', content: json(schemas.ApiError) } },
});

path({ method: 'get', path: '/me', summary: 'Get the authenticated user and client', tags: ['Authentication'], security: authed, responses: ok(meSchema) });
path({ method: 'post', path: '/artwork/links', summary: 'Signed links for artwork IDs', description: "For artwork a client holds without a signature (a track list saved before links were signed). Each link opens its one image with no credential; it opens nothing the caller could not open with its own token.", tags: ['Library'], security: authed, request: { body: { required: true, content: json(artworkLinksRequestSchema) } }, responses: { 200: { description: 'Signed links by ID', content: json(z.object({ data: artworkLinksSchema })) }, 400: { description: 'Invalid IDs', content: json(schemas.ApiError) } } });
path({ method: 'get', path: '/artwork/{hash}', summary: 'Get cached cover artwork', description: "A track's artworkUrl carries `sig`, a signature for that one image: with it no credential is needed. Without it, authenticate as usual (a media token in `token` for an <img>).", tags: ['Library'], security: [...authed, {}], request: { params: z.object({ hash: z.string() }), query: z.object({ size: z.coerce.number().optional(), token: z.string().optional(), sig: z.string().optional() }) }, responses: { 200: { description: 'AVIF artwork', content: { 'image/avif': { schema: { type: 'string', contentEncoding: 'binary' } } } }, 401: { description: 'Authentication failed', content: json(schemas.ApiError) }, 403: { description: 'INVALID_ARTWORK_SIGNATURE: the signature does not match this image', content: json(schemas.ApiError) }, 404: { description: 'Artwork unavailable', content: json(schemas.ApiError) } } });
path({ method: 'get', path: '/app-keys', summary: 'List dedicated Aurora app keys', description: 'Requires a browser JWT session.', tags: ['Authentication'], security: authed, responses: ok(z.array(schemas.Client)) });
path({ method: 'post', path: '/app-keys', summary: 'Create a dedicated Aurora app key', description: 'The secret is returned once. Requires a browser JWT session.', tags: ['Authentication'], security: authed, request: { body: { required: true, content: json(appKeyCreateSchema) } }, responses: created(unknownObject) });
path({ method: 'post', path: '/app-keys/{id}/rotate', summary: 'Rotate an Aurora app key', tags: ['Authentication'], security: authed, request: { params: idParams }, responses: ok(unknownObject) });
path({ method: 'delete', path: '/app-keys/{id}', summary: 'Revoke or delete an Aurora app key', tags: ['Authentication'], security: authed, request: { params: idParams }, responses: ok(unknownObject) });
path({ method: 'get', path: '/pairing/requests/{code}', summary: 'Preview a pairing request', tags: ['Authentication'], security: authed, request: { params: codeParams }, responses: ok(unknownObject) });
path({ method: 'post', path: '/pairing/requests/{code}/approve', summary: 'Approve a pairing request', tags: ['Authentication'], security: authed, request: { params: codeParams }, responses: ok(unknownObject) });
path({ method: 'delete', path: '/pairing/requests/{code}', summary: 'Cancel an approved pairing request', tags: ['Authentication'], security: authed, request: { params: codeParams }, responses: ok(unknownObject) });
path({ method: 'post', path: '/auth/scoped-token', summary: 'Mint a short-lived scoped token', tags: ['Authentication'], security: authed, request: { body: { required: true, content: json(z.object({ scope: z.enum(['media', 'sse']), expiresIn: z.enum(['5m', '15m', '1h', '12h']).optional() })) } }, responses: ok(unknownObject) });

path({ method: 'get', path: '/artists', summary: 'List artists', tags: ['Library'], security: authed, request: { query: cursorQuery }, responses: paged(z.array(schemas.Artist)) });
path({ method: 'get', path: '/artists/{id}', summary: 'Get an artist and tracks', tags: ['Library'], security: authed, request: { params: idParams }, responses: ok(schemas.ArtistDetail) });
path({ method: 'get', path: '/albums', summary: 'List albums', tags: ['Library'], security: authed, request: { query: cursorQuery }, responses: paged(z.array(schemas.Album)) });
path({ method: 'get', path: '/albums/{id}', summary: 'Get an album and tracks', tags: ['Library'], security: authed, request: { params: idParams }, responses: ok(schemas.AlbumDetail) });
path({ method: 'get', path: '/genres', summary: 'List genres', tags: ['Library'], security: authed, request: { query: cursorQuery }, responses: paged(z.array(schemas.Genre)) });
path({ method: 'get', path: '/genres/{id}', summary: 'Get a genre and tracks', tags: ['Library'], security: authed, request: { params: idParams }, responses: ok(schemas.GenreDetail) });
path({ method: 'get', path: '/tracks/{id}', summary: 'Get one path-free track resource', tags: ['Library'], security: authed, request: { params: idParams }, responses: ok(schemas.Track) });
path({ method: 'get', path: '/tracks/{id}/lyrics', summary: 'Get embedded synced or unsynced lyrics', tags: ['Library'], security: authed, request: { params: idParams }, responses: ok(schemas.Lyrics) });
path({ method: 'get', path: '/search', summary: 'Search the listener library', tags: ['Library'], security: authed, request: { query: z.object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).optional(), artistLimit: z.coerce.number().int().min(1).max(100).optional(), albumLimit: z.coerce.number().int().min(1).max(100).optional(), trackLimit: z.coerce.number().int().min(1).max(100).optional() }) }, responses: ok(unknownObject) });
path({ method: 'get', path: '/search/ranked', summary: 'Relevance-ranked search across artists, albums and tracks, paginated', tags: ['Library'], security: authed, request: { query: z.object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().optional() }) }, responses: ok(unknownObject) });

path({ method: 'get', path: '/playlists', summary: 'List readable playlists', tags: ['Playlists'], security: authed, responses: ok(z.array(schemas.Playlist)) });
path({ method: 'get', path: '/playlists/discover', summary: 'List public playlists from other users', tags: ['Playlists'], security: authed, responses: ok(z.array(schemas.Playlist)) });
path({ method: 'get', path: '/playlists/{id}', summary: 'Get a playlist', tags: ['Playlists'], security: authed, request: { params: idParams }, responses: ok(schemas.Playlist) });
path({ method: 'get', path: '/playlists/{id}/suggestions', summary: 'Get playlist suggestions', tags: ['Playlists'], security: authed, request: { params: idParams }, responses: ok(z.array(schemas.Track)) });
path({ method: 'post', path: '/playlists', summary: 'Create a playlist', tags: ['Playlists'], security: authed, request: { body: { required: true, content: json(z.object({ title: z.string(), description: z.string().nullable().optional() })) } }, responses: created(schemas.Playlist) });
path({ method: 'put', path: '/playlists/{id}/tracks', summary: 'Replace playlist tracks', tags: ['Playlists'], security: authed, request: { params: idParams, body: { required: true, content: json(z.object({ trackIds: z.array(z.string()) })) } }, responses: ok(schemas.Playlist) });
path({ method: 'patch', path: '/playlists/{id}', summary: 'Update playlist metadata', tags: ['Playlists'], security: authed, request: { params: idParams, body: { required: true, content: json(unknownObject) } }, responses: ok(schemas.Playlist) });
path({ method: 'patch', path: '/playlists/{id}/state', summary: 'Update playlist pin or privacy state', tags: ['Playlists'], security: authed, request: { params: idParams, body: { required: true, content: json(unknownObject) } }, responses: ok(schemas.Playlist) });
path({ method: 'post', path: '/playlists/{id}/share', summary: 'Create or revoke a share link', tags: ['Playlists'], security: authed, request: { params: idParams, body: { required: true, content: json(z.object({ enabled: z.boolean() })) } }, responses: ok(unknownObject) });
path({ method: 'delete', path: '/playlists/{id}', summary: 'Delete a playlist', tags: ['Playlists'], security: authed, request: { params: idParams }, responses: noContent() });

path({ method: 'get', path: '/hub', summary: 'Get listener hub collections', tags: ['Discovery'], security: authed, request: { query: z.object({ queueRefresh: z.enum(['true', 'false']).optional().describe('Pass false on background re-polls so the view does not queue another hub refresh.') }) }, responses: ok(unknownObject) });
path({ method: 'get', path: '/hub/smart', summary: 'Get deterministic smart sections', tags: ['Discovery'], security: authed, responses: ok(unknownObject) });
path({ method: 'post', path: '/hub/regenerate', summary: 'Regenerate the listener\'s AI hub playlists', tags: ['Discovery'], security: authed, request: { body: { required: false, content: json(z.object({ force: z.boolean().optional().describe('Regenerate even when the hub playlists are still fresh, replacing them.') })) } }, responses: ok(hubRegenerationSchema) });
path({ method: 'get', path: '/hub/artist-radio/eligibility', summary: 'Whether an artist radio can be built', tags: ['Discovery'], security: authed, request: { query: z.object({ artistId: z.string() }) }, responses: ok(artistRadioEligibilitySchema) });
path({ method: 'post', path: '/hub/artist-radio', summary: 'Generate artist radio', tags: ['Discovery'], security: authed, request: { body: { required: true, content: json(z.object({ artistId: z.string(), limit: z.number().int().optional() })) } }, responses: ok(schemas.Playlist) });
path({ method: 'post', path: '/hub/custom', summary: 'Generate a prompt-driven playlist', tags: ['Discovery'], security: authed, request: { body: { required: true, content: json(z.object({ prompt: z.string(), count: z.number().int().optional() })) } }, responses: created(schemas.Playlist) });
path({ method: 'post', path: '/recommendations/next', summary: 'Choose the next infinity-mode track', description: 'Uses playback-start history and queue exclusions without recording plays. Returns null when no eligible track remains.', tags: ['Discovery'], security: authed, request: { body: { required: true, content: json(nextRecommendationSchema) } }, responses: ok(z.union([schemas.Track, z.null()])) });

path({ method: 'put', path: '/tracks/{id}/loved', summary: 'Set track loved state', tags: ['Listening'], security: authed, request: { params: idParams, body: { required: true, content: json(z.object({ loved: z.boolean() })) } }, responses: ok(unknownObject) });
path({ method: 'put', path: '/tracks/{id}/rating', summary: 'Set track rating', tags: ['Listening'], security: authed, request: { params: idParams, body: { required: true, content: json(z.object({ rating: z.number().int().min(0).max(5) })) } }, responses: ok(unknownObject) });
path({ method: 'post', path: '/playback/reports', summary: 'Idempotently report playback activity', tags: ['Listening'], security: authed, request: { body: { required: true, content: json(playbackReportSchema) } }, responses: ok(unknownObject) });
path({ method: 'get', path: '/preferences', summary: 'Get listener preferences', tags: ['Listening'], security: authed, responses: ok(schemas.Preferences) });
path({ method: 'patch', path: '/preferences', summary: 'Update listener preferences', tags: ['Listening'], security: authed, request: { body: { required: true, content: json(listenerPreferencesSchema.partial()) } }, responses: ok(schemas.Preferences) });
path({ method: 'post', path: '/tracks/{id}/playback', summary: 'Resolve playback sources and loudness', tags: ['Playback'], security: authed, request: { params: idParams, body: { required: true, content: json(playbackDescriptorRequestSchema) } }, responses: ok(schemas.PlaybackDescriptor) });

// Every session route answers this while sync is off for the account, to every client alike.
const SYNC_DISABLED = "PLAYBACK_SYNC_DISABLED: playback sync across devices is turned off for this account (the server admin's choice, or the user's where the admin lets each user decide)";
const sessionResponses = <R extends Record<number, { description: string }>>(responses: R) => ({
  ...responses,
  403: { description: responses[403] ? `${responses[403].description}; or ${SYNC_DISABLED}` : SYNC_DISABLED, content: json(schemas.ApiError) },
});
path({ method: 'get', path: '/playback-sessions', summary: 'List durable playback sessions', tags: ['Sessions'], security: authed, responses: sessionResponses(ok(z.array(schemas.PlaybackSession))) });
path({ method: 'post', path: '/playback-sessions', summary: 'Create a playback session for this user', tags: ['Sessions'], security: authed, request: { body: { required: true, content: json(playbackSessionCreateSchema) } }, responses: sessionResponses(created(schemas.PlaybackSession)) });
path({ method: 'get', path: '/playback-sessions/{id}', summary: 'Get a playback session', tags: ['Sessions'], security: authed, request: { params: idParams }, responses: sessionResponses(ok(schemas.PlaybackSession)) });
const sessionPatchResponses = {
  ...ok(schemas.PlaybackSession),
  200: {
    description: 'The session after the patch. For a retried requestId, the current session and the revision the original attempt produced.',
    content: json(z.object({
      data: schemas.PlaybackSession,
      meta: z.object({
        requestId,
        appliedRevision: z.number().int().positive().describe('Revision this patch produced.'),
        replayed: z.boolean().describe('True when the requestId was already applied; nothing was applied again.'),
      }),
    })),
  },
  409: { description: 'REVISION_CONFLICT, ANCHOR_NOT_FOUND, ENTRY_ID_CONFLICT or CURRENT_ENTRY_PLAYING (the entry that plays cannot be removed; each with the current session in details.current), or TRACKS_UNAVAILABLE', content: json(schemas.ApiError) },
  422: { description: 'IDEMPOTENCY_KEY_REUSED: the requestId was used for a different body', content: json(schemas.ApiError) },
};
path({ method: 'patch', path: '/playback-sessions/{id}', summary: 'Apply optimistic queue or transport changes', tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: true, content: json(playbackSessionPatchSchema) } }, responses: sessionResponses(sessionPatchResponses) });
path({ method: 'post', path: '/playback-sessions/{id}/output', summary: 'Play here: make the calling device (or, with kind receiver, the Cast receiver it casts to) the session output and get its credential', tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: true, content: json(playbackOutputClaimSchema) } }, responses: sessionResponses(ok(schemas.PlaybackOutputClaimResult)) });
path({ method: 'post', path: '/playback-sessions/{id}/output/refresh', summary: "Mint a fresh output credential for the session's current output grant", tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: true, content: json(playbackOutputRefreshSchema) } }, responses: sessionResponses({ ...ok(schemas.PlaybackOutputCredential), 409: { description: 'OUTPUT_GRANT_REPLACED: another device has claimed the output since (current session in details.current)', content: json(schemas.ApiError) } }) });
path({ method: 'post', path: '/playback-sessions/{id}/output/renew', summary: 'A Cast receiver renews its own receiver credential, up to renewableUntil', description: 'Receiver credential only, for its own session. The new credential keeps the same renewableUntil.', tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: false, content: json(z.object({}).strict()) } }, responses: sessionResponses({ ...ok(schemas.PlaybackOutputCredential), 401: { description: 'RECEIVER_RENEWAL_EXPIRED: past renewableUntil; a controller must refresh it', content: json(schemas.ApiError) }, 403: { description: 'RECEIVER_CREDENTIAL_REQUIRED, or SCOPED_TOKEN_NOT_ALLOWED for another session', content: json(schemas.ApiError) }, 409: { description: 'OUTPUT_GRANT_REPLACED: another output has been claimed since (current session in details.current)', content: json(schemas.ApiError) } }) });
path({ method: 'post', path: '/playback-sessions/{id}/reports', summary: 'Report what the output is playing (output or receiver credential only)', tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: true, content: json(playbackOutputReportSchema) } }, responses: sessionResponses({ ...ok(schemas.PlaybackOutputReportResult), 403: { description: 'OUTPUT_CREDENTIAL_REQUIRED, or SCOPED_TOKEN_NOT_ALLOWED for another session', content: json(schemas.ApiError) }, 409: { description: 'OUTPUT_GRANT_REPLACED: another device has claimed the output (current session in details.current)', content: json(schemas.ApiError) }, 422: { description: 'OUTPUT_IDENTITY_MISMATCH: the body names another output or generation than the credential', content: json(schemas.ApiError) } }) });
path({ method: 'post', path: '/playback-sessions/{id}/commands', summary: "Remote control: ask the session's output to play, pause, skip, seek, jump or load", description: 'Sent to the output as a live-only playbackSession.command event; its next report confirms the effect. For a new queue, PATCH the session first (replaceQueue), then send load with the resulting revision.', tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: true, content: json(playbackCommandRequestSchema) } }, responses: sessionResponses({ 202: { description: 'Sent to the output (accepted: false for a repeated requestId)', content: json(schemas.PlaybackCommandResult) }, 409: { description: 'OUTPUT_GRANT_REPLACED: another device plays the session now; OUTPUT_NOT_ACTIVE: nothing plays it; or OUTPUT_UNREACHABLE: the output has no event stream open (current session in details.current)', content: json(schemas.ApiError) } }) });
path({ method: 'get', path: '/devices', summary: "The user's devices with Aurora open now", description: 'One entry per device with an event stream open (GET /events). The list changes live: every stream hears devices.changed with the new list.', tags: ['Sessions'], security: authed, responses: ok(z.array(schemas.ConnectedDevice)) });
// Listen together (docs/listen-together.md, 6c)
const ownerOnly = { 403: { description: "SESSION_OWNER_ONLY: only the session's owner can do this", content: json(schemas.ApiError) } };
const inviteParams = z.object({ id: z.string().min(1), token: z.string().min(1) });
path({ method: 'patch', path: '/playback-sessions/{id}/sharing', summary: 'Who may join: private or invite only (owner)', description: 'Private keeps guests already in, but no one new can join. Guests hear playbackSession.visibilityChanged.', tags: ['Listen together'], security: authed, request: { params: idParams, body: { required: true, content: json(sessionSharingSchema) } }, responses: sessionResponses({ ...ok(schemas.PlaybackSession), ...ownerOnly }) });
path({ method: 'get', path: '/playback-sessions/{id}/members', summary: 'The owner and the guests, with names and scopes', description: 'For the people in the session: the owner and its guests.', tags: ['Listen together'], security: authed, request: { params: idParams }, responses: sessionResponses(ok(schemas.SessionMembers)) });
path({ method: 'delete', path: '/playback-sessions/{id}/members/{userId}', summary: 'Remove a guest (owner), or leave (the guest itself)', description: 'Everyone in the session, and the guest, hears playbackSession.memberLeft (`{sessionId, userId, reason: removed | left}`).', tags: ['Listen together'], security: authed, request: { params: z.object({ id: z.string().min(1), userId: z.string().min(1) }) }, responses: sessionResponses({ 204: { description: 'Removed' }, ...ownerOnly }) });
path({ method: 'get', path: '/playback-sessions/{id}/invites', summary: "The session's working join links (owner)", tags: ['Listen together'], security: authed, request: { params: idParams }, responses: sessionResponses({ ...ok(z.array(schemas.SessionInvite)), ...ownerOnly }) });
path({ method: 'post', path: '/playback-sessions/{id}/invites', summary: 'A new join link (owner)', description: 'Anyone signed in on this server who opens it can join, with its scopes, until it is revoked or listening together ends. A private session becomes invite-only.', tags: ['Listen together'], security: authed, request: { params: idParams, body: { required: true, content: json(sessionInviteCreateSchema) } }, responses: sessionResponses({ 201: { description: 'Created', content: json(z.object({ data: schemas.SessionInvite })) }, ...ownerOnly }) });
path({ method: 'delete', path: '/playback-sessions/{id}/invites/{token}', summary: 'Revoke a join link (owner)', tags: ['Listen together'], security: authed, request: { params: inviteParams }, responses: sessionResponses({ 204: { description: 'Revoked' }, ...ownerOnly, 404: { description: 'SESSION_INVITE_NOT_FOUND', content: json(schemas.ApiError) } }) });
path({ method: 'post', path: '/playback-sessions/{id}/invites/{token}/prompt', summary: 'Prompt users of this server with a join link (owner)', description: 'Each hears playbackSession.invitePrompt (`{sessionId, token, path, preview}`) on /events. Unknown users and the owner are skipped.', tags: ['Listen together'], security: authed, request: { params: inviteParams, body: { required: true, content: json(sessionInvitePromptSchema) } }, responses: sessionResponses({ ...ok(z.object({ prompted: z.number().int().nonnegative() })), ...ownerOnly, 404: { description: 'SESSION_INVITE_NOT_FOUND', content: json(schemas.ApiError) }, 409: { description: 'SESSION_NOT_JOINABLE: the session is private right now', content: json(schemas.ApiError) } }) });
path({ method: 'post', path: '/playback-sessions/{id}/together/end', summary: 'End listening together (owner)', description: 'Every guest is removed, every link revoked, and the session becomes private. The music plays on. Everyone hears playbackSession.togetherEnded, and memberLeft (`reason: ended`) for each guest.', tags: ['Listen together'], security: authed, request: { params: idParams, body: { required: true, content: json(z.object({}).strict()) } }, responses: sessionResponses({ ...ok(schemas.PlaybackSession), ...ownerOnly }) });
path({ method: 'get', path: '/session-invites/{token}', summary: 'What a join link shows before joining', description: '"{ownerName}\'s session" and the avatars of the owner and the guests: no guest names, nothing about what plays. Limited per user.', tags: ['Listen together'], security: authed, request: { params: z.object({ token: z.string().min(1) }) }, responses: { ...ok(schemas.SessionInvitePreview), 404: { description: 'SESSION_INVITE_NOT_FOUND: unknown, revoked, or its session gone', content: json(schemas.ApiError) }, 409: { description: 'SESSION_NOT_JOINABLE: the session is private right now', content: json(schemas.ApiError) } } });
path({ method: 'post', path: '/session-invites/{token}/join', summary: 'Join a session through a link', description: "Makes the caller a guest with the link's scopes, leaving any other session it was a guest in. The owner joining its own link gets its session back. Everyone in the session hears playbackSession.memberJoined. Limited per user.", tags: ['Listen together'], security: authed, request: { params: z.object({ token: z.string().min(1) }), body: { required: true, content: json(z.object({}).strict()) } }, responses: { ...ok(schemas.PlaybackSession), 403: { description: "PLAYBACK_SYNC_DISABLED: sync is off for the session's owner", content: json(schemas.ApiError) }, 404: { description: 'SESSION_INVITE_NOT_FOUND', content: json(schemas.ApiError) }, 409: { description: 'SESSION_NOT_JOINABLE: the session is private right now', content: json(schemas.ApiError) } } });
path({ method: 'get', path: '/users/online', summary: 'Users of this server with Aurora open now', description: 'Names and avatars only, the caller left out: whom an owner can prompt with a join link.', tags: ['Listen together'], security: authed, responses: ok(z.array(schemas.OnlineUser)) });
path({ method: 'post', path: '/playback-sessions/{id}/transfer', summary: 'Move the session to another of the user\'s devices', description: 'The target hears playbackSession.transferRequested (`{sessionId, revision, targetClientId, requestedBy}`, live only) on /events, takes the output over and plays from where the session is; the device that played is displaced as for any claim. A browser may need a tap before it can start sound.', tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: true, content: json(playbackTransferRequestSchema) } }, responses: sessionResponses({ 202: { description: 'Sent to the device', content: json(schemas.PlaybackCommandResult) }, 404: { description: 'PLAYBACK_SESSION_NOT_FOUND', content: json(schemas.ApiError) }, 409: { description: 'DEVICE_NOT_CONNECTED: that device has no event stream open, or is a Cast receiver', content: json(schemas.ApiError) } }) });
path({ method: 'post', path: '/playback-sessions/{id}/handoff', summary: 'Legacy alias: claim the output for the calling browser at an expected revision', tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: true, content: json(z.object({ expectedRevision: z.number().int().positive() })) } }, responses: sessionResponses(ok(schemas.PlaybackSession)) });
path({ method: 'delete', path: '/playback-sessions/{id}', summary: 'Delete a playback session at an expected revision', tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: true, content: json(playbackSessionDeleteSchema) } }, responses: sessionResponses(noContent()) });
path({
  method: 'get', path: '/events', summary: 'Subscribe to listener-scoped server events', tags: ['Events'],
  description: 'Use a short-lived sse token (or a receiver credential, which hears only its own session) in the query string because EventSource cannot set Authorization headers; a full session token is refused. '
    + 'Each event\'s data is JSON `{id, type, occurredAt, data}`. Types: playbackSession.created / updated / handedOff / deleted (fetch the session when its revision is newer), '
    + 'playbackSession.progress (every accepted output report: `{sessionId, revision, outputId, generation, report}`; live only, never replayed), '
    + 'playlist.changed, annotation.changed, playbackSession.command (to the output: `{sessionId, outputId, generation, requestId, issuedBy, command}`; live only), playbackSession.transferRequested (to the device asked to take over: `{sessionId, revision, targetClientId, requestedBy}`; live only), Listen together: playbackSession.memberJoined (`{sessionId, userId, avatar}`), memberLeft (`{sessionId, userId, reason: left | removed | ended}`), visibilityChanged (`{sessionId, visibility}`), togetherEnded (`{sessionId}`), to the owner and its guests, and invitePrompt (`{sessionId, token, path, preview}`, to a prompted user), devices.changed (`{devices}`: every device of this user with Aurora open, whenever one opens or closes; live only), library.revision, playbackSync.changed (`{enabled}`: whether the playback-session API works for this account now), and resync.required (the replay window was lost: re-fetch everything).',
  request: { query: z.object({ token: z.string().optional(), clientId: z.string().optional().describe('With an sse token: the device this stream belongs to, so remote commands can reach it.'), clientName: z.string().optional().describe('With an sse token: what to call this device in GET /devices ("Chrome on Linux").') }), headers: z.object({ 'last-event-id': z.string().optional() }) }, security: authed,
  responses: { 200: { description: 'Server-Sent Events stream', content: { 'text/event-stream': { schema: z.string() } } }, 401: { description: 'Authentication failed', content: json(schemas.ApiError) } },
});

export function generateAuroraApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Aurora Listener API',
      version: '1.0.0',
      description: 'In-development, path-free API for Aurora web and future dedicated listener applications. Administrative and library-management operations remain outside v1.',
    },
    servers: [{ url: '/api/v1', description: 'This Aurora server' }],
    tags: [
      { name: 'Authentication' },
      { name: 'Library' },
      { name: 'Playlists' },
      { name: 'Discovery' },
      { name: 'Listening' },
      { name: 'Playback' },
      { name: 'Sessions' },
      { name: 'Events' },
    ],
  });
}
