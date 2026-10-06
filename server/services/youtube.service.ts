import {
  getSystemSetting,
  getArtistById,
  getTracksByArtist,
  incrementYoutubeApiUsage,
  getYoutubeApiUsage,
  upsertArtistVideosCache,
  getArtistVideosCache,
  replaceArtistVideos,
  getMusicVideosForArtist,
  getMusicVideoByTrackId,
  getTrackById,
  isCompilationArtistName,
  type MusicVideoRow,
} from '../database';
import { getSongDedupKey } from './candidatePool.service';
import { videoTitleCandidates } from './youtubeTitle';

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
): Promise<T> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new YoutubeConfigError();

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
          // 403 with quotaExceeded → treat as budget so callers serve cache.
          if (res.status === 403 && /quota/i.test(body)) {
            throw new YoutubeBudgetError();
          }
          throw new Error(`YouTube HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
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
      if (isYouTubeHost(u.hostname)) return u.toString();
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

// ─── Title matching ─────────────────────────────────────────────────────
// Title cleaning / candidate generation lives in ./youtubeTitle (pure + tested).

// Title-only match key, scoped to one artist's catalogue (we already filter by
// artist_id), so the artist component is intentionally dropped — collaborator
// strings differ too often between YouTube and file tags. Omitting the mb id
// forces getSongDedupKey's `meta:` branch.
function titleKey(title: string): string {
  return getSongDedupKey({ title });
}

// Rank competing videos for the same track: prefer the official music video
// over lyric/audio uploads. Higher is better.
function videoQualityScore(title: string): number {
  const t = title.toLowerCase();
  let score = 0;
  if (/\bofficial\b/.test(t)) score += 2;
  if (/\bvideo\b/.test(t)) score += 2;
  if (/\blyrics?\b/.test(t)) score -= 1;
  if (/\baudio\b/.test(t)) score -= 1;
  return score;
}

type RawVideo = { videoId: string; title: string; thumbnailUrl: string | null; publishedAt: string | null; position: number };

function pickThumbnail(thumbs: any): string | null {
  if (!thumbs) return null;
  const t = thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default;
  return t?.url || null;
}

// ─── Fetch + match a single artist's channel uploads ────────────────────

async function listChannelUploads(channelId: string, maxVideos: number): Promise<RawVideo[]> {
  // 1 unit: resolve the channel's uploads playlist.
  const chData: any = await ytFetch('channels', { part: 'contentDetails', id: channelId }, 1);
  const uploadsPlaylist = chData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylist) return [];

  const videos: RawVideo[] = [];
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

// Resolve + fetch + match + write cache for a single artist. Idempotent.
export async function refreshArtistVideos(artistId: string): Promise<{ count: number; channelId: string | null }> {
  const artist: any = await getArtistById(artistId);
  if (!artist) throw new Error(`Artist ${artistId} not found`);

  if (isCompilationArtistName(artist.name)) {
    await upsertArtistVideosCache(artistId, { channelId: null, videosCount: 0, lastError: 'Compilation pseudo-artist — videos not applicable' });
    return { count: 0, channelId: null };
  }

  let channelId: string | null = (await getArtistVideosCache(artistId))?.youtube_channel_id || null;
  if (!channelId) {
    const resolved = await resolveArtistChannelId(artist);
    channelId = resolved.channelId;
    if (!channelId) {
      // Don't poison the cache while the artist's links are still loading —
      // leaving no row lets the next visit retry once metadata is present.
      if (resolved.ready) {
        await upsertArtistVideosCache(artistId, { channelId: null, videosCount: 0, lastError: resolved.reason });
      }
      return { count: 0, channelId: null };
    }
  }

  try {
    const uploads = await listChannelUploads(channelId, 100);

    // Build a title-only key map of the artist's library tracks.
    const tracks = await getTracksByArtist(artistId);
    const trackByKey = new Map<string, any>();
    for (const t of tracks) {
      const key = titleKey(t.title || '');
      if (!key.endsWith(':')) trackByKey.set(key, t); // skip empty titles
    }

    // Match each upload to a library track; keep the best video per track.
    const bestByTrack = new Map<string, { video: RawVideo; track: any; score: number }>();
    for (const v of uploads) {
      let matched: any = null;
      for (const c of videoTitleCandidates(v.title)) {
        const t = trackByKey.get(titleKey(c));
        if (t) { matched = t; break; }
      }
      if (!matched) continue;

      const score = videoQualityScore(v.title);
      const existing = bestByTrack.get(matched.id);
      if (!existing || score > existing.score) {
        bestByTrack.set(matched.id, { video: v, track: matched, score });
      }
    }

    // Dedupe by video_id: two library tracks sharing a title (e.g. original +
    // remaster) can map to the same upload. Keep the first (lowest position) so
    // the stored count matches the rows actually written (video_id is the PK).
    const seenVideoIds = new Set<string>();
    const rows: Omit<MusicVideoRow, 'fetched_at'>[] = Array.from(bestByTrack.values())
      .sort((a, b) => a.video.position - b.video.position)
      .filter(({ video }) => {
        if (seenVideoIds.has(video.videoId)) return false;
        seenVideoIds.add(video.videoId);
        return true;
      })
      .map(({ video, track }) => ({
        video_id: video.videoId,
        artist_id: artistId,
        track_id: track.id,
        title: track.title || video.title,
        thumbnail_url: video.thumbnailUrl,
        published_at: video.publishedAt,
        position: video.position,
      }));

    await replaceArtistVideos(artistId, rows);
    await upsertArtistVideosCache(artistId, { channelId, videosCount: rows.length, lastError: null });
    return { count: rows.length, channelId };
  } catch (err: any) {
    if (err instanceof YoutubeBudgetError) throw err;
    await upsertArtistVideosCache(artistId, { channelId, videosCount: 0, lastError: err.message || 'Fetch failed' });
    throw err;
  }
}

// Fetch only if the cache is stale (or missing). Videos rarely change, so the
// default TTL is generous.
const artistRefreshes = new Map<string, Promise<{ refreshed: boolean; reason: string }>>();

export function refreshArtistVideosIfStale(artistId: string, ttlDays?: number): Promise<{ refreshed: boolean; reason: string }> {
  const pending = artistRefreshes.get(artistId);
  if (pending) return pending;
  const refresh = refreshArtistVideosIfStaleOnce(artistId, ttlDays).finally(() => {
    artistRefreshes.delete(artistId);
  });
  artistRefreshes.set(artistId, refresh);
  return refresh;
}

async function refreshArtistVideosIfStaleOnce(artistId: string, ttlDays?: number): Promise<{ refreshed: boolean; reason: string }> {
  const ttl = typeof ttlDays === 'number' && ttlDays > 0
    ? ttlDays
    : (await getSystemSetting('youtubeCacheTtlDays')) as number | null ?? 14;
  const cache = await getArtistVideosCache(artistId);
  if (!cache) {
    await refreshArtistVideos(artistId);
    return { refreshed: true, reason: 'no-cache' };
  }
  const ageMs = Date.now() - new Date(cache.fetched_at).getTime();
  const ttlMs = ttl * 24 * 60 * 60 * 1000;
  if (ageMs >= ttlMs) {
    await refreshArtistVideos(artistId);
    return { refreshed: true, reason: 'stale' };
  }
  return { refreshed: false, reason: 'fresh' };
}

// Now Playing must be able to populate matches without an artist-page visit.
// Existing matches are free; misses reuse the same bounded channel lookup,
// cache freshness and daily budget as the artist rail.
export async function getMusicVideoForTrack(trackId: string) {
  if (!(await isYouTubeEnabled())) return null;
  const cached = await getMusicVideoByTrackId(trackId);
  if (cached) return cached;
  const track = await getTrackById(trackId);
  if (!track?.artistId) return null;
  try {
    await refreshArtistVideosIfStale(track.artistId);
  } catch {
    // Provider errors or exhausted quota must not interrupt music playback.
    return null;
  }
  return getMusicVideoByTrackId(trackId);
}

export async function testYouTubeConnection(): Promise<{ ok: boolean; error?: string; sample?: string }> {
  if (!(await getApiKey())) {
    return { ok: false, error: 'YouTube API key not set' };
  }
  try {
    // Cheap 1-unit call against a known handle to validate the key.
    const data: any = await ytFetch('channels', { part: 'snippet', forHandle: '@YouTube' }, 1);
    const title = data?.items?.[0]?.snippet?.title;
    if (!title) return { ok: false, error: 'Unexpected API response' };
    return { ok: true, sample: String(title) };
  } catch (err: any) {
    if (err instanceof YoutubeBudgetError) {
      return { ok: false, error: 'Daily API quota exhausted — cannot test' };
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
