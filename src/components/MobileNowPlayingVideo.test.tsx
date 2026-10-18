import { StrictMode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import MobileNowPlayingVideo from './MobileNowPlayingVideo';
import { usePlayerStore } from '../store';
import { usePlaybackTimeStore, noteLocalPlaybackSeek } from '../store/playbackTime';
import { loadYouTubeIframeApi, type YTNamespace, type YTPlayer, type YTPlayerOptions } from '../utils/youtubeIframeApi';
import { beginMusicVideoDiagnostics, useMusicVideoDiagnostics } from '../store/musicVideoDiagnostics';

jest.mock('../utils/youtubeIframeApi', () => ({ loadYouTubeIframeApi: jest.fn() }));
let options: YTPlayerOptions;
let player: jest.Mocked<YTPlayer>;
const loadMock = jest.mocked(loadYouTubeIframeApi);
beforeEach(() => {
  jest.useFakeTimers();
  beginMusicVideoDiagnostics('test-track', 'matched');
  usePlayerStore.setState({ playbackState: 'playing' });
  usePlaybackTimeStore.setState({ currentTime: 12 });
  player = {
    playVideo: jest.fn(), pauseVideo: jest.fn(), stopVideo: jest.fn(), mute: jest.fn(), unMute: jest.fn(),
    seekTo: jest.fn(), getCurrentTime: jest.fn(() => 12), getDuration: jest.fn(() => 180),
    getVideoLoadedFraction: jest.fn(() => 1), getPlayerState: jest.fn(() => -1), destroy: jest.fn(),
  };
  loadMock.mockResolvedValue({
    Player: jest.fn((_target: HTMLElement, value: YTPlayerOptions) => { options = value; return player; }),
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  } as unknown as YTNamespace);
});
afterEach(() => { jest.useRealTimers(); });
async function mount() {
  const onPhaseChange = jest.fn();
  const view = render(<div className="mobile-now-playing-shell"><MobileNowPlayingVideo videoId="test-video" onPhaseChange={onPhaseChange} /></div>);
  await act(async () => {});
  return { ...view, onPhaseChange };
}
function ready() { act(() => options.events?.onReady?.({ target: player })); }
function state(data: number) { act(() => options.events?.onStateChange?.({ target: player, data })); }

test('waits for readiness then mutes before playing at the latest audio position', async () => {
  const { onPhaseChange } = await mount();
  act(() => usePlayerStore.setState({ playbackState: 'paused' }));
  act(() => usePlayerStore.setState({ playbackState: 'playing' }));
  act(() => jest.advanceTimersByTime(1000));
  expect(player.playVideo).not.toHaveBeenCalled();
  expect(player.pauseVideo).not.toHaveBeenCalled();
  expect(player.getPlayerState).not.toHaveBeenCalled();
  ready();
  expect(player.mute.mock.invocationCallOrder[0]).toBeLessThan(player.playVideo.mock.invocationCallOrder[0]);
  expect(player.mute.mock.invocationCallOrder[0]).toBeLessThan(player.seekTo.mock.invocationCallOrder[0]);
  expect(player.seekTo).toHaveBeenCalledWith(12, true);
  expect(options.playerVars).toMatchObject({ mute: 1, playsinline: 1 });
  state(1);
  expect(onPhaseChange).toHaveBeenLastCalledWith('visible');
});

test('a track paused while loading does not start the video on readiness', async () => {
  await mount();
  act(() => usePlayerStore.setState({ playbackState: 'paused' }));
  ready();
  expect(player.playVideo).not.toHaveBeenCalled();
  act(() => usePlayerStore.setState({ playbackState: 'playing' }));
  expect(player.playVideo).toHaveBeenCalledTimes(1);
});

test('blocked autoplay restores cover art and retries on a player gesture', async () => {
  const { container, onPhaseChange } = await mount();
  ready();
  act(() => options.events?.onAutoplayBlocked?.({ target: player }));
  expect(onPhaseChange).toHaveBeenLastCalledWith('none');
  fireEvent.pointerUp(container.firstChild!);
  expect(player.playVideo).toHaveBeenCalledTimes(2);
  state(1);
  expect(onPhaseChange).toHaveBeenLastCalledWith('visible');
});

test('embed errors stop polling and unmount cleans up the player subscription', async () => {
  const { unmount, onPhaseChange } = await mount();
  ready();
  state(1);
  act(() => options.events?.onError?.({ target: player, data: 150 }));
  expect(onPhaseChange).toHaveBeenLastCalledWith('none');
  player.getCurrentTime.mockClear();
  player.getPlayerState.mockClear();
  act(() => jest.advanceTimersByTime(8000));
  expect(player.getCurrentTime).not.toHaveBeenCalled();
  expect(player.getPlayerState).not.toHaveBeenCalled();
  unmount();
  expect(player.destroy).toHaveBeenCalledTimes(1);
  act(() => usePlayerStore.setState({ playbackState: 'paused' }));
  expect(player.pauseVideo).not.toHaveBeenCalled();
});

test('Strict Mode teardown removes the abandoned target before API readiness', async () => {
  loadMock.mockReturnValue(new Promise(() => {}));
  const { container, unmount } = render(<StrictMode><MobileNowPlayingVideo videoId="strict" onPhaseChange={jest.fn()} /></StrictMode>);
  expect(container.querySelector('.mobile-now-video-player')?.childElementCount).toBe(1);
  unmount();
});

test('retains the embed error after leaving Now Playing and ignores late callbacks', async () => {
  const { unmount } = await mount();
  ready();
  act(() => options.events?.onError?.({ target: player, data: 153 }));
  unmount();
  expect(useMusicVideoDiagnostics.getState().events.at(-1)).toMatchObject({ event: 'embed-error', code: 153 });
  beginMusicVideoDiagnostics('next-track', 'lookup');
  act(() => options.events?.onError?.({ target: player, data: 100 }));
  act(() => options.events?.onAutoplayBlocked?.({ target: player }));
  expect(useMusicVideoDiagnostics.getState().events.at(-1)?.event).toBe('lookup');
});

test('reports iframe readiness timeout without preventing a late ready event from playing', async () => {
  const { unmount } = await mount();
  act(() => jest.advanceTimersByTime(20000));
  expect(useMusicVideoDiagnostics.getState().events.at(-1)?.event).toBe('player-timeout');
  ready();
  expect(player.playVideo).toHaveBeenCalledTimes(1);
  expect(useMusicVideoDiagnostics.getState().events.at(-1)?.event).toBe('ready');
  unmount();
  const eventCount = useMusicVideoDiagnostics.getState().events.length;
  act(() => jest.advanceTimersByTime(30000));
  expect(useMusicVideoDiagnostics.getState().events).toHaveLength(eventCount);
});

test('API loader failure is reported separately from blocked autoplay', async () => {
  loadMock.mockRejectedValueOnce(new Error('script load failed'));
  const { onPhaseChange } = await mount();
  expect(onPhaseChange).toHaveBeenLastCalledWith('none');
  expect(useMusicVideoDiagnostics.getState().events.at(-1)?.event).toBe('api-failed');
});

test('seeks immediately while paused, including small seeks and back to zero', async () => {
  await mount();
  ready();
  act(() => usePlayerStore.setState({ playbackState: 'paused' }));
  player.seekTo.mockClear();
  player.playVideo.mockClear();
  act(() => noteLocalPlaybackSeek(12.2));
  expect(player.seekTo).toHaveBeenLastCalledWith(12.2, true);
  act(() => noteLocalPlaybackSeek(0));
  expect(player.seekTo).toHaveBeenLastCalledWith(0, true);
  expect(player.playVideo).not.toHaveBeenCalled();
});

test('corrects drift over 750ms but avoids repeated seeks while buffering', async () => {
  await mount(); ready(); state(1);
  player.seekTo.mockClear();
  player.getPlayerState.mockReturnValue(1);
  act(() => usePlaybackTimeStore.setState({ currentTime: 12.5 }));
  act(() => jest.advanceTimersByTime(2000));
  expect(player.seekTo).not.toHaveBeenCalled();
  act(() => usePlaybackTimeStore.setState({ currentTime: 14 }));
  act(() => jest.advanceTimersByTime(1000));
  expect(player.seekTo).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(1000));
  expect(player.seekTo).toHaveBeenCalledTimes(1);
  player.getPlayerState.mockReturnValue(3);
  act(() => jest.advanceTimersByTime(4000));
  expect(player.seekTo).toHaveBeenCalledTimes(1);
  state(1);
  expect(player.seekTo).toHaveBeenCalledTimes(2);
});

