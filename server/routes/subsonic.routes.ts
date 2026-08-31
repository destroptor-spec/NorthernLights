import { Router, Request, Response, NextFunction } from 'express';
import { getTrustedClientIp } from '../middleware/clientIp';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import * as mm from 'music-metadata';
import { spawn } from 'child_process';
import { initDB, touchSubsonicApiKey, getActiveSubsonicApiKeyByPrefix, updateSubsonicApiKeyHash, getPlaylists, getPlaylistTracks, getPlaylistMeta, createPlaylist, addTracksToPlaylist, deletePlaylist, recordPlaybackForUser, setTrackLovedForUser, setTrackRatingForUser, getUserSetting, setUserSetting, getSystemSetting, getArtworkInfoForPath } from '../database';
import { fetchCandidatePool, computeArtistCentroids } from '../services/candidatePool.service';
import { isPathAllowed, pathToBuffer } from '../state';
import { maybeMeasureLoudnessForUser } from '../services/loudness.service';
import { completeVodPlaylist, getOrCreateHlsSession, getSessionInfo, touchSession, getSessionOutputDir, waitForSegmentListed } from '../services/hlsStream.service';
import { generateScopedToken, verifyScopedToken } from '../services/scopedToken.service';
import { writeDebugLog } from '../services/debugLogger.service';
import { logFfmpeg } from '../services/loggingConfig';
import { queueLlmHubRefreshForUser } from '../services/hubRefresh.service';
import { scrobbleTracks as scrobbleLastFmTracks, updateNowPlaying as updateLastFmNowPlaying } from '../services/lastfm.service';
import { scrobbleTracks as scrobbleListenBrainzTracks, updateNowPlaying as updateListenBrainzNowPlaying } from '../services/listenbrainz.service';
import type { LfmTrack } from '../services/lastfm.service';
import type { LbTrack } from '../services/listenbrainz.service';
import { resolveArtwork } from '../services/artCache';
import { providerArtworkProxyPath, resolveProviderArtworkUrl } from '../services/artworkFallback.service';
import { publishApiV1Event } from '../services/apiV1Events.service';

const router = Router();
const SUBSONIC_VERSION = '1.16.1';
const SERVER_VERSION = 'Aurora 1.0.0-rc.3';
const DEFAULT_CLIENT = 'Aurora';
const DEFAULT_HLS_QUALITY = '192';
const DEFAULT_HLS_CODEC = 'aac';
const SUBSONIC_KEY_PREFIX_LENGTH = 18;
const SUBSONIC_KEY_USAGE_TOUCH_MS = 5 * 60 * 1000;
const OPEN_SUBSONIC_ENABLED_CACHE_MS = 2_000;
// Per-user saved play queue (Subsonic getPlayQueue/savePlayQueue + the
// indexBasedQueue extension) is stored as a JSON blob in user_settings.
const PLAYQUEUE_SETTING_KEY = 'subsonic:playqueue';
const EFFNET_SIMILARITY_WEIGHT = 0.55;
const SUBSONIC_PROVIDER_SCROBBLE_SETTING_KEY = 'subsonicProviderScrobbleEnabled';

type SubsonicContext = {
  userId: string;
  username: string;
  role: string;
  keyId: string;
  keyPrefix: string;
  rawKey?: string;
  authKind: 'apiKey' | 'mediaToken';
};

type SubsonicErrorCode = 41 | 42 | 43 | 44 | 50 | 70;
type ProviderScrobbleTrack = LfmTrack & LbTrack;
export type SubsonicScrobbleEvent = {
  rawId: string;
  trackId: string;
  playedAt?: Date;
  timestamp?: number;
};

const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
  aiff: 'audio/aiff',
};

// music-metadata reports a *container* name (e.g. "MPEG", "M4A/mp42/isom",
// "ASF/audio", "WAVE"), not a file extension. Map those — and any real
// extension — to a canonical, slash-free Subsonic suffix that is also a
// MIME_TYPES key, so contentType resolves correctly. Clients such as
// Symfonium treat `suffix` as a filename extension and reject/mis-handle
// values that contain a '/' or are not a recognised codec token.
const FORMAT_TO_SUFFIX: Record<string, string> = {
  mp3: 'mp3', mpeg: 'mp3', mp2: 'mp3',
  flac: 'flac',
  ogg: 'ogg', vorbis: 'ogg', opus: 'opus',
  m4a: 'm4a', mp4: 'm4a', mp42: 'm4a', m4b: 'm4a', isom: 'm4a', alac: 'm4a',
  aac: 'aac', adts: 'aac',
  asf: 'wma', wma: 'wma',
  wav: 'wav', wave: 'wav',
  aiff: 'aiff', aif: 'aiff', aifc: 'aiff',
};

type RateLimitEntry = { count: number; resetAt: number };
const rateLimitBuckets = new Map<string, RateLimitEntry>();
const keyTouchCache = new Map<string, number>();

// OpenSubsonic spec: getOpenSubsonicExtensions advertises which extensions the
// server supports. Crucially it MUST be reachable WITHOUT authentication — it's
// how a client discovers that `apiKeyAuthentication` exists *before* it has any
// way to log in. Aurora is API-key-only (it stores one-way bcrypt password
// hashes, so it can't support Subsonic token/salt auth at all), which means
// apiKey auth is the *only* path a client like Symfonium has. If this endpoint
// requires auth, the client never learns apiKey auth is available, falls back
// to token/password, gets rejected, and the sync never initiates.
export function openSubsonicExtensionsPayload(): Record<string, unknown> {
  return {
    openSubsonicExtensions: {
      extension: [
        { name: 'apiKeyAuthentication', versions: [1] },
        { name: 'formPost', versions: [1] },
        { name: 'songLyrics', versions: [1] },
        { name: 'indexBasedQueue', versions: [1] },
      // Declares that `stream` honours `timeOffset` for music, which is what
      // lets clients seek within a transcoded stream — without it a transcode
      // can only ever be played from the start, since a pipe has no byte space
      // to range-request into.
      { name: 'transcodeOffset', versions: [1] },
      ],
    },
  };
}

// Methods the OpenSubsonic spec requires to be served without authentication.
const PUBLIC_SUBSONIC_METHODS = new Set(['getopensubsonicextensions']);
let openSubsonicEnabledCache = { value: true, expiresAt: 0 };

async function isOpenSubsonicEnabled(): Promise<boolean> {
  const now = Date.now();
  if (openSubsonicEnabledCache.expiresAt > now) return openSubsonicEnabledCache.value;
  const value = (await getSystemSetting('openSubsonicEnabled')) !== false;
  openSubsonicEnabledCache = { value, expiresAt: now + OPEN_SUBSONIC_ENABLED_CACHE_MS };
  return value;
}

const EMPTY_STUB_PAYLOADS: Record<string, Record<string, unknown>> = {
  getpodcasts: { podcasts: { channel: [] } },
  createpodcastchannel: {},
  deletepodcastchannel: {},
  deletepodcastepisode: {},
  downloadpodcastepisode: {},
  refreshpodcasts: {},
  getpodcastepisode: {},
  getnewestpodcasts: { newestPodcasts: { episode: [] } },
  getshares: { shares: { share: [] } },
  createshare: {},
  updateshare: {},
  deleteshare: {},
  getinternetradiostations: { internetRadioStations: { internetRadioStation: [] } },
  createinternetradiostation: {},
  updateinternetradiostation: {},
  deleteinternetradiostation: {},
  getchatmessages: { chatMessages: { chatMessage: [] } },
  addchatmessage: {},
  getbookmarks: { bookmarks: { bookmark: [] } },
  createbookmark: {},
  deletebookmark: {},
  getvideoinfo: { videoInfo: { captions: [] } },
  getvideos: { videos: { video: [] } },
  getcaptions: { captions: { caption: [] } },
  getavatar: {},
  jukeboxcontrol: { jukeboxStatus: { currentIndex: -1, playing: false, gain: 1, position: 0 } },
};

function getParam(req: Request, name: string): string | undefined {
  const source = req.method === 'POST' ? { ...req.query, ...(req.body || {}) } : req.query;
  const value = (source as Record<string, unknown>)[name];
  if (Array.isArray(value)) return value[0] === undefined ? undefined : String(value[0]);
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function getParamList(req: Request, name: string): string[] {
  const source = req.method === 'POST' ? { ...req.query, ...(req.body || {}) } : req.query;
  const value = (source as Record<string, unknown>)[name];
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

function normalizeMethod(raw: string): string {
  return raw.replace(/\.view$/i, '').toLowerCase();
}

// Subsonic "match everything" convention: to enumerate the whole library via
// search3, clients (including Symfonium with compatibility mode OFF) send
// query="" — which arrives as the literal characters "" (or ''). Strip wrapping
// quotes/whitespace; if nothing remains it's an empty (match-all) query, not a
// literal search for quote characters (which matches nothing and makes sync
// return 0 results).
export function normalizeSearchQuery(raw: string | undefined): string {
  return String(raw ?? '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
}

// Diagnostics only — never logs secret values, just which auth params are
// present so we can see what a client (e.g. Symfonium) actually sends.
function clientInfo(req: Request): string {
  return `c=${getParam(req, 'c') || '-'} v=${getParam(req, 'v') || '-'}`;
}

function authParamShape(req: Request): string {
  const present = (...names: string[]) => (names.some((n) => (getParam(req, n) ?? '') !== '') ? 1 : 0);
  return `apiKey=${present('apiKey', 'api_key', 'apikey', 'key')} u=${present('u', 'username')} p=${present('p', 'password')} t=${present('t', 'token')} s=${present('s', 'salt')}`;
}

// CodeQL false positive (js/insufficient-password-hash): a Subsonic API key is a
// 256-bit CSPRNG token (`aurora_sub_` + randomBytes(32), see
// generateSubsonicApiKeySecret in auth.routes.ts), NOT a user-chosen password.
// SHA-256 is the correct, standard storage for high-entropy secrets (cf. GitHub
// PATs / session tokens): the 2^256 keyspace is infeasible to brute-force
// regardless of hash speed, so a slow KDF (bcrypt/argon2) would only add
// per-request latency with no security gain — which is why this replaced the
// legacy bcrypt path. The input merely *looks* like a password to taint tracking.
function hashSubsonicApiKey(apiKey: string): string {
  return `sha256:${crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex')}`; // codeql[js/insufficient-password-hash]
}

// Constant-time string compare to avoid leaking the stored hash byte-by-byte via
// the short-circuit timing of `===`. Mirrors the timingSafeEqual guard in admin.routes.ts.
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

async function verifySubsonicApiKey(apiKey: string, storedHash: string): Promise<{ ok: boolean; upgradedHash?: string }> {
  if (storedHash.startsWith('sha256:')) {
    return { ok: timingSafeStringEqual(hashSubsonicApiKey(apiKey), storedHash) };
  }

  const ok = await bcrypt.compare(apiKey, storedHash);
  return ok ? { ok, upgradedHash: hashSubsonicApiKey(apiKey) } : { ok };
}

async function touchSubsonicKeyDebounced(keyId: string) {
  const now = Date.now();
  const lastTouched = keyTouchCache.get(keyId) || 0;
  if (now - lastTouched < SUBSONIC_KEY_USAGE_TOUCH_MS) return;
  keyTouchCache.set(keyId, now);
  await touchSubsonicApiKey(keyId);
}

function rateLimitKey(req: Request, method: string): string {
  return `${method}:${getTrustedClientIp(req)}`;
}

function writeSubsonicLog(line: string) {
  try {
    writeDebugLog('subsonic-api.log', line);
  } catch {
    // Diagnostics must not affect client sync.
  }
}

function subsonicRateLimiter(req: Request, res: Response, next: NextFunction) {
  const method = normalizeMethod(String(req.params.method || ''));
  const mediaMethods = new Set(['stream', 'download', 'hlssegment']);
  // Library syncs enumerate per-artist/per-album: folder-mode Symfonium can
  // call getMusicDirectory once per artist *and* per album, so a large library
  // legitimately issues many thousands of metadata requests in a burst. The
  // old 300/5min cap caused mid-sync 429s ("errors on tracks").
  const limit = mediaMethods.has(method)
    ? { windowMs: 60 * 1000, max: 900 }
    : { windowMs: 5 * 60 * 1000, max: 12000 };
  const now = Date.now();

  for (const [key, entry] of rateLimitBuckets) {
    if (entry.resetAt <= now) rateLimitBuckets.delete(key);
  }

  const key = rateLimitKey(req, method);
  const existing = rateLimitBuckets.get(key);
  const nextEntry = existing && existing.resetAt > now
    ? { count: existing.count + 1, resetAt: existing.resetAt }
    : { count: 1, resetAt: now + limit.windowMs };

  rateLimitBuckets.set(key, nextEntry);

  if (nextEntry.count > limit.max) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((nextEntry.resetAt - now) / 1000))));
    return sendError(req, res, 50, 'Too many Subsonic API requests. Try again later.', 429);
  }

  next();
}

