import {
  getSystemSetting,
  getArtistById,
  getTracksByArtist,
  incrementYoutubeApiUsage,
  getYoutubeApiUsage,
  getArtistVideosCache,
  getMusicVideosForArtist,
  getMusicVideoByTrackId,
  getTrackById,
  isCompilationArtistName,
  getArtistVideoUploads,
  saveArtistVideoCatalog,
  noteArtistVideoFailure,
  type VideoUpload,
} from '../database';
import { createHash } from 'node:crypto';
import { matchVideoUploads } from './youtubeMatching';
import { loadArtistVideoLinks } from './metadata/videoLinks';
import type { TrackVideoLookup } from '../../shared/musicVideos';

const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const USER_AGENT = 'AuroraMediaServer/1.0';

// Gentle spacing between calls. YouTube has no strict per-second cap (the real
// constraint is the daily quota), but we serialize to keep concurrent users
// from bursting.
const RATE_LIMIT_MS = 150;

// Distinct error class so route handlers can serve stale cache instead of a 502.
export class YoutubeBudgetError extends Error {
  constructor(message = 'Daily YouTube API quota budget exhausted') {
    super(message);
    this.name = 'YoutubeBudgetError';
  }
}

export class YoutubeConfigError extends Error {
  constructor(message = 'YouTube API key not configured') {
    super(message);
    this.name = 'YoutubeConfigError';
  }
}

// Google refused the key itself (invalid, restricted, API off, project
// suspended). It holds for every artist, so it is remembered server-wide.
export class YoutubeKeyRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YoutubeKeyRejectedError';
  }
}

// Reasons Google gives for the key or project rather than for one request.
const KEY_REJECTION_REASONS = new Set([
  'keyInvalid', 'keyExpired', 'accessNotConfigured', 'ipRefererBlocked',
  'API_KEY_INVALID', 'API_KEY_EXPIRED', 'ACCESS_DENIED', 'SERVICE_DISABLED', 'CONSUMER_INVALID',
  'API_KEY_SERVICE_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_ANDROID_APP_BLOCKED', 'API_KEY_IOS_APP_BLOCKED',
]);

export function classifyYoutubeError(status: number, body: string): Error {
  let error: any = null;
  try { error = JSON.parse(body)?.error ?? null; } catch { /* not JSON */ }
  const reasons: string[] = [
    ...(Array.isArray(error?.errors) ? error.errors : []),
    ...(Array.isArray(error?.details) ? error.details : []),
  ].map((entry: any) => entry?.reason).filter((reason: unknown): reason is string => typeof reason === 'string');
  const message = typeof error?.message === 'string' && error.message ? error.message : body.slice(0, 300);
  if (status === 403 && (/quota/i.test(body) || reasons.some(reason => /dailyLimitExceeded|rateLimitExceeded/.test(reason)))) {
    return new YoutubeBudgetError();
  }
  if ((status === 400 || status === 403) && reasons.some(reason => KEY_REJECTION_REASONS.has(reason))) {
    return new YoutubeKeyRejectedError(message);
  }
  return new Error(`YouTube HTTP ${status}: ${message}`);
}

// After a rejection, artist refreshes skip Google (and the quota counter) for a
// while; a key change, a successful call or Save & Test ends the pause.
const KEY_REJECTION_PAUSE_MS = 30 * 60_000;
// Holds the rejected key itself (in memory only, like every getApiKey() call)
// so that saving a different key ends the pause.
let keyRejection: { apiKey: string; message: string; at: number } | null = null;

function noteKeyRejected(apiKey: string, message: string) {
  if (keyRejection?.apiKey !== apiKey || keyRejection.message !== message) {
    console.warn(`[YouTube] Google rejected the API key: ${message}. Music videos are served from cache until the key works.`);
  }
  keyRejection = { apiKey, message, at: Date.now() };
}

function noteKeyAccepted() {
  if (!keyRejection) return;
  console.info('[YouTube] Google accepts the API key again.');
  keyRejection = null;
}

/** The current key's last rejection by Google, if any (for Settings → Metadata → YouTube). */
export async function getYoutubeKeyProblem(): Promise<{ message: string; since: string } | null> {
  const apiKey = await getApiKey();
  if (!apiKey || !keyRejection || keyRejection.apiKey !== apiKey) return null;
  return { message: keyRejection.message, since: new Date(keyRejection.at).toISOString() };
}

let lastRequestAt = 0;
let queueRunning = false;
type QueueItem = { fn: () => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void };
const queue: QueueItem[] = [];

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (queue.length > 0) {
    const wait = Math.max(0, RATE_LIMIT_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const item = queue.shift()!;
    lastRequestAt = Date.now();
    try {
      item.resolve(await item.fn());
    } catch (err) {
      item.reject(err);
    }
  }
  queueRunning = false;
}

