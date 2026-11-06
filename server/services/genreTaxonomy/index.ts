/**
 * Genre & style taxonomy: startup seeding and tag mapping
 * (docs/Aurora genre and style redesign.md, phase 1). Runs in the background
 * after the database connects; nothing here blocks playback or scanning.
 */
import { initDB } from '../../database';
import { getMappingCoverage } from './coverage';
import { mappingIsCurrent, runTagMapping } from './mapping';
import { loadMbSnapshotIfNeeded, seedTaxonomy } from './seed';
import { backfillTrackTags } from './trackTags';
import { runArtistTagBackfill } from './artistTagBackfill';

export { getMappingCoverage } from './coverage';
export { runTagMapping } from './mapping';
export { getArtistTagBackfillStatus, stopArtistTagBackfill, countRemaining as countArtistTagsRemaining } from './artistTagBackfill';

const log = (message: string) => console.log(`[GenreTaxonomy] ${message}`);
let running: Promise<void> | null = null;
let rerunRequested = false;
let scheduled: NodeJS.Timeout | null = null;

async function mapNow(full: boolean) {
  const db = await initDB();
  const started = Date.now();
  const result = await runTagMapping(db, { full });
  if (result.keys > 0) {
    log(`Mapped ${result.mapped}/${result.keys} new tag keys (${full ? 'full' : 'incremental'}, v${result.version}, ${Date.now() - started} ms)`);
  }
}

/** Startup: seed taxonomy and MusicBrainz genres, backfill track tags, map. */
export async function initializeGenreTaxonomy(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const db = await initDB();
    await seedTaxonomy(db);
    await loadMbSnapshotIfNeeded(db);
    const backfilled = await backfillTrackTags(db);
    if (backfilled) log(`Backfilled tags for ${backfilled} tracks`);
    await mapNow(!(await mappingIsCurrent()));
    const coverage = await getMappingCoverage(db, 0);
    log(`Coverage ${(coverage.tracks.coverage * 100).toFixed(1)} % of tagged tracks; ${coverage.tags.unmapped} unmapped tag(s), ${coverage.mappings.unreviewed} mapping(s) to review`);
  })().finally(() => { running = null; });
  // Optional provider evidence: slow, resumable; does nothing without a provider.
  void running.then(() => startArtistTagBackfill()).catch(() => {});
  return running;
}

/** Starts the artist-tag backfill in the background; maps new artist tags as it goes. */
export function startArtistTagBackfill() {
  runArtistTagBackfill({ onProgress: () => scheduleTagMapping(1000) })
    .catch(error => console.error('[GenreTaxonomy] Artist tag backfill failed:', error?.message || error));
}

/** Debounced incremental mapping after a scan wrote new tags. */
export function scheduleTagMapping(delayMs = 5000) {
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(async () => {
    scheduled = null;
    if (running) { rerunRequested = true; return; }
    running = mapNow(false).finally(() => {
      running = null;
      if (rerunRequested) { rerunRequested = false; scheduleTagMapping(delayMs); }
    });
    running.catch(error => console.error('[GenreTaxonomy] Tag mapping failed:', error?.message || error));
  }, delayMs);
}
