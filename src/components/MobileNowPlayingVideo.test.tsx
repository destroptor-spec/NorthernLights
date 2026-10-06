import { StrictMode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import MobileNowPlayingVideo from './MobileNowPlayingVideo';
import { usePlayerStore } from '../store';
import { usePlaybackTimeStore } from '../store/playbackTime';
import { loadYouTubeIframeApi, type YTNamespace, type YTPlayer, type YTPlayerOptions } from '../utils/youtubeIframeApi';

jest.mock('../utils/youtubeIframeApi', () => ({ loadYouTubeIframeApi: jest.fn() }));
let options: YTPlayerOptions;
let player: jest.Mocked<YTPlayer>;
const loadMock = jest.mocked(loadYouTubeIframeApi);
beforeEach(() => {
  jest.useFakeTimers();
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
