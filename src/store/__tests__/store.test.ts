import { restorePersistedPlayerState, usePlayerStore } from '../index';
import { selectDisplayedPlaybackState, selectDisplayedPlaying } from '../../utils/sessionFollow';
import { sendRemoteAction, startOnFollowingReceiver } from '../../utils/sessionRemote';
import { castManager } from '../../utils/CastManager';
import { sessionMirror } from '../../utils/SessionMirror';
import * as auroraApi from '../../api/auroraApi';
import { sessionFollower } from '../../utils/SessionFollower';

jest.mock('../../utils/sessionRemote', () => ({ sendRemoteAction: jest.fn(async () => 'sent'), startOnFollowingReceiver: jest.fn(async () => 'sent') }));
import { TrackInfo } from '../../utils/fileSystem';
import { hasNextTrack } from '../../utils/queue';
import { playbackManager } from '../../utils/PlaybackManager';
import { getPlaybackTimeSnapshot, setPlaybackTimeState } from '../playbackTime';

describe('Music Store Logic', () => {
  beforeEach(() => {
    usePlayerStore.setState({ library: [], playlist: [] });
  });
  it('adds tracks to library', () => {
    usePlayerStore.setState({ library: [] });
    usePlayerStore.getState().addTracksToLibrary([{ id: 'baz', path: '/baz.mp3', title: 'c' }]);
    expect(usePlayerStore.getState().library).toHaveLength(1);
    expect(usePlayerStore.getState().library[0].title).toBe('c');
  });

  it('never removes the track that plays from the queue (Skip moves past it)', () => {
    usePlayerStore.setState({
      playlist: [{ id: 'a', path: '/a.mp3' }, { id: 'b', path: '/b.mp3' }, { id: 'c', path: '/c.mp3' }],
      currentIndex: 1,
    });
    usePlayerStore.getState().removeFromPlaylist(1);
    expect(usePlayerStore.getState().playlist.map((t: TrackInfo) => t.id)).toEqual(['a', 'b', 'c']);
    usePlayerStore.getState().removeFromPlaylist(2);
    expect(usePlayerStore.getState().playlist.map((t: TrackInfo) => t.id)).toEqual(['a', 'b']);
    expect(usePlayerStore.getState().currentIndex).toBe(1);
  });

  it('moves a track in the playlist', () => {
    usePlayerStore.setState({
      playlist: [
        { id: 'a', path: '/a.mp3', title: 'x' },
        { id: 'b', path: '/b.mp3', title: 'y' }
      ]
    });
    usePlayerStore.getState().moveInPlaylist(0, 1);
    expect(usePlayerStore.getState().playlist.map((t: TrackInfo) => t.id)).toEqual(['b', 'a']);
  });

  it('preserves Auto quality while hydrating browser track URLs', () => {
    usePlayerStore.setState({ mediaAccessToken: 'media-token', streamingQuality: 'auto' });
    const [track] = usePlayerStore.getState().hydrateTracks([
      { id: 'adaptive-track', path: 'L211c2ljL2FkYXB0aXZlLmZsYWM=', title: 'Adaptive' },
    ]);
    const url = new URL(track.url!);
    expect(url.searchParams.get('quality')).toBe('auto');
    expect(url.searchParams.get('token')).toBe('media-token');
  });

  describe('Next on the last track', () => {
    const queue = () => [{ id: 'a', path: '/a.mp3', title: 'a' }, { id: 'b', path: '/b.mp3', title: 'b' }];
    const stubs = () => {
      const playAtIndex = jest.fn().mockResolvedValue(undefined);
      const stop = jest.fn();
      const fetchNextInfinityTrack = jest.fn().mockResolvedValue(undefined);
      usePlayerStore.setState({ playAtIndex, stop, fetchNextInfinityTrack, recordSkip: jest.fn(), _scrobbleEligible: true, shuffle: false } as never);
      return { playAtIndex, stop, fetchNextInfinityTrack };
    };

    it('wraps to the first track only with repeat-all', async () => {
      const { playAtIndex } = stubs();
      usePlayerStore.setState({ playlist: queue(), currentIndex: 1, repeat: 'all' });
      await usePlayerStore.getState().nextTrack();
      expect(playAtIndex).toHaveBeenCalledWith(0);
    });

    it('continues with Infinity instead of jumping back to the first track', async () => {
      const { playAtIndex, fetchNextInfinityTrack } = stubs();
      usePlayerStore.setState({ playlist: queue(), currentIndex: 1, repeat: 'none', isInfinityMode: true });
      await usePlayerStore.getState().nextTrack();
      expect(fetchNextInfinityTrack).toHaveBeenCalledWith(false);
      expect(playAtIndex).not.toHaveBeenCalled();
    });

    it('records the skip of the last track before Infinity continues', async () => {
      stubs();
      const recordSkip = jest.fn();
      usePlayerStore.setState({ recordSkip, _scrobbleEligible: false, playlist: queue(), currentIndex: 1, repeat: 'none', isInfinityMode: true } as never);
      await usePlayerStore.getState().nextTrack();
      expect(recordSkip).toHaveBeenCalledWith('b');
    });

    it('does nothing without Infinity: Next is disabled there, and stopping closed the mobile player', async () => {
      const { playAtIndex, stop, fetchNextInfinityTrack } = stubs();
      usePlayerStore.setState({ playlist: queue(), currentIndex: 1, repeat: 'none', isInfinityMode: false });
      expect(hasNextTrack(usePlayerStore.getState())).toBe(false);
      await usePlayerStore.getState().nextTrack();
      expect(stop).not.toHaveBeenCalled();
      expect(playAtIndex).not.toHaveBeenCalled();
      expect(fetchNextInfinityTrack).not.toHaveBeenCalled();
    });

    it('hasNextTrack: repeat-all, shuffle or Infinity keep Next enabled on the last track', () => {
      const base = { playlist: queue(), currentIndex: 1, repeat: 'none' as const, shuffle: false, isInfinityMode: false };
      expect(hasNextTrack(base)).toBe(false);
      expect(hasNextTrack({ ...base, repeat: 'all' })).toBe(true);
      expect(hasNextTrack({ ...base, shuffle: true })).toBe(true);
      expect(hasNextTrack({ ...base, isInfinityMode: true })).toBe(true);
      expect(hasNextTrack({ ...base, currentIndex: 0 })).toBe(true);
      expect(hasNextTrack({ ...base, playlist: [] })).toBe(false);
    });

    it('still advances normally before the end', async () => {
      const { playAtIndex } = stubs();
      usePlayerStore.setState({ playlist: queue(), currentIndex: 0, repeat: 'none', isInfinityMode: false });
      await usePlayerStore.getState().nextTrack();
      expect(playAtIndex).toHaveBeenCalledWith(1);
    });
  });

  // Prod 2026-10-13: after a Cast session ended, the browser's own player still
  // held the track from before casting, so Play resumed that (or nothing).
  describe('after a Cast session ends', () => {
    const queue = () => [
      { id: 'a', path: '/a.mp3', title: 'a', duration: 200 },
      { id: 'b', path: '/b.mp3', title: 'b', duration: 170 },
    ];
    let seek: jest.SpyInstance;
    let resume: jest.SpyInstance;
    let playAtIndex: jest.Mock;
    beforeEach(() => {
      seek = jest.spyOn(playbackManager, 'seek').mockImplementation(() => {});
      resume = jest.spyOn(playbackManager, 'resume').mockResolvedValue(undefined);
      jest.spyOn(playbackManager, 'pause').mockImplementation(() => {});
      playAtIndex = jest.fn().mockResolvedValue(undefined);
      usePlayerStore.setState({ playlist: queue(), currentIndex: 0, playbackState: 'playing', playAtIndex } as never);
    });
    afterEach(() => jest.restoreAllMocks());

    it('plays the Cast track here from its position when told to', async () => {
      await usePlayerStore.getState().continueLocallyAfterCast(1, 130, true);
      expect(playAtIndex).toHaveBeenCalledWith(1);
      expect(seek).toHaveBeenCalledWith(130);
    });

    it('otherwise shows it paused, and the next Play starts it from there', async () => {
      await usePlayerStore.getState().continueLocallyAfterCast(1, 130, false);
      expect(playAtIndex).not.toHaveBeenCalled();
      expect(usePlayerStore.getState()).toMatchObject({ currentIndex: 1, playbackState: 'paused' });
      expect(getPlaybackTimeSnapshot()).toEqual({ currentTime: 130, duration: 170 });

      await usePlayerStore.getState().resume();
      expect(resume).not.toHaveBeenCalled();
      expect(playAtIndex).toHaveBeenCalledWith(1);
      expect(seek).toHaveBeenCalledWith(130);

      await usePlayerStore.getState().resume();
      expect(resume).toHaveBeenCalledTimes(1);
    });
  });

  // Sync playback across devices: an idle device follows the one that plays,
  // and asks "Play where?" before it acts (Andreas, 2026-10-13).
  describe('following another device', () => {
    const entry = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const queue = () => [
      { id: 'a', path: '/a.mp3', title: 'a', duration: 200, queueEntryId: entry(1) },
      { id: 'b', path: '/b.mp3', title: 'b', duration: 170, queueEntryId: entry(2) },
      { id: 'c', path: '/c.mp3', title: 'c', duration: 180, queueEntryId: entry(3) },
    ];
    const follow = (extra: Record<string, unknown> = {}) => ({
      sessionId: 's', outputId: 'desktop', name: 'NAD Forstærker', kind: 'cast' as const, generation: 4,
      state: 'playing' as const, entryId: entry(2), positionMs: 30_000, anchorMs: Date.now(), ...extra,
    });
    let seek: jest.SpyInstance;
    let playAtIndex: jest.Mock;
    const sent = () => (sendRemoteAction as jest.Mock).mock.calls.map(([action]) => action);
    const following = (extra: Record<string, unknown> = {}) => {
      usePlayerStore.getState().adoptSessionQueue(queue(), 1, 30);
      usePlayerStore.getState().setSessionFollow(follow(extra));
    };
    beforeEach(() => {
      seek = jest.spyOn(playbackManager, 'seek').mockImplementation(() => {});
      jest.spyOn(playbackManager, 'resume').mockResolvedValue(undefined);
      jest.spyOn(playbackManager, 'pause').mockImplementation(() => {});
      (sendRemoteAction as jest.Mock).mockClear();
      playAtIndex = jest.fn().mockResolvedValue(undefined);
      usePlayerStore.setState({
        playlist: [{ id: 'old', path: '/old.mp3', title: 'old', queueEntryId: entry(9) }],
        currentIndex: 0, playbackState: 'paused', castConnected: false,
        sessionFollow: null, remoteControlOutputId: null, playWherePrompt: null, playAtIndex,
      } as never);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      jest.useRealTimers();
      usePlayerStore.setState({ sessionFollow: null, remoteControlOutputId: null, playWherePrompt: null });
    });

    it("takes over the session's queue paused; on this device, Play continues from where the other device is now", async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      following({ anchorMs: 1_000_000 });
      expect(usePlayerStore.getState()).toMatchObject({ currentIndex: 1, playbackState: 'paused', queueSource: null });
      expect(usePlayerStore.getState().playlist.map((t) => t.queueEntryId)).toEqual([entry(1), entry(2), entry(3)]);

      await usePlayerStore.getState().resume();
      expect(usePlayerStore.getState().playWherePrompt).toEqual({ outputName: 'NAD Forstærker' });
      expect(playAtIndex).not.toHaveBeenCalled();

      jest.setSystemTime(1_007_000);
      await usePlayerStore.getState().resolvePlayWhere('here');
      expect(playAtIndex).toHaveBeenCalledWith(1);
      expect(seek).toHaveBeenCalledWith(37);
      expect(sendRemoteAction).not.toHaveBeenCalled();
    });

    it('never touches a device that plays', () => {
      usePlayerStore.setState({ playbackState: 'playing' });
      usePlayerStore.getState().adoptSessionQueue(queue(), 1, 30);
      expect(usePlayerStore.getState().playlist.map((t) => t.id)).toEqual(['old']);
    });

    it('on the playing device: sends the action there, and remembers that for the next ones', async () => {
      following();
      await usePlayerStore.getState().nextTrack();
      await usePlayerStore.getState().resolvePlayWhere('remote');
      expect(sent()).toEqual([{ type: 'next' }]);
      expect(usePlayerStore.getState().remoteControlOutputId).toBe('desktop');

      // Remembered: no more asking.
      await usePlayerStore.getState().prevTrack();
      usePlayerStore.getState().pause();
      await usePlayerStore.getState().playQueueEntry(2);
      usePlayerStore.getState().seekTo(95);
      const album = [{ id: 'x', path: '/x.mp3', title: 'x' }, { id: 'y', path: '/y.mp3', title: 'y' }];
      await usePlayerStore.getState().setPlaylist(album, 1);
      expect(usePlayerStore.getState().playWherePrompt).toBeNull();
      expect(sent().slice(1)).toEqual([
        { type: 'previous' },
        { type: 'pause' },
        { type: 'jump', track: expect.objectContaining({ queueEntryId: entry(3) }) },
        { type: 'seek', seconds: 95 },
        { type: 'load', tracks: album, startIndex: 1 },
      ]);
      expect(playAtIndex).not.toHaveBeenCalled();
      expect(usePlayerStore.getState().playlist.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });

    it('on this device: does it here (Next plays the next track here)', async () => {
      following();
      await usePlayerStore.getState().nextTrack();
      await usePlayerStore.getState().resolvePlayWhere('here');
      expect(playAtIndex).toHaveBeenCalledWith(2);
      expect(sendRemoteAction).not.toHaveBeenCalled();
    });

    it('Previous here restarts the track when the other device was past 3 s', async () => {
      following();
      await usePlayerStore.getState().prevTrack();
      await usePlayerStore.getState().resolvePlayWhere('here');
      expect(playAtIndex).toHaveBeenCalledWith(1);
    });

    it('closing "Play where?" does nothing', async () => {
      following();
      await usePlayerStore.getState().playQueueEntry(0);
      await usePlayerStore.getState().resolvePlayWhere(null);
      expect(playAtIndex).not.toHaveBeenCalled();
      expect(sendRemoteAction).not.toHaveBeenCalled();
      expect(usePlayerStore.getState().remoteControlOutputId).toBeNull();
    });

    it('Pause never asks: with nothing chosen it stays a local pause', () => {
      following();
      usePlayerStore.getState().pause();
      expect(usePlayerStore.getState().playWherePrompt).toBeNull();
      expect(sendRemoteAction).not.toHaveBeenCalled();
    });

    it('forgets the choice when another device takes over or playback there ends', () => {
      following();
      usePlayerStore.setState({ remoteControlOutputId: 'desktop' });
      usePlayerStore.getState().setSessionFollow(follow({ positionMs: 40_000 }));
      expect(usePlayerStore.getState().remoteControlOutputId).toBe('desktop');
      usePlayerStore.getState().setSessionFollow(follow({ outputId: 'phone', name: 'Chrome on Android' }));
      expect(usePlayerStore.getState().remoteControlOutputId).toBeNull();

      usePlayerStore.setState({ remoteControlOutputId: 'phone' });
      usePlayerStore.getState().setSessionFollow(null);
      expect(usePlayerStore.getState().remoteControlOutputId).toBeNull();
    });

    it("shows the controlled device's play state on the Play/Pause button", () => {
      following();
      expect(selectDisplayedPlaying(usePlayerStore.getState())).toBe(false);
      usePlayerStore.setState({ remoteControlOutputId: 'desktop' });
      expect(selectDisplayedPlaying(usePlayerStore.getState())).toBe(true);
      usePlayerStore.getState().setSessionFollow(follow({ state: 'paused' }));
      expect(selectDisplayedPlaying(usePlayerStore.getState())).toBe(false);
    });

    it("shows the controlled device's state on now-playing indicators too", () => {
      // Prod 2026-10-17: the Play/Pause button said playing while the album
      // header and the bars in the track list said paused.
      following();
      expect(selectDisplayedPlaybackState(usePlayerStore.getState())).not.toBe('playing');
      usePlayerStore.setState({ remoteControlOutputId: 'desktop' });
      expect(selectDisplayedPlaybackState(usePlayerStore.getState())).toBe('playing');
      usePlayerStore.getState().setSessionFollow(follow({ state: 'paused' }));
      expect(selectDisplayedPlaybackState(usePlayerStore.getState())).toBe('paused');
    });

    it('the device chip changes the choice without doing anything else', async () => {
      following();
      usePlayerStore.getState().openPlayWhere();
      await usePlayerStore.getState().resolvePlayWhere('remote');
      expect(usePlayerStore.getState().remoteControlOutputId).toBe('desktop');
      expect(sendRemoteAction).not.toHaveBeenCalled();
      expect(playAtIndex).not.toHaveBeenCalled();
    });

    it('forgets the choice and says so when that device cannot be reached', async () => {
      following();
      usePlayerStore.setState({ remoteControlOutputId: 'desktop', toasts: [] } as never);
      (sendRemoteAction as jest.Mock).mockResolvedValueOnce('unreachable');
      await usePlayerStore.getState().nextTrack();
      await Promise.resolve();
      expect(usePlayerStore.getState().remoteControlOutputId).toBeNull();
      expect(usePlayerStore.getState().toasts.map((t) => t.message)).toContain("NAD Forstærker isn't reachable.");
    });

    it("says when a connected device does not answer a command (asleep in the background)", async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      following();
      usePlayerStore.setState({ remoteControlOutputId: 'desktop', toasts: [] } as never);
      const heard = jest.spyOn(sessionFollower, 'lastHeardFrom').mockReturnValue(0);
      await usePlayerStore.getState().nextTrack();
      await jest.advanceTimersByTimeAsync(4_900);
      expect(usePlayerStore.getState().toasts).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(200);
      expect(usePlayerStore.getState().toasts.map((t) => t.message)).toContain("NAD Forstærker isn't responding.");

      // An answer in time means no message.
      usePlayerStore.setState({ toasts: [] } as never);
      heard.mockReturnValue(Number.MAX_SAFE_INTEGER);
      await usePlayerStore.getState().nextTrack();
      await jest.advanceTimersByTimeAsync(6_000);
      expect(usePlayerStore.getState().toasts).toHaveLength(0);
    });

    // Prod 2026-10-14: the phone casting to the NAD was locked and went
    // quiet; the desktop dropped it and started a second playback unasked.
    it('asks before playing alongside a Cast device that is not responding, and sends nothing to it', async () => {
      following({ silent: true });
      usePlayerStore.setState({ remoteControlOutputId: 'desktop' });
      await usePlayerStore.getState().nextTrack();
      expect(usePlayerStore.getState().playWherePrompt).toEqual({ outputName: 'NAD Forstærker', silent: true });
      expect(sendRemoteAction).not.toHaveBeenCalled();
      await usePlayerStore.getState().resolvePlayWhere('remote');
      expect(sendRemoteAction).not.toHaveBeenCalled();
      expect(playAtIndex).not.toHaveBeenCalled();

      await usePlayerStore.getState().nextTrack();
      await usePlayerStore.getState().resolvePlayWhere('here');
      expect(playAtIndex).toHaveBeenCalledWith(2);
    });

    it('does not top up Infinity on a copy of another device\'s queue', async () => {
      following();
      const fetchNext = jest.fn().mockResolvedValue(undefined);
      usePlayerStore.setState({ isInfinityMode: false, fetchNextInfinityTrack: fetchNext } as never);
      usePlayerStore.getState().toggleInfinityMode();
      await usePlayerStore.getState().ensureInfinityQueue();
      expect(usePlayerStore.getState().isInfinityMode).toBe(true);
      expect(fetchNext).not.toHaveBeenCalled();
    });

    it('a remote load keeps the session entry IDs and plays the chosen entry', async () => {
      await usePlayerStore.getState().playSessionQueue(queue(), 2);
      expect(usePlayerStore.getState().playlist.map((t) => t.queueEntryId)).toEqual([entry(1), entry(2), entry(3)]);
      expect(usePlayerStore.getState()).toMatchObject({ currentIndex: 2, queueSource: null });
      expect(playAtIndex).toHaveBeenCalledWith(2);
    });
  });

  // The admin decides; with "each user decides" the user's own choice, stored
  // on the server, applies on all their devices.
  describe('sync playback across devices', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });
    const respond = (body: unknown) => { global.fetch = jest.fn(async () => ({ ok: true, json: async () => body })) as never; };

    it('reads the mode and the user choice from the server', async () => {
      usePlayerStore.setState({ authToken: 'jwt', playbackSyncMode: 'off', playbackSyncUserEnabled: false, syncPlaybackAcrossDevices: false } as never);
      respond({ playbackSyncMode: 'user', playbackSyncEnabled: true });
      await usePlayerStore.getState().refreshPlaybackSync();
      expect(usePlayerStore.getState()).toMatchObject({ playbackSyncMode: 'user', playbackSyncUserEnabled: true, syncPlaybackAcrossDevices: true });

      respond({ playbackSyncMode: 'off', playbackSyncEnabled: true });
      await usePlayerStore.getState().refreshPlaybackSync();
      expect(usePlayerStore.getState().syncPlaybackAcrossDevices).toBe(false);
    });

    it('saves the user choice for all their devices, and goes back when that fails', async () => {
      usePlayerStore.setState({ authToken: 'jwt', playbackSyncMode: 'user', playbackSyncUserEnabled: false, syncPlaybackAcrossDevices: false, toasts: [] } as never);
      respond({});
      await usePlayerStore.getState().savePlaybackSyncUserEnabled(true);
      expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({ playbackSyncEnabled: true });
      expect(usePlayerStore.getState().syncPlaybackAcrossDevices).toBe(true);

      global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'nope' }) })) as never;
      await usePlayerStore.getState().savePlaybackSyncUserEnabled(false);
      expect(usePlayerStore.getState()).toMatchObject({ playbackSyncUserEnabled: true, syncPlaybackAcrossDevices: true });
    });

    it("forgets the signed-out user's choice", () => {
      usePlayerStore.setState({ playbackSyncMode: 'user', playbackSyncUserEnabled: true, syncPlaybackAcrossDevices: true } as never);
      usePlayerStore.getState().clearAuthToken();
      expect(usePlayerStore.getState()).toMatchObject({ playbackSyncUserEnabled: false, syncPlaybackAcrossDevices: false });
    });
  });

  // Prod 2026-10-14: reopening the phone PWA, which had been playing when it
  // was closed, took playback back from the desktop.
  describe('a reload', () => {
    it('never restores "playing", so nothing reads it as sync switching on mid-playback', () => {
      const restored = restorePersistedPlayerState(
        { playbackState: 'playing', playbackSyncMode: 'on', currentIndex: 3 },
        { playbackState: 'stopped', syncPlaybackAcrossDevices: false, currentIndex: null },
      );
      expect(restored).toMatchObject({ playbackState: 'paused', syncPlaybackAcrossDevices: true, currentIndex: 3 });
      expect(restorePersistedPlayerState({ playbackState: 'paused' }, { playbackState: 'stopped' }).playbackState).toBe('paused');
    });
  });
});


