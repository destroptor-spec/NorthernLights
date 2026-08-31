import type {
  AlbumSummary,
  ArtistSummary,
  AuroraClient,
  Genre,
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
