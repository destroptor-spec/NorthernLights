import { eventProximity } from './eventProximity';
import { shuffled } from './shuffle';

// Wednesday 2026-11-25, 14:30 on the listener's calendar.
const now = new Date(2026, 10, 25, 14, 30);

it('says tonight, or today for a show starting before 5 pm', () => {
  expect(eventProximity('2026-11-25', null, now)).toBe('tonight');
  expect(eventProximity('2026-11-25', '2026-11-25T20:00:00', now)).toBe('tonight');
  expect(eventProximity('2026-11-25', '2026-11-25T13:00:00', now)).toBe('today');
  expect(eventProximity('2026-11-25', '2026-11-25T00:00:00', now)).toBe('tonight');
});

it('says tomorrow, this <weekday> within the week, then in N days up to four weeks', () => {
  expect(eventProximity('2026-11-26', null, now)).toBe('tomorrow');
  expect(eventProximity('2026-11-28', null, now)).toBe(`this ${new Date(2026, 10, 28).toLocaleDateString(undefined, { weekday: 'long' }).toLowerCase()}`);
  expect(eventProximity('2026-12-02', null, now)).toBe('in 7 days');
  expect(eventProximity('2026-12-23', null, now)).toBe('in 28 days');
  expect(eventProximity('2026-12-24', null, now)).toBeNull();
});

it('says nothing for a date gone or one it cannot read', () => {
  expect(eventProximity('2026-11-24', null, now)).toBeNull();
  expect(eventProximity('soon', null, now)).toBeNull();
});

it('counts calendar days, not 24-hour spans, across a clock change', () => {
  // Late evening the day before Europe's spring change (2027-03-28).
  expect(eventProximity('2027-03-29', null, new Date(2027, 2, 27, 23, 30))).toBe('this monday'.replace('monday', new Date(2027, 2, 29).toLocaleDateString(undefined, { weekday: 'long' }).toLowerCase()));
});

it('shuffles a copy, keeping every item', () => {
  const items = [1, 2, 3, 4, 5];
  const out = shuffled(items, () => 0);
  expect(out).toEqual([2, 3, 4, 5, 1]);
  expect(items).toEqual([1, 2, 3, 4, 5]);
  expect([...shuffled(items)].sort()).toEqual(items);
});
