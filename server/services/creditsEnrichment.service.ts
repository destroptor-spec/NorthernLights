import type { Pool } from 'pg';
import { initDB, setEnrichedTrackCredits, setTrackGeniusSongId, getSystemSetting } from '../database';
import { mbGetRecording } from './metadata/providers/musicbrainz';
import { geniusGetSong, geniusResolveSongId } from './metadata/providers/genius';
import { RateLimitError } from './metadata/errors';

// Tag-driven credits are written during scan (no network). These importers add
// provider-sourced rows alongside them (setEnrichedTrackCredits scopes its
// DELETE by source, so tag rows are never replaced). Aurora stays fully usable
// without ever running them.
//
// ─── Credit imports — automatic, slow, resumable server jobs ──────────────────
// Each provider imports on its own whenever it's configured (MusicBrainz
// connected and enabled; a Genius API key): at startup, every 10 minutes for
// tracks that arrived since, and when an admin opens its settings tab. Nothing
// to start by hand; the tabs only show progress.
//
// Free APIs, so no pointless calls (track_credit_lookups): every lookup is
// recorded with its outcome and the key it used (the MusicBrainz recording id;
// title and artist for Genius). A track is asked about again only when that
// key changes (retagged), after 7 days for a failure, or after 180 days for
// "no credits" (credits get added upstream). Pacing leaves the shared provider
// queues room for interactive lookups: MusicBrainz one track per 1.5 s,
// Genius one per 2 s (a search and a song). A rate limit (429, or 503 from
// MusicBrainz) or a run of failures pauses the import for 30 minutes.

export type CreditsProvider = 'musicbrainz' | 'genius';

export type CreditsImportState =
  /** Looking tracks up now. */
  | 'running'
  /** Waiting out a rate limit or a provider outage; resumes at resumesAt. */
  | 'paused'
  /** Every track is looked up; new ones are picked up as they arrive. */
  | 'idle'
  /** The provider isn't set up (no Genius key; MusicBrainz not connected). */
  | 'off';

export interface CreditsImportStatus {
  state: CreditsImportState;
  /** Tracks the provider can look up (MusicBrainz: with a recording id; Genius: with title and artist). */
  eligible: number;
  /** Of those, looked up with their current key. */
  lookedUp: number;
  /** Looked up and the provider had credits. */
  withCredits: number;
  /** Looked up, no credits on the provider. */
  withoutCredits: number;
  /** Looked up, failed (retried after 7 days). */
  failed: number;
  /** Credit rows on file from this provider. */
  creditRows: number;
  /** Tracks waiting to be looked up (new, retagged or due again). */
  remaining: number;
  /** When a paused import carries on (ms since epoch). */
  resumesAt: number | null;
  /** Why it's paused: 'rate-limit' or 'failures'. */
  pauseReason: 'rate-limit' | 'failures' | null;
  /** When the last full pass finished (ms since epoch). */
  lastFinishedAt: number | null;
}

const TICK_MS = 10 * 60_000;
const PAUSE_MS = 30 * 60_000;
const BATCH = 100;
const MAX_CONSECUTIVE_FAILURES = 20;
const PACE_MS: Record<CreditsProvider, number> = { musicbrainz: 1500, genius: 2000 };
let paceOverrideMs: number | null = null;

/** Tests only: no pause between lookups. */
export function setCreditsImportPaceForTests(ms: number | null) {
  paceOverrideMs = ms;
}
const RETRY_FAILED = '7 days';
const RETRY_NONE = '180 days';