export function parseSubsonicAuthParams(params: Record<string, unknown>): { apiKey?: string; error?: { code: SubsonicErrorCode; message: string } } {
  const valueOf = (name: string) => {
    const value = params[name];
    if (Array.isArray(value)) return value[0] === undefined ? undefined : String(value[0]);
    return value === undefined || value === null ? undefined : String(value);
  };
  const apiKey = valueOf('apiKey') || valueOf('api_key') || valueOf('apikey') || valueOf('key');
  const hasPasswordAuth = Boolean(valueOf('u') || valueOf('username') || valueOf('p') || valueOf('password'));
  const hasTokenAuth = Boolean(valueOf('t') || valueOf('s') || valueOf('token') || valueOf('salt'));

  if (apiKey && (hasPasswordAuth || hasTokenAuth)) {
    return { error: { code: 43, message: 'Conflicting authentication parameters. Use apiKey only.' } };
  }
  if (hasTokenAuth) {
    return { error: { code: 42, message: 'Token/salt authentication is not supported. Use an Aurora Subsonic API key.' } };
  }
  if (hasPasswordAuth) {
    return { error: { code: 41, message: 'Username/password authentication is not supported. Use an Aurora Subsonic API key.' } };
  }
  if (!apiKey) {
    return { error: { code: 43, message: 'Missing Aurora Subsonic API key.' } };
  }
  return { apiKey };
}

async function authenticateSubsonic(req: Request): Promise<{ ctx?: SubsonicContext; error?: { code: SubsonicErrorCode; message: string } }> {
  const params = req.method === 'POST' ? { ...req.query, ...(req.body || {}) } : req.query;
  const parsed = parseSubsonicAuthParams(params as Record<string, unknown>);
  if (parsed.error) return { error: parsed.error };

  const keyPrefix = parsed.apiKey!.slice(0, SUBSONIC_KEY_PREFIX_LENGTH);
  const key = await getActiveSubsonicApiKeyByPrefix(keyPrefix);
  if (!key) {
    return { error: { code: 44, message: 'Invalid or revoked Aurora Subsonic API key.' } };
  }

  const verified = await verifySubsonicApiKey(parsed.apiKey!, key.key_hash);
  if (!verified.ok) {
    return { error: { code: 44, message: 'Invalid or revoked Aurora Subsonic API key.' } };
  }

  if (verified.upgradedHash) {
    await updateSubsonicApiKeyHash(key.id, verified.upgradedHash);
  }
  await touchSubsonicKeyDebounced(key.id);

  return {
    ctx: {
      userId: key.user_id,
      username: key.username,
      role: key.role,
      keyId: key.id,
      keyPrefix: key.key_prefix,
      rawKey: parsed.apiKey!,
      authKind: 'apiKey',
    },
  };
}

async function authenticateHlsSegment(req: Request): Promise<{ ctx?: SubsonicContext; error?: { code: SubsonicErrorCode; message: string } }> {
  const mediaToken = getParam(req, 'mediaToken');
  if (!mediaToken) return authenticateSubsonic(req);

  const payload = await verifyScopedToken(mediaToken, 'media');
  if (!payload) {
    return { error: { code: 44, message: 'Invalid or expired HLS media token.' } };
  }

  return {
    ctx: {
      userId: payload.userId,
      username: payload.username,
      role: payload.role,
      keyId: 'media-token',
      keyPrefix: 'media-token',
      authKind: 'mediaToken',
    },
  };
}

function baseResponse(status: 'ok' | 'failed') {
  return {
    status,
    version: SUBSONIC_VERSION,
    type: 'aurora',
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
  };
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlAttrs(attrs: Record<string, unknown>): string {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
}

function xmlNode(name: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => xmlNode(name, item)).join('');
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const attrs: Record<string, unknown> = {};
    const children: string[] = [];
    for (const [key, child] of Object.entries(obj)) {
      if (Array.isArray(child) || (child && typeof child === 'object')) {
        children.push(xmlNode(key, child));
      } else {
        attrs[key] = child;
      }
    }
    return `<${name}${xmlAttrs(attrs)}>${children.join('')}</${name}>`;
  }
  return `<${name}>${escapeXml(value)}</${name}>`;
}

