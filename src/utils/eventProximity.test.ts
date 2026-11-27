import { eventProximity } from './eventProximity';
import { shuffled } from './shuffle';

// Wednesday 2026-11-25, 14:30 on the listener's calendar.
const now = new Date(2026, 10, 25, 14, 30);

it('says Tonight, or Today for a show starting before 5 pm', () => {
  expect(eventProximity('2026-11-25', null, now)).toBe('Tonight');
  expect(eventProximity('2026-11-25', '2026-11-25T20:00:00', now)).toBe('Tonight');
  expect(eventProximity('2026-11-25', '2026-11-25T13:00:00', now)).toBe('Today');
  expect(eventProximity('2026-11-25', '2026-11-25T00:00:00', now)).toBe('Tonight');
});

it('says Tomorrow, This <Weekday> within the week, then In N days up to four weeks', () => {
  expect(eventProximity('2026-11-26', null, now)).toBe('Tomorrow');
  expect(eventProximity('2026-11-28', null, now)).toBe('This Saturday');
  expect(eventProximity('2026-12-02', null, now)).toBe('In 7 days');
  expect(eventProximity('2026-12-23', null, now)).toBe('In 28 days');
  expect(eventProximity('2026-12-24', null, now)).toBeNull();
});

it('says nothing for a date gone or one it cannot read', () => {
  expect(eventProximity('2026-11-24', null, now)).toBeNull();
  expect(eventProximity('soon', null, now)).toBeNull();
});

it('counts calendar days, not 24-hour spans, across a clock change', () => {
  // Late evening the day before Europe's spring change (2027-03-28).
  expect(eventProximity('2027-03-29', null, new Date(2027, 2, 27, 23, 30))).toBe('This Monday');
});

it('shuffles a copy, keeping every item', () => {
  const items = [1, 2, 3, 4, 5];
  const out = shuffled(items, () => 0);
  expect(out).toEqual([2, 3, 4, 5, 1]);
  expect(items).toEqual([1, 2, 3, 4, 5]);
  expect([...shuffled(items)].sort()).toEqual(items);
});

import { formatShowDate, showLocale } from './showDateFormat';

it('writes show dates the way they are where the server runs, never shifting the venue clock', () => {
  expect(formatShowDate('2027-03-05', '2027-03-05T20:00:00', 'Europe/Copenhagen')).toEqual({ dayAndDate: 'Fri 5 Mar', date: '5 Mar', time: '20:00' });
  expect(formatShowDate('2027-03-05', '2027-03-05T20:00:00', 'America/New_York')).toEqual({ dayAndDate: 'Fri, Mar 5', date: 'Mar 5', time: '8:00 PM' });
  expect(formatShowDate('2027-03-05', '2027-03-05T00:00:00', 'Europe/Copenhagen').time).toBeNull();
  expect(formatShowDate('2027-03-05', null, null).time).toBeNull();
  expect(showLocale(undefined)).toBe('en-GB');
  expect(showLocale('Australia/Sydney')).toBe('en-AU');
});
