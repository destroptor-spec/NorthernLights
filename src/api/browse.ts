// Browse: Genre → Style (API v1, docs/Aurora genre and style redesign.md).
import { auroraApiPage, auroraApiRequest, type Track } from './auroraApi';
import type {
  AlbumStyleProfile,
  ArtistStyleProfile,
  BrowseAlbum,
  BrowseArtist,
  BrowseGenreDetail,
  BrowseGenres,
  BrowseStyleDetail,
  BrowseUnsorted,
} from '../../shared/api/v1';

type Auth = Record<string, string>;

/** What a track, album or artist list is filtered to (mirrors the server). */
export interface BrowseFilter {
  genre?: string;
  style?: number;
  noStyle?: boolean;
  decade?: number;
  unsorted?: boolean;
  tag?: string;
}

function filterQuery(filter: BrowseFilter, extra: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams();
  if (filter.genre) params.set('genre', filter.genre);
  if (filter.style !== undefined) params.set('style', String(filter.style));
  if (filter.noStyle) params.set('noStyle', 'true');
  if (filter.decade !== undefined) params.set('decade', String(filter.decade));
  if (filter.unsorted) params.set('unsorted', 'true');
  if (filter.tag) params.set('tag', filter.tag);
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) params.set(key, String(value));
  return params.toString();
}

export const fetchBrowseGenres = (auth: Auth, includeHidden = false) =>
  auroraApiRequest<BrowseGenres>(`/browse/genres${includeHidden ? '?hidden=true' : ''}`, auth);

export const fetchBrowseGenre = (auth: Auth, genre: string) =>
  auroraApiRequest<BrowseGenreDetail>(`/browse/genres/${encodeURIComponent(genre)}`, auth);

export const fetchBrowseStyle = (auth: Auth, styleId: number) =>
  auroraApiRequest<BrowseStyleDetail>(`/browse/styles/${styleId}`, auth);

export const fetchBrowseUnsorted = (auth: Auth) => auroraApiRequest<BrowseUnsorted>('/browse/unsorted', auth);

export const fetchBrowseTracks = (auth: Auth, filter: BrowseFilter, limit = 500) =>
  auroraApiPage<Track[]>(`/browse/tracks?${filterQuery(filter, { limit })}`, auth);

export const fetchBrowseAlbums = (auth: Auth, filter: BrowseFilter, cursor?: string | null, limit = 24) =>
  auroraApiPage<BrowseAlbum[]>(`/browse/albums?${filterQuery(filter, { limit, cursor: cursor ?? undefined })}`, auth);

export const fetchBrowseArtists = (auth: Auth, filter: BrowseFilter, cursor?: string | null, limit = 24) =>
  auroraApiPage<BrowseArtist[]>(`/browse/artists?${filterQuery(filter, { limit, cursor: cursor ?? undefined })}`, auth);

export const fetchAlbumStyles = (auth: Auth, albumId: string) =>
  auroraApiRequest<AlbumStyleProfile>(`/albums/${encodeURIComponent(albumId)}/styles`, auth);

export const fetchArtistStyles = (auth: Auth, artistId: string) =>
  auroraApiRequest<ArtistStyleProfile>(`/artists/${encodeURIComponent(artistId)}/styles`, auth);

/** Route of a genre or style page. */
export const genrePath = (genre: string) => `/library/browse/genre/${encodeURIComponent(genre)}`;
export const stylePath = (styleId: number) => `/library/browse/style/${styleId}`;
export const UNSORTED_PATH = '/library/browse/unsorted';