async function getApiKey(): Promise<string> {
  // Read at call time, never at module load. Stored in system settings via the
  // Metadata tab (like the Genius key), not the environment.
  const key = await getSystemSetting('youtubeApiKey');
  return (typeof key === 'string' ? key : '').trim();
}

async function getCap(): Promise<number | null> {
  const hardStop = await getSystemSetting('youtubeHardStop');
  // Default ON. The YouTube Data API hard-fails at 10,000 units/day; capping
  // below that keeps us from spamming Google with over-quota errors.
  const enforce = hardStop === null ? true : !!hardStop;
  if (!enforce) return null;
  const raw = await getSystemSetting('youtubeDailyQuotaCap');
  const cap = typeof raw === 'number' && raw > 0 ? raw : 9000;
  return cap;
}

export async function isYouTubeEnabled(): Promise<boolean> {
  const enabled = await getSystemSetting('youtubeEnabled');
  if (!enabled) return false;
  if (!(await getApiKey())) return false;
  return true;
}

// Central fetch wrapper: budget check (pre-flight, by unit cost) + queue + rate
// limit + key injection. Cost: failed calls also tick the counter — acceptable
// against a daily quota.
async function ytFetch<T = any>(
  endpoint: string,
  params: Record<string, string | number | undefined> = {},
  units = 1,
  options: { force?: boolean } = {},
): Promise<T> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new YoutubeConfigError();
  if (!options.force && keyRejection?.apiKey === apiKey && Date.now() - keyRejection.at < KEY_REJECTION_PAUSE_MS) {
    throw new YoutubeKeyRejectedError(keyRejection.message);
  }

  const cap = await getCap();
  const newCount = await incrementYoutubeApiUsage({ cap, units });
  if (newCount === null) {
    throw new YoutubeBudgetError();
  }

  const url = new URL(`${YT_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  url.searchParams.set('key', apiKey);

  return new Promise<T>((resolve, reject) => {
    queue.push({
      fn: async () => {
        const res = await fetch(url.toString(), {
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          // Quota → budget error so callers serve cache; key problems pause all refreshes.
          const error = classifyYoutubeError(res.status, body);
          if (error instanceof YoutubeKeyRejectedError) noteKeyRejected(apiKey, error.message);
          throw error;
        }
        noteKeyAccepted();
        return res.json() as Promise<T>;
      },
      resolve,
      reject,
    });
    processQueue();
  });
}

// ─── Channel resolution from the artist's MusicBrainz YouTube link ──────

function parseArtistLinks(artist: any): { url: string; type: string }[] {
  const raw = artist?.links;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Validate the host properly rather than substring-matching "youtube.com":
// a bare `.includes('youtube.com')` would also accept hostile lookalikes like
// `https://youtube.com.evil.test` or `https://evil.test/?x=youtube.com`.
function isYouTubeHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com');
}

function findYouTubeUrl(links: { url: string; type: string }[]): string | null {
  for (const l of links) {
    const raw = (l?.url || '').trim();
    if (!raw) continue;
    try {
      const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      if (isYouTubeHost(u.hostname) && parseChannelUrl(u.toString())) return u.toString();
    } catch {
      // Skip malformed URLs.
    }
  }
  return null;
}

type ChannelRef =
  | { kind: 'id'; value: string }       // UC… channel id (0 API units)
  | { kind: 'handle'; value: string }   // @handle
  | { kind: 'username'; value: string } // legacy /user/NAME
  | null;

