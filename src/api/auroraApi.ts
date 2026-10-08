import type {
  AlbumSummary,
  ArtistSummary,
  AuroraClient,
  Genre,
  NextRecommendationRequest,
  PlaybackDescriptor,
  PlaybackSession,
  PlaybackSessionPatch,
  Playlist,
  Track,
} from '../../shared/api/v1';
import type { TrackInfo } from '../utils/fileSystem';

const CLIENT_ID_STORAGE_KEY = 'aurora.listenerClientId';

type DataEnvelope<T> = { data: T; meta: { requestId: string } };
type PageEnvelope<T> = DataEnvelope<T> & { page: { nextCursor: string | null } };

export class AuroraApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

/**
 * An RFC 4122 v4 UUID, valid in any browsing context.
 *
 * API v1 validates idempotency keys such as a playback report's `eventId` as
 * UUIDs. `crypto.randomUUID` exists only in secure contexts, so a client on
 * plain http (a LAN IP, say) would otherwise fall back to a non-UUID and have
 * every report rejected — plays silently not counted. `getRandomValues` is
 * available everywhere.
 */
export function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getAuroraClientId(): string {
  if (typeof window === 'undefined') return 'web:ssr';
  const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;
  const created = createClientId();
  window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, created);
  return created;
}

export async function auroraApiRequest<T>(
  path: string,
  authHeaders: Record<string, string>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      'X-Aurora-Client-Id': getAuroraClientId(),
      'X-Aurora-Client-Name': 'Aurora Web',
      ...authHeaders,
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AuroraApiError(
      payload?.error?.message || `Aurora API request failed (${response.status}).`,
      response.status,
      payload?.error?.code || 'REQUEST_FAILED',
      payload?.error?.requestId || response.headers.get('X-Request-Id') || undefined,
    );
  }
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as DataEnvelope<T>).data;
  }
  return undefined as T;
}

export async function auroraApiPage<T>(
  path: string,
  authHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<PageEnvelope<T>> {
  const response = await fetch(`/api/v1${path}`, {
    headers: {
      'X-Aurora-Client-Id': getAuroraClientId(),
      'X-Aurora-Client-Name': 'Aurora Web',
      ...authHeaders,
    },
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AuroraApiError(
      payload?.error?.message || `Aurora API request failed (${response.status}).`,
      response.status,
      payload?.error?.code || 'REQUEST_FAILED',
      payload?.error?.requestId || response.headers.get('X-Request-Id') || undefined,
    );
  }
  return payload as PageEnvelope<T>;
}

export async function auroraApiAllPages<T>(
  path: string,
  authHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<T[]> {
  const values: T[] = [];
  let cursor: string | null = null;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const pageResult: PageEnvelope<T[]> = await auroraApiPage<T[]>(
      `${path}${separator}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      authHeaders,
      signal,
    );
    values.push(...pageResult.data);
    cursor = pageResult.page.nextCursor;
  } while (cursor);
  return values;
}

export function fetchNextRecommendation(authHeaders: Record<string, string>, input: NextRecommendationRequest): Promise<Track | null> {
  return auroraApiRequest<Track | null>('/recommendations/next', authHeaders, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function toLegacyTrack(track: Track, mediaToken: string, quality: string): TrackInfo {
  const token = encodeURIComponent(mediaToken);
  const tokenQuery = token ? `&token=${token}` : '';
  const artTokenQuery = token ? `${track.artworkUrl?.includes('?') ? '&' : '?'}token=${token}` : '';
  const absolute = (url: string) => typeof window === 'undefined' ? url : new URL(url, window.location.origin).toString();
  return {
    id: track.id,
    path: `api-v1:${track.id}`,
    title: track.title,
    artist: track.artist,
    albumArtist: track.albumArtist || undefined,
    artists: track.artists,
    album: track.album,
    genre: track.genre || undefined,
    canonicalGenre: track.genre || undefined,
    genres: track.genres,
    duration: track.durationSeconds || undefined,
    playCount: track.playCount,
    trackNumber: track.trackNumber || undefined,
    discNumber: track.discNumber || undefined,
    year: track.year || undefined,
    releaseType: track.releaseType || undefined,
    isCompilation: track.compilation,
    bitrate: track.bitrate || undefined,
    format: track.format || undefined,
    lossless: track.lossless,
    artistId: track.artistId || undefined,
    albumId: track.albumId || undefined,
    genreId: track.genreId || undefined,
    isLoved: track.loved,
    mbRecordingId: track.musicBrainz.recordingId || undefined,
    mbTrackId: track.musicBrainz.trackId || undefined,
    mbAlbumId: track.musicBrainz.albumId || undefined,
    mbArtistId: track.musicBrainz.artistId || undefined,
    mbReleaseGroupId: track.musicBrainz.releaseGroupId || undefined,
    mbWorkId: track.musicBrainz.workId || undefined,
    url: absolute(`/api/stream/${encodeURIComponent(track.id)}/playlist.m3u8?quality=${encodeURIComponent(quality)}${tokenQuery}`),
    rawUrl: absolute(`/api/v1/media/tracks/${encodeURIComponent(track.id)}${token ? `?token=${token}` : ''}`),
    artUrl: track.artworkUrl ? absolute(`${track.artworkUrl}${artTokenQuery}`) : undefined,
  };
}

export function toLegacyPlaylist(playlist: Playlist, mediaToken: string, quality: string) {
  return {
    ...playlist,
    tracks: playlist.tracks.map((entry) => ({
      ...toLegacyTrack(entry.track, mediaToken, quality),
      playlistAddedAt: entry.addedAt ? new Date(entry.addedAt).getTime() : undefined,
    })),
  };
}

export type { AlbumSummary, ArtistSummary, AuroraClient, Genre, PlaybackDescriptor, PlaybackSession, PlaybackSessionPatch, Playlist, Track };