describe('casting to a receiver that plays the session itself (Phase 5, PR E)', () => {
  const entry = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tracks = (...ns: number[]): TrackInfo[] => ns.map((n) => ({ id: `t${n}`, path: `/t${n}.mp3`, title: `T${n}`, queueEntryId: entry(n) }));
  let follows = true;
  beforeEach(() => {
    follows = true;
    jest.spyOn(castManager, 'receiverFollowsSession').mockImplementation(() => follows);
    jest.spyOn(castManager, 'getCastDeviceName').mockReturnValue('NAD Forstærker');
    jest.spyOn(sessionMirror, 'currentGrant').mockReturnValue({ sessionId: 'session-1', outputId: 'receiver:cast-77', generation: 4 });
    (startOnFollowingReceiver as jest.Mock).mockClear().mockResolvedValue('sent');
    // Earlier tests stub playAtIndex; these need the real one.
    const { playAtIndex, adoptSessionQueueAsOutput } = usePlayerStore.getInitialState();
    usePlayerStore.setState({ playAtIndex, adoptSessionQueueAsOutput, playlist: tracks(1, 2, 3), currentIndex: 0, playbackState: 'playing', isBuffering: false, addToast: jest.fn() } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('starts a track with a load command to the receiver, never a Cast load', async () => {
    const ensure = jest.spyOn(castManager, 'ensureQueuePlayback');
    await usePlayerStore.getState().playAtIndex(2);
    expect(startOnFollowingReceiver).toHaveBeenCalledWith(entry(3), expect.objectContaining({
      grant: { sessionId: 'session-1', outputId: 'receiver:cast-77', generation: 4 },
    }));
    expect(ensure).not.toHaveBeenCalled();
    expect(usePlayerStore.getState()).toMatchObject({ currentIndex: 2, isBuffering: false });
    expect(usePlayerStore.getState().addToast).not.toHaveBeenCalled();
  });

  it('says so when the receiver cannot be reached', async () => {
    (startOnFollowingReceiver as jest.Mock).mockResolvedValueOnce('unreachable');
    await usePlayerStore.getState().playAtIndex(1);
    expect(usePlayerStore.getState().addToast).toHaveBeenCalledWith("NAD Forstærker isn't reachable.", 'error');
  });

  it("shows the session's queue, keeping the entry that plays", () => {
    usePlayerStore.getState().adoptSessionQueueAsOutput(tracks(9, 1, 2, 3), entry(9));
    expect(usePlayerStore.getState().playlist.map((t) => t.id)).toEqual(['t9', 't1', 't2', 't3']);
    expect(usePlayerStore.getState().currentIndex).toBe(1);
    expect(usePlayerStore.getState().playbackState).toBe('playing');
  });

  it("falls back to the session's current entry when the playing one is gone", () => {
    usePlayerStore.getState().adoptSessionQueueAsOutput(tracks(7, 8), entry(8));
    expect(usePlayerStore.getState().currentIndex).toBe(1);
  });

  it('leaves Infinity to the server while the receiver follows the session (Phase 4)', async () => {
    const recommend = jest.spyOn(auroraApi, 'fetchNextRecommendation').mockResolvedValue(null);
    const { ensureInfinityQueue, fetchNextInfinityTrack } = usePlayerStore.getInitialState();
    usePlayerStore.setState({ ensureInfinityQueue, fetchNextInfinityTrack, isInfinityMode: true, isFetchingInfinity: false, currentIndex: 2 } as never);
    await usePlayerStore.getState().ensureInfinityQueue();
    await usePlayerStore.getState().fetchNextInfinityTrack(true);
    expect(recommend).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().playlist.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('without a following receiver, waits for the load when another device replaced the queue', () => {
    follows = false;
    usePlayerStore.getState().adoptSessionQueueAsOutput(tracks(7, 8), entry(8));
    expect(usePlayerStore.getState().playlist.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });
});

describe("playing here, the session's queue counts (Phase 3)", () => {
  const entry = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tracks = (...ns: number[]): TrackInfo[] => ns.map((n) => ({ id: `t${n}`, path: `/t${n}.mp3`, title: `T${n}`, queueEntryId: entry(n) }));
  beforeEach(() => {
    jest.spyOn(castManager, 'receiverFollowsSession').mockReturnValue(false);
    const { adoptSessionQueueAsOutput } = usePlayerStore.getInitialState();
    usePlayerStore.setState({ adoptSessionQueueAsOutput, playlist: tracks(1, 2, 3), currentIndex: 1, playbackState: 'playing' } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it("takes in another device's edit around the track that plays, which plays on", () => {
    const reconcile = jest.spyOn(castManager, 'reconcileQueueEdits');
    jest.spyOn(castManager, 'isConnected').mockReturnValue(false);
    usePlayerStore.getState().adoptSessionQueueAsOutput(tracks(1, 2, 9, 3), entry(2));
    expect(usePlayerStore.getState().playlist.map((t) => t.id)).toEqual(['t1', 't2', 't9', 't3']);
    expect(usePlayerStore.getState()).toMatchObject({ currentIndex: 1, playbackState: 'playing' });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('keeps the Infinity look of its picks, and hands the edit to a Cast window it manages', () => {
    usePlayerStore.setState({ playlist: [...tracks(1, 2), { ...tracks(3)[0], isInfinity: true }] });
    jest.spyOn(castManager, 'isConnected').mockReturnValue(true);
    const reconcile = jest.spyOn(castManager, 'reconcileQueueEdits').mockImplementation(() => undefined);
    usePlayerStore.getState().adoptSessionQueueAsOutput(tracks(2, 3, 4), entry(2));
    expect(usePlayerStore.getState().playlist.map((t) => [t.id, !!t.isInfinity])).toEqual([['t2', false], ['t3', true], ['t4', false]]);
    expect(usePlayerStore.getState().currentIndex).toBe(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

describe('Infinity on the session this device plays (Phase 4, every output)', () => {
  const entry = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tracks = (...ns: number[]): TrackInfo[] => ns.map((n) => ({ id: `t${n}`, path: `/t${n}.mp3`, queueEntryId: entry(n) }));
  afterEach(() => jest.restoreAllMocks());

  const prepare = (sync: boolean, holds: boolean) => {
    jest.spyOn(castManager, 'receiverFollowsSession').mockReturnValue(false);
    jest.spyOn(sessionMirror, 'holdsOutput').mockReturnValue(holds);
    const recommend = jest.spyOn(auroraApi, 'fetchNextRecommendation').mockResolvedValue(null);
    const { ensureInfinityQueue, fetchNextInfinityTrack } = usePlayerStore.getInitialState();
    usePlayerStore.setState({
      ensureInfinityQueue, fetchNextInfinityTrack, isInfinityMode: true, isFetchingInfinity: false,
      syncPlaybackAcrossDevices: sync, playlist: tracks(1, 2), currentIndex: 1, stop: jest.fn(),
    } as never);
    return recommend;
  };

  it('leaves it to the server while this device holds the output, with sync on', async () => {
    const recommend = prepare(true, true);
    await usePlayerStore.getState().ensureInfinityQueue();
    expect(recommend).not.toHaveBeenCalled();
  });

  it('keeps choosing here with sync off, or before this device holds the output', async () => {
    const off = prepare(false, true);
    await usePlayerStore.getState().ensureInfinityQueue();
    expect(off).toHaveBeenCalled();
    jest.restoreAllMocks();
    const notYet = prepare(true, false);
    await usePlayerStore.getState().ensureInfinityQueue();
    expect(notYet).toHaveBeenCalled();
  });
});

describe('plays and scrobbles counted here or by the server', () => {
  afterEach(() => jest.restoreAllMocks());

  // Drives the store's onTimeUpdate the way playback does.
  const listenUntil = (seconds: number) => (playbackManager as unknown as { onTimeUpdateCallback: (t: number) => void }).onTimeUpdateCallback(seconds);
  const prepare = (sync: boolean, holds: boolean) => {
    jest.spyOn(castManager, 'receiverFollowsSession').mockReturnValue(false);
    jest.spyOn(sessionMirror, 'holdsOutput').mockReturnValue(holds);
    const fetchMock = jest.fn(async (_url: string, _init?: { body: string }) => ({ ok: true }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
    const recordPlay = jest.fn();
    setPlaybackTimeState({ currentTime: 0, duration: 200 });
    usePlayerStore.setState({
      syncPlaybackAcrossDevices: sync, recordPlay,
      playlist: [{ id: 't1', path: '/t1.mp3', title: 'One', artist: 'A' }], currentIndex: 0,
      _scrobbleStartAt: 1_000_000, _scrobbleEligible: false, playedThresholdPercent: 50,
      lastFmConnected: true, lastFmScrobbleEnabled: true, listenBrainzConnected: false, listenBrainzScrobbleEnabled: false,
    } as never);
    const scrobbles = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/scrobble'));
    return { recordPlay, scrobbles };
  };

  it('with sync off, scrobbles the moment the track counts as played, not only when it ends by itself', () => {
    // Prod 2026-10-18: nothing was scrobbled after Next, or while casting.
    const { recordPlay, scrobbles } = prepare(false, false);
    listenUntil(90);
    expect(scrobbles()).toHaveLength(0);
    listenUntil(101);
    expect(recordPlay).toHaveBeenCalledWith('t1');
    expect(scrobbles()).toHaveLength(1);
    expect(JSON.parse(scrobbles()[0][1]!.body).tracks[0]).toMatchObject({ artist: 'A', track: 'One', timestamp: 1000 });
    listenUntil(150);
    expect(scrobbles()).toHaveLength(1);
  });

  it('leaves plays and scrobbles to the server while this device plays the session', () => {
    const { recordPlay, scrobbles } = prepare(true, true);
    listenUntil(150);
    expect(recordPlay).not.toHaveBeenCalled();
    expect(scrobbles()).toHaveLength(0);
    expect(usePlayerStore.getState()._scrobbleEligible).toBe(true); // a later Next is still no skip
  });
});
