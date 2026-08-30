import { spawn, execFileSync, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeHlsServerLog, writeHlsSessionLog } from './debugLogger.service';
import { logHls, logFfmpeg } from './loggingConfig';

// ─── Types ──────────────────────────────────────────────────────────────

interface HlsSession {
  trackId: string;
  quality: string;
  codec: string;
  outputDir: string;
  playlistPath: string;
  ffmpegProcess: ChildProcess | null;
  createdAt: number;
  lastAccessedAt: number;
  ready: boolean;               // true once playlist contains a segment entry
  readyPromise: Promise<void>;  // resolves when the playlist has a playable segment
  segmentCount: number;
  finished: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────

const HLS_BASE_DIR = path.join(os.tmpdir(), 'nl-hls-streams');
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes of inactivity
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const HLS_SEGMENT_DURATION = 10; // seconds per chunk

// ─── Session Store ──────────────────────────────────────────────────────

const activeSessions = new Map<string, HlsSession>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function sessionKey(trackId: string, quality: string, codec: string): string {
  return `${trackId}::${quality}::${codec}`;
}

function getSessionKeyParts(key: string): { trackId: string; quality: string; codec: string } | null {
  const parts = key.split('::');
  if (parts.length !== 3) return null;
  return { trackId: parts[0], quality: parts[1], codec: parts[2] };
}

function logHlsSession(trackId: string, quality: string, codec: string, line: string) {
  writeHlsServerLog(`[session ${trackId} ${quality} ${codec}] ${line}`);
  writeHlsSessionLog(trackId, quality, codec, line);
}

function summarizePlaylist(content: string): string {
  return content
    .split(/\r?\n/)
    .slice(0, 16)
    .join('\\n');
}

/**
 * FFmpeg writes a growing `#EXT-X-PLAYLIST-TYPE:EVENT` playlist and only adds
 * `#EXT-X-ENDLIST` once the transcode finishes. Shaka on the Cast receiver
 * reads a playlist with no ENDLIST as a *live* presentation: it reports
 * `duration=-1` and starts playback near the end of what exists — about one
 * segment in. Any track loaded before its transcode completed therefore began
 * ~10s late, losing the start of the song (prod 2026-08-30: 8 of 23 track
 * starts, all of them explicit queue loads rather than prewarmed auto-advances).
 *
 * Rewriting the partial playlist into a complete VOD one from the track
 * duration we already hold gives the player the real timeline, so it starts at
 * 0 and can seek. Requests for segments FFmpeg has not written yet are held by
 * the segment route until they are listed.
 *
 * Returns null when completion isn't safe — unknown duration, no EXTINF to
 * derive the segment grid from, or an already-terminated playlist — and
 * callers then serve FFmpeg's playlist unchanged.
 *
 * On segment count this deliberately errs low. FFmpeg cuts each segment at the
 * first frame boundary at or after the `hls_time` mark, so real segment
 * lengths drift either side of the first EXTINF rather than holding it exactly,
 * and the encoded stream also runs fractionally longer than the source
 * (measured at 0.021–0.040s). Both push the true segment count up: a 200.000s
 * 44.1kHz source encodes to 200.039912s across 21 segments where ceil() here
 * says 20. Verified against real FFmpeg output, this only ever under-counts,
 * and only by one, and only when the duration sits on a grid boundary — see
 * FFMPEG_GROUND_TRUTH in the tests. That is the safe direction: under-counting
 * drops a sub-frame tail (23ms in the example above, inaudible), while
 * over-counting would send the player after a segment that never exists and
 * stall the end of the track.
 */
const SEGMENT_WAIT_TIMEOUT_MS = 30000;
const SEGMENT_WAIT_POLL_MS = 50;

/**
 * A synthesized VOD playlist lets the player ask for a segment FFmpeg has not
 * produced yet. FFmpeg writes the segment file *before* appending it to the
 * playlist, so file existence alone would happily serve a half-written segment;
 * "listed in the playlist" is the only completeness signal available. Shared by the
 * web and Subsonic segment routes. Hold the request until the segment is listed, the session finishes without it, or the
 * timeout expires.
 */
export async function waitForSegmentListed(
  playlistPath: string,
  segmentName: string,
  isFinished: () => boolean,
): Promise<boolean> {
  const isListed = (): boolean => {
    try {
      if (!fs.existsSync(playlistPath)) return false;
      return fs.readFileSync(playlistPath, 'utf8')
        .split(/\r?\n/)
        .some((line) => line.trim() === segmentName);
    } catch {
      return false; // playlist mid-write
    }
  };

  const deadline = Date.now() + SEGMENT_WAIT_TIMEOUT_MS;
  for (;;) {
    if (isListed()) return true;
    // Re-check after observing completion: the final segment and the finished
    // flag can land between two polls.
    if (isFinished()) return isListed();
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, SEGMENT_WAIT_POLL_MS));
  }
}

