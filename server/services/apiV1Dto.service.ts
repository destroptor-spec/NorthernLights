import crypto from 'crypto';
import { initDB } from '../database';
import type { AlbumSummary, ArtistSummary, Genre, Playlist, Track } from '../../shared/api/v1';

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
  } catch {
    // Comma-separated legacy values remain common in imported metadata.
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableInt(value: unknown): number | null {
  const number = nullableNumber(value);
  return number === null ? null : Math.trunc(number);
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mediaEtagForTrack(row: any): string | null {
  if (!row?.id) return null;
  const rawMtime = Number(row.file_mtime ?? row.fileMtime ?? 0);
  const mtime = Number.isFinite(rawMtime) ? Math.floor(rawMtime) : 0;
  const signature = `${row.id}:${mtime}:${row.file_size ?? row.fileSize ?? 0}`;
  return `\"${crypto.createHash('sha256').update(signature).digest('base64url').slice(0, 24)}\"`;
}

export function mapTrackV1(row: any): Track {
  const lastPlayed = row.user_last_played ?? row.lastPlayedAt ?? row.last_played_at;
  const artHash = nullableString(row.artHash ?? row.art_hash);
  return {
    id: String(row.id),
    title: String(row.title || 'Unknown Title'),
    artist: String(row.artist || 'Unknown Artist'),
    albumArtist: nullableString(row.albumArtist ?? row.album_artist),
    artists: list(row.artists),
    album: String(row.album || 'Unknown Album'),
    genre: nullableString(row.canonicalGenre ?? row.canonical_genre ?? row.genre),
    genres: list(row.genres),
    durationSeconds: nullableNumber(row.duration),
    trackNumber: nullableInt(row.trackNumber ?? row.track_number),
    discNumber: nullableInt(row.discNumber ?? row.disc_number),
    year: nullableInt(row.year),
    releaseType: nullableString(row.releaseType ?? row.release_type),
    compilation: Boolean(row.isCompilation ?? row.is_compilation),
    bitrate: nullableInt(row.bitrate),
    format: nullableString(row.format),
    lossless: Boolean(row.lossless),
    fileSize: nullableInt(row.fileSize ?? row.file_size),
    mediaEtag: mediaEtagForTrack(row),
    artistId: nullableString(row.artistId ?? row.artist_id),
    albumId: nullableString(row.albumId ?? row.album_id),
    genreId: nullableString(row.genreId ?? row.genre_id),
    loved: Boolean(row.isLoved ?? row.is_loved),
    rating: Math.max(0, Math.min(5, nullableInt(row.user_rating ?? row.rating) || 0)),
    playCount: Math.max(0, nullableInt(row.user_play_count ?? row.playCount ?? row.play_count) || 0),
    lastPlayedAt: typeof lastPlayed === 'number' ? iso(lastPlayed) : iso(lastPlayed),
    artworkId: artHash,
    artworkUrl: artHash ? `/api/v1/artwork/${encodeURIComponent(artHash)}` : null,
    musicBrainz: {
      recordingId: nullableString(row.mbRecordingId ?? row.mb_recording_id),
      trackId: nullableString(row.mbTrackId ?? row.mb_track_id),
      albumId: nullableString(row.mbAlbumId ?? row.mb_album_id),
      artistId: nullableString(row.mbArtistId ?? row.mb_artist_id),
      releaseGroupId: nullableString(row.mbReleaseGroupId ?? row.mb_release_group_id),
      workId: nullableString(row.mbWorkId ?? row.mb_work_id),
    },
  };
}

export function mapArtistSummaryV1(row: any): ArtistSummary {
  return {
    id: String(row.id),
    name: String(row.name || 'Unknown Artist'),
    imageUrl: nullableString(row.image_url ?? row.imageUrl),
    artworkUrl: nullableString(row.artwork_url ?? row.artworkUrl),
    genres: list(row.genres ?? row.community_tags),
    artistType: nullableString(row.artist_type ?? row.artistType),
    area: nullableString(row.area),
    lifeSpanBegin: nullableString(row.lifespan_begin ?? row.lifeSpanBegin),
  };
}

export function mapAlbumSummaryV1(row: any): AlbumSummary {
  const artworkId = nullableString(row.art_hash ?? row.artHash);
  return {
    id: String(row.id),
    title: String(row.title || 'Unknown Album'),
    artistName: String(row.artist_name ?? row.artistName ?? 'Unknown Artist'),
    year: nullableInt(row.derived_year ?? row.release_year ?? row.year),
    genres: list(row.derived_genres ?? row.genres ?? row.tags),
    releaseType: String(row.derived_release_type ?? row.release_type ?? 'Album'),
    trackCount: Math.max(0, nullableInt(row.track_count ?? row.trackCount) || 0),
    artworkId,
    // imageUrl is intentionally reserved for public/external images. Embedded
    // cover art remains protected and is addressed through artworkId so a
    // client can attach a media token instead of issuing an unauthenticated
    // <img> request to a protected API URL.
    imageUrl: nullableString(row.image_url ?? row.imageUrl),
    compilation: Boolean(row.is_compilation ?? row.isCompilation),
  };
}

export function mapGenreV1(row: any): Genre {
  return {
    id: String(row.id),
    name: String(row.name || 'Unknown Genre'),
    trackCount: Math.max(0, nullableInt(row.track_count ?? row.trackCount) || 0),
    aliasCount: Math.max(0, nullableInt(row.alias_count ?? row.aliasCount) || 0),
    imageUrl: nullableString(row.image_url ?? row.imageUrl),
  };
}

export async function getApiV1TracksByIds(userId: string, ids: string[]): Promise<Track[]> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return [];
  const db = await initDB();
  const mapped: Array<[string, Track]> = [];
  for (let offset = 0; offset < uniqueIds.length; offset += 5000) {
    const result = await db.query(`
      SELECT t.*, g.name AS canonical_genre,
             COALESCE(ups.play_count, 0) AS user_play_count,
             COALESCE(ups.rating, 0) AS user_rating,
             ups.last_played_at AS user_last_played,
             (ult.track_id IS NOT NULL) AS is_loved
      FROM tracks t
      LEFT JOIN genres g ON g.id = t.genre_id
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
      LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $1
      WHERE t.id = ANY($2::text[])
    `, [userId, uniqueIds.slice(offset, offset + 5000)]);
    mapped.push(...result.rows.map((row) => [String(row.id), mapTrackV1(row)] as [string, Track]));
  }
  const byId = new Map(mapped);
  return ids.map((id) => byId.get(id)).filter((track): track is Track => Boolean(track));
}

export async function getApiV1TrackById(userId: string, id: string): Promise<Track | null> {
  return (await getApiV1TracksByIds(userId, [id]))[0] || null;
}

export async function mapPlaylistV1(row: any, userId: string, prefetchedTracks?: Map<string, Track>): Promise<Playlist> {
  const rawTracks = Array.isArray(row.tracks) ? row.tracks : [];
  const trackIds = rawTracks.map((track: any) => String(track.id));
  const tracks: Track[] = prefetchedTracks
    ? trackIds.map((id: string) => prefetchedTracks.get(id)).filter((track: Track | undefined): track is Track => Boolean(track))
    : await getApiV1TracksByIds(userId, trackIds);
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  const entries = rawTracks.flatMap((rawTrack: any) => {
    const track = tracksById.get(String(rawTrack.id));
    if (!track) return [];
    return [{
      track,
      addedAt: iso(rawTrack.playlistAddedAt ?? rawTrack.playlist_added_at),
    }];
  });
  const ownerId = nullableString(row.userId ?? row.user_id);
  const isOwner = row.isOwner === true || ownerId === userId;
  const isSystem = Boolean(row.isSystem ?? row.is_system);
  const generated = Boolean(row.isLlmGenerated ?? row.is_llm_generated);
  return {
    id: String(row.id),
    title: String(row.title || 'Untitled Playlist'),
    description: nullableString(row.description),
    ownerUsername: nullableString(row.ownerUsername ?? row.owner_username),
    isOwner,
    isSystem,
    isGenerated: generated,
    pinned: Boolean(row.pinned),
    private: Boolean(row.isPrivate ?? row.is_private),
    readOnly: isSystem || generated || !isOwner,
    createdAt: iso(row.createdAt ?? row.created_at),
    tracks: entries,
  };
}

export async function getLibraryRevision(): Promise<string> {
  const db = await initDB();
  const result = await db.query(`
    SELECT COUNT(*)::bigint AS count, COALESCE(MAX(file_mtime), 0)::bigint AS max_mtime,
           COALESCE(SUM(COALESCE(file_size, 0)), 0)::numeric AS total_size
    FROM tracks
  `);
  const row = result.rows[0] || {};
  return crypto.createHash('sha256')
    .update(`${row.count || 0}:${row.max_mtime || 0}:${row.total_size || 0}`)
    .digest('base64url')
    .slice(0, 24);
}
