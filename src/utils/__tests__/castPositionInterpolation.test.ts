import {
  POSITION_EXTRAPOLATION_CAP_MS,
  interpolatePosition,
} from '../castWatchdogPolicy';

/**
 * Prod 2026-10-06, the session that verified #66. With the RemotePlayer stream
 * dead for two minutes the position was correct but arrived only every 5s:
 *
 *   08:56:47.029  pos=162.832  (+5.002 over 5.004s wall)
 *   08:56:52.031  pos=167.825  (+4.994 over 5.002s wall)
 *   08:56:57.023  pos=172.825  (+4.999 over 4.992s wall)
 *
 * 40 consecutive updates, every one tracking wall clock to within ~10ms, and
 * not a single backward step — so the choppiness was pure granularity, not two
 * sources disagreeing. This fills the gaps between those samples.
 */
describe('interpolatePosition', () => {
  const anchor = { anchorPosition: 162.832, anchorAtMs: 1_000_000, playing: true, duration: 229.787 };

  it('fills the gap between two receiver updates', () => {
    // 2.5s after the 162.832 sample, halfway to the next one.
    expect(interpolatePosition({ ...anchor, nowMs: 1_002_500 })).toBeCloseTo(165.332, 6);
  });

  it('lands on the next real value just as it arrives', () => {
    // At +5s the interpolated value should agree with the 167.825 that the
    // receiver actually reported, to within the measured drift.
    const interpolated = interpolatePosition({ ...anchor, nowMs: 1_005_002 });
    expect(Math.abs(interpolated - 167.825)).toBeLessThan(0.02);
  });

  it('freezes when the receiver is not playing', () => {
    // A pause from the TV remote: hold position rather than inventing motion.
    expect(interpolatePosition({ ...anchor, playing: false, nowMs: 1_009_000 })).toBe(162.832);
  });

  it('stops after the extrapolation cap rather than running away', () => {
    // Updates stopped entirely. Coasting to the end of the track would be
    // confidently wrong; stopping is visibly stuck, which is honest.
    const far = interpolatePosition({ ...anchor, nowMs: 1_000_000 + 60_000 });
    expect(far).toBeCloseTo(162.832 + POSITION_EXTRAPOLATION_CAP_MS / 1000, 6);
  });

  it('is exact at the cap boundary', () => {
    const at = interpolatePosition({ ...anchor, nowMs: 1_000_000 + POSITION_EXTRAPOLATION_CAP_MS });
    const past = interpolatePosition({ ...anchor, nowMs: 1_000_000 + POSITION_EXTRAPOLATION_CAP_MS + 5_000 });
    expect(at).toBeCloseTo(past, 6);
  });

  it('never overruns the track length', () => {
    expect(interpolatePosition({
      anchorPosition: 228.0, anchorAtMs: 1_000_000, nowMs: 1_006_000, playing: true, duration: 229.787,
    })).toBe(229.787);
  });

  it('advances without a known duration', () => {
    expect(interpolatePosition({
      anchorPosition: 10, anchorAtMs: 1_000_000, nowMs: 1_003_000, playing: true, duration: null,
    })).toBeCloseTo(13, 6);
  });

  it('never moves backwards', () => {
    // Clock skew, or a tick that races the anchor it was computed from.
    expect(interpolatePosition({ ...anchor, nowMs: 999_000 })).toBe(162.832);
    expect(interpolatePosition({ ...anchor, nowMs: 1_000_000 })).toBe(162.832);
  });

  it('refuses to invent a position from an unusable anchor', () => {
    for (const bad of [NaN, Infinity, -1, undefined as unknown as number]) {
      expect(interpolatePosition({
        anchorPosition: bad, anchorAtMs: 1_000_000, nowMs: 1_003_000, playing: true,
      })).toBe(0);
    }
  });

  it('keeps a real zero at track start', () => {
    expect(interpolatePosition({
      anchorPosition: 0, anchorAtMs: 1_000_000, nowMs: 1_002_000, playing: true, duration: 229.787,
    })).toBeCloseTo(2, 6);
  });

  it('does not compound when re-run from the same anchor', () => {
    // The ticker must never re-anchor on its own output. Repeated calls from
    // one anchor stay a pure function of elapsed time.
    const a = interpolatePosition({ ...anchor, nowMs: 1_001_000 });
    const b = interpolatePosition({ ...anchor, nowMs: 1_002_000 });
    const c = interpolatePosition({ ...anchor, nowMs: 1_003_000 });
    expect(b - a).toBeCloseTo(1, 6);
    expect(c - b).toBeCloseTo(1, 6);
  });
});