export function completeVodPlaylist(playlist: string, durationSec: number | null): string | null {
  if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  if (playlist.includes('#EXT-X-ENDLIST')) return null;

  const lines = playlist.split(/\r?\n/);
  const extinfDurations: number[] = [];
  for (const line of lines) {
    if (!line.startsWith('#EXTINF:')) continue;
    const value = parseFloat(line.slice('#EXTINF:'.length).split(',')[0] || '');
    if (Number.isFinite(value) && value > 0) extinfDurations.push(value);
  }
  if (extinfDurations.length === 0) return null;

  // FFmpeg emits a constant segment length (the trailing segment aside), so the
  // first EXTINF defines the grid for the whole track. Deriving it from the
  // real playlist rather than assuming HLS_SEGMENT_DURATION keeps the announced
  // durations exact — they are frame-aligned, e.g. 10.007800 at 44.1kHz.
  const segmentDuration = extinfDurations[0];
  const totalSegments = Math.ceil(durationSec / segmentDuration);
  if (!Number.isFinite(totalSegments) || totalSegments < extinfDurations.length) return null;

  const header = lines.filter((line) => (
    line.startsWith('#EXTM3U')
    || line.startsWith('#EXT-X-VERSION:')
    || line.startsWith('#EXT-X-TARGETDURATION:')
    || line.startsWith('#EXT-X-MEDIA-SEQUENCE:')
    || line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')
  ));

  const finalSegmentDuration = durationSec - segmentDuration * (totalSegments - 1);
  const output = [...header, '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let index = 0; index < totalSegments; index += 1) {
    const isFinal = index === totalSegments - 1;
    const extinf = isFinal && finalSegmentDuration > 0 && finalSegmentDuration <= segmentDuration
      ? finalSegmentDuration
      : segmentDuration;
    output.push(`#EXTINF:${extinf.toFixed(6)},`);
    output.push(`segment${String(index).padStart(3, '0')}.ts`);
  }
  output.push('#EXT-X-ENDLIST');
  output.push('');
  return output.join('\n');
}

function countPlaylistSegments(content: string): number {
  return (content.match(/^segment\d+\.ts$/gm) || []).length;
}

function inspectTransportSegment(segmentPath: string): string {
  try {
    const output = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=format_name,duration,size:stream=index,codec_name,codec_type,codec_tag_string,profile,sample_rate,channels',
      '-of', 'json',
      segmentPath,
    ], { timeout: 5000 }).toString().trim();
    return output || '{"error":"empty ffprobe output"}';
  } catch (err: any) {
    return JSON.stringify({ error: err?.message || String(err) });
  }
}

// ─── Core API ───────────────────────────────────────────────────────────

/**
 * Get or create an HLS session for a given track + quality combination.
 * Returns as soon as the first segment is written — FFmpeg continues in background.
 */
