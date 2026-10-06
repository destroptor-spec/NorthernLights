import { decideSeek, reconcileDuration } from '../castWatchdogPolicy';

/**
 * Prod 2026-10-06 11:45, two skips in ten seconds on "Fuck Her Gently" (123s):
 *
 *   11:45:03  receiver jumps time=3 -> 123, track ends, "Rain" starts
 *   11:45:06  Queue load requested startIndex=7   (back to Fuck Her Gently)
 *   11:45:07  sender hydration duration=206.223823   <- Rain's length
 *   11:45:12  Cast seek via media session time=144.1
 *   11:45:12  receiver IDLE -> "Rain" again
 *
 * After the reload RemotePlayer still described the previous item, so the bar
 * was drawn against 206s. 144.1 of 206 is ~70%; 70% of the real track is ~86s.
 */
describe('decideSeek', () => {
  const incident = {
    receiverDuration: 123,
    receiverIsCurrentTrack: true,
    receiverOnDifferentTrack: false,
    catalogDuration: 123.45,
  };

  it('refuses the seek that skipped the track', () => {
    expect(decideSeek({ ...incident, target: 144.1 })).toEqual({
      action: 'refuse', reason: 'beyond-end', trackDuration: 123,
    });
  });

  it('allows an ordinary seek inside the track', () => {
    expect(decideSeek({ ...incident, target: 86 })).toEqual({ action: 'seek', time: 86 });
  });

  it('refuses a target that would land on the last second', () => {
    // Exactly at the end finishes the track just as surely as past it.
    expect(decideSeek({ ...incident, target: 123 }).action).toBe('refuse');
    expect(decideSeek({ ...incident, target: 122.5 }).action).toBe('refuse');
  });

  it('is exact at the end margin', () => {
    expect(decideSeek({ ...incident, target: 122 })).toEqual({ action: 'seek', time: 122 });
    expect(decideSeek({ ...incident, target: 122.001 }).action).toBe('refuse');
  });

  it('falls back to the catalogue when no receiver status vouches for the track', () => {
    // The first skip, at 11:45:03, went through the controller path; there was
    // no guarantee of a fresh status. The catalogue still knows the track is
    // 123.45s long.
    expect(decideSeek({
      target: 144.1, receiverIsCurrentTrack: false, receiverOnDifferentTrack: false, catalogDuration: 123.45,
    })).toEqual({ action: 'refuse', reason: 'beyond-end', trackDuration: 123.45 });
  });

  it('prefers the receiver over the catalogue when both are known', () => {
    // A catalogue length can be off for an odd file; the receiver decoded it.
    expect(decideSeek({ ...incident, catalogDuration: 300, target: 150 }).action).toBe('refuse');
  });

  it('ignores a receiver duration for a track that is not current', () => {
    expect(decideSeek({
      target: 150, receiverDuration: 123, receiverIsCurrentTrack: false,
      receiverOnDifferentTrack: false, catalogDuration: 206.22,
    })).toEqual({ action: 'seek', time: 150 });
  });

  it('refuses any seek while the receiver plays a different track', () => {
    expect(decideSeek({
      target: 10, receiverDuration: 123, receiverIsCurrentTrack: false,
      receiverOnDifferentTrack: true, catalogDuration: 206.22,
    })).toMatchObject({ action: 'refuse', reason: 'track-mismatch' });
  });

  it('still seeks when nothing knows the length', () => {
    // No better information than before this guard existed: behave as before.
    expect(decideSeek({ target: 50, receiverIsCurrentTrack: false, receiverOnDifferentTrack: false }))
      .toEqual({ action: 'seek', time: 50 });
  });

  it('refuses nonsense targets', () => {
    for (const target of [NaN, -1, Infinity, undefined]) {
      expect(decideSeek({ ...incident, target })).toMatchObject({ action: 'refuse', reason: 'invalid-target' });
    }
  });

  it('allows a seek back to the start', () => {
    expect(decideSeek({ ...incident, target: 0 })).toEqual({ action: 'seek', time: 0 });
  });
});

describe('reconcileDuration', () => {
  it('replaces the stale duration from the incident', () => {
    expect(reconcileDuration({ candidate: 206.223823, receiverDuration: 123, receiverIsCurrentTrack: true }))
      .toBe(123);
  });

  it('keeps the incoming value when the two agree', () => {
    // RemotePlayer 123.58 against the receiver's 123: same track, and the
    // RemotePlayer figure is the more precise.
    expect(reconcileDuration({ candidate: 123.576592, receiverDuration: 123, receiverIsCurrentTrack: true }))
      .toBe(123.576592);
  });

  it('is exact at the tolerance', () => {
    expect(reconcileDuration({ candidate: 125, receiverDuration: 123, receiverIsCurrentTrack: true })).toBe(125);
    expect(reconcileDuration({ candidate: 125.001, receiverDuration: 123, receiverIsCurrentTrack: true })).toBe(123);
  });

  it('does not let a status for another track overrule', () => {
    // Just after a track change the last status can still describe the old
    // song; then the fresh RemotePlayer value is the better guess.
    expect(reconcileDuration({ candidate: 206.22, receiverDuration: 123, receiverIsCurrentTrack: false }))
      .toBe(206.22);
  });

  it('ignores a zero from a receiver that is still buffering', () => {
    // The receiver reports duration=0 while a track loads.
    expect(reconcileDuration({ candidate: 123.45, receiverDuration: 0, receiverIsCurrentTrack: true }))
      .toBe(123.45);
  });

  it('uses the receiver when the incoming value is unusable', () => {
    expect(reconcileDuration({ candidate: NaN, receiverDuration: 123, receiverIsCurrentTrack: true })).toBe(123);
    expect(reconcileDuration({ candidate: 0, receiverDuration: 0, receiverIsCurrentTrack: true })).toBeNull();
  });
});