export function buildSubsonicXml(payload: Record<string, unknown>): string {
  const response = payload['subsonic-response'] as Record<string, unknown>;
  const attrs: Record<string, unknown> = {};
  const children: string[] = [];
  for (const [key, value] of Object.entries(response)) {
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      children.push(xmlNode(key, value));
    } else {
      attrs[key] = value;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?><subsonic-response xmlns="http://subsonic.org/restapi"${xmlAttrs(attrs)}>${children.join('')}</subsonic-response>`;
}

export function subsonicSuccess(payload: Record<string, unknown> = {}) {
  return { 'subsonic-response': { ...baseResponse('ok'), ...payload } };
}

export function subsonicError(code: SubsonicErrorCode, message: string) {
  return { 'subsonic-response': { ...baseResponse('failed'), error: { code, message } } };
}

function sendSubsonic(req: Request, res: Response, payload: Record<string, unknown>) {
  const format = (getParam(req, 'f') || 'xml').toLowerCase();
  if (format === 'json' || format === 'jsonp') {
    if (format === 'jsonp') {
      const callback = getParam(req, 'callback') || 'callback';
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback)) {
        res.status(400).type('text/plain').send('Invalid JSONP callback');
        return;
      }
      res.type('application/javascript').send(`${callback}(${JSON.stringify(payload)});`);
      return;
    }
    res.json(payload);
    return;
  }
  res.type('application/xml').send(buildSubsonicXml(payload));
}

function sendError(req: Request, res: Response, code: SubsonicErrorCode, message: string, status = 200) {
  res.status(status);
  sendSubsonic(req, res, subsonicError(code, message));
}

function artistId(id: string) { return id.startsWith('artist:') ? id.slice(7) : id; }
function albumId(id: string) { return id.startsWith('album:') ? id.slice(6) : id; }
function encodeSongId(id: string) {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeSongId(id: string) {
  try {
    return Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return id;
  }
}

function songId(id: string) {
  if (id.startsWith('song:v1:')) return decodeSongId(id.slice(8));
  if (id.startsWith('song:')) return id.slice(5);
  return id;
}
function subsonicArtistId(id: string) { return `artist:${id}`; }
function subsonicAlbumId(id: string) { return `album:${id}`; }
function subsonicSongId(id: string) { return `song:v1:${encodeSongId(id)}`; }

function parseSubsonicEpochMillis(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return undefined;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function isSubsonicSubmission(value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  return true;
}

export function buildSubsonicScrobbleEvents(ids: string[], times: string[]): SubsonicScrobbleEvent[] {
  const events: SubsonicScrobbleEvent[] = [];
  ids.forEach((rawId, index) => {
    const cleanedId = String(rawId || '').trim();
    if (!cleanedId) return;
    const playedAt = parseSubsonicEpochMillis(times[index]);
    const event: SubsonicScrobbleEvent = {
      rawId: cleanedId,
      trackId: songId(cleanedId),
    };
    if (playedAt) {
      event.playedAt = playedAt;
      event.timestamp = Math.floor(playedAt.getTime() / 1000);
    }
    events.push(event);
  });
  return events;
}

function settingEnabled(value: unknown): boolean {
  return value === true || value === 'true';
}

export async function isSubsonicProviderScrobbleBridgeEnabled(userId: string): Promise<boolean> {
  return settingEnabled(await getUserSetting(userId, SUBSONIC_PROVIDER_SCROBBLE_SETTING_KEY));
}

function positiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

function mapTrackToProviderScrobble(track: any, event: SubsonicScrobbleEvent): ProviderScrobbleTrack | null {
  const artist = String(track.artist || '').trim();
  const title = String(track.title || '').trim();
  if (!artist || !title) return null;
  const payload: ProviderScrobbleTrack = {
    artist,
    track: title,
    album: String(track.album || '').trim() || undefined,
    albumArtist: String(track.album_artist || '').trim() || undefined,
    duration: positiveInt(track.duration),
    trackNumber: positiveInt(track.track_number),
    timestamp: event.timestamp,
    mbid: String(track.mb_recording_id || track.mb_track_id || '').trim() || undefined,
  };
  return payload;
}

function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date
    ? value
    : typeof value === 'number'
      ? new Date(value)
      : /^\d{10,}$/.test(String(value))
        ? new Date(Number(value))
        : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function extensionOf(p: string): string {
  return p ? path.extname(p).slice(1).toLowerCase() : '';
}

function suffixFor(track: any): string {
  // tracks.path is base64 of the raw filesystem-path bytes, so a literal
  // path.extname() yields '' for real rows. Try the value verbatim first
  // (covers already-decoded paths / tests), then base64-decode it.
  const rawPath = track.path ? String(track.path) : '';
  let decoded = '';
  try { decoded = rawPath ? Buffer.from(rawPath, 'base64').toString('utf8') : ''; } catch { /* not base64 */ }
  for (const ext of [extensionOf(rawPath), extensionOf(decoded)]) {
    if (ext && MIME_TYPES[ext]) return ext;
    if (ext && FORMAT_TO_SUFFIX[ext]) return FORMAT_TO_SUFFIX[ext];
  }
  // Fall back to the container name (e.g. "m4a/mp42/isom"), probing each token.
  const container = String(track.format || '').toLowerCase();
  for (const token of container.split(/[\/\s]+/).filter(Boolean)) {
    if (FORMAT_TO_SUFFIX[token]) return FORMAT_TO_SUFFIX[token];
  }
  return 'mp3';
}

export function mapTrackToSubsonic(track: any, userId?: string) {
  const suffix = suffixFor(track);
  const duration = Number.isFinite(Number(track.duration)) ? Math.max(0, Math.round(Number(track.duration))) : 0;
  const bitRate = Number.isFinite(Number(track.bitrate)) ? Math.round(Number(track.bitrate) / 1000) : undefined;
  // Accept both raw DB rows (snake_case, e.g. getAlbum/getSong/search) and
  // mapTrackRow output (camelCase, e.g. getPlaylist via getPlaylistTracks).
  const albumId = track.albumId ?? track.album_id;
  const artistId = track.artistId ?? track.artist_id;
  const trackNumber = track.trackNumber ?? track.track_number;
  const discNumber = track.discNumber ?? track.disc_number;
  const fileSize = track.fileSize ?? track.file_size;
  const isLoved = track.isLoved ?? track.is_loved;
  return {
    id: subsonicSongId(track.id),
    parent: albumId ? subsonicAlbumId(albumId) : undefined,
    isDir: false,
    title: track.title || path.basename(String(track.path || track.id)),
    album: track.album || undefined,
    artist: track.artist || undefined,
    track: trackNumber || undefined,
    discNumber: discNumber || undefined,
    year: track.year || undefined,
    genre: track.genre || undefined,
    coverArt: subsonicSongId(track.id),
    size: fileSize != null ? Number(fileSize) : (track.size != null ? Number(track.size) : undefined),
    contentType: MIME_TYPES[suffix] || 'audio/mpeg',
    suffix,
    duration,
    bitRate,
    path: undefined,
    isVideo: false,
    // tracks has no created_at; use the source file's mtime (epoch ms) as the
    // library "created" timestamp. toIso() handles the epoch-ms form.
    created: toIso(track.created_at ?? track.file_mtime),
    albumId: albumId ? subsonicAlbumId(albumId) : undefined,
    artistId: artistId ? subsonicArtistId(artistId) : undefined,
    type: 'music',
    userRating: track.user_rating ?? track.rating ?? undefined,
    starred: isLoved ? toIso(track.loved_at) || new Date().toISOString() : undefined,
  };
}

export function mapAlbum(row: any, songCount?: number, duration?: number) {
  return {
    id: subsonicAlbumId(row.id),
    album: row.title || 'Unknown Album',
    name: row.title || 'Unknown Album',
    title: row.title || 'Unknown Album',
    artist: row.artist_name || undefined,
    artistId: row.artist_id ? subsonicArtistId(row.artist_id) : undefined,
    coverArt: subsonicAlbumId(row.id),
    songCount: Number(songCount || row.song_count || 0),
    duration: Number(duration || row.duration || 0),
    playCount: Number(row.play_count || 0),
    created: toIso(row.created_at),
    year: row.release_year || undefined,
    genre: row.genre || undefined,
    isDir: true,
  };
}

export function mapArtist(row: any, albumCount?: number) {
  return {
    id: subsonicArtistId(row.id),
    name: row.name || 'Unknown Artist',
    title: row.name || 'Unknown Artist',
    albumCount: Number(albumCount || row.album_count || 0),
    artistImageUrl: row.image_url || row.artwork_url || undefined,
    starred: undefined,
  };
}

export function buildAlbumListPayload(method: string, albums: any[]) {
  const key = method === 'getalbumlist2' ? 'albumList2' : 'albumList';
  return { [key]: { album: albums.map((row) => mapAlbum(row)) } };
}

export function buildSearchPayload(method: string, payload: Record<string, unknown>) {
  const key = method === 'search3'
    ? 'searchResult3'
    : method === 'search2'
      ? 'searchResult2'
      : 'searchResult';
  return { [key]: payload };
}

function countPayloadItems(value: any, key: string): number {
  const item = value?.[key];
  if (Array.isArray(item)) return item.length;
  return item ? 1 : 0;
}

function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(value || '', 10);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, base));
}

async function getTrackRow(id: string, userId: string) {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved
    FROM tracks t
    LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $2
    LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $2
    WHERE t.id = $1
  `, [songId(id), userId]);
  return res.rows[0] || null;
}

export async function sendProviderScrobbleReports(userId: string, tracks: ProviderScrobbleTrack[], submission: boolean) {
  const action = submission ? 'scrobble' : 'now-playing';
  try {
    if (tracks.length === 0) return;
    if (!(await isSubsonicProviderScrobbleBridgeEnabled(userId))) return;
    const [
      lastFmConnected,
      lastFmScrobbleEnabled,
      listenBrainzConnected,
      listenBrainzScrobbleEnabled,
    ] = await Promise.all([
      getUserSetting(userId, 'lastFmConnected'),
      getUserSetting(userId, 'lastFmScrobbleEnabled'),
      getUserSetting(userId, 'listenBrainzConnected'),
      getUserSetting(userId, 'listenBrainzScrobbleEnabled'),
    ]);

    const jobs: Array<{ provider: string; action: string; run: () => Promise<unknown> }> = [];
    if (settingEnabled(lastFmConnected) && settingEnabled(lastFmScrobbleEnabled)) {
      jobs.push({
        provider: 'lastfm',
        action,
        run: () => submission
          ? scrobbleLastFmTracks(userId, tracks)
          : updateLastFmNowPlaying(userId, tracks[tracks.length - 1]),
      });
    }
    if (settingEnabled(listenBrainzConnected) && settingEnabled(listenBrainzScrobbleEnabled)) {
      jobs.push({
        provider: 'listenbrainz',
        action,
        run: () => submission
          ? scrobbleListenBrainzTracks(userId, tracks)
          : updateListenBrainzNowPlaying(userId, tracks[tracks.length - 1]),
      });
    }

    const results = await Promise.allSettled(jobs.map((job) => job.run()));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const job = jobs[index];
        writeSubsonicLog(`provider_error provider=${job.provider} action=${job.action} count=${tracks.length} message=${String(result.reason?.message || result.reason).slice(0, 240)}`);
      }
    });
  } catch (error: any) {
    writeSubsonicLog(`provider_error provider=bridge action=${action} count=${tracks.length} message=${String(error?.message || error).slice(0, 240)}`);
  }
}

export function queueProviderScrobbleReports(userId: string, tracks: ProviderScrobbleTrack[], submission: boolean) {
  void sendProviderScrobbleReports(userId, tracks, submission);
}