// Map a YouTube channel URL onto a lookup ref. Only the deterministic forms are
// supported (channel id / @handle / legacy user). /c/custom URLs would need a
// search (deliberately not done — channel-only, quota-cheap by design).
function parseChannelUrl(url: string): ChannelRef {
  let u: URL;
  try {
    u = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  if (parts[0].toLowerCase() === 'channel' && parts[1]) {
    return { kind: 'id', value: parts[1] };
  }
  if (parts[0].toLowerCase() === 'user' && parts[1]) {
    return { kind: 'username', value: parts[1] };
  }
  if (parts[0].startsWith('@')) {
    return { kind: 'handle', value: parts[0] };
  }
  // /c/CustomName — not resolvable without a search.
  return null;
}

// Resolve the artist to a YouTube channel id using only their MB link. Returns
// null (with a reason) when there's no resolvable channel link. `ready` is false
// only when the artist has NO links cached at all — likely MusicBrainz metadata
// just hasn't been fetched yet (the artist-data fetch races this one on first
// visit), so the caller should retry next time rather than caching a negative.
async function resolveArtistChannelId(artist: any): Promise<{ channelId: string | null; reason: string | null; ready: boolean }> {
  const links = parseArtistLinks(artist);
  if (links.length === 0) return { channelId: null, reason: 'Artist metadata not loaded yet', ready: false };

  const ytUrl = findYouTubeUrl(links);
  if (!ytUrl) return { channelId: null, reason: 'No YouTube channel link on this artist', ready: true };

  const ref = parseChannelUrl(ytUrl);
  if (!ref) return { channelId: null, reason: 'Unsupported YouTube channel URL form', ready: true };

  if (ref.kind === 'id') return { channelId: ref.value, reason: null, ready: true };

  const params: Record<string, string> = { part: 'id' };
  if (ref.kind === 'handle') params.forHandle = ref.value;
  else params.forUsername = ref.value;

  const data: any = await ytFetch('channels', params, 1);
  const channelId = data?.items?.[0]?.id || null;
  return { channelId, reason: channelId ? null : 'Channel link did not resolve', ready: true };
}

function pickThumbnail(thumbs: any): string | null {
  if (!thumbs) return null;
  const t = thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default;
  return t?.url || null;
}

// ─── Fetch + match a single artist's channel uploads ────────────────────

async function listChannelUploads(channelId: string, maxVideos: number): Promise<VideoUpload[]> {
  // 1 unit: resolve the channel's uploads playlist.
  const chData: any = await ytFetch('channels', { part: 'contentDetails', id: channelId }, 1);
  const uploadsPlaylist = chData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylist) return [];

  const videos: VideoUpload[] = [];
  let pageToken: string | undefined;
  let position = 0;
  // Up to 2 pages (100 uploads) keeps quota at ~3 units/artist while covering
  // the overwhelming majority of artists' official video output.
  for (let page = 0; page < 2; page++) {
    const data: any = await ytFetch('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: uploadsPlaylist,
      maxResults: 50,
      pageToken,
    }, 1);
    for (const item of (data?.items || [])) {
      const videoId = item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId;
      if (!videoId) continue;
      if (videos.some(video => video.videoId === videoId)) continue;
      videos.push({
        videoId,
        title: item?.snippet?.title || '',
        thumbnailUrl: pickThumbnail(item?.snippet?.thumbnails),
        publishedAt: item?.contentDetails?.videoPublishedAt || item?.snippet?.publishedAt || null,
        position: position++,
      });
      if (videos.length >= maxVideos) return videos;
    }
    pageToken = data?.nextPageToken;
    if (!pageToken) break;
  }
  return videos;
}

type RefreshResult = { refreshed: boolean; reason: string; retryAfterMs?: number };
const RETRY_MS = 60_000;
const artistRefreshes = new Map<string, Promise<RefreshResult>>();
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceKey = (artist: { links?: unknown; mbid?: string | null }, mbid: string | null) =>
  fingerprint({ mbid: artist.mbid || mbid, links: parseArtistLinks(artist).map(link => link.url).sort() });

// Both the artist rail and Now Playing share this work, including metadata
// resolution, local rematching, provider calls and retry cooldowns.
export function refreshArtistVideosIfStale(artistId: string, ttlDays?: number): Promise<RefreshResult> {
  const pending = artistRefreshes.get(artistId);
  if (pending) return pending;
  const refresh = refreshArtistVideosOnce(artistId, ttlDays).finally(() => artistRefreshes.delete(artistId));
  artistRefreshes.set(artistId, refresh);
  return refresh;
}

