import { mbFetch } from '../../musicbrainz.service';
import { ProviderError } from '../errors';

export interface MbArtist {
  disambiguation?: string;
  area?: { name: string };
  type?: string;
  'life-span'?: { begin?: string; end?: string; ended?: boolean };
  relations?: Array<{ target_type?: string; url?: { resource?: string }; type?: string }>;
  genres?: Array<{ name: string }>;
}

export function extractMbLinks(relations: any[]): { url: string; type: string }[] {
  if (!Array.isArray(relations)) return [];
  return relations
    .filter((r: any) => r.target_type === 'url' && r.url?.resource)
    .map((r: any) => ({
      url: r.url.resource,
      type: r.type || 'other',
    }));
}

export async function mbGetArtist(mbid: string): Promise<MbArtist | null> {
  try {
    const artist = await mbFetch(
      `https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels+tags+genres+ratings&fmt=json`
    );
    return artist || null;
  } catch (err: any) {
    if (err instanceof ProviderError) throw err;
    console.error('[MusicBrainz] getArtist error:', err.message);
    throw new ProviderError('musicbrainz', err.message);
  }
}

export async function mbSearchArtist(query: string): Promise<any> {
  try {
    return await mbFetch(
      `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(query)}&limit=5&fmt=json`
    );
  } catch (err: any) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('musicbrainz', err.message);
  }
}

export async function mbGetAlbumCover(mbid: string): Promise<string | null> {
  try {
    const coverUrl = `https://coverartarchive.org/release/${mbid}/front-500`;
    const res = await fetch(coverUrl, { method: 'HEAD' });
    if (res.ok) return coverUrl;
    return null;
  } catch {
    return null;
  }
}

export async function mbSearchReleaseGroup(
  query: string
): Promise<{ id: string; title: string }[]> {
  try {
    const result = await mbFetch(
      `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(query)}&limit=5&fmt=json`
    );
    return (result['release-groups'] || []).map((h: any) => ({
      id: h.id,
      title: h.title,
    }));
  } catch (err: any) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('musicbrainz', err.message);
  }
}

export { mbFetch } from '../../musicbrainz.service';

