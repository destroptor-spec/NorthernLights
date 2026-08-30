jest.mock('child_process', () => ({ spawn: jest.fn(), execFileSync: jest.fn() }));
jest.mock('./debugLogger.service', () => ({
  writeHlsServerLog: jest.fn(),
  writeHlsSessionLog: jest.fn(),
}));
jest.mock('./loggingConfig', () => ({
  logFfmpeg: jest.fn(),
  logHls: jest.fn(),
}));

import { completeVodPlaylist } from './hlsStream.service';

// The exact shape FFmpeg serves mid-transcode: EVENT type, no ENDLIST, and
// frame-aligned 10.0078s segments (44.1kHz AAC). Captured from prod on
// 2026-08-30, when the Cast receiver read it as a live stream and started
// playback ~10s in.
const PARTIAL_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:EVENT',
  '#EXTINF:10.007800,',
  'segment000.ts',
  '#EXTINF:10.007800,',
  'segment001.ts',
  '',
].join('\n');

describe('completeVodPlaylist', () => {
  it('turns a partial EVENT playlist into a terminated VOD playlist', () => {
    const output = completeVodPlaylist(PARTIAL_PLAYLIST, 159);
    expect(output).not.toBeNull();
    expect(output).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(output).toContain('#EXT-X-ENDLIST');
    expect(output).not.toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
  });

  it('lists every segment for the full track, not just the transcoded ones', () => {
    const output = completeVodPlaylist(PARTIAL_PLAYLIST, 159) as string;
    const segments = output.split('\n').filter((line) => /^segment\d+\.ts$/.test(line));
    // ceil(159 / 10.0078) === 16
    expect(segments).toHaveLength(16);
    expect(segments[0]).toBe('segment000.ts');
    expect(segments[15]).toBe('segment015.ts');
  });

  it('announces a total duration matching the real track length', () => {
    const output = completeVodPlaylist(PARTIAL_PLAYLIST, 159) as string;
    const total = output
      .split('\n')
      .filter((line) => line.startsWith('#EXTINF:'))
      .reduce((sum, line) => sum + parseFloat(line.slice('#EXTINF:'.length)), 0);
    expect(total).toBeCloseTo(159, 3);
  });

  it('keeps every EXTINF within EXT-X-TARGETDURATION', () => {
    const output = completeVodPlaylist(PARTIAL_PLAYLIST, 159) as string;
    const durations = output
      .split('\n')
      .filter((line) => line.startsWith('#EXTINF:'))
      .map((line) => parseFloat(line.slice('#EXTINF:'.length)));
    expect(Math.max(...durations)).toBeLessThanOrEqual(10.0078);
    expect(durations.every((value) => Math.round(value) <= 10)).toBe(true);
  });

  it('preserves the original header tags', () => {
    const output = completeVodPlaylist(PARTIAL_PLAYLIST, 159) as string;
    expect(output.startsWith('#EXTM3U')).toBe(true);
    expect(output).toContain('#EXT-X-VERSION:6');
    expect(output).toContain('#EXT-X-TARGETDURATION:10');
    expect(output).toContain('#EXT-X-MEDIA-SEQUENCE:0');
  });

  it('handles a track that divides evenly into segments', () => {
    const output = completeVodPlaylist(PARTIAL_PLAYLIST, 20.0156) as string;
    const segments = output.split('\n').filter((line) => /^segment\d+\.ts$/.test(line));
    expect(segments).toHaveLength(2);
  });

  it('declines when the duration is unknown or nonsensical', () => {
    expect(completeVodPlaylist(PARTIAL_PLAYLIST, null)).toBeNull();
    expect(completeVodPlaylist(PARTIAL_PLAYLIST, 0)).toBeNull();
    expect(completeVodPlaylist(PARTIAL_PLAYLIST, -5)).toBeNull();
    expect(completeVodPlaylist(PARTIAL_PLAYLIST, NaN)).toBeNull();
  });

  it('leaves an already-terminated playlist alone', () => {
    const finished = PARTIAL_PLAYLIST + '#EXT-X-ENDLIST\n';
    expect(completeVodPlaylist(finished, 159)).toBeNull();
  });

  it('declines when there is no EXTINF to derive the segment grid from', () => {
    const empty = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:10', ''].join('\n');
    expect(completeVodPlaylist(empty, 159)).toBeNull();
  });

  it('declines when the duration contradicts the segments already written', () => {
    // Three segments on disk but a duration claiming the track is only ~10s.
    const threeSegments = PARTIAL_PLAYLIST + '#EXTINF:10.007800,\nsegment002.ts\n';
    expect(completeVodPlaylist(threeSegments, 10)).toBeNull();
  });
});

