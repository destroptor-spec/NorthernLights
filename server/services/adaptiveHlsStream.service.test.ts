import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('./debugLogger.service', () => ({
  writeHlsServerLog: jest.fn(),
  writeHlsSessionLog: jest.fn(),
}));
jest.mock('./loggingConfig', () => ({
  logFfmpeg: jest.fn(),
  logHls: jest.fn(),
}));

import {
  buildAdaptiveFfmpegArgs,
  buildAdaptiveLadder,
  buildAdaptiveMasterPlaylist,
  cleanupAllAdaptiveHlsSessions,
  getActiveAdaptiveSessionCount,
  getAdaptiveSegmentPath,
  getOrCreateAdaptiveHlsSession,
  reapExpiredAdaptiveHlsSessions,
  rewriteAdaptiveMediaPlaylistSegments,
  serializeAdaptiveLadder,
} from './adaptiveHlsStream.service';

class FakeFfmpegProcess extends EventEmitter {
  public stderr = new EventEmitter();
  public killed = false;

  public kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, signal || 'SIGKILL'));
    return true;
  }
}

const spawnMock = spawn as jest.MockedFunction<typeof spawn>;

function successfulFfmpeg(
  _command: string,
  args: readonly string[],
  options: { cwd?: string | URL },
) {
  const process = new FakeFfmpegProcess();
  const cwd = String(options.cwd);
  const mapIndex = args.indexOf('-var_stream_map');
  const names = String(args[mapIndex + 1] || '')
    .split(' ')
    .map((entry) => entry.match(/name:([^,\s]+)/)?.[1])
    .filter((name): name is string => Boolean(name));

  for (const name of names) {
    const renditionDir = path.join(cwd, name);
    fs.mkdirSync(renditionDir, { recursive: true });
    fs.writeFileSync(path.join(renditionDir, 'segment000.ts'), 'segment-zero');
    fs.writeFileSync(path.join(renditionDir, 'segment001.ts'), 'segment-one');
    fs.writeFileSync(path.join(renditionDir, 'playlist.m3u8'), [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXTINF:10.0,',
      'segment000.ts',
      '#EXTINF:10.0,',
      'segment001.ts',
      '',
    ].join('\n'));
  }
  setTimeout(() => process.emit('exit', 0, null), 5);
  return process as unknown as ReturnType<typeof spawn>;
}

function failedFfmpeg() {
  const process = new FakeFfmpegProcess();
  setTimeout(() => process.emit('exit', 1, null), 5);
  return process as unknown as ReturnType<typeof spawn>;
}

