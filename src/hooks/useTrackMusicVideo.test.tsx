import { act, renderHook, waitFor } from '@testing-library/react';
import { usePlayerStore } from '../store';
import { useTrackMusicVideo } from './useTrackMusicVideo';
import type { TrackInfo } from '../utils/fileSystem';

const track = (id: string): TrackInfo => ({ id, title: id, path: `/${id}.flac` });
const response = (id: string | null) => ({ ok: true, json: async () => ({ video: id ? { video_id: id } : null }) });
const originalFetch = global.fetch;
let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  usePlayerStore.setState({ youtubeEnabled: true, mobileVideoBackgrounds: true, castConnected: false });
});
afterEach(() => { global.fetch = originalFetch; });

test('reopening retries a missing match populated since the last visit', async () => {
  fetchMock.mockResolvedValueOnce(response(null)).mockResolvedValueOnce(response('new-video'));
  const first = renderHook(() => useTrackMusicVideo(track('retry')));
  await act(async () => {});
  first.unmount();
  const second = renderHook(() => useTrackMusicVideo(track('retry')));
  await waitFor(() => expect(second.result.current.videoId).toBe('new-video'));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('switching tracks immediately hides the old match while the next lookup waits', async () => {
  fetchMock.mockResolvedValueOnce(response('video-a')).mockReturnValueOnce(new Promise(() => {}));
  const { result, rerender } = renderHook(({ id }) => useTrackMusicVideo(track(id)), { initialProps: { id: 'a' } });
  await waitFor(() => expect(result.current.videoId).toBe('video-a'));
  rerender({ id: 'b' });
  expect(result.current.videoId).toBeNull();
});

test('late responses for an old track cannot overwrite the current match', async () => {
  let resolveOld!: (value: ReturnType<typeof response>) => void;
  fetchMock.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce(response('video-b'));
  const { result, rerender } = renderHook(({ id }) => useTrackMusicVideo(track(id)), { initialProps: { id: 'a' } });
  rerender({ id: 'b' });
  await waitFor(() => expect(result.current.videoId).toBe('video-b'));
  await act(async () => { resolveOld(response('video-a')); });
  expect(result.current.videoId).toBe('video-b');
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
});

test.each([
  { youtubeEnabled: false }, { mobileVideoBackgrounds: false }, { castConnected: true },
])('does not fetch when gated by %j', settings => {
  usePlayerStore.setState(settings);
  const { result } = renderHook(() => useTrackMusicVideo(track('gated')));
  expect(result.current.videoId).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('disabling backgrounds removes the active video', async () => {
  fetchMock.mockResolvedValue(response('video'));
  const { result } = renderHook(() => useTrackMusicVideo(track('toggle')));
  await waitFor(() => expect(result.current.videoId).toBe('video'));
  act(() => usePlayerStore.setState({ mobileVideoBackgrounds: false }));
  expect(result.current.videoId).toBeNull();
});
