import type { StreamFormat } from '../../shared/api/v1';

/** One step of the signal chain: "FLAC" + "24-bit/96 kHz", "AAC 128k" + "@ 48 kHz". */
export interface AudioFormatLabel {
  label: string;
  sub?: string;
}

/** 44100 → "44.1 kHz", 48000 → "48 kHz", 22050 → "22.05 kHz". */
export function formatSampleRate(hz: number | null | undefined): string | null {
  if (!hz || !Number.isFinite(hz) || hz <= 0) return null;
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz : Number(khz.toFixed(2))} kHz`;
}

const CODEC_NAMES: Record<string, string> = {
  flac: 'FLAC',
  alac: 'ALAC',
  aac: 'AAC',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  opus: 'Opus',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  wmav1: 'WMA',
  wmav2: 'WMA',
  wmapro: 'WMA Pro',
  wmalossless: 'WMA Lossless',
  wavpack: 'WavPack',
  ape: 'APE',
  tta: 'TTA',
};

/** The name a listener knows a codec by; PCM goes by its container (WAV, AIFF). */
export function codecName(codec: string | null | undefined, container?: string | null): string | null {
  const key = (codec || '').toLowerCase();
  if (key.startsWith('pcm_')) {
    const fmt = (container || '').toUpperCase();
    if (fmt.includes('AIFF')) return 'AIFF';
    if (fmt.includes('WAV')) return 'WAV';
    return 'PCM';
  }
  if (key && CODEC_NAMES[key]) return CODEC_NAMES[key];
  if (key) return key.toUpperCase();
  return container ? container.toUpperCase() : null;
}

const kbps = (bitsPerSecond: number | null | undefined) =>
  bitsPerSecond && bitsPerSecond > 0 ? `${Math.round(bitsPerSecond / 1000)}k` : null;

/**
 * The file as it is: lossless by depth and rate ("FLAC" · "24-bit/96 kHz"),
 * lossy by bitrate and rate ("MP3" · "320k @ 44.1 kHz").
 */
export function describeSource(source: StreamFormat['source']): AudioFormatLabel | null {
  const name = codecName(source.codec, source.container);
  if (!name) return null;
  const rate = formatSampleRate(source.sampleRate);
  let sub: string | null;
  if (source.lossless) {
    sub = source.bitDepth && rate ? `${source.bitDepth}-bit/${rate}` : rate ?? (source.bitDepth ? `${source.bitDepth}-bit` : null);
  } else {
    const bitrate = kbps(source.bitrate);
    sub = bitrate && rate ? `${bitrate} @ ${rate}` : bitrate ?? rate;
  }
  return sub ? { label: name, sub } : { label: name };
}

/**
 * What the stream carries: "AAC 128k" · "@ 48 kHz". Auto names the rendition
 * playing now when known; a copied stream says it is the file unchanged.
 */
export function describeOutput(
  output: StreamFormat['output'],
  activeBitrateKbps: number | null = null,
): AudioFormatLabel {
  const name = codecName(output.codec) ?? 'AAC';
  const bitrate = output.quality === 'auto'
    ? (activeBitrateKbps ? `${activeBitrateKbps}k` : null)
    : kbps(output.bitrate);
  const label = output.quality === 'auto'
    ? `Auto · ${name}${bitrate ? ` ${bitrate}` : ''}`
    : `${name}${bitrate ? ` ${bitrate}` : ''}`;
  const rate = formatSampleRate(output.sampleRate);
  const parts = [rate ? `@ ${rate}` : null, output.mode === 'copy' ? 'unchanged' : null].filter(Boolean);
  return parts.length ? { label, sub: parts.join(' · ') } : { label };
}
