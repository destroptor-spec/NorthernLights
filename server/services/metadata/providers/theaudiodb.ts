import { theAudioDbThrottle, fetchWithRetry } from '../rateLimiter';
import { ProviderError, RateLimitError, messageWithCause } from '../errors';

// TheAudioDB (https://www.theaudiodb.com/free_music_api), API v1: the key goes
// in the path. The free key "123" allows 30 requests a minute and returns one
// hit per search. Field names below are the live API's (2026-11-24), which
// differ from its docs in places (`strBiography`, not `strBiographyEN`).

const BASE = 'https://www.theaudiodb.com/api/v1/json';

export interface TadbArtist {
  idArtist?: string;
  strArtist?: string | null;
  strArtistAlternate?: string | null;
  intFormedYear?: string | null;
  intBornYear?: string | null;
  intDiedYear?: string | null;
  strDisbanded?: string | null;
  strStyle?: string | null;
  strGenre?: string | null;
  strMood?: string | null;
  strWebsite?: string | null;
  strFacebook?: string | null;
  strTwitter?: string | null;
  strBiography?: string | null;
  strBiographyEN?: string | null;
  strCountry?: string | null;
  strCountryCode?: string | null;
  strArtistThumb?: string | null;
  strArtistWideThumb?: string | null;
  strArtistFanart?: string | null;
  strArtistFanart2?: string | null;
  strArtistFanart3?: string | null;
  strArtistFanart4?: string | null;
  strMusicBrainzID?: string | null;
}

export interface TadbAlbum {
  idAlbum?: string;
  strAlbum?: string | null;
  strArtist?: string | null;
  strAlbumThumb?: string | null;
  /** The back cover. */
  strAlbumThumbBack?: string | null;
  /** The case, the flat sleeve and the face, as 3D renders. */
  strAlbum3DCase?: string | null;
  strAlbum3DFlat?: string | null;
  strAlbum3DFace?: string | null;
  strAlbumSpine?: string | null;
  /** The disc itself, a transparent PNG. */
  strAlbumCDart?: string | null;
  strMusicBrainzID?: string | null;
}

async function tadbGet<T>(apiKey: string, path: string): Promise<T> {
  return theAudioDbThrottle.run(async () => {
    const res = await fetchWithRetry(`${BASE}/${encodeURIComponent(apiKey)}/${path}`, { headers: { Accept: 'application/json' } });
    if (res.status === 429) throw new RateLimitError('theaudiodb');
    // An unknown or lapsed key answers 404 {"Message":"Not found"}.
    if (res.status === 404) throw new ProviderError('theaudiodb', 'HTTP 404 (is the API key right?)', 404);
    if (!res.ok) throw new ProviderError('theaudiodb', `HTTP ${res.status}`, res.status);
    return res.json() as Promise<T>;
  }).catch((err: any) => {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    throw new ProviderError('theaudiodb', messageWithCause(err));
  });
}

/** An artist by MusicBrainz id, or null. */
export async function tadbArtistByMbid(mbid: string, apiKey: string): Promise<TadbArtist | null> {
  const json = await tadbGet<{ artists?: TadbArtist[] | null }>(apiKey, `artist-mb.php?i=${encodeURIComponent(mbid)}`);
  return json.artists?.[0] ?? null;
}

/** The first artist a name search finds, or null. The caller checks the name. */
export async function tadbSearchArtist(name: string, apiKey: string): Promise<TadbArtist | null> {
  const json = await tadbGet<{ artists?: TadbArtist[] | null }>(apiKey, `search.php?s=${encodeURIComponent(name)}`);
  return json.artists?.[0] ?? null;
}

/** Albums by that artist with that name (the caller checks the match). */
export async function tadbSearchAlbum(artist: string, album: string, apiKey: string): Promise<TadbAlbum[]> {
  const json = await tadbGet<{ album?: TadbAlbum[] | null }>(apiKey, `searchalbum.php?s=${encodeURIComponent(artist)}&a=${encodeURIComponent(album)}`);
  return json.album ?? [];
}

/** An album by MusicBrainz release-group id, or null. */
export async function tadbAlbumByReleaseGroup(releaseGroupId: string, apiKey: string): Promise<TadbAlbum | null> {
  const json = await tadbGet<{ album?: TadbAlbum[] | null }>(apiKey, `album-mb.php?i=${encodeURIComponent(releaseGroupId)}`);
  return json.album?.[0] ?? null;
}

/** An https image URL, or undefined for TheAudioDB's empty strings and nulls. */
export function tadbImage(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = value.trim().replace(/^http:\/\//i, 'https://');
  return /^https:\/\/\S+$/.test(url) ? url : undefined;
}

/** Connection test: looks up one well-known artist. */
export async function testTheAudioDb(apiKey: string): Promise<{ artist?: string }> {
  const artist = await tadbArtistByMbid('cc197bad-dc9c-440d-a5b5-d52ba2e14234', apiKey);
  return { artist: artist?.strArtist ?? undefined };
}
