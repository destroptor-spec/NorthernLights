import { usePlayerStore } from '../index';
import { castManager } from '../../utils/CastManager';
import { playbackManager } from '../../utils/PlaybackManager';
import { sessionMirror } from '../../utils/SessionMirror';
import { getPlaybackTimeSnapshot, setPlaybackTimeState } from '../playbackTime';
import type { TrackInfo } from '../../utils/fileSystem';

/**
 * Signing out, or a login that expires, cuts all playback on this device:
 * local audio, the prepared next track, a cast from here, the sleep timer,
 * and empties the queue. The queue is the account's: with sync on, the
 * server's playback session brings it back after signing in.
 */
const queue: TrackInfo[] = [
  { id: 'a', path: '/a.mp3', duration: 200 },
  { id: 'b', path: '/b.mp3', duration: 180 },
];
const store = () => usePlayerStore.getState();
let halt: jest.SpyInstance;
let castConnected: jest.SpyInstance;
let stopCasting: jest.SpyInstance;

beforeEach(() => {
  halt = jest.spyOn(playbackManager, 'haltForSignOut').mockImplementation(() => undefined);
  castConnected = jest.spyOn(castManager, 'isConnected').mockReturnValue(false);
  stopCasting = jest.spyOn(castManager, 'stopCastingForSignOut').mockReturnValue(true);
  usePlayerStore.setState({
    authToken: 'jwt',
    currentUser: { id: 'u1', username: 'andreas', role: 'admin' },
    playlist: queue,
    currentIndex: 1,
    queueSource: { kind: 'album', id: 'al1', name: 'Album' },
    playbackState: 'playing',
    sleepTimerEndsAt: null,
  } as never);
  setPlaybackTimeState({ currentTime: 42, duration: 180 });
});
afterEach(() => jest.restoreAllMocks());

describe('signing out', () => {
  it('stops local playback and empties the queue', () => {
    store().clearAuthToken();
    expect(halt).toHaveBeenCalledTimes(1);
    expect(stopCasting).not.toHaveBeenCalled();
    expect(store()).toMatchObject({ authToken: null, playlist: [], currentIndex: null, queueSource: null, playbackState: 'stopped' });
    expect(getPlaybackTimeSnapshot().currentTime).toBe(0);
  });

  it('tells the playback session at once where it paused, before emptying the queue and letting it go', () => {
    const reported: unknown[] = [];
    jest.spyOn(sessionMirror, 'reportNow').mockImplementation(() => {
      const state = store();
      reported.push({
        state: state.playbackState,
        track: state.currentIndex !== null ? state.playlist[state.currentIndex]?.id : null,
        position: getPlaybackTimeSnapshot().currentTime,
        user: state.currentUser,
      });
    });
    store().clearAuthToken();
    expect(reported).toEqual([{ state: 'paused', track: 'b', position: 42, user: expect.objectContaining({ id: 'u1' }) }]);
  });

  it.each(['clearAuthToken', 'expireAuthSession'] as const)(
    '%s empties the queue only with the user cleared, so sync never sends it to the server as theirs',
    (action) => {
      const seen: Array<{ queue: number; user: boolean }> = [];
      const unsubscribe = usePlayerStore.subscribe((state) => seen.push({ queue: state.playlist.length, user: !!state.currentUser }));
      store()[action]();
      unsubscribe();
      expect(seen.some((s) => s.queue === 0 && s.user)).toBe(false);
      expect(seen.at(-1)).toEqual({ queue: 0, user: false });
    },
  );

  it("ends this device's cast", () => {
    castConnected.mockReturnValue(true);
    store().clearAuthToken();
    expect(stopCasting).toHaveBeenCalledTimes(1);
    expect(halt).toHaveBeenCalledTimes(1);
  });

  it('cancels the sleep timer', () => {
    const cancel = jest.fn();
    usePlayerStore.setState({ sleepTimerEndsAt: Date.now() + 60_000, cancelSleepTimer: cancel } as never);
    store().clearAuthToken();
    expect(cancel).toHaveBeenCalled();
  });

  it('ignores Play from a media key afterwards', async () => {
    const resume = jest.spyOn(playbackManager, 'resume').mockResolvedValue(undefined as never);
    store().clearAuthToken();
    await store().resume();
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('an expired login', () => {
  it('stops playback and empties the queue as sign-out does (the server session brings it back)', () => {
    store().expireAuthSession();
    expect(halt).toHaveBeenCalledTimes(1);
    expect(store()).toMatchObject({ authToken: null, authExpired: true, playlist: [], currentIndex: null, playbackState: 'stopped' });
    expect(getPlaybackTimeSnapshot().currentTime).toBe(0);
  });

  it("ends this device's cast", () => {
    castConnected.mockReturnValue(true);
    store().expireAuthSession();
    expect(stopCasting).toHaveBeenCalledTimes(1);
  });
});
