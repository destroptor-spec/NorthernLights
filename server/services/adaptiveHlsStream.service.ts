import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeHlsServerLog, writeHlsSessionLog, type HlsLogDetail } from './debugLogger.service';
import { logFfmpeg, logHls } from './loggingConfig';

export const ADAPTIVE_RENDITION_KBPS = [64, 128, 160, 320] as const;
export type AdaptiveRenditionKbps = typeof ADAPTIVE_RENDITION_KBPS[number];
export type AdaptiveRenditionName = `${AdaptiveRenditionKbps}k`;

export interface AdaptiveRendition {
  name: AdaptiveRenditionName;
  bitrateKbps: AdaptiveRenditionKbps;
}

export interface AdaptiveRenditionInfo extends AdaptiveRendition {
  playlistPath: string;
  segmentCount: number;
}

interface AdaptiveHlsSession {
  trackId: string;
  codec: string;
  ladder: AdaptiveRendition[];
  ladderKey: string;
  outputDir: string;
  ffmpegProcess: ChildProcess | null;
  createdAt: number;
  lastAccessedAt: number;
  ready: boolean;
  readyPromise: Promise<void>;
  finished: boolean;
  failure: string | null;
  renditions: Map<AdaptiveRenditionName, AdaptiveRenditionInfo>;
}

export interface AdaptiveHlsSessionInfo {
  trackId: string;
  codec: string;
  ladder: AdaptiveRendition[];
  ladderKey: string;
  outputDir: string;
  finished: boolean;
  renditions: AdaptiveRenditionInfo[];
}

const HLS_BASE_DIR = path.join(os.tmpdir(), 'nl-adaptive-hls-streams');
const SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const HLS_SEGMENT_DURATION = 10;
const READY_TIMEOUT_MS = 30_000;
const SEGMENT_NAME = /^segment\d+\.ts$/;
const SEGMENT_LINE = /^(segment\d+\.ts)$/gm;

const LOSSY_SOURCE_FORMATS = new Set([
  'aac', 'aac_he', 'ac3', 'asf', 'eac3', 'm4a', 'mp3', 'mp4', 'mp4/m4a',
  'mpeg', 'mpeg-4', 'ogg', 'opus', 'vorbis', 'wma',
]);

const activeSessions = new Map<string, AdaptiveHlsSession>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function normalizeSourceFormat(sourceFormat: string | null): string {
  return (sourceFormat || '').trim().toLowerCase();
}

function hasKnownLossySource(sourceFormat: string | null, sourceLossless: boolean | null): boolean {
  if (sourceLossless === true) return false;
  if (sourceLossless === false) return true;
  return LOSSY_SOURCE_FORMATS.has(normalizeSourceFormat(sourceFormat));
}

export function buildAdaptiveLadder(
  sourceBitrate: number | null,
  sourceFormat: string | null,
  sourceLossless: boolean | null = null,
  maxBitrateKbps: number | null = null,
): AdaptiveRendition[] {
  const requestedCap = maxBitrateKbps && Number.isFinite(maxBitrateKbps)
    ? Math.max(64, Math.min(320, Math.floor(maxBitrateKbps)))
    : 320;
  const sourceCap = hasKnownLossySource(sourceFormat, sourceLossless)
    && sourceBitrate
    && Number.isFinite(sourceBitrate)
    && sourceBitrate > 0
    ? Math.max(64, Math.floor(sourceBitrate / 1000))
    : 320;
  const cap = Math.min(requestedCap, sourceCap);
  const renditions = ADAPTIVE_RENDITION_KBPS
    .filter((bitrateKbps) => bitrateKbps <= cap)
    .map((bitrateKbps) => ({
      name: `${bitrateKbps}k` as AdaptiveRenditionName,
      bitrateKbps,
    }));

  return renditions.length > 0
    ? renditions
    : [{ name: '64k', bitrateKbps: 64 }];
}

export function serializeAdaptiveLadder(ladder: AdaptiveRendition[]): string {
  return ladder.map((rendition) => rendition.name).join(',');
}

