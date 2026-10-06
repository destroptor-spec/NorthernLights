import {
  chooseTransportAction,
  pickRemotePosition,
  receiverControlAvailable,
  transportStateFromPlayerState,
} from '../castWatchdogPolicy';

/**
 * Prod 2026-10-06 11:45: seven play/pause presses in nine seconds, every one
 * `Cast pause cannot reach the receiver :: mediaSession=none`, while the
 * receiver played on and kept sending aurora-status every 5s. The SDK's media
 * session was gone for ~18s and only came back when a new track loaded. The
 * aurora namespace stayed up the whole time, so that is the path to use.
 */
describe('receiverControlAvailable', () => {
  const fresh = { statusAgeMs: 2_000, freshMs: 20_000 };

  it('uses the channel when a fresh status advertises it', () => {
    expect(receiverControlAvailable({ ...fresh, caps: ['control'] })).toBe(true);
  });

  it('does not use it with a receiver that predates it', () => {
    // An old receiver still accepts messages on the registered namespace but
    // nothing listens: the command would vanish silently.
    expect(receiverControlAvailable({ ...fresh, caps: undefined })).toBe(false);
    expect(receiverControlAvailable({ ...fresh, caps: [] })).toBe(false);
    expect(receiverControlAvailable({ ...fresh, caps: ['something-else'] })).toBe(false);
  });

  it('does not trust a capability from a stale status', () => {
    expect(receiverControlAvailable({ caps: ['control'], statusAgeMs: 20_000, freshMs: 20_000 })).toBe(false);
    expect(receiverControlAvailable({ caps: ['control'], statusAgeMs: 19_999, freshMs: 20_000 })).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(receiverControlAvailable({ caps: 'control', ...fresh })).toBe(false);
    expect(receiverControlAvailable({ caps: ['control'], statusAgeMs: -5, freshMs: 20_000 })).toBe(false);
    expect(receiverControlAvailable({ caps: ['control'], statusAgeMs: NaN, freshMs: 20_000 })).toBe(false);
  });
});

describe('transportStateFromPlayerState', () => {
  it('maps receiver states for a transport decision', () => {
    expect(transportStateFromPlayerState('PLAYING')).toBe('playing');
    expect(transportStateFromPlayerState('BUFFERING')).toBe('playing');
    expect(transportStateFromPlayerState('PAUSED')).toBe('paused');
    expect(transportStateFromPlayerState('IDLE')).toBe('stopped');
    expect(transportStateFromPlayerState(undefined)).toBe('stopped');
  });

  it('drives a toggle from the receiver state', () => {
    expect(chooseTransportAction('toggle', transportStateFromPlayerState('PLAYING'))).toBe('pause');
    expect(chooseTransportAction('toggle', transportStateFromPlayerState('PAUSED'))).toBe('play');
  });
});

/**
 * Prod 2026-10-06 12:03:54. No SDK media session, so the watchdog hydrated
 * from a session synthesised out of the dead RemotePlayer, and #66 read it as
 * receiver data:
 *
 *   sender:   watchdog-remote-player time=0 duration=206.223823
 *             source=media-session playerSilentMs=167684
 *   receiver: Wherever I Go time=166 duration=384
 */
describe('pickRemotePosition with a synthetic session', () => {
  const incident = {
    playerTime: 0,
    playerDuration: 206.223823,
    sessionTime: 0,
    sessionDuration: 206.223823,
    fallbackDuration: 206.223823,
    sessionIsSynthetic: true,
    msSinceRemotePlayerEvent: 167_684,
  };

  it('publishes nothing rather than the dead player under another name', () => {
    expect(pickRemotePosition(incident)).toEqual({ currentTime: null, duration: null, source: 'none' });
  });

  it('still trusts a real media session in the same silence', () => {
    // The 08:55 verification case: getStatus succeeded, so the session is the
    // receiver's answer.
    expect(pickRemotePosition({ ...incident, sessionIsSynthetic: false, sessionTime: 166, sessionDuration: 384 }))
      .toEqual({ currentTime: 166, duration: 384, source: 'media-session' });
  });

  it('leaves a synthetic session alone while the player is alive', () => {
    // A live RemotePlayer is preferred anyway; the synthetic flag only matters
    // once it has gone quiet.
    expect(pickRemotePosition({ ...incident, playerTime: 12, playerDuration: 384, msSinceRemotePlayerEvent: 200 }))
      .toEqual({ currentTime: 12, duration: 384, source: 'remote-player' });
  });
});
