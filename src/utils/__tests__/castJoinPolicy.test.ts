import { decideJoin, JOIN_MEDIA_WAIT_MS } from '../castJoinPolicy';

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
});
