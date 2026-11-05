import { decideJoin, decideTakeoverJoin, isOwnLeaveDisconnect, JOIN_DEAF_AFTER_MS, JOIN_MEDIA_WAIT_MS, OWN_LEAVE_QUIET_MS, TAKEOVER_DEAF_GUESS_MS } from '../castJoinPolicy';

/**
 * Prod 2026-10-13 19:53:48: the desktop's Cast dialog joined the NAD, paused
 * on "Slidin'" from the phone. 250 ms later the SDK had no media yet (it came
 * at 19:53:49.926), so the desktop loaded its own queue over it.
 */
describe('decideJoin', () => {
  it('takes on media the SDK already sees', () => {
    expect(decideJoin({ sdkHasMedia: true, receiverStatus: null, elapsedMs: 0 })).toBe('adopt');
  });

  it('waits for evidence instead of deciding at once', () => {
    expect(decideJoin({ sdkHasMedia: false, receiverStatus: null, elapsedMs: 250 })).toBe('wait');
    // The 19:53:48 join: media status came after 1,024 ms.
    expect(decideJoin({ sdkHasMedia: true, receiverStatus: null, elapsedMs: 1024 })).toBe('adopt');
  });

  it('goes ahead at once when our receiver says nothing is playing', () => {
    expect(decideJoin({ sdkHasMedia: false, receiverStatus: { queueEntryId: null, playerState: 'IDLE' }, elapsedMs: 100 })).toBe('fresh');
    // A finished queue: loading over it interrupts nothing.
    expect(decideJoin({ sdkHasMedia: false, receiverStatus: { queueEntryId: 'e1', playerState: 'IDLE' }, elapsedMs: 100 })).toBe('fresh');
  });

  it('never loads over a receiver that says it plays, even if the SDK stays blind', () => {
    const playing = { queueEntryId: 'e1', playerState: 'PAUSED' };
    expect(decideJoin({ sdkHasMedia: false, receiverStatus: playing, elapsedMs: 500 })).toBe('wait');
    expect(decideJoin({ sdkHasMedia: false, receiverStatus: playing, elapsedMs: JOIN_MEDIA_WAIT_MS })).toBe('hold');
  });

  it('treats a receiver that stays silent for the whole wait as fresh, as before', () => {
    expect(decideJoin({ sdkHasMedia: false, receiverStatus: null, elapsedMs: JOIN_MEDIA_WAIT_MS - 1 })).toBe('wait');
    expect(decideJoin({ sdkHasMedia: false, receiverStatus: null, elapsedMs: JOIN_MEDIA_WAIT_MS })).toBe('fresh');
  });

  it('goes ahead after the wait when the receiver answered the ping but has nothing to report', () => {
    expect(decideJoin({ sdkHasMedia: false, receiverStatus: null, heardFromReceiver: true, elapsedMs: JOIN_MEDIA_WAIT_MS })).toBe('fresh');
  });

  /**
   * Prod 2026-10-27 12:33: the desktop joined the NAD's idle receiver app,
   * heard nothing back (no ack, no status, no media status), loaded, and
   * loaded again 15 s later over its own track.
   */
  it('calls a session that never answers deaf, after waiting longer for a slow receiver', () => {
    expect(decideJoin({ sdkHasMedia: false, receiverStatus: null, heardFromReceiver: false, elapsedMs: JOIN_MEDIA_WAIT_MS })).toBe('wait');
    expect(decideJoin({ sdkHasMedia: false, receiverStatus: null, heardFromReceiver: false, elapsedMs: JOIN_DEAF_AFTER_MS - 1 })).toBe('wait');
    expect(decideJoin({ sdkHasMedia: false, receiverStatus: null, heardFromReceiver: false, elapsedMs: JOIN_DEAF_AFTER_MS })).toBe('deaf');
    // Media the SDK sees is an answer too.
    expect(decideJoin({ sdkHasMedia: true, receiverStatus: null, heardFromReceiver: false, elapsedMs: JOIN_DEAF_AFTER_MS })).toBe('adopt');
  });
});