export function parseAdaptiveLadder(value: string): AdaptiveRendition[] | null {
  if (!value) return null;
  const names = value.split(',');
  const seen = new Set<string>();
  const ladder: AdaptiveRendition[] = [];
  for (const name of names) {
    if (seen.has(name)) return null;
    const bitrateKbps = Number.parseInt(name, 10) as AdaptiveRenditionKbps;
    if (!ADAPTIVE_RENDITION_KBPS.includes(bitrateKbps) || name !== `${bitrateKbps}k`) return null;
    seen.add(name);
    ladder.push({ name: name as AdaptiveRenditionName, bitrateKbps });
  }
  const canonical = ladder.every((rendition, index) => rendition.bitrateKbps === [...ladder]
    .sort((left, right) => left.bitrateKbps - right.bitrateKbps)[index]?.bitrateKbps);
  return canonical ? ladder : null;
}

export function parseAdaptiveMaxBitrate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const bitrate = Number.parseInt(value, 10);
  if (!ADAPTIVE_RENDITION_KBPS.includes(bitrate as AdaptiveRenditionKbps) || value !== `${bitrate}k`) return null;
  return bitrate;
}

export function buildAdaptiveMasterPlaylist(
  ladder: AdaptiveRendition[],
  codec: string,
  token?: string,
): string {
  const ladderKey = serializeAdaptiveLadder(ladder);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const rendition of ladder) {
    const averageBandwidth = rendition.bitrateKbps * 1000;
    const peakBandwidth = Math.round(averageBandwidth * 1.15);
    const params = new URLSearchParams({
      quality: 'auto',
      codec,
      adaptive: '1',
      rendition: rendition.name,
      ladder: ladderKey,
    });
    if (token) params.set('token', token);
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${peakBandwidth},AVERAGE-BANDWIDTH=${averageBandwidth},CODECS="mp4a.40.2"`,
      `media.m3u8?${params.toString()}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function rewriteAdaptiveMediaPlaylistSegments(
  playlist: string,
  ladder: AdaptiveRendition[],
  rendition: AdaptiveRenditionName,
  codec: string,
  token?: string,
): string {
  const params = new URLSearchParams({
    quality: 'auto',
    codec,
    adaptive: '1',
    rendition,
    ladder: serializeAdaptiveLadder(ladder),
  });
  if (token) params.set('token', token);
  return playlist.replace(SEGMENT_LINE, `$1?${params.toString()}`);
}

export function buildAdaptiveFfmpegArgs(
  inputPath: string,
  ladder: AdaptiveRendition[],
  codec: string = 'aac',
): string[] {
  if (codec !== 'aac') {
    throw new Error(`Adaptive HLS only supports AAC, received ${codec}`);
  }
  if (ladder.length === 0) {
    throw new Error('Adaptive HLS requires at least one rendition');
  }

  const labels = ladder.map((_, index) => `[a${index}]`).join('');
  const args = [
    '-i', inputPath,
    '-vn',
    '-filter_complex', `[0:a:0]asplit=${ladder.length}${labels}`,
  ];

  ladder.forEach((rendition, index) => {
    args.push(
      '-map', `[a${index}]`,
      `-c:a:${index}`, 'aac',
      `-b:a:${index}`, rendition.name,
      `-profile:a:${index}`, 'aac_low',
    );
  });

  args.push(
    '-hls_time', String(HLS_SEGMENT_DURATION),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', '%v/segment%03d.ts',
    '-hls_flags', 'independent_segments',
    '-var_stream_map', ladder.map((rendition, index) => `a:${index},name:${rendition.name}`).join(' '),
    '-f', 'hls',
    '%v/playlist.m3u8',
  );

  return args;
}

function sessionKey(trackId: string, ladder: AdaptiveRendition[], codec: string): string {
  return `${trackId}::${serializeAdaptiveLadder(ladder)}::${codec}`;
}

function countPlaylistSegments(content: string): number {
  return (content.match(/^segment\d+\.ts$/gm) || []).length;
}

function logAdaptiveSession(session: Pick<AdaptiveHlsSession, 'trackId' | 'ladderKey' | 'codec'>, line: string, detail: HlsLogDetail = 'normal'): void {
  writeHlsServerLog(`[adaptive-session ${session.trackId} ${session.ladderKey} ${session.codec}] ${line}`, detail);
  writeHlsSessionLog(session.trackId, `auto-${session.ladderKey}`, session.codec, line, detail);
}

function readRenditionState(session: AdaptiveHlsSession): { ready: boolean; totalSegments: number } {
  let ready = true;
  let totalSegments = 0;
  for (const rendition of session.renditions.values()) {
    if (!fs.existsSync(rendition.playlistPath)) {
      ready = false;
      rendition.segmentCount = 0;
      continue;
    }
    const content = fs.readFileSync(rendition.playlistPath, 'utf8');
    rendition.segmentCount = countPlaylistSegments(content);
    totalSegments += rendition.segmentCount;
    if (rendition.segmentCount < 2 && !(rendition.segmentCount >= 1 && content.includes('#EXT-X-ENDLIST'))) {
      ready = false;
    }
  }
  return { ready, totalSegments };
}

function snapshotSession(session: AdaptiveHlsSession): AdaptiveHlsSessionInfo {
  return {
    trackId: session.trackId,
    codec: session.codec,
    ladder: session.ladder.map((rendition) => ({ ...rendition })),
    ladderKey: session.ladderKey,
    outputDir: session.outputDir,
    finished: session.finished,
    renditions: Array.from(session.renditions.values(), (rendition) => ({ ...rendition })),
  };
}

export async function getOrCreateAdaptiveHlsSession(
  trackId: string,
  trackPath: Buffer,
  ladder: AdaptiveRendition[],
  codec: string = 'aac',
): Promise<AdaptiveHlsSessionInfo> {
  const key = sessionKey(trackId, ladder, codec);
  const existing = activeSessions.get(key);
  if (existing) {
    const renditionState = readRenditionState(existing);
    if (existing.failure || (existing.finished && !renditionState.ready)) {
      logAdaptiveSession(existing, 'Discarding failed adaptive session before retry');
      cleanupAdaptiveHlsSession(trackId, ladder, codec);
    } else {
      existing.lastAccessedAt = Date.now();
      if (!existing.ready) await existing.readyPromise;
      if (existing.failure) throw new Error(existing.failure);
      return snapshotSession(existing);
    }
  }

  const ladderKey = serializeAdaptiveLadder(ladder);
  const keyHash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const outputDir = path.join(HLS_BASE_DIR, keyHash);
  fs.mkdirSync(outputDir, { recursive: true });
  const renditions = new Map<AdaptiveRenditionName, AdaptiveRenditionInfo>();
  for (const rendition of ladder) {
    const renditionDir = path.join(outputDir, rendition.name);
    fs.mkdirSync(renditionDir, { recursive: true });
    renditions.set(rendition.name, {
      ...rendition,
      playlistPath: path.join(renditionDir, 'playlist.m3u8'),
      segmentCount: 0,
    });
  }

  let resolveReady: () => void = () => undefined;
  const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
  const session: AdaptiveHlsSession = {
    trackId,
    codec,
    ladder: ladder.map((rendition) => ({ ...rendition })),
    ladderKey,
    outputDir,
    ffmpegProcess: null,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    ready: false,
    readyPromise,
    finished: false,
    failure: null,
    renditions,
  };
  activeSessions.set(key, session);

  const inputPath = trackPath.toString('utf8');
  const ffmpegArgs = buildAdaptiveFfmpegArgs(inputPath, ladder, codec);
  logAdaptiveSession(session, `Creating one-process adaptive package in ${outputDir}`);
  logAdaptiveSession(session, `FFmpeg args: ${ffmpegArgs.join(' ')}`, 'detailed');
  logHls(`[HLS] Spawning adaptive FFmpeg for ${trackId}: ${ladderKey}`);

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'], cwd: outputDir });
  session.ffmpegProcess = ffmpeg;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let settled = false;

  const settle = (failure?: string) => {
    if (settled) return;
    settled = true;
    if (pollInterval) clearInterval(pollInterval);
    if (failure) session.failure = failure;
    session.ready = true;
    resolveReady();
  };

  ffmpeg.stderr?.on('data', (data: Buffer) => {
    const message = data.toString();
    logFfmpeg(`[HLS] Adaptive FFmpeg stderr: ${message.substring(0, 200)}`);
    logAdaptiveSession(session, `FFmpeg stderr: ${message.trim()}`, /error|invalid|failed|warning|corrupt|cannot|could not|no such file|non.monoton/i.test(message) ? 'normal' : 'ffmpeg');
  });

  ffmpeg.on('error', (error) => {
    session.ffmpegProcess = null;
    session.finished = true;
    logAdaptiveSession(session, `FFmpeg spawn error: ${error.message}`);
    settle(`Adaptive HLS FFmpeg spawn failed: ${error.message}`);
  });

  ffmpeg.on('exit', (code, signal) => {
    session.ffmpegProcess = null;
    session.finished = true;
    const state = readRenditionState(session);
    logAdaptiveSession(session, `FFmpeg exited code=${code} signal=${signal}; segments=${state.totalSegments}`);
    if (code !== 0 || signal) {
      const failure = `Adaptive HLS FFmpeg exited before completing the package (code=${code}, signal=${signal})`;
      session.failure = failure;
      settle(failure);
      return;
    }
    if (state.ready) settle();
    else settle('Adaptive HLS FFmpeg finished without playable aligned renditions');
  });

  const pollStartedAt = Date.now();
  pollInterval = setInterval(() => {
    try {
      const state = readRenditionState(session);
      if (state.ready) {
        logAdaptiveSession(session, `Ready with ${state.totalSegments} total segments across ${ladder.length} renditions`);
        settle();
        return;
      }
    } catch {
      // FFmpeg may be replacing a playlist while it is read. Poll again.
    }

    if (Date.now() - pollStartedAt > READY_TIMEOUT_MS) {
      if (session.ffmpegProcess && !session.ffmpegProcess.killed) session.ffmpegProcess.kill('SIGKILL');
      session.finished = true;
      settle('Timed out waiting for all adaptive HLS renditions');
    }
  }, 50);

  startCleanupTimer();
  await readyPromise;
  if (session.failure) throw new Error(session.failure);
  return snapshotSession(session);
}

export function getAdaptiveHlsSessionInfo(
  trackId: string,
  ladder: AdaptiveRendition[],
  codec: string = 'aac',
): AdaptiveHlsSessionInfo | null {
  const session = activeSessions.get(sessionKey(trackId, ladder, codec));
  if (!session || session.failure) return null;
  readRenditionState(session);
  return snapshotSession(session);
}

export function getAdaptiveSegmentPath(
  trackId: string,
  ladder: AdaptiveRendition[],
  codec: string,
  renditionName: string,
  segmentName: string,
): string | null {
  if (!SEGMENT_NAME.test(segmentName)) return null;
  const session = activeSessions.get(sessionKey(trackId, ladder, codec));
  if (!session || session.failure) return null;
  const rendition = session.renditions.get(renditionName as AdaptiveRenditionName);
  if (!rendition) return null;
  const renditionDir = path.dirname(rendition.playlistPath);
  const segmentPath = path.resolve(renditionDir, segmentName);
  if (path.dirname(segmentPath) !== path.resolve(renditionDir)) return null;
  return segmentPath;
}

export function touchAdaptiveHlsSession(trackId: string, ladder: AdaptiveRendition[], codec: string): void {
  const session = activeSessions.get(sessionKey(trackId, ladder, codec));
  if (session) session.lastAccessedAt = Date.now();
}

export function cleanupAdaptiveHlsSession(trackId: string, ladder: AdaptiveRendition[], codec: string = 'aac'): void {
  const key = sessionKey(trackId, ladder, codec);
  const session = activeSessions.get(key);
  if (!session) return;
  if (session.ffmpegProcess && !session.ffmpegProcess.killed) session.ffmpegProcess.kill('SIGKILL');
  try {
    fs.rmSync(session.outputDir, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort.
  }
  activeSessions.delete(key);
}

export function cleanupAllAdaptiveHlsSessions(): void {
  for (const session of activeSessions.values()) {
    if (session.ffmpegProcess && !session.ffmpegProcess.killed) session.ffmpegProcess.kill('SIGKILL');
    try {
      fs.rmSync(session.outputDir, { recursive: true, force: true });
    } catch {
      // Cleanup is best effort.
    }
  }
  activeSessions.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  try {
    fs.rmSync(HLS_BASE_DIR, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort.
  }
}

export function getActiveAdaptiveSessionCount(): number {
  return activeSessions.size;
}

export function reapExpiredAdaptiveHlsSessions(now: number = Date.now()): number {
  let reaped = 0;
  for (const session of Array.from(activeSessions.values())) {
    if (now - session.lastAccessedAt <= SESSION_TTL_MS) continue;
    logHls(`[HLS] Reaping expired adaptive session: ${session.trackId} ${session.ladderKey}`);
    cleanupAdaptiveHlsSession(session.trackId, session.ladder, session.codec);
    reaped += 1;
  }
  return reaped;
}

function startCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    reapExpiredAdaptiveHlsSessions();
    if (activeSessions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}
