import { mbFetch } from '../../musicbrainz.service';
import { ProviderError } from '../errors';

export interface MbArtist {
  disambiguation?: string;
  area?: { name: string };
  type?: string;
  'life-span'?: { begin?: string; end?: string; ended?: boolean };
  relations?: Array<{
    target_type?: string;
    'target-type'?: string;
    url?: { resource?: string };
    type?: string;
    artist?: { name?: string; 'sort-name'?: string };
    direction?: string;
  }>;
  genres?: Array<{ name: string; count?: number }>;
  tags?: Array<{ name: string; count?: number }>;
}

export function extractMbLinks(relations: any[]): { url: string; type: string }[] {
  if (!Array.isArray(relations)) return [];
  return relations
    .filter((r: any) => (r.target_type === 'url' || r['target-type'] === 'url') && r.url?.resource)
    .map((r: any) => ({
      url: r.url.resource,
      type: r.type || 'other',
    }));
}

export function extractMbMembers(relations: any[]): string[] {
  if (!Array.isArray(relations)) return [];
  const members: string[] = [];
  for (const r of relations) {
    const targetType = r.target_type || r['target-type'];
    if (targetType === 'artist' && r.type === 'member of band' && r.artist?.name) {
      members.push(r.artist.name);
    }
  }
  return members;
}

export async function mbGetArtist(mbid: string, signal?: AbortSignal): Promise<MbArtist | null> {
  try {
    const artist = await mbFetch(
      `https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels+artist-rels+tags+genres+ratings&fmt=json`, signal
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

// ─── Cover Art Archive typed images (front, Medium/disc, …) ────────────────
//
// CAA is a public, no-auth service (separate origin from the MB API, so it
// bypasses the mbFetch allowlist — same pattern as mbGetAlbumCover above).
// Each image carries a `types` array; "Medium" is the physical medium
// itself (vinyl label / CD face), which powers the album disc view.

const CAA_RELEASE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CaaImage {
  types: string[];                      // e.g. ["Front"], ["Medium"]
  front: boolean;
  image: string;                        // full-size url
  thumbnails: Record<string, string>;   // "250" | "500" | "1200" | "small" | "large"
  comment?: string;                     // sometimes "Disc 1" — unreliable
  approved?: boolean;
}

/** Full typed image list for a *release* MBID (not release-group). [] on 404/error. */
export async function caaGetReleaseImages(releaseMbid: string): Promise<CaaImage[]> {
  if (!CAA_RELEASE_RE.test(releaseMbid)) return [];
  try {
    const res = await fetch(`https://coverartarchive.org/release/${encodeURIComponent(releaseMbid)}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return [];               // 404 = no art for this release
    const data = await res.json();
    return Array.isArray(data?.images) ? data.images : [];
  } catch {
    return [];
  }
}

/**
 * Pick the disc/label image. "Medium" = the physical medium (vinyl label, CD
 * face). discIndex selects which platter for multi-disc releases (CAA order,
 * best-effort). Prefers approved images. Returns null when none exist.
 */
export function pickMediumImage(images: CaaImage[], discIndex = 0): CaaImage | null {
  const media = images.filter(i => Array.isArray(i.types) && i.types.includes('Medium'));
  if (media.length === 0) return null;
  return media[Math.min(Math.max(discIndex, 0), media.length - 1)]
      ?? media.find(i => i.approved) ?? media[0];
}

/** Best front-cover image (release level). null when none. */
export function pickFrontImage(images: CaaImage[]): CaaImage | null {
  return images.find(i => i.front) ?? images.find(i => i.types?.includes('Front')) ?? null;
}

// ─── Recording-level credits (composer / performer / producer / …) ─────────
//
// MusicBrainz's recording entity exposes per-track artist relationships
// — performers (with instrument attributes), producers, mixers, remixers,
// engineers, arrangers, conductors, vocalists. Composer/lyricist live on
// the related work entity, so we ask for work-rels and work-level-rels
// in the same request to avoid a second round-trip.

export interface MbCreditRelation {
  role: string;        // canonical Aurora role
  name: string;        // artist display name
  artistMbid?: string;
  detail?: string;     // instrument (for performer-with-attribute)
}

// Maps MB relationship types to Aurora's canonical role taxonomy. Returns
// null when the relation isn't a per-track credit we surface.
function mapMbRelationType(type: string | undefined, attributes?: string[]): { role: string; detail?: string } | null {
  if (!type) return null;
  const t = type.toLowerCase();
  // Performer family — MB models instrument/vocal as attributes; the type
  // itself is "instrument" or "vocal", with the attribute holding the
  // actual instrument name (e.g. ["piano"]).
  if (t === 'instrument' || t === 'vocal') {
    return { role: 'performer', detail: (attributes && attributes[0]) || (t === 'vocal' ? 'vocals' : undefined) };
  }
  if (t === 'performer') return { role: 'performer', detail: (attributes && attributes[0]) || undefined };
  if (t === 'conductor') return { role: 'conductor' };
  if (t === 'producer') return { role: 'producer' };
  if (t === 'remixer') return { role: 'remixer' };
  if (t === 'mix' || t === 'mixer') return { role: 'mixer' };
  if (t === 'engineer' || t === 'audio engineer' || t === 'recording engineer') return { role: 'engineer' };
  if (t === 'arranger' || t === 'instrument arranger' || t === 'vocal arranger') return { role: 'arranger' };
  if (t === 'composer') return { role: 'composer' };
  if (t === 'lyricist') return { role: 'lyricist' };
  if (t === 'writer') return { role: 'writer' };
  if (t === 'dj-mixer' || t === 'dj mixer') return { role: 'dj-mixer' };
  return null;
}

export async function mbGetRecording(mbid: string): Promise<MbCreditRelation[]> {
  try {
    // work-rels + work-level-rels lets us harvest composer/lyricist that
    // live on the work entity, without a separate /work/{mbid} request.
    const data = await mbFetch(
      `https://musicbrainz.org/ws/2/recording/${mbid}?inc=artist-rels+work-rels+work-level-rels&fmt=json`
    );
    if (!data) return [];
    const credits: MbCreditRelation[] = [];

    const pushFromRelations = (relations: any[] | undefined) => {
      if (!Array.isArray(relations)) return;
      for (const rel of relations) {
        const targetType = rel.target_type || rel['target-type'];
        if (targetType && targetType !== 'artist') continue;
        const mapped = mapMbRelationType(rel.type, rel.attributes);
        if (!mapped) continue;
        const name: string | undefined = rel.artist?.name;
        if (!name) continue;
        credits.push({
          role: mapped.role,
          name,
          artistMbid: rel.artist?.id,
          detail: mapped.detail,
        });
      }
    };

    // 1. Recording-level artist relations (performers, producers, etc.)
    pushFromRelations(data.relations);

    // 2. Work-level artist relations (composer, lyricist, …) reached via
    //    "performance" work-rels off the recording.
    if (Array.isArray(data.relations)) {
      for (const rel of data.relations) {
        const targetType = rel.target_type || rel['target-type'];
        if (targetType === 'work' && rel.work?.relations) {
          pushFromRelations(rel.work.relations);
        }
      }
    }

    return credits;
  } catch (err: any) {
    if (err instanceof ProviderError) throw err;
    console.error('[MusicBrainz] getRecording error:', err.message);
    throw new ProviderError('musicbrainz', err.message);
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