describe('isOwnLeaveDisconnect', () => {
  it('treats the disconnect right after leaving on purpose as that leave', () => {
    expect(isOwnLeaveDisconnect(1_000, 1_400)).toBe(true);
    expect(isOwnLeaveDisconnect(1_000, 1_000 + OWN_LEAVE_QUIET_MS - 1)).toBe(true);
  });

  it('still reports a real disconnect', () => {
    expect(isOwnLeaveDisconnect(0, 5_000)).toBe(false);
    expect(isOwnLeaveDisconnect(1_000, 1_000 + OWN_LEAVE_QUIET_MS)).toBe(false);
  });
});


/**
 * docs/cast-takeover.md, PR 4 (Andreas, 2026-11-02): picking a Cast device
 * that plays someone else's cast replaces it, like casting over any other app.
 */
describe('decideTakeoverJoin', () => {
  const base = { sdkHasMedia: false, heardFromReceiver: true, myClientId: 'web:desktop-b', isOwnDevice: () => false, elapsedMs: 300 };

  it("takes over another device's cast, or a receiver that names nobody (idle, or an older sender)", () => {
    expect(decideTakeoverJoin({ ...base, sdkHasMedia: true, receiverStatus: { castingClientId: 'web:phone-a' } })).toBe('takeover');
    expect(decideTakeoverJoin({ ...base, receiverStatus: { castingClientId: null } })).toBe('takeover');
  });

  it('takes on its own cast, and leaves another of my own devices to become its remote', () => {
    expect(decideTakeoverJoin({ ...base, sdkHasMedia: true, receiverStatus: { castingClientId: 'web:desktop-b' } })).toBe('adopt');
    expect(decideTakeoverJoin({ ...base, receiverStatus: { castingClientId: 'web:desktop-b' } })).toBe('wait');
    expect(decideTakeoverJoin({ ...base, receiverStatus: { castingClientId: 'web:desktop-b' }, elapsedMs: JOIN_MEDIA_WAIT_MS })).toBe('adopt');
    expect(decideTakeoverJoin({ ...base, receiverStatus: { castingClientId: 'web:phone-a' }, isOwnDevice: (id) => id === 'web:phone-a' })).toBe('leave-own');
  });

  it('waits for the status a receiver that answered will send, then takes over', () => {
    expect(decideTakeoverJoin({ ...base, receiverStatus: null })).toBe('wait');
    expect(decideTakeoverJoin({ ...base, receiverStatus: null, elapsedMs: JOIN_MEDIA_WAIT_MS })).toBe('takeover');
  });

  it('calls a join that hears nothing deaf after a while, to load anyway and hear the relay', () => {
    const deaf = { ...base, heardFromReceiver: false, receiverStatus: null };
    expect(decideTakeoverJoin({ ...deaf, elapsedMs: JOIN_MEDIA_WAIT_MS })).toBe('wait');
    expect(decideTakeoverJoin({ ...deaf, elapsedMs: TAKEOVER_DEAF_GUESS_MS })).toBe('deaf');
  });

  it("a status heard only through the relay (another of the same account's devices loaded last) is no proof this connection hears: deaf after the same wait (prod 2026-11-05 22:13, T7)", () => {
    const relayed = { ...base, heardDirectly: false, receiverStatus: { castingClientId: 'web:phone-a' } };
    expect(decideTakeoverJoin({ ...relayed, elapsedMs: 280 })).toBe('wait');
    expect(decideTakeoverJoin({ ...relayed, elapsedMs: TAKEOVER_DEAF_GUESS_MS })).toBe('deaf');
    // Heard on the connection too: a plain takeover at once.
    expect(decideTakeoverJoin({ ...relayed, heardDirectly: true, elapsedMs: 280 })).toBe('takeover');
    // Whose cast it is still counts at once: another of my own devices, or my own.
    expect(decideTakeoverJoin({ ...relayed, isOwnDevice: (id) => id === 'web:phone-a' })).toBe('leave-own');
    expect(decideTakeoverJoin({ ...relayed, receiverStatus: { castingClientId: 'web:desktop-b' }, elapsedMs: JOIN_MEDIA_WAIT_MS })).toBe('adopt');
    // Nothing named, only relayed: not taken as heard either.
    expect(decideTakeoverJoin({ ...base, heardDirectly: false, receiverStatus: null, elapsedMs: TAKEOVER_DEAF_GUESS_MS })).toBe('deaf');
  });
});