export async function getOrCreateHlsSession(
  trackId: string,
  trackPath: Buffer,
  quality: string,
  sourceBitrate: number | null,
  sourceFormat: string | null,
  targetCodec: string
): Promise<HlsSession> {
  const key = sessionKey(trackId, quality, targetCodec);

  // Reuse existing session if available
  const existing = activeSessions.get(key);
  if (existing) {
    const failedWithoutPlaylist = existing.ready
      && existing.finished
      && (!fs.existsSync(existing.playlistPath) || existing.segmentCount === 0);

    if (failedWithoutPlaylist) {
      logHlsSession(trackId, quality, targetCodec, 'Discarding failed zero-segment session before retry');
      cleanupSession(trackId, quality, targetCodec);
    } else {
      existing.lastAccessedAt = Date.now();
      if (!existing.ready) {
        await existing.readyPromise;
      }
      return existing;
    }
  }

  // Create output directory — hash the key to guarantee a short, fixed-length name
  const dirHash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const outputDir = path.join(HLS_BASE_DIR, dirHash);
  fs.mkdirSync(outputDir, { recursive: true });

  const playlistPath = path.join(outputDir, 'playlist.m3u8');
  // Relative filenames for FFmpeg — absolute paths cause it to embed /tmp/... in the playlist,
  // which the Chromecast interprets as URLs and fetches 404. Use cwd: outputDir instead.
  const playlistFilename = 'playlist.m3u8';
  const segmentFilename = 'segment%03d.ts';

  // Determine encoding strategy
  const inputPath = trackPath.toString('utf8');
  const shouldRemux = getRemuxDecision(quality, sourceBitrate, sourceFormat, targetCodec, inputPath);
  logHlsSession(trackId, quality, targetCodec, `Creating session in ${outputDir}`);
  logHlsSession(trackId, quality, targetCodec, `Input path: ${inputPath}`);
  logHlsSession(trackId, quality, targetCodec, `Remux decision: ${shouldRemux ? 'copy' : 'transcode'}`);

  // Build FFmpeg args
  const ffmpegArgs = buildFfmpegArgs(inputPath, playlistFilename, segmentFilename, quality, shouldRemux, targetCodec, sourceBitrate);
  logHlsSession(trackId, quality, targetCodec, `FFmpeg args: ${ffmpegArgs.join(' ')}`);

  // Create the readiness promise — resolves when segment000.ts appears
  let resolveReady: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const session: HlsSession = {
    trackId,
    quality,
    codec: targetCodec,
    outputDir,
    playlistPath,
    ffmpegProcess: null,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    ready: false,
    readyPromise,
    segmentCount: 0,
    finished: false,
  };

  activeSessions.set(key, session);

  // Spawn FFmpeg with cwd: outputDir so segment filenames in the playlist are relative
  logHls(`[HLS DEBUG] Spawning FFmpeg: ${ffmpegArgs.join(' ')}`);
  logHls(`[HLS DEBUG] cwd: ${outputDir}`);
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'], cwd: outputDir });
  session.ffmpegProcess = ffmpeg;
  logHlsSession(trackId, quality, targetCodec, 'FFmpeg process spawned');

  ffmpeg.stderr?.on('data', (data: Buffer) => {
    // FFmpeg writes ALL output to stderr (config banner, progress, AND errors).
    // Only log lines that look like actual errors, not config/progress noise.
    const msg = data.toString();
    logFfmpeg(`[HLS DEBUG] FFmpeg stderr: ${msg.substring(0, 200)}`);
    logHlsSession(trackId, quality, targetCodec, `FFmpeg stderr: ${msg.trim()}`);
    if (/^\[?error|Error while|Invalid|No such file|could not|Cannot/mi.test(msg)) {
      console.error(`[HLS] FFmpeg error for ${trackId}:`, msg.trim());
    }
  });

  ffmpeg.on('exit', (code, signal) => {
    session.ffmpegProcess = null;
    session.finished = true;
    logHlsSession(trackId, quality, targetCodec, `FFmpeg exited with code=${code} signal=${signal}`);
    if (code !== 0 && code !== null && signal !== 'SIGKILL') {
      console.error(`[HLS] FFmpeg exited with code ${code} for track ${trackId}`);
    }
  });

  ffmpeg.on('error', (err) => {
    console.error(`[HLS] FFmpeg spawn error for ${trackId}:`, err);
    logHlsSession(trackId, quality, targetCodec, `FFmpeg spawn error: ${err?.message || String(err)}`);
    session.ffmpegProcess = null;
    // Resolve the promise anyway so callers don't hang
    if (!session.ready) {
      session.ready = true;
      resolveReady!();
    }
  });

  // Resolve as soon as the playlist contains a segment entry — instant-start playback.
  // We check the playlist (not the segment file) because FFmpeg writes the segment
  // first, then updates the playlist. Serving a playlist with no segments causes
  // the CAF Shaka player to close the MediaSource immediately → SourceBuffer error.
  const pollStart = Date.now();
  const POLL_TIMEOUT_MS = 30000; // 30s safety net

  const pollInterval = setInterval(() => {
    try {
      if (fs.existsSync(playlistPath)) {
        const content = fs.readFileSync(playlistPath, 'utf8');
        const segmentCount = countPlaylistSegments(content);
        session.segmentCount = segmentCount;
        logHls(`[HLS DEBUG] Poll: playlist exists, content: ${JSON.stringify(content.substring(0, 200))}`);
        logHlsSession(trackId, quality, targetCodec, `Playlist poll snapshot (${segmentCount} segments): ${summarizePlaylist(content)}`);
        if (segmentCount >= 2 || (segmentCount >= 1 && content.includes('#EXT-X-ENDLIST'))) {
          clearInterval(pollInterval);
          session.ready = true;
          logHls(`[HLS DEBUG] Session ready for track ${trackId}`);
          const firstSegmentPath = path.join(outputDir, 'segment000.ts');
          if (fs.existsSync(firstSegmentPath)) {
            logHlsSession(trackId, quality, targetCodec, `First segment probe: ${inspectTransportSegment(firstSegmentPath)}`);
          } else {
            logHlsSession(trackId, quality, targetCodec, 'First segment probe skipped: segment000.ts missing at ready time');
          }
          resolveReady!();
          return;
        }
      }
    } catch (_) { /* file may be partially written */ }

    if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
      clearInterval(pollInterval);
      console.error(`[HLS] Timeout waiting for first segment of track ${trackId}`);
      logHlsSession(trackId, quality, targetCodec, 'Timed out waiting for playlist to contain first segment');
      session.ready = true;
      resolveReady!();
    }
  }, 50);

  // Also resolve if FFmpeg exits (success or failure) before the poll finds a segment
  ffmpeg.on('exit', () => {
    // Give a brief moment for the final write to flush
    setTimeout(() => {
      if (!session.ready) {
        clearInterval(pollInterval);
        session.ready = true;
        resolveReady!();
      }
    }, 200);
  });

  // Start cleanup timer if not running
  startCleanupTimer();

  // Wait for readiness
  await readyPromise;
  return session;
}

