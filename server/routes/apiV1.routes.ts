import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as mm from 'music-metadata';
import { z, type ZodType } from 'zod';
import {
  addTracksToPlaylist,
  createPlaylist,
  deletePlaylist,
  getAlbumById,
  getAlbumsPage,
  getArtistsPage,
  getAlbumLoudness,
  getArtistById,
  getDiscoverablePlaylistsWithTracks,
  getGenreById,
  getGenresPage,
  getPlaylistByIdForUser,
  getPlaylistByIdReadable,
  getPlaylistMeta,
  getPlaylistSuggestionPool,
  getPlaylistTracks,
  getPlaylists,
  getPlaylistsForUserWithTracks,
  getSystemSetting,
  getTrackLoudnessByIds,
  getTracksByAlbum,
  getTracksByArtist,
  getTracksByGenre,
  getUserSetting,
  initDB,
  recordPlaybackForUser,
  recordSkipForUser,
  searchLibrary,
  setPlaylistShare,
  setTrackLovedForUser,
  setTrackRatingForUser,
  setUserSetting,
  togglePlaylistPin,
  togglePlaylistPrivacy,
  updatePlaylistMeta,
  PlaylistTracksUnavailableError,
} from '../database';
import { isPathAllowed, pathToBuffer, addToSessionHistory, getSessionHistory } from '../state';
import { calculateNextInfinityTrack, getHubCollections } from '../services/recommendation.service';
import { generateCustomPlaylist } from '../services/llm.service';
import { getLlmPlaylistSettings, queueLlmHubRefreshForUser } from '../services/hubRefresh.service';
import {
  computeSmartHubBundle,
  evaluateArtistRadioEligibility,
  generateArtistRadio,
} from '../services/smartHub.service';
import { createRateLimiter } from '../middleware/rateLimit';
import {
  apiV1RequestContext,
  requireApiV1Auth,
  requireApiV1WebSession,
  sendApiV1Error,
} from '../middleware/apiV1Auth';
import {
  appKeyCreateSchema,
  listenerPreferencesSchema,
  pairingExchangeSchema,
  pairingRequestSchema,
  playbackDescriptorRequestSchema,
  playbackReportSchema,
  playbackSessionCreateSchema,
  playbackSessionDeleteSchema,
  playbackSessionPatchSchema,
  OPAQUE_ID,
} from '../../shared/api/v1';
import {
  approvePairingRequest,
  cancelPairingRequest,
  createAuroraAppKey,
  createPairingRequest,
  deleteRevokedAuroraAppKey,
  exchangePairingRequest,
  getPairingRequestForApproval,
  listAuroraAppKeys,
  revokeAuroraAppKey,
  rotateAuroraAppKey,
} from '../services/auroraAppAuth.service';
import {
  getApiV1TrackById,
  getApiV1TracksByIds,
  getLibraryRevision,
  mapAlbumSummaryV1,
  mapArtistSummaryV1,
  mapGenreV1,
  mapPlaylistV1,
  mapTrackV1,
  mediaEtagForTrack,
} from '../services/apiV1Dto.service';
import {
  createPlaybackSession,
  deletePlaybackSession,
  getPlaybackSession,
  handoffPlaybackSession,
  listPlaybackSessions,
  patchPlaybackSession,
  PlaybackSessionNotFoundError,
  PlaybackSessionOwnershipError,
  PlaybackSessionRevisionError,
  PlaybackSessionTrackError,
} from '../services/playbackSession.service';
import { publishApiV1Event, replayApiV1Events, subscribeApiV1Events } from '../services/apiV1Events.service';
import { generateEphemeralScopedToken, verifyScopedToken } from '../services/scopedToken.service';
import { generateAuroraApiDocument } from '../api/v1/openapi';
import { artCachePath, DEFAULT_ART_SIZE, isValidArtSize } from '../services/artCache';

const router = Router();
const startedAt = new Date().toISOString();
const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
const SERVER_VERSION = packageJson.version || 'unknown';
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', aiff: 'audio/aiff', wma: 'audio/x-ms-wma',
};
const OPENAPI_DOCUMENT = generateAuroraApiDocument();

router.use(apiV1RequestContext);

const publicLimiter = createRateLimiter({ keyPrefix: 'api-v1-public', windowMs: 60_000, max: 120 });
const pairingRequestLimiter = createRateLimiter({ keyPrefix: 'api-v1-pairing-request', windowMs: 15 * 60_000, max: 30 });
// A request lives for ten minutes and clients are instructed to poll every
// three seconds (200 polls). Give each pairing request its own full-lifetime
// budget, with a separate high IP ceiling to retain public-endpoint abuse
// protection without unrelated clients consuming one another's quota.
const pairingExchangeIpLimiter = createRateLimiter({ keyPrefix: 'api-v1-pairing-exchange-ip', windowMs: 10 * 60_000, max: 1200 });
const pairingExchangeLimiter = createRateLimiter({
  keyPrefix: 'api-v1-pairing-exchange',
  windowMs: 10 * 60_000,
  max: 240,
  keyGenerator: (req) => typeof req.body?.requestId === 'string' ? `request:${req.body.requestId}` : 'invalid-request',
});
const listenerLimiter = createRateLimiter({ keyPrefix: 'api-v1-listener', windowMs: 60_000, max: 1200 });
// Media streaming is registered before the router-wide listener limiter, so it
// needs its own. Range requests make it the highest-frequency endpoint here, and
// its own bucket stops a heavy stream from consuming a client's API quota.
const mediaLimiter = createRateLimiter({ keyPrefix: 'api-v1-media', windowMs: 60_000, max: 1800 });

function parseBody<T>(schema: ZodType<T>, req: Request, res: Response): T | null {
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    sendApiV1Error(req, res, 400, 'VALIDATION_FAILED', 'The request payload is invalid.', parsed.error.flatten());
    return null;
  }
  return parsed.data;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
}

