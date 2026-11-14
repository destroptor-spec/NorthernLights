/**
 * Community artist tags per provider (artist_tags), phase 1 of
 * docs/Aurora genre and style redesign.md.
 *
 * Last.fm counts are 0–100 relative to the artist's strongest tag; MusicBrainz
 * counts are raw votes, usually single digits. Each provider's tags are
 * normalised per artist (weight = count / strongest count) and never summed
 * across providers. Optional by design: with no Last.fm key or MusicBrainz off,
 * nothing here runs and the taxonomy works from file tags and audio.
 */
import type { Pool } from 'pg';
import { tagKey } from './data';

export type TagProvider = 'lastfm' | 'musicbrainz';
export interface ProviderTag { name: string; count: number }
export interface WeightedTag { name: string; key: string; rawCount: number; weight: number }
export interface DisplayTag { name: string; count: number; providers: TagProvider[] }

const MAX_TAGS_PER_PROVIDER = 50;

/**
 * Dedupes by name (MusicBrainz lists genres and tags separately with the same
 * votes, so take the maximum, never the sum) and weights against the
 * strongest tag. Tags with no positive count are dropped.
 */
export function normaliseProviderTags(tags: ProviderTag[]): WeightedTag[] {
  const best = new Map<string, ProviderTag>();
  for (const tag of tags) {
    const name = typeof tag?.name === 'string' ? tag.name.trim() : '';
    const count = Number(tag?.count);
    if (!name || !Number.isFinite(count) || count <= 0) continue;
    const id = name.toLowerCase();
    const prev = best.get(id);
    if (!prev || count > prev.count) best.set(id, { name, count: Math.round(count) });
  }
  const list = Array.from(best.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, MAX_TAGS_PER_PROVIDER);
  const top = list[0]?.count || 0;
  if (top <= 0) return [];
  return list.map(t => ({ name: t.name, key: tagKey(t.name), rawCount: t.count, weight: Math.min(1, t.count / top) }));
}

/** Chips on the artist page: per name the strongest provider weight, as 0–100. */
export function mergeForDisplay(byProvider: Partial<Record<TagProvider, WeightedTag[]>>, limit = 16): DisplayTag[] | undefined {
  const merged = new Map<string, DisplayTag & { weight: number }>();
  for (const provider of ['lastfm', 'musicbrainz'] as TagProvider[]) {
    for (const tag of byProvider[provider] || []) {
      const id = tag.name.toLowerCase();
      const prev = merged.get(id);
      if (prev) {
        prev.weight = Math.max(prev.weight, tag.weight);
        if (!prev.providers.includes(provider)) prev.providers.push(provider);
      } else {
        merged.set(id, { name: tag.name, count: 0, providers: [provider], weight: tag.weight });
      }
    }
  }
  const list = Array.from(merged.values())
    .sort((a, b) => b.weight - a.weight || b.providers.length - a.providers.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(t => ({ name: t.name, count: Math.round(t.weight * 100), providers: t.providers }));
  return list.length > 0 ? list : undefined;
}

/** Replaces one provider's tags for an artist and records the fetch (also when empty). */
export async function saveArtistTags(db: Pool, artistId: string, provider: TagProvider, tags: WeightedTag[], error: string | null = null) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (!error) {
      await client.query('DELETE FROM artist_tags WHERE artist_id = $1 AND provider = $2', [artistId, provider]);
      if (tags.length) {
        await client.query(
          `INSERT INTO artist_tags (artist_id, provider, tag, tag_key, raw_count, weight, fetched_at)
           SELECT $1, $2, tag, key, raw, w, NOW()
           FROM unnest($3::text[], $4::text[], $5::int[], $6::real[]) AS t(tag, key, raw, w)
           ON CONFLICT (artist_id, provider, tag) DO NOTHING`,
          [artistId, provider, tags.map(t => t.name), tags.map(t => t.key), tags.map(t => t.rawCount), tags.map(t => t.weight)]);
      }
    }
    await client.query(
      `INSERT INTO artist_tag_fetches (artist_id, provider, fetched_at, tag_count, error)
       VALUES ($1, $2, NOW(), $3, $4)
       ON CONFLICT (artist_id, provider) DO UPDATE SET
         fetched_at = EXCLUDED.fetched_at, tag_count = EXCLUDED.tag_count, error = EXCLUDED.error`,
      [artistId, provider, error ? 0 : tags.length, error]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Called after a regular artist lookup; resolves the artist row by its unique name. */
export async function saveArtistTagsByName(db: Pool, artistName: string, byProvider: Partial<Record<TagProvider, WeightedTag[]>>) {
  const providers = Object.keys(byProvider) as TagProvider[];
  if (!providers.length) return;
  const row = (await db.query('SELECT id FROM artists WHERE name = $1', [artistName])).rows[0];
  if (!row) return;
  for (const provider of providers) await saveArtistTags(db, row.id, provider, byProvider[provider] || []);
}
