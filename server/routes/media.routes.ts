import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import * as mm from 'music-metadata';
import { isPathAllowed, pathToBuffer } from '../state';
import { initDB, getArtworkInfoForPath, getTrackLoudnessByIds, getAlbumLoudness } from '../database';
import { maybeMeasureLoudnessForUser } from '../services/loudness.service';
import { artCachePath, isValidArtSize, DEFAULT_ART_SIZE, resolveArtwork, ARTWORK_EXTRACTION_VERSION, type ArtSize } from '../services/artCache';
import { providerArtworkProxyPath, resolveProviderArtworkUrl } from '../services/artworkFallback.service';
import {
  completeVodPlaylist,
  getOrCreateHlsSession,
  getSessionInfo,
  touchSession,
  getSessionOutputDir,
  getActiveSessionVariants,
} from '../services/hlsStream.service';
import {
  buildAdaptiveLadder,
  buildAdaptiveMasterPlaylist,
  getAdaptiveHlsSessionInfo,
  getAdaptiveSegmentPath,
  getOrCreateAdaptiveHlsSession,
  parseAdaptiveLadder,
  parseAdaptiveMaxBitrate,
  rewriteAdaptiveMediaPlaylistSegments,
  serializeAdaptiveLadder,
  touchAdaptiveHlsSession,
  type AdaptiveRendition,
  type AdaptiveRenditionName,
} from '../services/adaptiveHlsStream.service';
import { writeCastReceiverLog, writeHlsServerLog, writeHlsSessionLog } from '../services/debugLogger.service';
import { logHls, logFfmpeg } from '../services/loggingConfig';
import { createRateLimiter } from '../middleware/rateLimit';

const router = Router();

// Media routes serve streaming/HLS segments and album art — hot paths hit many
// times per playback — so the ceiling is generous, sized to stop abuse without
// throttling normal listening.
router.use(createRateLimiter({
  keyPrefix: 'media',
  windowMs: 60 * 1000,
  max: 1800,
  message: 'Too many media requests. Try again later.',
}));
const HLS_SEGMENT_LINE = /^(segment\d+\.ts)$/gm;
const HLS_MEDIA_PLAYLIST_NAME = 'media.m3u8';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mime type map
const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
};

// CORS helper to handle authenticated requests and custom headers
const setCorsHeaders = (req: any, res: any) => {
  const origin = req.headers.origin;
  // If we have an allowed origin, echo it back instead of using '*' to allow
  // withCredentials/Authorization. Do not reflect arbitrary origins.
  if (origin && isAllowedMediaOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
};

function isAllowedMediaOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;

  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean)
    : ['http://localhost:3000'];
  if (process.env.CAST_RECEIVER_ORIGIN) allowedOrigins.push(process.env.CAST_RECEIVER_ORIGIN);

  const normalizedAllowedOrigins = new Set(
    allowedOrigins
      .map((value) => {
        try {
          const allowed = new URL(value);
          if (allowed.username || allowed.password || allowed.pathname !== '/' || allowed.search || allowed.hash) return null;
          return allowed.origin;
        } catch {
          return null;
        }
      })
      .filter((value): value is string => Boolean(value))
  );

  if (normalizedAllowedOrigins.has(parsed.origin)) return true;

  return parsed.origin === 'https://www.gstatic.com' || parsed.origin === 'https://cast.google.com';
}

// ─── HLS Streaming ─────────────────────────────────────────────────────

function validateHlsPlaylist(playlist: string): { valid: boolean; error?: string } {
  if (!playlist.startsWith('#EXTM3U')) {
    return { valid: false, error: 'Playlist is missing #EXTM3U header' };
  }

  const lines = playlist.split(/\r?\n/);
  const singleInstanceTags = [
    '#EXT-X-TARGETDURATION:',
    '#EXT-X-MEDIA-SEQUENCE:',
    '#EXT-X-PLAYLIST-TYPE:',
    '#EXT-X-VERSION:',
    '#EXT-X-ENDLIST',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  for (const tag of singleInstanceTags) {
    const count = lines.filter((line) => line === tag || line.startsWith(tag)).length;
    if (count > 1) {
      return { valid: false, error: `Playlist contains duplicate ${tag.replace(/:$/, '')} tags` };
    }
  }

  const targetDurationLine = lines.find((line) => line.startsWith('#EXT-X-TARGETDURATION:'));
  if (!targetDurationLine) {
    return { valid: false, error: 'Playlist is missing EXT-X-TARGETDURATION' };
  }

  const targetDuration = parseInt(targetDurationLine.split(':')[1] || '', 10);
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    return { valid: false, error: 'Playlist has invalid EXT-X-TARGETDURATION' };
  }

  for (const line of lines) {
    if (!line.startsWith('#EXTINF:')) continue;
    const durationValue = parseFloat(line.slice('#EXTINF:'.length).split(',')[0] || '');
    if (!Number.isFinite(durationValue)) {
      return { valid: false, error: 'Playlist has invalid EXTINF duration' };
    }
    if (Math.round(durationValue) > targetDuration) {
      return { valid: false, error: 'EXTINF exceeds EXT-X-TARGETDURATION' };
    }
  }

  return { valid: true };
}

