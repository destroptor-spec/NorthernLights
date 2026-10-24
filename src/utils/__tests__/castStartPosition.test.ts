import { castStartPosition, FOLLOW_AT_LAUNCH_MAX_AGE_MS } from '../castStartPosition';
import type { FollowedOutput } from '../sessionFollow';

/**
 * Prod 2026-10-22 13:47:17: the phone, idle and following Stue TV on "Fix
 * You" at 0:43, tapped Cast; a new Cast session ended the TV's and the phone
 * loaded "Fix You" at 0:00 (its own idle audio element).
 */
const follow = (overrides: Partial<FollowedOutput> = {}): FollowedOutput => ({
  sessionId: 's1', outputId: 'receiver:651ba6aa', name: 'Stue TV', kind: 'receiver', generation: 356,
  state: 'playing', entryId: 'fix-you', positionMs: 40_000, anchorMs: 1_000_000, ...overrides,
});

const base = { localSeconds: 0, localPlaying: false, entryId: 'fix-you', durationSeconds: 295, follow: null, atLaunch: null, now: 1_010_000 };

describe('castStartPosition', () => {
  it('starts where the followed output was when Cast was tapped, not at 0:00', () => {
    // Tapped 3 s after the report; the new session connects 9 s later.
    expect(castStartPosition({ ...base, follow: follow(), atLaunch: { follow: follow(), at: 1_003_000 }, now: 1_012_000 }))
      .toEqual({ seconds: 43, source: 'followed' });
  });

  it('reads the output as it is now when this device did not ask for the launch', () => {
    expect(castStartPosition({ ...base, follow: follow() })).toEqual({ seconds: 50, source: 'followed' });
  });

  it('keeps a paused output where it is', () => {
    expect(castStartPosition({ ...base, follow: follow({ state: 'paused', positionMs: 20_000 }) }))
      .toEqual({ seconds: 20, source: 'followed' });
  });

  it('uses its own position while it plays itself', () => {
    expect(castStartPosition({ ...base, localSeconds: 292.4, localPlaying: true, follow: follow() }))
      .toEqual({ seconds: 292.4, source: 'local' });
  });

  it('uses its own position for another track, a silent output, or no output', () => {
    expect(castStartPosition({ ...base, follow: follow({ entryId: 'paradise' }) }).source).toBe('local');
    expect(castStartPosition({ ...base, follow: follow({ silent: true }) }).source).toBe('local');
    expect(castStartPosition({ ...base }).source).toBe('local');
  });

  it('ignores a launch request from long ago', () => {
    const stale = { follow: follow({ positionMs: 5_000 }), at: base.now - FOLLOW_AT_LAUNCH_MAX_AGE_MS };
    expect(castStartPosition({ ...base, follow: follow(), atLaunch: stale })).toEqual({ seconds: 50, source: 'followed' });
  });

  it('never starts past the end of the track', () => {
    expect(castStartPosition({ ...base, follow: follow({ positionMs: 294_000 }), now: 1_060_000 }).seconds).toBe(295);
  });
});
