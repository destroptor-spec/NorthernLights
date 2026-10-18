import { pollDecision, UNREACHABLE_POLLS_BEFORE_RECOVERY } from '../serverHealth';

describe('pollDecision', () => {
  it('believes a server that says its database is down at once', () => {
    expect(pollDecision('down', { connected: true, unreachableStreak: 0 })).toEqual({ connected: false, unreachableStreak: 0 });
  });

  it('keeps a connected app as it is through a few polls without an answer', () => {
    // Prod 2026-10-18: two slow health answers put the app on the recovery screen mid-song.
    let state = { connected: true as boolean | null, unreachableStreak: 0 };
    for (let poll = 1; poll < UNREACHABLE_POLLS_BEFORE_RECOVERY; poll += 1) {
      state = pollDecision('unreachable', state);
      expect(state.connected).toBe(true);
    }
    expect(pollDecision('unreachable', state).connected).toBe(false);
  });

  it('starts counting again after an answer', () => {
    const afterOne = pollDecision('unreachable', { connected: true, unreachableStreak: 0 });
    const answered = pollDecision('connected', afterOne);
    expect(answered).toEqual({ connected: true, unreachableStreak: 0 });
    expect(pollDecision('unreachable', answered).connected).toBe(true);
  });

  it('does not pretend an app that was not connected is', () => {
    expect(pollDecision('unreachable', { connected: false, unreachableStreak: 0 }).connected).toBe(false);
    expect(pollDecision('unreachable', { connected: null, unreachableStreak: 0 }).connected).toBe(false);
  });
});
