import { act, renderHook, waitFor } from '@testing-library/react';
import { usePlayerStore } from '../store';
import { useTrackMusicVideo } from './useTrackMusicVideo';
import type { TrackInfo } from '../utils/fileSystem';
import { useMusicVideoDiagnostics } from '../store/musicVideoDiagnostics';

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
  expect(useMusicVideoDiagnostics.getState()).toMatchObject({ trackId: 'b', videoId: 'video-b' });
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
});

test('diagnostics distinguish a failed lookup from a successful lookup with no match', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 401 }).mockResolvedValueOnce(response(null));
  const { rerender } = renderHook(({ id }) => useTrackMusicVideo(track(id)), { initialProps: { id: 'unauthorized' } });
  await waitFor(() => expect(useMusicVideoDiagnostics.getState().events.at(-1)).toMatchObject({ event: 'lookup-failed', code: 401 }));
  rerender({ id: 'unmatched' });
  await waitFor(() => expect(useMusicVideoDiagnostics.getState().events.at(-1)).toMatchObject({ event: 'no-match' }));
  expect(useMusicVideoDiagnostics.getState().events).not.toContainEqual(expect.objectContaining({ code: 401 }));
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

test('pending metadata is retried and the video appears without reopening', async () => {
  jest.useFakeTimers();
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ video: null, status: 'pending', retryAfterMs: 2000 }) })
    .mockResolvedValueOnce(response('ready-video'));
  const { result, unmount } = renderHook(() => useTrackMusicVideo(track('cold')));
  await act(async () => {});
  expect(result.current.videoId).toBeNull();
  await act(async () => { jest.advanceTimersByTime(2000); });
  expect(result.current.videoId).toBe('ready-video');
  unmount();
  jest.useRealTimers();
});

test('retries are bounded and cancelled when switching tracks', async () => {
  jest.useFakeTimers();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ video: null, status: 'temporary-error', retryAfterMs: 1000 }) });
  const { rerender, unmount } = renderHook(({ id }) => useTrackMusicVideo(track(id)), { initialProps: { id: 'a' } });
  await act(async () => {});
  for (let i = 0; i < 6; i++) await act(async () => { jest.advanceTimersByTime(60000); });
  expect(fetchMock).toHaveBeenCalledTimes(4);
  rerender({ id: 'b' });
  await act(async () => {});
  rerender({ id: 'c' });
  await act(async () => {});
  unmount();
  const calls = fetchMock.mock.calls.length;
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(fetchMock).toHaveBeenCalledTimes(calls);
  jest.useRealTimers();
});

test('pending retries wait while hidden and resume only once on return', async () => {
  jest.useFakeTimers();
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ video: null, status: 'pending', retryAfterMs: 2000 }) })
    .mockResolvedValueOnce(response('recovered'));
  const { result, unmount } = renderHook(() => useTrackMusicVideo(track('hidden')));
  await act(async () => {});
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { jest.advanceTimersByTime(0); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.current.videoId).toBe('recovered');
  unmount();
  if (original) Object.defineProperty(document, 'visibilityState', original);
  else Reflect.deleteProperty(document, 'visibilityState');
  jest.useRealTimers();
});