function inferCodecString(codec: string): string {
  switch (codec) {
    case 'aac':
    case 'aac_he':
      return 'mp4a.40.2';
    case 'mp3':
      return 'mp4a.69';
    case 'ac3':
      return 'ac-3';
    case 'eac3':
      return 'ec-3';
    default:
      return 'mp4a.40.2';
  }
}

function inferBandwidth(quality: string, codec: string, sourceBitrate?: number | null): number {
  if (quality === 'source') {
    if (codec === 'aac' || codec === 'aac_he') {
      return sourceBitrate && Number.isFinite(sourceBitrate) && sourceBitrate > 0
        ? Math.min(sourceBitrate, 320000)
        : 320000;
    }
    return sourceBitrate && Number.isFinite(sourceBitrate) && sourceBitrate > 0
      ? sourceBitrate
      : 320000;
  }

  const parsed = parseInt(quality, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed * 1000;
  }
  return 192000;
}

function buildMasterPlaylist(trackId: string, quality: string, codec: string, token?: string, sourceBitrate?: number | null): string {
  const params = new URLSearchParams({
    quality,
    codec,
  });
  if (token) params.set('token', token);

  const codecString = inferCodecString(codec);
  const averageBandwidth = inferBandwidth(quality, codec, sourceBitrate);
  const bandwidth = Math.round(averageBandwidth * 1.15);

  return [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${averageBandwidth},CODECS="${codecString}"`,
    `${HLS_MEDIA_PLAYLIST_NAME}?${params.toString()}`,
    '',
  ].join('\n');
}

function rewriteMediaPlaylistSegments(playlist: string, quality: string, codec: string, token?: string): string {
  const segmentSuffix = `?quality=${encodeURIComponent(quality)}&codec=${encodeURIComponent(codec)}`
    + (token ? `&token=${encodeURIComponent(token)}` : '');

  return playlist.replace(
    HLS_SEGMENT_LINE,
    `$1${segmentSuffix}`
  );
}

const SEGMENT_WAIT_TIMEOUT_MS = 30000;
const SEGMENT_WAIT_POLL_MS = 50;

/**
 * A synthesized VOD playlist lets the player ask for a segment FFmpeg has not
 * produced yet. FFmpeg writes the segment file *before* appending it to the
 * playlist, so file existence alone would happily serve a half-written segment;
 * "listed in the playlist" is the only completeness signal available. Hold the
 * request until the segment is listed, the session finishes without it, or the
 * timeout expires.
 */
async function waitForSegmentListed(
  playlistPath: string,
  segmentName: string,
  isFinished: () => boolean,
): Promise<boolean> {
  const isListed = (): boolean => {
    try {
      if (!fs.existsSync(playlistPath)) return false;
      return fs.readFileSync(playlistPath, 'utf8')
        .split(/\r?\n/)
        .some((line) => line.trim() === segmentName);
    } catch {
      return false; // playlist mid-write
    }
  };

  const deadline = Date.now() + SEGMENT_WAIT_TIMEOUT_MS;
  for (;;) {
    if (isListed()) return true;
    // Re-check after observing completion: the final segment and the finished
    // flag can land between two polls.
    if (isFinished()) return isListed();
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, SEGMENT_WAIT_POLL_MS));
  }
}

async function resolveTrackForHls(trackId: string, userId?: string): Promise<{
  fileBuf: Buffer;
  bitrate: number | null;
  sourceFormat: string | null;
  sourceLossless: boolean | null;
  duration: number | null;
}> {
  let fileBuf: Buffer;
  let bitrate: number | null = null;
  let sourceFormat: string | null = null;
  let sourceLossless: boolean | null = null;
  let duration: number | null = null;
  let resolvedId: string | null = null;

  if (UUID_REGEX.test(trackId)) {
    const db = await initDB();
    const result = await db.query('SELECT path, bitrate, format, lossless, duration FROM tracks WHERE id = $1', [trackId]);
    if (result.rows.length === 0) {
      const err = new Error('Track not found') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    fileBuf = pathToBuffer(result.rows[0].path);
    bitrate = result.rows[0].bitrate;
    sourceFormat = result.rows[0].format;
    sourceLossless = typeof result.rows[0].lossless === 'boolean' ? result.rows[0].lossless : null;
    duration = Number.isFinite(Number(result.rows[0].duration)) ? Number(result.rows[0].duration) : null;
    resolvedId = trackId;
  } else {
    const dbPath = Buffer.from(decodeURIComponent(trackId), 'base64').toString();
    fileBuf = pathToBuffer(dbPath);

    try {
      const db = await initDB();
      const result = await db.query('SELECT id, bitrate, format, lossless, duration FROM tracks WHERE path = $1', [dbPath]);
      if (result.rows.length > 0) {
        resolvedId = result.rows[0].id;
        bitrate = result.rows[0].bitrate;
        sourceFormat = result.rows[0].format;
        sourceLossless = typeof result.rows[0].lossless === 'boolean' ? result.rows[0].lossless : null;
        duration = Number.isFinite(Number(result.rows[0].duration)) ? Number(result.rows[0].duration) : null;
      }
    } catch { /* non-critical */ }
  }

  const allowed = await isPathAllowed(fileBuf);
  if (!allowed) {
    const err = new Error('Forbidden: Path is outside allowed library directories') as Error & { status?: number };
    err.status = 403;
    throw err;
  }

  // Precompute loudness for this track (background, deduped, gated on the user's
  // opt-in). Playback resolution is the chokepoint that covers HLS *and* the
  // direct/Subsonic paths; this never blocks the response.
  if (userId && resolvedId) {
    void maybeMeasureLoudnessForUser(userId, resolvedId, fileBuf.toString('utf8'));
  }

  return { fileBuf, bitrate, sourceFormat, sourceLossless, duration };
}

function normalizeTargetCodec(codec: string, quality: string): string {
  if ((codec === 'ac3' || codec === 'eac3') && quality !== 'source' && parseInt(quality, 10) < 256) {
    logHls(`[HLS] Overriding ${codec} → AAC (${quality} too low for AC-3)`);
    return 'aac';
  }
  return codec;
}

async function ensureHlsSessionForRequest(trackId: string, quality: string, targetCodec: string, userId?: string) {
  const { fileBuf, bitrate, sourceFormat, duration } = await resolveTrackForHls(trackId, userId);
  const codec = normalizeTargetCodec(targetCodec, quality);
  await getOrCreateHlsSession(trackId, fileBuf, quality, bitrate, sourceFormat, codec);
  return {
    codec,
    durationSec: duration,
    sessionInfo: getSessionInfo(trackId, quality, codec),
  };
}

function isAllowedAdaptiveLadder(requested: AdaptiveRendition[], full: AdaptiveRendition[]): boolean {
  if (requested.length === 0 || requested.length > full.length) return false;
  return requested.every((rendition, index) => rendition.name === full[index]?.name);
}

async function ensureAdaptiveHlsSessionForRequest(
  trackId: string,
  requestedLadder: AdaptiveRendition[] | null,
  maxBitrateKbps: number | null,
  userId?: string,
) {
  const track = await resolveTrackForHls(trackId, userId);
  const fullLadder = buildAdaptiveLadder(track.bitrate, track.sourceFormat, track.sourceLossless);
  const ladder = requestedLadder
    ?? buildAdaptiveLadder(track.bitrate, track.sourceFormat, track.sourceLossless, maxBitrateKbps);
  if (!isAllowedAdaptiveLadder(ladder, fullLadder)) {
    const error = new Error('Invalid adaptive rendition ladder') as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  const sessionInfo = await getOrCreateAdaptiveHlsSession(trackId, track.fileBuf, ladder, 'aac');
  return { ladder, sessionInfo, durationSec: track.duration };
}

function sanitizeCastLogValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/([?&]token=)[^&\s]+/g, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token":"[redacted]"')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt-redacted]')
    .slice(0, 2000);
}

router.post('/cast/log', (req, res) => {
  const source = sanitizeCastLogValue(typeof req.body?.source === 'string' ? req.body.source : 'receiver');
  const level = sanitizeCastLogValue(typeof req.body?.level === 'string' ? req.body.level : 'info');
  const message = sanitizeCastLogValue(typeof req.body?.message === 'string' ? req.body.message : '');
  const detail = sanitizeCastLogValue(typeof req.body?.detail === 'string' ? req.body.detail : '');
  const session = sanitizeCastLogValue(typeof req.body?.session === 'string' ? req.body.session : '');

  writeCastReceiverLog(`[${level}] [${source}]${session ? ` [${session}]` : ''} ${message}${detail ? ` :: ${detail}` : ''}`);
  res.sendStatus(204);
});

// Loudness for the client's gain stage. Returns BOTH per-track and per-album
// loudness so the client can switch track/album mode instantly with no refetch.
// Missing ids (not yet measured) return null and are opportunistically queued
// for background measurement (gated on the user's opt-in, deduped).
router.get('/loudness', async (req, res) => {
  try {
    const userId = (req as any).user?.userId as string | undefined;
    const ids = Array.from(new Set(String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean))).slice(0, 500);
    if (ids.length === 0) return res.json({});

    const db = await initDB();
    const metaRes = await db.query('SELECT id, path, album_id FROM tracks WHERE id = ANY($1)', [ids]);
    const meta = new Map<string, { path: string; albumId: string | null }>();
    for (const r of metaRes.rows as any[]) meta.set(r.id, { path: r.path, albumId: r.album_id });

    const trackLoud = await getTrackLoudnessByIds(ids);
    const trackMap = new Map(trackLoud.map((r) => [r.track_id, { lufs: r.loudness_lufs, truePeakDbfs: r.true_peak_dbfs }]));

    // Memoize album loudness per album so co-album tracks don't recompute it.
    const albumCache = new Map<string, { lufs: number; truePeakDbfs: number } | null>();
    const albumFor = async (albumId: string | null) => {
      if (!albumId) return null;
      if (!albumCache.has(albumId)) albumCache.set(albumId, await getAlbumLoudness(albumId));
      return albumCache.get(albumId) ?? null;
    };

    const out: Record<string, { track: unknown; album: unknown }> = {};
    for (const id of ids) {
      const m = meta.get(id);
      const track = trackMap.get(id) ?? null;
      out[id] = { track, album: m ? await albumFor(m.albumId) : null };
      if (!track && userId && m?.path) {
        void maybeMeasureLoudnessForUser(userId, id, pathToBuffer(m.path).toString('utf8'));
      }
    }
    res.json(out);
  } catch (e) {
    console.error('[Loudness] /api/loudness error', (e as Error).message);
    res.status(500).json({ error: 'Failed to load loudness' });
  }
});

// Serve HLS playlist for a track
router.all('/stream/:trackId/playlist.m3u8', async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const { trackId } = req.params;
  const quality = (req.query.quality as string) || '128k';
  let targetCodec = (req.query.codec as string) || 'aac'; // safe universal default

  try {
    const token = req.query.token as string | undefined;
    const { bitrate, sourceFormat, sourceLossless } = await resolveTrackForHls(trackId, (req as any).user?.userId);
    let output: string;
    if (quality === 'auto') {
      targetCodec = 'aac';
      const maxBitrateKbps = parseAdaptiveMaxBitrate(req.query.maxBitrate);
      const ladder = buildAdaptiveLadder(bitrate, sourceFormat, sourceLossless, maxBitrateKbps);
      output = buildAdaptiveMasterPlaylist(ladder, targetCodec, token);
      writeHlsServerLog(`[playlist ${trackId} auto ${targetCodec}] Served adaptive master ladder=${serializeAdaptiveLadder(ladder)}`);
      writeHlsSessionLog(trackId, `auto-${serializeAdaptiveLadder(ladder)}`, targetCodec, `Served adaptive master playlist: ${output.split(/\r?\n/).join('\\n')}`);
    } else {
      output = buildMasterPlaylist(trackId, quality, targetCodec, token, bitrate);
      writeHlsServerLog(`[playlist ${trackId} ${quality} ${targetCodec}] Served master playlist`);
      writeHlsSessionLog(trackId, quality, targetCodec, `Served master playlist: ${output.split(/\r?\n/).join('\\n')}`);
    }
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(output);
  } catch (err: any) {
    console.error('[HLS] Playlist error:', err?.message || err);
    writeHlsServerLog(`[playlist ${trackId} ${quality} ${targetCodec}] Error: ${err?.message || String(err)}`);
    if (!res.headersSent) {
      if (err?.code === 'ENOENT' || err?.message?.includes('ENOENT')) {
        res.status(501).send('FFmpeg not installed — HLS streaming unavailable');
      } else if (err?.status === 403) {
        res.status(403).send('Forbidden');
      } else {
        res.status(500).send('HLS streaming error');
      }
    }
  }
});

router.all('/stream/:trackId/media.m3u8', async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const { trackId } = req.params;
  const quality = (req.query.quality as string) || '128k';
  let targetCodec = (req.query.codec as string) || 'aac';

  try {
    if (req.query.adaptive === '1') {
      targetCodec = 'aac';
      const ladder = parseAdaptiveLadder(String(req.query.ladder || ''));
      const rendition = String(req.query.rendition || '') as AdaptiveRenditionName;
      if (!ladder || !ladder.some((item) => item.name === rendition)) {
        return res.status(400).send('Invalid adaptive rendition request');
      }
      const ensured = await ensureAdaptiveHlsSessionForRequest(
        trackId,
        ladder,
        null,
        (req as any).user?.userId,
      );
      const renditionInfo = ensured.sessionInfo.renditions.find((item) => item.name === rendition);
      if (!renditionInfo || !fs.existsSync(renditionInfo.playlistPath)) {
        writeHlsServerLog(`[adaptive-media ${trackId} ${ensured.sessionInfo.ladderKey} ${rendition}] Playlist missing`);
        return res.status(500).send('Adaptive HLS media playlist generation failed');
      }

      const token = req.query.token as string | undefined;
      const rawPlaylist = fs.readFileSync(renditionInfo.playlistPath, 'utf8');
      const completedPlaylist = ensured.sessionInfo.finished
        ? null
        : completeVodPlaylist(rawPlaylist, ensured.durationSec);
      const output = rewriteAdaptiveMediaPlaylistSegments(completedPlaylist ?? rawPlaylist, ensured.ladder, rendition, targetCodec, token);
      const validation = validateHlsPlaylist(output);
      if (!validation.valid) {
        writeHlsServerLog(`[adaptive-media ${trackId} ${ensured.sessionInfo.ladderKey} ${rendition}] Invalid playlist: ${validation.error}`);
        return res.status(500).send(`Invalid HLS playlist: ${validation.error}`);
      }

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', ensured.sessionInfo.finished ? 'public, max-age=30' : 'no-cache');
      touchAdaptiveHlsSession(trackId, ensured.ladder, targetCodec);
      writeHlsServerLog(`[adaptive-media ${trackId} ${ensured.sessionInfo.ladderKey} ${rendition}] Served ${renditionInfo.segmentCount} segments`);
      return res.send(output);
    }

    if (quality === 'auto') {
      return res.status(400).send('Adaptive HLS rendition marker is required');
    }

    const ensured = await ensureHlsSessionForRequest(trackId, quality, targetCodec, (req as any).user?.userId);
    targetCodec = ensured.codec;
    const sessionInfo = ensured.sessionInfo;

    if (!sessionInfo || !fs.existsSync(sessionInfo.playlistPath)) {
      writeHlsServerLog(`[media-playlist ${trackId} ${quality} ${targetCodec}] Session ready but playlist path missing`);
      return res.status(500).send('HLS media playlist generation failed');
    }

    const token = req.query.token as string | undefined;
    const rawPlaylist = fs.readFileSync(sessionInfo.playlistPath, 'utf8');
    const completedPlaylist = sessionInfo.finished
      ? null
      : completeVodPlaylist(rawPlaylist, ensured.durationSec);
    if (completedPlaylist) {
      writeHlsSessionLog(trackId, quality, targetCodec, `Completed partial playlist to VOD (duration=${ensured.durationSec}s)`);
    }
    const output = rewriteMediaPlaylistSegments(completedPlaylist ?? rawPlaylist, sessionInfo.quality, sessionInfo.codec, token);

    const validation = validateHlsPlaylist(output);
    if (!validation.valid) {
      console.error('[HLS] Invalid playlist generated:', validation.error);
      writeHlsServerLog(`[media-playlist ${trackId} ${quality} ${targetCodec}] Invalid playlist: ${validation.error}`);
      writeHlsSessionLog(trackId, quality, targetCodec, `Invalid media playlist: ${validation.error}`);
      return res.status(500).send(`Invalid HLS playlist: ${validation.error}`);
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', sessionInfo.finished ? 'public, max-age=30' : 'no-cache');
    writeHlsServerLog(`[media-playlist ${trackId} ${quality} ${targetCodec}] Served media playlist with ${sessionInfo.segmentCount} segments; finished=${sessionInfo.finished}`);
    writeHlsSessionLog(trackId, quality, targetCodec, `Served media playlist snapshot: ${output.split(/\r?\n/).slice(0, 20).join('\\n')}`);
    res.send(output);
  } catch (err: any) {
    console.error('[HLS] Media playlist error:', err?.message || err);
    writeHlsServerLog(`[media-playlist ${trackId} ${quality} ${targetCodec}] Error: ${err?.message || String(err)}`);
    if (!res.headersSent) {
      if (err?.code === 'ENOENT' || err?.message?.includes('ENOENT')) {
        res.status(501).send('FFmpeg not installed — HLS streaming unavailable');
      } else if (err?.status === 403) {
        res.status(403).send('Forbidden');
      } else if (err?.status === 404) {
        res.status(404).send('Track not found');
      } else {
        res.status(500).send('HLS streaming error');
      }
    }
  }
});

router.all('/stream/:trackId/prewarm', async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (req.method !== 'POST' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'POST, HEAD, OPTIONS');
    return res.status(405).send('Method not allowed');
  }

  const { trackId } = req.params;
  const quality = (req.query.quality as string) || '128k';
  let targetCodec = (req.query.codec as string) || 'aac';

  try {
    if (quality === 'auto') {
      targetCodec = 'aac';
      const maxBitrateKbps = parseAdaptiveMaxBitrate(req.query.maxBitrate);
      const ensured = await ensureAdaptiveHlsSessionForRequest(
        trackId,
        null,
        maxBitrateKbps,
        (req as any).user?.userId,
      );
      const renditions = ensured.sessionInfo.renditions.map((rendition) => ({
        name: rendition.name,
        bitrateKbps: rendition.bitrateKbps,
        segmentCount: rendition.segmentCount,
      }));
      const segmentCount = renditions.length > 0
        ? Math.min(...renditions.map((rendition) => rendition.segmentCount))
        : 0;
      touchAdaptiveHlsSession(trackId, ensured.ladder, targetCodec);
      writeHlsServerLog(`[prewarm ${trackId} auto ${targetCodec}] Adaptive ladder=${ensured.sessionInfo.ladderKey}; renditions=${renditions.length}; minSegments=${segmentCount}`);

      if (req.method === 'HEAD') return res.sendStatus(204);
      return res.json({
        ok: true,
        trackId,
        quality,
        codec: targetCodec,
        segmentCount,
        finished: ensured.sessionInfo.finished,
        renditions,
      });
    }

    const ensured = await ensureHlsSessionForRequest(trackId, quality, targetCodec, (req as any).user?.userId);
    targetCodec = ensured.codec;
    const sessionInfo = ensured.sessionInfo;

    if (!sessionInfo || !fs.existsSync(sessionInfo.playlistPath)) {
      writeHlsServerLog(`[prewarm ${trackId} ${quality} ${targetCodec}] Session ready but playlist path missing`);
      return res.status(500).json({ ok: false, error: 'HLS prewarm failed' });
    }

    touchSession(trackId, quality, targetCodec);
    writeHlsServerLog(`[prewarm ${trackId} ${quality} ${targetCodec}] Ready with ${sessionInfo.segmentCount} segments; finished=${sessionInfo.finished}`);
    writeHlsSessionLog(trackId, quality, targetCodec, `Prewarm ready: segments=${sessionInfo.segmentCount}; finished=${sessionInfo.finished}`);

    if (req.method === 'HEAD') {
      return res.sendStatus(204);
    }

    res.json({
      ok: true,
      trackId,
      quality,
      codec: targetCodec,
      segmentCount: sessionInfo.segmentCount,
      finished: sessionInfo.finished,
    });
  } catch (err: any) {
    console.error('[HLS] Prewarm error:', err?.message || err);
    writeHlsServerLog(`[prewarm ${trackId} ${quality} ${targetCodec}] Error: ${err?.message || String(err)}`);
    if (err?.code === 'ENOENT' || err?.message?.includes('ENOENT')) {
      return res.status(501).json({ ok: false, error: 'FFmpeg not installed — HLS streaming unavailable' });
    }
    if (err?.status === 403) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    if (err?.status === 404) {
      return res.status(404).json({ ok: false, error: 'Track not found' });
    }
    res.status(500).json({ ok: false, error: 'HLS prewarm error' });
  }
});

// Serve individual HLS segments (.ts files)
router.all('/stream/:trackId/:segment', async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const { trackId, segment } = req.params;
  const quality = (req.query.quality as string) || '128k';
  const codec = (req.query.codec as string) || 'aac';

  // Restrict both fixed and adaptive requests to one bare transport-stream
  // filename so no request can escape its exact session/rendition directory.
  if (!/^[\w.-]+\.ts$/.test(segment) || segment.includes('..')) {
    return res.status(400).send('Invalid segment request');
  }

  if (req.query.adaptive === '1') {
    const ladder = parseAdaptiveLadder(String(req.query.ladder || ''));
    const rendition = String(req.query.rendition || '');
    if (!ladder || !ladder.some((item) => item.name === rendition) || codec !== 'aac') {
      return res.status(400).send('Invalid adaptive segment request');
    }
    const segmentPath = getAdaptiveSegmentPath(trackId, ladder, codec, rendition, segment);
    if (!segmentPath) {
      return res.status(404).send('No exact adaptive HLS session for this segment');
    }
    const renditionPlaylistPath = path.join(path.dirname(segmentPath), 'playlist.m3u8');
    const segmentReady = await waitForSegmentListed(
      renditionPlaylistPath,
      segment,
      () => getAdaptiveHlsSessionInfo(trackId, ladder, codec)?.finished ?? true,
    );
    if (!segmentReady || !fs.existsSync(segmentPath)) {
      writeHlsSessionLog(trackId, `auto-${serializeAdaptiveLadder(ladder)}`, codec, `Adaptive segment never appeared: ${rendition}/${segment}`);
      return res.status(404).send('Adaptive segment not found');
    }
    const stat = fs.statSync(segmentPath);
    touchAdaptiveHlsSession(trackId, ladder, codec);
    writeHlsSessionLog(trackId, `auto-${serializeAdaptiveLadder(ladder)}`, codec, `Serving ${rendition}/${segment} (${stat.size} bytes)`);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return fs.createReadStream(segmentPath).pipe(res);
  }

  logHls(`[HLS DEBUG] Segment request: trackId=${trackId} segment=${segment} quality=${quality} codec=${codec}`);
  writeHlsSessionLog(trackId, quality, codec, `Segment request for ${segment}`);

  const outputDir = getSessionOutputDir(trackId, quality, codec);

  if (!outputDir) {
    logHls(`[HLS DEBUG] No exact session for trackId=${trackId}; active variants=${JSON.stringify(getActiveSessionVariants(trackId))}`);
    writeHlsSessionLog(trackId, quality, codec, `Missing exact session for ${segment}; active variants=${JSON.stringify(getActiveSessionVariants(trackId))}`);
    return res.status(404).send('No active HLS session for this track');
  }

  const segmentPath = path.join(outputDir, segment);
  const segmentReady = await waitForSegmentListed(
    path.join(outputDir, 'playlist.m3u8'),
    segment,
    () => getSessionInfo(trackId, quality, codec)?.finished ?? true,
  );
  if (!segmentReady || !fs.existsSync(segmentPath)) {
    logHls(`[HLS DEBUG] Segment not found: ${segmentPath}`);
    writeHlsSessionLog(trackId, quality, codec, `Segment missing on disk: ${segmentPath}`);
    return res.status(404).send('Segment not found');
  }

  logHls(`[HLS DEBUG] Serving segment: ${segmentPath}`);
  const stat = fs.statSync(segmentPath);
  writeHlsSessionLog(trackId, quality, codec, `Serving ${segment} (${stat.size} bytes) from ${segmentPath}`);

  // Touch the session to keep it alive
  touchSession(trackId, quality, codec);

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // Chunks never change
  fs.createReadStream(segmentPath).pipe(res);
});

// ─── Legacy Streaming ──────────────────────────────────────────────────

// Stream audio (supports Range requests)
router.all('/stream', async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  // Raw passthrough is only requested by source-quality playback (local
  // bit-perfect or Cast lossless), so this stays quiet in normal use. The UA
  // tells Cast-device fetches apart from browser ones when debugging casts.
  console.log(`[Stream] raw ${req.method} ua="${String(req.headers['user-agent'] || '').slice(0, 100)}" range=${String(req.headers.range || 'none')}`);

  const b64Path = req.query.pathB64 as string;
  const rawPath = req.query.path as string;

  if (!b64Path && !rawPath) {
    return res.status(400).send('Missing path parameter');
  }

  // pathB64 is the DB base64 path, URL-encoded by the frontend.
  // decodeURIComponent undoes the URL-encoding; the result is the raw DB base64 string.
  const dbPathStr = b64Path ? decodeURIComponent(b64Path) : rawPath;

  const fileBuf = pathToBuffer(dbPathStr);

  if (!fs.existsSync(fileBuf)) {
    return res.status(404).send('File not found');
  }

  const allowed = await isPathAllowed(fileBuf);
  if (!allowed) {
    return res.status(403).send('Forbidden: Path is outside allowed library directories');
  }

  const stat = fs.statSync(fileBuf);
  const fileSize = stat.size;
  const ext = path.extname(fileBuf.toString('utf8')).slice(1).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'audio/mpeg';

  if (mimeType === 'audio/x-ms-wma') {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'none');

    const ffmpeg = spawn('ffmpeg', [
      '-i', fileBuf.toString('utf8'),
      '-map', '0:a:0',
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-id3v2_version', '3',
      '-fflags', '+genpts',
      '-f', 'mp3',
      '-'
    ]);

    ffmpeg.stderr.on('data', (data) => {
      logFfmpeg('[FFmpeg]', data.toString());
    });

    ffmpeg.stdout.pipe(res);

    req.on('close', () => {
      ffmpeg.kill('SIGKILL');
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg spawn error:', err);
      if (!res.headersSent) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(501).send('FFmpeg not installed — WMA playback unavailable');
        } else {
          res.status(500).send('Transcoding error');
        }
      }
    });

    ffmpeg.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`FFmpeg process exited with code ${code} and signal ${signal}`);
      }
    });

    return;
  }

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(fileBuf, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mimeType,
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
    };
    res.writeHead(200, head);
    fs.createReadStream(fileBuf).pipe(res);
  }
});

const ART_IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function resolveArtSize(raw: unknown): ArtSize {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  return isValidArtSize(n) ? n : DEFAULT_ART_SIZE;
}

// Stream a pre-encoded AVIF cache file. Returns false (without touching the
// response) when the file is absent/empty so the caller can fall back.
function streamArtFile(res: any, filePath: string): boolean {
  try {
    if (fs.statSync(filePath).size === 0) return false;
  } catch {
    return false;
  }
  res.setHeader('Content-Type', 'image/avif');
  res.setHeader('Cache-Control', ART_IMMUTABLE_CACHE);
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// Album art. Two addressing modes:
//   ?hash=<contentHash>&size=256|640|1024  → serve the pre-encoded AVIF directly
//   ?pathB64=<base64 path>                 → resolve the track's art_hash, then
//                                            serve the cache file; falls back to
//                                            live raw extraction for tracks not
//                                            yet processed (pre-backfill).
router.get('/art', async (req, res) => {
  const size = resolveArtSize(req.query.size);
  const hashParam = typeof req.query.hash === 'string' ? req.query.hash : null;

  // ── Hash-addressed (the common, fast path) ──
  if (hashParam) {
    if (!/^[0-9a-f]{1,64}$/.test(hashParam)) return res.status(400).send('Bad hash');
    if (streamArtFile(res, artCachePath(hashParam, size))) return;
    return res.status(404).send('Not found');
  }

  const b64Path = req.query.pathB64 as string;
  const rawPath = req.query.path as string;
  if (!b64Path && !rawPath) return res.status(404).send('Not found');
  const dbPathStr = b64Path ? decodeURIComponent(b64Path) : rawPath;

  // ── Path-addressed: resolve the stored local art and album fallback ──
  const artworkInfo = await getArtworkInfoForPath(dbPathStr).catch(() => null);
  if (artworkInfo?.artHash) {
    if (streamArtFile(res, artCachePath(artworkInfo.artHash, size))) return;
    // Cache file vanished (cache dir cleared) → fall through to live extraction.
  }

  // ── Live raw extraction fallback ──
  const fileBuf = pathToBuffer(dbPathStr);
  if (!fs.existsSync(fileBuf)) {
    return res.status(404).send('Not found');
  }

  const allowed = await isPathAllowed(fileBuf);
  if (!allowed) {
    return res.status(403).send('Forbidden: Path is outside allowed library directories');
  }

  try {
    const utf8Path = fileBuf.toString('utf8');
    const shouldParseEmbedded = !artworkInfo ||
      artworkInfo.artHash === null ||
      artworkInfo.artworkVersion < ARTWORK_EXTRACTION_VERSION ||
      !!artworkInfo.artHash;
    const pictures = shouldParseEmbedded
      ? (await mm.parseFile(utf8Path, { duration: false })).common.picture
      : undefined;
    const artwork = await resolveArtwork(pictures, utf8Path);

    if (artwork) {
      res.setHeader('Content-Type', artwork.format);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(artwork.data);
    }
  } catch (err: any) {
    console.error('[Art] Error reading embedded art:', err?.message || err);
  }

  const providerUrl = artworkInfo
    ? await resolveProviderArtworkUrl({
        albumId: artworkInfo.albumId,
        album: artworkInfo.album,
        artist: artworkInfo.artist,
        mbAlbumId: artworkInfo.mbAlbumId,
        cachedImageUrl: artworkInfo.cachedImageUrl,
      }).catch((err) => {
        console.warn('[Art] Provider fallback failed:', err?.message || err);
        return undefined;
      })
    : undefined;
  if (providerUrl) return res.redirect(302, providerArtworkProxyPath(providerUrl));
  return res.status(404).send('No art found');
});

export default router;
