import { codecName, describeOutput, describeSource, formatSampleRate } from './audioFormat';

const source = (overrides = {}) => ({
  codec: 'flac', container: 'FLAC', sampleRate: 44100, bitDepth: 16, channels: 2, bitrate: 900_000, lossless: true, ...overrides,
});
const output = (overrides = {}) => ({
  quality: '128k', mode: 'transcode' as const, codec: 'aac', bitrate: 128_000, sampleRate: 44100, ...overrides,
});

describe('formatSampleRate', () => {
  it('drops a trailing .0 and keeps real decimals', () => {
    expect(formatSampleRate(44100)).toBe('44.1 kHz');
    expect(formatSampleRate(48000)).toBe('48 kHz');
    expect(formatSampleRate(88200)).toBe('88.2 kHz');
    expect(formatSampleRate(22050)).toBe('22.05 kHz');
    expect(formatSampleRate(null)).toBeNull();
  });
});

describe('codecName', () => {
  it('names PCM by its container', () => {
    expect(codecName('pcm_s24le', 'WAVE')).toBe('WAV');
    expect(codecName('pcm_s16be', 'AIFF')).toBe('AIFF');
    expect(codecName('alac')).toBe('ALAC');
    expect(codecName(null, 'flac')).toBe('FLAC');
  });
});

describe('describeSource', () => {
  it('gives lossless files depth and rate', () => {
    expect(describeSource(source())).toEqual({ label: 'FLAC', sub: '16-bit/44.1 kHz' });
    expect(describeSource(source({ sampleRate: 96000, bitDepth: 24 }))).toEqual({ label: 'FLAC', sub: '24-bit/96 kHz' });
  });

  it('gives lossy files bitrate and rate', () => {
    expect(describeSource(source({ codec: 'mp3', container: 'MPEG', bitDepth: null, lossless: false, bitrate: 320_000 })))
      .toEqual({ label: 'MP3', sub: '320k @ 44.1 kHz' });
  });
});

describe('describeOutput', () => {
  it('says codec, bitrate and rate', () => {
    expect(describeOutput(output())).toEqual({ label: 'AAC 128k', sub: '@ 44.1 kHz' });
    expect(describeOutput(output({ sampleRate: 48000 }))).toEqual({ label: 'AAC 128k', sub: '@ 48 kHz' });
  });

  it('marks a copied stream as unchanged', () => {
    expect(describeOutput(output({ mode: 'copy', bitrate: 256_000 }))).toEqual({ label: 'AAC 256k', sub: '@ 44.1 kHz · unchanged' });
  });

  it('names the Auto rendition playing now', () => {
    expect(describeOutput(output({ quality: 'auto', bitrate: null }), 160)).toEqual({ label: 'Auto · AAC 160k', sub: '@ 44.1 kHz' });
    expect(describeOutput(output({ quality: 'auto', bitrate: null }))).toEqual({ label: 'Auto · AAC', sub: '@ 44.1 kHz' });
  });
});