function dataResponse(req: Request, res: Response, data: unknown, status = 200) {
  return res.status(status).json({ data, meta: { requestId: req.requestId } });
}

type EntityCursor = { sort: string; id: string };

function pageCursor(cursor: EntityCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodePageCursor(raw: unknown): EntityCursor | null | false {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length > 1024) return false;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { sort?: unknown; id?: unknown };
    return typeof parsed.sort === 'string' && typeof parsed.id === 'string' && parsed.id.length > 0
      ? { sort: parsed.sort, id: parsed.id }
      : false;
  } catch {
    return false;
  }
}

function paginationRequest(req: Request) {
  const after = decodePageCursor(req.query.cursor);
  if (after === false) return null;
  const requested = typeof req.query.limit === 'string' ? Number(req.query.limit) : LIST_DEFAULT;
  const limit = Math.min(LIST_MAX, Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : LIST_DEFAULT));
  return { after, limit };
}

function databasePage<T extends { id: unknown }>(values: T[], limit: number, sortValue: (value: T) => string) {
  const hasMore = values.length > limit;
  const items = hasMore ? values.slice(0, limit) : values;
  const last = items.at(-1);
  return {
    items,
    page: {
      nextCursor: hasMore && last ? pageCursor({ sort: sortValue(last), id: String(last.id) }) : null,
    },
  };
}

function stripServerFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripServerFields);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(path|decoded_path|password_hash|key_hash)$/i.test(key) || /secret|accessToken|refreshToken/i.test(key)) continue;
    result[key] = stripServerFields(child);
  }
  return result;
}

async function hydrateTrackContainers(value: unknown, userId: string): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => hydrateTrackContainers(item, userId)));
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (/^(path|decoded_path|password_hash|key_hash)$/i.test(key) || /secret|accessToken|refreshToken/i.test(key)) continue;
    if (key === 'tracks' && Array.isArray(child)) {
      result.tracks = await getApiV1TracksByIds(userId, child.map((track: any) => String(track?.id || '')).filter(Boolean));
    } else if (key === 'track' && child && typeof child === 'object' && (child as any).id) {
      result.track = await getApiV1TrackById(userId, String((child as any).id));
    } else {
      result[key] = await hydrateTrackContainers(child, userId);
    }
  }
  return result;
}

function webVerificationUri(req: Request, userCode: string) {
  return `${req.protocol}://${req.get('host')}/pair?code=${encodeURIComponent(userCode)}`;
}

// Public server discovery and pairing bootstrap.
router.get('/openapi.json', publicLimiter, (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(OPENAPI_DOCUMENT);
});

router.get('/meta', publicLimiter, async (req, res) => {
  dataResponse(req, res, {
    name: 'Aurora',
    serverVersion: SERVER_VERSION,
    apiVersion: '1.0',
    openApiUrl: '/api/v1/openapi.json',
    startedAt,
    libraryRevision: await getLibraryRevision(),
    authentication: ['auroraAppKey', 'auroraWebSession'],
    capabilities: {
      library: true,
      search: true,
      hub: true,
      playlists: true,
      playbackSessions: true,
      eventStream: true,
      offlineDownloads: false,
      desktopCast: false,
    },
  });
});

router.post('/pairing/requests', pairingRequestLimiter, async (req, res) => {
  const input = parseBody(pairingRequestSchema, req, res);
  if (!input) return;
  try {
    const request = await createPairingRequest(input);
    dataResponse(req, res, { ...request, verificationUri: webVerificationUri(req, request.userCode) }, 201);
  } catch (error) {
    console.error('[API v1] pairing request error:', error);
    sendApiV1Error(req, res, 500, 'PAIRING_REQUEST_FAILED', 'Could not start device pairing.');
  }
});

router.post('/pairing/exchange', pairingExchangeIpLimiter, pairingExchangeLimiter, async (req, res) => {
  const input = parseBody(pairingExchangeSchema, req, res);
  if (!input) return;
  try {
    const result = await exchangePairingRequest(input);
    if (result.status === 'pending') return dataResponse(req, res, { status: 'pending' }, 202);
    if (result.status === 'expired') return sendApiV1Error(req, res, 410, 'PAIRING_EXPIRED', 'The pairing request has expired.');
    if (result.status === 'cancelled') return sendApiV1Error(req, res, 410, 'PAIRING_CANCELLED', 'The pairing request was cancelled.');
    if (result.status === 'invalid') return sendApiV1Error(req, res, 401, 'PAIRING_INVALID', 'The pairing request is invalid.');
    if (result.status === 'ok') {
      return dataResponse(req, res, { status: 'authorized', key: result.key, client: result.record });
    }
    return sendApiV1Error(req, res, 409, 'PAIRING_NOT_READY', 'The pairing request is not ready to exchange.');
  } catch (error) {
    console.error('[API v1] pairing exchange error:', error);
    sendApiV1Error(req, res, 500, 'PAIRING_EXCHANGE_FAILED', 'Could not complete device pairing.');
  }
});

async function authenticateMediaRequest(req: Request, res: Response): Promise<boolean> {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const payload = token ? await verifyScopedToken(token, 'media') : null;
  if (!payload) {
    sendApiV1Error(req, res, 401, 'INVALID_MEDIA_TOKEN', 'The media token is invalid or expired.');
    return false;
  }
  req.user = payload;
  return true;
}

