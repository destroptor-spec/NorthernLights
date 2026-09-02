import {
  enumerateCompletedWrappedPeriods,
  wrappedSeasonRange,
  wrappedYm,
  wrappedYmToLocalMs,
} from './wrappedPeriods';

// Period bounds are calendar months in the deployment's own timezone, and the
// bug these tests were written for — a completed period staying invisible for a
// whole extra month — only reproduces east of UTC; at or west of UTC the old
// UTC-parsed comparison happened to give the right answer. Every assertion
// below is built from LOCAL date components, so the suite is correct in
// whatever zone it runs, and fails on the old comparison in any zone east of
// UTC (production is UTC+1/+2).
//
// Reassigning process.env.TZ mid-test does nothing: jest runs tests in a vm
// context that never gets the timezone-change notification. The zone has to be
// set on the jest process itself, which is what `npm run test:tz` does.

const suffixes = (now: Date, earliest: Date) =>
  enumerateCompletedWrappedPeriods(now, earliest).map((p) => p.suffix);

// First plays well before any period under test, so only the completeness rule
// decides what comes back.
const EARLIEST = () => new Date(2024, 0, 15);

describe('wrappedYmToLocalMs', () => {
  test('parses a period bound as local midnight', () => {
    expect(wrappedYmToLocalMs('2026-09-01')).toBe(new Date(2026, 8, 1).getTime());
    expect(wrappedYmToLocalMs('2026-12-01')).toBe(new Date(2026, 11, 1).getTime());
  });

  test('does NOT fall back to date-only UTC parsing', () => {
    if (new Date(2026, 8, 1).getTimezoneOffset() === 0) return; // identical under UTC
    expect(wrappedYmToLocalMs('2026-09-01')).not.toBe(Date.parse('2026-09-01'));
  });
});

describe('wrappedYm', () => {
  test('zero-pads the month', () => {
    expect(wrappedYm(2026, 6)).toBe('2026-06-01');
    expect(wrappedYm(2026, 12)).toBe('2026-12-01');
  });
});

describe('wrappedSeasonRange', () => {
  test('seasons are 3-month, end-exclusive windows', () => {
    expect(wrappedSeasonRange(2026, 'spring')).toEqual({ startYm: '2026-03-01', endYmExclusive: '2026-06-01' });
    expect(wrappedSeasonRange(2026, 'summer')).toEqual({ startYm: '2026-06-01', endYmExclusive: '2026-09-01' });
    expect(wrappedSeasonRange(2026, 'autumn')).toEqual({ startYm: '2026-09-01', endYmExclusive: '2026-12-01' });
  });

  test('winter belongs to the year it ends in, and spans the year boundary', () => {
    expect(wrappedSeasonRange(2026, 'winter')).toEqual({ startYm: '2025-12-01', endYmExclusive: '2026-03-01' });
  });
});

describe('enumerateCompletedWrappedPeriods', () => {
  // The regression: on 2 Sep 2026 summer (Jun–Aug) is over, so it must be
  // enumerated. The old comparison hid it until 1 Oct east of UTC.
  test('a season that ended last month is complete', () => {
    expect(suffixes(new Date(2026, 8, 2), EARLIEST())).toContain('2026_summer');
  });

  test('complete from the first local instant of the following month', () => {
    expect(suffixes(new Date(2026, 8, 1, 0, 0, 0), EARLIEST())).toContain('2026_summer');
  });

  // The upper bound of the same rule: a period must not freeze while its final
  // month is still being played into.
  test('not complete while its final month is still running', () => {
    expect(suffixes(new Date(2026, 7, 31, 23, 59, 59), EARLIEST())).not.toContain('2026_summer');
    expect(suffixes(new Date(2026, 7, 15), EARLIEST())).not.toContain('2026_summer');
  });

  test('in-progress periods are excluded', () => {
    const got = suffixes(new Date(2026, 8, 2), EARLIEST());
    expect(got).not.toContain('2026');        // year still running
    expect(got).not.toContain('2026_autumn'); // season still running
  });

  test('newest-first by period end, with a year recap leading its own seasons', () => {
    expect(suffixes(new Date(2026, 8, 2), EARLIEST()).slice(0, 6)).toEqual([
      '2026_summer', // ends Sep 2026
      '2026_spring', // ends Jun 2026
      '2026_winter', // ends Mar 2026
      '2025',        // ends Jan 2026 — after 2025's last season
      '2025_autumn', // ends Dec 2025
      '2025_summer', // ends Sep 2025
    ]);
  });

  test('periods ending at or before the first bucket month are excluded', () => {
    const got = suffixes(new Date(2026, 8, 2), new Date(2026, 5, 20)); // first plays June 2026
    expect(got).toEqual(['2026_summer']);
    expect(got).not.toContain('2026_spring'); // ends exactly at the earliest month
  });

  test('every completed period between the first bucket and now is enumerated once', () => {
    const got = suffixes(new Date(2026, 8, 2), EARLIEST());
    expect(new Set(got).size).toBe(got.length);
    expect(got).toEqual(expect.arrayContaining(['2024', '2025', '2025_winter', '2026_winter', '2026_summer']));
  });

  test('a season period carries the title, id suffix, window and cap the Hub relies on', () => {
    const summer = enumerateCompletedWrappedPeriods(new Date(2026, 8, 2), EARLIEST())
      .find((p) => p.suffix === '2026_summer');
    expect(summer).toMatchObject({
      isYear: false,
      suffix: '2026_summer',
      title: 'Summer 2026',        // AuroraCover parses this for the summer palette
      descLabel: 'summer of 2026',
      startYm: '2026-06-01',
      endYmExclusive: '2026-09-01',
      limit: 30,
    });
  });

  test('a year period covers Jan–Dec with the larger cap', () => {
    const year = enumerateCompletedWrappedPeriods(new Date(2026, 8, 2), EARLIEST())
      .find((p) => p.suffix === '2025');
    expect(year).toMatchObject({
      isYear: true,
      title: '2025 Wrapped',
      descLabel: '2025',
      startYm: '2025-01-01',
      endYmExclusive: '2026-01-01',
      limit: 50,
    });
  });

  test('no play history yet → nothing to recap', () => {
    expect(suffixes(new Date(2026, 8, 2), new Date(2026, 8, 1))).toEqual([]);
  });
});
