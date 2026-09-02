import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z, type ZodType } from 'zod';
import {
  albumSummarySchema,
  apiErrorSchema,
  appKeyCreateSchema,
  artistSummarySchema,
  clientSchema,
  genreSchema,
  listenerPreferencesSchema,
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
  Playlist: registry.register('Playlist', playlistSchema),
  PlaybackDescriptor: registry.register('PlaybackDescriptor', playbackDescriptorSchema),
  PlaybackSession: registry.register('PlaybackSession', playbackSessionSchema),
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

path({ method: 'get', path: '/me', summary: 'Get the authenticated user and client', tags: ['Authentication'], security: authed, responses: ok(unknownObject) });
path({ method: 'get', path: '/artwork/{hash}', summary: 'Get cached cover artwork', tags: ['Library'], security: authed, request: { params: z.object({ hash: z.string() }), query: z.object({ size: z.coerce.number().optional(), token: z.string().optional() }) }, responses: { 200: { description: 'AVIF artwork', content: { 'image/avif': { schema: { type: 'string', contentEncoding: 'binary' } } } }, 401: { description: 'Authentication failed', content: json(schemas.ApiError) }, 404: { description: 'Artwork unavailable', content: json(schemas.ApiError) } } });
path({ method: 'get', path: '/app-keys', summary: 'List dedicated Aurora app keys', description: 'Requires a browser JWT session.', tags: ['Authentication'], security: authed, responses: ok(z.array(schemas.Client)) });
path({ method: 'post', path: '/app-keys', summary: 'Create a dedicated Aurora app key', description: 'The secret is returned once. Requires a browser JWT session.', tags: ['Authentication'], security: authed, request: { body: { required: true, content: json(appKeyCreateSchema) } }, responses: created(unknownObject) });
path({ method: 'post', path: '/app-keys/{id}/rotate', summary: 'Rotate an Aurora app key', tags: ['Authentication'], security: authed, request: { params: idParams }, responses: ok(unknownObject) });
path({ method: 'delete', path: '/app-keys/{id}', summary: 'Revoke or delete an Aurora app key', tags: ['Authentication'], security: authed, request: { params: idParams }, responses: ok(unknownObject) });
path({ method: 'get', path: '/pairing/requests/{code}', summary: 'Preview a pairing request', tags: ['Authentication'], security: authed, request: { params: codeParams }, responses: ok(unknownObject) });
path({ method: 'post', path: '/pairing/requests/{code}/approve', summary: 'Approve a pairing request', tags: ['Authentication'], security: authed, request: { params: codeParams }, responses: ok(unknownObject) });
path({ method: 'delete', path: '/pairing/requests/{code}', summary: 'Cancel an approved pairing request', tags: ['Authentication'], security: authed, request: { params: codeParams }, responses: ok(unknownObject) });
path({ method: 'post', path: '/auth/scoped-token', summary: 'Mint a short-lived scoped token', tags: ['Authentication'], security: authed, request: { body: { required: true, content: json(z.object({ scope: z.enum(['media', 'sse', 'receiver']), expiresIn: z.enum(['5m', '15m', '1h', '12h']).optional() })) } }, responses: ok(unknownObject) });

path({ method: 'get', path: '/artists', summary: 'List artists', tags: ['Library'], security: authed, request: { query: cursorQuery }, responses: paged(z.array(schemas.Artist)) });
path({ method: 'get', path: '/artists/{id}', summary: 'Get an artist and tracks', tags: ['Library'], security: authed, request: { params: idParams }, responses: ok(unknownObject) });
path({ method: 'get', path: '/albums', summary: 'List albums', tags: ['Library'], security: authed, request: { query: cursorQuery }, responses: paged(z.array(schemas.Album)) });
path({ method: 'get', path: '/albums/{id}', summary: 'Get an album and tracks', tags: ['Library'], security: authed, request: { params: idParams }, responses: ok(unknownObject) });
path({ method: 'get', path: '/genres', summary: 'List genres', tags: ['Library'], security: authed, request: { query: cursorQuery }, responses: paged(z.array(schemas.Genre)) });
path({ method: 'get', path: '/genres/{id}', summary: 'Get a genre and tracks', tags: ['Library'], security: authed, request: { params: idParams }, responses: ok(unknownObject) });
path({ method: 'get', path: '/tracks/{id}', summary: 'Get one path-free track resource', tags: ['Library'], security: authed, request: { params: idParams }, responses: ok(schemas.Track) });
path({ method: 'get', path: '/tracks/{id}/lyrics', summary: 'Get embedded synced or unsynced lyrics', tags: ['Library'], security: authed, request: { params: idParams }, responses: ok(schemas.Lyrics) });
path({ method: 'get', path: '/search', summary: 'Search the listener library', tags: ['Library'], security: authed, request: { query: z.object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).optional() }) }, responses: ok(unknownObject) });

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

