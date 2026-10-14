import { usePlayerStore } from '../index';
import { selectDisplayedPlaying } from '../../utils/sessionFollow';
import { sendRemoteAction } from '../../utils/sessionRemote';

jest.mock('../../utils/sessionRemote', () => ({ sendRemoteAction: jest.fn(async () => 'sent') }));
import { TrackInfo } from '../../utils/fileSystem';
import { hasNextTrack } from '../../utils/queue';
import { playbackManager } from '../../utils/PlaybackManager';
import { getPlaybackTimeSnapshot } from '../playbackTime';

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

    it('the device chip changes the choice without doing anything else', async () => {
      following();
      usePlayerStore.getState().openPlayWhere();
      await usePlayerStore.getState().resolvePlayWhere('remote');
      expect(usePlayerStore.getState().remoteControlOutputId).toBe('desktop');
      expect(sendRemoteAction).not.toHaveBeenCalled();
      expect(playAtIndex).not.toHaveBeenCalled();
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
});