// URL-safe direct stream, addressed by track ID rather than a server path.
router.get('/media/tracks/:id', mediaLimiter, async (req, res) => {
  if (!(await authenticateMediaRequest(req, res))) return;
  try {
    const db = await initDB();
    const result = await db.query('SELECT id, path, file_mtime, file_size, format FROM tracks WHERE id = $1', [req.params.id]);
    const row = result.rows[0];
    if (!row) return sendApiV1Error(req, res, 404, 'TRACK_NOT_FOUND', 'Track not found.');
    const file = pathToBuffer(row.path);
    if (!fs.existsSync(file) || !(await isPathAllowed(file))) {
      return sendApiV1Error(req, res, 404, 'MEDIA_NOT_FOUND', 'The track media is unavailable.');
    }
    const stat = fs.statSync(file);
    const etag = mediaEtagForTrack({ ...row, file_mtime: stat.mtimeMs, file_size: stat.size });
    if (etag) res.setHeader('ETag', etag);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    const ext = path.extname(file.toString('utf8')).slice(1).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const range = req.headers.range;
    if (!range && etag && req.headers['if-none-match'] === etag) return res.status(304).end();
    if (!range) {
      res.status(200).setHeader('Content-Length', stat.size);
      res.setHeader('Content-Type', mime);
      fs.createReadStream(file).pipe(res);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
    const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
    const start = suffixLength === null ? Number(match[1]) : Math.max(0, stat.size - suffixLength);
    const end = suffixLength === null && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
      return res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    res.setHeader('Content-Type', mime);
    fs.createReadStream(file, { start, end }).pipe(res);
  } catch (error) {
    console.error('[API v1] media stream error:', error);
    if (!res.headersSent) sendApiV1Error(req, res, 500, 'MEDIA_FAILED', 'The media stream could not be opened.');
  }
});

router.use(requireApiV1Auth, listenerLimiter);

router.get('/artwork/:hash', (req, res) => {
  const hash = routeParam(req, 'hash');
  if (!/^[0-9a-f]{1,64}$/.test(hash)) return sendApiV1Error(req, res, 400, 'INVALID_ARTWORK_ID', 'The artwork ID is invalid.');
  const requestedSize = typeof req.query.size === 'string' ? Number(req.query.size) : DEFAULT_ART_SIZE;
  const size = isValidArtSize(requestedSize) ? requestedSize : DEFAULT_ART_SIZE;
  const file = artCachePath(hash, size);
  try {
    const stat = fs.statSync(file);
    if (stat.size <= 0) throw new Error('empty artwork');
    res.setHeader('Content-Type', 'image/avif');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(file).pipe(res);
  } catch {
    sendApiV1Error(req, res, 404, 'ARTWORK_NOT_FOUND', 'Artwork not found.');
  }
});

router.get('/me', (req, res) => dataResponse(req, res, {
  user: { id: req.apiV1!.userId, username: req.apiV1!.username, role: req.apiV1!.role },
  client: { id: req.apiV1!.clientId, name: req.apiV1!.clientName, authKind: req.apiV1!.authKind, scope: 'listener' },
}));

// App-key lifecycle is intentionally restricted to a normal web session.
router.get('/app-keys', requireApiV1WebSession, async (req, res) => {
  dataResponse(req, res, await listAuroraAppKeys(req.apiV1!.userId));
});

router.post('/app-keys', requireApiV1WebSession, async (req, res) => {
  const input = parseBody(appKeyCreateSchema, req, res);
  if (!input) return;
  const created = await createAuroraAppKey(req.apiV1!.userId, input.name, input.platform);
  dataResponse(req, res, { key: created.key, client: created.record }, 201);
});

router.post('/app-keys/:id/rotate', requireApiV1WebSession, async (req, res) => {
  const rotated = await rotateAuroraAppKey(req.apiV1!.userId, routeParam(req, 'id'));
  if (!rotated) return sendApiV1Error(req, res, 404, 'APP_KEY_NOT_FOUND', 'Active app key not found.');
  dataResponse(req, res, { key: rotated.key, clientId: rotated.clientId });
});

router.delete('/app-keys/:id', requireApiV1WebSession, async (req, res) => {
  const keys = await listAuroraAppKeys(req.apiV1!.userId);
  const record = keys.find((key) => key.id === routeParam(req, 'id'));
  if (!record) return sendApiV1Error(req, res, 404, 'APP_KEY_NOT_FOUND', 'App key not found.');
  const changed = record.revokedAt
    ? await deleteRevokedAuroraAppKey(req.apiV1!.userId, routeParam(req, 'id'))
    : await revokeAuroraAppKey(req.apiV1!.userId, routeParam(req, 'id'));
  if (!changed) return sendApiV1Error(req, res, 404, 'APP_KEY_NOT_FOUND', 'App key not found.');
  dataResponse(req, res, { status: record.revokedAt ? 'deleted' : 'revoked' });
});

router.get('/pairing/requests/:code', requireApiV1WebSession, async (req, res) => {
  const request = await getPairingRequestForApproval(routeParam(req, 'code'));
  if (!request) return sendApiV1Error(req, res, 404, 'PAIRING_NOT_FOUND', 'Pairing request not found.');
  dataResponse(req, res, request);
});

router.post('/pairing/requests/:code/approve', requireApiV1WebSession, async (req, res) => {
  const approved = await approvePairingRequest(req.apiV1!.userId, routeParam(req, 'code'));
  if (!approved) return sendApiV1Error(req, res, 409, 'PAIRING_NOT_PENDING', 'The pairing request is expired or no longer pending.');
  dataResponse(req, res, { status: 'approved' });
});

router.delete('/pairing/requests/:code', requireApiV1WebSession, async (req, res) => {
  const cancelled = await cancelPairingRequest(req.apiV1!.userId, routeParam(req, 'code'));
  if (!cancelled) return sendApiV1Error(req, res, 404, 'PAIRING_NOT_FOUND', 'Approved pairing request not found.');
  dataResponse(req, res, { status: 'cancelled' });
});

router.post('/auth/scoped-token', async (req, res) => {
  const schema = z.object({ scope: z.enum(['media', 'sse', 'receiver']), expiresIn: z.enum(['5m', '15m', '1h', '12h']).default('15m') }).strict();
  const input = parseBody(schema, req, res);
  if (!input) return;
  const token = await generateEphemeralScopedToken(input.scope, {
    userId: req.apiV1!.userId,
    username: req.apiV1!.username,
    role: req.apiV1!.role,
  }, input.expiresIn);
  const seconds = input.expiresIn === '5m' ? 300
    : input.expiresIn === '1h' ? 3600
    : input.expiresIn === '12h' ? 43200
    : 900;
  dataResponse(req, res, { token, scope: input.scope, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() });
});

router.get('/artists', async (req, res) => {
  const pagination = paginationRequest(req);
  if (!pagination) return sendApiV1Error(req, res, 400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
  const rows = await getArtistsPage({ limit: pagination.limit + 1, after: pagination.after });
  const page = databasePage(rows, pagination.limit, (row: any) => String(row.name || ''));
  res.json({ data: page.items.map(mapArtistSummaryV1), page: page.page, meta: { requestId: req.requestId } });
});

router.get('/artists/:id', async (req, res) => {
  const artist = await getArtistById(req.params.id);
  if (!artist) return sendApiV1Error(req, res, 404, 'ARTIST_NOT_FOUND', 'Artist not found.');
  const rawTracks = await getTracksByArtist(req.params.id, req.apiV1!.userId);
  const tracks = await getApiV1TracksByIds(req.apiV1!.userId, rawTracks.map((track: any) => String(track.id)));
  dataResponse(req, res, {
    artist: mapArtistSummaryV1(artist),
    details: stripServerFields({
      bio: artist.bio || null,
      disambiguation: artist.disambiguation || null,
      musicBrainzId: artist.mbid || null,
      links: artist.links || null,
      lifeSpanEnd: artist.lifespan_end || null,
    }),
    tracks,
  });
});

router.get('/albums', async (req, res) => {
  const pagination = paginationRequest(req);
  if (!pagination) return sendApiV1Error(req, res, 400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
  const rows = await getAlbumsPage({ limit: pagination.limit + 1, after: pagination.after });
  const page = databasePage(rows, pagination.limit, (row: any) => String(row.title || ''));
  res.json({ data: page.items.map(mapAlbumSummaryV1), page: page.page, meta: { requestId: req.requestId } });
});

router.get('/albums/:id', async (req, res) => {
  const album = await getAlbumById(req.params.id);
  if (!album) return sendApiV1Error(req, res, 404, 'ALBUM_NOT_FOUND', 'Album not found.');
  const rawTracks = await getTracksByAlbum(req.params.id, req.apiV1!.userId);
  const tracks = await getApiV1TracksByIds(req.apiV1!.userId, rawTracks.map((track: any) => String(track.id)));
  dataResponse(req, res, {
    album: mapAlbumSummaryV1(album),
    details: stripServerFields({
      description: album.description || null,
      tags: album.tags || null,
      musicBrainzId: album.mbid || album.mb_release_group_id || null,
      editionLabel: album.edition_label || null,
    }),
    tracks,
  });
});

router.get('/genres', async (req, res) => {
  const pagination = paginationRequest(req);
  if (!pagination) return sendApiV1Error(req, res, 400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
  const rows = await getGenresPage({ limit: pagination.limit + 1, after: pagination.after });
  const page = databasePage(rows, pagination.limit, (row: any) => String(row.name || ''));
  res.json({ data: page.items.map(mapGenreV1), page: page.page, meta: { requestId: req.requestId } });
});

router.get('/genres/:id', async (req, res) => {
  const genre = await getGenreById(req.params.id);
  if (!genre) return sendApiV1Error(req, res, 404, 'GENRE_NOT_FOUND', 'Genre not found.');
  const rawTracks = await getTracksByGenre(req.params.id, genre.name, req.apiV1!.userId);
  const tracks = await getApiV1TracksByIds(req.apiV1!.userId, rawTracks.map((track: any) => String(track.id)));
  dataResponse(req, res, { genre: mapGenreV1(genre), tracks });
});

router.get('/tracks/:id', async (req, res) => {
  const track = await getApiV1TrackById(req.apiV1!.userId, req.params.id);
  if (!track) return sendApiV1Error(req, res, 404, 'TRACK_NOT_FOUND', 'Track not found.');
  dataResponse(req, res, track);
});

router.get('/tracks/:id/lyrics', async (req, res) => {
  const id = routeParam(req, 'id');
  const db = await initDB();
  const result = await db.query('SELECT id, path FROM tracks WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row) return sendApiV1Error(req, res, 404, 'TRACK_NOT_FOUND', 'Track not found.');
  const file = pathToBuffer(row.path);
  if (!fs.existsSync(file) || !(await isPathAllowed(file))) {
    return sendApiV1Error(req, res, 404, 'MEDIA_NOT_FOUND', 'The track media is unavailable.');
  }
  try {
    const metadata = await mm.parseFile(file.toString('utf8'), { duration: false });
    const tags = (metadata.common.lyrics || []) as any[];
    const documents = tags.flatMap((tag: any) => {
      const language = typeof tag?.language === 'string' && /^[a-z]{2,3}$/i.test(tag.language)
        ? tag.language.toLowerCase()
        : 'und';
      if (Array.isArray(tag?.syncText) && tag.syncText.length > 0) {
        return [{
          language,
          synced: true,
          lines: tag.syncText.map((line: any) => ({
            startMs: Math.max(0, Math.round(Number(line?.timestamp) || 0)),
            text: String(line?.text ?? ''),
          })),
        }];
      }
      if (tag?.text && String(tag.text).trim()) {
        return [{
          language,
          synced: false,
          lines: String(tag.text).replace(/\r\n?/g, '\n').split('\n').map((text: string) => ({ text })),
        }];
      }
      return [];
    });
    dataResponse(req, res, { trackId: id, documents });
  } catch (error) {
    console.warn('[API v1] embedded lyrics read failed:', error instanceof Error ? error.message : error);
    dataResponse(req, res, { trackId: id, documents: [] });
  }
});

router.get('/search', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) return dataResponse(req, res, { artists: [], albums: [], tracks: [] });
  const requestedLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 50));
  const result = await searchLibrary(query, req.apiV1!.userId, { artistLimit: limit, albumLimit: limit, trackLimit: limit });
  dataResponse(req, res, {
    artists: result.artists.map(mapArtistSummaryV1),
    albums: result.albums.map(mapAlbumSummaryV1),
    tracks: await getApiV1TracksByIds(req.apiV1!.userId, result.tracks.map((track: any) => String(track.id))),
  });
});

router.get('/playlists', async (req, res) => {
  const playlists = await getPlaylistsForUserWithTracks(req.apiV1!.userId);
  const trackIds = playlists.flatMap((playlist: any) => (playlist.tracks || []).map((track: any) => String(track.id)));
  const tracks = await getApiV1TracksByIds(req.apiV1!.userId, trackIds);
  const byId = new Map(tracks.map(track => [track.id, track]));
  dataResponse(req, res, await Promise.all(playlists.map((playlist: any) => mapPlaylistV1(playlist, req.apiV1!.userId, byId))));
});

router.get('/playlists/discover', async (req, res) => {
  const playlists = await getDiscoverablePlaylistsWithTracks(req.apiV1!.userId);
  const trackIds = playlists.flatMap((playlist: any) => (playlist.tracks || []).map((track: any) => String(track.id)));
  const tracks = await getApiV1TracksByIds(req.apiV1!.userId, trackIds);
  const byId = new Map(tracks.map(track => [track.id, track]));
  dataResponse(req, res, await Promise.all(playlists.map((playlist: any) => mapPlaylistV1(playlist, req.apiV1!.userId, byId))));
});

router.get('/playlists/:id', async (req, res) => {
  const meta = await getPlaylistByIdReadable(req.params.id, req.apiV1!.userId);
  if (!meta) return sendApiV1Error(req, res, 404, 'PLAYLIST_NOT_FOUND', 'Playlist not found.');
  const tracks = await getPlaylistTracks(req.params.id, req.apiV1!.userId);
  dataResponse(req, res, await mapPlaylistV1({ ...meta, tracks }, req.apiV1!.userId));
});

router.get('/playlists/:id/suggestions', async (req, res) => {
  const meta = await getPlaylistByIdForUser(routeParam(req, 'id'), req.apiV1!.userId);
  if (!meta) return sendApiV1Error(req, res, 404, 'PLAYLIST_NOT_FOUND', 'Playlist not found.');
  const raw = await getPlaylistSuggestionPool(req.params.id, req.apiV1!.userId);
  dataResponse(req, res, await getApiV1TracksByIds(req.apiV1!.userId, raw.map((track: any) => String(track.id))));
});

router.post('/playlists', async (req, res) => {
  const schema = z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(2000).nullable().optional() }).strict();
  const input = parseBody(schema, req, res);
  if (!input) return;
  const id = `user_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  await createPlaylist(id, input.title, input.description || null, false, req.apiV1!.userId);
  const meta = await getPlaylistByIdReadable(id, req.apiV1!.userId);
  publishApiV1Event(req.apiV1!.userId, 'playlist.changed', { playlistId: id, action: 'created' });
  dataResponse(req, res, await mapPlaylistV1({ ...meta, tracks: [] }, req.apiV1!.userId), 201);
});

async function ownedEditablePlaylist(req: Request, res: Response) {
  const meta = await getPlaylistByIdForUser(routeParam(req, 'id'), req.apiV1!.userId);
  if (!meta) {
    sendApiV1Error(req, res, 404, 'PLAYLIST_NOT_FOUND', 'Playlist not found.');
    return null;
  }
  if (meta.isSystem || meta.isLlmGenerated) {
    sendApiV1Error(req, res, 403, 'PLAYLIST_READ_ONLY', 'This playlist is read-only.');
    return null;
  }
  return meta;
}

router.put('/playlists/:id/tracks', async (req, res) => {
  const input = parseBody(z.object({ trackIds: z.array(z.string().min(1)).max(10_000) }).strict(), req, res);
  if (!input || !(await ownedEditablePlaylist(req, res))) return;
  try {
    await addTracksToPlaylist(req.params.id, input.trackIds);
  } catch (error) {
    if (error instanceof PlaylistTracksUnavailableError) {
      return sendApiV1Error(req, res, 409, 'TRACKS_UNAVAILABLE', 'One or more playlist tracks are unavailable.', {
        missingIds: error.missingIds,
      });
    }
    throw error;
  }
  const meta = await getPlaylistByIdReadable(req.params.id, req.apiV1!.userId);
  const tracks = await getPlaylistTracks(req.params.id, req.apiV1!.userId);
  publishApiV1Event(req.apiV1!.userId, 'playlist.changed', { playlistId: req.params.id, action: 'tracksReplaced' });
  dataResponse(req, res, await mapPlaylistV1({ ...meta, tracks }, req.apiV1!.userId));
});

router.patch('/playlists/:id', async (req, res) => {
  const input = parseBody(z.object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).nullable().optional() }).strict().refine((value) => Object.keys(value).length > 0), req, res);
  if (!input || !(await ownedEditablePlaylist(req, res))) return;
  await updatePlaylistMeta(req.params.id, req.apiV1!.userId, input);
  const meta = await getPlaylistByIdReadable(req.params.id, req.apiV1!.userId);
  const tracks = await getPlaylistTracks(req.params.id, req.apiV1!.userId);
  publishApiV1Event(req.apiV1!.userId, 'playlist.changed', { playlistId: req.params.id, action: 'updated' });
  dataResponse(req, res, await mapPlaylistV1({ ...meta, tracks }, req.apiV1!.userId));
});

router.patch('/playlists/:id/state', async (req, res) => {
  const input = parseBody(z.object({ pinned: z.boolean().optional(), private: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0), req, res);
  if (!input || !(await ownedEditablePlaylist(req, res))) return;
  if (input.pinned !== undefined) await togglePlaylistPin(req.params.id, req.apiV1!.userId, input.pinned);
  if (input.private !== undefined) await togglePlaylistPrivacy(req.params.id, req.apiV1!.userId, input.private);
  const meta = await getPlaylistByIdReadable(req.params.id, req.apiV1!.userId);
  const tracks = await getPlaylistTracks(req.params.id, req.apiV1!.userId);
  publishApiV1Event(req.apiV1!.userId, 'playlist.changed', { playlistId: req.params.id, action: 'stateUpdated' });
  dataResponse(req, res, await mapPlaylistV1({ ...meta, tracks }, req.apiV1!.userId));
});

router.post('/playlists/:id/share', async (req, res) => {
  const input = parseBody(z.object({ enabled: z.boolean() }).strict(), req, res);
  if (!input || !(await ownedEditablePlaylist(req, res))) return;
  const result = await setPlaylistShare(req.params.id, req.apiV1!.userId, input.enabled, crypto.randomBytes(18).toString('base64url'));
  if (!result) return sendApiV1Error(req, res, 404, 'PLAYLIST_NOT_FOUND', 'Playlist not found.');
  publishApiV1Event(req.apiV1!.userId, 'playlist.changed', { playlistId: req.params.id, action: 'shareUpdated' });
  dataResponse(req, res, {
    enabled: result.isPublic,
    sharePath: result.isPublic && result.shareToken ? `/share/${result.shareToken}` : null,
  });
});

router.delete('/playlists/:id', async (req, res) => {
  if (!(await ownedEditablePlaylist(req, res))) return;
  await deletePlaylist(req.params.id, req.apiV1!.userId);
  publishApiV1Event(req.apiV1!.userId, 'playlist.changed', { playlistId: req.params.id, action: 'deleted' });
  res.status(204).end();
});

router.get('/hub', async (req, res) => {
  queueLlmHubRefreshForUser(req.apiV1!.userId, 'hub-view');
  const collections = await getHubCollections([], req.apiV1!.userId);
  dataResponse(req, res, await hydrateTrackContainers(collections, req.apiV1!.userId));
});

router.get('/hub/smart', async (req, res) => {
  dataResponse(req, res, await hydrateTrackContainers(await computeSmartHubBundle(req.apiV1!.userId), req.apiV1!.userId));
});

router.post('/hub/artist-radio', async (req, res) => {
  const input = parseBody(z.object({ artistId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() }).strict(), req, res);
  if (!input) return;
  const eligibility = await evaluateArtistRadioEligibility(req.apiV1!.userId, input.artistId);
  if (!eligibility.eligible) return sendApiV1Error(req, res, 409, 'ARTIST_RADIO_UNAVAILABLE', eligibility.reason || 'Artist radio is unavailable.');
  const generated = await generateArtistRadio(req.apiV1!.userId, input.artistId, { forceRefresh: true, limit: input.limit });
  const meta = await getPlaylistByIdReadable(generated.id, req.apiV1!.userId);
  const tracks = await getPlaylistTracks(generated.id, req.apiV1!.userId);
  publishApiV1Event(req.apiV1!.userId, 'playlist.changed', { playlistId: generated.id, action: 'generated' });
  dataResponse(req, res, await mapPlaylistV1({ ...meta, tracks }, req.apiV1!.userId));
});

router.post('/hub/custom', async (req, res) => {
  const input = parseBody(z.object({ prompt: z.string().trim().min(1).max(1000), count: z.number().int().min(1).max(100).optional() }).strict(), req, res);
  if (!input) return;
  const concept = await generateCustomPlaylist(input.prompt);
  if (!concept) return sendApiV1Error(req, res, 503, 'CUSTOM_PLAYLIST_FAILED', 'Aurora could not create a playlist for that prompt.');
  const existing = new Set((await getPlaylists(req.apiV1!.userId)).map((playlist: any) => playlist.id));
  const settings = await getLlmPlaylistSettings(req.apiV1!.userId);
  const saved = await getHubCollections([concept], req.apiV1!.userId, {
    ...settings,
    ...(input.count ? { llmTracksPerPlaylist: input.count } : {}),
    llmGenerationSource: 'custom',
  });
  const playlist = saved.find((candidate: any) => candidate.id && !existing.has(candidate.id));
  if (!playlist) return sendApiV1Error(req, res, 503, 'CUSTOM_PLAYLIST_FAILED', 'Aurora could not match that prompt to the library.');
  const meta = await getPlaylistByIdReadable(playlist.id, req.apiV1!.userId);
  const tracks = await getPlaylistTracks(playlist.id, req.apiV1!.userId);
  publishApiV1Event(req.apiV1!.userId, 'playlist.changed', { playlistId: playlist.id, action: 'generated' });
  dataResponse(req, res, await mapPlaylistV1({ ...meta, tracks }, req.apiV1!.userId), 201);
});

// The engine reads these from the settings object it is handed. A browser has
// them in its store; a headless client — the Cast receiver — has no access to
// the sliders at all, so the server resolves them itself. Anything the caller
// does provide still wins, which keeps the web client's behaviour identical.
const INFINITY_SETTING_KEYS = ['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit'] as const;

async function resolveInfinitySettings(userId: string, provided: Record<string, unknown>) {
  const resolved: Record<string, unknown> = {};
  for (const key of INFINITY_SETTING_KEYS) {
    const value = await getUserSetting(userId, key);
    if (value !== null && value !== undefined) resolved[key] = value;
  }
  return { ...resolved, ...provided };
}

router.post('/recommendations/next', async (req, res) => {
  const input = parseBody(z.object({
    settings: z.record(z.string(), z.unknown()).default({}),
    // What the caller already has queued but unheard. Server-side history only
    // advances on threshold-gated playback reports, so without this a client
    // topping up several tracks ahead is handed the same track repeatedly.
    exclude: z.array(OPAQUE_ID).max(200).optional(),
  }).strict(), req, res);
  if (!input) return;
  const settings = await resolveInfinitySettings(req.apiV1!.userId, input.settings);
  const track = await calculateNextInfinityTrack(
    getSessionHistory(req.apiV1!.userId),
    settings,
    { excludeTrackIds: input.exclude ?? [] },
  );
  dataResponse(req, res, track ? await getApiV1TrackById(req.apiV1!.userId, String((track as any).id)) : null);
});

router.put('/tracks/:id/loved', async (req, res) => {
  const input = parseBody(z.object({ loved: z.boolean() }).strict(), req, res);
  if (!input) return;
  const track = await getApiV1TrackById(req.apiV1!.userId, req.params.id);
  if (!track) return sendApiV1Error(req, res, 404, 'TRACK_NOT_FOUND', 'Track not found.');
  await setTrackLovedForUser(req.apiV1!.userId, req.params.id, input.loved);
  publishApiV1Event(req.apiV1!.userId, 'annotation.changed', { trackId: req.params.id, loved: input.loved });
  dataResponse(req, res, { trackId: req.params.id, loved: input.loved });
});

router.put('/tracks/:id/rating', async (req, res) => {
  const input = parseBody(z.object({ rating: z.number().int().min(0).max(5) }).strict(), req, res);
  if (!input) return;
  const track = await getApiV1TrackById(req.apiV1!.userId, req.params.id);
  if (!track) return sendApiV1Error(req, res, 404, 'TRACK_NOT_FOUND', 'Track not found.');
  await setTrackRatingForUser(req.apiV1!.userId, req.params.id, input.rating);
  publishApiV1Event(req.apiV1!.userId, 'annotation.changed', { trackId: req.params.id, rating: input.rating });
  dataResponse(req, res, { trackId: req.params.id, rating: input.rating });
});

router.post('/playback/reports', async (req, res) => {
  const input = parseBody(playbackReportSchema, req, res);
  if (!input) return;
  if (!(await getApiV1TrackById(req.apiV1!.userId, input.trackId))) {
    return sendApiV1Error(req, res, 404, 'TRACK_NOT_FOUND', 'Track not found.');
  }
  const db = await initDB();
  const inserted = await db.query(`
    INSERT INTO api_playback_events (event_id, user_id, track_id, kind, occurred_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `, [input.eventId, req.apiV1!.userId, input.trackId, input.kind, input.occurredAt || new Date().toISOString()]);
  if ((inserted.rowCount || 0) > 0) {
    try {
      if (input.kind === 'played') await recordPlaybackForUser(req.apiV1!.userId, input.trackId, input.occurredAt ? new Date(input.occurredAt) : undefined);
      if (input.kind === 'skipped') await recordSkipForUser(req.apiV1!.userId, input.trackId);
      if (input.kind !== 'skipped') addToSessionHistory(req.apiV1!.userId, input.trackId);
    } catch (error) {
      // Let a client safely retry if the actual playback-state write failed
      // after reserving its idempotency key.
      await db.query('DELETE FROM api_playback_events WHERE event_id = $1 AND user_id = $2', [input.eventId, req.apiV1!.userId]);
      throw error;
    }
  }
  dataResponse(req, res, { status: (inserted.rowCount || 0) > 0 ? 'recorded' : 'duplicate' });
});

const preferenceDefaults = {
  streamingQuality: 'auto', prebufferPolicy: 'conservative', playedThresholdPercent: 50,
  loudnessNormEnabled: false, loudnessTargetLufs: -18, loudnessPreampDb: 0,
  loudnessMode: 'track', subsonicProviderScrobbleEnabled: false,
} as const;

router.get('/preferences', async (req, res) => {
  const result: Record<string, unknown> = { ...preferenceDefaults };
  for (const key of Object.keys(preferenceDefaults)) {
    const value = await getUserSetting(req.apiV1!.userId, key);
    if (value !== null) result[key] = value;
  }
  dataResponse(req, res, listenerPreferencesSchema.parse(result));
});

router.patch('/preferences', async (req, res) => {
  const input = parseBody(listenerPreferencesSchema.partial().strict().refine((value) => Object.keys(value).length > 0), req, res);
  if (!input) return;
  await Promise.all(Object.entries(input).map(([key, value]) => setUserSetting(req.apiV1!.userId, key, value)));
  const result: Record<string, unknown> = { ...preferenceDefaults };
  for (const key of Object.keys(preferenceDefaults)) {
    const value = await getUserSetting(req.apiV1!.userId, key);
    if (value !== null) result[key] = value;
  }
  dataResponse(req, res, listenerPreferencesSchema.parse(result));
});

router.post('/tracks/:id/playback', async (req, res) => {
  const input = parseBody(playbackDescriptorRequestSchema, req, res);
  if (!input) return;
  const track = await getApiV1TrackById(req.apiV1!.userId, req.params.id);
  if (!track) return sendApiV1Error(req, res, 404, 'TRACK_NOT_FOUND', 'Track not found.');
  const db = await initDB();
  const mediaResult = await db.query('SELECT id, path FROM tracks WHERE id = $1', [req.params.id]);
  const mediaFile = mediaResult.rows[0]?.path ? pathToBuffer(mediaResult.rows[0].path) : null;
  if (!mediaFile || !fs.existsSync(mediaFile) || !(await isPathAllowed(mediaFile))) {
    return sendApiV1Error(req, res, 404, 'MEDIA_NOT_FOUND', 'The track media is unavailable.');
  }
  const mediaStat = fs.statSync(mediaFile);
  const mediaEtag = mediaEtagForTrack({ id: track.id, file_mtime: mediaStat.mtimeMs, file_size: mediaStat.size });
  const mediaExtension = path.extname(mediaFile.toString('utf8')).slice(1).toLowerCase();
  const directMimeType = MIME_TYPES[mediaExtension] || 'application/octet-stream';
  const directCodecAccepted = input.capabilities.codecs.length === 0
    || input.capabilities.codecs.some(codec => codec.toLowerCase() === directMimeType || codec.toLowerCase() === mediaExtension);
  const token = await generateEphemeralScopedToken('media', {
    userId: req.apiV1!.userId,
    username: req.apiV1!.username,
    role: req.apiV1!.role,
  }, '15m');
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const quality = input.quality;
  const sources: Array<{ kind: 'hls' | 'direct'; url: string; mimeType: string; quality: string; expiresAt: string }> = [];
  if (input.capabilities.hls) {
    sources.push({
      kind: 'hls',
      url: `/api/stream/${encodeURIComponent(track.id)}/playlist.m3u8?quality=${encodeURIComponent(quality)}&token=${encodeURIComponent(token)}`,
      mimeType: 'application/vnd.apple.mpegurl',
      quality,
      expiresAt,
    });
  }
  if (input.capabilities.directPlay && directCodecAccepted && quality === 'source' && mediaExtension !== 'wma') {
    sources.push({
      kind: 'direct',
      url: `/api/v1/media/tracks/${encodeURIComponent(track.id)}?token=${encodeURIComponent(token)}`,
      mimeType: directMimeType,
      quality: 'source',
      expiresAt,
    });
  }
  if (sources.length === 0) return sendApiV1Error(req, res, 406, 'NO_PLAYABLE_SOURCE', 'No compatible playback source is available.');
  const [trackLoudness, albumLoudness] = await Promise.all([
    getTrackLoudnessByIds([track.id]),
    track.albumId ? getAlbumLoudness(track.albumId) : Promise.resolve(null),
  ]);
  const loudness = trackLoudness[0] || null;
  dataResponse(req, res, {
    track,
    sources,
    loudness: {
      trackLufs: loudness ? loudness.loudness_lufs : null,
      albumLufs: albumLoudness?.lufs ?? null,
      truePeakDbfs: loudness?.true_peak_dbfs ?? null,
    },
    byteLength: mediaStat.size,
    etag: mediaEtag,
    acceptRanges: true,
  });
});

router.get('/playback-sessions', async (req, res) => dataResponse(req, res, await listPlaybackSessions(req.apiV1!.userId)));

router.post('/playback-sessions', async (req, res) => {
  const input = parseBody(playbackSessionCreateSchema, req, res);
  if (!input) return;
  try {
    dataResponse(req, res, await createPlaybackSession({
      userId: req.apiV1!.userId,
      clientId: req.apiV1!.clientId,
      ...input,
      source: input.source || null,
    }), 201);
  } catch (error) {
    handleSessionError(req, res, error);
  }
});

router.get('/playback-sessions/:id', async (req, res) => {
  const session = await getPlaybackSession(req.apiV1!.userId, req.params.id);
  if (!session) return sendApiV1Error(req, res, 404, 'PLAYBACK_SESSION_NOT_FOUND', 'Playback session not found.');
  dataResponse(req, res, session);
});

router.patch('/playback-sessions/:id', async (req, res) => {
  const patch = parseBody(playbackSessionPatchSchema, req, res);
  if (!patch) return;
  try {
    dataResponse(req, res, await patchPlaybackSession({
      userId: req.apiV1!.userId,
      clientId: req.apiV1!.clientId,
      sessionId: req.params.id,
      patch,
    }));
  } catch (error) {
    handleSessionError(req, res, error);
  }
});

router.post('/playback-sessions/:id/handoff', async (req, res) => {
  const input = parseBody(z.object({ expectedRevision: z.number().int().positive() }).strict(), req, res);
  if (!input) return;
  try {
    dataResponse(req, res, await handoffPlaybackSession({
      userId: req.apiV1!.userId,
      clientId: req.apiV1!.clientId,
      sessionId: req.params.id,
      expectedRevision: input.expectedRevision,
    }));
  } catch (error) {
    handleSessionError(req, res, error);
  }
});

router.delete('/playback-sessions/:id', async (req, res) => {
  const input = parseBody(playbackSessionDeleteSchema, req, res);
  if (!input) return;
  try {
    await deletePlaybackSession(req.apiV1!.userId, req.apiV1!.clientId, req.params.id, input.expectedRevision);
    res.status(204).end();
  } catch (error) {
    handleSessionError(req, res, error);
  }
});

function handleSessionError(req: Request, res: Response, error: unknown) {
  if (error instanceof PlaybackSessionNotFoundError) return sendApiV1Error(req, res, 404, 'PLAYBACK_SESSION_NOT_FOUND', 'Playback session not found.');
  if (error instanceof PlaybackSessionOwnershipError) return sendApiV1Error(req, res, 409, 'PLAYBACK_SESSION_NOT_OWNER', 'Take over this playback session before changing it.');
  if (error instanceof PlaybackSessionRevisionError) return sendApiV1Error(req, res, 409, 'REVISION_CONFLICT', 'The playback session changed on another client.', { current: error.current });
  if (error instanceof PlaybackSessionTrackError) return sendApiV1Error(req, res, 409, 'TRACKS_UNAVAILABLE', 'One or more queue tracks are unavailable.', { missingIds: error.missingIds });
  console.error('[API v1] playback session error:', error);
  return sendApiV1Error(req, res, 500, 'PLAYBACK_SESSION_FAILED', 'The playback session could not be updated.');
}

router.get('/events', async (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const write = (event: { id: string; type: string; data: unknown }) => {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const lastEventId = typeof req.headers['last-event-id'] === 'string'
    ? req.headers['last-event-id']
    : typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined;
  const replay = replayApiV1Events(req.apiV1!.userId, lastEventId);
  if (replay === null) {
    write({ id: crypto.randomUUID(), type: 'resync.required', data: { reason: 'eventHistoryUnavailable' } });
  } else {
    replay.forEach(write);
  }
  const unsubscribe = subscribeApiV1Events(req.apiV1!.userId, write);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe();
  });
});

router.use((req, res) => sendApiV1Error(req, res, 404, 'ENDPOINT_NOT_FOUND', 'API endpoint not found.'));

router.use((error: unknown, req: Request, res: Response, _next: unknown) => {
  console.error('[API v1] unhandled error:', error);
  if (!res.headersSent) sendApiV1Error(req, res, 500, 'INTERNAL_ERROR', 'Aurora could not complete the request.');
});

export default router;
