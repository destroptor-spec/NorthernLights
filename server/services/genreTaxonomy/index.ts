/**
 * Genre & style taxonomy: startup seeding, tag mapping (phase 1), fusion
 * (phase 2) and style centroids (phase 3) of docs/Aurora genre and style
 * redesign.md. Runs in the background after the database connects; nothing
 * here blocks playback or scanning.
 */
import { initDB } from '../../database';
import { getMappingCoverage } from './coverage';
import { mappingIsCurrent, runTagMapping } from './mapping';
import { loadMbSnapshotIfNeeded, seedTaxonomy } from './seed';
import { backfillTrackTags } from './trackTags';
import { runArtistTagBackfill } from './artistTagBackfill';
import { FUSION_VERSION, fusionIsCurrent, runFusion } from './fusion';
import { rebuildCentroids } from './centroids';
import { backfillArtistCountries, rebuildTrackOrigin, startFileOriginBackfill } from '../trackOrigin.service';

export { getMappingCoverage } from './coverage';
export { runTagMapping } from './mapping';
export { getFusionStatus, runFusion, setTrackStyleOverride, TrackStyleOverrideError } from './fusion';
export { listDisputedStyles } from './disputed';
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
    // Fusion has never run, or its rules changed: rebuild every track now.
    if (!(await fusionIsCurrent())) await fuseNow();
    // Fused before centroids existed (phase 3): build them once without a full fusion run.
    else if (!(await db.query('SELECT 1 FROM style_centroids LIMIT 1')).rowCount) {
      const built = await rebuildCentroids(db, FUSION_VERSION);
      log(`Built ${built} style centroids`);
    }
    // Fused before track origins existed: build them once from stored data.
    if (!(await db.query('SELECT 1 FROM track_origin LIMIT 1')).rowCount) {
      const artists = await backfillArtistCountries(db);
      const placed = await rebuildTrackOrigin(db);
      log(`Placed ${placed} tracks (${artists} artist countries from their areas)`);
    }
  })().finally(() => { running = null; });
  // Optional provider evidence: slow, resumable; does nothing without a provider.
  void running.then(() => startArtistTagBackfill()).catch(() => {});
  // Release country and lyrics language of files scanned before Aurora kept them.
  void running.then(() => startFileOriginBackfill(initDB)).catch(() => {});
  return running;
}

/** Starts the artist-tag backfill in the background; maps new artist tags as it goes. */
export function startArtistTagBackfill() {
  runArtistTagBackfill({ onProgress: () => scheduleTagMapping(1000) })
    .catch(error => console.error('[GenreTaxonomy] Artist tag backfill failed:', error?.message || error));
}

async function fuseNow() {
  const status = await runFusion(await initDB());
  const g = status.byGenreSource;
  log(`Fused ${status.tracks} tracks in ${status.durationMs} ms: genre from tags ${g.tag}, artist tags ${g.artist}, sound ${g.audio}, by hand ${g.override}, unsorted ${g.unsorted}; ${status.withStyle} with a style, ${status.addedFromSound} styles added from the sound, ${status.disputed} disputed`);
}

// Fusion is a full rebuild (about 10 s per 30,000 tracks), so requests are
// debounced; a steady stream (an analysis run) still fuses every 10 minutes.
const FUSION_DEBOUNCE_MS = 30_000;
const FUSION_MAX_WAIT_MS = 10 * 60_000;
let fusionTimer: NodeJS.Timeout | null = null;
let fusionFirstRequest = 0;
let fusionRunning: Promise<void> | null = null;
let fusionRerun = false;

/**
 * Rebuilds genres and styles after tags, mappings, review answers, artist
 * tags or style scores changed. `delayMs` shortens the wait for changes made
 * by hand (a review answer should show in Browse soon).
 */
export function scheduleFusion(delayMs = FUSION_DEBOUNCE_MS) {
  // Tests run fusion directly; a timer firing mid-suite would race them.
  if (process.env.NODE_ENV === 'test') return;
  const now = Date.now();
  if (!fusionTimer) fusionFirstRequest = now;
  else clearTimeout(fusionTimer);
  const wait = Math.max(0, Math.min(delayMs, fusionFirstRequest + FUSION_MAX_WAIT_MS - now));
  fusionTimer = setTimeout(() => {
    fusionTimer = null;
    if (fusionRunning || running) { fusionRerun = true; return; }
    fusionRunning = fuseNow()
      .catch(error => console.error('[GenreTaxonomy] Fusion failed:', error?.message || error))
      .finally(() => {
        fusionRunning = null;
        if (fusionRerun) { fusionRerun = false; scheduleFusion(); }
      });
  }, wait);
  fusionTimer.unref?.();
}

/** Debounced incremental mapping after a scan wrote new tags; fusion follows. */
export function scheduleTagMapping(delayMs = 5000) {
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(async () => {
    scheduled = null;
    if (running) { rerunRequested = true; return; }
    running = mapNow(false).finally(() => {
      running = null;
      if (rerunRequested) { rerunRequested = false; scheduleTagMapping(delayMs); }
      scheduleFusion();
    });
    running.catch(error => console.error('[GenreTaxonomy] Tag mapping failed:', error?.message || error));
  }, delayMs);
}
