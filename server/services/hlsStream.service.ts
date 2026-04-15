import { spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Types ──────────────────────────────────────────────────────────────

interface HlsSession {
  trackId: string;
  quality: string;
  outputDir: string;
  playlistPath: string;
  ffmpegProcess: ChildProcess | null;
  createdAt: number;
  lastAccessedAt: number;
  ready: boolean;               // true once FFmpeg has written at least segment 0
  readyPromise: Promise<void>;  // resolves when the first segment appears
}

// ─── Constants ──────────────────────────────────────────────────────────

const HLS_BASE_DIR = path.join(os.tmpdir(), 'nl-hls-streams');
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes of inactivity
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const HLS_SEGMENT_DURATION = 10; // seconds per chunk

// ─── Session Store ──────────────────────────────────────────────────────

const activeSessions = new Map<string, HlsSession>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function sessionKey(trackId: string, quality: string): string {
  return `${trackId}::${quality}`;
}

// ─── Core API ───────────────────────────────────────────────────────────

/**
 * Get or create an HLS session for a given track + quality combination.
 * Returns once the playlist is ready to be served (first segment written).
 */
export async function getOrCreateHlsSession(
  trackId: string,
  trackPath: Buffer,
  quality: string,
  sourceBitrate: number | null
): Promise<HlsSession> {
  const key = sessionKey(trackId, quality);

  // Reuse existing session if available
  const existing = activeSessions.get(key);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    if (!existing.ready) {
      await existing.readyPromise;
    }
    return existing;
  }

  // Create output directory — hash the trackId to guarantee a short, fixed-length name
  // (base64 trackIds from non-DB tracks can exceed filesystem name limits)
  const dirHash = crypto.createHash('sha256').update(`${trackId}::${quality}`).digest('hex').slice(0, 16);
  const outputDir = path.join(HLS_BASE_DIR, dirHash);
  fs.mkdirSync(outputDir, { recursive: true });

  const playlistPath = path.join(outputDir, 'playlist.m3u8');
  const segmentPattern = path.join(outputDir, 'segment%03d.ts');

  // Determine encoding strategy
  const shouldRemux = getRemuxDecision(quality, sourceBitrate);

  // Build FFmpeg args
  const inputPath = trackPath.toString('utf8');
  const ffmpegArgs = buildFfmpegArgs(inputPath, playlistPath, segmentPattern, quality, shouldRemux);

  // Create the readiness promise — resolves when segment000.ts appears
  let resolveReady: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const session: HlsSession = {
    trackId,
    quality,
    outputDir,
    playlistPath,
    ffmpegProcess: null,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    ready: false,
    readyPromise,
  };

  activeSessions.set(key, session);

  // Spawn FFmpeg
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  session.ffmpegProcess = ffmpeg;

  ffmpeg.stderr?.on('data', (data: Buffer) => {
    // FFmpeg writes ALL output to stderr (config banner, progress, AND errors).
    // Only log lines that look like actual errors, not config/progress noise.
    const msg = data.toString();
    if (/^\[?error|Error while|Invalid|No such file|could not|Cannot/mi.test(msg)) {
      console.error(`[HLS] FFmpeg error for ${trackId}:`, msg.trim());
    }
  });

  ffmpeg.on('exit', (code, signal) => {
    session.ffmpegProcess = null;
    if (code !== 0 && code !== null && signal !== 'SIGKILL') {
      console.error(`[HLS] FFmpeg exited with code ${code} for track ${trackId}`);
    }
  });

  ffmpeg.on('error', (err) => {
    console.error(`[HLS] FFmpeg spawn error for ${trackId}:`, err);
    session.ffmpegProcess = null;
    // Resolve the promise anyway so callers don't hang
    if (!session.ready) {
      session.ready = true;
      resolveReady!();
    }
  });

  // Wait for the COMPLETE playlist (#EXT-X-ENDLIST) before serving.
  // This ensures hls.js receives a full VOD playlist on the first request,
  // instead of a partial live-looking playlist that stalls after one segment.
  // For local files with remuxing (-c:a copy), FFmpeg finishes in < 1 second.
  const pollStart = Date.now();
  const POLL_TIMEOUT_MS = 30000; // 30s for long transcodes

  const pollInterval = setInterval(() => {
    try {
      if (fs.existsSync(playlistPath)) {
        const content = fs.readFileSync(playlistPath, 'utf-8');
        if (content.includes('#EXT-X-ENDLIST')) {
          clearInterval(pollInterval);
          session.ready = true;
          resolveReady!();
          return;
        }
      }
    } catch (_) { /* file may be partially written */ }

    if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
      clearInterval(pollInterval);
      console.error(`[HLS] Timeout waiting for complete playlist of track ${trackId}`);
      session.ready = true;
      resolveReady!();
    }
  }, 150);

  // Also resolve if FFmpeg exits (success or failure) before the poll finds ENDLIST
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
 * Touch a session to keep it alive.
 */
export function touchSession(trackId: string, quality: string): void {
  const session = activeSessions.get(sessionKey(trackId, quality));
  if (session) {
    session.lastAccessedAt = Date.now();
  }
}

/**
 * Get the output directory for a session (for serving segments).
 */
export function getSessionOutputDir(trackId: string, quality: string): string | null {
  const session = activeSessions.get(sessionKey(trackId, quality));
  return session?.outputDir ?? null;
}

/**
 * Find any active session for a trackId, regardless of quality.
 * Used by the segment route since hls.js doesn't forward query params.
 */
export function findSessionByTrackId(trackId: string): { outputDir: string; quality: string } | null {
  for (const [_key, session] of activeSessions) {
    if (session.trackId === trackId) {
      session.lastAccessedAt = Date.now();
      return { outputDir: session.outputDir, quality: session.quality };
    }
  }
  return null;
}

/**
 * Clean up a specific session — kill FFmpeg, remove temp files.
 */
export function cleanupSession(trackId: string, quality: string): void {
  const key = sessionKey(trackId, quality);
  const session = activeSessions.get(key);
  if (!session) return;

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

function getRemuxDecision(quality: string, sourceBitrate: number | null): boolean {
  if (quality === 'source') return true;

  // If we don't know the source bitrate, always transcode to be safe
  if (!sourceBitrate) return false;

  const requestedBitrateNum = parseInt(quality) * 1000;
  if (isNaN(requestedBitrateNum)) return false;

  return requestedBitrateNum >= sourceBitrate;
}

function buildFfmpegArgs(
  inputPath: string,
  playlistPath: string,
  segmentPattern: string,
  quality: string,
  shouldRemux: boolean
): string[] {
  const args = [
    '-i', inputPath,
    '-vn',                          // Strip any video/cover art streams
    '-map', '0:a:0',               // Take first audio stream only
  ];

  if (shouldRemux) {
    args.push('-c:a', 'copy');      // Zero CPU — container change only
  } else {
    args.push(
      '-c:a', 'aac',
      '-b:a', quality,              // e.g. '128k', '320k'
    );
  }

  args.push(
    '-hls_time', String(HLS_SEGMENT_DURATION),
    '-hls_list_size', '0',          // VOD mode — keep all segments in playlist
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
        console.log(`[HLS] Reaping expired session: ${key}`);
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
