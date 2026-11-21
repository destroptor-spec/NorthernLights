import { execFile, execFileSync } from 'child_process';
import fs from 'fs';

/**
 * What a track's file actually holds, read from its first audio stream by
 * ffprobe: the stream's codec, sample rate, bit depth and channels, which the
 * library rows don't record. Used to plan an HLS transcode and to show the
 * listener what comes in and what goes out.
 */
export interface SourceAudio {
  /** ffprobe codec name: 'flac', 'alac', 'aac', 'mp3', 'pcm_s24le' … */
  codec: string | null;
  sampleRate: number | null;
  /** Bits per sample for lossless sources; null for lossy codecs, where it means nothing. */
  bitDepth: number | null;
  channels: number | null;
  /** bits/s: the stream's own, else the file's average. */
  bitrate: number | null;
  lossless: boolean | null;
}

/**
 * The highest sample rate an HLS transcode carries. AAC at 96 kHz is legal
 * but gains nothing at 64–320 kbps (the encoder low-passes far below 24 kHz)
 * and doubles the decoder's frame rate: Beoplay Cast speakers stutter on it
 * (reproduced on two units, 2026-11-21) while 44.1/48 kHz plays cleanly.
 * MP3 and AC-3 stop at 48 kHz anyway.
 */
export const MAX_HLS_SAMPLE_RATE = 48000;

/**
 * The sample rate an HLS transcode writes for a source rate: the source's own
 * up to 48 kHz, else the 44.1 or 48 kHz of its family (88.2/176.4 kHz → 44.1,
 * 96/192 kHz → 48), so the resampling ratio stays a whole number.
 * Null when the source rate is unknown.
 */
export function hlsOutputSampleRate(sourceSampleRate: number | null | undefined): number | null {
  if (!sourceSampleRate || !Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) return null;
  if (sourceSampleRate <= MAX_HLS_SAMPLE_RATE) return sourceSampleRate;
  return sourceSampleRate % 44100 === 0 ? 44100 : 48000;
}

const LOSSLESS_CODECS = new Set(['flac', 'alac', 'wavpack', 'ape', 'tta', 'mlp', 'truehd', 'wmalossless', 'shorten']);

function isLosslessCodec(codec: string | null): boolean | null {
  if (!codec) return null;
  return LOSSLESS_CODECS.has(codec) || codec.startsWith('pcm_');
}

function positiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

const SAMPLE_FMT_BITS: Record<string, number> = { u8: 8, u8p: 8, s16: 16, s16p: 16, s32: 32, s32p: 32, flt: 32, fltp: 32, s64: 64, s64p: 64, dbl: 64, dblp: 64 };

/** Reads ffprobe's JSON (`-show_entries stream=…:format=bit_rate -of json`). */
export function parseSourceAudioProbe(json: string): SourceAudio | null {
  let parsed: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const stream = parsed.streams?.[0];
  if (!stream) return null;
  const codec = typeof stream.codec_name === 'string' && stream.codec_name ? stream.codec_name.toLowerCase() : null;
  const lossless = isLosslessCodec(codec);
  // FLAC and ALAC hold 24-bit audio in a 32-bit sample format and say the
  // real depth in bits_per_raw_sample; PCM says it in bits_per_sample.
  const bitDepth = lossless
    ? positiveInt(stream.bits_per_raw_sample)
      ?? positiveInt(stream.bits_per_sample)
      ?? (typeof stream.sample_fmt === 'string' ? SAMPLE_FMT_BITS[stream.sample_fmt] ?? null : null)
    : null;
  return {
    codec,
    sampleRate: positiveInt(stream.sample_rate),
    bitDepth,
    channels: positiveInt(stream.channels),
    bitrate: positiveInt(stream.bit_rate) ?? positiveInt(parsed.format?.bit_rate),
    lossless,
  };
}

const PROBE_ARGS = [
  '-v', 'quiet',
  '-select_streams', 'a:0',
  '-show_entries', 'stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample,sample_fmt,channels,bit_rate:format=bit_rate',
  '-of', 'json',
];
const PROBE_TIMEOUT_MS = 5000;

/** Probes a file synchronously; null when ffprobe fails. For starting a transcode. */
export function probeSourceAudioSync(filePath: string): SourceAudio | null {
  try {
    return parseSourceAudioProbe(execFileSync('ffprobe', [...PROBE_ARGS, filePath], { timeout: PROBE_TIMEOUT_MS }).toString());
  } catch {
    return null;
  }
}

const probeCache = new Map<string, SourceAudio | null>();
const PROBE_CACHE_LIMIT = 1000;

/**
 * Probes a file without blocking, remembered per path, size and modified time
 * so a tag edit or replaced file is probed again. Null when ffprobe fails.
 */
export async function probeSourceAudio(filePath: string): Promise<SourceAudio | null> {
  let key = filePath;
  try {
    const stat = await fs.promises.stat(filePath);
    key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return null;
  }
  if (probeCache.has(key)) return probeCache.get(key) ?? null;
  const result = await new Promise<SourceAudio | null>((resolve) => {
    execFile('ffprobe', [...PROBE_ARGS, filePath], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : parseSourceAudioProbe(String(stdout)));
    });
  });
  if (probeCache.size >= PROBE_CACHE_LIMIT) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) probeCache.delete(oldest);
  }
  probeCache.set(key, result);
  return result;
}