async function refreshArtistVideosOnce(artistId: string, ttlDays?: number): Promise<RefreshResult> {
  let artist = await getArtistById(artistId);
  if (!artist) return { refreshed: false, reason: 'no-artist' };
  const tracks = await getTracksByArtist(artistId);
  const mbid: string | null = artist.mbid || tracks.find(track => track.mbArtistId)?.mbArtistId || null;
  let source = sourceKey(artist, mbid);
  const libraryKey = fingerprint(['v1', tracks.map(track => [track.id, track.title]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  const cache = await getArtistVideosCache(artistId);
  const configuredTtl = ttlDays ?? await getSystemSetting('youtubeCacheTtlDays');
  const ttl = typeof configuredTtl === 'number' && Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 14;
  const fresh = cache?.uploads_cached && cache.source_key === source
    && Date.now() - new Date(cache.fetched_at).getTime() < ttl * 86400000;

  // A library change only needs the cached upload titles. No provider quota.
  if (cache?.uploads_cached && cache.source_key === source && cache.library_key !== libraryKey) {
    const uploads = await getArtistVideoUploads(artistId);
    await saveArtistVideoCatalog(artistId, uploads, matchVideoUploads(uploads, tracks), {
      fetched: false, sourceKey: source, libraryKey, channelId: cache.youtube_channel_id,
    });
  }
  if (fresh && !cache.last_error) return { refreshed: false, reason: 'fresh' };
  const retryAfterMs = cache?.attempt_source_key === source ? new Date(cache.retry_after ?? 0).getTime() - Date.now() : 0;
  if (retryAfterMs > 0) return { refreshed: false, reason: 'temporary-error', retryAfterMs };

  try {
    if (!parseArtistLinks(artist).length && !isCompilationArtistName(artist.name)) {
      await loadArtistVideoLinks(artistId, mbid);
      artist = await getArtistById(artistId) ?? artist;
      source = sourceKey(artist, mbid);
    }
    // Still no links: MusicBrainz is off, there is no artist MBID, or MusicBrainz
    // lists none (its failures throw). Cache "no channel"; links that arrive
    // later change the source key and refresh straight away.
    const resolved = isCompilationArtistName(artist.name) ? { channelId: null }
      : cache?.source_key === source && cache.youtube_channel_id ? { channelId: cache.youtube_channel_id }
      : await resolveArtistChannelId(artist);
    const uploads = resolved.channelId ? await listChannelUploads(resolved.channelId, 100) : [];
    await saveArtistVideoCatalog(artistId, uploads, matchVideoUploads(uploads, tracks), {
      fetched: true, sourceKey: source, libraryKey, channelId: resolved.channelId,
    });
    return { refreshed: true, reason: 'refreshed' };
  } catch (error) {
    const reason = error instanceof YoutubeBudgetError ? 'quota-exhausted'
      : error instanceof YoutubeKeyRejectedError ? 'key-rejected' : 'provider-error';
    // Key rejections are logged once by ytFetch; anything else would vanish.
    if (reason === 'provider-error') {
      console.warn(`[YouTube] Could not refresh music videos for "${artist.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
    await noteArtistVideoFailure(artistId, source, reason, RETRY_MS);
    throw error;
  }
}

// Existing matches return immediately while freshness is checked in the
// background. Cold lookups wait briefly, then tell the client to retry without
// holding its request open behind provider queues.
export async function lookupMusicVideoForTrack(trackId: string, waitMs = 1000): Promise<TrackVideoLookup> {
  if (!(await isYouTubeEnabled())) return { video: null, status: 'disabled' };
  const [cached, track] = await Promise.all([getMusicVideoByTrackId(trackId), getTrackById(trackId)]);
  if (!track?.artistId) return { video: cached, status: cached ? 'matched' : 'no-match' };
  const refresh = refreshArtistVideosIfStale(track.artistId);
  if (cached) {
    void refresh.catch(() => {});
    return { video: cached, status: 'matched' };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      refresh,
      new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), waitMs); }),
    ]);
    const video = await getMusicVideoByTrackId(trackId);
    if (video) return { video, status: 'matched' };
    if (!result) return { video: null, status: 'pending', retryAfterMs: 2000 };
    if (result.reason === 'pending' || result.reason === 'temporary-error') {
      return { video: null, status: result.reason, retryAfterMs: result.retryAfterMs };
    }
    return { video: null, status: 'no-match' };
  } catch {
    return { video: null, status: 'temporary-error', retryAfterMs: RETRY_MS };
  } finally { clearTimeout(timeout); }
}

export async function getMusicVideoForTrack(trackId: string) {
  return (await lookupMusicVideoForTrack(trackId)).video;
}

export async function testYouTubeConnection(): Promise<{ ok: boolean; error?: string; sample?: string }> {
  if (!(await getApiKey())) {
    return { ok: false, error: 'YouTube API key not set' };
  }
  try {
    // Cheap 1-unit call against a known handle to validate the key.
    // Forced: an admin testing a key must reach Google even during a rejection pause.
    const data: any = await ytFetch('channels', { part: 'snippet', forHandle: '@YouTube' }, 1, { force: true });
    const title = data?.items?.[0]?.snippet?.title;
    if (!title) return { ok: false, error: 'Unexpected API response' };
    return { ok: true, sample: String(title) };
  } catch (err: any) {
    if (err instanceof YoutubeBudgetError) {
      return { ok: false, error: 'Daily API quota exhausted — cannot test' };
    }
    if (err instanceof YoutubeKeyRejectedError) {
      return { ok: false, error: `Google rejected the key: ${err.message}` };
    }
    return { ok: false, error: err.message || 'Network error' };
  }
}

export async function getCurrentDayUsage() {
  const usage = await getYoutubeApiUsage();
  const cap = await getCap();
  const dailyCap = (await getSystemSetting('youtubeDailyQuotaCap')) as number | null;
  return {
    day: usage.day,
    count: usage.count,
    lastCallAt: usage.last_call_at,
    cap: typeof dailyCap === 'number' && dailyCap > 0 ? dailyCap : 9000,
    hardStopActive: cap !== null,
    stopped: cap !== null && usage.count >= cap,
  };
}

export { getMusicVideosForArtist };
