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
  TrackRays,
} from '../../shared/api/v1';

import type { DisputedTrack } from '../../shared/genreReview';

type Auth = Record<string, string>;

/** What a track, album or artist list is filtered to (mirrors the server). */
export interface BrowseFilter {
  genre?: string;
  style?: number;
  noStyle?: boolean;
  decade?: number;
  /** ISO 3166-1 alpha-2. */
  country?: string;
  vocals?: string;
  mood?: string;
  unsorted?: boolean;
  tag?: string;
}

function filterQuery(filter: BrowseFilter, extra: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams();
  if (filter.genre) params.set('genre', filter.genre);
  if (filter.style !== undefined) params.set('style', String(filter.style));
  if (filter.noStyle) params.set('noStyle', 'true');
  if (filter.decade !== undefined) params.set('decade', String(filter.decade));
  if (filter.country) params.set('country', filter.country);
  if (filter.vocals) params.set('vocals', filter.vocals);
  if (filter.mood) params.set('mood', filter.mood);
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

/** What Shuffle plays: a handful of strong tracks, spread over artists, in play order. */
export const fetchBrowseMix = (auth: Auth, filter: BrowseFilter) =>
  auroraApiRequest<Track[]>(`/browse/mix?${filterQuery(filter)}`, auth);

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

/** "Aurora rays from {title}". */
export const fetchTrackRays = (auth: Auth, trackId: string) =>
  auroraApiRequest<TrackRays>(`/tracks/${encodeURIComponent(trackId)}/rays`, auth);

export const raysPath = (trackId: string) => `/library/rays/${encodeURIComponent(trackId)}`;

/** Admin: add or remove a genre or style on one track (legacy API; admin stays off v1). */
export async function setTrackStyle(auth: Auth, trackId: string, change: { genre: string; styleId: number | null; action: 'add' | 'remove' }) {
  const response = await fetch(`/api/library/track-styles/${encodeURIComponent(trackId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(change),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || 'Could not save the change.');
  }
}

/** Admin: tracks with tagged styles the sound disputes, one page of tracks at a time (legacy API). */
export async function fetchDisputedStyles(auth: Auth, offset = 0, limit = 50) {
  const response = await fetch(`/api/library/track-styles/disputed?offset=${offset}&limit=${limit}`, { headers: auth });
  if (!response.ok) throw new Error('Could not load disputed tags.');
  return response.json() as Promise<{ total: number; styles: number; items: DisputedTrack[] }>;
}

/** Admin: Aurora's genres and styles, for the picker. */
export async function fetchTaxonomy(auth: Auth) {
  const response = await fetch('/api/library/genre-reviews/taxonomy', { headers: auth });
  if (!response.ok) throw new Error('Could not load the genre list.');
  return response.json() as Promise<{ genres: string[]; styles: Array<{ id: number; genre: string; name: string }> }>;
}
