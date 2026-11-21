import { hlsOutputSampleRate, parseSourceAudioProbe } from './sourceAudio.service';

describe('hlsOutputSampleRate', () => {
  it('keeps rates up to 48 kHz', () => {
    expect(hlsOutputSampleRate(22050)).toBe(22050);
    expect(hlsOutputSampleRate(44100)).toBe(44100);
    expect(hlsOutputSampleRate(48000)).toBe(48000);
  });

  it('brings higher rates down to the 44.1 or 48 kHz of their family', () => {
    expect(hlsOutputSampleRate(88200)).toBe(44100);
    expect(hlsOutputSampleRate(176400)).toBe(44100);
    expect(hlsOutputSampleRate(96000)).toBe(48000);
    expect(hlsOutputSampleRate(192000)).toBe(48000);
    expect(hlsOutputSampleRate(64000)).toBe(48000);
  });

  it('is null for an unknown rate', () => {
    expect(hlsOutputSampleRate(null)).toBeNull();
    expect(hlsOutputSampleRate(0)).toBeNull();
    expect(hlsOutputSampleRate(Number.NaN)).toBeNull();
  });
});

describe('parseSourceAudioProbe', () => {
  it('reads a 24-bit FLAC from bits_per_raw_sample, not its 32-bit sample format', () => {
    const probe = parseSourceAudioProbe(JSON.stringify({
      streams: [{ codec_name: 'flac', sample_rate: '96000', bits_per_raw_sample: '24', bits_per_sample: 0, sample_fmt: 's32', channels: 2 }],
      format: { bit_rate: '2450123' },
    }));
    expect(probe).toEqual({ codec: 'flac', sampleRate: 96000, bitDepth: 24, channels: 2, bitrate: 2450123, lossless: true });
  });

  it('reads PCM depth from bits_per_sample', () => {
    const probe = parseSourceAudioProbe(JSON.stringify({
      streams: [{ codec_name: 'pcm_s16le', sample_rate: '44100', bits_per_sample: 16, sample_fmt: 's16', channels: 2, bit_rate: '1411200' }],
    }));
    expect(probe?.bitDepth).toBe(16);
    expect(probe?.lossless).toBe(true);
    expect(probe?.bitrate).toBe(1411200);
  });

  it('gives lossy codecs no bit depth', () => {
    const probe = parseSourceAudioProbe(JSON.stringify({
      streams: [{ codec_name: 'mp3', sample_rate: '44100', sample_fmt: 'fltp', channels: 2, bit_rate: '320000' }],
    }));
    expect(probe).toEqual({ codec: 'mp3', sampleRate: 44100, bitDepth: null, channels: 2, bitrate: 320000, lossless: false });
  });

  it('is null for no audio stream or bad output', () => {
    expect(parseSourceAudioProbe(JSON.stringify({ streams: [] }))).toBeNull();
    expect(parseSourceAudioProbe('not json')).toBeNull();
  });
});