/**
 * Touch a session to keep it alive. Codec is optional — matches by trackId + quality.
 */
export function touchSession(trackId: string, quality: string, codec?: string): void {
  if (codec) {
    const session = activeSessions.get(sessionKey(trackId, quality, codec));
    if (session) {
      session.lastAccessedAt = Date.now();
      return;
    }
  }
}

/**
 * Get the output directory for a session (for serving segments).
 * Codec is optional — matches by trackId + quality.
 */
export function getSessionOutputDir(trackId: string, quality: string, codec?: string): string | null {
  if (codec) {
    const session = activeSessions.get(sessionKey(trackId, quality, codec));
    if (session) return session.outputDir;
  }
  return null;
}

export function getSessionInfo(trackId: string, quality: string, codec: string): Pick<HlsSession, 'playlistPath' | 'quality' | 'codec' | 'segmentCount' | 'finished'> | null {
  const session = activeSessions.get(sessionKey(trackId, quality, codec));
  if (!session) return null;
  return {
    playlistPath: session.playlistPath,
    quality: session.quality,
    codec: session.codec,
    segmentCount: session.segmentCount,
    finished: session.finished,
  };
}

/**
 * Return all active session variants for a trackId.
 */
export function getActiveSessionVariants(trackId: string): Array<{ quality: string; codec: string }> {
  const variants: Array<{ quality: string; codec: string }> = [];
  for (const [key, session] of activeSessions) {
    if (session.trackId !== trackId) continue;
    const parts = getSessionKeyParts(key);
    if (!parts) continue;
    variants.push({ quality: parts.quality, codec: parts.codec });
  }
  return variants;
}