path({ method: 'get', path: '/hub', summary: 'Get listener hub collections', tags: ['Discovery'], security: authed, responses: ok(unknownObject) });
path({ method: 'get', path: '/hub/smart', summary: 'Get deterministic smart sections', tags: ['Discovery'], security: authed, responses: ok(unknownObject) });
path({ method: 'post', path: '/hub/artist-radio', summary: 'Generate artist radio', tags: ['Discovery'], security: authed, request: { body: { required: true, content: json(z.object({ artistId: z.string(), limit: z.number().int().optional() })) } }, responses: ok(schemas.Playlist) });
path({ method: 'post', path: '/hub/custom', summary: 'Generate a prompt-driven playlist', tags: ['Discovery'], security: authed, request: { body: { required: true, content: json(z.object({ prompt: z.string(), count: z.number().int().optional() })) } }, responses: created(schemas.Playlist) });
path({ method: 'post', path: '/recommendations/next', summary: 'Choose the next infinity-mode track', tags: ['Discovery'], security: authed, request: { body: { required: true, content: json(unknownObject) } }, responses: ok(schemas.Track.nullable()) });

path({ method: 'put', path: '/tracks/{id}/loved', summary: 'Set track loved state', tags: ['Listening'], security: authed, request: { params: idParams, body: { required: true, content: json(z.object({ loved: z.boolean() })) } }, responses: ok(unknownObject) });
path({ method: 'put', path: '/tracks/{id}/rating', summary: 'Set track rating', tags: ['Listening'], security: authed, request: { params: idParams, body: { required: true, content: json(z.object({ rating: z.number().int().min(0).max(5) })) } }, responses: ok(unknownObject) });
path({ method: 'post', path: '/playback/reports', summary: 'Idempotently report playback activity', tags: ['Listening'], security: authed, request: { body: { required: true, content: json(playbackReportSchema) } }, responses: ok(unknownObject) });
path({ method: 'get', path: '/preferences', summary: 'Get listener preferences', tags: ['Listening'], security: authed, responses: ok(schemas.Preferences) });
path({ method: 'patch', path: '/preferences', summary: 'Update listener preferences', tags: ['Listening'], security: authed, request: { body: { required: true, content: json(listenerPreferencesSchema.partial()) } }, responses: ok(schemas.Preferences) });
path({ method: 'post', path: '/tracks/{id}/playback', summary: 'Resolve playback sources and loudness', tags: ['Playback'], security: authed, request: { params: idParams, body: { required: true, content: json(playbackDescriptorRequestSchema) } }, responses: ok(schemas.PlaybackDescriptor) });

path({ method: 'get', path: '/playback-sessions', summary: 'List durable playback sessions', tags: ['Sessions'], security: authed, responses: ok(z.array(schemas.PlaybackSession)) });
path({ method: 'post', path: '/playback-sessions', summary: 'Create a playback session owned by this client', tags: ['Sessions'], security: authed, request: { body: { required: true, content: json(playbackSessionCreateSchema) } }, responses: created(schemas.PlaybackSession) });
path({ method: 'get', path: '/playback-sessions/{id}', summary: 'Get a playback session', tags: ['Sessions'], security: authed, request: { params: idParams }, responses: ok(schemas.PlaybackSession) });
path({ method: 'patch', path: '/playback-sessions/{id}', summary: 'Apply optimistic queue or transport changes', tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: true, content: json(playbackSessionPatchSchema) } }, responses: ok(schemas.PlaybackSession) });
path({ method: 'post', path: '/playback-sessions/{id}/handoff', summary: 'Explicitly transfer session ownership', tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: true, content: json(z.object({ expectedRevision: z.number().int().positive() })) } }, responses: ok(schemas.PlaybackSession) });
path({ method: 'delete', path: '/playback-sessions/{id}', summary: 'Delete an owned playback session at an expected revision', tags: ['Sessions'], security: authed, request: { params: idParams, body: { required: true, content: json(playbackSessionDeleteSchema) } }, responses: noContent() });
path({
  method: 'get', path: '/events', summary: 'Subscribe to listener-scoped server events', tags: ['Events'],
  description: 'Use a short-lived sse token in the query string because EventSource cannot set Authorization headers.',
  request: { query: z.object({ token: z.string().optional() }), headers: z.object({ 'last-event-id': z.string().optional() }) }, security: authed,
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