/**
 * Ground truth captured by transcoding generated sources with the exact FFmpeg
 * arguments this service builds, then reading the finished playlist:
 *
 *   source           encoded      segments  first EXTINF
 *   159s   @44.1kHz  159.024101   16        10.007800
 *   212s   @48kHz    212.021328   22        10.005333
 *   200s   @44.1kHz  200.039912   21        10.007800
 *   20.02s @44.1kHz   20.043222    3        10.007800
 *   90.5s  @48kHz     90.521331   10        10.005333
 */
const FFMPEG_GROUND_TRUTH = [
  { sourceDuration: 159, grid: 10.007800, actualSegments: 16 },
  { sourceDuration: 212, grid: 10.005333, actualSegments: 22 },
  { sourceDuration: 200, grid: 10.007800, actualSegments: 21 },
  { sourceDuration: 20.02, grid: 10.007800, actualSegments: 3 },
  { sourceDuration: 90.5, grid: 10.005333, actualSegments: 10 },
];

describe('completeVodPlaylist segment-count safety', () => {
  const playlistOnGrid = (grid: number) => [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:EVENT',
    `#EXTINF:${grid.toFixed(6)},`,
    'segment000.ts',
    `#EXTINF:${grid.toFixed(6)},`,
    'segment001.ts',
    '',
  ].join('\n');

  const segmentCount = (playlist: string) =>
    playlist.split('\n').filter((line) => /^segment\d+\.ts$/.test(line)).length;

  // Over-counting is the dangerous direction: it sends the player after a
  // segment FFmpeg never writes, stalling the end of the track. Under-counting
  // only drops a sub-frame tail.
  it.each(FFMPEG_GROUND_TRUTH)(
    'never announces more segments than FFmpeg writes ($sourceDuration s)',
    ({ sourceDuration, grid, actualSegments }) => {
      const mine = segmentCount(completeVodPlaylist(playlistOnGrid(grid), sourceDuration) as string);
      expect(mine).toBeLessThanOrEqual(actualSegments);
    },
  );

  it.each(FFMPEG_GROUND_TRUTH)(
    'is off by at most one segment ($sourceDuration s)',
    ({ sourceDuration, grid, actualSegments }) => {
      const mine = segmentCount(completeVodPlaylist(playlistOnGrid(grid), sourceDuration) as string);
      expect(actualSegments - mine).toBeLessThanOrEqual(1);
    },
  );

  it('matches FFmpeg exactly unless the duration sits on a grid boundary', () => {
    const exact = FFMPEG_GROUND_TRUTH.filter(({ sourceDuration }) => sourceDuration % 10 !== 0);
    for (const { sourceDuration, grid, actualSegments } of exact) {
      const mine = segmentCount(completeVodPlaylist(playlistOnGrid(grid), sourceDuration) as string);
      expect(mine).toBe(actualSegments);
    }
  });

  it('under-counts by one when the duration is an exact multiple of the grid', () => {
    // 200.000s encodes to 200.039912s = 21 segments; this derives 20, dropping
    // a 23ms tail rather than risking a request for a segment that never lands.
    const mine = segmentCount(completeVodPlaylist(playlistOnGrid(10.0078), 200) as string);
    expect(mine).toBe(20);
  });
});
