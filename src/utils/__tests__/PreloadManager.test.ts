import type { TrackInfo } from '../fileSystem';
import { preloadManager } from '../PreloadManager';

jest.mock('../losslessCapability', () => ({ canBrowserPlayNative: (format?: string) => format === 'FLAC' }));

const makeTrack = (id: string): TrackInfo => ({
  id,
  path: `/${id}.flac`,
  title: id,
  url: `/api/stream/${id}/playlist.m3u8?quality=128k`,
});

describe('PreloadManager', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('prewarms only the immediate next track by default', () => {
    const playlist = [makeTrack('current-default'), makeTrack('next-default'), makeTrack('later-default')];

    preloadManager.prewarmNext(playlist, 0, '128k');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/api/stream/next-default/prewarm' }),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('prewarms two queued tracks for aggressive preparation', () => {
    const playlist = [makeTrack('current-aggressive'), makeTrack('next-aggressive'), makeTrack('later-aggressive')];

    preloadManager.prewarmNext(playlist, 0, '128k', { aheadCount: 2 });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pathname: '/api/stream/next-aggressive/prewarm' }),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pathname: '/api/stream/later-aggressive/prewarm' }),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('stops at the end of the queue', () => {
    const playlist = [makeTrack('current-tail'), makeTrack('next-tail')];

    preloadManager.prewarmNext(playlist, 0, '128k', { aheadCount: 2 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('warms the fixed cast flavor when cast is connected', () => {
    const playlist = [makeTrack('current-cast'), makeTrack('next-cast')];

    preloadManager.prewarmNext(playlist, 0, 'auto', { castConnected: true });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as URL;
    expect(url.searchParams.get('quality')).toBe('128k');
    expect(url.searchParams.get('codec')).toBe('aac');
  });

  it('warms the browser flavor without a codec param when not casting', () => {
    const playlist = [makeTrack('current-local'), makeTrack('next-local')];

    preloadManager.prewarmNext(playlist, 0, 'auto');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as URL;
    expect(url.searchParams.get('quality')).toBe('auto');
    expect(url.searchParams.has('codec')).toBe(false);
  });

  // Prod 2026-10-17: at Source quality every next track was transcoded into an
  // HLS session that nothing played; those files stream directly.
  it('warms no HLS session for a track that streams directly at Source quality', () => {
    const playlist = [makeTrack('current-direct'), { ...makeTrack('next-direct'), format: 'FLAC' }];
    preloadManager.prewarmNext(playlist, 0, 'source');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still warms HLS at Source for a format this browser cannot play, and while casting', () => {
    const playlist = [makeTrack('current-mixed'), { ...makeTrack('next-wma'), format: 'ASF/Windows Media' }, { ...makeTrack('after-flac'), format: 'FLAC' }];
    preloadManager.prewarmNext(playlist, 0, 'source', { aheadCount: 2 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('next-wma');

    (global.fetch as jest.Mock).mockClear();
    preloadManager.prewarmNext([makeTrack('current-cast-src'), { ...makeTrack('next-cast-flac'), format: 'FLAC' }], 0, 'source', { castConnected: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