/**
 * Clean up a specific session — kill FFmpeg, remove temp files.
 */
export function cleanupSession(trackId: string, quality: string, codec?: string): void {
  let key: string;
  if (codec) {
    key = sessionKey(trackId, quality, codec);
  } else {
    // Find the first matching session
    for (const [k, session] of activeSessions) {
      if (session.trackId === trackId && session.quality === quality) {
        key = k;
        break;
      }
    }
    if (!key!) return;
  }
  const session = activeSessions.get(key!);
  if (!session) return;
  logHlsSession(session.trackId, session.quality, session.codec, 'Cleaning up session');

  // Kill FFmpeg if still running
  if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
    session.ffmpegProcess.kill('SIGKILL');
  }

  // Remove temp files
  try {
    fs.rmSync(session.outputDir, { recursive: true, force: true });
  } catch (e) {
    // Ignore cleanup errors
  }

  activeSessions.delete(key);
}

/**
 * Clean up ALL sessions — called during server shutdown.
 */
export function cleanupAllSessions(): void {
  for (const [key, session] of activeSessions) {
    if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
      session.ffmpegProcess.kill('SIGKILL');
    }
    try {
      fs.rmSync(session.outputDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  }
  activeSessions.clear();

  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  // Try to remove the base dir itself
  try {
    fs.rmSync(HLS_BASE_DIR, { recursive: true, force: true });
  } catch (e) {
    // Ignore
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────

// Formats that are definitively NOT valid in MPEG-TS containers (HLS spec)
const NOT_TS_COMPATIBLE = new Set([
  'flac', 'ogg', 'vorbis', 'opus', 'wav', 'wave', 'wma',
]);

/**
 * Use ffprobe to detect the actual audio codec of a file.
 * Returns codec name (e.g., 'aac', 'alac', 'mp3', 'flac') or null on failure.
 */
function detectActualCodec(filePath: string): string | null {
  try {
    const output = execFileSync('ffprobe', [
      '-v', 'quiet',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      filePath,
    ], { timeout: 5000 }).toString().trim();
    return output || null;
  } catch {
    return null;
  }
}

/**
 * Decide whether to remux (copy codec) or transcode.
 * Considers: user quality preference, source format, and target codec.
 */
function getRemuxDecision(
  quality: string,
  sourceBitrate: number | null,
  sourceFormat: string | null,
  targetCodec: string,
  inputPath: string
): boolean {
  const fmt = (sourceFormat || '').toLowerCase();
  const actualCodec = detectActualCodec(inputPath)?.toLowerCase() || null;

  // Known incompatible formats — always transcode regardless of quality
  if (NOT_TS_COMPATIBLE.has(fmt) || (actualCodec && NOT_TS_COMPATIBLE.has(actualCodec))) return false;

  // MPEG-4 container: could be AAC or ALAC — must detect actual codec
  if (fmt === 'mpeg-4' || fmt === 'm4a' || fmt === 'mp4') {
    if (actualCodec === 'alac') return false; // ALAC can't go in MPEG-TS
    // For AAC in M4A, fall through to the normal bitrate check below
  }

  const codecMap: Record<string, string[]> = {
    mp3: ['mp3', 'mpeg'],
    aac: ['aac', 'm4a', 'mp4', 'mpeg-4', 'mp4/m4a'],
    ac3: ['ac3'],
    eac3: ['eac3'],
  };
  const matchingFormats = codecMap[targetCodec] || [];
  const matchesTargetCodec = matchingFormats.includes(fmt) || (!!actualCodec && matchingFormats.includes(actualCodec));

  // Quality = 'source': only remux if the stream already matches the advertised codec.
  // Otherwise the master playlist CODECS tag lies (e.g. AAC advertised but MP3 copied),
  // and some HLS clients fail even though FFmpeg can mux the segment.
  if (quality === 'source') {
    return matchesTargetCodec;
  }

  if (!sourceBitrate) return false;

  const requestedBitrateNum = parseInt(quality) * 1000;
  if (isNaN(requestedBitrateNum)) return false;

  // Remux if: source codec matches target AND bitrate is sufficient
  // This means the source is already in the right format — no transcoding needed
  if (matchesTargetCodec && requestedBitrateNum >= sourceBitrate) {
    return true;
  }

  return false; // transcode
}

function resolveTranscodeBitrate(quality: string, sourceBitrate: number | null, codec: string): string {
  if (quality !== 'source') return quality;

  const sourceKbps = sourceBitrate && Number.isFinite(sourceBitrate)
    ? Math.max(1, Math.round(sourceBitrate / 1000))
    : 320;

  // "source" cannot be literal when the source codec/container is not HLS/TS-compatible
  // or does not match the advertised target codec. Use a real bitrate that preserves
  // lossy-source intent without creating huge AAC streams for lossless inputs.
  const maxKbps = codec === 'aac' || codec === 'aac_he' ? 320 : sourceKbps;
  const minKbps = codec === 'ac3' || codec === 'eac3' ? 256 : 64;
  return `${Math.max(minKbps, Math.min(sourceKbps, maxKbps))}k`;
}

function buildFfmpegArgs(
  inputPath: string,
  playlistPath: string,
  segmentPattern: string,
  quality: string,
  shouldRemux: boolean,
  codec: string,
  sourceBitrate: number | null
): string[] {
  const args = [
    '-i', inputPath,
    '-vn',                          // Strip any video/cover art streams
    '-map', '0:a:0',               // Take first audio stream only
  ];

  if (shouldRemux) {
    args.push('-c:a', 'copy');      // Zero CPU — container change only
  } else {
    const bitrate = resolveTranscodeBitrate(quality, sourceBitrate, codec);
    switch (codec) {
      case 'mp3':
        args.push('-c:a', 'libmp3lame', '-b:a', bitrate);
        break;
      case 'ac3':
        args.push('-c:a', 'ac3', '-b:a', bitrate);
        break;
      case 'eac3':
        args.push('-c:a', 'eac3', '-b:a', bitrate);
        break;
      default: // 'aac', 'aac_he', any unknown → AAC (universal)
        args.push('-c:a', 'aac', '-b:a', bitrate, '-profile:a', 'aac_low');
        break;
    }
  }

  args.push(
    '-hls_time', String(HLS_SEGMENT_DURATION),
    '-hls_list_size', '0',          // Event playlist — keep all segments available.
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', segmentPattern,
    '-hls_flags', 'independent_segments',
    '-f', 'hls',
    playlistPath,
  );

  return args;
}

function startCleanupTimer(): void {
  if (cleanupTimer) return;

  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of activeSessions) {
      if (now - session.lastAccessedAt > SESSION_TTL_MS) {
        logHls(`[HLS] Reaping expired session: ${key}`);
        logHlsSession(session.trackId, session.quality, session.codec, 'Reaping expired session due to TTL');
        cleanupSession(session.trackId, session.quality);
      }
    }

    // If no sessions remain, stop the timer
    if (activeSessions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);
}