async function resolvePlayableTrack(id: string, userId: string) {
  const track = await getTrackRow(id, userId);
  if (!track?.path) {
    const err = new Error('Track not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const fileBuf = pathToBuffer(track.path);
  const allowed = await isPathAllowed(fileBuf);
  if (!allowed) {
    const err = new Error('Forbidden') as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  // Precompute loudness in the background (deduped, gated on the user's opt-in).
  void maybeMeasureLoudnessForUser(userId, track.id, fileBuf.toString('utf8'));
  return { track, fileBuf };
}

/**
 * Progressive transcode targets. Every container here can be written to a pipe;
 * `m4a` deliberately maps onto ADTS AAC because the MP4 container needs a
 * seekable output and cannot be streamed from FFmpeg's stdout without
 * fragmenting it.
 */
const TRANSCODE_TARGETS: Record<string, { codec: string; container: string; suffix: string }> = {
  mp3: { codec: 'libmp3lame', container: 'mp3', suffix: 'mp3' },
  opus: { codec: 'libopus', container: 'ogg', suffix: 'opus' },
  ogg: { codec: 'libvorbis', container: 'ogg', suffix: 'ogg' },
  aac: { codec: 'aac', container: 'adts', suffix: 'aac' },
  m4a: { codec: 'aac', container: 'adts', suffix: 'aac' },
};

const DEFAULT_TRANSCODE_FORMAT = 'mp3';
const DEFAULT_TRANSCODE_KBPS = 320;

export interface StreamPlan {
  mode: 'direct' | 'transcode';
  suffix: string;
  contentType: string;
  bitrateKbps?: number;
  codec?: string;
  container?: string;
  reason: string;
}

/**
 * Decide whether `stream.view` serves the original file or transcodes, from the
 * spec's `maxBitRate` and `format` parameters.
 *
 * Subsonic defines `maxBitRate` as "the server will attempt to limit the
 * bitrate to this value, in kilobits per second. If set to zero, no limit is
 * imposed", and `format=raw` as the explicit opt-out from transcoding. Clients
 * expose this as a per-network quality setting — Symfonium's "Original" sends
 * no cap (or zero) and must keep getting the untouched file, while a cellular
 * setting of e.g. 320 asks the server to do the work.
 *
 * Direct play is preserved wherever the request does not actually demand a
 * change, so the common case stays a plain file read with byte-range support.
 */
export function resolveStreamPlan(
  source: { suffix: string; bitrateKbps?: number | null },
  params: { maxBitRate?: string | null; format?: string | null },
): StreamPlan {
  const sourceSuffix = (source.suffix || '').toLowerCase();
  const direct = (reason: string): StreamPlan => ({
    mode: 'direct',
    suffix: sourceSuffix,
    contentType: MIME_TYPES[sourceSuffix] || 'audio/mpeg',
    reason,
  });

  const requestedFormat = (params.format || '').trim().toLowerCase();
  if (requestedFormat === 'raw') return direct('format=raw');

  const parsedCap = parseInt(String(params.maxBitRate ?? ''), 10);
  // Zero means "no limit" per the spec; anything unparseable is treated as absent.
  const cap = Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : null;

  const target = requestedFormat ? TRANSCODE_TARGETS[requestedFormat] : undefined;
  // An unsupported format is not an error — the spec lets the server fall back
  // rather than fail, so it is treated as if no format had been requested.
  const formatWantsChange = Boolean(target) && target!.suffix !== sourceSuffix;

  if (!cap && !formatWantsChange) return direct('no-cap-no-format-change');

  const sourceKbps = Number.isFinite(Number(source.bitrateKbps)) && Number(source.bitrateKbps) > 0
    ? Number(source.bitrateKbps)
    : null;

  // Transcoding upward wastes CPU and quality; if the source already fits under
  // the cap and no format change was asked for, send it untouched.
  if (cap && !formatWantsChange && sourceKbps !== null && sourceKbps <= cap) {
    return direct(`source-${sourceKbps}kbps-within-cap-${cap}`);
  }

  const chosen = target || TRANSCODE_TARGETS[DEFAULT_TRANSCODE_FORMAT];
  const bitrateKbps = cap ?? Math.min(sourceKbps ?? DEFAULT_TRANSCODE_KBPS, DEFAULT_TRANSCODE_KBPS);

  return {
    mode: 'transcode',
    suffix: chosen.suffix,
    contentType: MIME_TYPES[chosen.suffix] || 'audio/mpeg',
    bitrateKbps,
    codec: chosen.codec,
    container: chosen.container,
    reason: `cap=${cap ?? 'none'} format=${requestedFormat || 'none'}`,
  };
}

async function streamFile(req: Request, res: Response, id: string, userId: string, download = false) {
  const { track, fileBuf } = await resolvePlayableTrack(id, userId);
  if (!fs.existsSync(fileBuf)) return res.status(404).send('File not found');

  const stat = fs.statSync(fileBuf);
  const ext = path.extname(fileBuf.toString('utf8')).slice(1).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'audio/mpeg';
  const fileName = path.basename(fileBuf.toString('utf8'));
  const range = req.headers.range;

  // download.view always returns the original file — only stream.view honours
  // the transcoding parameters.
  const sourceKbps = Number.isFinite(Number(track.bitrate)) && Number(track.bitrate) > 0
    ? Math.round(Number(track.bitrate) / 1000)
    : null;
  const requestedMaxBitRate = getParam(req, 'maxBitRate');
  const requestedFormat = getParam(req, 'format');
  const plan = download
    ? null
    : resolveStreamPlan({ suffix: ext, bitrateKbps: sourceKbps }, {
      maxBitRate: requestedMaxBitRate,
      format: requestedFormat,
    });

  writeSubsonicLog(
    `stream id=${songId(id)} mode=${plan?.mode ?? 'download'}`
    + ` maxBitRate=${requestedMaxBitRate || '-'} format=${requestedFormat || '-'}`
    + ` source=${ext || '-'}@${sourceKbps ?? '-'}kbps`
    + ` target=${plan?.suffix ?? ext}@${plan?.bitrateKbps ?? sourceKbps ?? '-'}kbps`
    + ` reason=${plan?.reason ?? 'download'} timeOffset=${getParam(req, 'timeOffset') || '-'}`
    + ` range=${range ? 'yes' : 'no'} ${clientInfo(req)}`,
  );

  if (plan?.mode === 'transcode') return streamTranscoded(req, res, fileBuf, plan, track);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType);
  if (download) res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = Math.max(0, parseInt(parts[0], 10) || 0);
    const end = parts[1] ? Math.min(stat.size - 1, parseInt(parts[1], 10)) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.sendStatus(416);
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(fileBuf, { start, end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(fileBuf).pipe(res);
}

/**
 * FFmpeg arguments for a progressive transcode written to stdout.
 *
 * `-vn` with an explicit `-map 0:a:0` matters: library files routinely carry an
 * embedded cover image as an mjpeg video stream, and without both flags FFmpeg
 * tries to carry it into a container that cannot hold it.
 */
export function parseTimeOffset(value: unknown, durationSec?: number | null): number {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  // Seeking past the end would produce an empty stream; clamp so the client
  // gets the tail rather than silence.
  if (Number.isFinite(Number(durationSec)) && Number(durationSec) > 0) {
    return Math.min(parsed, Math.max(0, Number(durationSec) - 1));
  }
  return parsed;
}

export function buildTranscodeArgs(filePath: string, plan: StreamPlan, timeOffsetSec = 0): string[] {
  const args: string[] = [];
  // Input seeking (`-ss` before `-i`) so FFmpeg skips to the offset instead of
  // decoding and discarding everything before it.
  if (timeOffsetSec > 0) args.push('-ss', String(timeOffsetSec));
  args.push(
    '-i', filePath,
    '-vn',
    '-map', '0:a:0',
    '-c:a', String(plan.codec),
    '-b:a', `${plan.bitrateKbps}k`,
  );
  if (plan.container === 'mp3') args.push('-id3v2_version', '3');
  args.push('-f', String(plan.container), '-');
  return args;
}

/**
 * Pipe an FFmpeg transcode straight to the response. There is no seekable byte
 * space behind a pipe, so range requests are refused up front rather than
 * answered wrongly — clients fall back to sequential playback.
 */
function streamTranscoded(req: Request, res: Response, fileBuf: Buffer, plan: StreamPlan, track: any) {
  res.setHeader('Content-Type', plan.contentType);
  res.setHeader('Accept-Ranges', 'none');

  // The real length is not known until the stream has been produced, so the
  // spec offers an estimate for clients that need a progress bar or duration.
  const timeOffsetSec = parseTimeOffset(getParam(req, 'timeOffset'), track?.duration);

  if (String(getParam(req, 'estimateContentLength') || '').toLowerCase() === 'true') {
    const duration = Number(track?.duration);
    if (Number.isFinite(duration) && duration > 0 && plan.bitrateKbps) {
      // What remains after the offset, not the whole track — otherwise a seek
      // leaves the client expecting more bytes than it will ever receive.
      const remaining = Math.max(0, duration - timeOffsetSec);
      res.setHeader('Content-Length', Math.floor((plan.bitrateKbps * 1000 / 8) * remaining));
    }
  }

  const ffmpeg = spawn('ffmpeg', buildTranscodeArgs(fileBuf.toString('utf8'), plan, timeOffsetSec));

  ffmpeg.stderr.on('data', (data) => logFfmpeg('[FFmpeg subsonic]', data.toString()));
  ffmpeg.stdout.pipe(res);

  ffmpeg.on('error', (err: Error) => {
    writeSubsonicLog(`stream_transcode_error message=${String(err?.message || err).slice(0, 200)}`);
    if (!res.headersSent) res.status(500).send('Transcoding failed');
    else res.destroy();
  });

  // Kill the encoder as soon as the client goes away; without this a skipped
  // track leaves FFmpeg running to the end of the file.
  req.on('close', () => ffmpeg.kill('SIGKILL'));
}

async function sendCoverArt(req: Request, res: Response, id: string, userId: string) {
  let trackId = songId(id);
  const db = await initDB();
  if (id.startsWith('album:')) {
    const albumTrack = await db.query(`
      SELECT id FROM tracks
      WHERE album_id = $1 AND path IS NOT NULL
      ORDER BY (NULLIF(art_hash, '') IS NOT NULL) DESC,
               disc_number NULLS LAST, track_number NULLS LAST, title
      LIMIT 1
    `, [albumId(id)]);
    trackId = albumTrack.rows[0]?.id || '';
  } else if (id.startsWith('artist:')) {
    const artistTrack = await db.query(`
      SELECT id FROM tracks
      WHERE artist_id = $1 AND path IS NOT NULL
      ORDER BY (NULLIF(art_hash, '') IS NOT NULL) DESC,
               album, disc_number NULLS LAST, track_number NULLS LAST, title
      LIMIT 1
    `, [artistId(id)]);
    trackId = artistTrack.rows[0]?.id || '';
  }
  const { track, fileBuf } = await resolvePlayableTrack(trackId, userId);
  if (!fs.existsSync(fileBuf)) return res.status(404).send('Not found');

  const utf8Path = fileBuf.toString('utf8');
  const metadata = await mm.parseFile(utf8Path, { duration: false });
  const artwork = await resolveArtwork(metadata.common.picture, utf8Path);
  if (artwork) {
    res.setHeader('Content-Type', artwork.format);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(artwork.data);
  }

  const artworkInfo = track.path ? await getArtworkInfoForPath(track.path) : null;
  const providerUrl = artworkInfo ? await resolveProviderArtworkUrl({
    albumId: artworkInfo.albumId,
    album: artworkInfo.album,
    artist: artworkInfo.artist,
    mbAlbumId: artworkInfo.mbAlbumId,
    cachedImageUrl: artworkInfo.cachedImageUrl,
  }) : undefined;
  if (providerUrl) return res.redirect(302, providerArtworkProxyPath(providerUrl));
  return res.status(404).send('No art found');
}

async function sendHls(req: Request, res: Response, id: string, ctx: SubsonicContext) {
  const quality = getParam(req, 'maxBitRate') || DEFAULT_HLS_QUALITY;
  const codec = DEFAULT_HLS_CODEC;
  const { track, fileBuf } = await resolvePlayableTrack(id, ctx.userId);
  await getOrCreateHlsSession(songId(id), fileBuf, `${quality}k`, Number(track.bitrate) || null, track.format || null, codec);
  const session = getSessionInfo(songId(id), `${quality}k`, codec);
  if (!session || !fs.existsSync(session.playlistPath)) return res.status(500).send('HLS unavailable');
  touchSession(songId(id), `${quality}k`, codec);
  const mediaToken = await generateScopedToken('media', {
    userId: ctx.userId,
    username: ctx.username,
    role: ctx.role,
  });
  const query = new URLSearchParams({
    id: subsonicSongId(songId(id)),
    mediaToken,
    f: getParam(req, 'f') || 'json',
    maxBitRate: quality,
  });
  // Mid-transcode FFmpeg's playlist is EVENT-typed with no #EXT-X-ENDLIST, which
  // players read as a live stream — they report an unknown duration and start
  // near the live edge rather than at 0. Complete it to VOD from the known track
  // duration, exactly as the web routes do.
  const rawPlaylist = fs.readFileSync(session.playlistPath, 'utf8');
  const trackDuration = Number.isFinite(Number(track.duration)) ? Number(track.duration) : null;
  const completedPlaylist = session.finished ? null : completeVodPlaylist(rawPlaylist, trackDuration);
  const playlist = (completedPlaylist ?? rawPlaylist).replace(/^(segment\d+\.ts)$/gm, (_match, segment) => {
    query.set('segment', segment);
    return `/rest/hlsSegment.view?${query.toString()}`;
  });
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', session.finished ? 'public, max-age=30' : 'no-cache');
  res.send(playlist);
}

async function sendHlsSegment(req: Request, res: Response, id: string) {
  const segment = getParam(req, 'segment') || '';
  if (!/^segment\d+\.ts$/.test(segment)) return res.status(400).send('Invalid segment');
  const quality = getParam(req, 'maxBitRate') || DEFAULT_HLS_QUALITY;
  const outputDir = getSessionOutputDir(songId(id), `${quality}k`, DEFAULT_HLS_CODEC);
  if (!outputDir) return res.status(404).send('No HLS session');
  const segmentPath = path.join(outputDir, segment);
  // A completed playlist lists segments FFmpeg has not written yet, so hold the
  // request until it appears instead of 404ing the client out of the stream.
  const segmentReady = await waitForSegmentListed(
    path.join(outputDir, 'playlist.m3u8'),
    segment,
    () => getSessionInfo(songId(id), `${quality}k`, DEFAULT_HLS_CODEC)?.finished ?? true,
  );
  if (!segmentReady || !fs.existsSync(segmentPath)) return res.status(404).send('Segment not found');
  touchSession(songId(id), `${quality}k`, DEFAULT_HLS_CODEC);
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(segmentPath).pipe(res);
}

async function getAlbumSummaries(userId: string, where = '', params: unknown[] = []) {
  const db = await initDB();
  const res = await db.query(`
    SELECT a.*, COUNT(t.id)::int AS song_count, COALESCE(SUM(t.duration), 0)::int AS duration,
           MIN(t.artist_id::text) AS artist_id, MIN(t.genre) AS genre
    FROM albums a
    LEFT JOIN tracks t ON t.album_id = a.id
    ${where}
    GROUP BY a.id
    ORDER BY a.title ASC
  `, params);
  return res.rows.map((row) => mapAlbum(row));
}

// Subsonic getUser: Aurora is apiKey-only with out-of-band user management, so
// remote user administration / password change are intentionally unsupported.
// We still expose real capability flags derived from the account role so
// clients can enable the right features on connect.
export function buildSubsonicUser(username: string, role: string) {
  const isAdmin = role === 'admin';
  return {
    username,
    scrobblingEnabled: true,
    adminRole: isAdmin,
    settingsRole: isAdmin,
    downloadRole: true,
    uploadRole: false,
    playlistRole: true,
    coverArtRole: true,
    commentRole: false,
    podcastRole: false,
    streamRole: true,
    jukeboxRole: false,
    shareRole: false,
    videoConversionRole: false,
    folder: [1],
  };
}

// Map music-metadata ILyricsTag[] (embedded USLT/SYLT etc.) to the
// OpenSubsonic songLyrics `structuredLyrics` shape. Synced lyrics carry
// per-line `start` ms; unsynced lyrics are split into value-only lines.
export function buildStructuredLyrics(tags: any[], displayArtist?: string, displayTitle?: string) {
  const out: Array<Record<string, unknown>> = [];
  for (const tag of tags || []) {
    const lang = typeof tag?.language === 'string' && /^[a-z]{2,3}$/i.test(tag.language)
      ? tag.language.toLowerCase()
      : 'und';
    if (Array.isArray(tag?.syncText) && tag.syncText.length > 0) {
      out.push({
        displayArtist, displayTitle, lang, offset: 0, synced: true,
        line: tag.syncText.map((l: any) => ({
          start: Math.max(0, Math.round(Number(l?.timestamp) || 0)),
          value: String(l?.text ?? ''),
        })),
      });
    } else if (tag?.text && String(tag.text).trim()) {
      out.push({
        displayArtist, displayTitle, lang, offset: 0, synced: false,
        line: String(tag.text).replace(/\r\n?/g, '\n').split('\n').map((value) => ({ value })),
      });
    }
  }
  return out;
}

async function readEmbeddedLyrics(fileBuf: Buffer): Promise<any[]> {
  const metadata = await mm.parseFile(fileBuf.toString('utf8'));
  return (metadata.common?.lyrics as any[]) || [];
}

// Resolve a list of internal track ids to Subsonic song rows, preserving the
// requested order and dropping ids that no longer exist (used by play queue).
async function fetchOrderedTracks(ids: string[], userId: string) {
  if (!ids.length) return [] as any[];
  const db = await initDB();
  const res = await db.query(`
    SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved
    FROM tracks t
    LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $2
    LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $2
    WHERE t.id = ANY($1)
  `, [ids, userId]);
  const byId = new Map<string, any>(res.rows.map((r: any) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// Resolve a getSimilarSongs seed (song/album/artist id) to acoustic vectors for
// the EffNet/MusiCNN nearest-neighbour search. Returns null when the seed has
// no analysed features yet (caller falls back to genre/artist matching).
async function resolveSimilarSeed(rawId: string, userId: string): Promise<{ vectorStr: string; embeddingCentroidStr: string | null; excludeIds: string[] } | null> {
  const db = await initDB();
  if (rawId.startsWith('artist:')) {
    const c = await computeArtistCentroids(userId, artistId(rawId), 8);
    return c?.acousticVectorStr ? { vectorStr: c.acousticVectorStr, embeddingCentroidStr: c.embeddingCentroidStr, excludeIds: [] } : null;
  }
  if (rawId.startsWith('album:')) {
    const r = (await db.query(
      `SELECT tf.acoustic_vector_8d::text AS v8, tf.embedding_vector::text AS emb
       FROM tracks t JOIN track_features tf ON tf.track_id = t.id
       WHERE t.album_id = $1 AND tf.acoustic_vector_8d IS NOT NULL
       ORDER BY t.disc_number NULLS LAST, t.track_number NULLS LAST LIMIT 1`,
      [albumId(rawId)],
    )).rows[0];
    return r?.v8 ? { vectorStr: r.v8, embeddingCentroidStr: r.emb || null, excludeIds: [] } : null;
  }
  const seedId = songId(rawId);
  const r = (await db.query(
    `SELECT tf.acoustic_vector_8d::text AS v8, tf.embedding_vector::text AS emb
     FROM track_features tf WHERE tf.track_id = $1`,
    [seedId],
  )).rows[0];
  return r?.v8 ? { vectorStr: r.v8, embeddingCentroidStr: r.emb || null, excludeIds: [seedId] } : null;
}

// Genre/artist fallback for getSimilarSongs when the seed has no acoustic
// features (e.g. not yet analysed). Same-artist tracks rank ahead of same-genre.
async function fallbackSimilarSongs(rawId: string, count: number, userId: string) {
  const db = await initDB();
  let seedArtistId: string | null = null;
  let seedGenreId: string | null = null;
  let seedSongInternal: string | null = null;
  if (rawId.startsWith('artist:')) {
    seedArtistId = artistId(rawId);
  } else if (rawId.startsWith('album:')) {
    const r = (await db.query('SELECT artist_id::text AS artist_id, genre_id::text AS genre_id FROM tracks WHERE album_id = $1 LIMIT 1', [albumId(rawId)])).rows[0];
    seedArtistId = r?.artist_id || null; seedGenreId = r?.genre_id || null;
  } else {
    seedSongInternal = songId(rawId);
    const r = (await db.query('SELECT artist_id::text AS artist_id, genre_id::text AS genre_id FROM tracks WHERE id = $1', [seedSongInternal])).rows[0];
    seedArtistId = r?.artist_id || null; seedGenreId = r?.genre_id || null;
  }
  const params: unknown[] = [userId];
  const where: string[] = ['t.path IS NOT NULL'];
  const orParts: string[] = [];
  if (seedArtistId) { params.push(seedArtistId); orParts.push(`t.artist_id::text = $${params.length}`); }
  if (seedGenreId) { params.push(seedGenreId); orParts.push(`t.genre_id::text = $${params.length}`); }
  if (orParts.length) where.push(`(${orParts.join(' OR ')})`);
  if (seedSongInternal) { params.push(seedSongInternal); where.push(`t.id <> $${params.length}`); }
  let order = 'random()';
  if (seedArtistId) { params.push(seedArtistId); order = `(t.artist_id::text = $${params.length}) DESC, random()`; }
  params.push(count);
  const rows = (await db.query(`
    SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved
    FROM tracks t
    LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
    LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $1
    WHERE ${where.join(' AND ')}
    ORDER BY ${order}
    LIMIT $${params.length}
  `, params)).rows;
  return rows;
}

async function handleSystem(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  const db = await initDB();
  switch (method) {
    case 'ping':
      return sendSubsonic(req, res, subsonicSuccess({}));
    case 'getlicense':
      return sendSubsonic(req, res, subsonicSuccess({ license: { valid: true } }));
    case 'getopensubsonicextensions':
      // Normally served before the auth gate (see router.all below); handled
      // here too so it still works if reached with valid auth.
      return sendSubsonic(req, res, subsonicSuccess(openSubsonicExtensionsPayload()));
    case 'tokeninfo':
      return sendSubsonic(req, res, subsonicSuccess({
        tokenInfo: {
          username: ctx.username,
          keyPrefix: ctx.keyPrefix,
          role: ctx.role,
        },
      }));
    case 'getuser': {
      const requested = getParam(req, 'username');
      let username = ctx.username;
      let role = ctx.role;
      if (requested && requested !== ctx.username) {
        // Only an admin may inspect another user; mirror Subsonic's 50.
        if (ctx.role !== 'admin') return sendError(req, res, 50, 'Not authorized to get details for another user');
        const other = await db.query('SELECT username, role FROM users WHERE username = $1', [requested]);
        if (!other.rows[0]) return sendError(req, res, 70, 'User not found');
        username = other.rows[0].username;
        role = other.rows[0].role;
      }
      return sendSubsonic(req, res, subsonicSuccess({ user: buildSubsonicUser(username, role) }));
    }
    case 'getscanstatus': {
      const count = await db.query('SELECT COUNT(*)::int AS count FROM tracks');
      return sendSubsonic(req, res, subsonicSuccess({
        scanStatus: {
          scanning: false,
          count: Number(count.rows[0]?.count || 0),
        },
      }));
    }
    case 'startscan': {
      const count = await db.query('SELECT COUNT(*)::int AS count FROM tracks');
      return sendSubsonic(req, res, subsonicSuccess({
        scanStatus: {
          scanning: false,
          count: Number(count.rows[0]?.count || 0),
        },
      }));
    }
    default:
      return false;
  }
}

async function handleBrowsing(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  const db = await initDB();
  switch (method) {
    case 'getmusicfolders':
      return sendSubsonic(req, res, subsonicSuccess({ musicFolders: { musicFolder: [{ id: '1', name: 'Aurora Library' }] } }));
    case 'getindexes': {
      const artists = await db.query(`
        SELECT a.*, COUNT(t.album_id)::int AS album_count
        FROM artists a
        LEFT JOIN (
          SELECT DISTINCT artist_id, album_id
          FROM tracks
          WHERE artist_id IS NOT NULL AND album_id IS NOT NULL
        ) t ON t.artist_id = a.id
        WHERE a.merged_into IS NULL
        GROUP BY a.id
        ORDER BY a.name ASC
      `);
      const grouped = new Map<string, any[]>();
      for (const row of artists.rows) {
        const letter = /^[A-Za-z]$/.test(String(row.name || '').charAt(0)) ? String(row.name).charAt(0).toUpperCase() : '#';
        if (!grouped.has(letter)) grouped.set(letter, []);
        grouped.get(letter)!.push(mapArtist(row, row.album_count));
      }
      return sendSubsonic(req, res, subsonicSuccess({ indexes: { index: Array.from(grouped.entries()).map(([name, artist]) => ({ name, artist })) } }));
    }
    case 'getmusicdirectory': {
      const id = getParam(req, 'id') || 'root';
      if (id === 'root' || id === '1') {
        const artists = await db.query(`
          SELECT a.*, COUNT(t.album_id)::int AS album_count
          FROM artists a
          LEFT JOIN (
            SELECT DISTINCT artist_id, album_id
            FROM tracks
            WHERE artist_id IS NOT NULL AND album_id IS NOT NULL
          ) t ON t.artist_id = a.id
          WHERE a.merged_into IS NULL
          GROUP BY a.id
          ORDER BY a.name ASC
        `);
        return sendSubsonic(req, res, subsonicSuccess({
          directory: {
            id: 'root',
            name: 'Aurora Library',
            child: artists.rows.map((row) => ({
              ...mapArtist(row, row.album_count),
              parent: 'root',
              isDir: true,
            })),
          },
        }));
      }
      if (id.startsWith('artist:')) {
        const artist = await db.query('SELECT * FROM artists WHERE id = $1', [artistId(id)]);
        const albums = await getAlbumSummaries(ctx.userId, 'WHERE t.artist_id = $1', [artistId(id)]);
        return sendSubsonic(req, res, subsonicSuccess({
          directory: {
            id,
            name: artist.rows[0]?.name || 'Artist',
            child: albums.map((album) => ({ ...album, parent: id, isDir: true })),
          },
        }));
      }
      const album = await db.query('SELECT * FROM albums WHERE id = $1', [albumId(id)]);
      const tracks = await db.query('SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved FROM tracks t LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $2 LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $2 WHERE t.album_id = $1 ORDER BY t.disc_number NULLS LAST, t.track_number NULLS LAST, t.title', [albumId(id), ctx.userId]);
      return sendSubsonic(req, res, subsonicSuccess({ directory: { id, name: album.rows[0]?.title || 'Album', child: tracks.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)) } }));
    }
    case 'getgenres': {
      const genres = await db.query(`
        SELECT g.name, COUNT(DISTINCT tg.track_id)::int AS song_count,
               COUNT(DISTINCT t.album_id)::int AS album_count
        FROM genres g
        JOIN track_genres tg ON tg.genre_id = g.id
        JOIN tracks t ON t.id = tg.track_id
        WHERE g.merged_into IS NULL
        GROUP BY g.id, g.name
        ORDER BY g.name ASC
      `);
      return sendSubsonic(req, res, subsonicSuccess({ genres: { genre: genres.rows.map((row) => ({ value: row.name, songCount: row.song_count, albumCount: row.album_count })) } }));
    }
    case 'getartists': {
      const artists = await db.query(`
        SELECT a.*, COUNT(t.album_id)::int AS album_count
        FROM artists a
        LEFT JOIN (
          SELECT DISTINCT artist_id, album_id
          FROM tracks
          WHERE artist_id IS NOT NULL AND album_id IS NOT NULL
        ) t ON t.artist_id = a.id
        WHERE a.merged_into IS NULL
        GROUP BY a.id
        ORDER BY a.name ASC
      `);
      return sendSubsonic(req, res, subsonicSuccess({ artists: { index: [{ name: 'All', artist: artists.rows.map((row) => mapArtist(row, row.album_count)) }] } }));
    }
    case 'getartist': {
      const id = artistId(getParam(req, 'id') || '');
      const artist = await db.query('SELECT * FROM artists WHERE id = $1', [id]);
      if (!artist.rows[0]) return sendError(req, res, 70, 'Artist not found');
      const albums = await getAlbumSummaries(ctx.userId, 'WHERE t.artist_id = $1', [id]);
      return sendSubsonic(req, res, subsonicSuccess({ artist: { ...mapArtist(artist.rows[0], albums.length), album: albums } }));
    }
    case 'getalbum': {
      const id = albumId(getParam(req, 'id') || '');
      const album = await db.query('SELECT * FROM albums WHERE id = $1', [id]);
      if (!album.rows[0]) return sendError(req, res, 70, 'Album not found');
      const tracks = await db.query('SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved FROM tracks t LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $2 LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $2 WHERE t.album_id = $1 ORDER BY t.disc_number NULLS LAST, t.track_number NULLS LAST, t.title', [id, ctx.userId]);
      // albums rows have no artist_id/genre columns; derive them from the
      // tracks so the AlbumID3 payload carries artistId/genre for clients.
      const albumRow = album.rows[0];
      const firstTrack = tracks.rows[0];
      if (albumRow && firstTrack) {
        albumRow.artist_id = albumRow.artist_id ?? firstTrack.artist_id;
        albumRow.genre = albumRow.genre ?? firstTrack.genre;
      }
      const summary = mapAlbum(albumRow, tracks.rows.length, tracks.rows.reduce((sum, row) => sum + Number(row.duration || 0), 0));
      writeSubsonicLog(`getAlbum id=${id} songs=${tracks.rows.length}`);
      return sendSubsonic(req, res, subsonicSuccess({ album: { ...summary, song: tracks.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)) } }));
    }
    case 'getsong': {
      const track = await getTrackRow(getParam(req, 'id') || '', ctx.userId);
      if (!track) return sendError(req, res, 70, 'Song not found');
      return sendSubsonic(req, res, subsonicSuccess({ song: mapTrackToSubsonic(track, ctx.userId) }));
    }
    default:
      return false;
  }
}

async function handleLists(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  const db = await initDB();
  switch (method) {
    case 'getalbumlist':
    case 'getalbumlist2': {
      const type = (getParam(req, 'type') || 'alphabeticalByName').toLowerCase();
      // Aurora tracks loved songs only, not starred albums (getStarred2 also
      // reports none); return an empty list rather than the whole catalogue.
      if (type === 'starred') {
        return sendSubsonic(req, res, subsonicSuccess(buildAlbumListPayload(method, [])));
      }
      const size = Math.max(1, Math.min(500, parseInt(getParam(req, 'size') || '10', 10) || 10));
      const offset = Math.max(0, parseInt(getParam(req, 'offset') || '0', 10) || 0);
      const genre = getParam(req, 'genre');
      const fromYear = parseInt(getParam(req, 'fromYear') || '', 10);
      const toYear = parseInt(getParam(req, 'toYear') || '', 10);
      let order = 'a.title ASC';
      if (type === 'newest' || type === 'recent') order = 'a.created_at DESC';
      if (type === 'random') order = 'md5(a.id::text)';
      if (type === 'alphabeticalbyartist') order = 'a.artist_name ASC, a.title ASC';
      if (type === 'byyear') order = fromYear > toYear ? 'a.release_year DESC NULLS LAST, a.title ASC' : 'a.release_year ASC NULLS LAST, a.title ASC';
      if (type === 'highest' || type === 'frequent') order = 'play_count DESC, a.title ASC';
      if (type === 'starred') order = 'a.title ASC';
      const params: unknown[] = [];
      const conditions: string[] = [];
      if (genre || type === 'bygenre') {
        params.push(genre || '');
        conditions.push(`LOWER(g.name) = LOWER($${params.length})`);
      }
      if (type === 'byyear' && Number.isFinite(fromYear) && Number.isFinite(toYear)) {
        params.push(Math.min(fromYear, toYear), Math.max(fromYear, toYear));
        conditions.push(`a.release_year BETWEEN $${params.length - 1} AND $${params.length}`);
      }
      params.push(size, offset);
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const albums = await db.query(`
        SELECT a.*, COUNT(t.id)::int AS song_count, COALESCE(SUM(t.duration), 0)::int AS duration,
               MIN(t.artist_id::text) AS artist_id, MIN(g.name) AS genre, COALESCE(SUM(t.play_count), 0)::int AS play_count
        FROM albums a LEFT JOIN tracks t ON t.album_id = a.id
        LEFT JOIN genres g ON g.id = t.genre_id
        ${where}
        GROUP BY a.id
        ORDER BY ${order}
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params);
      writeSubsonicLog(`albumList method=${method} type=${type} size=${size} offset=${offset} albums=${albums.rows.length}`);
      return sendSubsonic(req, res, subsonicSuccess(buildAlbumListPayload(method, albums.rows)));
    }
    case 'getrandomsongs': {
      const size = Math.max(1, Math.min(500, parseInt(getParam(req, 'size') || '10', 10) || 10));
      const genre = getParam(req, 'genre');
      const fromYear = parseInt(getParam(req, 'fromYear') || '', 10);
      const toYear = parseInt(getParam(req, 'toYear') || '', 10);
      const params: unknown[] = [ctx.userId];
      const conditions: string[] = [];
      if (genre) { params.push(genre); conditions.push(`LOWER(g.name) = LOWER($${params.length})`); }
      if (Number.isFinite(fromYear)) { params.push(fromYear); conditions.push(`t.year >= $${params.length}`); }
      if (Number.isFinite(toYear)) { params.push(toYear); conditions.push(`t.year <= $${params.length}`); }
      params.push(size);
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      // ORDER BY random() gives a true sample; the old COUNT+offset scheme
      // returned one contiguous block (tracks.id sorts albums together).
      const songs = await db.query(`SELECT t.*, COALESCE(g.name, t.genre) AS genre, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved FROM tracks t LEFT JOIN genres g ON g.id = t.genre_id LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1 LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $1 ${where} ORDER BY random() LIMIT $${params.length}`, params);
      return sendSubsonic(req, res, subsonicSuccess({ randomSongs: { song: songs.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)) } }));
    }
    case 'getsongsbygenre': {
      const genre = getParam(req, 'genre') || '';
      const count = Math.max(1, Math.min(500, parseInt(getParam(req, 'count') || '10', 10) || 10));
      const songs = await db.query('SELECT t.*, COALESCE(g.name, t.genre) AS genre, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved FROM tracks t JOIN genres g ON g.id = t.genre_id LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1 LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $1 WHERE LOWER(g.name) = LOWER($2) ORDER BY t.title LIMIT $3', [ctx.userId, genre, count]);
      return sendSubsonic(req, res, subsonicSuccess({ songsByGenre: { song: songs.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)) } }));
    }
    case 'getstarred':
    case 'getstarred2': {
      const rows = await db.query('SELECT t.*, ult.loved_at, TRUE AS is_loved, ups.rating AS user_rating FROM user_loved_tracks ult JOIN tracks t ON t.id = ult.track_id LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = ult.user_id WHERE ult.user_id = $1 ORDER BY ult.loved_at DESC', [ctx.userId]);
      const payloadName = method === 'getstarred2' ? 'starred2' : 'starred';
      return sendSubsonic(req, res, subsonicSuccess({ [payloadName]: { song: rows.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)), album: [], artist: [] } }));
    }
    case 'search':
    case 'search2':
    case 'search3': {
      const rawQuery = getParam(req, 'query') ?? getParam(req, 'any') ?? '';
      const query = normalizeSearchQuery(rawQuery);
      const artistCount = parseBoundedInt(getParam(req, 'artistCount'), 20, 0, 500);
      const albumCount = parseBoundedInt(getParam(req, 'albumCount'), 20, 0, 500);
      const songCount = parseBoundedInt(getParam(req, 'songCount'), 50, 0, 500);
      const artistOffset = parseBoundedInt(getParam(req, 'artistOffset'), 0, 0, Number.MAX_SAFE_INTEGER);
      const albumOffset = parseBoundedInt(getParam(req, 'albumOffset'), 0, 0, Number.MAX_SAFE_INTEGER);
      const songOffset = parseBoundedInt(getParam(req, 'songOffset'), 0, 0, Number.MAX_SAFE_INTEGER);
      const hasQuery = query.length > 0;
      const term = `%${query}%`;
      const [artists, albums, songs] = await Promise.all([
        db.query(`
          SELECT a.*, COUNT(t.album_id)::int AS album_count
          FROM artists a
          LEFT JOIN (
            SELECT DISTINCT artist_id, album_id
            FROM tracks
            WHERE artist_id IS NOT NULL AND album_id IS NOT NULL
          ) t ON t.artist_id = a.id
          ${hasQuery ? 'WHERE a.name ILIKE $1' : ''}
          GROUP BY a.id
          ORDER BY a.name, a.id
          LIMIT $${hasQuery ? 2 : 1} OFFSET $${hasQuery ? 3 : 2}
        `, hasQuery ? [term, artistCount, artistOffset] : [artistCount, artistOffset]),
        db.query(`
          SELECT a.*, COUNT(t.id)::int AS song_count, COALESCE(SUM(t.duration), 0)::int AS duration,
                 MIN(t.artist_id::text) AS artist_id, MIN(t.genre) AS genre, COALESCE(SUM(t.play_count), 0)::int AS play_count
          FROM albums a
          LEFT JOIN tracks t ON t.album_id = a.id
          ${hasQuery ? 'WHERE a.title ILIKE $1 OR a.artist_name ILIKE $1' : ''}
          GROUP BY a.id
          ORDER BY a.title, a.id
          LIMIT $${hasQuery ? 2 : 1} OFFSET $${hasQuery ? 3 : 2}
        `, hasQuery ? [term, albumCount, albumOffset] : [albumCount, albumOffset]),
        db.query(`
          SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved
          FROM tracks t
          LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $${hasQuery ? 2 : 1}
          LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $${hasQuery ? 2 : 1}
          ${hasQuery ? 'WHERE t.title ILIKE $1 OR t.artist ILIKE $1 OR t.album ILIKE $1' : ''}
          ORDER BY t.title, t.id
          LIMIT $${hasQuery ? 3 : 2} OFFSET $${hasQuery ? 4 : 3}
        `, hasQuery ? [term, ctx.userId, songCount, songOffset] : [ctx.userId, songCount, songOffset]),
      ]);
      const payload = { artist: artists.rows.map((row) => mapArtist(row, row.album_count)), album: albums.rows.map((row) => mapAlbum(row)), song: songs.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)) };
      writeSubsonicLog(`search method=${method} rawQuery=${JSON.stringify(String(rawQuery)).slice(0, 60)} emptyQuery=${!hasQuery} artistCount=${countPayloadItems(payload, 'artist')} albumCount=${countPayloadItems(payload, 'album')} songCount=${countPayloadItems(payload, 'song')} artistOffset=${artistOffset} albumOffset=${albumOffset} songOffset=${songOffset}`);
      return sendSubsonic(req, res, subsonicSuccess(buildSearchPayload(method, payload)));
    }
    case 'getsimilarsongs':
    case 'getsimilarsongs2': {
      const rawId = getParam(req, 'id') || '';
      const count = Math.max(1, Math.min(500, parseInt(getParam(req, 'count') || '50', 10) || 50));
      const seed = await resolveSimilarSeed(rawId, ctx.userId);
      let rows: any[];
      if (seed) {
        // EffNet/MusiCNN acoustic nearest-neighbour — the same engine the
        // daylist/recommendation builder uses (8-d mood vector + 1280-d EffNet
        // embedding, blended via EFFNET_SIMILARITY_WEIGHT).
        rows = await fetchCandidatePool({
          name: 'acoustic',
          limit: count,
          vectorStr: seed.vectorStr,
          embeddingCentroidStr: seed.embeddingCentroidStr,
          effnetWeight: EFFNET_SIMILARITY_WEIGHT,
          userId: ctx.userId,
          excludeIds: seed.excludeIds,
        });
      } else {
        // Seed not analysed yet → genre/artist fallback so we still return songs.
        rows = await fallbackSimilarSongs(rawId, count, ctx.userId);
      }
      const key = method === 'getsimilarsongs2' ? 'similarSongs2' : 'similarSongs';
      return sendSubsonic(req, res, subsonicSuccess({ [key]: { song: rows.map((row) => mapTrackToSubsonic(row, ctx.userId)) } }));
    }
    default:
      return false;
  }
}

async function handlePlaylists(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  switch (method) {
    case 'getplaylists': {
      // Subsonic clients never hit the web hub view, so opportunistically kick a
      // background LLM hub refresh on listing. Non-blocking and self-throttling:
      // runLlmHubRegeneration skips when hub playlists are still fresh for the
      // configured schedule (and guards against concurrent runs per user), so
      // polling clients like Symfonium won't spam the LLM. Freshly generated
      // playlists show up on the client's next poll.
      queueLlmHubRefreshForUser(ctx.userId, 'subsonic');
      const playlists = await getPlaylists(ctx.userId);
      const db = await initDB();
      const counts = playlists.length > 0
        ? await db.query('SELECT playlist_id, COUNT(*)::int AS c FROM playlist_tracks WHERE playlist_id = ANY($1) GROUP BY playlist_id', [playlists.map((p: any) => p.id)])
        : { rows: [] as any[] };
      const countMap = new Map<string, number>(counts.rows.map((r: any) => [r.playlist_id, Number(r.c)]));
      return sendSubsonic(req, res, subsonicSuccess({ playlists: { playlist: playlists.map((playlist: any) => ({ id: playlist.id, name: playlist.title, comment: playlist.description || undefined, songCount: countMap.get(playlist.id) || 0, public: false, owner: ctx.username, created: toIso(playlist.createdAt), changed: toIso(playlist.createdAt), readOnly: !!playlist.isSystem || !!playlist.isLlmGenerated })) } }));
    }
    case 'getplaylist': {
      const id = getParam(req, 'id') || '';
      const playlists = await getPlaylists(ctx.userId);
      const playlist = playlists.find((item: any) => item.id === id);
      if (!playlist) return sendError(req, res, 70, 'Playlist not found');
      const tracks = await getPlaylistTracks(id, ctx.userId);
      return sendSubsonic(req, res, subsonicSuccess({ playlist: { id, name: playlist.title, comment: playlist.description || undefined, owner: ctx.username, public: false, songCount: tracks.length, duration: tracks.reduce((sum: number, track: any) => sum + Number(track.duration || 0), 0), entry: tracks.map((track: any) => mapTrackToSubsonic(track, ctx.userId)), readOnly: !!playlist.isSystem || !!playlist.isLlmGenerated } }));
    }
    case 'createplaylist': {
      const name = (getParam(req, 'name') || getParam(req, 'playlistId') || 'Subsonic Playlist').trim().slice(0, 120);
      const id = `subsonic_${Date.now()}`;
      await createPlaylist(id, name, null, false, ctx.userId);
      const songs = getParamList(req, 'songId').map(songId);
      if (songs.length > 0) await addTracksToPlaylist(id, songs);
      publishApiV1Event(ctx.userId, 'playlist.changed', { playlistId: id, action: 'created', source: 'openSubsonic' });
      return sendSubsonic(req, res, subsonicSuccess({ playlist: { id, name, songCount: songs.length } }));
    }
    case 'updateplaylist': {
      const id = getParam(req, 'playlistId') || getParam(req, 'id') || '';
      const meta = await getPlaylistMeta(id);
      if (!meta) return sendError(req, res, 70, 'Playlist not found');
      if (meta.isSystem || meta.isLlmGenerated) return sendError(req, res, 50, 'Generated playlists are read-only');
      if (meta.userId !== ctx.userId && ctx.role !== 'admin') return sendError(req, res, 50, 'Playlist belongs to another user');
      const existing = await getPlaylistTracks(id, ctx.userId);
      const removeIndexes = new Set(getParamList(req, 'songIndexToRemove').map((value) => parseInt(value, 10)).filter(Number.isFinite));
      let nextIds = existing.map((track: any) => track.id).filter((_id: string, index: number) => !removeIndexes.has(index));
      const addIds = getParamList(req, 'songIdToAdd').map(songId);
      nextIds = nextIds.concat(addIds);
      await addTracksToPlaylist(id, nextIds);
      publishApiV1Event(ctx.userId, 'playlist.changed', { playlistId: id, action: 'tracksReplaced', source: 'openSubsonic' });
      return sendSubsonic(req, res, subsonicSuccess({}));
    }
    case 'deleteplaylist': {
      const id = getParam(req, 'id') || '';
      const meta = await getPlaylistMeta(id);
      if (!meta) return sendError(req, res, 70, 'Playlist not found');
      if (meta.isSystem || meta.isLlmGenerated) return sendError(req, res, 50, 'Generated playlists are read-only');
      if (meta.userId !== ctx.userId && ctx.role !== 'admin') return sendError(req, res, 50, 'Playlist belongs to another user');
      await deletePlaylist(id, ctx.role === 'admin' ? null : ctx.userId);
      publishApiV1Event(meta.userId || ctx.userId, 'playlist.changed', { playlistId: id, action: 'deleted', source: 'openSubsonic' });
      return sendSubsonic(req, res, subsonicSuccess({}));
    }
    default:
      return false;
  }
}

async function handleAnnotations(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  const id = getParam(req, 'id') || '';
  switch (method) {
    case 'star':
      await setTrackLovedForUser(ctx.userId, songId(id), true);
      publishApiV1Event(ctx.userId, 'annotation.changed', { trackId: songId(id), loved: true, source: 'openSubsonic' });
      return sendSubsonic(req, res, subsonicSuccess({}));
    case 'unstar':
      await setTrackLovedForUser(ctx.userId, songId(id), false);
      publishApiV1Event(ctx.userId, 'annotation.changed', { trackId: songId(id), loved: false, source: 'openSubsonic' });
      return sendSubsonic(req, res, subsonicSuccess({}));
    case 'setrating': {
      const rating = parseInt(getParam(req, 'rating') || '0', 10);
      const normalizedRating = Number.isFinite(rating) ? rating : 0;
      await setTrackRatingForUser(ctx.userId, songId(id), normalizedRating);
      publishApiV1Event(ctx.userId, 'annotation.changed', { trackId: songId(id), rating: normalizedRating, source: 'openSubsonic' });
      return sendSubsonic(req, res, subsonicSuccess({}));
    }
    case 'scrobble': {
      const events = buildSubsonicScrobbleEvents(getParamList(req, 'id'), getParamList(req, 'time'));
      if (events.length === 0) return sendError(req, res, 70, 'Missing scrobble id');

      const submission = isSubsonicSubmission(getParam(req, 'submission'));
      const providerTracks: ProviderScrobbleTrack[] = [];
      let recorded = 0;
      let missing = 0;
      let unreportable = 0;

      for (const event of events) {
        const track = await getTrackRow(event.trackId, ctx.userId);
        if (!track) {
          missing += 1;
          continue;
        }

        const providerTrack = mapTrackToProviderScrobble(track, event);
        if (providerTrack) providerTracks.push(providerTrack);
        else unreportable += 1;

        if (submission) {
          await recordPlaybackForUser(ctx.userId, event.trackId, event.playedAt);
          recorded += 1;
        }
      }

      if (recorded === 0 && providerTracks.length === 0 && missing > 0) {
        return sendError(req, res, 70, 'Track not found');
      }

      queueProviderScrobbleReports(ctx.userId, providerTracks, submission);
      writeSubsonicLog(`scrobble mode=${submission ? 'submission' : 'now-playing'} ids=${events.length} recorded=${recorded} reportable=${providerTracks.length} missing=${missing} unreportable=${unreportable} ${clientInfo(req)}`);
      return sendSubsonic(req, res, subsonicSuccess({}));
    }
    default:
      return false;
  }
}

async function handleQueue(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  switch (method) {
    case 'saveplayqueue':
    case 'saveplayqueuebyindex': {
      const ids = getParamList(req, 'id').map(songId).filter(Boolean);
      if (ids.length === 0) {
        // Per spec, a save with no ids clears the queue.
        await setUserSetting(ctx.userId, PLAYQUEUE_SETTING_KEY, null);
        return sendSubsonic(req, res, subsonicSuccess({}));
      }
      let currentIndex: number;
      if (method === 'saveplayqueuebyindex') {
        currentIndex = parseInt(getParam(req, 'currentIndex') || '0', 10);
      } else {
        const current = getParam(req, 'current');
        currentIndex = current ? ids.indexOf(songId(current)) : 0;
      }
      if (!Number.isFinite(currentIndex) || currentIndex < 0 || currentIndex >= ids.length) currentIndex = 0;
      const position = Math.max(0, parseInt(getParam(req, 'position') || '0', 10) || 0);
      await setUserSetting(ctx.userId, PLAYQUEUE_SETTING_KEY, {
        ids,
        currentIndex,
        position,
        changed: new Date().toISOString(),
        changedBy: getParam(req, 'c') || DEFAULT_CLIENT,
      });
      return sendSubsonic(req, res, subsonicSuccess({}));
    }
    case 'getplayqueue':
    case 'getplayqueuebyindex': {
      const saved = await getUserSetting(ctx.userId, PLAYQUEUE_SETTING_KEY);
      if (!saved || !Array.isArray(saved.ids) || saved.ids.length === 0) {
        // No saved queue → empty success, per spec.
        return sendSubsonic(req, res, subsonicSuccess({}));
      }
      const rows = await fetchOrderedTracks(saved.ids, ctx.userId);
      if (rows.length === 0) return sendSubsonic(req, res, subsonicSuccess({}));
      // Keep `current` pointing at the right track even if some queue entries
      // were deleted from the library since the queue was saved.
      const savedIndex = Math.min(Math.max(0, Number(saved.currentIndex) || 0), saved.ids.length - 1);
      const currentInternalId = saved.ids[savedIndex];
      const survivingIds = rows.map((r: any) => r.id);
      const currentIndex = Math.max(0, survivingIds.indexOf(currentInternalId));
      const common = {
        position: Math.max(0, Number(saved.position) || 0),
        username: ctx.username,
        changed: typeof saved.changed === 'string' ? saved.changed : new Date().toISOString(),
        changedBy: saved.changedBy || DEFAULT_CLIENT,
        entry: rows.map((row: any) => mapTrackToSubsonic(row, ctx.userId)),
      };
      if (method === 'getplayqueuebyindex') {
        return sendSubsonic(req, res, subsonicSuccess({ playQueueByIndex: { currentIndex, ...common } }));
      }
      return sendSubsonic(req, res, subsonicSuccess({ playQueue: { current: subsonicSongId(survivingIds[currentIndex]), ...common } }));
    }
    default:
      return false;
  }
}

async function handleLyrics(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  switch (method) {
    case 'getlyricsbysongid': {
      const rawId = getParam(req, 'id') || '';
      const track = await getTrackRow(rawId, ctx.userId);
      let structured: Array<Record<string, unknown>> = [];
      if (track?.path) {
        try {
          const { fileBuf } = await resolvePlayableTrack(rawId, ctx.userId);
          if (fs.existsSync(fileBuf)) {
            const tags = await readEmbeddedLyrics(fileBuf);
            structured = buildStructuredLyrics(tags, track.artist || undefined, track.title || undefined);
          }
        } catch { /* missing/forbidden file → empty lyrics */ }
      }
      return sendSubsonic(req, res, subsonicSuccess(
        structured.length ? { lyricsList: { structuredLyrics: structured } } : { lyricsList: {} },
      ));
    }
    case 'getlyrics': {
      const artist = (getParam(req, 'artist') || '').trim();
      const title = (getParam(req, 'title') || '').trim();
      if (!artist && !title) return sendSubsonic(req, res, subsonicSuccess({ lyrics: {} }));
      const db = await initDB();
      const conds: string[] = ['path IS NOT NULL'];
      const params: unknown[] = [];
      if (title) { params.push(title); conds.push(`title ILIKE $${params.length}`); }
      if (artist) { params.push(artist); conds.push(`artist ILIKE $${params.length}`); }
      const row = (await db.query(`SELECT id, artist, title FROM tracks WHERE ${conds.join(' AND ')} LIMIT 1`, params)).rows[0];
      let value = '';
      if (row?.id) {
        try {
          const { fileBuf } = await resolvePlayableTrack(subsonicSongId(row.id), ctx.userId);
          if (fs.existsSync(fileBuf)) {
            const tags = await readEmbeddedLyrics(fileBuf);
            const tag = tags.find((t: any) => t?.text && String(t.text).trim())
              || tags.find((t: any) => Array.isArray(t?.syncText) && t.syncText.length > 0);
            if (tag?.text) value = String(tag.text);
            else if (tag?.syncText) value = tag.syncText.map((l: any) => String(l?.text ?? '')).join('\n');
          }
        } catch { /* ignore */ }
      }
      return sendSubsonic(req, res, subsonicSuccess({
        lyrics: { artist: row?.artist || artist || undefined, title: row?.title || title || undefined, value },
      }));
    }
    default:
      return false;
  }
}

async function dispatch(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  if (await handleSystem(req, res, method, ctx) !== false) return;
  if (method === 'stream') return streamFile(req, res, getParam(req, 'id') || '', ctx.userId, false);
  if (method === 'download') return streamFile(req, res, getParam(req, 'id') || '', ctx.userId, true);
  if (method === 'getcoverart') return sendCoverArt(req, res, getParam(req, 'id') || '', ctx.userId);
  if (method === 'hls') return sendHls(req, res, getParam(req, 'id') || '', ctx);
  if (method === 'hlssegment') return sendHlsSegment(req, res, getParam(req, 'id') || '');
  if (await handleBrowsing(req, res, method, ctx) !== false) return;
  if (await handleLists(req, res, method, ctx) !== false) return;
  if (await handlePlaylists(req, res, method, ctx) !== false) return;
  if (await handleAnnotations(req, res, method, ctx) !== false) return;
  if (await handleQueue(req, res, method, ctx) !== false) return;
  if (await handleLyrics(req, res, method, ctx) !== false) return;
  if (method === 'getnowplaying') return sendSubsonic(req, res, subsonicSuccess({ nowPlaying: { entry: [] } }));
  if (method === 'getartistinfo') return sendSubsonic(req, res, subsonicSuccess({ artistInfo: {} }));
  if (method === 'getartistinfo2') return sendSubsonic(req, res, subsonicSuccess({ artistInfo2: {} }));
  if (method === 'getalbuminfo') return sendSubsonic(req, res, subsonicSuccess({ albumInfo: {} }));
  if (method === 'getalbuminfo2') return sendSubsonic(req, res, subsonicSuccess({ albumInfo2: {} }));
  if (method === 'gettopsongs') return sendSubsonic(req, res, subsonicSuccess({ topSongs: { song: [] } }));
  if (EMPTY_STUB_PAYLOADS[method]) return sendSubsonic(req, res, subsonicSuccess(EMPTY_STUB_PAYLOADS[method]));
  sendError(req, res, 70, `Unsupported OpenSubsonic endpoint: ${method}`);
}

router.all('/:method', subsonicRateLimiter, async (req, res) => {
  const method = normalizeMethod(String(req.params.method));
  try {
    if (!(await isOpenSubsonicEnabled())) {
      writeSubsonicLog(`disabled method=${method} ${clientInfo(req)}`);
      return sendError(req, res, 50, 'OpenSubsonic API is disabled by the server administrator.', 503);
    }

    // Spec-required public endpoints (currently only getOpenSubsonicExtensions)
    // are served before authentication so clients can discover apiKey auth
    // support before they have any way to log in. Without this, Symfonium can't
    // detect apiKeyAuthentication, falls back to token/password auth (which
    // Aurora can't support), and the sync fails to initiate.
    if (PUBLIC_SUBSONIC_METHODS.has(method)) {
      writeSubsonicLog(`public method=${method} ${clientInfo(req)} ${authParamShape(req)}`);
      return sendSubsonic(req, res, subsonicSuccess(openSubsonicExtensionsPayload()));
    }
    const auth = method === 'hlssegment'
      ? await authenticateHlsSegment(req)
      : await authenticateSubsonic(req);
    if (auth.error || !auth.ctx) {
      writeSubsonicLog(`auth_error method=${method} code=${auth.error?.code || 44} ${clientInfo(req)} ${authParamShape(req)} message=${auth.error?.message || 'Authentication failed'}`);
      return sendError(req, res, auth.error?.code || 44, auth.error?.message || 'Authentication failed');
    }
    await dispatch(req, res, method, auth.ctx);
  } catch (error: any) {
    console.error(`[Subsonic] ${method} error:`, error?.message || error);
    writeSubsonicLog(`error method=${method} message=${String(error?.message || error).slice(0, 300)}`);
    if (res.headersSent) return;
    if (error?.status === 404) return res.status(404).send('Not found');
    if (error?.status === 403) return res.status(403).send('Forbidden');
    sendError(req, res, 70, error?.message || 'Subsonic request failed');
  }
});

export default router;
