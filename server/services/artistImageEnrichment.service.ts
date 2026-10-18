import { getArtistsNeedingImage, getSystemSetting } from '../database';
import { getArtistData } from './metadata';

// Bounded, background batch job that fills in artist pictures for the whole
// library — not just the artists you happen to browse. The Artists grid renders
// initials until a row has an image_url, so this is what turns those into photos.
//
// LIBRARY IS CANON: this never runs unless the user has actually configured a
// metadata provider. No provider → no images, just initials, and the batch
// no-ops. getArtistData() itself reads the user's chosen artist-image provider
// (providerArtistImage in Settings → Metadata) and only fetches from configured
// providers, so this service just decides *which* artists to feed it and when to
// stop — it never overrides the provider preference.
//
// getArtistData() writes image_url via upsertArtistCache and is throttled per
// provider (Last.fm / Genius / MusicBrainz token buckets in metadata/rateLimiter
// + metadata/providers/musicbrainz), so a serial loop here is already rate-safe.
// It stamps last_updated only when the lookup completed, so artists the provider
// has no image for drop out of getArtistsNeedingImage until the cache TTL — while
// artists whose lookup failed (rate limit, outage) stay unstamped. A failed
// lookup ends the run: the provider is unlikely to recover mid-run, and the same
// unstamped artists would otherwise be fetched again and again.
//
// Purging images when an artist is removed needs no work here: artist images are
// URL-only (stored in artists.image_url, no local file cache), so deleting the
// orphaned artist row (purgeOrphanedEntities) is the purge.

export interface ArtistImageEnrichmentResult {
  attempted: number;
  succeeded: number;   // got an image_url back
  noImage: number;     // provider had no picture (still marked done so we stop asking)
  failed: number;
  ranOutOfQuota: boolean;
  stoppedOnError?: string; // a lookup failed; the rest waits for the next run
  skipped?: 'already_running' | 'no_provider';
}

const PER_QUERY = 200;          // page size when scanning for work
const MAX_PER_RUN = 20000;      // hard ceiling so one run can't loop forever
// Pause between artists. The provider throttles are tuned for someone waiting on
// an artist page (Genius 4 req/s); nobody waits on this batch, and a full-speed
// run of a thousand artists is what gets a free API key rate limited (Genius
// blocked prod for over an hour on 2026-10-18). ~1.3 Genius requests/s at most.
const BACKGROUND_PACE_MS = 1500;

let isRunning = false;

async function anyMetadataProviderConfigured(): Promise<boolean> {
  // getArtistData can only produce an image from a configured provider. If the
  // user has wired up none of them, there is nothing to fetch — bail before
  // touching the database so the library stays usable with zero providers.
  const lastFmApiKey = await getSystemSetting('lastFmApiKey');
  if (typeof lastFmApiKey === 'string' && lastFmApiKey.length > 0) return true;
  const geniusApiKey = await getSystemSetting('geniusApiKey');
  if (typeof geniusApiKey === 'string' && geniusApiKey.length > 0) return true;
  const mb = await getSystemSetting('musicBrainzEnabled');
  if (mb === true || mb === 'true') return true;
  return false;
}

/**
 * Fetch and cache images for every artist that still lacks one, in priority
 * order (most-owned artists first), pacing itself on the provider throttles.
 * Resumable: stops on rate-limit and continues on the next invocation since
 * processed artists fall out of the work set. Guarded against concurrent runs.
 */
export async function enrichArtistImages(
  { paceMs = BACKGROUND_PACE_MS }: { paceMs?: number } = {}
): Promise<ArtistImageEnrichmentResult> {
  const empty: ArtistImageEnrichmentResult = {
    attempted: 0, succeeded: 0, noImage: 0, failed: 0, ranOutOfQuota: false,
  };

  if (isRunning) return { ...empty, skipped: 'already_running' };

  if (!(await anyMetadataProviderConfigured())) {
    return { ...empty, skipped: 'no_provider' };
  }

  isRunning = true;
  const result: ArtistImageEnrichmentResult = { ...empty };
  const seen = new Set<string>();
  try {
    while (result.attempted < MAX_PER_RUN) {
      const batch = (await getArtistsNeedingImage(
        Math.min(PER_QUERY, MAX_PER_RUN - result.attempted)
      )).filter((artist) => !seen.has(artist.id));
      if (batch.length === 0) break;

      for (const artist of batch) {
        seen.add(artist.id);
        if (result.attempted > 0 && paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
        result.attempted++;
        try {
          const data = await getArtistData(artist.name, artist.mbid);
          if (data.error && /rate|429/i.test(data.error)) {
            result.ranOutOfQuota = true;
            break;
          }
          if (data.error && !data.imageUrl) {
            result.failed++;
            result.stoppedOnError = data.error;
            break;
          }
          if (data.imageUrl) result.succeeded++;
          else result.noImage++;
        } catch (err: any) {
          const msg = err?.message || String(err);
          if (msg.includes('429') || /rate/i.test(msg)) {
            result.ranOutOfQuota = true;
            break;
          }
          result.failed++;
        }
      }

      if (result.ranOutOfQuota || result.stoppedOnError) break;
    }

    if (result.attempted > 0) {
      console.log(
        `[ArtistImages] enriched ${result.succeeded}/${result.attempted} ` +
        `(no image: ${result.noImage}, failed: ${result.failed}` +
        `${result.ranOutOfQuota ? ', stopped on rate limit' : ''}` +
        `${result.stoppedOnError ? `, stopped on error: ${result.stoppedOnError}` : ''})`
      );
    }
    return result;
  } finally {
    isRunning = false;
  }
}

/** Fire-and-forget trigger for post-scan hooks; never throws into the caller. */
export function enrichArtistImagesInBackground(): void {
  if (isRunning) return;
  setImmediate(() => {
    enrichArtistImages().catch((err) =>
      console.warn('[ArtistImages] background enrichment failed:', err?.message || err)
    );
  });
}
