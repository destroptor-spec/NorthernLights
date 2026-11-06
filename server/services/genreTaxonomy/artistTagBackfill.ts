/**
 * Slow, resumable backfill of per-provider artist tags for library artists
 * (phase 1 of docs/Aurora genre and style redesign.md).
 *
 * Free, rate-limited APIs: one call per artist and provider, paced 1.5 s,
 * most-played artists first, only for configured providers (Last.fm key /
 * MusicBrainz enabled with a known MBID). It stops on a rate limit and resumes
 * on the next start, because fetched artists drop out of the work set. Failed
 * fetches are retried after a week, never in a tight loop.
 */
import type { Pool } from 'pg';
import { getSystemSetting, initDB } from '../../database';
import { lastFmArtistTopTags } from '../metadata/providers/lastfm';
import { mbGetArtist } from '../metadata/providers/musicbrainz';
import { isRateLimitError } from '../metadata/errors';
import { normaliseProviderTags, saveArtistTags, type ProviderTag, type TagProvider } from './artistTags';

const PACE_MS = 1500;
const BATCH = 50;
const RETRY_FAILED_AFTER = '7 days';
const MAP_EVERY = 25;

export interface ArtistTagBackfillStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  fetched: Record<TagProvider, number>;
  remaining: Record<TagProvider, number> | null;
  stoppedReason: string | null;
}

const status: ArtistTagBackfillStatus = {
  running: false, startedAt: null, finishedAt: null,
  fetched: { lastfm: 0, musicbrainz: 0 }, remaining: null, stoppedReason: null,
};
let stopRequested = false;

async function enabledProviders(): Promise<{ provider: TagProvider; key?: string }[]> {
  const out: { provider: TagProvider; key?: string }[] = [];
  const lastFmApiKey = await getSystemSetting('lastFmApiKey');
  if (typeof lastFmApiKey === 'string' && lastFmApiKey.trim()) out.push({ provider: 'lastfm', key: lastFmApiKey.trim() });
  const mb = await getSystemSetting('musicBrainzEnabled');
  if (mb === true || mb === 'true') out.push({ provider: 'musicbrainz' });
  return out;
}

function workSetSql(provider: TagProvider, select: string) {
  return `
    SELECT ${select}
    FROM artists a
    JOIN tracks t ON t.artist_id = a.id
    WHERE lower(a.name) <> 'various artists'
      ${provider === 'musicbrainz' ? "AND COALESCE(a.mbid, '') <> ''" : ''}
      AND NOT EXISTS (
        SELECT 1 FROM artist_tag_fetches f
        WHERE f.artist_id = a.id AND f.provider = $1
          AND (f.error IS NULL OR f.fetched_at > NOW() - INTERVAL '${RETRY_FAILED_AFTER}'))`;
}

export async function countRemaining(db: Pool): Promise<Record<TagProvider, number>> {
  const out = { lastfm: 0, musicbrainz: 0 } as Record<TagProvider, number>;
  for (const provider of ['lastfm', 'musicbrainz'] as TagProvider[]) {
    out[provider] = Number((await db.query(workSetSql(provider, 'COUNT(DISTINCT a.id)::int AS n'), [provider])).rows[0].n);
  }
  return out;
}

async function fetchTags(provider: TagProvider, artist: { name: string; mbid: string | null }, key?: string): Promise<ProviderTag[] | null> {
  if (provider === 'lastfm') {
    const top = await lastFmArtistTopTags(artist.name, key!);
    return (top?.tag || []).map((t: any) => ({ name: t?.name, count: Number(t?.count) }));
  }
  const mb = await mbGetArtist(artist.mbid!);
  if (!mb) return null; // lookup failed; mbGetArtist logs the reason
  return [...((mb as any).genres || []), ...((mb as any).tags || [])].map((t: any) => ({ name: t?.name, count: Number(t?.count) }));
}

export function getArtistTagBackfillStatus(): ArtistTagBackfillStatus {
  return { ...status, fetched: { ...status.fetched }, remaining: status.remaining && { ...status.remaining } };
}

export function stopArtistTagBackfill() {
  if (status.running) stopRequested = true;
}

/** Runs until done, stopped or rate-limited. Concurrent calls return the running status. */
export async function runArtistTagBackfill(
  { paceMs = PACE_MS, onProgress }: { paceMs?: number; onProgress?: () => void } = {},
): Promise<ArtistTagBackfillStatus> {
  if (status.running) return getArtistTagBackfillStatus();
  const providers = await enabledProviders();
  const db = await initDB();
  Object.assign(status, {
    running: true, startedAt: new Date().toISOString(), finishedAt: null,
    fetched: { lastfm: 0, musicbrainz: 0 }, remaining: await countRemaining(db), stoppedReason: null,
  });
  stopRequested = false;
  let sinceMap = 0;
  try {
    if (!providers.length) status.stoppedReason = 'no provider configured';
    outer: for (const { provider, key } of status.stoppedReason ? [] : providers) {
      for (;;) {
        const batch = (await db.query(
          `${workSetSql(provider, 'a.id, a.name, a.mbid, COUNT(t.id) AS plays')} GROUP BY a.id ORDER BY plays DESC, a.name LIMIT ${BATCH}`,
          [provider])).rows as { id: string; name: string; mbid: string | null }[];
        if (!batch.length) break;
        for (const artist of batch) {
          if (stopRequested) { status.stoppedReason = 'stopped'; break outer; }
          try {
            const tags = await fetchTags(provider, artist, key);
            await saveArtistTags(db, artist.id, provider, tags ? normaliseProviderTags(tags) : [], tags ? null : 'lookup failed');
          } catch (error: any) {
            if (isRateLimitError(error)) { status.stoppedReason = `rate limited by ${provider}`; break outer; }
            await saveArtistTags(db, artist.id, provider, [], String(error?.message || error).slice(0, 300));
          }
          status.fetched[provider]++;
          if (status.remaining) status.remaining[provider] = Math.max(0, status.remaining[provider] - 1);
          if (++sinceMap >= MAP_EVERY) { sinceMap = 0; onProgress?.(); }
          if (paceMs > 0) await new Promise(resolve => setTimeout(resolve, paceMs));
        }
      }
    }
  } finally {
    if (sinceMap > 0) onProgress?.();
    status.running = false;
    status.finishedAt = new Date().toISOString();
    if (!status.stoppedReason) status.stoppedReason = 'done';
    console.log(`[GenreTaxonomy] Artist tag backfill ${status.stoppedReason}: Last.fm ${status.fetched.lastfm}, MusicBrainz ${status.fetched.musicbrainz} artist(s) fetched`);
  }
  // Snapshot after the finally block, so callers see the final reason.
  return getArtistTagBackfillStatus();
}