test('foreground return resynchronizes with audio without requiring a playback-state change', async () => {
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const { unmount } = await mount(); ready(); state(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  fireEvent(document, new Event('visibilitychange'));
  expect(player.pauseVideo).toHaveBeenCalled();
  act(() => usePlaybackTimeStore.setState({ currentTime: 60 }));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  fireEvent(document, new Event('visibilitychange'));
  expect(player.seekTo).toHaveBeenLastCalledWith(60, true);
  expect(player.playVideo).toHaveBeenCalledTimes(2);
  unmount();
  const seeks = player.seekTo.mock.calls.length;
  act(() => noteLocalPlaybackSeek(0));
  expect(player.seekTo).toHaveBeenCalledTimes(seeks);
  if (original) Object.defineProperty(document, 'visibilityState', original);
  else Reflect.deleteProperty(document, 'visibilityState');
});

test('does not loop a shorter video, but an explicit backward seek can show it again', async () => {
  const { onPhaseChange } = await mount(); ready(); state(1);
  player.getPlayerState.mockReturnValue(1);
  act(() => usePlaybackTimeStore.setState({ currentTime: 190 }));
  act(() => jest.advanceTimersByTime(2000));
  expect(onPhaseChange).toHaveBeenLastCalledWith('ended');
  player.playVideo.mockClear();
  act(() => jest.advanceTimersByTime(8000));
  expect(player.playVideo).not.toHaveBeenCalled();
  act(() => noteLocalPlaybackSeek(30));
  expect(player.seekTo).toHaveBeenLastCalledWith(30, true);
  state(1);
  expect(onPhaseChange).toHaveBeenLastCalledWith('visible');
});