const log = (message: string) => console.log(`[Credits] ${message}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The key a lookup used, as SQL over tracks t: when it changes, the track is looked up again. */
const KEY_SQL: Record<CreditsProvider, string> = {
  musicbrainz: `t.mb_recording_id`,
  genius: `lower(btrim(t.title)) || '|' || lower(btrim(COALESCE(t.artist, t.album_artist)))`,
};
const ELIGIBLE_SQL: Record<CreditsProvider, string> = {
  musicbrainz: `t.mb_recording_id IS NOT NULL AND t.mb_recording_id <> ''`,
  genius: `COALESCE(btrim(t.title), '') <> '' AND COALESCE(btrim(COALESCE(t.artist, t.album_artist)), '') <> ''`,
};
/** A track to look up: never looked up, retagged, or due again. */
const DUE_SQL = (provider: CreditsProvider) => `
  ${ELIGIBLE_SQL[provider]}
  AND (l.track_id IS NULL OR l.lookup_key IS DISTINCT FROM ${KEY_SQL[provider]}
       OR (l.outcome = 'failed' AND l.looked_up_at < NOW() - INTERVAL '${RETRY_FAILED}')
       OR (l.outcome = 'none' AND l.looked_up_at < NOW() - INTERVAL '${RETRY_NONE}'))`;

interface Runner {
  running: boolean;
  pausedUntil: number | null;
  pauseReason: 'rate-limit' | 'failures' | null;
  lastFinishedAt: number | null;
  stopRequested: boolean;
}
const runners: Record<CreditsProvider, Runner> = {
  musicbrainz: { running: false, pausedUntil: null, pauseReason: null, lastFinishedAt: null, stopRequested: false },
  genius: { running: false, pausedUntil: null, pauseReason: null, lastFinishedAt: null, stopRequested: false },
};

async function isConfigured(provider: CreditsProvider): Promise<{ ok: boolean; geniusKey?: string }> {
  if (provider === 'musicbrainz') {
    const [connected, enabled] = await Promise.all([getSystemSetting('musicBrainzConnected'), getSystemSetting('musicBrainzEnabled')]);
    const on = (v: unknown) => v === true || v === 'true';
    return { ok: on(connected) && (enabled === null || enabled === undefined || on(enabled)) };
  }
  const key = await getSystemSetting('geniusApiKey');
  return typeof key === 'string' && key.length > 0 ? { ok: true, geniusKey: key } : { ok: false };
}

// ProviderError carries the HTTP status in statusCode; MusicBrainz errors also
// say it in the message ("MusicBrainz HTTP 503").
const statusOf = (err: any): number | null => Number(err?.statusCode ?? err?.status) || null;
const isRateLimit = (err: any) => {
  if (err instanceof RateLimitError) return true;
  const status = statusOf(err);
  if (status === 429 || status === 503) return true;
  const message = String(err?.message || '');
  return /\b(429|503)\b/.test(message) || /rate.?limit/i.test(message);
};
const isNotFound = (err: any) => statusOf(err) === 404 || /\b404\b/.test(String(err?.message || ''));

type Due = { id: string; key: string; mb_recording_id: string | null; title: string; artist: string; genius_song_id: string | null };

async function nextBatch(db: Pool, provider: CreditsProvider): Promise<Due[]> {
  return (await db.query(`
    SELECT t.id, ${KEY_SQL[provider]} AS key, t.mb_recording_id, t.title, COALESCE(t.artist, t.album_artist) AS artist, t.genius_song_id
    FROM tracks t
    LEFT JOIN track_credit_lookups l ON l.track_id = t.id AND l.source = $1
    WHERE ${DUE_SQL(provider)}
    ORDER BY (l.track_id IS NOT NULL), t.id
    LIMIT $2`, [provider, BATCH])).rows as Due[];
}

async function record(db: Pool, provider: CreditsProvider, track: Due, outcome: 'found' | 'none' | 'failed', credits = 0) {
  await db.query(`
    INSERT INTO track_credit_lookups (track_id, source, lookup_key, outcome, credits, looked_up_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (track_id, source) DO UPDATE SET
      lookup_key = EXCLUDED.lookup_key, outcome = EXCLUDED.outcome, credits = EXCLUDED.credits, looked_up_at = EXCLUDED.looked_up_at`,
  [track.id, provider, track.key, outcome, credits]);
}

/** Credit rows written for one track, or null when the provider has none. */
async function lookUp(provider: CreditsProvider, track: Due, geniusKey?: string): Promise<number | null> {
  if (provider === 'musicbrainz') {
    const credits = await mbGetRecording(String(track.mb_recording_id));
    // None now (a retagged track): earlier rows from this provider go too.
    if (!credits.length) { await setEnrichedTrackCredits(track.id, 'musicbrainz', []); return null; }
    await setEnrichedTrackCredits(track.id, 'musicbrainz', credits.map(c => ({ role: c.role, name: c.name, detail: c.detail })));
    return credits.length;
  }
  // Resolve the Genius song id once and keep it on the track, so a later
  // lookup (after 180 days) skips the search.
  let songId: string | number | null = track.genius_song_id;
  if (!songId) {
    const resolved = await geniusResolveSongId(track.title, track.artist, geniusKey!);
    if (!resolved) { await setEnrichedTrackCredits(track.id, 'genius', []); return null; }
    songId = resolved;
    await setTrackGeniusSongId(track.id, String(resolved));
  }
  const credits = await geniusGetSong(songId, geniusKey!);
  if (!credits.length) { await setEnrichedTrackCredits(track.id, 'genius', []); return null; }
  await setEnrichedTrackCredits(track.id, 'genius', credits.map(c => ({ role: c.role, name: c.name })));
  return credits.length;
}

function pause(provider: CreditsProvider, reason: 'rate-limit' | 'failures') {
  const runner = runners[provider];
  runner.pausedUntil = Date.now() + PAUSE_MS;
  runner.pauseReason = reason;
  log(`${provider}: paused for ${PAUSE_MS / 60_000} minutes (${reason === 'rate-limit' ? 'rate limited' : 'repeated failures'})`);
  setTimeout(() => { void ensureCreditsImport(provider); }, PAUSE_MS + 1000).unref?.();
}

async function run(provider: CreditsProvider): Promise<void> {
  const runner = runners[provider];
  const db = await initDB();
  let imported = 0;
  let looked = 0;
  let consecutiveFailures = 0;
  const started = Date.now();
  try {
    for (;;) {
      const config = await isConfigured(provider);
      if (!config.ok || runner.stopRequested) return;
      const batch = await nextBatch(db, provider);
      if (!batch.length) {
        runner.lastFinishedAt = Date.now();
        if (looked > 0) log(`${provider}: looked up ${looked} tracks, ${imported} with credits, in ${Math.round((Date.now() - started) / 60_000)} min`);
        return;
      }
      for (const track of batch) {
        if (runner.stopRequested) return;
        try {
          const written = await lookUp(provider, track, config.geniusKey);
          await record(db, provider, track, written ? 'found' : 'none', written ?? 0);
          if (written) imported++;
          consecutiveFailures = 0;
        } catch (err: any) {
          if (isRateLimit(err)) { pause(provider, 'rate-limit'); return; }
          if (isNotFound(err)) {
            await record(db, provider, track, 'none');
          } else {
            await record(db, provider, track, 'failed');
            if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { pause(provider, 'failures'); return; }
          }
        }
        looked++;
        await sleep(paceOverrideMs ?? PACE_MS[provider]);
      }
    }
  } finally {
    runner.running = false;
  }
}

/**
 * Starts a provider's import when it's set up, has work, and isn't already
 * running or paused. Cheap to call often: the scheduler, startup and the
 * settings tab call it.
 */
export async function ensureCreditsImport(provider: CreditsProvider): Promise<void> {
  const runner = runners[provider];
  if (runner.running) return;
  if (runner.pausedUntil && runner.pausedUntil > Date.now()) return;
  runner.pausedUntil = null;
  runner.pauseReason = null;
  if (!(await isConfigured(provider)).ok) return;
  runner.running = true;
  runner.stopRequested = false;
  void run(provider).catch(error => {
    runner.running = false;
    console.error(`[Credits] ${provider} import failed:`, error?.message || error);
  });
}

let scheduler: NodeJS.Timeout | null = null;

/** Starts both imports and checks for new work every 10 minutes. Server startup only. */
export function startCreditsImports() {
  if (scheduler) return;
  const tick = () => { void ensureCreditsImport('musicbrainz'); void ensureCreditsImport('genius'); };
  // Let startup work (scans, the genre taxonomy) go first.
  setTimeout(tick, 2 * 60_000).unref?.();
  scheduler = setInterval(tick, TICK_MS);
  scheduler.unref?.();
}

export function stopCreditsImports() {
  if (scheduler) clearInterval(scheduler);
  scheduler = null;
  runners.musicbrainz.stopRequested = true;
  runners.genius.stopRequested = true;
}

/** What the settings tab shows: the importer's state and counts from the lookup log. */
export async function getCreditsImportStatus(provider: CreditsProvider): Promise<CreditsImportStatus> {
  const db = await initDB();
  const runner = runners[provider];
  const [config, counts] = await Promise.all([
    isConfigured(provider),
    db.query(`
      SELECT COUNT(*) FILTER (WHERE ${ELIGIBLE_SQL[provider]})::int AS eligible,
             COUNT(*) FILTER (WHERE ${ELIGIBLE_SQL[provider]} AND l.lookup_key IS NOT DISTINCT FROM ${KEY_SQL[provider]} AND l.track_id IS NOT NULL)::int AS looked_up,
             COUNT(*) FILTER (WHERE ${ELIGIBLE_SQL[provider]} AND l.lookup_key IS NOT DISTINCT FROM ${KEY_SQL[provider]} AND l.outcome = 'found')::int AS found,
             COUNT(*) FILTER (WHERE ${ELIGIBLE_SQL[provider]} AND l.lookup_key IS NOT DISTINCT FROM ${KEY_SQL[provider]} AND l.outcome = 'none')::int AS none,
             COUNT(*) FILTER (WHERE ${ELIGIBLE_SQL[provider]} AND l.lookup_key IS NOT DISTINCT FROM ${KEY_SQL[provider]} AND l.outcome = 'failed')::int AS failed,
             COUNT(*) FILTER (WHERE ${DUE_SQL(provider)})::int AS remaining,
             (SELECT COUNT(*) FROM track_artist_credits WHERE source = $1)::int AS credit_rows
      FROM tracks t
      LEFT JOIN track_credit_lookups l ON l.track_id = t.id AND l.source = $1`, [provider]),
  ]);
  const c = counts.rows[0];
  const paused = !!runner.pausedUntil && runner.pausedUntil > Date.now();
  const state: CreditsImportState = !config.ok ? 'off' : runner.running ? 'running' : paused ? 'paused' : 'idle';
  return {
    state,
    eligible: c.eligible,
    lookedUp: c.looked_up,
    withCredits: c.found,
    withoutCredits: c.none,
    failed: c.failed,
    creditRows: c.credit_rows,
    remaining: c.remaining,
    resumesAt: paused ? runner.pausedUntil : null,
    pauseReason: paused ? runner.pauseReason : null,
    lastFinishedAt: runner.lastFinishedAt,
  };
}