describe('adaptive HLS packaging', () => {
  beforeEach(() => {
    cleanupAllAdaptiveHlsSessions();
    spawnMock.mockReset();
  });

  afterAll(() => {
    cleanupAllAdaptiveHlsSessions();
  });

  it('builds a source-aware ladder and lets lossless or unknown sources reach 320 kbps', () => {
    expect(buildAdaptiveLadder(160_000, 'mp3').map((item) => item.name)).toEqual(['64k', '128k', '160k']);
    expect(buildAdaptiveLadder(96_000, 'aac').map((item) => item.name)).toEqual(['64k']);
    expect(buildAdaptiveLadder(700_000, 'flac', true).map((item) => item.name)).toEqual(['64k', '128k', '160k', '320k']);
    expect(buildAdaptiveLadder(null, null).map((item) => item.name)).toEqual(['64k', '128k', '160k', '320k']);
    expect(buildAdaptiveLadder(700_000, 'flac', true, 64).map((item) => item.name)).toEqual(['64k']);
  });

  it('declares each bandwidth and propagates auth through every adaptive URI', () => {
    const ladder = buildAdaptiveLadder(null, null);
    const master = buildAdaptiveMasterPlaylist(ladder, 'aac', 'media-token');
    expect(master).toContain('BANDWIDTH=73600,AVERAGE-BANDWIDTH=64000,CODECS="mp4a.40.2"');
    expect(master).toContain('BANDWIDTH=368000,AVERAGE-BANDWIDTH=320000,CODECS="mp4a.40.2"');
    expect(master.match(/token=media-token/g)).toHaveLength(4);
    expect(master.match(/adaptive=1/g)).toHaveLength(4);

    const variant = rewriteAdaptiveMediaPlaylistSegments(
      '#EXTM3U\n#EXTINF:10,\nsegment000.ts\n',
      ladder,
      '64k',
      'aac',
      'media-token',
    );
    expect(variant).toContain('segment000.ts?quality=auto&codec=aac&adaptive=1&rendition=64k');
    expect(variant).toContain('token=media-token');
  });

  it('generates one-input asplit and var_stream_map arguments for aligned renditions', () => {
    const ladder = buildAdaptiveLadder(160_000, 'mp3');
    const args = buildAdaptiveFfmpegArgs('/music/track.mp3', ladder);
    expect(args.filter((arg) => arg === '-i')).toHaveLength(1);
    expect(args).toContain('[0:a:0]asplit=3[a0][a1][a2]');
    expect(args).toContain('a:0,name:64k a:1,name:128k a:2,name:160k');
    expect(args).toContain('%v/segment%03d.ts');
    expect(args.at(-1)).toBe('%v/playlist.m3u8');
  });

  it('resamples once, before the split, when asked', () => {
    const ladder = buildAdaptiveLadder(2_450_000, 'flac', true);
    expect(buildAdaptiveFfmpegArgs('/music/track.flac', ladder, 'aac', 48000)).toContain(`[0:a:0]aresample=48000,asplit=${ladder.length}${ladder.map((_, i) => `[a${i}]`).join('')}`);
  });

  it('deduplicates sessions and resolves only exact rendition-owned segments', async () => {
    spawnMock.mockImplementation(successfulFfmpeg as typeof spawn);
    const ladder = buildAdaptiveLadder(160_000, 'mp3');
    const first = await getOrCreateAdaptiveHlsSession('track-dedup', Buffer.from('/music/track.mp3'), ladder);
    const second = await getOrCreateAdaptiveHlsSession('track-dedup', Buffer.from('/music/track.mp3'), ladder);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(first.renditions.every((rendition) => rendition.segmentCount === 2)).toBe(true);
    expect(second.ladderKey).toBe(serializeAdaptiveLadder(ladder));
    const exact = getAdaptiveSegmentPath('track-dedup', ladder, 'aac', '128k', 'segment000.ts');
    expect(exact).toBeTruthy();
    expect(fs.existsSync(exact!)).toBe(true);
    expect(getAdaptiveSegmentPath('track-dedup', ladder, 'aac', '320k', 'segment000.ts')).toBeNull();
    expect(getAdaptiveSegmentPath('track-dedup', ladder, 'aac', '128k', '../segment000.ts')).toBeNull();
    expect(getActiveAdaptiveSessionCount()).toBe(1);
    expect(reapExpiredAdaptiveHlsSessions(Date.now() + 31 * 60 * 1000)).toBe(1);
    expect(getActiveAdaptiveSessionCount()).toBe(0);
    expect(fs.existsSync(first.outputDir)).toBe(false);
  });

  it('discards a failed process and creates a fresh session on retry', async () => {
    spawnMock
      .mockImplementationOnce(failedFfmpeg as typeof spawn)
      .mockImplementation(successfulFfmpeg as typeof spawn);
    const ladder = buildAdaptiveLadder(128_000, 'aac');

    await expect(getOrCreateAdaptiveHlsSession('track-retry', Buffer.from('/music/retry.aac'), ladder))
      .rejects.toThrow('exited before completing the package');
    const recovered = await getOrCreateAdaptiveHlsSession('track-retry', Buffer.from('/music/retry.aac'), ladder);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(recovered.renditions).toHaveLength(2);
    expect(recovered.renditions.every((rendition) => rendition.segmentCount === 2)).toBe(true);
  });
});
