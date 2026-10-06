import { logLoudness } from './loggingConfig';
import { spawn } from 'child_process';
import { initDB, setTrackLoudness, getUserSetting, getSystemSetting } from '../database';
import { isPathAllowed } from '../state';

// ─── Loudness measurement (EBU R128 via ffmpeg) ───────────────────────
// The library is untagged for loudness, so we compute it. This is a separate,
// whole-file ffmpeg pass (the Python analyzer only decodes a 15s mono window,
// and the HLS ffmpeg remuxes with -c:a copy — neither yields integrated LUFS).
// Everything here is background-only and MUST NOT block a request: measurement
// decodes the entire file (seconds for lossless).

const MEASURE_TIMEOUT_MS = 120_000;

/**
 * Measure a file's integrated loudness (LUFS) and true peak (dBTP) with
 * `ffmpeg loudnorm print_format=json` (a single self-delimiting JSON object on
 * stderr — one JSON.parse, no locale-sensitive line regexes). Never throws;
 * resolves to null on any failure (spawn error, non-zero exit, timeout,
 * unparseable output, silent/non-finite result, or a disallowed path).
 */
export async function measureLoudness(fsPath: string): Promise<{ lufs: number; truePeakDbfs: number } | null> {
  if (!fsPath) return null;
  try {
    if (!(await isPathAllowed(Buffer.from(fsPath, 'utf8')))) {
      console.warn('[Loudness] Skipped path outside configured libraries:', fsPath);
      return null;
    }
  } catch (error) {
    console.warn('[Loudness] Unable to check library path:', error);
    return null;
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    logLoudness('[Loudness] Measurement started', { filePath: fsPath });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stderr = '';
    const finish = (v: { lufs: number; truePeakDbfs: number } | null, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const context = { filePath: fsPath, durationMs: Date.now() - startedAt };
      if (v) logLoudness('[Loudness] Measurement completed', { ...context, ...v });
      else console.warn('[Loudness] Measurement failed', { ...context, reason, stderr: stderr.slice(-4096) });
      resolve(v);
    };

    let child;
    try {
      child = spawn(
        'ffmpeg',
        ['-hide_banner', '-nostats', '-i', fsPath, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
    } catch (error) {
      return finish(null, `Unable to start ffmpeg: ${String(error)}`);
    }

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(null, `Timed out after ${MEASURE_TIMEOUT_MS}ms`);
    }, MEASURE_TIMEOUT_MS);

    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString();
      // Bound memory on a pathological/long run; the JSON summary is at the end.
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
    });
    child.on('error', error => finish(null, `ffmpeg error: ${error.message}`));
    child.on('close', (code: number | null, signal: string | null) => {
      if (code !== 0) return finish(null, `ffmpeg exited (code=${code}, signal=${signal})`);
      // loudnorm prints one flat JSON object last (no nested braces).
      const start = stderr.lastIndexOf('{');
      const end = stderr.lastIndexOf('}');
      if (start === -1 || end <= start) return finish(null, 'Missing loudness summary');
      try {
        const parsed = JSON.parse(stderr.slice(start, end + 1));
        const lufs = Number(parsed.input_i);
        const truePeakDbfs = Number(parsed.input_tp);
        if (!Number.isFinite(lufs) || !Number.isFinite(truePeakDbfs)) return finish(null, 'Silent audio or non-finite loudness result');
        finish({ lufs, truePeakDbfs });
      } catch {
        finish(null, 'Invalid loudness summary');
      }
    });
  });
}

// ─── Fire-and-forget measurement (deduped) ────────────────────────────
// Small in-flight Set so concurrent playbacks of the same track don't stack
// measurements. The job self-checks the sentinel and bails if already
// attempted, so an already-measured track costs one PK lookup, not a decode.
const inFlight = new Set<string>();

export function fireLoudnessMeasurement(trackId: string, fsPath: string): void {
  if (!trackId || !fsPath) return;
  const key = `loudness_${trackId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  void (async () => {
    try {
      const db = await initDB();
      const r = await db.query('SELECT loudness_measured_at FROM track_features WHERE track_id = $1', [trackId]);
      if (r.rows[0]?.loudness_measured_at) return; // already attempted (success or recorded failure)
      const result = await measureLoudness(fsPath);
      // (null, null) records a failure sentinel so we don't retry forever.
      await setTrackLoudness(trackId, result?.lufs ?? null, result?.truePeakDbfs ?? null);
    } catch (e) {
      console.error('[Loudness] measurement failed', trackId, (e as Error).message);
    } finally {
      inFlight.delete(key);
    }
  })();
}

/**
 * Gate the lazy playback trigger on (a) the system compute mode and (b) the
 * user's opt-in. Loudness is intrinsic, shared track data, so a single enabled
 * user warms the cache for everyone; a user who hasn't turned normalization on
 * triggers zero ffmpeg from playback. When the mode is 'full', on-play
 * measurement is off entirely (the library is measured by scan/manual backfill).
 * (Explicit library backfill is operator-driven and bypasses this gate.)
 */
export async function maybeMeasureLoudnessForUser(userId: string | undefined, trackId: string, fsPath: string): Promise<void> {
  if (!userId || !trackId || !fsPath) return;
  try {
    // Default (unset) → 'both', so lazy is allowed unless the admin picked 'full'.
    if ((await getSystemSetting('loudnessComputeMode')) === 'full') return;
    if ((await getUserSetting(userId, 'loudnessNormEnabled')) !== true) return;
  } catch {
    return; // if we can't confirm the user wants it, do nothing
  }
  fireLoudnessMeasurement(trackId, fsPath);
}
