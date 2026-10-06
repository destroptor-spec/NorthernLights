import {
  REMOTE_PLAYER_STALE_MS,
  chooseTransportAction,
  isRemotePlayerStreamStale,
  pickRemotePosition,
} from '../castWatchdogPolicy';

/**
 * Regression guard for prod 2026-09-02 21:56-21:57.
 *
 * The receiver played "Tell Your Friends" (334s) from 172s to 230s while the
 * sender's RemotePlayer event stream had been silent for 174s and then 204s.
 * The watchdog pulled a fresh media status every 5s and succeeded every time,
 * then published the RemotePlayer's frozen snapshot instead of the answer it
 * had just received:
 *
 *   receiver: title=Tell Your Friends time=205 duration=334
 *   sender:   trackSynced=true playerState=PLAYING time=0 duration=240.716624
 *
 * The 240.7 duration belonged to a different track — the one playing when the
 * stream died — which is what proved the snapshot frozen rather than merely
 * lagging.
 */
describe('pickRemotePosition', () => {
  // The numbers straight out of the incident log.
  const incident = {
    playerTime: 0,
    playerDuration: 240.716624,
    sessionTime: 205,
    sessionDuration: 334,
  };

  it('takes the receiver position once the RemotePlayer stream is dead', () => {
    expect(pickRemotePosition({ ...incident, msSinceRemotePlayerEvent: 204_695 })).toEqual({
      currentTime: 205,
      duration: 334,
      source: 'media-session',
    });
  });

  it('reproduces the old preference when the stream is healthy', () => {
    // Same inputs, live stream: the RemotePlayer wins. This is the branch the
    // old unconditional code took in every state, which is why a frozen
    // currentTime=0 reached the progress bar. The staleness signal is the only
    // thing that changes the outcome.
    expect(pickRemotePosition({ ...incident, msSinceRemotePlayerEvent: 0 })).toEqual({
      currentTime: 0,
      duration: 240.716624,
      source: 'remote-player',
    });
  });

  it('never mixes a stale duration into a receiver position', () => {
    // The specific corruption: 205s of a 240.7s track would put the bar at 85%
    // of the wrong song. Duration has to travel with the position it describes.
    const choice = pickRemotePosition({ ...incident, msSinceRemotePlayerEvent: 60_000 });
    expect(choice.duration).toBe(334);
    expect(choice.duration).not.toBe(incident.playerDuration);
  });

  it('reports nothing to apply when a dead stream is all there is', () => {
    // No usable status: publishing the frozen 0 is the bug, so publish nothing
    // and leave whatever the aurora-status channel last set in place.
    expect(pickRemotePosition({
      playerTime: 0,
      playerDuration: 240.716624,
      msSinceRemotePlayerEvent: 204_695,
    })).toEqual({ currentTime: null, duration: null, source: 'none' });
  });

  it('keeps a legitimate zero from a live stream', () => {
    // Track start. A real 0 must survive, so the fix cannot just treat 0 as
    // missing.
    expect(pickRemotePosition({
      playerTime: 0,
      playerDuration: 334,
      sessionTime: 0,
      sessionDuration: 334,
      msSinceRemotePlayerEvent: 250,
    })).toEqual({ currentTime: 0, duration: 334, source: 'remote-player' });
  });

  it('falls back to the receiver when a live stream has no position yet', () => {
    expect(pickRemotePosition({
      playerTime: undefined,
      sessionTime: 12,
      sessionDuration: 334,
      msSinceRemotePlayerEvent: 0,
    })).toEqual({ currentTime: 12, duration: 334, source: 'media-session' });
  });

  it('uses metadata duration only when nothing better exists', () => {
    const choice = pickRemotePosition({
      sessionTime: 12,
      fallbackDuration: 334,
      msSinceRemotePlayerEvent: 204_695,
    });
    expect(choice).toEqual({ currentTime: 12, duration: 334, source: 'media-session' });
  });

  it('rejects unusable numbers from either side', () => {
    expect(pickRemotePosition({
      playerTime: NaN,
      playerDuration: 0,
      sessionTime: -1,
      sessionDuration: Infinity,
      msSinceRemotePlayerEvent: 0,
    })).toEqual({ currentTime: null, duration: null, source: 'none' });
  });

  it('is exact at the staleness boundary', () => {
    const at = pickRemotePosition({ ...incident, msSinceRemotePlayerEvent: REMOTE_PLAYER_STALE_MS });
    const past = pickRemotePosition({ ...incident, msSinceRemotePlayerEvent: REMOTE_PLAYER_STALE_MS + 1 });
    expect(at.source).toBe('remote-player');
    expect(past.source).toBe('media-session');
  });
});

describe('isRemotePlayerStreamStale', () => {
  it('tolerates a single missed one-second tick', () => {
    expect(isRemotePlayerStreamStale(1_000)).toBe(false);
    expect(isRemotePlayerStreamStale(2_999)).toBe(false);
  });

  it('flags the multi-minute silence seen in prod', () => {
    expect(isRemotePlayerStreamStale(174_695)).toBe(true);
    expect(isRemotePlayerStreamStale(204_695)).toBe(true);
  });

  it('is exact at the boundary', () => {
    expect(isRemotePlayerStreamStale(3_000)).toBe(false);
    expect(isRemotePlayerStreamStale(3_001)).toBe(true);
  });
});

describe('chooseTransportAction', () => {
  it('toggles from the receiver state, not a frozen local flag', () => {
    expect(chooseTransportAction('toggle', 'playing')).toBe('pause');
    expect(chooseTransportAction('toggle', 'paused')).toBe('play');
  });

  it('never reports a toggle as satisfied', () => {
    // The user asked for a change; answering "already there" would swallow the
    // press, which is the symptom being fixed.
    for (const state of ['playing', 'paused', 'stopped'] as const) {
      expect(chooseTransportAction('toggle', state)).not.toBe('satisfied');
    }
  });

  it('reads a toggle on a stopped receiver as play', () => {
    expect(chooseTransportAction('toggle', 'stopped')).toBe('play');
  });

  it('skips commands the receiver has already applied', () => {
    expect(chooseTransportAction('pause', 'paused')).toBe('satisfied');
    expect(chooseTransportAction('play', 'playing')).toBe('satisfied');
  });

  it('acts on explicit intents that would change something', () => {
    expect(chooseTransportAction('pause', 'playing')).toBe('pause');
    expect(chooseTransportAction('play', 'paused')).toBe('play');
    expect(chooseTransportAction('play', 'stopped')).toBe('play');
  });

  it('does not try to pause a stopped receiver', () => {
    expect(chooseTransportAction('pause', 'stopped')).toBe('satisfied');
  });
});
